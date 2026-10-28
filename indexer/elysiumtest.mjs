// Elysium testnet points: reads sasa's launcher on the public Elysium testnet (free RPC, no
// Alchemy) and gives airdrop points (points_events) for real use, with daily caps so it can't be
// farmed by a script:
//   - first launch ever: the "elysium" quest, 100
//   - every launch: 50, at most 3 a day
//   - every buy or sale of a sasa coin there: 10, at most 10 a day
//   - minting the sasa Day-1 Pass (contracts-elysium SasaDayPass): the "elysium_pass" quest, 50;
//     pass holders get twice the launch and trade points
// Switched off on mainnet day (ELYSIUM_TEST_OFF=1) or by itself once the testnet is gone.

import { createPublicClient, defineChain, getAddress, http, parseAbiItem } from "viem";
import { readFileSync } from "node:fs";

const RPC = process.env.ELYSIUM_TEST_RPC || "https://testnet-rpc.elysium.kinetiq.xyz";
const LAUNCHER = "0x6c1d150124777243ce9A6eF5b4740a2E0aaF41E9";
const START_BLOCK = 17149526n; // the launcher's deploy (contracts-elysium/deployments/99801.json)
const STEP = 5000n;
const EVERY_MS = 20_000;

const LAUNCHED = parseAbiItem(
  "event Launched(address indexed coin, address indexed creator, address pool, uint256 tokenId, string name, string symbol, string uri, uint256 startMc, uint256 firstBuyIn, uint256 firstBuyOut)"
);
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");

/** The Day-1 Pass on the testnet: written by the "Deploy sasa Day-1 Pass" workflow (or ELYSIUM_PASS). */
function passAddress() {
  if (/^0x[0-9a-fA-F]{40}$/.test(process.env.ELYSIUM_PASS || "")) return getAddress(process.env.ELYSIUM_PASS);
  try {
    const j = JSON.parse(readFileSync(new URL("../contracts-elysium/deployments/pass-99801.json", import.meta.url), "utf8"));
    return /^0x[0-9a-fA-F]{40}$/.test(j.pass || "") ? getAddress(j.pass) : null;
  } catch {
    // deployed Oct 28, 2026 by the "Deploy sasa Day-1 Pass" workflow
    return getAddress("0x2fBf535502Eaa2f39502a04ea26BfBfA7F7b9789");
  }
}

const SWAP = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");

