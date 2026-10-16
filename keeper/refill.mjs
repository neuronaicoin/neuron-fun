// Keeps the keeper's gas topped up from its own dollars.
//
// The race fee (paid by every creator, on every chain) goes to the keeper in the chain's dollar
// (USDC). On Arc that already IS gas. On Base, BNB Chain and Robinhood Chain gas is ETH / BNB, so
// when the keeper runs low there it swaps a few of its own dollars into the chain's coin through
// Relay (same chain, to itself). Never more than REFILL_USD per swap, at most once per
// REFILL_EVERY_MIN per chain. An alert goes out only when it can't refill (no dollars left, Relay
// down), so a human tops it up.
//
// Env: MIN_GAS_WEI (default 0.002 of the chain's coin; Arc 1 USDC), MIN_GAS_WEI_<chainId>,
//      REFILL_USD (default 5), REFILL_EVERY_MIN (default 30), RELAY_API, RELAY_API_KEY,
//      GAS_REFILL=false switches it off.

import { decodeFunctionData, parseAbi, zeroAddress } from "viem";

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address, uint256) returns (bool)",
]);

const lastTry = new Map();

/** The least gas a chain's keeper should hold (18-decimal native units). */
export function gasFloor(c, env = process.env) {
  const own = env[`MIN_GAS_WEI_${c.chainId}`];
  if (own) return BigInt(own);
  // Arc pays gas in USDC (18 decimals natively): a dollar, not 0.002 of a dollar
  if (c.builderKind === "usdc") return 10n ** 18n;
  return BigInt(env.MIN_GAS_WEI || "2000000000000000");
}

const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const priceAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

/** sasa's own contracts on this chain (from its deployment file): a swap step may never call them. */
export function ownContracts(c) {
  const keys = ["hub", "builder", "hook", "factory", "consolidator", "router", "bridge", "cross", "autoOrders", "coinDeployer", "seat", "feed", "usd"];
  return new Set(keys.map((k) => String(c[k] || "").toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a) && !/^0x0{40}$/.test(a)));
}

/**
 * Relay's same-chain route from `amount` of `token` to the chain's coin, for `who` (sender and
 * receiver). Only plain transactions on this chain, no native value, at most one approval (of
 * `token`, for at most `amount`) and exactly one swap, sent to the contract the approval is for
 * (never to the dollar, Permit2 or one of sasa's own contracts). Returns the steps and what the
 * quote says arrives (`out`, wei).
 */
export async function relayToNative({ relayApi, chainId, who, token, amount, deny = new Set(), fetchFn = fetch, apiKey = process.env.RELAY_API_KEY }) {
  const r = await fetchFn(`${relayApi}/quote/v2`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) },
    body: JSON.stringify({
      user: who,
      recipient: who,
      originChainId: chainId,
      destinationChainId: chainId,
      originCurrency: token,
      destinationCurrency: zeroAddress,
      amount: amount.toString(),
      tradeType: "EXACT_INPUT",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !Array.isArray(j.steps)) throw new Error(`relay: ${j.message || r.status}`);
  const txs = [];
  let swaps = 0;
  let spender = null;
  for (const step of j.steps) {
    if (step.kind !== "transaction") throw new Error("relay: route needs a signature step");
    for (const it of step.items || []) {
      const d = it.data || {};
      if (Number(d.chainId) !== chainId) throw new Error("relay: route leaves the chain");
      if (d.value && BigInt(d.value) !== 0n) throw new Error("relay: route needs native value");
      if (!d.to || !d.data) throw new Error("relay: empty step");
      const isApprove = String(d.to).toLowerCase() === String(token).toLowerCase() && String(d.data).startsWith("0x095ea7b3");
      const to = String(d.to).toLowerCase();
      if (isApprove) {
        const [who_, value] = decodeFunctionData({ abi: erc20Abi, data: d.data }).args;
        if (value > amount) throw new Error("relay: approval above the amount");
        if (spender) throw new Error("relay: more than one approval");
        spender = String(who_).toLowerCase();
      } else {
        if (to === String(token).toLowerCase()) throw new Error("relay: unexpected call on the dollar");
        if (to === PERMIT2 || deny.has(to)) throw new Error("relay: swap step calls a contract it must not");
        if (++swaps > 1) throw new Error("relay: more than one trade step");
      }
      txs.push({ to: d.to, data: d.data, approve: isApprove });
    }
  }
  if (swaps !== 1) throw new Error("relay: no trade step");
  const swap = txs.find((t) => !t.approve);
  // the dollars always need a fresh approval (only ever the exact amount is approved): a route
  // without one, or a swap sent anywhere but the approved contract, is refused
  if (!spender) throw new Error("relay: route has no approval step");
  if (spender !== String(swap.to).toLowerCase()) throw new Error("relay: the swap isn't sent to the approved contract");
  if (spender && (spender === PERMIT2 || deny.has(spender))) throw new Error("relay: approval for a contract it must not be");
  // approval first, then the swap
  txs.sort((a, b) => Number(b.approve) - Number(a.approve));
  let out = 0n;
  try {
    out = BigInt(j?.details?.currencyOut?.amount ?? 0);
  } catch {}
  return { txs, out };
}

