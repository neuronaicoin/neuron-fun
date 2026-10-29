// Elysium MAINNET points (sasa's launcher there, from Nov 9 2026). Waits by itself until the
// deploy workflow has written the mainnet addresses (elysiumnet.mjs), then gives airdrop points:
//   - first mainnet launch: the "elysium_main" quest, 100
//   - every launch: 50, at most 3 a day
//   - every buy or sale of a sasa coin there: 10, at most 10 a day
//   - the first 7 days after the launcher went live: 3x launch and trade points
//   - Day-1 Pass holders (mainnet pass, or the testnet pass): 2x, on top (6x in the first week)
//   - minting the mainnet Day-1 Pass: the "elysium_pass" quest, 50 (once, same as testnet)
// Daily caps keep it from being farmed by a script.

import { createPublicClient, defineChain, getAddress, http, parseAbiItem } from "viem";
import { elysiumMainnet } from "./elysiumnet.mjs";

const STEP = 5000n;
const EVERY_MS = 10_000;
const WAIT_MS = 2 * 60_000; // while mainnet isn't filled in yet
export const BOOST_X = 3;
export const BOOST_DAYS = 7;

const LAUNCHED = parseAbiItem(
  "event Launched(address indexed coin, address indexed creator, address pool, uint256 tokenId, string name, string symbol, string uri, uint256 startMc, uint256 firstBuyIn, uint256 firstBuyOut)"
);
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const SWAP = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");

