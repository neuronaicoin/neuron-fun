/**
 * Social layer on the client: profiles, follows, leaderboard, the Following
 * feed and buyer markers on the chart. Reads use the public database views;
 * writes go through /api/social with the alerts session (one free signature).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { IS_TESTNET, USD_MODE } from "./config";
import { db, fetchTrades, type Trade } from "./data";
import { ensureSession, type SignFn } from "./alerts";

export type Profile = {
  address: string;
  username: string | null;
  color: string;
  emoji: string;
  bio: string;
  hideTrades: boolean;
  followers: number;
  following: number;
  /** Uploaded profile picture (null: the sasa mark or an emoji on their color). */
  avatar: string | null;
  /** Lets followers copy their trades (copy.sql). */
  allowCopy: boolean;
  /** How many people copy them. */
  copiers: number;
};

export const COLORS = ["#ff6b1a", "#8a5cf6", "#2563eb", "#12b886", "#ef4444", "#f59e0b", "#ec4899", "#0ea5e9"];
export const EMOJIS = ["", "🙂", "🦦", "🐸", "🚀", "🔥", "👑", "💎", "🐋", "🐶", "🐱", "🦊", "🐼", "🦍", "🌙", "⚡"];

/** Leaderboard entry needs at least this much volume (in ETH) in the period. */
/**
 * Minimum volume to show on the leaderboard, in the database's units (raw amount / 1e18).
 * Dollar edition: USDC has 6 decimals, so $1 = 1e6 / 1e18 = 1e-12. ($1 on testnet, $100 on mainnet.)
 */
export const MIN_VOLUME_ETH = USD_MODE ? (IS_TESTNET ? 1 : 100) / 1e12 : IS_TESTNET ? 0.0005 : 0.4;

const EMPTY = (address: string): Profile => ({
  address,
  username: null,
  color: COLORS[parseInt(address.slice(2, 4) || "0", 16) % COLORS.length],
  emoji: "",
  bio: "",
  hideTrades: false,
  followers: 0,
  following: 0,
  avatar: null,
  allowCopy: false,
  copiers: 0,
});

type Row = {
  address: string;
  username: string | null;
  color: string;
  emoji: string;
  bio: string;
  hide_trades: boolean;
  followers: number;
  following: number;
  avatar_url?: string | null;
  allow_copy?: boolean;
  copiers?: number;
};
const toProfile = (r: Row): Profile => ({
  address: r.address,
  username: r.username,
  color: r.color,
  emoji: r.emoji,
  bio: r.bio,
  hideTrades: r.hide_trades,
  followers: r.followers,
  following: r.following,
  avatar: r.avatar_url ?? null,
  allowCopy: !!r.allow_copy,
  copiers: r.copiers ?? 0,
});

export const displayName = (p: Pick<Profile, "address" | "username">) =>
  p.username ? `@${p.username}` : `${p.address.slice(0, 6)}…${p.address.slice(-4)}`;
export const profileHref = (p: Pick<Profile, "address" | "username">) => `/u/${p.username ?? p.address}/`;

// ------------------------------------------------------------------ profile cache

const cache = new Map<string, Profile>();
const pending = new Map<string, Promise<void>>();

/** Profiles for many addresses at once (missing ones get a default look). */
export async function fetchProfiles(addresses: string[]): Promise<Map<string, Profile>> {
  const want = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  const missing = want.filter((a) => !cache.has(a) && !pending.has(a));
  if (missing.length) {
    const job = (async () => {
      for (let i = 0; i < missing.length; i += 100) {
        const part = missing.slice(i, i + 100);
        const { data } = await db.from("profiles_public").select("*").in("address", part);
        const found = new Map(((data ?? []) as Row[]).map((r) => [r.address, toProfile(r)]));
        for (const a of part) cache.set(a, found.get(a) ?? EMPTY(a));
      }
    })().finally(() => missing.forEach((a) => pending.delete(a)));
    missing.forEach((a) => pending.set(a, job));
  }
  await Promise.all(want.map((a) => pending.get(a)).filter(Boolean));
  return new Map(want.map((a) => [a, cache.get(a) ?? EMPTY(a)]));
}

