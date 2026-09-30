// All coins: keeps a list of the busiest coins on every DEX of our chains.
//
// Every ~2 min, per network: GeckoTerminal trending and top-volume pools, and
// new pools every third round (about 5 calls a minute; the free API allows 30). Each pool's base token is saved
// with its price, volume, liquidity and changes. New tokens get a GoPlus check
// (can it be sold, taxes, can the owner mint). The site reads the ext_coins
// view, which only shows active, sellable coins.
//
// Env: MARKETS_NETWORKS  JSON [{ id, chainId }] (GeckoTerminal ids). Default:
//      Base, BNB Chain, Ethereum, plus Robinhood Chain and Arc when GeckoTerminal
//      lists them (found by name at start-up).
//      MARKETS_EVERY_MS  default 120000. MARKETS_GAP_MS pause between calls (6500).
//      MARKETS_OFF=1 turns it off.

const GT = "https://api.geckoterminal.com/api/v2";
const GOPLUS = "https://api.gopluslabs.io/api/v1/token_security";
const DEXSCREENER = "https://api.dexscreener.com/latest/dex/tokens";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Base tokens that aren't memecoins (wrapped gas coins, stablecoins, majors).
const NOT_MEME = new Set(
  ["WETH", "ETH", "WBNB", "BNB", "USDC", "USDT", "DAI", "USDE", "USDS", "FDUSD", "USDG", "WBTC", "CBBTC", "BTCB", "TBTC", "CBETH", "WSTETH", "STETH", "RETH", "EURC", "USD1", "PYUSD", "FRAX", "LUSD", "GHO", "USDBC"].map((s) => s.toUpperCase())
);

/**
 * Not a meme coin: wrapped gas coins and majors, stablecoins, staked ETH. The
 * list shows coins people trade for fun, not the plumbing. Exported for tests.
 */
export function notMeme(symbol, name) {
  const s = String(symbol ?? "").toUpperCase();
  const n = String(name ?? "");
  return (
    NOT_MEME.has(s) ||
    /USD/.test(s) || // stablecoins: RLUSD, crvUSD, USDT0, sUSDe, BUSD…
    /^W(ETH|BTC|BNB|SOL|AVAX|POL|MATIC|S)$/.test(s) ||
    /^(ST|WST|WE|EZ|R|CB|S|M|OS)ETH$/.test(s) ||
    /\bwrapped\b/i.test(n) ||
    /\bstable ?coin\b/i.test(n)
  );
}

// No meme coin is worth a trillion dollars: bigger values are broken data
// (a token with an absurd supply), shown as unknown. Exported for tests.
export const MAX_SANE_USD = 1e12;
export function sane(v) {
  const x = num(v);
  return x !== null && x > 0 && x < MAX_SANE_USD ? x : null;
}

const DEFAULT_NETWORKS = [
  { id: "base", chainId: 8453 },
  { id: "bsc", chainId: 56 },
  { id: "eth", chainId: 1 },
];

// The free API allows ~30 calls a minute per IP, and cloud IPs are shared:
// stay far below it, and wait out a limit once instead of skipping.
const GAP = Number(process.env.MARKETS_GAP_MS ?? "6500");
const PAGES = 3;

