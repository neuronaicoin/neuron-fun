// sasa rewards service (runs on Railway, separate from the indexer).
//
// Every few minutes it adds new rewards to the ledger:
//   referral  25% of sasa's fee share on an invited friend's trades, for 12 months
//   copy      10% of sasa's fee share on trades copied from a trader
// Once a day (PAYOUT_HOUR_UTC) it pays everyone who is owed at least the
// minimum, per chain, from the rewards wallet, in one batch transaction:
//   1. collect sasa's fees from coins that pay into the fee splitter
//   2. split them (30% to this wallet, 70% to the treasury)
//   3. pay what's owed, never more than the daily cap or the wallet's balance
//
// Safety:
//   - the signed payout is saved before it's sent, so a crash can't pay twice
//   - rows are marked paid only for recipients the chain confirms were paid
//   - rewards_state.paused stops all payouts (admin page)
//   - DRY_RUN=1 logs what it would do and sends nothing
//
// Env:
//   DATABASE_URL          Postgres (same as the indexer)
//   REWARDS_PRIVATE_KEY   the rewards wallet's key (only here)
//   CHAINS                JSON: [{ name, chainId, rpc, splitter, disperse, orders?, native?, token? }]
//                         (the older per-chain rewards; "[]" or unset when there are none)
//   USD_PAYOUT            JSON: { rpc, token }  Base RPC and USDC on Base: invite rewards from race
//                         coins, other DEXs' coins and futures, paid in USDC (see usd.mjs)
//   REWARD_CHAIN_IDS      race chains whose trades earn them (default 8453,4663,5042,56)
//   HL_BUILDER            sasa's futures fee address on Hyperliquid (futures rewards; unset = off)
//   HL_FILLS, HL_API      Hyperliquid's builder_fills files and info API (defaults: mainnet)
//   RPC_8453, RPC_56, RPC_4663, RPC_5042   funding itself (fund.mjs): claim Relay's app fees, turn
//                         what it holds on each chain into USDC on Base; FUND_EVERY_HOURS (6)
//   TREASURY_WALLET       where USDC above what's owed + KEEP_USD (100) goes once a day
//                         (default sasa treasury 0x3C4E66b4B4DDD1F6348aD5fDfAE7e60AC35aca6F)
//                         token: the USDC address on USDC chains (sasa v5); rewards are then
//                         paid in USDC and counted as dollars. Without it, in the chain's coin.
//                         orders: the SasaOrders contract; its auto orders get filled here too
//   PAYOUT_HOUR_UTC       hour to pay (default 0)
//   MIN_PAYOUT_USD        smaller amounts wait for the next day (default 0.5)
//   DAILY_CAP_USD         most paid per chain per day (default 500)
//   GAS_RESERVE_WEI       kept in the wallet for gas when paying in the chain's coin (default 0.002 ETH)
//   MIN_GAS_WEI           least gas coin needed to pay USDC rewards (default 0.00002 ETH)
//   MIN_CLAIM_WEI         collect a coin's fees once they reach this (default 0.0001 ETH)
//   PROTOCOL_BPS, REFERRAL_BPS, COPY_BPS, REFERRAL_MONTHS   (defaults 7000, 2500, 1000, 12)
//   FALLBACK_PRICE_USD    price to use if the live price can't be fetched (optional)

import { alert, heartbeat } from "./alert.mjs";
import pg from "pg";
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, getAddress, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ordersLoop } from "./orders.mjs";
import lz4 from "lz4js";
import { buildPerpLedger, buildUsdLedger, builderAccountUsd, payUsd, reconcileUsd } from "./usd.mjs";
import { FUND_DEFAULTS, claimRelayFees, convertToBase, sweepSurplus } from "./fund.mjs";

