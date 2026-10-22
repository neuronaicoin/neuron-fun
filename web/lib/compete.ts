"use client";

import { db } from "./data";

/**
 * The creator competition: the creator whose coins (launched on sasa during the competition)
 * get the most volume from other traders wins. Only first place is paid.
 */
export const COMP = {
  from: "2026-10-23T00:00:00Z",
  to: "2026-11-22T00:00:00Z",
  /** the prize is this share of the winner's volume ... */
  rate: 0.0025,
  /** ... up to this */
  max: 10_000,
  /** below this volume there is no prize */
  min: 100_000,
} as const;

/** Prize steps shown on the page. */
export const STEPS = [100_000, 500_000, 1_000_000, 2_000_000, 4_000_000] as const;

export type CompRow = { creator: string; volume: number; coins: number; trades: number; rank: number };

export async function fetchCompBoard(limit = 100): Promise<CompRow[]> {
  const { data, error } = await db.rpc("comp_board", { p_from: COMP.from, p_to: COMP.to, p_limit: limit });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    creator: String(r.creator),
    volume: Number(r.volume_usd) || 0,
    coins: Number(r.coins) || 0,
    trades: Number(r.trades) || 0,
    rank: Number(r.rank) || 0,
  }));
}

/** What first place would win with this volume. */
export const prizeFor = (volume: number) => (volume < COMP.min ? 0 : Math.min(COMP.max, Math.floor(volume * COMP.rate)));