export const SQL = `
create table if not exists elysium_test_state (id int primary key, last_block bigint not null);
create table if not exists elysium_test_coins (
  coin       text primary key,
  pool       text not null,
  creator    text not null,
  block      bigint not null,
  created_at timestamptz not null default now()
);
create table if not exists elysium_test_trades (
  tx         text primary key,
  trader     text not null,
  coin       text not null,
  block      bigint not null,
  created_at timestamptz not null default now()
);
create table if not exists elysium_pass (
  owner      text primary key,
  token_id   bigint not null,
  block      bigint not null,
  created_at timestamptz not null default now()
);
alter table elysium_pass enable row level security;
revoke all on elysium_pass from anon, authenticated;
alter table elysium_test_state enable row level security;
alter table elysium_test_coins enable row level security;
alter table elysium_test_trades enable row level security;
revoke all on elysium_test_state, elysium_test_coins, elysium_test_trades from anon, authenticated;
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Day-1 Pass holders earn twice the launch and trade points. */
const passX = (owner) => `(case when exists (select 1 from elysium_pass where owner = '${owner.replace(/[^0-9a-fx]/gi, "")}') then 2 else 1 end)`;

/** Points for one launch (the quest the first time; 50 a launch, 3 a day). */
async function pointLaunch(pool, owner, coin) {
  await pool.query(`insert into points_events (owner, kind, ref, pts) values ($1, 'quest', 'elysium', 100) on conflict do nothing`, [owner]);
  await pool.query(
    `insert into points_events (owner, kind, ref, pts)
     select $1, 'elysium', $2, 50 * ${passX(owner)}
     where (select count(*) from points_events where owner = $1 and kind = 'elysium' and ref like 'launch:%'
            and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') < 3
     on conflict do nothing`,
    [owner, `launch:${coin}`]
  );
}

/** Points for one trade (10, 10 a day). */
async function pointTrade(pool, owner, tx) {
  await pool.query(
    `insert into points_events (owner, kind, ref, pts)
     select $1, 'elysium', $2, 10 * ${passX(owner)}
     where (select count(*) from points_events where owner = $1 and kind = 'elysium' and ref like 'trade:%'
            and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') < 10
     on conflict do nothing`,
    [owner, `trade:${tx}`]
  );
}

export async function elysiumTestLoop(pool, log) {
  if (process.env.ELYSIUM_TEST_OFF === "1") return;
  await pool.query(SQL);
  const chain = defineChain({ id: 99801, name: "Elysium Testnet", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const pub = createPublicClient({ chain, transport: http(RPC, { retryCount: 2, timeout: 20_000 }) });
  const PASS = passAddress();
  if (PASS) log(`elysium testnet: Day-1 Pass ${PASS}`);
  let fails = 0;
  for (;;) {
    try {
      const st = await pool.query("select last_block from elysium_test_state where id = 1");
      let from = st.rowCount ? BigInt(st.rows[0].last_block) + 1n : START_BLOCK;
      const tip = await pub.getBlockNumber();
      while (from <= tip) {
        const to = from + STEP - 1n > tip ? tip : from + STEP - 1n;
        // new coins
        const launches = await pub.getLogs({ address: LAUNCHER, event: LAUNCHED, fromBlock: from, toBlock: to });
        for (const l of launches) {
          const coin = getAddress(l.args.coin);
          const creator = l.args.creator.toLowerCase();
          await pool.query(
            `insert into elysium_test_coins (coin, pool, creator, block) values ($1, $2, $3, $4) on conflict do nothing`,
            [coin, getAddress(l.args.pool), creator, l.blockNumber.toString()]
          );
          await pointLaunch(pool, creator, coin);
        }
        // Day-1 Pass mints: the holder is recorded (2x from now on) and gets the pass quest
        if (PASS) {
          const mints = await pub.getLogs({ address: PASS, event: TRANSFER, args: { from: "0x0000000000000000000000000000000000000000" }, fromBlock: from, toBlock: to });
          for (const m of mints) {
            const owner = m.args.to.toLowerCase();
            const r = await pool.query(`insert into elysium_pass (owner, token_id, block) values ($1, $2, $3) on conflict do nothing`, [owner, m.args.tokenId.toString(), m.blockNumber.toString()]);
            if (r.rowCount) await pool.query(`insert into points_events (owner, kind, ref, pts) values ($1, 'quest', 'elysium_pass', 50) on conflict do nothing`, [owner]);
          }
          if (mints.length) log(`elysium testnet: ${mints.length} Day-1 Pass mint(s)`);
        }
        // trades in sasa's pools (the trader is whoever sent the transaction)
        const pools = (await pool.query("select pool, coin from elysium_test_coins")).rows;
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
              `insert into elysium_test_trades (tx, trader, coin, block) values ($1, $2, $3, $4) on conflict do nothing`,
              [s.transactionHash, trader, coinOf.get(s.address.toLowerCase()) ?? s.address, s.blockNumber.toString()]
            );
            if (r.rowCount) await pointTrade(pool, trader, s.transactionHash);
          }
        }
        await pool.query(
          `insert into elysium_test_state (id, last_block) values (1, $1) on conflict (id) do update set last_block = excluded.last_block`,
          [to.toString()]
        );
        if (launches.length) log(`elysium testnet: ${launches.length} new coin(s) up to block ${to}`);
        from = to + 1n;
      }
      fails = 0;
    } catch (e) {
      fails++;
      if (fails === 1 || fails % 30 === 0) log(`elysium testnet: ${e.shortMessage ?? e.message}`);
    }
    await sleep(fails ? Math.min(EVERY_MS * fails, 10 * 60_000) : EVERY_MS);
  }
}
