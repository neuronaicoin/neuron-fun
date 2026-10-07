// Neuron.fun indexer: follows every chain's curve factory and curves and
// keeps Postgres in step, so the website can show coins, trades, charts
// and holders instantly, however many there are.
//
// Each batch of blocks is written in one database transaction together
// with the new checkpoint, so a crash or restart never loses or doubles
// anything: the batch is simply read again.
//
// Env:
//   DATABASE_URL    Postgres connection string (Supabase: Project Settings -> Database)
//   CHAINS          JSON array: [{ "name", "chainId", "rpc", "factory", "startBlock", "router"? }]
//                   factory: one address, or a list with the LIVE factory first and
//                            earlier ones after it (their coins keep being indexed)
//                   router:  the pool router(s), same format, so trades after
//                            graduation are indexed too
//   ADMINS          admin wallets for pause / capacity alerts (see safety.mjs)
//   CHAINS[].orders the SasaOrders contract(s): trades it makes are credited to the order owner
//   CONFIRMATIONS   blocks to stay behind the tip (default 3)
//   MAX_RANGE       blocks per batch (default 2000)
//   POLL_MS         pause when caught up (default 2500)
//   REFRESH_MS      how often the precomputed coin list is rebuilt (default 10000)
//   Price alerts and web push: see alerts.mjs

import pg from "pg";
import { cardLoop, extCardLoop } from "./cards.mjs";
import { alertLoop } from "./alerts.mjs";
import { safetyLoop } from "./safety.mjs";
import { copyLoop } from "./copy.mjs";
import { sparkLoop } from "./spark.mjs";
import { pointsLoop } from "./points.mjs";
import { badgesLoop } from "./badges.mjs";
import { marketsLoop } from "./markets.mjs";
import { seoLoop } from "./seo.mjs";
import { createPublicClient, defineChain, getAddress, http, parseAbi, parseAbiItem } from "viem";

const env = (n, d) => {
  const v = process.env[n];
  if (v === undefined || v === "") {
    if (d === undefined) throw new Error(`missing env ${n}`);
    return d;
  }
  return v;
};

const CONFIRMATIONS = BigInt(env("CONFIRMATIONS", "3"));
const MAX_RANGE = BigInt(env("MAX_RANGE", "2000"));
const POLL_MS = Number(env("POLL_MS", "2500"));
const REFRESH_MS = Number(env("REFRESH_MS", "10000"));
const list = (v) => (v ? (Array.isArray(v) ? v : [v]).map((a) => getAddress(a)) : []);
const CHAINS = JSON.parse(env("CHAINS")).map((c) => ({
  ...c,
  factories: list(c.factory),
  // The live factory (new launches, beta locks) is the first one.
  factory: list(c.factory)[0],
  routers: list(c.router),
  // v6 omnichain coins (optional): the OmniFactory on this chain. Its launches are indexed
  // as coins too, and its own buys (the creator's first buy) are credited to the creator.
  omniFactory: c.omniFactory ? getAddress(c.omniFactory) : null,
  // Paid placement contract (SasaBoost), mainnet: "Boosted" row on Explore.
  boost: c.boost ? getAddress(c.boost) : null,
  // Auto-orders contracts: their fills are credited to the order's owner.
  orders: list(c.orders),
  startBlock: BigInt(c.startBlock ?? 0),
}));

const pool = new pg.Pool({
  connectionString: env("DATABASE_URL"),
  max: CHAINS.length + 2,
  ssl: /localhost|127\.0\.0\.1/.test(env("DATABASE_URL")) ? false : { rejectUnauthorized: false },
});

