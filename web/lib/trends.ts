/**
 * Trend Radar: what new meme coins are hot right now across DEXs (GeckoTerminal's
 * trending pools, every network), boiled down to a few themes a creator can launch on.
 * Read straight from the browser (GeckoTerminal's free API allows it) and kept for
 * 10 minutes so a page visit costs at most one call.
 */
const GT = "https://api.geckoterminal.com/api/v2";
const KEY = "sasa:trends:v1";
const TTL = 10 * 60_000;

export type TrendCoin = {
  name: string;
  symbol: string;
  network: string;
  image: string | null;
  vol24: number;
  change24: number | null;
  ageHours: number | null;
};
export type Trends = { at: number; coins: TrendCoin[]; themes: string[] };

const NETWORKS: Record<string, string> = {
  solana: "Solana",
  base: "Base",
  bsc: "BNB",
  eth: "Ethereum",
  arbitrum: "Arbitrum",
  "robinhood-chain": "Robinhood",
  robinhood: "Robinhood",
  arc: "Arc",
  sui: "Sui",
  ton: "TON",
  tron: "Tron",
  polygon_pos: "Polygon",
  avax: "Avalanche",
  hyperevm: "HyperEVM",
  abstract: "Abstract",
  monad: "Monad",
};
export const networkLabel = (id: string) => NETWORKS[id] ?? id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// Big, old or pegged coins are never "a trend to launch on".
const NOT_MEME = new Set([
  "WETH", "ETH", "WBTC", "BTC", "CBBTC", "SOL", "WSOL", "USDC", "USDT", "USDG", "DAI", "USDE", "USD1", "FDUSD", "BNB", "WBNB",
  "VIRTUAL", "AERO", "ZRO", "TRX", "SUI", "TON", "HYPE", "PUMP", "JUP", "RAY", "BONK", "WIF", "PEPE", "LINK", "UNI", "ARB", "OP",
]);
// Words that say nothing about a theme.
const STOP = new Set([
  "the", "a", "an", "of", "on", "in", "to", "and", "for", "by", "is", "it", "my", "your", "coin", "token", "inu", "official",
  "meme", "memecoin", "sol", "eth", "base", "bnb", "bsc", "new", "real", "first", "just", "this", "that", "with", "from", "dao",
  "ai", "v2", "v3", "x", "s", "de", "la", "el", "le",
]);

const num = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Pools JSON -> one row per coin (busiest pool wins). Exported for tests. */
export function coinsFromPools(json: unknown, now = Date.now()): TrendCoin[] {
  const j = json as { data?: unknown[]; included?: unknown[] };
  const tokens = new Map<string, { name?: string; symbol?: string; image_url?: string }>();
  for (const t of (j?.included ?? []) as { id?: string; type?: string; attributes?: Record<string, string> }[]) {
    if (t?.type === "token" && t.id) tokens.set(t.id, t.attributes ?? {});
  }
  const best = new Map<string, TrendCoin>();
  for (const p of (j?.data ?? []) as {
    attributes?: Record<string, unknown>;
    relationships?: { base_token?: { data?: { id?: string } }; network?: { data?: { id?: string } } };
  }[]) {
    const a = p?.attributes ?? {};
    const baseId = p?.relationships?.base_token?.data?.id ?? "";
    const t = tokens.get(baseId) ?? {};
    const network = p?.relationships?.network?.data?.id ?? baseId.split("_")[0] ?? "";
    const symbol = String(t.symbol ?? String(a.name ?? "").split("/")[0] ?? "").trim();
    const name = String(t.name ?? symbol).trim();
    if (!symbol || NOT_MEME.has(symbol.toUpperCase())) continue;
    const created = typeof a.pool_created_at === "string" ? Date.parse(a.pool_created_at) : NaN;
    const vol = (a.volume_usd ?? {}) as Record<string, unknown>;
    const chg = (a.price_change_percentage ?? {}) as Record<string, unknown>;
    const row: TrendCoin = {
      name,
      symbol,
      network,
      image: typeof t.image_url === "string" && /^https:\/\//.test(t.image_url) ? t.image_url : null,
      vol24: num(vol.h24),
      change24: chg.h24 === undefined || chg.h24 === null ? null : num(chg.h24),
      ageHours: Number.isFinite(created) ? Math.max(0, (now - created) / 3_600_000) : null,
    };
    const k = network + ":" + symbol.toLowerCase();
    const cur = best.get(k);
    if (!cur || row.vol24 > cur.vol24) best.set(k, row);
  }
  return [...best.values()];
}

/**
 * Themes to launch on: words several hot coins share first ("kimchi", "frog"), then the
 * hottest coins' own ideas in a few words ("aura final boss", "actually useless").
 */
export function themesFrom(coins: TrendCoin[], max = 8): string[] {
  const clean = (x: string) =>
    x
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const wordsOf = (c: TrendCoin) =>
    new Set(clean(`${c.name} ${c.symbol}`).split(" ").filter((w) => w.length >= 3 && w.length <= 14 && !STOP.has(w) && !/^\d+$/.test(w)));
  const seen = new Map<string, number>();
  for (const c of coins) for (const w of wordsOf(c)) seen.set(w, (seen.get(w) ?? 0) + 1);
  const shared = [...seen.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([w]) => w);

  const own: string[] = [];
  for (const c of coins) {
    const name = clean(c.name)
      .split(" ")
      .filter((w) => w && !STOP.has(w))
      .join(" ");
    const sym = clean(c.symbol);
    let theme = name;
    if (/^[a-z]{3,}$/.test(sym) && !name.includes(sym)) theme = name && name.split(" ").length <= 2 ? `${sym} ${name}` : sym;
    if (!theme) theme = sym;
    if (theme.length > 24) theme = theme.split(" ").slice(0, 3).join(" ").slice(0, 24).trim();
    if (theme.length >= 3) own.push(theme);
  }
  const out: string[] = [];
  for (const t of [...shared, ...own]) {
    if (out.length >= max) break;
    if (!out.some((o) => o === t || o.includes(t) || t.includes(o))) out.push(t);
  }
  return out;
}

function readCache(): Trends | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as Trends;
    return Date.now() - t.at < TTL && Array.isArray(t.coins) ? t : null;
  } catch {
    return null;
  }
}

/** Hot new meme coins and their themes. Throws only when nothing could be read. */
export async function fetchTrends(): Promise<Trends> {
  const cached = readCache();
  if (cached) return cached;
  let coins: TrendCoin[] = [];
  let lastErr: unknown = null;
  for (const duration of ["6h", "24h"]) {
    try {
      const r = await fetch(`${GT}/networks/trending_pools?include=base_token,network&duration=${duration}&page=1`, {
        headers: { accept: "application/json" },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      coins = coinsFromPools(await r.json());
      if (coins.length) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!coins.length) throw lastErr ?? new Error("No trends right now");
  // Fresh coins first, then by volume.
  coins.sort((a, b) => {
    const fa = a.ageHours !== null && a.ageHours < 48 ? 1 : 0;
    const fb = b.ageHours !== null && b.ageHours < 48 ? 1 : 0;
    return fb - fa || b.vol24 - a.vol24;
  });
  const t: Trends = { at: Date.now(), coins: coins.slice(0, 12), themes: themesFrom(coins) };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(t));
  } catch {}
  return t;
}

/** The sentence handed to the AI for a theme: original coins, never a copy of a live one. */
export const trendIdea = (theme: string) =>
  `An original, funny meme coin riding today's "${theme}" trend. Make the name, ticker and picture your own, not a copy of any existing coin.`;
