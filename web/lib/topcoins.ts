import { db } from "./data";
import type { ExtCoin } from "./extcoins";

/**
 * Market: the 300 biggest coins (indexer/topcoins.mjs picks them daily from CoinGecko; prices
 * every 15 minutes). Each trades on the cheapest of Base, BNB Chain and Ethereum where it has
 * real DEX liquidity; Bitcoin, ETH and BNB as cbBTC, WETH and WBNB. Trading works like any
 * other DEX coin on sasa (Relay, USDC, 0.7% fee).
 */
export type TopCoin = {
  id: string;
  rank: number | null;
  name: string;
  symbol: string;
  image: string | null;
  network: "base" | "bsc" | "eth";
  address: string;
  via: string | null;
  pool: string | null;
  dex: string | null;
  liqUsd: number | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  vol24h: number | null;
  change24h: number | null;
  change7d: number | null;
  spark: number[] | null;
};

const n = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function toTop(r: Record<string, unknown>): TopCoin {
  return {
    id: String(r.cg_id),
    rank: n(r.rank),
    name: String(r.name ?? ""),
    symbol: String(r.symbol ?? ""),
    image: typeof r.image === "string" && r.image.startsWith("https://") ? r.image : null,
    network: (["base", "bsc", "eth"].includes(String(r.network)) ? r.network : "base") as TopCoin["network"],
    address: String(r.address ?? "").toLowerCase(),
    via: typeof r.via === "string" ? r.via : null,
    pool: typeof r.pool === "string" ? r.pool : null,
    dex: typeof r.dex === "string" ? r.dex : null,
    liqUsd: n(r.liq_usd),
    priceUsd: n(r.price_usd),
    mcapUsd: n(r.mcap_usd),
    vol24h: n(r.vol_24h),
    change24h: n(r.change_24h),
    change7d: n(r.change_7d),
    spark: Array.isArray(r.spark) ? (r.spark as unknown[]).map(Number).filter((x) => Number.isFinite(x)) : null,
  };
}

export async function fetchTopCoins(): Promise<TopCoin[]> {
  const { data, error } = await db.from("top_coins_pub").select("*").order("rank", { ascending: true, nullsFirst: false }).limit(500);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(toTop);
}

export async function fetchTopCoin(id: string): Promise<TopCoin | null> {
  const { data, error } = await db.from("top_coins_pub").select("*").eq("cg_id", id).maybeSingle();
  if (error) throw error;
  return data ? toTop(data as Record<string, unknown>) : null;
}

/** The coin as the coin page and trade box know coins (the traded token on its chain). */
export function topAsExt(c: TopCoin): ExtCoin {
  return {
    network: c.network,
    chainId: c.network === "base" ? 8453 : c.network === "bsc" ? 56 : 1,
    address: c.address,
    pool: c.pool,
    dex: c.dex,
    name: c.name,
    symbol: c.symbol,
    image: c.image,
    priceUsd: c.priceUsd,
    mcapUsd: c.mcapUsd,
    liqUsd: c.liqUsd,
    vol24h: c.vol24h,
    change1h: null,
    change24h: c.change24h,
    buys24h: null,
    sells24h: null,
    poolCreated: null,
    trendingRank: null,
    checkedAt: null,
    buyTax: null,
    sellTax: null,
    mintable: null,
    top10: null,
    xHandle: null,
  };
}

/** In-app link (the app's one Market coin page), and the page's own address outside the app. */
export const topHref = (id: string) => `/m/?id=${encodeURIComponent(id)}`;
export const topPageUrl = (site: string, id: string) => `${site}/m/${encodeURIComponent(id)}/`;
/** CoinGecko ids: lowercase letters, digits and dashes. */
export const isTopId = (id: string) => /^[a-z0-9][a-z0-9-]{0,99}$/.test(id);