let lockWarned = false;
let omniWarned = false;
const launchedEvent = parseAbiItem(
  "event Launched(address indexed curve, address indexed token, address indexed creator, bytes32 launchKey, string name, string symbol, uint8 feeMode)"
);
const curveEvents = parseAbi([
  "event Trade(address indexed trader, bool indexed isBuy, uint256 nativeAmount, uint256 tokenAmount, uint256 fee, uint256 virtualNative, uint256 virtualToken)",
  "event Closed(bytes32 indexed report)",
  "event Graduated(bytes32 indexed report, uint256 nativeToPool, uint256 tokensToPool, uint256 tokensBurned)",
  // v6 (omnichain) curves
  "event Frozen(uint256 realNative, uint256 sold)",
  "event Reopened()",
  "event Settled(uint32 winnerEid, bool winner, uint256 moneyOut, uint256 poolTokens)",
]);
// v6 launch. The coin has the same address on every chain; coinId = keccak(creator, launchKey).
const boostedEvent = parseAbiItem("event Boosted(address indexed coin, address indexed payer, uint256 plan, uint256 paid, uint64 until)");
const omniLaunchedEvent = parseAbiItem(
  "event Launched(bytes32 indexed coinId, address indexed coin, address indexed curve, address creator, uint32[] eids, string name, string symbol, string logo, string description, uint256 lockSeconds, uint8 feeMode)"
);
// Curve states: 0 trading, 1 closed (v5: sells only), 2 graduated,
// 3 frozen (v6: graduation being decided), 4 moved (v6: lost the race, coins moved to the winner).
const STATE_FROZEN = 3;
const STATE_MOVED = 4;
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const orderExecutedEvent = parseAbiItem(
  "event Executed(uint256 indexed id, address indexed owner, address indexed curve, bool isBuy, uint256 amountIn, uint256 amountOut)"
);
const poolTradeEvent = parseAbiItem(
  "event PoolTrade(address indexed token, address indexed trader, bool indexed isBuy, uint256 nativeAmount, uint256 tokenAmount, uint160 sqrtPriceX96After)"
);
// Dollar-edition routers trade against USDC (router.usdc()); ETH routers have
// no such function (the quote is the chain's coin, address 0). Cached per router.
const QUOTE_CACHE = new Map();
async function quoteTokenOf(pub, router, usdChain) {
  const key = router.toLowerCase();
  if (QUOTE_CACHE.has(key)) return QUOTE_CACHE.get(key);
  try {
    const q = await pub.readContract({ address: router, abi: parseAbi(["function usdc() view returns (address)"]), functionName: "usdc" });
    QUOTE_CACHE.set(key, q);
    return q;
  } catch {
    // ETH routers have no usdc(): remember that. On a dollar chain it was a
    // network hiccup: don't remember, ask again next time.
    if (!usdChain) QUOTE_CACHE.set(key, null);
    return null;
  }
}

const Q96 = 2 ** 96;
const curveReadAbi = parseAbi([
  "function initialVirtualNative() view returns (uint256)",
  "function initialVirtualToken() view returns (uint256)",
]);
const tokenReadAbi = parseAbi([
  "function logo() view returns (string)",
  "function description() view returns (string)",
  "function lockedUntil() view returns (uint256)",
]);

const ZERO = "0x0000000000000000000000000000000000000000";
const log = (...a) => console.log(new Date().toISOString(), ...a);
const lc = (a) => a.toLowerCase();

// ------------------------------------------------------------------ per chain

function makeChain(c) {
  const chain = defineChain({
    id: c.chainId,
    name: c.name,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [c.rpc] } },
  });
  return { ...c, pub: createPublicClient({ chain, transport: http(c.rpc, { retryCount: 3, timeout: 20_000 }) }) };
}

async function knownCurves(db, chainId) {
  const r = await db.query(
    "select k.curve, k.token, k.coin_id, k.initial_virtual_native, c.creator from curves k join coins c on c.id = k.coin_id where k.chain_id = $1",
    [chainId]
  );
  const byCurve = new Map();
  const byToken = new Map();
  const tokens = [];
  for (const row of r.rows) {
    byCurve.set(row.curve, row);
    byToken.set(row.token, row);
    tokens.push(row.token);
  }
  return { byCurve, byToken, tokens };
}

async function blockTimes(pub, numbers) {
  const out = new Map();
  await Promise.all(
    [...new Set(numbers.map(String))].map(async (n) => {
      const b = await pub.getBlock({ blockNumber: BigInt(n) });
      out.set(n, new Date(Number(b.timestamp) * 1000));
    })
  );
  return out;
}

async function getLogsChunked(pub, args, addresses) {
  if (addresses && addresses.length === 0) return [];
  if (!addresses) return pub.getLogs(args);
  const out = [];
  for (let i = 0; i < addresses.length; i += 200) {
    out.push(...(await pub.getLogs({ ...args, address: addresses.slice(i, i + 200) })));
  }
  return out;
}

