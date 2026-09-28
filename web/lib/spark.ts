"use client";

import { useEffect, useMemo, useState } from "react";
import { db } from "./data";

/**
 * Mini price charts for coin cards: 24 prices over the last 4 hours per coin,
 * kept by the indexer in coin_spark (spark.sql). One query for all the coins
 * on screen, refreshed every minute.
 */
const cache = new Map<string, number[]>();
let version = 0;
const listeners = new Set<() => void>();

async function load(ids: string[]) {
  const need = ids.filter(Boolean);
  if (!need.length) return;
  for (let i = 0; i < need.length; i += 100) {
    const { data, error } = await db.from("coin_spark").select("coin_id,pts").in("coin_id", need.slice(i, i + 100));
    if (error) return; // table not there yet: cards simply show no chart
    for (const r of (data ?? []) as { coin_id: string; pts: number[] }[]) {
      if (Array.isArray(r.pts) && r.pts.length > 1) cache.set(r.coin_id, r.pts.map(Number));
    }
  }
  version++;
  listeners.forEach((l) => l());
}

export function useSparks(ids: string[]): Map<string, number[]> {
  const [, setV] = useState(version);
  const key = useMemo(() => [...new Set(ids)].sort().join(","), [ids]);
  useEffect(() => {
    const l = () => setV(version);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  useEffect(() => {
    if (!key) return;
    const list = key.split(",");
    void load(list).catch(() => {});
    const t = setInterval(() => void load(list).catch(() => {}), 60_000);
    return () => clearInterval(t);
  }, [key]);
  return cache;
}
