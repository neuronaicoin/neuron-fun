/**
 * One fair ranking for coins launched on sasa and coins from every other DEX:
 * the same yardstick for both, so our own coins get no head start.
 *
 *   trending  24h trading volume in USD (what people are actually trading)
 *   gainers   biggest 24h rise, among coins with at least $10K volume
 *   losers    biggest 24h fall, same volume bar
 *   new       newest first (launch time / pool creation)
 */
import type { Coin, SortKey } from "./data";
import type { ExtCoin } from "./extcoins";

export type Ranked = { kind: "ours"; coin: Coin } | { kind: "ext"; coin: ExtCoin };

/** Tabs where both kinds compete on one list. The rest are about our curves only. */
export const MERGED_SORTS = new Set<SortKey>(["trending", "gainers", "losers", "new"]);

// Movers need real trading behind them, or a $50 buy on a tiny coin tops the list.
export const MIN_MOVER_VOLUME_USD = 10_000;

const oursVolume = (c: Coin, ethUsd: number | null) => (ethUsd ? c.volumeNative24h * ethUsd : 0);
// Our coins' change is a fraction (0.25), other DEXs' a percent (25): compare in percent.
const oursChange = (c: Coin) => (c.change24h === null ? null : c.change24h * 100);
const time = (s: string | null) => (s ? Date.parse(s) || 0 : 0);

export function rankMerged(ours: Coin[], ext: ExtCoin[], sort: SortKey, ethUsd: number | null): Ranked[] {
  const all: { r: Ranked; vol: number; change: number | null; t: number }[] = [
    ...ours.map((c) => ({ r: { kind: "ours" as const, coin: c }, vol: oursVolume(c, ethUsd), change: oursChange(c), t: time(c.createdAt) })),
    ...ext.map((c) => ({ r: { kind: "ext" as const, coin: c }, vol: c.vol24h ?? 0, change: c.change24h, t: time(c.poolCreated) })),
  ];
  let out = all;
  if (sort === "trending") out = [...all].sort((a, b) => b.vol - a.vol);
  else if (sort === "gainers")
    out = all.filter((x) => x.vol >= MIN_MOVER_VOLUME_USD && x.change !== null && x.change > 0).sort((a, b) => (b.change ?? 0) - (a.change ?? 0));
  else if (sort === "losers")
    out = all.filter((x) => x.vol >= MIN_MOVER_VOLUME_USD && x.change !== null && x.change < 0).sort((a, b) => (a.change ?? 0) - (b.change ?? 0));
  else if (sort === "new") out = [...all].sort((a, b) => b.t - a.t);
  return out.map((x) => x.r);
}
