"use client";

/**
 * Money on its way between Base and Solana (a Solana buy or sale, the Cash-back helper): for
 * the seconds a bridge takes it is in neither wallet, so without this the header total drops
 * by that amount and comes back. Each entry counts in the total until it lands:
 *   - toward a coin (a buy): until the trade code says it arrived (transitDone), or expiry
 *   - toward Cash (a sale): until Base cash reaches `cashAtLeast` (transitSettle), or expiry
 * Kept on this device only (localStorage), so a reload mid-move still counts it.
 */
import type { Address } from "viem";
import { CHAINS } from "./config";
import { usdcAbi } from "./abis";
import { clientFor } from "./data";

type Entry = { id: string; usd: number; until: number; cashAtLeast?: number };
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
export function transitAdd(usd: number, opts: { ms?: number; cashAtLeast?: number } = {}): string {
  const id = Math.random().toString(36).slice(2);
  if (!(usd > 0.01)) return id;
  write([...read(), { id, usd, until: Date.now() + (opts.ms ?? 180_000), cashAtLeast: opts.cashAtLeast }]);
  return id;
}

/** It arrived (or failed and went back): stop counting it. */
export function transitDone(id: string) {
  write(read().filter((e) => e.id !== id));
}

/** Moves toward Cash that Base cash shows as arrived stop counting. */
export function transitSettle(baseCashUsd: number) {
  const list = read();
  const left = list.filter((e) => e.cashAtLeast === undefined || baseCashUsd < e.cashAtLeast);
  if (left.length !== list.length) write(left);
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
export function transitToCash(usd: number, cashBefore: number | null) {
  // unknown starting cash: counted for a minute only (a Solana → Base move takes seconds)
  if (cashBefore === null) transitAdd(usd, { ms: 60_000 });
  else transitAdd(usd, { cashAtLeast: cashBefore + usd * 0.9 });
}
