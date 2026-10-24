// Solana memecoins for sasa's coin lists (see markets.mjs for the other chains).
//
// Kept in their own table (sol_ext_tokens) and view (sol_ext_coins), so nothing on the site that
// reads the other chains' lists sees them until Solana opens (web/lib/solana.ts). Same sources
// and rules as markets.mjs: GeckoTerminal trending, busiest and new pools; DexScreener for fresh
// numbers and pictures; GoPlus's Solana check (a coin that can be frozen, can't be moved, or whose
// balances someone can change is never listed).
//
// Solana addresses are case-sensitive: kept exactly as they are (never lowercased).
//
// Env: MARKETS_SOLANA=0 switches it off. MARKETS_EVERY_MS / MARKETS_GAP_MS as in markets.mjs.

import { MAX_SANE_USD, notMeme, sane, xHandle } from "./markets.mjs";

const GT = "https://api.geckoterminal.com/api/v2";
const DS = "https://api.dexscreener.com";
const GOPLUS_SOL = "https://api.gopluslabs.io/api/v1/solana/token_security";
const NETWORK = "solana";
const CHAIN_ID = 792703809; // Relay's id for Solana
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const GAP = Number(process.env.MARKETS_GAP_MS ?? "6500");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
// Solana's own coins that aren't memes (wrapped SOL, liquid-staked SOL, stables…)
const NOT_MEME_SOL = new Set(["SOL", "WSOL", "JITOSOL", "MSOL", "BSOL", "JUPSOL", "INF", "HSOL", "BNSOL", "USDC", "USDT", "PYUSD", "USDS", "EURC", "JLP", "CBBTC", "WBTC", "ZBTC", "WETH"]);
const notSolMeme = (symbol, name) => NOT_MEME_SOL.has(String(symbol ?? "").toUpperCase()) || notMeme(symbol, name);

const SQL = `create table if not exists sol_ext_tokens (
  address        text primary key,
  network        text not null default 'solana',
  chain_id       bigint not null default ${CHAIN_ID},
  pool           text,
  dex            text,
  name           text,
  symbol         text,
  image          text,
  price_usd      double precision,
  fdv_usd        double precision,
  mcap_usd       double precision,
  liq_usd        double precision,
  vol_24h        double precision,
  change_1h      double precision,
  change_24h     double precision,
  buys_24h       integer,
  sells_24h      integer,
  pool_created   timestamptz,
  trending_rank  integer,
  x_handle       text,
  seen_at        timestamptz not null default now(),
  gp_checked_at  timestamptz,
  gp_honeypot    boolean,
  gp_cannot_sell boolean,
  gp_buy_tax     double precision,
  gp_sell_tax    double precision,
  gp_mintable    boolean,
  gp_top10       double precision
);
create index if not exists sol_ext_tokens_vol on sol_ext_tokens (vol_24h desc);
alter table sol_ext_tokens enable row level security;
revoke all on sol_ext_tokens from anon, authenticated;
create or replace view sol_ext_coins as
  select network, chain_id, address, pool, dex, name, symbol, image, price_usd, fdv_usd, mcap_usd, liq_usd,
         vol_24h, change_1h, change_24h, buys_24h, sells_24h, pool_created, trending_rank, seen_at,
         gp_checked_at, gp_buy_tax, gp_sell_tax, gp_mintable, gp_top10, x_handle
  from sol_ext_tokens
  where coalesce(vol_24h, 0) >= 10000
    and coalesce(liq_usd, 0) >= 5000
    and seen_at > now() - interval '2 hours'
    and coalesce(gp_honeypot, false) = false
    and coalesce(gp_cannot_sell, false) = false
    and coalesce(gp_sell_tax, 0) < 0.3;
-- a coin's page keeps working after it leaves the busy list (people can still sell it)
create or replace view sol_ext_coins_all as
  select network, chain_id, address, pool, dex, name, symbol, image, price_usd, fdv_usd, mcap_usd, liq_usd,
         vol_24h, change_1h, change_24h, buys_24h, sells_24h, pool_created, trending_rank, seen_at,
         gp_checked_at, gp_buy_tax, gp_sell_tax, gp_mintable, gp_top10, x_handle
  from sol_ext_tokens
  where seen_at > now() - interval '30 days'
    and coalesce(gp_honeypot, false) = false
    and coalesce(gp_cannot_sell, false) = false
    and coalesce(gp_sell_tax, 0) < 0.3;
grant select on sol_ext_coins, sol_ext_coins_all to anon, authenticated;
notify pgrst, 'reload schema';`;