const env = (k, d) => {
  const v = process.env[k];
  if (v === undefined || v === "") {
    if (d === undefined) throw new Error(`missing env ${k}`);
    return d;
  }
  return v;
};
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DRY = env("DRY_RUN", "0") === "1";
const PROTOCOL_BPS = BigInt(env("PROTOCOL_BPS", "7000"));
const REFERRAL_BPS = BigInt(env("REFERRAL_BPS", "2500"));
const COPY_BPS = BigInt(env("COPY_BPS", "1000"));
const REFERRAL_MONTHS = Number(env("REFERRAL_MONTHS", "12"));
const PAYOUT_HOUR = Number(env("PAYOUT_HOUR_UTC", "0"));
const MIN_PAYOUT_USD = Number(env("MIN_PAYOUT_USD", "0.5"));
const DAILY_CAP_USD = Number(env("DAILY_CAP_USD", "500"));
const GAS_RESERVE = BigInt(env("GAS_RESERVE_WEI", "2000000000000000"));
// USDC chains pay rewards in USDC; the wallet only needs a little of the chain's coin for gas.
const MIN_GAS = BigInt(env("MIN_GAS_WEI", "20000000000000"));
const MIN_CLAIM = BigInt(env("MIN_CLAIM_WEI", "100000000000000"));
// On USDC chains the same threshold in dollars (6 decimals): collect from $0.01.
const MIN_CLAIM_USDC = BigInt(Math.round(Number(env("MIN_CLAIM_USD", "0.01")) * 1e6));
const BATCH = 100;

const curveAbi = parseAbi([
  "function protocolFees() view returns (uint256)",
  "function protocolFeeRecipient() view returns (address)",
  "function claimProtocolFees() returns (uint256)",
]);
const splitterAbi = parseAbi(["function distribute() returns (uint256, uint256)", "function rewards() view returns (address)"]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
]);
const disperseAbi = parseAbi([
  "function disperseEth(address launch, address[] recipients, uint256[] amounts, uint256 round) payable returns (uint256)",
  "function disperseToken(address launch, address asset, address[] recipients, uint256[] amounts, uint256 round) returns (uint256)",
  "event Paid(address indexed launch, address indexed asset, address indexed to, uint256 amount)",
  "event Unpaid(address indexed launch, address indexed to, uint256 amount)",
]);

const pool = new pg.Pool({ connectionString: env("DATABASE_URL"), max: 3 });
const account = privateKeyToAccount(env("REWARDS_PRIVATE_KEY").trim().replace(/^(?!0x)/, "0x"));
const CHAINS = JSON.parse(env("CHAINS", "[]")).map((c) => {
  const chain = defineChain({
    id: c.chainId,
    name: c.name,
    nativeCurrency: { name: c.native ?? "ETH", symbol: c.native ?? "ETH", decimals: 18 },
    rpcUrls: { default: { http: [c.rpc] } },
  });
  return {
    ...c,
    splitter: getAddress(c.splitter),
    token: c.token ? getAddress(c.token) : null,
    disperse: getAddress(c.disperse),
    orders: c.orders ? getAddress(c.orders) : null,
    pub: createPublicClient({ chain, transport: http(c.rpc) }),
    wallet: createWalletClient({ chain, account, transport: http(c.rpc) }),
  };
});