/** "/u/otterdad/" or "/u/0x…/" → profile (null if the username doesn't exist). */
export async function fetchProfile(nameOrAddress: string): Promise<Profile | null> {
  const key = nameOrAddress.toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(key)) {
    cache.delete(key);
    return (await fetchProfiles([key])).get(key) ?? null;
  }
  if (!/^[a-z0-9_]{3,20}$/.test(key)) return null;
  const { data } = await db.from("profiles_public").select("*").eq("username", key).limit(1);
  const r = (data ?? [])[0] as Row | undefined;
  if (!r) return null;
  const p = toProfile(r);
  cache.set(p.address, p);
  return p;
}

export function useProfiles(addresses: string[]): Map<string, Profile> {
  const key = [...new Set(addresses.map((a) => a.toLowerCase()))].sort().join(",");
  const [map, setMap] = useState<Map<string, Profile>>(new Map());
  useEffect(() => {
    let alive = true;
    if (!key) return;
    fetchProfiles(key.split(",")).then((m) => alive && setMap(m));
    return () => {
      alive = false;
    };
  }, [key]);
  return map;
}

// ------------------------------------------------------------------ who I follow

type FollowState = { me: string | null; set: Set<string> };
let follow: FollowState = { me: null, set: new Set() };
const followListeners = new Set<() => void>();
const SERVER_FOLLOW = follow;
function setFollow(f: FollowState) {
  follow = f;
  followListeners.forEach((l) => l());
}
export function useFollowing(): FollowState {
  return useSyncExternalStore(
    (l) => {
      followListeners.add(l);
      return () => followListeners.delete(l);
    },
    () => follow,
    () => SERVER_FOLLOW
  );
}

export async function loadFollowing(me: string | null) {
  const a = me ? me.toLowerCase() : null;
  if (!a) return setFollow({ me: null, set: new Set() });
  if (follow.me !== a) setFollow({ me: a, set: new Set() });
  const { data } = await db.from("follows_public").select("followee").eq("follower", a).limit(1000);
  if (follow.me === a) setFollow({ me: a, set: new Set(((data ?? []) as { followee: string }[]).map((r) => r.followee)) });
}

