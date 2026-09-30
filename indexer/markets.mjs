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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Base tokens that aren't memecoins (wrapped gas coins, stablecoins, majors).
const NOT_MEME = new Set(
  ["WETH", "ETH", "WBNB", "BNB", "USDC", "USDT", "DAI", "USDE", "USDS", "FDUSD", "USDG", "WBTC", "CBBTC", "BTCB", "TBTC", "CBETH", "WSTETH", "STETH", "RETH", "EURC", "USD1", "PYUSD", "FRAX", "LUSD", "GHO", "USDBC"].map((s) => s.toUpperCase())
);

const DEFAULT_NETWORKS = [
  { id: "base", chainId: 8453 },
  { id: "bsc", chainId: 56 },
  { id: "eth", chainId: 1 },
];

// The free API allows ~30 calls a minute per IP, and cloud IPs are shared:
// stay far below it, and wait out a limit once instead of skipping.
const GAP = Number(process.env.MARKETS_GAP_MS ?? "6500");

async function gt(path, retry = true) {
  const r = await fetch(`${GT}${path}`, { headers: { accept: "application/json" } });
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
    if (!symbol || NOT_MEME.has(symbol.toUpperCase())) return;
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
      fdv_usd: num(a.fdv_usd),
      mcap_usd: num(a.market_cap_usd),
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
  const r = await fetch(`${GOPLUS}/${chainId}?contract_addresses=${addresses.join(",")}`, { headers: { accept: "application/json" } });
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
  const cols = ["network", "chain_id", "address", "pool", "dex", "name", "symbol", "image", "price_usd", "fdv_usd", "mcap_usd", "liq_usd", "vol_24h", "change_1h", "change_24h", "buys_24h", "sells_24h", "pool_created", "trending_rank"];
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    values.push(`(${cols.map((_, j) => `$${i * cols.length + j + 1}`).join(",")},now())`);
    for (const c of cols) params.push(r[c]);
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
       trending_rank = excluded.trending_rank, seen_at = now()`,
    params
  );
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
        // Trending first (sets the rank), then newest and busiest pools.
        const t = await gt(`/networks/${n.id}/trending_pools?include=base_token&page=1`);
        got.push(...rowsFromPools(t, n.id, n.chainId, 0));
        await sleep(GAP);
        const top = await gt(`/networks/${n.id}/pools?include=base_token&page=1&sort=h24_volume_usd_desc`);
        got.push(...rowsFromPools(top, n.id, n.chainId));
        await sleep(GAP);
        // Brand-new pools rarely pass the volume bar yet: every third round is enough.
        if (round % 3 === 1) {
          const nw = await gt(`/networks/${n.id}/new_pools?include=base_token&page=1`);
          got.push(...rowsFromPools(nw, n.id, n.chainId));
          await sleep(GAP);
        }
        const rows = busiest(got);
        // Tokens not trending any more lose their rank.
        await pool.query("update ext_tokens set trending_rank = null where network = $1 and trending_rank is not null", [n.id]);
        await save(pool, rows);

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
    // Forget coins nobody has traded for a week.
    await pool.query("delete from ext_tokens where seen_at < now() - interval '7 days'").catch(() => {});
    await sleep(Math.max(5_000, every - (Date.now() - started)));
  }
}
