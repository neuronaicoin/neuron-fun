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
//   CHAINS          JSON array: [{ "name", "chainId", "rpc", "factory", "startBlock" }]
//   CONFIRMATIONS   blocks to stay behind the tip (default 3)
//   MAX_RANGE       blocks per batch (default 2000)
//   POLL_MS         pause when caught up (default 2500)

import pg from "pg";
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
const CHAINS = JSON.parse(env("CHAINS")).map((c) => ({
  ...c,
  factory: getAddress(c.factory),
  startBlock: BigInt(c.startBlock ?? 0),
}));

const pool = new pg.Pool({
  connectionString: env("DATABASE_URL"),
  max: CHAINS.length + 2,
  ssl: /localhost|127\.0\.0\.1/.test(env("DATABASE_URL")) ? false : { rejectUnauthorized: false },
});

const launchedEvent = parseAbiItem(
  "event Launched(address indexed curve, address indexed token, address indexed creator, bytes32 launchKey, string name, string symbol)"
);
const curveEvents = parseAbi([
  "event Trade(address indexed trader, bool indexed isBuy, uint256 nativeAmount, uint256 tokenAmount, uint256 fee, uint256 virtualNative, uint256 virtualToken)",
  "event Closed(bytes32 indexed report)",
  "event Graduated(bytes32 indexed report, uint256 nativeToPool, uint256 tokensToPool, uint256 tokensBurned)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const curveReadAbi = parseAbi([
  "function initialVirtualNative() view returns (uint256)",
  "function initialVirtualToken() view returns (uint256)",
]);
const tokenReadAbi = parseAbi(["function logo() view returns (string)", "function description() view returns (string)"]);

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
  const r = await db.query("select curve, token, coin_id, initial_virtual_native from curves where chain_id = $1", [chainId]);
  const byCurve = new Map();
  const tokens = [];
  for (const row of r.rows) {
    byCurve.set(row.curve, row);
    tokens.push(row.token);
  }
  return { byCurve, tokens };
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
  const launches = await pub.getLogs({ address: c.factory, event: launchedEvent, fromBlock: from, toBlock: to });
  const launchInfo = await Promise.all(
    launches.map(async (l) => {
      const [ivn, logo, description] = await Promise.all([
        pub.readContract({ address: l.args.curve, abi: curveReadAbi, functionName: "initialVirtualNative" }),
        pub.readContract({ address: l.args.token, abi: tokenReadAbi, functionName: "logo" }).catch(() => ""),
        pub.readContract({ address: l.args.token, abi: tokenReadAbi, functionName: "description" }).catch(() => ""),
      ]);
      const ivt = await pub.readContract({ address: l.args.curve, abi: curveReadAbi, functionName: "initialVirtualToken" });
      return { l, ivn, ivt, logo, description };
    })
  );

  const db = await pool.connect();
  try {
    await db.query("begin");

    for (const { l, ivn, ivt, logo, description } of launchInfo) {
      const a = l.args;
      const coinId = `${lc(a.creator)}:${a.launchKey}`;
      const ts = (await blockTimes(pub, [l.blockNumber])).get(String(l.blockNumber));
      await db.query(
        `insert into coins (id, creator, launch_key, name, symbol, logo, description, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do nothing`,
        [coinId, lc(a.creator), a.launchKey, a.name, a.symbol, logo, description, ts]
      );
      await db.query(
        `insert into curves (chain_id, curve, token, coin_id, initial_virtual_native, virtual_native, virtual_token, created_block, created_at)
         values ($1,$2,$3,$4,$5,$5,$6,$7,$8) on conflict (chain_id, curve) do nothing`,
        [c.chainId, lc(a.curve), lc(a.token), coinId, ivn.toString(), ivt.toString(), l.blockNumber.toString(), ts]
      );
    }

    const known = await knownCurves(db, c.chainId);

    // 2. Trades and lifecycle events, only from our own curves.
    const curveLogs = (
      await pub.getLogs({ events: curveEvents, fromBlock: from, toBlock: to })
    ).filter((l) => known.byCurve.has(lc(l.address)));
    curveLogs.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
    const times = await blockTimes(pub, curveLogs.map((l) => l.blockNumber));

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
          [c.chainId, l.transactionHash, l.logIndex, l.blockNumber.toString(), ts, k.curve, k.coin_id, lc(a.trader), a.isBuy,
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
      } else if (l.eventName === "Graduated") {
        await db.query("update curves set state = 2, real_native = 0 where chain_id = $1 and curve = $2", [c.chainId, k.curve]);
        await db.query(
          "update coins set graduated_chain = $2, graduated_at = $3 where id = $1 and graduated_chain is null",
          [k.coin_id, c.chainId, ts]
        );
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
    return { launches: launches.length, trades: curveLogs.filter((l) => l.eventName === "Trade").length, transfers: transfers.length };
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

async function main() {
  await pool.query("select 1");
  log(`indexing ${CHAINS.map((c) => c.name).join(", ")}`);
  await Promise.all(CHAINS.map((c) => runChain(makeChain(c))));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
