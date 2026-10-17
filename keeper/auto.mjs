// sasa auto orders keeper: take profit, stop loss and buy the dip, on race coins and other DEXs'
// coins. One pass per run; loop it on Railway (LOOP_SECONDS, default 8).
//
// Orders are signed by their users and stored by the site (indexer/auto.sql, edge/auto-api.js).
// Every pass, for each open order whose coin is near its price:
//   1. build the trade: the race router's buy/sell (race coins) or Relay's best route (other
//      coins), plus Across's fee when the order sends money to another chain;
//   2. dry-run it on chain (the contract checks the signature, the minimum and everything else);
//   3. check the price really is there (a stop loss only sells once the price is at or below its
//      stop; take profit and dip buys are held to their price by the signed minimum itself);
//   4. check the 0.1% fee covers the network fee (sasa never pays for a user's order);
//   5. send it, mark it filled and ring the user's 🔔.
// The keeper can't move anyone's money any other way: the contract only does what was signed.
//
// Env:
//   PRIVATE_KEY            the keeper key (AutoOrders' keeper; it also receives the 0.1% fees)
//   DEPLOYMENTS            folder with <chainId>.json from DeployRace (default ../contracts-v7/deployments/race)
//   RPC_<chainId>          RPC URL(s) per chain, comma-separated
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   TREASURY               receives sasa's 0.7% fee on other DEXs' coins (Relay app fee): the
//                          rewards wallet 0x4670db0a98Ac28D4093969E3Dfbf16045E321073
//   SITE_URL               default https://sasapad.fun
//   HOME_CHAIN_ID          where sasa accounts keep their dollars (default 8453, Base)
//   LOOP_SECONDS           default 8 (0: one pass, then exit)
//   DRY_RUN                "true": decide and log, send nothing

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, decodeEventLog, decodeFunctionData, defineChain, encodeFunctionData, fallback, http, parseAbi, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { alert, heartbeat } from "./alert.mjs";
import { gasFloor } from "./refill.mjs";

// where the site's Relay fee goes (the rewards wallet; earlier sasa admin): auto-order fees count
// for invite rewards only when TREASURY is one of them
const SASA_FEE_TO = new Set(["0x4670db0a98ac28d4093969e3dfbf16045e321073", "0xe0ba5905940d748b23dc01266aa884e2391cca2f"]);

const env = (n, d) => {
  const v = process.env[n];
  if (v === undefined || v === "") {
    if (d === undefined) throw new Error(`missing env ${n}`);
    return d;
  }
  return v;
};
const log = (...a) => console.log(new Date().toISOString(), "[auto]", ...a);
const DRY = () => env("DRY_RUN", "false") === "true";

export const autoAbi = parseAbi([
  "struct Order { address user; address tokenIn; address tokenOut; uint256 amountIn; uint256 minOut; uint8 mode; uint256 destChainId; uint256 maxRouteFee; uint256 deadline; uint256 nonce; }",
  "struct Route { address approveTo; address target; bytes data; uint256 routeFee; }",
  "function execute(Order o, bytes sig, Route r) returns (uint256)",
  "function used(address, uint256) view returns (bool)",
  "function homeChainId() view returns (uint256)",
  "event Executed(address indexed user, uint256 indexed nonce, uint8 mode, uint256 amountIn, uint256 amountOut, uint256 fee)",
  "error NotKeeper()",
  "error Used()",
  "error Expired()",
  "error BadSignature()",
  "error BadOrder()",
  "error RouterNotAllowed()",
  "error TooLittle(uint256 got, uint256 minimum)",
  "error RouteFeeTooHigh()",
  "error NoRoute()",
  "error CallFailed(bytes reason)",
]);
const routerAbi = parseAbi([
  "function buy(address coin, uint256 usdcIn, uint256 minCoinsOut, address to, uint256 deadline) returns (uint256)",
  "function sell(address coin, uint256 coinsIn, uint256 minUsdcOut, address to, uint256 deadline) returns (uint256)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

const MODE_SWAP = 0, MODE_SELL_HOME = 1, MODE_BUY_CROSS = 2;
const FEE_BPS = 10n;
/** How close the stored price must be before an order is tried (stored prices lag a little). */
const NEAR = 0.03;
/** An order whose fee can't cover its gas waits; after this long it is closed with a note. */
const TOO_SMALL_HOURS = 24;

// ------------------------------------------------------------------ setup

export function loadChains(dir, account) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => /^\d+\.json$/.test(x))) {
    const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (!d.autoOrders || d.autoOrders === zeroAddress) continue;
    const rpcs = (process.env[`RPC_${d.chainId}`] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!rpcs.length) {
      log(`skip chain ${d.chainId}: no RPC_${d.chainId}`);
      continue;
    }
    const chain = defineChain({ id: Number(d.chainId), name: `c${d.chainId}`, nativeCurrency: { name: "N", symbol: "N", decimals: 18 }, rpcUrls: { default: { http: rpcs } } });
    const transport = fallback(rpcs.map((u) => http(u, { retryCount: 2, timeout: 20_000 })));
    out.set(Number(d.chainId), {
      ...d,
      chainId: Number(d.chainId),
      usdDecimals: Number(d.usdDecimals ?? 6),
      pub: createPublicClient({ chain, transport }),
      wallet: createWalletClient({ chain, account, transport }),
    });
  }
  return out;
}