export async function socialApi<T>(path: string, body: unknown): Promise<T> {
  const addr = follow.me;
  const raw = addr ? localStorage.getItem(`sasa-session:${addr}`) : null;
  const token = raw ? (JSON.parse(raw) as { token?: string }).token : null;
  if (!token) throw new Error("Please sign in again.");
  const r = await fetch(`/api/social/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (r.status === 401) {
    localStorage.removeItem(`sasa-session:${addr}`);
    throw new Error("Please sign in again.");
  }
  if (!r.ok) throw new Error(j.error ?? "Something went wrong. Try again.");
  return j;
}

export async function setFollowing(sign: SignFn, address: string, on: boolean) {
  await ensureSession(sign);
  const a = address.toLowerCase();
  const next = new Set(follow.set);
  if (on) next.add(a);
  else next.delete(a);
  setFollow({ ...follow, set: next });
  try {
    await socialApi("follow", { address: a, follow: on });
    const c = cache.get(a);
    if (c) cache.set(a, { ...c, followers: Math.max(0, c.followers + (on ? 1 : -1)) });
  } catch (e) {
    const back = new Set(follow.set);
    if (on) back.delete(a);
    else back.add(a);
    setFollow({ ...follow, set: back });
    throw e;
  }
}

/** Forgets a cached profile (after changing it). */
export function forgetProfile(address: string) {
  cache.delete(address.toLowerCase());
}

/** Uploads a profile picture (a data: URL, already resized) or removes it (null). */
export async function saveAvatar(sign: SignFn, image: string | null): Promise<string | null> {
  await ensureSession(sign);
  const j = await socialApi<{ avatar: string | null }>("avatar", { image });
  if (follow.me) cache.delete(follow.me);
  return j.avatar;
}

export async function reportAvatar(sign: SignFn, address: string): Promise<boolean> {
  await ensureSession(sign);
  const j = await socialApi<{ removed?: boolean }>("avatar-report", { address });
  cache.delete(address.toLowerCase());
  return !!j.removed;
}

export async function saveProfile(
  sign: SignFn,
  p: { username: string; color: string; emoji: string; bio: string; hideTrades: boolean }
): Promise<void> {
  await ensureSession(sign);
  await socialApi("profile", p);
  if (follow.me) cache.delete(follow.me);
}

// ------------------------------------------------------------------ numbers

export type TraderStats = { trader: string; realized: number; volume: number; trades: number; wins: number; closed: number; quickSells: number; sells: number };
type StatRow = { trader: string; realized: string; volume: string; trades: number; wins: number; closed: number; quick_sells: number; sells: number };
const toStats = (r: StatRow): TraderStats => ({
  trader: r.trader,
  realized: Number(r.realized),
  volume: Number(r.volume),
  trades: r.trades,
  wins: r.wins,
  closed: r.closed,
  quickSells: r.quick_sells,
  sells: r.sells,
});

export type Period = "d" | "w" | "a";
const since = (p: Period) => (p === "a" ? "2000-01-01T00:00:00Z" : new Date(Date.now() - (p === "d" ? 1 : 7) * 86400e3).toISOString());

export async function fetchLeaderboard(p: Period): Promise<TraderStats[]> {
  const { data, error } = await db.rpc("leaderboard", { p_since: since(p), p_min_volume: MIN_VOLUME_ETH, p_limit: 50 });
  if (error) throw error;
  return ((data ?? []) as StatRow[]).map(toStats);
}

export async function fetchTraderStats(address: string, p: Period): Promise<TraderStats | null> {
  const { data, error } = await db.rpc("trader_stats", { p_since: since(p), p_traders: [address.toLowerCase()] });
  if (error) throw error;
  const r = ((data ?? []) as StatRow[])[0];
  return r ? toStats(r) : null;
}

/** Often sells within 5 minutes of buying. */
export const isQuickSeller = (s: TraderStats | null) => !!s && s.sells >= 5 && s.quickSells / s.sells > 0.5;
export const winRate = (s: TraderStats | null) => (s && s.closed > 0 ? s.wins / s.closed : null);

/** Latest trades by the people I follow (hidden profiles left out). */
export async function fetchFeed(followees: string[], limit = 50): Promise<Trade[]> {
  if (!followees.length) return [];
  const profiles = await fetchProfiles(followees);
  const visible = followees.filter((a) => !profiles.get(a)?.hideTrades);
  if (!visible.length) return [];
  const { data, error } = await db
    .from("trades")
    .select("chain_id,tx_hash,ts,coin_id,curve,trader,is_buy,native_amount,token_amount,price")
    .in("trader", visible)
    .order("ts", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    chainId: r.chain_id as number,
    txHash: r.tx_hash as string,
    ts: r.ts as string,
    coinId: r.coin_id as string,
    curve: r.curve as string,
    trader: r.trader as string,
    isBuy: r.is_buy as boolean,
    nativeAmount: Number(r.native_amount),
    tokenAmount: Number(r.token_amount),
    price: Number(r.price),
  }));
}

// ------------------------------------------------------------------ chart markers

export type BuyerMarker = { time: number; label: string; color: string; followed: boolean };

/** Buys on this curve by people I follow, and big buys by anyone. */
export function useBuyerMarkers(coinId: string, curve: string | null, ethUsd: number | null): BuyerMarker[] {
  const { set } = useFollowing();
  const [markers, setMarkers] = useState<BuyerMarker[]>([]);
  const bigUsd = IS_TESTNET ? 1 : 500;
  const followKey = [...set].sort().join(",");
  useEffect(() => {
    let alive = true;
    if (!curve) return;
    (async () => {
      const trades = (await fetchTrades({ coinId, limit: 300 })).filter((t) => t.isBuy && t.curve.toLowerCase() === curve.toLowerCase());
      const picked = trades.filter((t) => set.has(t.trader.toLowerCase()) || (ethUsd !== null && (t.nativeAmount / 1e18) * ethUsd >= bigUsd));
      const profiles = await fetchProfiles(picked.map((t) => t.trader));
      const out = picked.map((t) => {
        const p = profiles.get(t.trader.toLowerCase());
        const followed = set.has(t.trader.toLowerCase());
        const amount = ethUsd !== null ? `$${((t.nativeAmount / 1e18) * ethUsd).toFixed(0)}` : "";
        return {
          time: Math.floor(Date.parse(t.ts) / 1000),
          label: `${p ? displayName(p) : t.trader.slice(0, 6)} ${amount}`.trim(),
          color: followed ? (p?.color ?? "#ff6b1a") : "#64748b",
          followed,
        };
      });
      if (alive) setMarkers(out);
    })().catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coinId, curve, ethUsd, followKey]);
  return markers;
}