// Invite rewards in dollars, paid in USDC on Base (usd.mjs)
const USD = (() => {
  const raw = process.env.USD_PAYOUT;
  if (!raw) return null;
  const u = JSON.parse(raw);
  const chain = defineChain({ id: 8453, name: "Base", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [u.rpc] } } });
  return {
    token: getAddress(u.token),
    pub: createPublicClient({ chain, transport: http(u.rpc) }),
    wallet: createWalletClient({ chain, account, transport: http(u.rpc) }),
  };
})();
// Funding itself (fund.mjs): every chain with an RPC_<chainId> set
const FUND = FUND_DEFAULTS.filter((f) => process.env[`RPC_${f.chainId}`]).map((f) => {
  const rpc = process.env[`RPC_${f.chainId}`].split(",")[0].trim();
  const chain = defineChain({ id: f.chainId, name: `c${f.chainId}`, nativeCurrency: { name: "N", symbol: "N", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  return { ...f, pub: createPublicClient({ chain, transport: http(rpc) }), wallet: createWalletClient({ chain, account, transport: http(rpc) }) };
});
const FUND_MS = Number(env("FUND_EVERY_HOURS", "6")) * 3_600_000;
const SASA_TREASURY = env("TREASURY_WALLET", "0x3C4E66b4B4DDD1F6348aD5fDfAE7e60AC35aca6F");
const KEEP_USD = Number(env("KEEP_USD", "100"));
const REWARD_CHAIN_IDS = env("REWARD_CHAIN_IDS", "8453,4663,5042,56").split(",").map((x) => Number(x.trim())).filter(Boolean);
const HL_BUILDER = process.env.HL_BUILDER || "";

// ------------------------------------------------------------------ prices

let priceCache = { at: 0, v: {} };
async function usdPrice(symbol) {
  if (Date.now() - priceCache.at < 10 * 60_000 && priceCache.v[symbol]) return priceCache.v[symbol];
  try {
    const r = await fetch(`https://api.coinbase.com/v2/prices/${symbol}-USD/spot`);
    const j = await r.json();
    const p = Number(j?.data?.amount);
    if (p > 0) {
      priceCache = { at: Date.now(), v: { ...priceCache.v, [symbol]: p } };
      return p;
    }
  } catch {}
  const fb = Number(process.env.FALLBACK_PRICE_USD ?? "");
  return priceCache.v[symbol] ?? (fb > 0 ? fb : null);
}
const usdToWei = (usd, price) => BigInt(Math.floor((usd / price) * 1e9)) * 1_000_000_000n;

// ------------------------------------------------------------------ ledger

async function buildLedger() {
  const { rows } = await pool.query("select cursor from rewards_state where id = 1");
  const from = rows[0]?.cursor;
  if (!from) return;
  // Leave the last two minutes: the indexer may still be writing them.
  const upto = new Date(Date.now() - 2 * 60_000);
  if (upto <= new Date(from)) return;

  const ref = await pool.query(
    `insert into reward_ledger (owner, kind, chain_id, trade_tx, log_index, source, amount)
     select r.referrer, 'referral', t.chain_id, t.tx_hash, t.log_index, t.trader,
            floor(t.fee * $3::numeric / 10000 * $4::numeric / 10000)
     from trades t
     join referrals r on r.referee = t.trader
     where t.ts > $1 and t.ts <= $2
       and t.ts >= r.created_at
       and t.ts < r.created_at + make_interval(months => $5::int)
       and t.fee > 0
     on conflict do nothing`,
    [from, upto, PROTOCOL_BPS.toString(), REFERRAL_BPS.toString(), REFERRAL_MONTHS]
  );
  // Copies are matched by the signal the copier applied (it can be marked a
  // little after the trade), so look back two days; duplicates are ignored.
  const copy = await pool.query(
    `insert into reward_ledger (owner, kind, chain_id, trade_tx, log_index, source, amount)
     select s.trader, 'copy', t.chain_id, t.tx_hash, t.log_index, s.follower,
            floor(t.fee * $1::numeric / 10000 * $2::numeric / 10000)
     from copy_signals s
     join trades t on t.chain_id = s.chain_id and t.tx_hash = s.applied_tx and t.trader = s.follower
     where s.status = 'applied' and s.acted_at > now() - interval '2 days' and t.fee > 0
     on conflict do nothing`,
    [PROTOCOL_BPS.toString(), COPY_BPS.toString()]
  ).catch((e) => {
    if (/copy_signals/.test(e.message)) return { rowCount: 0 };
    throw e;
  });
  await pool.query("update rewards_state set cursor = $1, updated_at = now() where id = 1", [upto]);
  if (ref.rowCount || copy.rowCount) log(`ledger: +${ref.rowCount} referral, +${copy.rowCount} copy`);
}

// ------------------------------------------------------------------ sending

/** Signs, saves, then sends; a crash after saving just re-sends the same transaction. */
async function sendSaved(c, request, record) {
  const prepared = await c.wallet.prepareTransactionRequest(request);
  const raw = await c.wallet.signTransaction(prepared);
  const { keccak256 } = await import("viem");
  const hash = keccak256(raw);
  if (record) await record(hash, raw);
  await c.pub.sendRawTransaction({ serializedTransaction: raw }).catch((e) => {
    if (!/already known|nonce too low/i.test(e.shortMessage ?? e.message)) throw e;
  });
  return hash;
}

async function simpleTx(c, to, abi, functionName, args = []) {
  if (DRY) {
    log(`[dry] ${c.name}: ${functionName} on ${to}`);
    return;
  }
  const hash = await sendSaved(c, { to, data: (await import("viem")).encodeFunctionData({ abi, functionName, args }) });
  const r = await c.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
}

// ------------------------------------------------------------------ payouts

/** Re-sends or settles payouts left "sent" (e.g. after a restart). */
async function reconcile(c) {
  const { rows } = await pool.query(
    "select id, tx_hash, raw_tx, created_at from reward_payouts where chain_id = $1 and status = 'sent' order by id",
    [c.chainId]
  );
  for (const p of rows) {
    const receipt = await c.pub.getTransactionReceipt({ hash: p.tx_hash }).catch(() => null);
    if (!receipt) {
      if (Date.now() - new Date(p.created_at).getTime() > 10 * 60_000) {
        await c.pub.sendRawTransaction({ serializedTransaction: p.raw_tx }).catch(() => {});
        log(`${c.name}: re-sent payout ${p.tx_hash}`);
      }
      continue;
    }
    await settle(c, p.tx_hash, receipt);
  }
}

/** Marks rows paid only for recipients the chain confirms; the rest go back to unpaid. */
async function settle(c, hash, receipt) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    if (receipt.status !== "success") {
      await db.query("update reward_ledger set paid_tx = null, paid_at = null where paid_tx = $1", [hash]);
      await db.query("update reward_payouts set status = 'failed' where tx_hash = $1", [hash]);
      log(`${c.name}: payout ${hash} failed, will retry tomorrow`);
    } else {
      const unpaid = [];
      for (const l of receipt.logs) {
        if (l.address.toLowerCase() !== c.disperse.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: disperseAbi, data: l.data, topics: l.topics });
          if (ev.eventName === "Unpaid") unpaid.push(ev.args.to.toLowerCase());
        } catch {}
      }
      if (unpaid.length) {
        await db.query("update reward_ledger set paid_tx = null, paid_at = null where paid_tx = $1 and owner = any($2::text[])", [hash, unpaid]);
        log(`${c.name}: ${unpaid.length} wallet(s) refused the payment; kept as owed`);
      }
      await db.query("update reward_ledger set paid_at = now() where paid_tx = $1 and paid_at is null", [hash]);
      await db.query("update reward_payouts set status = 'confirmed' where tx_hash = $1", [hash]);
      log(`${c.name}: payout ${hash} confirmed`);
    }
    await db.query("commit");
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    db.release();
  }
}