async function indexRange(c, from, to) {
  const { pub } = c;

  // 1. New coins on this chain.
  const launches = await pub.getLogs({ address: c.factories, event: launchedEvent, fromBlock: from, toBlock: to });
  const launchInfo = await Promise.all(
    launches.map(async (l) => {
      const [ivn, logo, description] = await Promise.all([
        pub.readContract({ address: l.args.curve, abi: curveReadAbi, functionName: "initialVirtualNative" }),
        pub.readContract({ address: l.args.token, abi: tokenReadAbi, functionName: "logo" }).catch(() => ""),
        pub.readContract({ address: l.args.token, abi: tokenReadAbi, functionName: "description" }).catch(() => ""),
      ]);
      const ivt = await pub.readContract({ address: l.args.curve, abi: curveReadAbi, functionName: "initialVirtualToken" });
      // Creator lock (v4 coins; older tokens don't have it).
      const lockedUntil = await pub.readContract({ address: l.args.token, abi: tokenReadAbi, functionName: "lockedUntil" }).catch(() => 0n);
      return { l, ivn, ivt, logo, description, lockedUntil };
    })
  );

  const omniLaunches = c.omniFactory
    ? await pub.getLogs({ address: c.omniFactory, event: omniLaunchedEvent, fromBlock: from, toBlock: to })
    : [];
  const omniInfo = await Promise.all(
    omniLaunches.map(async (l) => {
      const [ivn, ivt, lockedUntil] = await Promise.all([
        pub.readContract({ address: l.args.curve, abi: curveReadAbi, functionName: "initialVirtualNative" }),
        pub.readContract({ address: l.args.curve, abi: curveReadAbi, functionName: "initialVirtualToken" }),
        pub.readContract({ address: l.args.coin, abi: tokenReadAbi, functionName: "lockedUntil" }).catch(() => 0n),
      ]);
      return { l, ivn, ivt, lockedUntil };
    })
  );

  const boosts = c.boost
    ? await pub.getLogs({ address: c.boost, event: boostedEvent, fromBlock: from, toBlock: to }).catch(() => [])
    : [];

  const db = await pool.connect();
  try {
    await db.query("begin");

    for (const { l, ivn, ivt, logo, description, lockedUntil } of launchInfo) {
      const a = l.args;
      const coinId = `${lc(a.creator)}:${a.launchKey}`;
      const ts = (await blockTimes(pub, [l.blockNumber])).get(String(l.blockNumber));
      await db.query(
        `insert into coins (id, creator, launch_key, name, symbol, logo, description, created_at, fee_mode)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (id) do nothing`,
        [coinId, lc(a.creator), a.launchKey, a.name, a.symbol, logo, description, ts, Number(a.feeMode ?? 0)]
      );
      await db.query(
        `insert into curves (chain_id, curve, token, coin_id, initial_virtual_native, virtual_native, virtual_token, created_block, created_at)
         values ($1,$2,$3,$4,$5,$5,$6,$7,$8) on conflict (chain_id, curve) do nothing`,
        [c.chainId, lc(a.curve), lc(a.token), coinId, ivn.toString(), ivt.toString(), l.blockNumber.toString(), ts]
      );
      if (lockedUntil > 0n) {
        // In a savepoint: if lock.sql hasn't been run yet, indexing carries on.
        await db.query("savepoint lock_row");
        try {
          await db.query(
            `insert into coin_lock (coin_id, chain_id, until) values ($1, $2, to_timestamp($3))
             on conflict (coin_id, chain_id) do update set until = excluded.until`,
            [coinId, c.chainId, Number(lockedUntil)]
          );
          await db.query("release savepoint lock_row");
        } catch (e) {
          await db.query("rollback to savepoint lock_row");
          if (!lockWarned) log("creator locks: run indexer/lock.sql in Supabase");
          lockWarned = true;
        }
      }
    }

    // 1a. Boosts (boost.sql). The coin's address is the same on every chain; keep the latest end.
    if (boosts.length) {
      await db.query("savepoint boost_rows");
      try {
        for (const l of boosts) {
          await db.query(
            `insert into coin_boost (coin, until) values ($1, to_timestamp($2))
             on conflict (coin) do update set until = greatest(coin_boost.until, excluded.until)`,
            [lc(l.args.coin), Number(l.args.until)]
          );
        }
        await db.query("release savepoint boost_rows");
      } catch (e) {
        await db.query("rollback to savepoint boost_rows");
        log("boosts: run indexer/boost.sql in Supabase");
      }
    }

    // 1b. v6 omnichain launches.
    for (const { l, ivn, ivt, lockedUntil } of omniInfo) {
      const a = l.args;
      // Same "creator:key" form as v5 ids (key = the v6 coin id), so links keep working.
      const coinId = `${lc(a.creator)}:${a.coinId}`;
      const ts = (await blockTimes(pub, [l.blockNumber])).get(String(l.blockNumber));
      await db.query(
        `insert into coins (id, creator, launch_key, name, symbol, logo, description, created_at, fee_mode)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (id) do nothing`,
        [coinId, lc(a.creator), a.coinId, a.name, a.symbol, a.logo, a.description, ts, Number(a.feeMode ?? 0)]
      );
      await db.query(
        `insert into curves (chain_id, curve, token, coin_id, initial_virtual_native, virtual_native, virtual_token, created_block, created_at)
         values ($1,$2,$3,$4,$5,$5,$6,$7,$8) on conflict (chain_id, curve) do nothing`,
        [c.chainId, lc(a.curve), lc(a.coin), coinId, ivn.toString(), ivt.toString(), l.blockNumber.toString(), ts]
      );
      // Which chains the coin launched on (omni.sql). In a savepoint: indexing goes on without it.
      await db.query("savepoint omni_row");
      try {
        await db.query(
          `insert into coin_omni (coin_id, coin, eids) values ($1, $2, $3)
           on conflict (coin_id) do update set eids = excluded.eids`,
          [coinId, lc(a.coin), a.eids.map(Number)]
        );
        if (lockedUntil > 0n) {
          await db.query(
            `insert into coin_lock (coin_id, chain_id, until) values ($1, $2, to_timestamp($3))
             on conflict (coin_id, chain_id) do update set until = excluded.until`,
            [coinId, c.chainId, Number(lockedUntil)]
          );
        }
        await db.query("release savepoint omni_row");
      } catch (e) {
        await db.query("rollback to savepoint omni_row");
        if (!omniWarned) log("v6 coins: run indexer/omni.sql in Supabase");
        omniWarned = true;
      }
    }

    const known = await knownCurves(db, c.chainId);

    // 2. Trades and lifecycle events, only from our own curves.
    const curveLogs = (
      await pub.getLogs({ events: curveEvents, fromBlock: from, toBlock: to })
    ).filter((l) => known.byCurve.has(lc(l.address)));
    curveLogs.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
    const times = await blockTimes(pub, curveLogs.map((l) => l.blockNumber));

    // Auto-order fills: the orders contract trades, but the trade is its owner's.
    const orderOwner = new Map(); // tx hash -> owner
    if (c.orders.length) {
      const fills = await pub.getLogs({ address: c.orders, event: orderExecutedEvent, fromBlock: from, toBlock: to });
      for (const f of fills) orderOwner.set(lc(f.transactionHash), lc(f.args.owner));
    }
    const isOrders = (a) => c.orders.some((o) => lc(o) === lc(a));
    const traderOf = (a, tx) => (isOrders(a) ? orderOwner.get(lc(tx)) ?? lc(a) : lc(a));

    for (const l of curveLogs) {
      const k = known.byCurve.get(lc(l.address));
      const ts = times.get(String(l.blockNumber));
      if (l.eventName === "Trade") {
        const a = l.args;
        const price = (Number(a.virtualNative) / Number(a.virtualToken)).toPrecision(18);
        const ins = await db.query(
          `insert into trades (chain_id, tx_hash, log_index, block_number, ts, curve, coin_id, trader, is_buy,
                               native_amount, token_amount, fee, price)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           on conflict do nothing returning 1`,
          [c.chainId, l.transactionHash, l.logIndex, l.blockNumber.toString(), ts, k.curve, k.coin_id,
           // The opening buy is made by the factory on the creator's behalf: credit the creator.
           c.factories.some((f) => lc(f) === lc(a.trader)) || (c.omniFactory && lc(c.omniFactory) === lc(a.trader)) ? k.creator : traderOf(a.trader, l.transactionHash), a.isBuy,
           a.nativeAmount.toString(), a.tokenAmount.toString(), a.fee.toString(), price]
        );
        if (ins.rowCount) {
          await db.query(
            `update curves set virtual_native = $3, virtual_token = $4, real_native = $3::numeric - initial_virtual_native
             where chain_id = $1 and curve = $2`,
            [c.chainId, k.curve, a.virtualNative.toString(), a.virtualToken.toString()]
          );
        }
      } else if (l.eventName === "Closed") {
        await db.query("update curves set state = 1 where chain_id = $1 and curve = $2 and state = 0", [c.chainId, k.curve]);
      } else if (l.eventName === "Frozen") {
        await db.query("update curves set state = $3 where chain_id = $1 and curve = $2 and state = 0", [c.chainId, k.curve, STATE_FROZEN]);
      } else if (l.eventName === "Reopened") {
        await db.query("update curves set state = 0 where chain_id = $1 and curve = $2 and state = $3", [c.chainId, k.curve, STATE_FROZEN]);
      } else if (l.eventName === "Settled") {
        const won = l.args.winner;
        await db.query("update curves set state = $3, real_native = 0 where chain_id = $1 and curve = $2", [c.chainId, k.curve, won ? 2 : STATE_MOVED]);
        if (won) {
          await db.query("update coins set graduated_chain = $2, graduated_at = $3 where id = $1 and graduated_chain is null", [k.coin_id, c.chainId, ts]);
        }
      } else if (l.eventName === "Graduated") {
        await db.query("update curves set state = 2, real_native = 0 where chain_id = $1 and curve = $2", [c.chainId, k.curve]);
        await db.query(
          "update coins set graduated_chain = $2, graduated_at = $3 where id = $1 and graduated_chain is null",
          [k.coin_id, c.chainId, ts]
        );
      }
    }

    // 2b. Trades in the locked pools after graduation (through our router).
    let poolTrades = 0;
    if (c.routers.length) {
      const logs = (await pub.getLogs({ address: c.routers, event: poolTradeEvent, fromBlock: from, toBlock: to })).filter((l) =>
        known.byToken.has(lc(l.args.token))
      );
      const ptimes = await blockTimes(pub, logs.map((l) => l.blockNumber));
      for (const l of logs) {
        const a = l.args;
        const k = known.byToken.get(lc(a.token));
        // Pool price is currency1 per currency0. ETH (address 0) is always
        // currency0; USDC can be either, depending on the two addresses.
        const sp = Number(a.sqrtPriceX96After) / Q96;
        const usdChain = c.quote === "USDC";
        const quote = await quoteTokenOf(pub, l.address, usdChain);
        let nativePerToken;
        if (usdChain && quote === null) {
          // Couldn't ask the router which coin it quotes in: use this trade's own price.
          nativePerToken = a.tokenAmount > 0n ? Number(a.nativeAmount) / Number(a.tokenAmount) : 0;
        } else {
          const quoteIsCurrency1 = quote !== null && BigInt(quote) > BigInt(a.token);
          nativePerToken = sp > 0 ? (quoteIsCurrency1 ? sp * sp : 1 / (sp * sp)) : 0;
        }
        // The 1% pool fee: taken from the native coin on buys, from the tokens on sells.
        const fee = a.isBuy ? (a.nativeAmount * 1n) / 100n : a.nativeAmount / 99n;
        const ins = await db.query(
          `insert into trades (chain_id, tx_hash, log_index, block_number, ts, curve, coin_id, trader, is_buy,
                               native_amount, token_amount, fee, price)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           on conflict do nothing returning 1`,
          [c.chainId, l.transactionHash, l.logIndex, l.blockNumber.toString(), ptimes.get(String(l.blockNumber)), k.curve, k.coin_id,
           traderOf(a.trader, l.transactionHash), a.isBuy, a.nativeAmount.toString(), a.tokenAmount.toString(), fee.toString(), nativePerToken.toPrecision(18)]
        );
        if (ins.rowCount && nativePerToken > 0) {
          // Keep the market value current: virtual_native / virtual_token = pool price.
          await db.query(
            `update curves set virtual_native = $3, virtual_token = $4 where chain_id = $1 and curve = $2 and state = 2`,
            [c.chainId, k.curve, BigInt(Math.round(nativePerToken * 1e27)).toString(), (10n ** 27n).toString()]
          );
        }
        poolTrades++;
      }
    }

    // 3. Token transfers -> balances. Each transfer is applied once.
    const transfers = await getLogsChunked(pub, { event: transferEvent, fromBlock: from, toBlock: to }, known.tokens);
    for (const l of transfers) {
      const a = l.args;
      const ins = await db.query(
        `insert into transfers (chain_id, tx_hash, log_index, token, from_addr, to_addr, amount)
         values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning 1`,
        [c.chainId, l.transactionHash, l.logIndex, lc(l.address), lc(a.from), lc(a.to), a.value.toString()]
      );
      if (!ins.rowCount || a.value === 0n) continue;
      for (const [holder, delta] of [[lc(a.from), `-${a.value}`], [lc(a.to), a.value.toString()]]) {
        if (holder === ZERO) continue;
        await db.query(
          `insert into balances (chain_id, token, holder, amount) values ($1,$2,$3,$4)
           on conflict (chain_id, token, holder) do update set amount = balances.amount + excluded.amount`,
          [c.chainId, lc(l.address), holder, delta]
        );
      }
    }

    await db.query(
      `insert into indexer_state (chain_id, last_block) values ($1, $2)
       on conflict (chain_id) do update set last_block = excluded.last_block`,
      [c.chainId, to.toString()]
    );
    await db.query("commit");
    return {
      launches: launches.length,
      trades: curveLogs.filter((l) => l.eventName === "Trade").length + poolTrades,
      transfers: transfers.length,
    };
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

async function runChain(c) {
  let range = MAX_RANGE;
  for (;;) {
    try {
      const st = await pool.query("select last_block from indexer_state where chain_id = $1", [c.chainId]);
      const from = st.rowCount ? BigInt(st.rows[0].last_block) + 1n : c.startBlock;
      const tip = (await c.pub.getBlockNumber()) - CONFIRMATIONS;
      if (from > tip) {
        await sleep(POLL_MS);
        continue;
      }
      const to = from + range - 1n > tip ? tip : from + range - 1n;
      const r = await indexRange(c, from, to);
      if (r.launches || r.trades) log(`${c.name} ${from}-${to}: ${r.launches} launches, ${r.trades} trades, ${r.transfers} transfers`);
      if (range < MAX_RANGE) range = range * 2n > MAX_RANGE ? MAX_RANGE : range * 2n;
      if (to === tip) await sleep(POLL_MS);
    } catch (e) {
      // Too many logs or a flaky RPC: take smaller steps and try again.
      range = range > 10n ? range / 4n : 10n;
      log(`${c.name}: ${e.shortMessage ?? e.message} (retrying with ${range} blocks)`);
      await sleep(Math.min(POLL_MS * 2, 10_000));
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ main

/** Rebuilds the precomputed coin list the home page reads (see speed.sql). */
async function refreshLoop() {
  let warned = false;
  for (;;) {
    try {
      await pool.query("refresh materialized view concurrently coin_list");
    } catch (e) {
      // coin_list not created yet: run speed.sql. Keep indexing meanwhile.
      if (!warned) log(`coin list refresh skipped: ${e.message}`);
      warned = true;
    }
    await sleep(REFRESH_MS);
  }
}

async function main() {
  await pool.query("select 1");
  log(`indexing ${CHAINS.map((c) => c.name).join(", ")}`);
  const chains = CHAINS.map((c) => makeChain(c));
  await Promise.all([
    ...chains.map((c) => runChain(c)),
    refreshLoop(),
    cardLoop(pool, log),
    extCardLoop(pool, log),
    alertLoop(pool, log),
    safetyLoop(pool, chains, log),
    copyLoop(pool, log),
    sparkLoop(pool, log),
    pointsLoop(pool, log),
    badgesLoop(pool, log),
    marketsLoop(pool, log),
    seoLoop(pool, log),
  ]);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
