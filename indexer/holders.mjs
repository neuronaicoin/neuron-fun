// Holder counts with a 15-minute change, for the site's coin cards and coin pages
// (web/lib/holderlive.ts). Snapshots go into holder_snaps; the view holder_live gives, per coin,
// the count now and the change since about 15 minutes ago.
//
//   sasa race coins   every minute, exact: wallets with a balance (balances, kept by race.mjs),
//                     minus pools, vaults and sasa's own contracts.
//   other coins       the busiest coins from other DEXs plus every Solana coin launched on sasa,
//                     in turn, from GeckoTerminal's token info (holders.count). One call every
//                     HOLDERS_GAP_MS (8 s: ~7 a minute), so each coin is read every ~10 minutes.
//                     GeckoTerminal's free limit is shared with markets.mjs and whalefeed.mjs.
//
// Keys: "race:<coin id>", "<network>:<address>" (EVM addresses lowercase, Solana as is).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const GT = "https://api.geckoterminal.com/api/v2";
const GAP = Number(process.env.HOLDERS_GAP_MS ?? "8000");
const EXT_COINS = Number(process.env.HOLDERS_EXT_COINS ?? "70");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SQL = `
create table if not exists holder_snaps (
  key      text        not null,
  at       timestamptz not null default now(),
  holders  integer     not null,
  primary key (key, at)
);
create index if not exists holder_snaps_at_idx on holder_snaps (at);

create or replace view holder_live as
with latest as (
  select distinct on (key) key, at, holders from holder_snaps
  where at > now() - interval '2 hours'
  order by key, at desc
), ago as (
  select distinct on (s.key) s.key, s.holders
  from holder_snaps s
  where s.at <= now() - interval '15 minutes' and s.at > now() - interval '45 minutes'
  order by s.key, s.at desc
)
select l.key, l.holders, l.at, (l.holders - a.holders) as change_15m
from latest l left join ago a on a.key = l.key;

grant select on holder_live to anon;
`;

/** sasa's own contracts and the pools' vaults on every race chain: never counted as holders. */
function contractAddresses() {
  const out = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);
  const here = dirname(fileURLToPath(import.meta.url));
  for (const f of ["race-chains-mainnet.json", "race-chains-mainnet-v8.json", "race-chains.json"]) {
    try {
      for (const c of JSON.parse(readFileSync(join(here, f), "utf8")))
        for (const v of Object.values(c)) if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) out.add(v.toLowerCase());
    } catch {}
  }
  return [...out];
}

async function raceLap(pool, skip) {
  // A wallet holding more than 25 different race coins is a pool vault (Uniswap v4 PoolManager,
  // PancakeSwap Vault), not a person.
  const { rowCount } = await pool.query(
    `with coins as (
       select c.id, lower(c.coin) as token, k.chain_id
       from race_coins c join race_chains k on k.coin_id = c.id
       where c.launched_at > now() - interval '30 days'
     ), vaults as (
       select b.chain_id, b.holder from balances b
       where b.amount > 0 and b.token in (select token from coins)
       group by b.chain_id, b.holder having count(distinct b.token) > 25
     ), counts as (
       select 'race:' || c.id as key, count(distinct b.holder)::int as holders
       from coins c join balances b on b.chain_id = c.chain_id and b.token = c.token and b.amount > 0
       where b.holder <> all($1::text[])
         and not exists (select 1 from vaults v where v.chain_id = b.chain_id and v.holder = b.holder)
       group by c.id
     ), last as (
       select distinct on (key) key, holders, at from holder_snaps
       where key like 'race:%' and at > now() - interval '1 day' order by key, at desc
     )
     insert into holder_snaps (key, holders)
     select n.key, n.holders from counts n left join last l on l.key = n.key
     where l.key is null or l.holders <> n.holders or l.at < now() - interval '5 minutes'
     on conflict do nothing`,
    [skip]
  );
  return rowCount;
}

async function extList(pool) {
  const { rows } = await pool.query(
    `select network, address from (
       select network, address, vol_24h::double precision as v from ext_coins
       union all
       select network, address, vol_24h::double precision from sol_ext_coins
     ) x where coalesce(v, 0) >= 20000 order by v desc nulls last limit $1`,
    [EXT_COINS]
  );
  // Solana coins launched on sasa: always, however small
  const sasa = await pool
    .query(`select mint as address from sol_coins where status = 'live' and created_at > now() - interval '30 days' order by created_at desc limit 60`)
    .then((r) => r.rows.map((x) => ({ network: "solana", address: x.address })))
    .catch(() => []);
  const seen = new Set();
  return [...sasa, ...rows].filter((c) => {
    const k = `${c.network}:${c.address}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function readHolders(c) {
  const r = await fetch(`${GT}/networks/${c.network}/tokens/${c.address}/info`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!r) return { wait: false, n: null };
  if (r.status === 429) return { wait: true, n: null };
  if (!r.ok) return { wait: false, n: null };
  const j = await r.json().catch(() => null);
  const n = Number(j?.data?.attributes?.holders?.count);
  return { wait: false, n: Number.isFinite(n) && n > 0 ? Math.round(n) : null };
}

export async function holdersLoop(pool, log) {
  await pool.query(SQL);
  const skip = contractAddresses();
  let list = [];
  let i = 0;
  let lastRace = 0;
  let lastList = 0;
  let lastPrune = 0;
  let saved = 0;
  for (;;) {
    const now = Date.now();
    if (now - lastRace >= 60_000) {
      lastRace = now;
      await raceLap(pool, skip).catch((e) => log(`holders: race coins: ${e.message}`));
    }
    if (now - lastPrune >= 3600_000) {
      lastPrune = now;
      await pool.query(`delete from holder_snaps where at < now() - interval '2 days'`).catch(() => {});
    }
    if (now - lastList >= 10 * 60_000 || !list.length) {
      list = await extList(pool).catch(() => list);
      lastList = now;
      if (saved) log(`holders: ${saved} coin counts saved in the last lap`);
      saved = 0;
    }
    if (list.length) {
      const c = list[i++ % list.length];
      const { wait, n } = await readHolders(c);
      if (n !== null) {
        const key = `${c.network}:${c.network === "solana" ? c.address : c.address.toLowerCase()}`;
        await pool.query(`insert into holder_snaps (key, holders) values ($1, $2) on conflict do nothing`, [key, n]).catch(() => {});
        saved++;
      }
      await sleep(wait ? 60_000 : GAP);
    } else await sleep(30_000);
  }
}