async function collectFees(c) {
  // Coins on this chain whose sasa fee share goes to the splitter.
  const { rows } = await pool.query("select curve from curves where chain_id = $1", [c.chainId]);
  let claimed = 0;
  for (const { curve } of rows) {
    try {
      const addr = getAddress(curve);
      const [recipient, fees] = await Promise.all([
        c.pub.readContract({ address: addr, abi: curveAbi, functionName: "protocolFeeRecipient" }),
        c.pub.readContract({ address: addr, abi: curveAbi, functionName: "protocolFees" }),
      ]);
      // v5 coins pay sasa's share into the splitter; v6 coins pay it straight to this
      // rewards wallet. Either way, claiming only moves it to where it already belongs.
      const ours = getAddress(recipient) === c.splitter || getAddress(recipient) === account.address;
      if (!ours || fees < (c.token ? MIN_CLAIM_USDC : MIN_CLAIM)) continue;
      await simpleTx(c, addr, curveAbi, "claimProtocolFees");
      claimed++;
    } catch (e) {
      log(`${c.name}: claim ${curve}: ${e.shortMessage ?? e.message}`);
    }
  }
  const held = c.token
    ? await c.pub.readContract({ address: c.token, abi: erc20Abi, functionName: "balanceOf", args: [c.splitter] })
    : await c.pub.getBalance({ address: c.splitter });
  if (held > 0n) await simpleTx(c, c.splitter, splitterAbi, "distribute");
  if (claimed || held) log(`${c.name}: collected fees from ${claimed} coin(s), split ${held} wei`);
}