export function db(url, key) {
  const headers = { apikey: key, "content-type": "application/json" };
  if (key && key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  return async (path, { method = "GET", body, prefer } = {}) => {
    const r = await fetch(`${url}/rest/v1/${path}`, { method, headers: { ...headers, prefer: prefer ? `return=minimal,${prefer}` : "return=minimal" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error(`db ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };
}

// ------------------------------------------------------------------ prices

/** Price per coin in dollars from the indexers (race_chains / ext_coins_all): a cheap first look. */
async function storedPrices(sb, orders) {
  const out = new Map();
  const races = [...new Set(orders.filter((o) => o.coin_kind === "race").map((o) => o.race_id))];
  if (races.length) {
    const rows = await sb(`race_chains?coin_id=in.(${races.map((r) => `"${r}"`).join(",")})&select=coin_id,chain_id,price_usd,state`);
    for (const r of rows || []) out.set(`race:${r.coin_id}:${r.chain_id}`, r.price_usd === null ? null : Number(r.price_usd));
  }
  const ext = orders.filter((o) => o.coin_kind === "ext");
  for (const net of new Set(ext.map((o) => o.network))) {
    const addrs = [...new Set(ext.filter((o) => o.network === net).map((o) => o.coin))];
    const rows = await sb(`ext_coins_all?network=eq.${net}&address=in.(${addrs.map((a) => `"${a}"`).join(",")})&select=address,price_usd`);
    for (const r of rows || []) out.set(`ext:${net}:${String(r.address).toLowerCase()}`, r.price_usd === null ? null : Number(r.price_usd));
    // Market coins (the 300 biggest) aren't in that list: their price is in top_coins_pub
    const missing = addrs.filter((a) => !(out.get(`ext:${net}:${a}`) > 0));
    if (missing.length) {
      const more = await sb(`top_coins_pub?network=eq.${net}&address=in.(${missing.map((a) => `"${a}"`).join(",")})&select=address,price_usd`).catch(() => []);
      for (const r of more || []) out.set(`ext:${net}:${String(r.address).toLowerCase()}`, r.price_usd === null ? null : Number(r.price_usd));
    }
  }
  return out;
}

export function near(kind, price, trigger) {
  if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) return true; // unknown: let the chain decide
  if (kind === "tp") return price >= trigger * (1 - NEAR);
  return price <= trigger * (1 + NEAR); // stop loss and dip: at or below
}

// ------------------------------------------------------------------ routes

const toOrder = (j) => ({
  user: j.user,
  tokenIn: j.tokenIn,
  tokenOut: j.tokenOut,
  amountIn: BigInt(j.amountIn),
  minOut: BigInt(j.minOut),
  mode: Number(j.mode),
  destChainId: BigInt(j.destChainId),
  maxRouteFee: BigInt(j.maxRouteFee),
  deadline: BigInt(j.deadline),
  nonce: BigInt(j.nonce),
});

/** Relay's best same-chain route, run by the AutoOrders contract itself. */
export async function relayRoute({ relayApi, treasury, chainId, contract, tokenIn, tokenOut, amount, fetchFn = fetch }) {
  const r = await fetchFn(`${relayApi}/quote/v2`, {
    method: "POST",
    // sasa's Relay API key (RELAY_API_KEY): ties the quote and its fee to sasa
    headers: { "content-type": "application/json", ...(process.env.RELAY_API_KEY ? { "x-api-key": process.env.RELAY_API_KEY } : {}) },
    body: JSON.stringify({
      user: contract,
      recipient: contract,
      originChainId: chainId,
      destinationChainId: chainId,
      originCurrency: tokenIn,
      destinationCurrency: tokenOut,
      amount: amount.toString(),
      tradeType: "EXACT_INPUT",
      ...(treasury ? { appFees: [{ recipient: treasury, fee: "70" }] } : {}),
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !Array.isArray(j.steps)) throw new Error(`relay: ${j.message || r.status}`);
  let approveTo = zeroAddress;
  let swap = null;
  for (const step of j.steps) {
    if (step.kind !== "transaction") throw new Error("relay: a signature step can't run from a contract");
    for (const it of step.items || []) {
      const d = it.data || {};
      if (Number(d.chainId) !== chainId) throw new Error("relay: route leaves the chain");
      if (d.value && BigInt(d.value) !== 0n) throw new Error("relay: route needs native value");
      if (String(d.to).toLowerCase() === String(tokenIn).toLowerCase() && String(d.data).startsWith("0x095ea7b3")) {
        approveTo = decodeFunctionData({ abi: erc20Abi, data: d.data }).args[0];
      } else {
        if (swap) throw new Error("relay: more than one trade step");
        swap = d;
      }
    }
  }
  if (!swap) throw new Error("relay: no trade step");
  return { approveTo, target: swap.to, data: swap.data, routeFee: 0n };
}

/** Across's fee for `amount` (from-chain units) from `from` to `to`, with a buffer. */
export async function acrossFee({ acrossApi, from, to, amount, recipient, fetchFn = fetch }) {
  const p = new URLSearchParams({
    inputToken: from.usd,
    outputToken: to.usd,
    originChainId: String(from.chainId),
    destinationChainId: String(to.chainId),
    amount: amount.toString(),
    recipient,
    // USDC has 18 decimals on BNB Chain and 6 elsewhere: Across refuses such a route unless told it's meant
    allowUnmatchedDecimals: "true",
  });
  const r = await fetchFn(`${acrossApi}/suggested-fees?${p}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.totalRelayFee) throw new Error(`across: ${j.message || r.status}`);
  if (j.isAmountTooLow) throw new Error("across: amount too low");
  return (BigInt(j.totalRelayFee.total) * 120n) / 100n + 1n;
}

// ------------------------------------------------------------------ gas

/** Dollars (as a float) of `gasWei` native on chain `c`: Arc pays in USDC; ETH/BNB via the feed. */
export async function gasUsd(c, gasWei) {
  if (c.builderKind === "usdc") return Number(gasWei) / 1e18;
  if (!c.feed || c.feed === zeroAddress) return null;
  const [, answer, , updatedAt] = await c.pub.readContract({ address: c.feed, abi: feedAbi, functionName: "latestRoundData" });
  if (answer <= 0n || Date.now() / 1000 - Number(updatedAt) > 2 * 86400) return null; // broken or stale feed: unknown
  return (Number(gasWei) / 1e18) * (Number(answer) / 1e8);
}

// ------------------------------------------------------------------ one order

const executedEvent = autoAbi.find((x) => x.type === "event" && x.name === "Executed");

/** The order already ran (a fill the keeper didn't get to save): its transaction and amounts. */
export async function findExecuted(c, order, sentTx = null, { scan = true } = {}) {
  const usdc = String(c.usd).toLowerCase();
  const buying = String(order.tokenIn).toLowerCase() === usdc;
  const units = 10 ** c.usdDecimals;
  const mine = (l) => {
    try {
      const ev = decodeEventLog({ abi: autoAbi, data: l.data, topics: l.topics });
      return ev.eventName === "Executed" && String(ev.args.user).toLowerCase() === String(order.user).toLowerCase() && ev.args.nonce === order.nonce ? ev : null;
    } catch {
      return null;
    }
  };
  // the transaction the keeper sent (saved before it waited), else the recent logs
  if (sentTx) {
    const r = await c.pub.getTransactionReceipt({ hash: sentTx }).catch(() => null);
    for (const l of r?.status === "success" ? r.logs : []) {
      const ev = String(l.address).toLowerCase() === String(c.autoOrders).toLowerCase() ? mine(l) : null;
      if (ev) return { tx: sentTx, out: ev.args.amountOut, usd: buying ? Number(ev.args.amountIn) / units : Number(ev.args.amountOut) / units };
    }
  }
  if (!scan) return null;
  const latest = await c.pub.getBlockNumber();
  const span = BigInt(c.logSpan ?? 9_000);
  for (let to = latest, i = 0; i < 20 && to > 0n; i++, to -= span) {
    const from = to > span ? to - span + 1n : 0n;
    const logs = await c.pub.getLogs({ address: c.autoOrders, event: executedEvent, args: { user: order.user, nonce: order.nonce }, fromBlock: from, toBlock: to });
    const l = logs[logs.length - 1];
    if (l) return { tx: l.transactionHash, out: l.args.amountOut, usd: buying ? Number(l.args.amountIn) / units : Number(l.args.amountOut) / units };
  }
  return null;
}

const errName = (e) => {
  for (let x = e; x; x = x.cause) if (x.data?.errorName) return x.data.errorName;
  const m = String(e?.shortMessage || e?.message || "");
  const k = /(TooLittle|Used|Expired|BadSignature|BadOrder|RouterNotAllowed|RouteFeeTooHigh|NoRoute|CallFailed|NotKeeper)/.exec(m);
  if (k) return k[1];
  if (/transfer amount exceeds (allowance|balance)|insufficient allowance|insufficient balance|ERC20InsufficientAllowance|ERC20InsufficientBalance/i.test(m)) return "Funds";
  return "Other";
};

/**
 * Decides and (unless dry) runs one order. Returns what happened: "waiting" (not there yet),
 * "filled", or a closing status ("expired" | "failed" | "cancelled") with a note.
 */
export async function runOrder(o, ctx) {
  const { chains, account, prices, relayApi, acrossApi, treasury } = ctx;
  const c = chains.get(o.chain_id);
  if (!c) return { status: "skip" };
  if (String(c.autoOrders).toLowerCase() !== o.contract) return { status: "failed", note: "Not sasa's auto-order contract on this chain." };
  const order = toOrder(o.order_json);
  if (BigInt(Math.floor(Date.now() / 1000)) > order.deadline) return { status: "expired", note: "Expired before the price was reached." };
  // sent before but not saved as done (the keeper stopped while waiting): its receipt says
  if (o.filled_tx) {
    const ran = await findExecuted(c, order, o.filled_tx, { scan: false }).catch(() => null);
    if (ran) return { status: "filled", tx: ran.tx, out: ran.out, usd: ran.usd };
  }
  const key = o.coin_kind === "race" ? `race:${o.race_id}:${o.coin_chain}` : `ext:${o.network}:${o.coin}`;
  const stored = prices.get(key) ?? null;
  if (!near(o.kind, stored, Number(o.trigger_usd))) return { status: "waiting" };

  // 1. the trade
  const usdc = String(c.usd).toLowerCase();
  const buying = String(order.tokenIn).toLowerCase() === usdc;
  let take = order.amountIn;
  if (!buying) {
    const bal = await c.pub.readContract({ address: order.tokenIn, abi: erc20Abi, functionName: "balanceOf", args: [order.user] });
    if (bal === 0n) return { status: "failed", note: "You no longer hold this coin." };
    if (bal < take) take = bal;
  }
  const swapIn = buying ? take - (take * FEE_BPS) / 10_000n : take;
  const coinDec = o.coin_kind === "race" ? 18 : Number(await c.pub.readContract({ address: o.coin, abi: erc20Abi, functionName: "decimals" }).catch(() => 18));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
  let route;
  try {
    if (order.mode === MODE_BUY_CROSS) {
      const dest = chains.get(Number(order.destChainId));
      if (!dest) return { status: "skip" };
      const routeFee = await acrossFee({ acrossApi, from: c, to: dest, amount: swapIn, recipient: dest.cross });
      route = { approveTo: zeroAddress, target: zeroAddress, data: "0x", routeFee };
    } else if (o.coin_kind === "race") {
      route = {
        approveTo: c.router,
        target: c.router,
        data: encodeFunctionData({ abi: routerAbi, functionName: buying ? "buy" : "sell", args: [order[buying ? "tokenOut" : "tokenIn"], swapIn, 0n, c.autoOrders, deadline] }),
        routeFee: 0n,
      };
    } else {
      route = await relayRoute({ relayApi, treasury, chainId: c.chainId, contract: c.autoOrders, tokenIn: order.tokenIn, tokenOut: order.tokenOut, amount: swapIn });
    }
    if (order.mode === MODE_SELL_HOME) {
      const home = chains.get(ctx.homeChainId);
      if (!home || home.chainId === c.chainId) return { status: "failed", note: "This order sends money home, but this chain is home." };
      // the fee for about what the sale brings: the stored price is enough to size it
      const guess = stored ? BigInt(Math.floor(((Number(take) / 10 ** coinDec) * stored) * 10 ** c.usdDecimals)) : order.minOut;
      route.routeFee = await acrossFee({ acrossApi, from: c, to: home, amount: guess > 0n ? guess : order.minOut, recipient: order.user });
      if (route.routeFee > order.maxRouteFee) return { status: "waiting", note: "Waiting: the fee to send the money to Base is above the limit." };
    }
    if (order.mode === MODE_BUY_CROSS && route.routeFee > order.maxRouteFee) return { status: "waiting", note: "Waiting: the fee to reach that chain is above the limit." };
  } catch (e) {
    return { status: "waiting", note: `Waiting for a route (${String(e.message).slice(0, 80)}).` };
  }

  // 2. dry run on chain
  const params = { address: c.autoOrders, abi: autoAbi, functionName: "execute", args: [order, o.signature, route], account };
  let out;
  let gas;
  try {
    let sim = await c.pub.simulateContract(params);
    out = sim.result;
    if (o.coin_kind === "race" && order.mode !== MODE_BUY_CROSS) {
      // sasa's router gets its own minimum too: what the dry run gave, less 2%. Then nobody can
      // push the price between this check and the trade and take the difference down to the
      // user's own minimum (the user still never gets less than what they signed).
      const routerOut = buying ? out : (out * 10_000n) / (10_000n - FEE_BPS); // a sale's fee comes off after the router
      const routerMin = (routerOut * 98n) / 100n;
      route = {
        ...route,
        data: encodeFunctionData({ abi: routerAbi, functionName: buying ? "buy" : "sell", args: [order[buying ? "tokenOut" : "tokenIn"], swapIn, routerMin, c.autoOrders, deadline] }),
      };
      params.args = [order, o.signature, route];
      sim = await c.pub.simulateContract(params);
      out = sim.result;
    }
    gas = await c.pub.estimateGas({ account, to: c.autoOrders, data: encodeFunctionData({ abi: autoAbi, functionName: "execute", args: [order, o.signature, route] }) });
  } catch (e) {
    const n = errName(e);
    if (n === "TooLittle") return { status: "waiting" };
    if (n === "Used") {
      const ran = await findExecuted(c, order, o.filled_tx).catch(() => null);
      if (ran) return { status: "filled", tx: ran.tx, out: ran.out, usd: ran.usd, already: true };
      return { status: "cancelled", note: "Cancelled on chain." };
    }
    if (n === "Expired") return { status: "expired", note: "Expired before the price was reached." };
    if (n === "BadSignature" || n === "BadOrder") return { status: "failed", note: "This order can't run (signature or order not valid)." };
    if (n === "Funds") return { status: "waiting", note: buying ? "Waiting: not enough USDC approved or in your balance." : "Waiting: the coins aren't approved for auto orders." };
    return { status: "waiting", note: `Waiting: ${n === "Other" ? "the trade didn't go through in a test run" : n}.` };
  }

  // 3. the price really is there (stop losses: at or below the stop; the others are held to it by minOut)
  const usdUnits = 10 ** c.usdDecimals;
  const tradeUsd = buying ? Number(take) / usdUnits : Number(out) / usdUnits;
  if (o.kind === "sl") {
    const feeShare = 0.001 + (o.coin_kind === "ext" ? 0.007 : 0);
    const gross = Number(out) / (1 - feeShare) + Number(route.routeFee ?? 0n);
    const price = gross / usdUnits / (Number(take) / 10 ** coinDec);
    if (price > Number(o.trigger_usd)) return { status: "waiting" };
  }
  if (o.kind === "dip" && order.mode === MODE_SWAP) {
    const price = Number(swapIn) / usdUnits / (Number(out) / 10 ** coinDec);
    if (price > Number(o.trigger_usd) * (1 + 1e-9)) return { status: "waiting" };
  }
  if (o.kind === "dip" && order.mode === MODE_BUY_CROSS && stored !== null && stored > Number(o.trigger_usd)) return { status: "waiting" };

  // 4. the fee pays the gas (sasa never pays for a user's order)
  const gasPrice = await c.pub.getGasPrice();
  const gUsd = await gasUsd(c, (gas * gasPrice * 13n) / 10n);
  const feeUsd = tradeUsd * 0.001;
  if (gUsd === null) return { status: "waiting", note: "Waiting: the network fee can't be priced right now." };
  if (feeUsd < gUsd) {
    const age = (Date.now() - new Date(o.created_at).getTime()) / 3600e3;
    if (o.kind !== "sl" && age > TOO_SMALL_HOURS) return { status: "failed", note: "Too small: its 0.1% fee doesn't cover the network fee." };
    return { status: "waiting", note: "Waiting: the 0.1% fee doesn't cover the network fee right now." };
  }

  // 5. send
  if (DRY()) {
    log(`[dry] ${c.chainId}: would run order ${o.id} (${o.kind}) for ${o.owner}`);
    return { status: "waiting" };
  }
  const hash = await c.wallet.writeContract({ ...params, gas: (gas * 13n) / 10n });
  await ctx.sb(`auto_orders?id=eq.${o.id}`, { method: "PATCH", body: { note: "Sending…", filled_tx: hash, updated_at: new Date().toISOString() } }).catch(() => {});
  const r = await c.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") return { status: "waiting", note: "The last try reverted; trying again.", tx: hash };
  let got = out;
  for (const l of r.logs) {
    try {
      const ev = decodeEventLog({ abi: autoAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "Executed") got = ev.args.amountOut;
    } catch {}
  }
  return { status: "filled", tx: hash, out: got, usd: tradeUsd };
}

// ------------------------------------------------------------------ pass

const TITLES = { tp: "🎯 Take profit hit", sl: "🛡 Stop loss", dip: "🪝 Bought the dip" };

export async function pass(ctx) {
  const { sb, site } = ctx;
  const orders = (await sb("auto_orders?status=eq.open&select=*&order=id.asc&limit=2000")) || [];
  if (!orders.length) return 0;
  ctx.prices = await storedPrices(sb, orders).catch((e) => {
    log(`prices: ${e.message}`);
    return new Map();
  });
  let done = 0;
  for (const o of orders) {
    let res;
    try {
      res = await runOrder(o, ctx);
    } catch (e) {
      res = { status: "waiting", note: `Waiting: ${String(e.shortMessage || e.message).slice(0, 80)}` };
    }
    if (res.status === "skip") continue;
    const now = new Date().toISOString();
    if (res.status === "waiting") {
      if (res.note && res.note !== o.note) await sb(`auto_orders?id=eq.${o.id}`, { method: "PATCH", body: { note: res.note, attempts: o.attempts + 1, updated_at: now } }).catch(() => {});
      continue;
    }
    done++;
    const patch = { status: res.status, note: res.note ?? null, updated_at: now };
    if (res.status === "filled") Object.assign(patch, { filled_tx: res.tx, filled_at: now, out_amount: String(res.out), note: null });
    await sb(`auto_orders?id=eq.${o.id}`, { method: "PATCH", body: patch }).catch((e) => log(`order ${o.id}: save failed ${e.message}`));
    log(`order ${o.id} (${o.kind}, chain ${o.chain_id}) -> ${res.status}${res.tx ? ` ${res.tx}` : ""}${res.note ? ` (${res.note})` : ""}`);
    // other DEXs' coins: counted in the Stats page's volume (race coins are counted by the race indexer)
    if (res.status === "filled" && o.coin_kind === "ext" && res.usd > 0) {
      const side = o.kind === "dip" ? "buy" : "sell";
      await sb("ext_trades?on_conflict=chain_id,tx", {
        method: "POST",
        prefer: "resolution=ignore-duplicates",
        body: {
          chain_id: o.chain_id,
          tx: String(res.tx).toLowerCase(),
          trader: o.owner,
          side,
          coin: o.coin,
          coin_chain: o.coin_chain,
          usd: Math.round(res.usd * 100) / 100,
          source: "auto",
          // the 0.70% app fee this route paid the treasury (relayRoute), counted for invite rewards
          fee_usd: SASA_FEE_TO.has(String(ctx.treasury).toLowerCase()) ? Math.round(res.usd * 0.007 * 1e6) / 1e6 : 0,
          traded_at: now,
        },
      }).catch((e) => log(`order ${o.id}: stats save failed ${e.message}`));
    }
    const sym = o.symbol ? `$${o.symbol}` : "your coin";
    const url = o.coin_kind === "race" ? `${site}/r/?id=${o.race_id}` : `${site}/x/${o.network}/${o.coin}/`;
    const title = res.status === "filled" ? `${TITLES[o.kind]}: ${o.kind === "dip" ? "bought" : "sold"} ${sym}` : `Auto order on ${sym} closed`;
    const body = res.status === "filled" ? "Your auto order ran. Tap to see the coin." : res.note || "It couldn't run.";
    await sb("notifications", { method: "POST", body: { owner: o.owner, coin_id: o.race_id ?? null, kind: "order", title, body, url } }).catch(() => {});
  }
  return done;
}

async function main() {
  const account = privateKeyToAccount(env("PRIVATE_KEY"));
  const ctx = {
    account,
    chains: loadChains(env("DEPLOYMENTS", "../contracts-v7/deployments/race"), account),
    sb: db(env("SUPABASE_URL", "https://rkoassatqhdkdptekvdt.supabase.co"), env("SUPABASE_SERVICE_KEY")),
    site: env("SITE_URL", "https://sasapad.fun").replace(/\/$/, ""),
    relayApi: env("RELAY_API", "https://api.relay.link"),
    acrossApi: env("ACROSS_API", "https://app.across.to/api"),
    treasury: env("TREASURY", ""),
    homeChainId: Number(env("HOME_CHAIN_ID", "8453")),
  };
  if (!ctx.chains.size) throw new Error("no chain with AutoOrders (deployments + RPC_<chainId>)");
  log(`watching auto orders on chains ${[...ctx.chains.keys()].join(", ")} as ${account.address}`);
  const every = Number(env("LOOP_SECONDS", "8"));
  let gasLook = 0;
  for (;;) {
    // every 10 minutes: does this wallet still have gas to fill orders? (the race keeper tops
    // it up from its USDC when both use the same wallet; otherwise a human does)
    if (Date.now() - gasLook > 10 * 60_000) {
      gasLook = Date.now();
      for (const c of ctx.chains.values()) {
        const bal = await c.pub.getBalance({ address: account.address }).catch(() => null);
        if (bal !== null && bal < gasFloor(c)) {
          await alert("auto orders", `gas-${c.chainId}`, `auto-order wallet ${account.address} is low on gas on chain ${c.chainId} (${Number(bal) / 1e18}); orders there can't run. Top it up.`);
        }
      }
    }
    await heartbeat("auto-keeper");
    try {
      await pass(ctx);
    } catch (e) {
      log(`pass failed: ${e.message}`);
    }
    if (!every) break;
    await new Promise((r) => setTimeout(r, every * 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
