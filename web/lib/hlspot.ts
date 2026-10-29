/**
 * Hyperliquid's own spot market (HyperCore): HYPE, KNTQ, PURR and every other token paired with
 * USDC there. The ones the Market list doesn't already have join it as ordinary rows (newSpotOnly); bought and sold through the user's
 * Hyperliquid account (lib/perpstrade.ts spotBuy / spotSell), the same account as Futures and
 * Predict. Prices come from Hyperliquid itself (spotMetaAndAssetCtxs), no other source.
 */
import { info } from "./perps";

export type HlSpot = {
  /** The pair's name in Hyperliquid's API ("PURR/USDC" or "@107"): what l2Book and candles take. */
  coin: string;
  /** Order asset id: 10000 + the pair's index. */
  asset: number;
  /** The base token's name as balances list it ("HYPE", "KNTQ"). */
  token: string;
  /** What people call it (the token's full name when Hyperliquid has one). */
  name: string;
  szDecimals: number;
  price: number;
  change24h: number | null;
  vol24h: number;
  mcap: number | null;
};

type Meta = {
  tokens: { name: string; szDecimals: number; index: number; fullName?: string | null }[];
  universe: { name: string; tokens: [number, number]; index: number }[];
};
type Ctx = { dayNtlVlm: string; markPx: string; midPx: string | null; prevDayPx: string; circulatingSupply?: string };

let cache: { at: number; list: Promise<HlSpot[]> } | null = null;

/** Every USDC-quoted spot pair on Hyperliquid with real trading, biggest volume first (cached 20 s). */
export function fetchHlSpot(): Promise<HlSpot[]> {
  if (cache && Date.now() - cache.at < 20_000) return cache.list;
  const list = (async () => {
    const [meta, ctxs] = await info<[Meta, Ctx[]]>({ type: "spotMetaAndAssetCtxs" });
    const tok = new Map(meta.tokens.map((t) => [t.index, t]));
    const usdc = meta.tokens.find((t) => t.name === "USDC")?.index ?? 0;
    const out: HlSpot[] = [];
    meta.universe.forEach((u, i) => {
      const c = ctxs[i];
      if (!c || u.tokens[1] !== usdc) return;
      const base = tok.get(u.tokens[0]);
      if (!base) return;
      const price = Number(c.midPx ?? c.markPx);
      const prev = Number(c.prevDayPx);
      const vol = Number(c.dayNtlVlm) || 0;
      if (!(price > 0) || vol < 1) return; // dead pairs (no trading today) stay out
      const supply = Number(c.circulatingSupply);
      const cap = supply > 0 ? supply * price : null;
      // Thin markets quote silly prices (a $4,000 coin with $2K traded): only believe a market cap that
      // real trading backs up, at least 0.05% of it traded today and $20K in all.
      const mcap = cap && vol >= 20_000 && vol >= cap * 0.0005 ? cap : null;
      const full = base.fullName?.trim();
      out.push({
        coin: u.name,
        asset: 10_000 + u.index,
        token: base.name,
        name: full && !/hyperliquid/i.test(full) ? full : base.name,
        szDecimals: base.szDecimals,
        price,
        change24h: prev > 0 ? ((price - prev) / prev) * 100 : null,
        vol24h: vol,
        mcap,
      });
    });
    return out.sort((a, b) => b.vol24h - a.vol24h);
  })();
  cache = { at: Date.now(), list };
  list.catch(() => (cache = null));
  return list;
}

/** The user's spot token balances on Hyperliquid (token name → amount free to sell). */
export async function hlSpotBalances(user: string): Promise<Map<string, number>> {
  const s = await info<{ balances?: { coin: string; total: string; hold: string }[] }>({ type: "spotClearinghouseState", user: user.toLowerCase() });
  const m = new Map<string, number>();
  for (const b of s?.balances ?? []) {
    const free = (Number(b.total) || 0) - (Number(b.hold) || 0);
    if (free > 0) m.set(b.coin, free);
  }
  return m;
}

/** Spot prices: at most 5 significant digits and (8 − szDecimals) decimals. */
export function spotPrice(px: number, szDecimals: number): string {
  if (!(px > 0)) return "0";
  const sig = Number(px.toPrecision(5));
  const s = sig.toFixed(Math.max(0, 8 - szDecimals));
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Dollar coins never show on the Market list (USDT0, USDH, USDE, feUSD…). */
const isDollar = (m: HlSpot) =>
  /USD|^USDT|DAI$/i.test(m.token) || /dollar/i.test(m.name) || (m.price > 0.97 && m.price < 1.03 && /usd/i.test(m.name)) || (m.price > 0.99 && m.price < 1.01 && Math.abs(m.change24h ?? 0) < 1);

/**
 * Hyperliquid tokens that may join the Market list: only coins the main list doesn't already have,
 * so no coin ever shows twice. Dropped: any symbol or name already on the list; Hyperliquid's wrapped
 * copies (UBTC, UETH, USOL… "Unit" assets: the leading U taken off matches a listed coin, or the name
 * starts "Unit "; AVAX0-style copies with a trailing 0); dollar coins; and thin pairs (under $25K
 * traded today) that would only add noise.
 */
export function newSpotOnly(list: HlSpot[], have: { symbol: string; name: string }[]): HlSpot[] {
  const syms = new Set(have.map((c) => c.symbol.toUpperCase()));
  const names = new Set(have.map((c) => c.name.trim().toLowerCase()));
  const seen = new Set<string>();
  return list.filter((m) => {
    const s = m.token.toUpperCase();
    const bare = [s.startsWith("U") && s.length > 2 ? s.slice(1) : null, s.endsWith("0") && s.length > 2 ? s.slice(0, -1) : null];
    if (syms.has(s) || bare.some((b) => b && syms.has(b))) return false;
    if (names.has(m.name.trim().toLowerCase()) || /^unit\s/i.test(m.name)) return false;
    if (isDollar(m) || m.vol24h < 25_000 || seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

/** Smallest spot order Hyperliquid takes, in dollars. */
export const SPOT_MIN = 10;
/** sasa's fee on Hyperliquid spot trades (builder fee, tenths of a basis point: 500 = 0.5%). */
export const SPOT_FEE_TENTHS_BP = 500;
