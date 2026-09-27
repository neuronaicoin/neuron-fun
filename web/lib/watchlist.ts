"use client";

import { useEffect, useState } from "react";

/** Favourite coins, kept in this browser. */
const KEY = "sasa-watchlist";
const EVENT = "sasa:watchlist";

export function getWatchlist(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 200) : [];
  } catch {
    return [];
  }
}

export function toggleWatch(id: string): boolean {
  const list = getWatchlist();
  const on = !list.includes(id);
  const next = on ? [id, ...list] : list.filter((x) => x !== id);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  window.dispatchEvent(new Event(EVENT));
  return on;
}

/** The current favourites; updates everywhere when one is toggled. */
export function useWatchlist(): Set<string> {
  const [ids, setIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const read = () => setIds(new Set(getWatchlist()));
    read();
    window.addEventListener(EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return ids;
}
