"use client";

/**
 * Money on its way: between Base and Solana (a Solana buy or sale, the Cash-back helper) and
 * between Cash and Futures (Hyperliquid). For the seconds or minutes a bridge takes it is in
 * neither place, so without this the header total drops by that amount and comes back, and
 * people think their money is gone. Each entry counts in the total, and shows in the "on its
 * way" banner (components/transitbanner.tsx), until it lands:
 *   - toward a coin (a buy): until the trade code says it arrived (transitDone), or expiry
 *   - toward Cash: until Base cash reaches `cashAtLeast` (transitSettle), or expiry
 *   - toward Futures: until the futures balance reaches `futuresAtLeast`, or expiry
 * Kept on this device only (localStorage), so a reload mid-move still counts it.
 */
import type { Address } from "viem";
import { CHAINS } from "./config";
import { usdcAbi } from "./abis";
import { clientFor } from "./data";

export type TransitEntry = {
  id: string;
  usd: number;
  until: number;
  /** when it started, and roughly how long it takes (for the banner's progress) */
  at?: number;
  etaMs?: number;
  /** where it's going, for the banner: "cash", "futures" or "coin" */
  to?: "cash" | "futures" | "coin";
  cashAtLeast?: number;
  futuresAtLeast?: number;
};
type Entry = TransitEntry;
const K = "sasa.transit";

function read(): Entry[] {
  try {
    const v = JSON.parse(localStorage.getItem(K) ?? "[]");
    const now = Date.now();
    return Array.isArray(v) ? (v as Entry[]).filter((e) => e && e.until > now && Number.isFinite(e.usd) && e.usd > 0) : [];
  } catch {
    return [];
  }
}
function write(list: Entry[]) {
  try {
    if (list.length) localStorage.setItem(K, JSON.stringify(list));
    else localStorage.removeItem(K);
  } catch {}
}

/** Starts counting `usd` as on its way. Returns its id (for transitDone). */
export function transitAdd(usd: number, opts: { ms?: number; cashAtLeast?: number; futuresAtLeast?: number; to?: TransitEntry["to"]; etaMs?: number } = {}): string {
  const id = Math.random().toString(36).slice(2);
  if (!(usd > 0.01)) return id;
  const now = Date.now();
  write([
    ...read(),
    { id, usd, until: now + (opts.ms ?? 180_000), at: now, etaMs: opts.etaMs, to: opts.to ?? (opts.cashAtLeast !== undefined ? "cash" : opts.futuresAtLeast !== undefined ? "futures" : "coin"), cashAtLeast: opts.cashAtLeast, futuresAtLeast: opts.futuresAtLeast },
  ]);
  notify();
  return id;
}

/** Everything on its way right now (for the banner). */
export function transitList(): TransitEntry[] {
  return read();
}

const subs = new Set<() => void>();
function notify() {
  subs.forEach((f) => f());
}
/** Called whenever the list changes on this page (other tabs: the storage event). */
export function onTransit(f: () => void): () => void {
  subs.add(f);
  const st = (e: StorageEvent) => e.key === K && f();
  if (typeof window !== "undefined") window.addEventListener("storage", st);
  return () => {
    subs.delete(f);
    if (typeof window !== "undefined") window.removeEventListener("storage", st);
  };
}

/** It arrived (or failed and went back): stop counting it. */
export function transitDone(id: string) {
  write(read().filter((e) => e.id !== id));
  notify();
}

/** Moves toward Cash that Base cash shows as arrived stop counting. */
export function transitSettle(baseCashUsd: number, futuresUsd?: number) {
  const list = read();
  const left = list.filter(
    (e) => (e.cashAtLeast === undefined || baseCashUsd < e.cashAtLeast) && (e.futuresAtLeast === undefined || futuresUsd === undefined || futuresUsd < e.futuresAtLeast)
  );
  if (left.length !== list.length) {
    write(left);
    notify();
  }
}

/** Dollars on their way right now. */
export function transitUsd(): number {
  return read().reduce((a, e) => a + e.usd, 0);
}

/** USDC in Cash on Base right now, in dollars (null when the read fails). */
export async function baseCashUsd(evm: string): Promise<number | null> {
  const base = CHAINS.find((c) => c.key === "base");
  if (!base) return null;
  try {
    const raw = (await clientFor(base).readContract({ address: base.usdc, abi: usdcAbi, functionName: "balanceOf", args: [evm as Address] })) as bigint;
    return Number(raw) / 1e6;
  } catch {
    return null;
  }
}

/** A move to Cash just sent: counts until Base cash shows it (cash read before sending). */
export function transitToCash(usd: number, cashBefore: number | null, opts: { ms?: number; etaMs?: number } = {}) {
  // unknown starting cash: counted for a short while only
  if (cashBefore === null) transitAdd(usd, { ms: opts.ms ? Math.min(opts.ms, 300_000) : 60_000, to: "cash", etaMs: opts.etaMs });
  else transitAdd(usd, { cashAtLeast: cashBefore + usd * 0.9, ms: opts.ms, to: "cash", etaMs: opts.etaMs });
}
