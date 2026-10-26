// Data for sasa's search pages (Google, Bing, AI engines), refreshed every 30 minutes:
//
//   - Solana coins join the coin archive (ext_archive, archive.sql): every real Solana coin we
//     ever saw keeps its page at /x/solana/<address>/, same rules as the other chains
//   - coin_days: one row per coin per day (closing price, day high/low, market cap, volume…),
//     the price history table on each coin page
//   - big_trades: trades of $1,000 or more in the busiest meme coins on every chain
//     (GeckoTerminal), for the coin pages and the daily pages
//   - day_pages: each day's meme coin record per chain (new coins, gainers, busiest, biggest
//     trades, coins launched on sasa), built through the day and kept for good after it.
//     Rendered at /day/<date>/ and /day/<date>/<chain>/ (web/functions/day)
//
// Everything is created here (safe to run again): nothing to run by hand.
// Env: SEO_PAGES=off turns it off.

import { notMeme } from "./markets.mjs";
import { submit } from "./seo.mjs";
import { SOL_SQL } from "./solmarkets.mjs";

const GT = "https://api.geckoterminal.com/api/v2";
const SITE = (process.env.SITE_URL || "https://sasapad.fun").replace(/\/$/, "");
const EVERY_MS = 30 * 60_000;
/** A trade this big (dollars) is kept. */
const BIG_USD = 1000;
/** Busiest pools per chain whose big trades are read each round. */
const POOLS_PER_CHAIN = 8;
/** Pause between GeckoTerminal calls: its free limit is shared with the market lists. */
const GT_GAP_MS = 12_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Day page chains: URL slug → network id (GeckoTerminal's). "all" is every chain. */
export const DAY_CHAINS = [
  { slug: "solana", network: "solana", name: "Solana" },
  { slug: "base", network: "base", name: "Base" },
  { slug: "bnb-chain", network: "bsc", name: "BNB Chain" },
  { slug: "robinhood-chain", network: "robinhood", name: "Robinhood Chain" },
  { slug: "arc", network: "arc", name: "Arc" },
  { slug: "ethereum", network: "eth", name: "Ethereum" },
];
/** Race chain ids → network ids (mainnet only; test races never count). */
const RACE_NETWORK = { 8453: "base", 56: "bsc", 4663: "robinhood", 5042: "arc" };
const NOT_MEME_SOL = new Set(["SOL", "WSOL", "JITOSOL", "MSOL", "BSOL", "JUPSOL", "INF", "HSOL", "BNSOL", "USDC", "USDT", "PYUSD", "USDS", "EURC", "JLP", "CBBTC", "WBTC", "ZBTC", "WETH", "PUMP"]);
const isMeme = (r) => !!r.name && !!r.symbol && !NOT_MEME_SOL.has(String(r.symbol).toUpperCase()) && !notMeme(r.symbol, r.name);

const SQL = `
-- Solana coins in the archive: the same bar as the other chains (archive.sql's ext_is_real)
create or replace function sol_is_real(t sol_ext_tokens) returns boolean
language sql immutable as $f$
  select t.gp_checked_at is not null
     and coalesce(t.gp_honeypot, false) = false
     and coalesce(t.gp_cannot_sell, false) = false
     and coalesce(t.gp_sell_tax, 0) < 0.1
     and coalesce(t.gp_buy_tax, 0) < 0.1
     and coalesce(t.liq_usd, 0) >= 10000
     and coalesce(t.vol_24h, 0) >= 25000
     and coalesce(t.buys_24h, 0) + coalesce(t.sells_24h, 0) >= 50
     and coalesce(t.mcap_usd, t.fdv_usd, 0) < 1e12
     and length(coalesce(t.name, '')) between 1 and 60
     and length(coalesce(t.symbol, '')) between 1 and 20
$f$;

create or replace function sol_archive_sync() returns integer
language plpgsql security definer set search_path = public as $f$
declare n integer;
begin
  insert into ext_archive (network, address, chain_id, name, symbol, image, pool, dex, pool_created,
                           price_usd, mcap_usd, liq_usd, vol_24h, peak_mcap, peak_vol, peak_liq,
                           buy_tax, sell_tax, mintable, top10, x_handle)
  select 'solana', t.address, 792703809, t.name, t.symbol, t.image, t.pool, t.dex, t.pool_created,
         t.price_usd, coalesce(t.mcap_usd, t.fdv_usd), t.liq_usd, t.vol_24h, coalesce(t.mcap_usd, t.fdv_usd), t.vol_24h, t.liq_usd,
         t.gp_buy_tax, t.gp_sell_tax, t.gp_mintable, t.gp_top10, t.x_handle
  from sol_ext_tokens t
  where t.seen_at > now() - interval '40 minutes' and sol_is_real(t)
    and not exists (select 1 from ext_archive a where a.network = 'solana' and a.address = t.address)
  on conflict (network, address) do nothing;
  get diagnostics n = row_count;

  update ext_archive a set
    name = coalesce(nullif(t.name, ''), a.name),
    symbol = coalesce(nullif(t.symbol, ''), a.symbol),
    image = coalesce(t.image, a.image),
    pool = coalesce(t.pool, a.pool),
    dex = coalesce(t.dex, a.dex),
    pool_created = coalesce(t.pool_created, a.pool_created),
    last_seen = t.seen_at,
    price_usd = coalesce(t.price_usd, a.price_usd),
    mcap_usd = coalesce(t.mcap_usd, t.fdv_usd, a.mcap_usd),
    liq_usd = coalesce(t.liq_usd, a.liq_usd),
    vol_24h = coalesce(t.vol_24h, a.vol_24h),
    peak_mcap = greatest(a.peak_mcap, case when coalesce(t.mcap_usd, t.fdv_usd) < 1e12 then coalesce(t.mcap_usd, t.fdv_usd) end),
    peak_vol = greatest(a.peak_vol, t.vol_24h),
    peak_liq = greatest(a.peak_liq, t.liq_usd),
    buy_tax = coalesce(t.gp_buy_tax, a.buy_tax),
    sell_tax = coalesce(t.gp_sell_tax, a.sell_tax),
    mintable = coalesce(t.gp_mintable, a.mintable),
    top10 = coalesce(t.gp_top10, a.top10),
    x_handle = coalesce(t.x_handle, a.x_handle),
    bad = a.bad or coalesce(t.gp_honeypot, false) or coalesce(t.gp_cannot_sell, false)
                or coalesce(t.gp_sell_tax, 0) >= 0.1 or coalesce(t.gp_buy_tax, 0) >= 0.1
  from sol_ext_tokens t
  where a.network = 'solana' and t.address = a.address and t.seen_at > now() - interval '40 minutes'
    and (t.seen_at > a.last_seen + interval '25 minutes'
         or (not a.bad and (coalesce(t.gp_honeypot, false) or coalesce(t.gp_cannot_sell, false)
                            or coalesce(t.gp_sell_tax, 0) >= 0.1 or coalesce(t.gp_buy_tax, 0) >= 0.1)));
  return n;
end $f$;
revoke all on function sol_archive_sync() from public;

-- One row per coin per day: the price history on coin pages. Only real coins (in the archive)
-- that traded at least $10K that day, so the table stays small.
create table if not exists coin_days (
  network    text        not null,
  address    text        not null,
  day        date        not null,
  price      real,                   -- the last price seen that day (the close)
  price_hi   real,
  price_lo   real,
  mcap       real,
  liq        real,
  vol        real,                   -- 24-hour volume at the last look
  chg        real,                   -- 24-hour change (%) at the last look
  buys       integer,
  sells      integer,
  gain_rank  smallint,               -- its place in that day's top gainers (day_pages), if any
  vol_rank   smallint,               -- its place in that day's busiest coins, if any
  updated_at timestamptz not null default now(),
  primary key (network, address, day)
);
alter table coin_days enable row level security;
drop policy if exists coin_days_read on coin_days;
create policy coin_days_read on coin_days for select using (true);
grant select on coin_days to anon, authenticated;

create or replace function coin_days_sync() returns integer
language plpgsql security definer set search_path = public as $f$
declare n integer;
begin
  insert into coin_days as d (network, address, day, price, price_hi, price_lo, mcap, liq, vol, chg, buys, sells, updated_at)
  select t.network, t.address, (t.seen_at at time zone 'UTC')::date, t.price_usd, t.price_usd, t.price_usd,
         coalesce(t.mcap_usd, t.fdv_usd), t.liq_usd, t.vol_24h,
         case when abs(t.change_24h) <= 10000 then t.change_24h end, t.buys_24h, t.sells_24h, t.seen_at
  from (
    select network, address, price_usd::double precision as price_usd, mcap_usd::double precision as mcap_usd,
           fdv_usd::double precision as fdv_usd, liq_usd::double precision as liq_usd, vol_24h::double precision as vol_24h,
           change_24h::double precision as change_24h, buys_24h, sells_24h, seen_at
    from ext_tokens where seen_at > now() - interval '40 minutes'
    union all
    select network, address, price_usd, mcap_usd, fdv_usd, liq_usd, vol_24h, change_24h, buys_24h, sells_24h, seen_at
    from sol_ext_tokens where seen_at > now() - interval '40 minutes'
  ) t
  join ext_archive a on a.network = t.network and a.address = t.address and not a.bad
  where coalesce(t.price_usd, 0) > 0 and t.price_usd < 1e9 and coalesce(t.vol_24h, 0) >= 10000
    and coalesce(t.mcap_usd, t.fdv_usd, 0) between 1000 and 1e12
  on conflict (network, address, day) do update set
    price = excluded.price,
    price_hi = greatest(d.price_hi, excluded.price),
    price_lo = least(d.price_lo, excluded.price),
    mcap = excluded.mcap, liq = excluded.liq, vol = excluded.vol, chg = excluded.chg,
    buys = excluded.buys, sells = excluded.sells, updated_at = excluded.updated_at
  where d.updated_at < excluded.updated_at;
  get diagnostics n = row_count;
  return n;
end $f$;
revoke all on function coin_days_sync() from public;

-- Big trades ($1,000+) in the busiest meme coins, kept 30 days (the day pages keep each day's
-- biggest for good).
create table if not exists big_trades (
  network  text        not null,
  address  text        not null,     -- the coin
  tx       text        not null,
  t        timestamptz not null,
  side     text        not null check (side in ('buy', 'sell')),
  usd      real        not null,
  wallet   text,
  primary key (network, tx, address)
);
create index if not exists big_trades_t on big_trades (t desc);
create index if not exists big_trades_coin on big_trades (network, address, t desc);
alter table big_trades enable row level security;
drop policy if exists big_trades_read on big_trades;
create policy big_trades_read on big_trades for select using (true);
grant select on big_trades to anon, authenticated;

-- Each day's meme coin record, per chain ('all' = every chain). Built through the day; the
-- last build before midnight (UTC) is the day's final page.
create table if not exists day_pages (
  day        date        not null,
  chain      text        not null,
  data       jsonb       not null,
  ok         boolean     not null default false,   -- enough on it to be a page worth indexing
  updated_at timestamptz not null default now(),
  primary key (day, chain)
);
alter table day_pages enable row level security;
drop policy if exists day_pages_read on day_pages;
create policy day_pages_read on day_pages for select using (true);
grant select on day_pages to anon, authenticated;

-- What sasa's own traders did in a coin (coin pages): trades and dollars, no names.
create index if not exists ext_trades_coin_idx on ext_trades (coin);
create or replace function coin_sasa_stats(p_coin text) returns json
language sql stable security definer set search_path = public as $f$
  select json_build_object('trades', count(*), 'usd', coalesce(sum(usd), 0), 'traders', count(distinct trader), 'last', max(created_at))
  from ext_trades where coin in (p_coin, lower(p_coin))
$f$;
revoke all on function coin_sasa_stats(text) from public;
grant execute on function coin_sasa_stats(text) to anon, authenticated;

notify pgrst, 'reload schema';
`;

/** Network ids GeckoTerminal knows for each chain we track (the id is also ours). */
async function bigTrades(pool, log) {
  const { rows } = await pool.query(
    `select network, address, pool, name, symbol from (
       select network, address, pool, name, symbol, vol_24h, row_number() over (partition by network order by vol_24h desc nulls last) as n
       from (select network, address, pool, name, symbol, vol_24h::double precision as vol_24h, seen_at, gp_honeypot, gp_cannot_sell from ext_tokens
             union all
             select network, address, pool, name, symbol, vol_24h, seen_at, gp_honeypot, gp_cannot_sell from sol_ext_tokens) t
       where pool is not null and seen_at > now() - interval '2 hours' and coalesce(vol_24h, 0) >= 50000
         and coalesce(gp_honeypot, false) = false and coalesce(gp_cannot_sell, false) = false
     ) x where n <= $1 * 2`,
    [POOLS_PER_CHAIN]
  );
  const byNet = new Map();
  for (const r of rows) {
    if (!isMeme(r)) continue;
    const list = byNet.get(r.network) ?? [];
    if (list.length < POOLS_PER_CHAIN) list.push(r);
    byNet.set(r.network, list);
  }
  // one pool per chain in turn, so a rate limit late in the round doesn't starve a chain
  const order = [];
  for (let i = 0; i < POOLS_PER_CHAIN; i++) for (const list of byNet.values()) if (list[i]) order.push(list[i]);
  let saved = 0;
  for (const c of order) {
    let json;
    try {
      const r = await fetch(`${GT}/networks/${c.network}/pools/${c.pool}/trades?trade_volume_in_usd_greater_than=${BIG_USD}&token=${c.address}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (r.status === 429) {
        log("seo pages: GeckoTerminal rate limit, big trades wait for the next round");
        break;
      }
      if (!r.ok) {
        await sleep(GT_GAP_MS);
        continue;
      }
      json = await r.json();
    } catch {
      await sleep(GT_GAP_MS);
      continue;
    }
    const sol = c.network === "solana";
    const values = [];
    for (const t of json?.data ?? []) {
      const a = t?.attributes ?? {};
      const usd = Number(a.volume_in_usd);
      const at = Date.parse(a.block_timestamp);
      // "token=" makes buy and sell about the coin, whichever side of the pool it is on
      const side = a.kind === "buy" || a.kind === "sell" ? a.kind : null;
      if (!side || !Number.isFinite(usd) || usd < BIG_USD || usd > 1e9 || !Number.isFinite(at) || !a.tx_hash) continue;
      const tx = sol ? String(a.tx_hash) : String(a.tx_hash).toLowerCase();
      const wallet = a.tx_from_address ? (sol ? String(a.tx_from_address) : String(a.tx_from_address).toLowerCase()) : null;
      values.push([c.network, c.address, tx, new Date(at).toISOString(), side, usd, wallet]);
    }
    if (values.length) {
      const params = values.flat();
      const ph = values.map((_, i) => `($${i * 7 + 1},$${i * 7 + 2},$${i * 7 + 3},$${i * 7 + 4},$${i * 7 + 5},$${i * 7 + 6},$${i * 7 + 7})`).join(",");
      const res = await pool.query(`insert into big_trades (network, address, tx, t, side, usd, wallet) values ${ph} on conflict do nothing`, params);
      saved += res.rowCount ?? 0;
    }
    await sleep(GT_GAP_MS);
  }
  await pool.query("delete from big_trades where t < now() - interval '30 days'");
  return saved;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** A coin as stored on a day page: short keys, numbers rounded to what the page shows. */
const slim = (r) => ({
  n: r.network,
  a: r.address,
  name: String(r.name).slice(0, 60),
  sym: String(r.symbol).slice(0, 20),
  img: typeof r.image === "string" && r.image.startsWith("https://") ? r.image : null,
  p: num(r.price_usd),
  mc: num(r.mcap),
  v: num(r.vol_24h),
  l: num(r.liq_usd),
  c: num(r.change_24h) !== null && Math.abs(Number(r.change_24h)) <= 10000 ? Math.round(Number(r.change_24h) * 10) / 10 : null,
  pc: r.pool_created ? new Date(r.pool_created).toISOString() : null,
});

const COIN_COLS = `network, address, name, symbol, image, price_usd::double precision as price_usd,
  coalesce(mcap_usd, fdv_usd)::double precision as mcap, liq_usd::double precision as liq_usd,
  vol_24h::double precision as vol_24h, change_24h::double precision as change_24h, pool_created, seen_at,
  gp_honeypot, gp_cannot_sell, gp_sell_tax::double precision as gp_sell_tax`;
const BOTH = `(select ${COIN_COLS} from ext_tokens union all select ${COIN_COLS} from sol_ext_tokens)`;
const SAFE = "coalesce(gp_honeypot, false) = false and coalesce(gp_cannot_sell, false) = false and coalesce(gp_sell_tax, 0) < 0.3";

/** Build (or rebuild) one day's pages from what we know now. `day` is "YYYY-MM-DD" (UTC). */
export async function buildDay(pool, day) {
  const from = `${day}T00:00:00Z`;
  const to = new Date(Date.parse(from) + 86400_000).toISOString();
  const [born, gainers, busiest, trades, races, sols] = await Promise.all([
    // coins whose first pool opened that day (all of them for the counts, honeypots left out)
    pool.query(`select * from ${BOTH} t where pool_created >= $1 and pool_created < $2 and ${SAFE}`, [from, to]),
    pool.query(
      `select * from ${BOTH} t where seen_at >= $1 and seen_at < $2 and ${SAFE} and coalesce(vol_24h, 0) >= 10000 and coalesce(liq_usd, 0) >= 5000
         and change_24h is not null and abs(change_24h) <= 10000 order by change_24h desc limit 300`,
      [from, to]
    ),
    pool.query(`select * from ${BOTH} t where seen_at >= $1 and seen_at < $2 and ${SAFE} and coalesce(liq_usd, 0) >= 5000 order by vol_24h desc nulls last limit 300`, [from, to]),
    pool.query(
      `select b.network, b.address, b.tx, b.t, b.side, b.usd, b.wallet, a.name, a.symbol, a.image
       from big_trades b left join ext_archive a on a.network = b.network and a.address = b.address
       where b.t >= $1 and b.t < $2 order by b.usd desc limit 400`,
      [from, to]
    ),
    pool
      .query(
        `select c.id, c.name, c.symbol, c.logo, c.launched_at, c.winner_chain, min(rc.chain_id) as chain_id
         from race_coins c join race_chains rc on rc.coin_id = c.id
         where c.launched_at >= $1 and c.launched_at < $2 and rc.chain_id = any($3)
         group by c.id order by c.launched_at`,
        [from, to, Object.keys(RACE_NETWORK).map(Number)]
      )
      .catch(() => ({ rows: [] })),
    pool
      .query(`select mint as address, name, symbol, image, created_at from sol_coins where status = 'live' and created_at >= $1 and created_at < $2 order by created_at`, [from, to])
      .catch(() => ({ rows: [] })),
  ]);
  // names for big trades in coins that aren't archived (yet): from the live lists
  const known = new Map();
  for (const r of [...born.rows, ...gainers.rows, ...busiest.rows]) known.set(`${r.network}/${r.address}`, r);

  const out = [];
  for (const ch of [{ slug: "all", network: null, name: "every chain" }, ...DAY_CHAINS]) {
    const mine = (r) => !ch.network || r.network === ch.network;
    const bornAll = born.rows.filter(mine);
    const bornMeme = bornAll.filter(isMeme);
    const newList = bornMeme.filter((r) => (num(r.vol_24h) ?? 0) >= 1000).sort((a, b) => (num(b.vol_24h) ?? 0) - (num(a.vol_24h) ?? 0)).slice(0, 40).map(slim);
    const gain = gainers.rows.filter(mine).filter(isMeme).slice(0, 25).map(slim);
    const busy = busiest.rows.filter(mine).filter(isMeme).slice(0, 25).map(slim);
    const big = trades.rows
      .filter(mine)
      .map((t) => {
        const k = known.get(`${t.network}/${t.address}`);
        const name = t.name || k?.name;
        const symbol = t.symbol || k?.symbol;
        if (!name || !symbol || !isMeme({ name, symbol })) return null;
        return { n: t.network, a: t.address, name, sym: symbol, img: [t.image, k?.image].find((x) => typeof x === "string" && x.startsWith("https://")) || null, t: new Date(t.t).toISOString(), s: t.side, usd: Math.round(Number(t.usd)), w: t.wallet, tx: t.tx };
      })
      .filter(Boolean);
    const sasa = [
      ...races.rows
        .map((r) => ({ kind: "race", id: r.id, name: r.name, sym: r.symbol, img: r.logo || null, t: new Date(r.launched_at).toISOString(), n: RACE_NETWORK[r.winner_chain] || null }))
        .filter((r) => !ch.network || r.n === ch.network),
      ...sols.rows
        .map((r) => ({ kind: "solana", n: "solana", a: r.address, name: r.name, sym: r.symbol, img: r.image || null, t: new Date(r.created_at).toISOString() }))
        .filter((r) => !ch.network || ch.network === "solana"),
    ].filter((r) => r.name && r.sym);
    // new pools per chain (on "all"), for the "busiest chain" bars
    const perChain = {};
    if (!ch.network) for (const r of bornAll) perChain[r.network] = (perChain[r.network] || 0) + 1;
    const data = {
      day,
      chain: ch.slug,
      newCount: bornAll.length,
      newMemeCount: bornMeme.length,
      perChain,
      volume: Math.round(busiest.rows.filter(mine).filter(isMeme).reduce((s, r) => s + (num(r.vol_24h) ?? 0), 0)),
      bigCount: big.length,
      bigUsd: big.reduce((s, t) => s + t.usd, 0),
      newList,
      gainers: gain,
      busiest: busy,
      big: big.slice(0, 25),
      sasa: sasa.slice(0, 60),
      sasaCount: sasa.length,
      builtAt: new Date().toISOString(),
    };
    const ok = newList.length >= 3 || gain.length >= 5 || busy.length >= 5;
    out.push({ chain: ch.slug, data, ok, gain, busy });
  }
  for (const p of out) {
    await pool.query(
      `insert into day_pages (day, chain, data, ok, updated_at) values ($1, $2, $3, $4, now())
       on conflict (day, chain) do update set data = excluded.data, ok = excluded.ok, updated_at = now()`,
      [day, p.chain, JSON.stringify(p.data), p.ok]
    );
  }
  // each coin's places in that day's lists (coin pages link to these days)
  const all = out.find((p) => p.chain === "all");
  if (all) {
    await pool.query("update coin_days set gain_rank = null, vol_rank = null where day = $1 and (gain_rank is not null or vol_rank is not null)", [day]);
    for (const [col, list] of [["gain_rank", all.gain], ["vol_rank", all.busy]])
      for (let i = 0; i < list.length; i++)
        await pool.query(`update coin_days set ${col} = $4 where network = $1 and address = $2 and day = $3`, [list[i].n, list[i].a, day, i + 1]);
  }
  return out;
}

export const dayUrls = (day, built) =>
  built.filter((p) => p.ok).map((p) => (p.chain === "all" ? `${SITE}/day/${day}/` : `${SITE}/day/${day}/${p.chain}/`));

/** Creates or updates the tables and functions above (safe to run again). */
export async function ensureSeoTables(pool) {
  // Solana's market table (solmarkets.mjs), in case that loop is off: the SQL below reads it
  await pool.query(SOL_SQL);
  await pool.query(SQL);
}

export async function seoPagesLoop(pool, log) {
  if (process.env.SEO_PAGES === "off") return log("seo pages: off (SEO_PAGES=off)");
  // the market tables come from markets.mjs / solmarkets.mjs: give them a moment on a fresh start
  await sleep(90_000);
  await ensureSeoTables(pool);
  log("seo pages: tables ready");
  let lastPing = 0;
  let lastDay = null;
  for (let round = 1; ; round++) {
    const started = Date.now();
    try {
      const added = Number((await pool.query("select sol_archive_sync() as n")).rows[0]?.n ?? 0);
      const days = Number((await pool.query("select coin_days_sync() as n")).rows[0]?.n ?? 0);
      if (added || round <= 2 || round % 12 === 0) log(`seo pages: Solana archive +${added}, coin days ${days}`);
    } catch (e) {
      log(`seo pages: archive/days ${e.message}`);
    }
    // The day's page first (big trades take minutes): a day is only ever built while it is still
    // that day, from the live lists, so the last build before midnight is its final record.
    const day = new Date().toISOString().slice(0, 10);
    try {
      const built = await buildDay(pool, day);
      // tell search engines: a new day's pages at once, then every 6 hours
      if (day !== lastDay || Date.now() - lastPing > 6 * 3600_000) {
        const urls = [...dayUrls(day, built), `${SITE}/day/`];
        if (lastDay && lastDay !== day) urls.push(`${SITE}/day/${lastDay}/`, ...DAY_CHAINS.map((c) => `${SITE}/day/${lastDay}/${c.slug}/`));
        await submit(urls, log).catch((e) => log(`seo pages: IndexNow ${e.message}`));
        lastPing = Date.now();
      }
      lastDay = day;
      if (round <= 2 || round % 12 === 0) log(`seo pages: day ${day} built (${built.filter((p) => p.ok).length} pages)`);
    } catch (e) {
      log(`seo pages: day ${day} ${e.message}`);
    }
    try {
      const n = await bigTrades(pool, log);
      if (round <= 2 || round % 12 === 0) log(`seo pages: ${n} new big trades`);
    } catch (e) {
      log(`seo pages: big trades ${e.message}`);
    }
    // Next round: every 30 minutes, plus one ~4 minutes before midnight (the day's final build)
    // and one just after it (the new day's first page).
    const now = Date.now();
    const midnight = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`) + 86400_000;
    let next = started + EVERY_MS;
    if (midnight - 4 * 60_000 > now + 60_000 && midnight - 4 * 60_000 < next) next = midnight - 4 * 60_000;
    else if (midnight + 90_000 < next) next = midnight + 90_000;
    await sleep(Math.max(60_000, next - now));
  }
}
