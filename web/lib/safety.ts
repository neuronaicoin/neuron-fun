"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { safetyAbi } from "./abis";
import { CHAINS, type NeuronChain } from "./config";
import { clientFor, db } from "./data";

/** Beta safety state of one chain's live factory. */
export type Safety = {
  chainKey: string;
  paused: boolean;
  /** Most native coin the curves may hold together; 0n = no cap. */
  cap: bigint;
  total: bigint;
  /** Room left under the cap; null = no cap. */
  room: bigint | null;
  owner: Address;
  pendingOwner: Address;
  guardian: Address;
  coins: bigint;
};

export async function readSafety(chain: NeuronChain): Promise<Safety> {
  const pub = clientFor(chain);
  const r = (n: string) => pub.readContract({ address: chain.factory, abi: safetyAbi, functionName: n as never });
  const [paused, cap, total, owner, pendingOwner, guardian, coins] = await Promise.all([
    r("buysPaused") as Promise<boolean>,
    r("nativeCap") as Promise<bigint>,
    r("totalNative") as Promise<bigint>,
    r("owner") as Promise<Address>,
    r("pendingOwner") as Promise<Address>,
    r("guardian") as Promise<Address>,
    r("curveCount") as Promise<bigint>,
  ]);
  return {
    chainKey: chain.key,
    paused,
    cap,
    total,
    room: cap === 0n ? null : cap > total ? cap - total : 0n,
    owner,
    pendingOwner,
    guardian,
    coins,
  };
}

// One shared poll for the whole page, however many components ask. It reads
// the small chain_safety table the indexer keeps (safety.sql), so visitors
// never hit the chains for this.
type Listener = (s: Record<string, Safety>) => void;
let state: Record<string, Safety> = {};
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

type Row = { chain_id: number; factory: string; paused: boolean; cap: string; total: string; guardian: string; owner: string; updated_at: string };

export async function refreshSafety() {
  const { data } = await db.from("chain_safety").select("chain_id,factory,paused,cap,total,guardian,owner,updated_at");
  const next: Record<string, Safety> = {};
  for (const r of (data ?? []) as Row[]) {
    const chain = CHAINS.find((c) => c.chain.id === r.chain_id);
    // Only the live factory counts, and only fresh rows (indexer up).
    if (!chain || r.factory.toLowerCase() !== chain.factory.toLowerCase()) continue;
    if (Date.now() - new Date(r.updated_at).getTime() > 5 * 60_000) continue;
    const cap = BigInt(String(r.cap).split(".")[0]);
    const total = BigInt(String(r.total).split(".")[0]);
    next[chain.key] = {
      chainKey: chain.key,
      paused: r.paused,
      cap,
      total,
      room: cap === 0n ? null : cap > total ? cap - total : 0n,
      owner: (r.owner || ZERO) as Address,
      pendingOwner: ZERO,
      guardian: (r.guardian || ZERO) as Address,
      coins: 0n,
    };
  }
  state = next;
  listeners.forEach((l) => l(state));
}

/** Live safety state of every chain, refreshed every 20 seconds. */
export function useSafety(): Record<string, Safety> {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    if (!timer) {
      void refreshSafety().catch(() => {});
      timer = setInterval(() => void refreshSafety().catch(() => {}), 20_000);
    }
    return () => {
      listeners.delete(setS);
      if (!listeners.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return s;
}

/** Would a buy that puts `net` into this chain's curves go over the cap? */
export const overCap = (s: Safety | undefined, net: bigint) => !!s && s.room !== null && net > s.room;