async function gt(path, retry = true) {
  // Never wait forever on a slow API: that would stop the whole loop.
  const r = await fetch(`${GT}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (r.status === 429) {
    if (!retry) throw new Error("GeckoTerminal rate limit");
    await sleep(30_000);
    return gt(path, false);
  }
  if (!r.ok) throw new Error(`GeckoTerminal ${r.status} for ${path}`);
  return r.json();
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Pools (+ included base tokens) -> token rows. Exported for tests. */
export function rowsFromPools(json, network, chainId, trendingOffset = null) {
  const tokens = new Map();
  for (const t of json?.included ?? []) if (t?.type === "token") tokens.set(t.id, t.attributes ?? {});
  const out = [];
  (json?.data ?? []).forEach((p, i) => {
    const a = p?.attributes ?? {};
    const baseId = p?.relationships?.base_token?.data?.id; // "<network>_<address>"
    if (!baseId || typeof baseId !== "string") return;
    const address = baseId.slice(baseId.indexOf("_") + 1).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) return; // EVM tokens only (for now)
    const t = tokens.get(baseId) ?? {};
    const symbol = String(t.symbol ?? a.name?.split("/")[0] ?? "").trim();
    if (!symbol || notMeme(symbol, t.name)) return;
    // Broken data (absurd market value) means a broken or fake token: skip it.
    if ((num(a.fdv_usd) ?? 0) >= MAX_SANE_USD * 10 || (num(a.market_cap_usd) ?? 0) >= MAX_SANE_USD * 10) return;
    const tx = a.transactions?.h24 ?? {};
    out.push({
      network,
      chain_id: chainId,
      address,
      pool: String(a.address ?? "").toLowerCase() || null,
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
    });
  });
  return out;
}

/** Keeps each token's busiest pool only (a token can trade in several pools). */
export function busiest(rows) {
  const best = new Map();
  for (const r of rows) {
    const k = `${r.network}:${r.address}`;
    const cur = best.get(k);
    if (!cur || (r.liq_usd ?? 0) > (cur.liq_usd ?? 0)) best.set(k, { ...r, trending_rank: r.trending_rank ?? cur?.trending_rank ?? null });
    else if (r.trending_rank !== null && (cur.trending_rank === null || r.trending_rank < cur.trending_rank)) cur.trending_rank = r.trending_rank;
  }
  return [...best.values()];
}

/** Finds GeckoTerminal ids for chains added after this was written (by name). */
async function discover(log) {
  const want = [
    { re: /robinhood/i, chainId: 4663 },
    { re: /^arc\b|arc network|arc mainnet/i, chainId: 5042 },
  ];
  const found = [];
  for (let page = 1; page <= 8 && found.length < want.length; page++) {
    const j = await gt(`/networks?page=${page}`).catch(() => null);
    const list = j?.data ?? [];
    if (!list.length) break;
    for (const n of list) {
      const name = String(n?.attributes?.name ?? "");
      for (const w of want) if (w.re.test(name) && !found.some((f) => f.chainId === w.chainId) && !/test/i.test(name)) found.push({ id: n.id, chainId: w.chainId, name });
    }
    await sleep(GAP);
  }
  for (const f of found) log(`markets: found ${f.name} as "${f.id}"`);
  return found;
}

async function goplus(chainId, addresses) {
  const r = await fetch(`${GOPLUS}/${chainId}?contract_addresses=${addresses.join(",")}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`GoPlus ${r.status}`);
  const j = await r.json();
  if (j?.code !== 1 || !j.result) return null; // chain not covered, or no answer
  return j.result;
}

const flag = (v) => (v === "1" ? true : v === "0" ? false : null);

/** GoPlus answer for one token -> our columns. Exported for tests. */
export function checkFromGoplus(g) {
  if (!g || typeof g !== "object") return null;
  const holders = Array.isArray(g.holders) ? g.holders : [];
  const top10 = holders.slice(0, 10).reduce((s, h) => s + (Number(h?.percent) || 0), 0);
  return {
    gp_honeypot: flag(g.is_honeypot),
    gp_cannot_sell: flag(g.cannot_sell_all),
    gp_buy_tax: num(g.buy_tax),
    gp_sell_tax: num(g.sell_tax),
    gp_mintable: flag(g.is_mintable),
    gp_top10: holders.length ? Math.min(1, top10) : null,
  };
}

async function save(pool, rows) {
  if (!rows.length) return;
  const cols = ["network", "chain_id", "address", "pool", "dex", "name", "symbol", "image", "price_usd", "fdv_usd", "mcap_usd", "liq_usd", "vol_24h", "change_1h", "change_24h", "buys_24h", "sells_24h", "pool_created", "trending_rank", "x_handle"];
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    values.push(`(${cols.map((_, j) => `$${i * cols.length + j + 1}`).join(",")},now())`);
    for (const c of cols) params.push(r[c] ?? null);
  });
  await pool.query(
    `insert into ext_tokens (${cols.join(",")},seen_at) values ${values.join(",")}
     on conflict (network, address) do update set
       pool = excluded.pool, dex = excluded.dex, name = excluded.name, symbol = excluded.symbol,
       image = coalesce(excluded.image, ext_tokens.image), price_usd = excluded.price_usd,
       fdv_usd = excluded.fdv_usd, mcap_usd = excluded.mcap_usd, liq_usd = excluded.liq_usd,
       vol_24h = excluded.vol_24h, change_1h = excluded.change_1h, change_24h = excluded.change_24h,
       buys_24h = excluded.buys_24h, sells_24h = excluded.sells_24h,
       pool_created = coalesce(excluded.pool_created, ext_tokens.pool_created),
       trending_rank = coalesce(excluded.trending_rank, ext_tokens.trending_rank),
       x_handle = coalesce(excluded.x_handle, ext_tokens.x_handle), seen_at = now()`,
    params
  );
}