async function gt(path, retry = true) {
  const r = await fetch(`${GT}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (r.status === 429) {
    if (!retry) throw new Error("GeckoTerminal rate limit");
    await sleep(30_000);
    return gt(path, false);
  }
  if (!r.ok) throw new Error(`GeckoTerminal ${r.status} for ${path}`);
  return r.json();
}

async function ds(path) {
  const r = await fetch(`${DS}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`DexScreener ${r.status} for ${path}`);
  return r.json();
}

/** GeckoTerminal pools → rows (Solana tokens only, addresses as they are). Exported for tests. */
export function solRowsFromPools(json, trendingOffset = null) {
  const tokens = new Map();
  for (const t of json?.included ?? []) if (t?.type === "token") tokens.set(t.id, t.attributes ?? {});
  const out = [];
  (json?.data ?? []).forEach((p, i) => {
    const a = p?.attributes ?? {};
    const baseId = p?.relationships?.base_token?.data?.id; // "solana_<mint>"
    if (!baseId || typeof baseId !== "string") return;
    const address = baseId.slice(baseId.indexOf("_") + 1);
    if (!B58.test(address)) return;
    const t = tokens.get(baseId) ?? {};
    const symbol = String(t.symbol ?? a.name?.split("/")[0] ?? "").trim();
    if (!symbol || notSolMeme(symbol, t.name)) return;
    if ((num(a.fdv_usd) ?? 0) >= MAX_SANE_USD * 10 || (num(a.market_cap_usd) ?? 0) >= MAX_SANE_USD * 10) return;
    const tx = a.transactions?.h24 ?? {};
    const poolAddr = String(a.address ?? "");
    out.push({
      address,
      pool: B58.test(poolAddr) ? poolAddr : null,
      dex: p?.relationships?.dex?.data?.id ?? null,
      name: String(t.name ?? symbol).slice(0, 80),
      symbol: symbol.slice(0, 24),
      image: typeof t.image_url === "string" && /^https:\/\//.test(t.image_url) ? t.image_url : null,
      price_usd: num(a.base_token_price_usd),
      fdv_usd: sane(a.fdv_usd),
      mcap_usd: sane(a.market_cap_usd),
      liq_usd: num(a.reserve_in_usd),
      vol_24h: num(a.volume_usd?.h24),
      change_1h: num(a.price_change_percentage?.h1),
      change_24h: num(a.price_change_percentage?.h24),
      buys_24h: Number.isFinite(Number(tx.buys)) ? Number(tx.buys) : null,
      sells_24h: Number.isFinite(Number(tx.sells)) ? Number(tx.sells) : null,
      pool_created: a.pool_created_at && !isNaN(Date.parse(a.pool_created_at)) ? new Date(a.pool_created_at).toISOString() : null,
      trending_rank: trendingOffset === null ? null : trendingOffset + i + 1,
      x_handle: null,
    });
  });
  return out;
}

/** DexScreener pairs → rows (each token's most liquid pair). Exported for tests. */
export function solRowsFromDexscreener(pairs) {
  const best = new Map();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    if (p?.chainId && p.chainId !== "solana") continue;
    const address = String(p?.baseToken?.address ?? "");
    if (!B58.test(address)) continue;
    const symbol = String(p?.baseToken?.symbol ?? "").trim();
    if (!symbol || notSolMeme(symbol, p?.baseToken?.name)) continue;
    if ((num(p?.fdv) ?? 0) >= MAX_SANE_USD * 10 || (num(p?.marketCap) ?? 0) >= MAX_SANE_USD * 10) continue;
    const liq = num(p?.liquidity?.usd);
    const cur = best.get(address);
    if (cur && (cur.liq_usd ?? 0) >= (liq ?? 0)) continue;
    const img = p?.info?.imageUrl;
    const poolAddr = String(p?.pairAddress ?? "");
    best.set(address, {
      address,
      pool: B58.test(poolAddr) ? poolAddr : null,
      dex: p?.dexId ?? null,
      name: String(p?.baseToken?.name ?? symbol).slice(0, 80),
      symbol: symbol.slice(0, 24),
      image: typeof img === "string" && /^https:\/\//.test(img) ? img : null,
      price_usd: num(p?.priceUsd),
      fdv_usd: sane(p?.fdv),
      mcap_usd: sane(p?.marketCap),
      liq_usd: liq,
      vol_24h: num(p?.volume?.h24),
      change_1h: num(p?.priceChange?.h1),
      change_24h: num(p?.priceChange?.h24),
      buys_24h: Number.isFinite(Number(p?.txns?.h24?.buys)) ? Number(p.txns.h24.buys) : null,
      sells_24h: Number.isFinite(Number(p?.txns?.h24?.sells)) ? Number(p.txns.h24.sells) : null,
      pool_created: Number.isFinite(Number(p?.pairCreatedAt)) && Number(p.pairCreatedAt) > 0 ? new Date(Number(p.pairCreatedAt)).toISOString() : null,
      trending_rank: null,
      x_handle: xHandle(p?.info?.socials),
    });
  }
  return [...best.values()];
}

