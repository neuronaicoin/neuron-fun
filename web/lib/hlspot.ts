/**
 * Hyperliquid's own spot market (HyperCore): HYPE, KNTQ, PURR and every other token paired with
 * USDC there. Listed on the Market page's "Hyperliquid" tab; bought and sold through the user's
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
      out.push({
        coin: u.name,
        asset: 10_000 + u.index,
        token: base.name,
        name: base.fullName?.trim() || base.name,
        szDecimals: base.szDecimals,
        price,
        change24h: prev > 0 ? ((price - prev) / prev) * 100 : null,
        vol24h: vol,
        mcap: supply > 0 ? supply * price : null,
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

/** Smallest spot order Hyperliquid takes, in dollars. */
export const SPOT_MIN = 10;
/** sasa's fee on Hyperliquid spot trades (builder fee, tenths of a basis point: 500 = 0.5%). */
export const SPOT_FEE_TENTHS_BP = 500;