// DexScreener chain ids for our networks (GeckoTerminal id -> DexScreener id).
const DS_CHAIN = { base: "base", bsc: "bsc", eth: "ethereum", robinhood: "robinhood", arc: "arc" };
const DS = "https://api.dexscreener.com";

async function ds(path) {
  const r = await fetch(`${DS}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`DexScreener ${r.status} for ${path}`);
  return r.json();
}

/** DexScreener pairs of one chain -> our rows (each token's most liquid pair). Exported for tests. */
export function rowsFromDexscreener(pairs, network, chainId) {
  const best = new Map();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const address = String(p?.baseToken?.address ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
    const symbol = String(p?.baseToken?.symbol ?? "").trim();
    if (!symbol || notMeme(symbol, p?.baseToken?.name)) continue;
    if ((num(p?.fdv) ?? 0) >= MAX_SANE_USD * 10 || (num(p?.marketCap) ?? 0) >= MAX_SANE_USD * 10) continue;
    const liq = num(p?.liquidity?.usd);
    const cur = best.get(address);
    if (cur && (cur.liq_usd ?? 0) >= (liq ?? 0)) continue;
    const img = p?.info?.imageUrl;
    best.set(address, {
      network,
      chain_id: chainId,
      address,
      pool: String(p?.pairAddress ?? "").toLowerCase() || null,
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

/** A project's X handle from DexScreener socials (x.com/<handle> or twitter.com/<handle>). */
export function xHandle(socials) {
  for (const s of Array.isArray(socials) ? socials : []) {
    if (!/^(twitter|x)$/i.test(String(s?.type ?? ""))) continue;
    const m = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/.exec(String(s?.url ?? ""));
    if (m && !/^(i|home|intent|search|share|hashtag)$/i.test(m[1])) return m[1];
  }
  return null;
}

/**
 * Second source: coins DexScreener users are looking at right now (newest
 * profiles and boosted tokens), on our chains, with full market data.
 */
async function fromDexscreener(pool, networks, log) {
  const lists = await Promise.all(["/token-profiles/latest/v1", "/token-boosts/latest/v1", "/token-boosts/top/v1"].map((p) => ds(p).catch(() => [])));
  const want = new Map(); // dsChain -> Set(address)
  for (const list of lists)
    for (const t of Array.isArray(list) ? list : []) {
      const chain = String(t?.chainId ?? "");
      const addr = String(t?.tokenAddress ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
      if (!want.has(chain)) want.set(chain, new Set());
      want.get(chain).add(addr);
    }
  let total = 0;
  for (const n of networks) {
    const dsChain = DS_CHAIN[n.id];
    const addrs = [...(want.get(dsChain) ?? [])].slice(0, 90);
    for (let i = 0; i < addrs.length; i += 30) {
      const pairs = await ds(`/tokens/v1/${dsChain}/${addrs.slice(i, i + 30).join(",")}`).catch(() => []);
      const rows = rowsFromDexscreener(pairs, n.id, n.chainId);
      await save(pool, rows);
      total += rows.length;
      await sleep(400);
    }
  }
  return total;
}

/** DexScreener pairs -> { tokenAddress: imageUrl }. Exported for tests. */
export function imagesFromDexscreener(json) {
  const out = {};
  for (const p of json?.pairs ?? []) {
    const addr = String(p?.baseToken?.address ?? "").toLowerCase();
    const img = p?.info?.imageUrl;
    if (/^0x[0-9a-f]{40}$/.test(addr) && typeof img === "string" && /^https:\/\//.test(img) && !out[addr]) out[addr] = img;
  }
  return out;
}

async function fillImages(pool, log) {
  // Up to 30 addresses per call; each coin is asked at most once a day.
  const { rows } = await pool.query(
    `select network, address from ext_tokens
      where image is null and seen_at > now() - interval '1 day'
        and (ds_checked_at is null or ds_checked_at < now() - interval '1 day')
      order by vol_24h desc nulls last limit 30`
  );
  if (!rows.length) return;
  const r = await fetch(`${DEXSCREENER}/${rows.map((x) => x.address).join(",")}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  const found = imagesFromDexscreener(await r.json());
  let n = 0;
  for (const x of rows) {
    const img = found[x.address] ?? null;
    if (img) n++;
    await pool.query("update ext_tokens set ds_checked_at = now(), image = coalesce(image, $3) where network = $1 and address = $2", [x.network, x.address, img]);
  }
  if (n) log(`markets: ${n} pictures from DexScreener`);
}

export async function marketsLoop(pool, log) {
  if (process.env.MARKETS_OFF === "1") return;
  const every = Number(process.env.MARKETS_EVERY_MS ?? "120000");
  let round = 0;
  let networks = DEFAULT_NETWORKS;
  try {
    if (process.env.MARKETS_NETWORKS) networks = JSON.parse(process.env.MARKETS_NETWORKS);
    else networks = [...DEFAULT_NETWORKS, ...(await discover(log))];
  } catch (e) {
    log(`markets: bad MARKETS_NETWORKS (${e.message}); using defaults`);
  }
  log(`markets: watching ${networks.map((n) => n.id).join(", ")}`);

  for (;;) {
    const started = Date.now();
    round++;
    for (const n of networks) {
      try {
        const got = [];
        // One page of each list per round (20 pools a page), pages 1-3 in turn:
        // ~60 trending + ~60 busiest coins per chain, without extra calls.
        const page = ((round - 1) % PAGES) + 1;
        const offset = (page - 1) * 20;
        const t = await gt(`/networks/${n.id}/trending_pools?include=base_token&page=${page}`);
        got.push(...rowsFromPools(t, n.id, n.chainId, offset));
        await sleep(GAP);
        const top = await gt(`/networks/${n.id}/pools?include=base_token&page=${page}&sort=h24_volume_usd_desc`);
        got.push(...rowsFromPools(top, n.id, n.chainId));
        await sleep(GAP);
        // Brand-new pools rarely pass the volume bar yet: every third round is enough.
        if (round % 3 === 1) {
          const nw = await gt(`/networks/${n.id}/new_pools?include=base_token&page=1`);
          got.push(...rowsFromPools(nw, n.id, n.chainId));
          await sleep(GAP);
        }
        const rows = busiest(got);
        // Ranks on this page are replaced by the fresh ones (other pages keep theirs).
        await pool.query("update ext_tokens set trending_rank = null where network = $1 and trending_rank between $2 and $3", [n.id, offset + 1, offset + 20]);
        await save(pool, rows);
        if (round <= 3 || round % 30 === 0) log(`markets ${n.id}: ${rows.length} coins updated`);

        // GoPlus: tokens never checked (or checked over a day ago), 20 at a time.
        const { rows: todo } = await pool.query(
          `select address from ext_tokens where network = $1 and seen_at > now() - interval '10 minutes'
             and (gp_checked_at is null or gp_checked_at < now() - interval '1 day')
           order by vol_24h desc nulls last limit 20`,
          [n.id]
        );
        if (todo.length && n.chainId) {
          const res = await goplus(n.chainId, todo.map((r) => r.address)).catch((e) => {
            log(`markets: GoPlus ${n.id}: ${e.message}`);
            return null;
          });
          for (const r of todo) {
            const c = res ? checkFromGoplus(res[r.address] ?? res[r.address.toLowerCase()]) : null;
            await pool.query(
              `update ext_tokens set gp_checked_at = now(), gp_honeypot = $3, gp_cannot_sell = $4, gp_buy_tax = $5,
                 gp_sell_tax = $6, gp_mintable = $7, gp_top10 = $8 where network = $1 and address = $2`,
              [n.id, r.address, c?.gp_honeypot ?? null, c?.gp_cannot_sell ?? null, c?.gp_buy_tax ?? null, c?.gp_sell_tax ?? null, c?.gp_mintable ?? null, c?.gp_top10 ?? null]
            );
          }
        }
      } catch (e) {
        log(`markets ${n.id}: ${e.message}`);
        await sleep(5000);
      }
    }
    // Second source (its own, higher limits): what DexScreener users watch now.
    try {
      const got = await fromDexscreener(pool, networks, log);
      if (round <= 3 || round % 30 === 0) log(`markets: ${got} coins from DexScreener`);
    } catch (e) {
      log(`markets: DexScreener ${e.message}`);
    }
    // Missing pictures: ask DexScreener (projects often upload theirs there first).
    await fillImages(pool, log).catch((e) => log(`markets: DexScreener ${e.message}`));
    // Coins stay searchable for 30 days after their last trade, then go.
    await pool.query("delete from ext_tokens where seen_at < now() - interval '30 days'").catch(() => {});
    await sleep(Math.max(5_000, every - (Date.now() - started)));
  }
}