/** Keeps each token's busiest pool (and its best trending rank). */
function busiest(rows) {
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.address);
    if (!cur || (r.liq_usd ?? 0) > (cur.liq_usd ?? 0)) best.set(r.address, { ...r, trending_rank: r.trending_rank ?? cur?.trending_rank ?? null });
    else if (r.trending_rank !== null && (cur.trending_rank === null || r.trending_rank < cur.trending_rank)) cur.trending_rank = r.trending_rank;
  }
  return [...best.values()];
}

const COLS = ["address", "pool", "dex", "name", "symbol", "image", "price_usd", "fdv_usd", "mcap_usd", "liq_usd", "vol_24h", "change_1h", "change_24h", "buys_24h", "sells_24h", "pool_created", "trending_rank", "x_handle"];

async function save(pool, rows) {
  if (!rows.length) return;
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    values.push(`(${COLS.map((_, j) => `$${i * COLS.length + j + 1}`).join(",")},now())`);
    for (const c of COLS) params.push(r[c] ?? null);
  });
  await pool.query(
    `insert into sol_ext_tokens (${COLS.join(",")},seen_at) values ${values.join(",")}
     on conflict (address) do update set
       pool = coalesce(excluded.pool, sol_ext_tokens.pool), dex = excluded.dex, name = excluded.name, symbol = excluded.symbol,
       image = coalesce(excluded.image, sol_ext_tokens.image), price_usd = excluded.price_usd,
       fdv_usd = excluded.fdv_usd, mcap_usd = excluded.mcap_usd, liq_usd = excluded.liq_usd,
       vol_24h = excluded.vol_24h, change_1h = excluded.change_1h, change_24h = excluded.change_24h,
       buys_24h = excluded.buys_24h, sells_24h = excluded.sells_24h,
       pool_created = coalesce(excluded.pool_created, sol_ext_tokens.pool_created),
       trending_rank = coalesce(excluded.trending_rank, sol_ext_tokens.trending_rank),
       x_handle = coalesce(excluded.x_handle, sol_ext_tokens.x_handle), seen_at = now()`,
    params
  );
}

/** GoPlus lists a transfer hook as a program address (an empty list or object when there is none). */
const hasHook = (h) => {
  if (!h) return false;
  if (Array.isArray(h)) return h.some((x) => x && (x.address || typeof x === "string"));
  if (typeof h === "object") return !!h.address;
  return String(h).length > 0;
};
const st = (v) => (v && typeof v === "object" ? String(v.status ?? "") : String(v ?? ""));

/** GoPlus's Solana answer for one token → our columns. Exported for tests. */
export function solCheckFromGoplus(g) {
  if (!g || typeof g !== "object") return null;
  const holders = Array.isArray(g.holders) ? g.holders : [];
  const top10 = holders.slice(0, 10).reduce((s, h) => s + (Number(h?.percent) || 0), 0);
  // a transfer fee (Token-2022) works like a tax on every buy and sell; GoPlus gives it in basis points
  const feeBps = num(g.transfer_fee?.current_fee_rate?.fee_rate);
  const tax = feeBps === null ? 0 : feeBps / 10_000;
  const yes = (v) => st(v) === "1";
  return {
    gp_honeypot: false,
    // someone can freeze holders' coins, they can't be moved, they start frozen, someone can change
    // balances, or a transfer hook (a program that runs on every transfer: it can block sells)
    gp_cannot_sell:
      yes(g.freezable) ||
      String(g.non_transferable ?? "") === "1" ||
      String(g.default_account_state ?? "") === "2" ||
      yes(g.balance_mutable_authority) ||
      (hasHook(g.transfer_hook) && String(g.trusted_token ?? "") !== "1"),
    gp_buy_tax: tax,
    gp_sell_tax: tax,
    gp_mintable: st(g.mintable) === "" ? null : yes(g.mintable),
    gp_top10: holders.length ? Math.min(1, top10) : null,
  };
}

