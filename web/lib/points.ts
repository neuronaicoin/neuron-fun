"use client";

import { useEffect, useState } from "react";
import { db } from "./data";
import { authedPost, type SignFn } from "./alerts";

export type MyPoints = {
  total: number;
  rank: number;
  players: number;
  today: number;
  streak: number;
  quests: string[];
  friends: number;
  friendsPts: number;
};
export type BoardRow = { owner: string; total: number; rank: number };
export type Rewards = { earned: number; paid: number; pending: number; friends: number; friendsTraded: number };

export const QUESTS = [
  { id: "launch", icon: "🚀", title: "Launch your first coin", note: "Any chain, any idea", pts: 200, href: "/create/" },
  { id: "ai", icon: "✨", title: "Create a coin with AI", note: "Try the AI designer once", pts: 100, href: "/create/?ai=1" },
  { id: "buy", icon: "🛒", title: "Make your first buy", note: "Any coin", pts: 50, href: "/explore/" },
  { id: "follow3", icon: "👥", title: "Follow 3 traders", note: "From Traders or a profile", pts: 50, href: "/traders/" },
  { id: "copy", icon: "🪞", title: "Copy a trader", note: "Turn copying on for someone", pts: 100, href: "/traders/" },
  { id: "alert", icon: "🔔", title: "Set a price alert", note: "Tap the bell on any coin", pts: 30, href: "/explore/" },
  { id: "forum", icon: "💬", title: "Post in a coin forum", note: "As a holder", pts: 50, href: "/forum/" },
  { id: "locked", icon: "🔒", title: "Launch with a creator lock", note: "1 hour or 24 hours", pts: 150, href: "/create/" },
] as const;

const n = (v: unknown) => Number(v ?? 0) || 0;

export async function fetchMyPoints(address: string): Promise<MyPoints | null> {
  const { data, error } = await db.rpc("points_me", { p_owner: address.toLowerCase() });
  if (error) throw error;
  const r = ((data ?? []) as Record<string, unknown>[])[0];
  if (!r) return null;
  return {
    total: n(r.total),
    rank: n(r.rank),
    players: n(r.players),
    today: n(r.today),
    streak: n(r.streak),
    quests: (r.quests as string[] | null) ?? [],
    friends: n(r.friends),
    friendsPts: n(r.friends_pts),
  };
}

export async function fetchBoard(limit = 50): Promise<BoardRow[]> {
  const { data, error } = await db.rpc("points_board", { p_limit: limit });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({ owner: String(r.owner), total: n(r.total), rank: n(r.rank) }));
}

/** Referral + copy rewards in wei, summed over chains. */
export async function fetchRewards(address: string): Promise<Rewards | null> {
  const { data, error } = await db.rpc("reward_summary", { p_owner: address.toLowerCase() });
  if (error) return null;
  const r = ((data ?? []) as Record<string, unknown>[])[0];
  if (!r) return null;
  return { earned: n(r.earned), paid: n(r.paid), pending: n(r.pending), friends: n(r.friends), friendsTraded: n(r.friends_traded) };
}

/** Streak boost for a day's trading points: 1x, growing to 2x at 7 days in a row. */
export const boostFor = (streak: number) => Math.min(2, 1 + Math.max(0, streak - 1) / 6);

// ------------------------------------------------------------------ invites

const REF_KEY = "sasa-ref";

/** Remembers an invite (?ref=) for 30 days, until the visitor is signed in. */
export function rememberRef() {
  try {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (ref && /^@?[a-zA-Z0-9_]{2,42}$/.test(ref)) {
      localStorage.setItem(REF_KEY, JSON.stringify({ ref: ref.replace(/^@/, ""), at: Date.now() }));
    }
  } catch {}
}

export function pendingRef(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(REF_KEY) ?? "null");
    if (!v || typeof v.ref !== "string" || Date.now() - v.at > 30 * 86400e3) return null;
    return v.ref;
  } catch {
    return null;
  }
}

export async function claimRef(sign: SignFn, ref: string): Promise<{ ok: boolean; reason?: string }> {
  const r = await authedPost<{ ok: boolean; reason?: string }>(sign, "social/referral", { ref });
  // Done either way: accepted, or it can never apply to this wallet.
  try {
    localStorage.removeItem(REF_KEY);
  } catch {}
  return r;
}

/** Your points total, for the header. Refreshes every 2 minutes. */
export function useMyTotal(address: string | null | undefined): number | null {
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    if (!address) {
      setTotal(null);
      return;
    }
    let alive = true;
    const load = () =>
      fetchMyPoints(address)
        .then((p) => alive && setTotal(p?.total ?? 0))
        .catch(() => {});
    load();
    const t = setInterval(load, 120_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [address]);
  return total;
}