/**
 * One look at one chain. Returns what happened: "ok" (enough gas), "refilled", "waiting"
 * (tried recently), "off", or "alert:<reason>" (the caller sends the alert).
 */
export async function refillGas(c, account, { relayApi = process.env.RELAY_API || "https://api.relay.link", fetchFn = fetch, send, log = () => {}, now = Date.now(), env = process.env } = {}) {
  const bal = await c.pub.getBalance({ address: account.address });
  const floor = gasFloor(c, env);
  if (bal >= floor) return "ok";
  const low = `keeper wallet ${account.address} is low on gas on chain ${c.chainId} (${Number(bal) / 1e18})`;
  // Arc: gas is the dollar itself, and testnets have no Relay
  if (env.GAS_REFILL === "false" || c.builderKind === "usdc" || c.testnet || !c.usd || c.usd === zeroAddress) return `alert:${low}. Top it up.`;
  const every = Number(env.REFILL_EVERY_MIN || "30") * 60_000;
  const prev = lastTry.get(c.chainId);
  if (prev !== undefined && now - prev < every) return "waiting";
  lastTry.set(c.chainId, now);

  const [dollars, dec] = await Promise.all([
    c.pub.readContract({ address: c.usd, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    c.pub.readContract({ address: c.usd, abi: erc20Abi, functionName: "decimals" }),
  ]);
  const one = 10n ** BigInt(dec);
  const cap = BigInt(Math.round(Number(env.REFILL_USD || "5") * 100)) * one / 100n;
  const amount = dollars < cap ? dollars : cap;
  if (amount < one) return `alert:${low}, and it has under $1 of USDC to swap. Top it up.`;
  try {
    // what the dollars should buy, by the builder's Chainlink price (8 decimals)
    if (!c.feed || c.feed === zeroAddress) throw new Error("no price feed to check the swap against");
    const [, answer] = await c.pub.readContract({ address: c.feed, abi: priceAbi, functionName: "latestRoundData" });
    if (answer <= 0n) throw new Error("no price from the feed");
    const expected = (amount * 10n ** 18n * 100_000_000n) / (one * BigInt(answer));
    const { txs, out } = await relayToNative({ relayApi, chainId: c.chainId, who: account.address, token: c.usd, amount, deny: ownContracts(c), fetchFn, apiKey: env.RELAY_API_KEY });
    if (out < (expected * 90n) / 100n) throw new Error(`the quote gives ${out} wei, under 90% of the ${expected} expected`);
    for (const t of txs) {
      const r = await send(c, { account, to: t.to, data: t.data, value: 0n });
      if (r.status !== "success") throw new Error(`${t.approve ? "approval" : "swap"} reverted ${r.transactionHash}`);
    }
    // what really arrived (the quote is only Relay's word): at least 80% of the price, after gas
    const after = await c.pub.getBalance({ address: account.address });
    if (after < bal + (expected * 80n) / 100n) {
      return `alert:keeper gas swap on chain ${c.chainId} brought less than expected (${Number(after - bal) / 1e18} for ${Number(amount) / Number(one)} USDC). Check it.`;
    }
    log(`${c.chainId}: gas was low (${Number(bal) / 1e18}); swapped ${Number(amount) / Number(one)} USDC into gas`);
    return "refilled";
  } catch (e) {
    return `alert:${low}; swapping its USDC failed (${e.shortMessage || e.message}). Top it up.`;
  }
}
