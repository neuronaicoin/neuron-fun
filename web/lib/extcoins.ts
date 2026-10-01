"use client";

/**
 * All coins: coins from every DEX on our chains (not launched on sasa), kept
 * fresh by the indexer's markets loop. Read from the ext_coins view, which
 * already hides inactive coins and ones that can't be sold.
 */
import { db } from "./data";

export type ExtCoin = {
  network: string;
  chainId: number | null;
  address: string;
  pool: string | null;
  dex: string | null;
  name: string;
  symbol: string;
  image: string | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  liqUsd: number | null;
  vol24h: number | null;
  change1h: number | null;
  change24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  poolCreated: string | null;
  trendingRank: number | null;
  checkedAt: string | null;
  buyTax: number | null;
  sellTax: number | null;
  mintable: boolean | null;
  top10: number | null;
  /** The project's X account, when it lists one (tagged when people share). */
  xHandle: string | null;
};

/** The chains All coins covers, in the order the filter shows them. */
export const EXT_NETWORKS: { id: string; label: string; color: string }[] = [
  { id: "robinhood", label: "Robinhood", color: "#12b886" },
  { id: "base", label: "Base", color: "#3b6ff5" },
  { id: "bsc", label: "BNB", color: "#f0b90b" },
  { id: "arc", label: "Arc", color: "#7c5cff" },
  { id: "eth", label: "Ethereum", color: "#627eea" },
];
export const extNetwork = (id: string) => EXT_NETWORKS.find((n) => n.id === id);

export type ExtSort = "trending" | "gainers" | "losers" | "new" | "volume";

const n = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// Some DEX data reports 0 when a value is unknown: treat it as unknown.
// …and anything over $1T is broken data, not a meme coin: unknown too.
const pos = (v: unknown) => {
  const x = n(v);
  return x !== null && x > 0 && x < 1e12 ? x : null;
};

function toExt(r: Record<string, unknown>): ExtCoin {
  return {
    network: String(r.network),
    chainId: n(r.chain_id),
    address: String(r.address),
    pool: (r.pool as string) ?? null,
    dex: (r.dex as string) ?? null,
    name: String(r.name ?? r.symbol ?? ""),
    symbol: String(r.symbol ?? ""),
    image: typeof r.image === "string" && r.image.startsWith("https://") ? r.image : null,
    priceUsd: n(r.price_usd),
    // Market cap when it's known, otherwise the fully diluted value.
    mcapUsd: pos(r.mcap_usd) ?? pos(r.fdv_usd),
    liqUsd: n(r.liq_usd),
    vol24h: n(r.vol_24h),
    change1h: n(r.change_1h),
    change24h: n(r.change_24h),
    buys24h: n(r.buys_24h),
    sells24h: n(r.sells_24h),
    poolCreated: (r.pool_created as string) ?? null,
    trendingRank: n(r.trending_rank),
    checkedAt: (r.gp_checked_at as string) ?? null,
    buyTax: n(r.gp_buy_tax),
    sellTax: n(r.gp_sell_tax),
    mintable: typeof r.gp_mintable === "boolean" ? r.gp_mintable : null,
    top10: n(r.gp_top10),
    xHandle: typeof r.x_handle === "string" && /^[A-Za-z0-9_]{1,15}$/.test(r.x_handle) ? r.x_handle : null,
  };
}

export async function fetchExtCoins(
  sort: ExtSort,
  network: string | null,
  search = "",
  limit = 48,
  filters: { minVol?: number; minLiq?: number } = {}
): Promise<ExtCoin[]> {
  const s = search.replace(/[%,()]/g, "").trim();
  // Lists show coins trading right now; a search looks through the last 30 days.
  let q = db.from(s ? "ext_coins_all" : "ext_coins").select("*");
  if (network) q = q.eq("network", network);
  if (filters.minVol && filters.minVol > 0) q = q.gte("vol_24h", filters.minVol);
  if (filters.minLiq && filters.minLiq > 0) q = q.gte("liq_usd", filters.minLiq);
  if (s) q = /^0x[0-9a-fA-F]{40}$/.test(s) ? q.eq("address", s.toLowerCase()) : q.or(`symbol.ilike.%${s}%,name.ilike.%${s}%`);
  q =
    sort === "new"
      ? q.order("pool_created", { ascending: false, nullsFirst: false })
      : sort === "gainers"
        ? q.order("change_24h", { ascending: false, nullsFirst: false })
        : sort === "losers"
          ? q.order("change_24h", { ascending: true, nullsFirst: false })
          : sort === "volume"
            ? q.order("vol_24h", { ascending: false, nullsFirst: false })
          : q.order("trending_rank", { ascending: true, nullsFirst: false }).order("vol_24h", { ascending: false });
  const { data, error } = await q.limit(Math.min(Math.max(1, limit), 500));
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(toExt);
}

export async function fetchExtCoin(network: string, address: string): Promise<ExtCoin | null> {
  const { data, error } = await db.from("ext_coins_all").select("*").eq("network", network).eq("address", address.toLowerCase()).maybeSingle();
  if (error) throw error;
  return data ? toExt(data as Record<string, unknown>) : null;
}

export const extHref = (c: { network: string; address: string }) => `/x/?n=${encodeURIComponent(c.network)}&a=${c.address}`;

export { compactUsd as money } from "./format";

export function price(v: number | null): string {
  if (v === null) return "—";
  if (v >= 1) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  // Small prices: keep 3 significant digits, never scientific notation.
  const d = Math.min(12, Math.max(2, -Math.floor(Math.log10(v)) + 2));
  return `$${v.toFixed(d)}`;
}

/** How many coins from other DEXs can be traded right now. */
export async function fetchExtCount(): Promise<number | null> {
  const { count, error } = await db.from("ext_coins").select("address", { count: "exact", head: true });
  return error ? null : count ?? null;
}
