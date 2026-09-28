"use client";

import { useEffect, useMemo, useState } from "react";
import { db } from "./data";

/**
 * Creator locks (v4 coins): until when the creator's coins can't be sold or
 * moved. Kept by the indexer in coin_lock (lock.sql). A coin launched on
 * several chains is locked on each; we show the earliest unlock (the moment
 * the creator could first sell anywhere).
 */
const cache = new Map<string, number>(); // coin id → unlock time (ms)
const asked = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

async function load(ids: string[]) {
  const need = ids.filter((id) => id && !asked.has(id));
  if (!need.length) return;
  need.forEach((id) => asked.add(id));
  for (let i = 0; i < need.length; i += 100) {
    const { data, error } = await db.from("coin_lock").select("coin_id,until").in("coin_id", need.slice(i, i + 100));
    if (error) {
      need.forEach((id) => asked.delete(id)); // table not there yet: try again later
      return;
    }
    for (const r of (data ?? []) as { coin_id: string; until: string }[]) {
      const t = new Date(r.until).getTime();
      const prev = cache.get(r.coin_id);
      cache.set(r.coin_id, prev === undefined ? t : Math.min(prev, t));
    }
  }
  version++;
  listeners.forEach((l) => l());
}

/** Unlock times (ms) for these coins; coins without a lock are absent. */
export function useLocks(ids: string[]): Map<string, number> {
  const [, setV] = useState(version);
  const key = useMemo(() => [...new Set(ids)].sort().join(","), [ids]);
  useEffect(() => {
    const l = () => setV(version);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  useEffect(() => {
    if (key) void load(key.split(",")).catch(() => {});
  }, [key]);
  return cache;
}

/** Unlock time for one coin (ms), or null when it has no lock. */
export async function fetchLock(coinId: string): Promise<number | null> {
  await load([coinId]).catch(() => {});
  return cache.get(coinId) ?? null;
}

/** "3h 12m", "45m", "30s": time left until `until` (ms). */
export function timeLeft(until: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((until - now) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Ticks every `ms` so countdowns stay live. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