export const SQL = `
create table if not exists elysium_state (id int primary key, last_block bigint not null);
create table if not exists elysium_coins (
  coin       text primary key,
  pool       text not null,
  creator    text not null,
  block      bigint not null,
  n          int,
  created_at timestamptz not null default now()
);
create table if not exists elysium_trades (
  tx         text primary key,
  trader     text not null,
  coin       text not null,
  block      bigint not null,
  created_at timestamptz not null default now()
);
create table if not exists elysium_main_pass (
  owner      text primary key,
  token_id   bigint not null,
  block      bigint not null,
  created_at timestamptz not null default now()
);
create table if not exists elysium_pass (
  owner      text primary key,
  token_id   bigint not null,
  block      bigint not null,
  created_at timestamptz not null default now()
);
alter table elysium_state enable row level security;
alter table elysium_coins enable row level security;
alter table elysium_trades enable row level security;
alter table elysium_main_pass enable row level security;
revoke all on elysium_state, elysium_coins, elysium_trades, elysium_main_pass from anon, authenticated;
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (a) => a.replace(/[^0-9a-fx]/gi, "").toLowerCase();

/** The multiplier for `owner` right now: 3x in the first week, 2x more with a Day-1 Pass. */
function multSql(owner, boost) {
  const o = clean(owner);
  return `(${boost ? BOOST_X : 1} * (case when exists (select 1 from elysium_main_pass where owner = '${o}')
            or exists (select 1 from elysium_pass where owner = '${o}') then 2 else 1 end))`;
}

const today = `date_trunc('day', now() at time zone 'utc') at time zone 'utc'`;

async function pointLaunch(pool, owner, coin, boost) {
  await pool.query(`insert into points_events (owner, kind, ref, pts) values ($1, 'quest', 'elysium_main', 100) on conflict do nothing`, [owner]);
  await pool.query(
    `insert into points_events (owner, kind, ref, pts)
     select $1, 'elysium_main', $2, 50 * ${multSql(owner, boost)}
     where (select count(*) from points_events where owner = $1 and kind = 'elysium_main' and ref like 'launch:%' and created_at >= ${today}) < 3
     on conflict do nothing`,
    [owner, `launch:${coin}`]
  );
}

async function pointTrade(pool, owner, tx, boost) {
  await pool.query(
    `insert into points_events (owner, kind, ref, pts)
     select $1, 'elysium_main', $2, 10 * ${multSql(owner, boost)}
     where (select count(*) from points_events where owner = $1 and kind = 'elysium_main' and ref like 'trade:%' and created_at >= ${today}) < 10
     on conflict do nothing`,
    [owner, `trade:${tx}`]
  );
}

export async function elysiumMainLoop(pool, log) {
  if (process.env.ELYSIUM_MAIN_OFF === "1") return;
  let cfg = null;
  while (!(cfg = await elysiumMainnet())) await sleep(WAIT_MS);
  await pool.query(SQL);
  const chain = defineChain({ id: cfg.chainId, name: "Elysium", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpc] } } });
  const pub = createPublicClient({ chain, transport: http(cfg.rpc, { retryCount: 2, timeout: 20_000 }) });
  // the 3x week: from the launcher going live (or ELYSIUM_BOOST_START, unix seconds)
  const start = Number(process.env.ELYSIUM_BOOST_START) || cfg.start || Math.floor(Date.now() / 1000);
  const boostEnd = (start + BOOST_DAYS * 86_400) * 1000;
  log(`elysium mainnet: launcher ${cfg.launcher}${cfg.pass ? `, Day-1 Pass ${cfg.pass}` : ""}; 3x points until ${new Date(boostEnd).toISOString()}`);
  let fails = 0;
  for (;;) {
    try {
      const st = await pool.query("select last_block from elysium_state where id = 1");
      const tip = await pub.getBlockNumber();
      let from = st.rowCount ? BigInt(st.rows[0].last_block) + 1n : (cfg.startBlock ?? (tip > 200_000n ? tip - 200_000n : 0n));
      while (from <= tip) {
        const to = from + STEP - 1n > tip ? tip : from + STEP - 1n;
        // points go by when it happened on chain: the first week is judged by the block's time
        const blockTime = new Map();
        const timeOf = async (bn) => {
          if (!blockTime.has(bn)) blockTime.set(bn, Number((await pub.getBlock({ blockNumber: bn })).timestamp) * 1000);
          return blockTime.get(bn);
        };
        const boostAt = async (bn) => (await timeOf(bn).catch(() => Date.now())) < boostEnd;

        const launches = await pub.getLogs({ address: cfg.launcher, event: LAUNCHED, fromBlock: from, toBlock: to });
        for (const l of launches) {
          const coin = getAddress(l.args.coin);
          const creator = l.args.creator.toLowerCase();
          await pool.query(
            `insert into elysium_coins (coin, pool, creator, block, n)
             values ($1, $2, $3, $4, (select count(*) + 1 from elysium_coins)) on conflict do nothing`,
            [coin, getAddress(l.args.pool), creator, l.blockNumber.toString()]
          );
          await pointLaunch(pool, creator, coin, await boostAt(l.blockNumber));
        }
        if (cfg.pass) {
          const mints = await pub.getLogs({ address: cfg.pass, event: TRANSFER, args: { from: "0x0000000000000000000000000000000000000000" }, fromBlock: from, toBlock: to });
          for (const m of mints) {
            const owner = m.args.to.toLowerCase();
            const r = await pool.query(`insert into elysium_main_pass (owner, token_id, block) values ($1, $2, $3) on conflict do nothing`, [owner, m.args.tokenId.toString(), m.blockNumber.toString()]);
            if (r.rowCount) await pool.query(`insert into points_events (owner, kind, ref, pts) values ($1, 'quest', 'elysium_pass', 50) on conflict do nothing`, [owner]);
          }
          if (mints.length) log(`elysium mainnet: ${mints.length} Day-1 Pass mint(s)`);
        }
        const pools = (await pool.query("select pool, coin from elysium_coins")).rows;
        if (pools.length) {
          const coinOf = new Map(pools.map((p) => [p.pool.toLowerCase(), p.coin]));
          const swaps = await pub.getLogs({ address: pools.map((p) => p.pool), event: SWAP, fromBlock: from, toBlock: to });
          const launchTx = new Set(launches.map((l) => l.transactionHash)); // a launch's own first buy isn't a trade
          const seen = new Set();
          for (const s of swaps) {
            if (launchTx.has(s.transactionHash) || seen.has(s.transactionHash)) continue;
            seen.add(s.transactionHash);
            const tx = await pub.getTransaction({ hash: s.transactionHash }).catch(() => null);
            if (!tx) continue;
            const trader = tx.from.toLowerCase();
            const r = await pool.query(
              `insert into elysium_trades (tx, trader, coin, block) values ($1, $2, $3, $4) on conflict do nothing`,
              [s.transactionHash, trader, coinOf.get(s.address.toLowerCase()) ?? s.address, s.blockNumber.toString()]
            );
            if (r.rowCount) await pointTrade(pool, trader, s.transactionHash, await boostAt(s.blockNumber));
          }
        }
        await pool.query(`insert into elysium_state (id, last_block) values (1, $1) on conflict (id) do update set last_block = excluded.last_block`, [to.toString()]);
        if (launches.length) log(`elysium mainnet: ${launches.length} new coin(s) up to block ${to}`);
        from = to + 1n;
      }
      fails = 0;
    } catch (e) {
      fails++;
      if (fails === 1 || fails % 30 === 0) log(`elysium mainnet: ${e.shortMessage ?? e.message}`);
    }
    await sleep(fails ? Math.min(EVERY_MS * fails, 5 * 60_000) : EVERY_MS);
  }
}