async function goplusSol(addresses) {
  const r = await fetch(`${GOPLUS_SOL}?contract_addresses=${addresses.join(",")}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`GoPlus ${r.status}`);
  const j = await r.json();
  if (j?.code !== 1 || !j.result) return null;
  return j.result;
}

export async function solMarketsLoop(pool, log) {
  if (process.env.MARKETS_SOLANA === "0" || process.env.MARKETS_OFF === "1") return;
  await pool.query(SQL);
  const every = Number(process.env.MARKETS_EVERY_MS ?? "120000");
  log("markets: watching solana (sol_ext_tokens)");
  for (let round = 1; ; round++) {
    const started = Date.now();
    try {
      // stay out of step with markets.mjs's calls to the same free API
      await sleep(GAP * 2);
      const got = [];
      const page = ((round - 1) % 5) + 1;
      const offset = (page - 1) * 20;
      got.push(...solRowsFromPools(await gt(`/networks/${NETWORK}/trending_pools?include=base_token&page=${page}`), offset));
      await sleep(GAP);
      got.push(...solRowsFromPools(await gt(`/networks/${NETWORK}/pools?include=base_token&page=${((round - 1) % 10) + 1}&sort=h24_volume_usd_desc`)));
      await sleep(GAP);
      if (round % 3 === 1) {
        got.push(...solRowsFromPools(await gt(`/networks/${NETWORK}/new_pools?include=base_token&page=1`)));
        await sleep(GAP);
      }
      const rows = busiest(got);
      await pool.query("update sol_ext_tokens set trending_rank = null where trending_rank between $1 and $2", [offset + 1, offset + 20]);
      await save(pool, rows);
      if (round <= 3 || round % 30 === 0) log(`markets solana: ${rows.length} coins updated`);
    } catch (e) {
      log(`markets solana: ${e.message}`);
    }
    // what DexScreener users watch on Solana right now, then fresh numbers for every coin seen today
    try {
      const lists = await Promise.all(["/token-profiles/latest/v1", "/token-boosts/latest/v1", "/token-boosts/top/v1"].map((p) => ds(p).catch(() => [])));
      const want = new Set();
      for (const list of lists) for (const t of Array.isArray(list) ? list : []) if (t?.chainId === "solana" && B58.test(String(t?.tokenAddress ?? ""))) want.add(t.tokenAddress);
      const { rows: known } = await pool.query(
        `select address from sol_ext_tokens where seen_at > now() - interval '24 hours' and coalesce(vol_24h, 0) >= 5000
         order by vol_24h desc nulls last limit 400`
      );
      const addrs = [...new Set([...[...want].slice(0, 90), ...known.map((r) => r.address)])];
      let n = 0;
      for (let i = 0; i < addrs.length; i += 30) {
        const got = solRowsFromDexscreener(await ds(`/tokens/v1/solana/${addrs.slice(i, i + 30).join(",")}`).catch(() => []));
        await save(pool, got);
        n += got.length;
        // slower than markets.mjs (both share DexScreener's limit; the other chains come first)
        await sleep(1000);
      }
      if (round <= 3 || round % 30 === 0) log(`markets solana: ${n} coins from DexScreener`);
    } catch (e) {
      log(`markets solana: DexScreener ${e.message}`);
    }
    // the safety check, 20 coins at a time, each at most once a day
    try {
      const { rows: todo } = await pool.query(
        `select address from sol_ext_tokens where seen_at > now() - interval '10 minutes'
           and (gp_checked_at is null or gp_checked_at < now() - interval '1 day')
         order by vol_24h desc nulls last limit 20`
      );
      if (todo.length) {
        const res = await goplusSol(todo.map((r) => r.address)).catch((e) => {
          log(`markets solana: GoPlus ${e.message}`);
          return null;
        });
        if (res)
          for (const r of todo) {
            const g = res[r.address] ?? res[r.address.toLowerCase()];
            // no answer for this coin: leave it unchecked (asked again next round)
            if (!g) continue;
            const c = solCheckFromGoplus(g);
            await pool.query(
              `update sol_ext_tokens set gp_checked_at = now(), gp_honeypot = $2, gp_cannot_sell = $3, gp_buy_tax = $4,
                 gp_sell_tax = $5, gp_mintable = $6, gp_top10 = $7 where address = $1`,
              [r.address, c?.gp_honeypot ?? null, c?.gp_cannot_sell ?? null, c?.gp_buy_tax ?? null, c?.gp_sell_tax ?? null, c?.gp_mintable ?? null, c?.gp_top10 ?? null]
            );
          }
      }
    } catch (e) {
      log(`markets solana: check ${e.message}`);
    }
    await pool.query("delete from sol_ext_tokens where seen_at < now() - interval '30 days'").catch(() => {});
    await sleep(Math.max(5_000, every - (Date.now() - started)));
  }
}
