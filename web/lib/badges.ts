"use client";

/**
 * Trader badges, computed every few minutes by the indexer (trader_badges).
 * Read in batches and cached for a few minutes, so a list of 50 traders or
 * trades costs one small request.
 */
import { useEffect, useState } from "react";
import { db } from "./data";

export type BadgeId = "whale" | "pnl" | "creator" | "early" | "diamond" | "streak";

export const BADGES: Record<BadgeId, { label: string; about: string }> = {
  whale: { label: "Whale", about: "Top 5% of traders by 30-day trading volume" },
  pnl: { label: "Top PnL", about: "Top 10% of traders by 30-day realized profit" },
  creator: { label: "Creator", about: "Launched a coin that graduated" },
  early: { label: "Early", about: "Among the first 10 buyers of a coin" },
  diamond: { label: "Diamond", about: "Held a coin for 7+ days without selling" },
  streak: { label: "Streak", about: "Traded 7+ days in a row" },
};
export const BADGE_ORDER: BadgeId[] = ["whale", "pnl", "creator", "early", "diamond", "streak"];

const TTL = 5 * 60_000;
const cache = new Map<string, { at: number; badges: BadgeId[] }>();
const listeners = new Set<() => void>();
let queue = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  timer = null;
  const ask = [...queue];
  queue = new Set();
  for (let i = 0; i < ask.length; i += 100) {
    const part = ask.slice(i, i + 100);
    try {
      const { data, error } = await db.from("trader_badges").select("trader,badges").in("trader", part);
      if (error) throw error;
      const got = new Map(((data ?? []) as { trader: string; badges: string[] }[]).map((r) => [r.trader, r.badges]));
      const now = Date.now();
      for (const a of part) {
        const list = (got.get(a) ?? []).filter((b): b is BadgeId => b in BADGES);
        cache.set(a, { at: now, badges: list });
      }
    } catch {
      // Table not there yet, or offline: remember "none" for a minute and try later.
      const now = Date.now();
      for (const a of part) cache.set(a, { at: now - TTL + 60_000, badges: cache.get(a)?.badges ?? [] });
    }
  }
  listeners.forEach((l) => l());
}

function request(addresses: string[]) {
  const now = Date.now();
  let added = false;
  for (const raw of addresses) {
    const a = raw.toLowerCase();
    const hit = cache.get(a);
    if (hit && now - hit.at < TTL) continue;
    if (!queue.has(a)) {
      queue.add(a);
      added = true;
    }
  }
  if (added && !timer) timer = setTimeout(() => void flush(), 30);
}

/** Badges for one or more traders (lowercase addresses as keys). */
export function useBadges(addresses: string[]): Map<string, BadgeId[]> {
  const key = [...new Set(addresses.map((a) => a.toLowerCase()))].sort().join(",");
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  useEffect(() => {
    if (key) request(key.split(","));
  }, [key]);
  const out = new Map<string, BadgeId[]>();
  if (key) for (const a of key.split(",")) out.set(a, cache.get(a)?.badges ?? []);
  return out;
}
