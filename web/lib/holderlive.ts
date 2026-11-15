/**
 * Holder counts with their change over the last 15 minutes (indexer/holders.mjs → view
 * holder_live). Keys: "race:<coin id>" for sasa race coins, "<network>:<address>" for the rest
 * (EVM addresses lowercase, Solana as is).
 */
import { db } from "./data";

export type HolderLive = { holders: number; change: number | null };

export const raceHolderKey = (coinId: string) => `race:${coinId.toLowerCase()}`;
export const extHolderKey = (network: string, address: string) => `${network}:${network === "solana" ? address : address.toLowerCase()}`;

export async function fetchHolderLive(keys: string[]): Promise<Map<string, HolderLive>> {
  const out = new Map<string, HolderLive>();
  const uniq = [...new Set(keys)].filter(Boolean);
  for (let i = 0; i < uniq.length; i += 80) {
    const { data, error } = await db.from("holder_live").select("key,holders,change_15m").in("key", uniq.slice(i, i + 80));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { key: string; holders: number; change_15m: number | null }[])
      out.set(r.key, { holders: Number(r.holders), change: r.change_15m === null ? null : Number(r.change_15m) });
  }
  return out;
}

export const compactCount = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M` : n >= 1e4 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, "")}K` : n.toLocaleString("en-US");