async function payChain(c) {
  const today = new Date().toISOString().slice(0, 10);
  const done = await pool.query("select 1 from reward_payouts where chain_id = $1 and day = $2 and status <> 'failed' limit 1", [c.chainId, today]);
  if (done.rowCount) return;

  // USDC chains: amounts are 6-decimal dollars. Otherwise the chain's coin at its price.
  let minWei, capWei;
  if (c.token) {
    minWei = BigInt(Math.round(MIN_PAYOUT_USD * 1e6));
    capWei = BigInt(Math.round(DAILY_CAP_USD * 1e6));
  } else {
    const price = await usdPrice(c.native ?? "ETH");
    if (!price) {
      log(`${c.name}: no ${c.native ?? "ETH"} price right now, paying later`);
      return;
    }
    minWei = usdToWei(MIN_PAYOUT_USD, price);
    capWei = usdToWei(DAILY_CAP_USD, price);
  }

  await collectFees(c);

  const gas = await c.pub.getBalance({ address: account.address });
  let budget;
  if (c.token) {
    if (gas < MIN_GAS) {
      log(`${c.name}: the rewards wallet needs a little ${c.native ?? "ETH"} for gas; paying later`);
      await alert("rewards", `gas-${c.name}`, `the rewards wallet ${account.address} needs ${c.native ?? "ETH"} for gas on ${c.name}; payouts and auto orders wait until it's topped up.`);
      return;
    }
    budget = await c.pub.readContract({ address: c.token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  } else {
    budget = gas > GAS_RESERVE ? gas - GAS_RESERVE : 0n;
  }
  if (budget > capWei) budget = capWei;

  const { rows } = await pool.query(
    `select owner, sum(amount)::text as owed, array_agg(id) as ids
     from reward_ledger where chain_id = $1 and paid_tx is null
     group by owner having sum(amount) >= $2::numeric
     order by min(created_at)`,
    [c.chainId, minWei.toString()]
  );
  const pay = [];
  let total = 0n;
  for (const r of rows) {
    const amt = BigInt(r.owed.split(".")[0]);
    if (total + amt > budget) continue;
    pay.push({ owner: getAddress(r.owner), amount: amt, ids: r.ids });
    total += amt;
  }
  if (rows.length && pay.length < rows.length) {
    log(`${c.name}: rewards wallet covers ${pay.length} of ${rows.length} payouts today; top it up or wait for more fees`);
  }
  if (!pay.length) return;

  const round = BigInt(Math.floor(Date.now() / 86_400_000));
  for (let i = 0; i < pay.length; i += BATCH) {
    const part = pay.slice(i, i + BATCH);
    const sum = part.reduce((s, p) => s + p.amount, 0n);
    if (DRY) {
      log(`[dry] ${c.name}: would pay ${part.length} wallet(s), ${sum} wei`);
      continue;
    }
    const { encodeFunctionData } = await import("viem");
    if (c.token) {
      // The batch payer pulls the USDC: approve exactly this batch first.
      await simpleTx(c, c.token, erc20Abi, "approve", [c.disperse, sum]);
    }
    const data = c.token
      ? encodeFunctionData({
          abi: disperseAbi,
          functionName: "disperseToken",
          args: [c.splitter, c.token, part.map((p) => p.owner), part.map((p) => p.amount), round],
        })
      : encodeFunctionData({
          abi: disperseAbi,
          functionName: "disperseEth",
          args: [c.splitter, part.map((p) => p.owner), part.map((p) => p.amount), round],
        });
    const hash = await sendSaved(c, c.token ? { to: c.disperse, data } : { to: c.disperse, data, value: sum }, async (h, raw) => {
      // Saved before sending: this is what makes a crash unable to pay twice.
      const db = await pool.connect();
      try {
        await db.query("begin");
        await db.query(
          "insert into reward_payouts (chain_id, tx_hash, raw_tx, total, recipients, day) values ($1, $2, $3, $4, $5, $6)",
          [c.chainId, h, raw, sum.toString(), part.length, today]
        );
        await db.query("update reward_ledger set paid_tx = $1 where id = any($2::bigint[]) and paid_tx is null", [h, part.flatMap((p) => p.ids)]);
        await db.query("commit");
      } catch (e) {
        await db.query("rollback");
        throw e;
      } finally {
        db.release();
      }
    });
    log(`${c.name}: sent payout ${hash} to ${part.length} wallet(s)`);
    const receipt = await c.pub.waitForTransactionReceipt({ hash, timeout: 300_000 }).catch(() => null);
    if (receipt) await settle(c, hash, receipt);
  }
}

// ------------------------------------------------------------------ main

async function main() {
  log(`rewards service for ${CHAINS.map((c) => c.name).join(", ")}; wallet ${account.address}${DRY ? " (dry run)" : ""}`);
  for (const c of CHAINS) {
    const r = await c.pub.readContract({ address: c.splitter, abi: splitterAbi, functionName: "rewards" }).catch(() => null);
    if (r && getAddress(r) !== account.address) log(`WARNING ${c.name}: the splitter pays ${r}, not this wallet`);
  }
  // Auto orders run on their own, quicker loop (one per chain).
  for (const c of CHAINS) {
    void ordersLoop(c, pool, log, account).catch((e) => log(`${c.name} orders stopped: ${e.message}`));
  }
  if (USD) log(`dollar rewards: paid in USDC on Base from ${account.address}`);
  let lastLedger = 0;
  let lastPerp = 0;
  let lastFund = 0;
  let sweptDay = "";
  for (;;) {
    await heartbeat("rewards");
    try {
      if (Date.now() - lastLedger > 5 * 60_000) {
        await buildLedger();
        const u = await buildUsdLedger(pool, {
          protocolBps: PROTOCOL_BPS,
          referralBps: REFERRAL_BPS,
          months: REFERRAL_MONTHS,
          chainIds: REWARD_CHAIN_IDS,
        });
        if (u.race || u.ext) log(`ledger: +${u.race} race, +${u.ext} other-DEX rewards (dollars)`);
        lastLedger = Date.now();
      }
      if (HL_BUILDER && Date.now() - lastPerp > 10 * 60_000) {
        lastPerp = Date.now();
        const p = await buildPerpLedger(pool, {
          builder: HL_BUILDER,
          base: env("HL_FILLS", "https://stats-data.hyperliquid.xyz/Mainnet/builder_fills"),
          referralBps: Number(REFERRAL_BPS),
          months: REFERRAL_MONTHS,
          decompress: (b) => lz4.decompress(b),
        }).catch(async (e) => {
          log(`futures rewards: ${e.message}`);
          await alert("rewards", "perp-fills", `futures invite rewards: ${e.message}`);
          return { fills: 0 };
        });
        if (p.fills) log(`ledger: +${p.fills} futures rewards (dollars)`);
        if (p.missing?.length) {
          await alert("rewards", `perp-missing-${p.missing[0]}`, `Hyperliquid's file of sasa's futures fills for ${p.missing.join(", ")} never appeared (HL_FILLS / builder address right?); those days count as no futures fills.`);
        }
        // Hyperliquid only charges sasa's futures fee while this account holds at least $100
        const v = await builderAccountUsd(env("HL_API", "https://api.hyperliquid.xyz"), HL_BUILDER).catch(() => null);
        if (v !== null && v < 100) {
          await alert("rewards", "hl-builder", `sasa's futures fee account ${HL_BUILDER} holds $${v.toFixed(2)} on Hyperliquid; it needs at least $100 (USDC in its perps account) or sasa's futures fee stops being charged.`);
        }
      }
      const paused = (await pool.query("select paused from rewards_state where id = 1")).rows[0]?.paused;
      for (const c of CHAINS) {
        try {
          await reconcile(c);
          if (!paused && new Date().getUTCHours() >= PAYOUT_HOUR) await payChain(c);
        } catch (e) {
          log(`${c.name}: ${e.shortMessage ?? e.message}`);
          await alert("rewards", `chain-${c.name}`, `${c.name}: ${e.shortMessage ?? e.message}`);
        }
      }
      // funding itself: claim Relay's app fees, bring everything to USDC on Base
      if (FUND.length && Date.now() - lastFund > FUND_MS) {
        lastFund = Date.now();
        try {
          if (env("CLAIM_RELAY", "true") !== "false" && !DRY) await claimRelayFees({ account, apiKey: process.env.RELAY_API_KEY, log });
        } catch (e) {
          log(`relay claim: ${e.message}`);
          await alert("rewards", "relay-claim", `claiming Relay's app fees failed: ${e.message}`);
        }
        if (!DRY) {
          const f = await convertToBase({ chains: FUND, account, apiKey: process.env.RELAY_API_KEY, price: usdPrice, log }).catch((e) => ({ moved: 0, errors: [e.message] }));
          if (f.errors.length) await alert("rewards", "fund", `moving the rewards wallet's money to USDC on Base: ${f.errors.join("; ")}`);
        }
      }
      if (USD) {
        try {
          await reconcileUsd(pool, USD, log, account);
          if (!paused && new Date().getUTCHours() >= PAYOUT_HOUR) {
            const r = await payUsd(pool, USD, account, { minUsd: MIN_PAYOUT_USD, capUsd: DAILY_CAP_USD, minGasWei: MIN_GAS, log, dry: DRY });
            if (r.refused?.length) {
              await alert("rewards", "usd-refused", `USDC on Base won't send to ${r.refused.join(", ")}; their invite rewards stay owed and everyone else was paid.`);
            }
            if (r.noGas) {
              await alert("rewards", "usd-gas", `the rewards wallet ${account.address} needs a little ETH on Base for gas; invite rewards wait until it's topped up.`);
            } else if (r.short > 0n && !r.capped) {
              await alert("rewards", "usd-short", `the rewards wallet ${account.address} is ${(Number(r.short) / 1e6).toFixed(2)} USDC short on Base for today's invite rewards; they stay owed and are paid as the fee vault and Relay fees bring more in.`);
            }
            // once a day, after paying: what's above what's owed + the reserve goes to the treasury
            const today = new Date().toISOString().slice(0, 10);
            if (sweptDay !== today) {
              sweptDay = today;
              await sweepSurplus(pool, USD, account, { treasury: SASA_TREASURY, keepUsd: KEEP_USD, log, dry: DRY });
            }
          }
        } catch (e) {
          log(`usd: ${e.shortMessage ?? e.message}`);
          await alert("rewards", "usd", `invite rewards (USDC on Base): ${e.shortMessage ?? e.message}`);
        }
      }
    } catch (e) {
      if (/relation "(reward_ledger|rewards_state|referrals|reward_payouts|reward_perp_users|race_trades|race_chains|ext_trades)" does not exist/.test(e.message)) {
        log("run indexer/rewards.sql and indexer/rewards-v7.sql in Supabase first");
      } else {
        log(`rewards: ${e.message}`);
        await alert("rewards", "loop", e.message);
      }
    }
    await sleep(Number(process.env.LOOP_MS ?? 60_000));
  }
}

main().catch(async (e) => {
  log("fatal", e);
  await alert("rewards", "fatal", `stopped: ${e?.message ?? e}`);
  process.exit(1);
});
