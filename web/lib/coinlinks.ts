"use client";

import { useEffect, useState } from "react";
import { db } from "./data";
import { authedPost, type SignFn } from "./alerts";

export type CoinLinks = { x: string | null; telegram: string | null; website: string | null };
export const NO_LINKS: CoinLinks = { x: null, telegram: null, website: null };

const cache = new Map<string, CoinLinks>();
const listeners = new Set<() => void>();

export async function fetchLinks(coinId: string): Promise<CoinLinks> {
  const { data, error } = await db.from("coin_links").select("x,telegram,website").eq("coin_id", coinId.toLowerCase()).maybeSingle();
  if (error) return cache.get(coinId) ?? NO_LINKS;
  const v = (data as CoinLinks | null) ?? NO_LINKS;
  cache.set(coinId, v);
  return v;
}

export async function saveLinks(sign: SignFn, coinId: string, links: Partial<CoinLinks>): Promise<CoinLinks> {
  const r = await authedPost<{ ok: boolean; links: CoinLinks }>(sign, "social/links", { coinId: coinId.toLowerCase(), ...links });
  cache.set(coinId, r.links);
  listeners.forEach((l) => l());
  return r.links;
}

/** A coin's links; updates right away when its creator edits them. */
export function useCoinLinks(coinId: string): CoinLinks | null {
  const [v, setV] = useState<CoinLinks | null>(cache.get(coinId) ?? null);
  useEffect(() => {
    let alive = true;
    fetchLinks(coinId)
      .then((l) => alive && setV(l))
      .catch(() => {});
    const l = () => alive && setV(cache.get(coinId) ?? NO_LINKS);
    listeners.add(l);
    return () => {
      alive = false;
      listeners.delete(l);
    };
  }, [coinId]);
  return v;
}
