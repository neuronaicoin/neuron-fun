"use client";

import { useEffect, useState } from "react";
import { parseAbi, type Address } from "viem";
import { usdcAbi } from "./abis";
import { CHAINS, type NeuronChain } from "./config";
import { db } from "./data";
import { call, type Call } from "./tx";

/** Paid placement: $10 for 6 hours, $20 for 24 hours (SasaBoost plans 0 and 1). */
export const BOOST_PLANS = [
  { plan: 0, price: 10, hours: 6 },
  { plan: 1, price: 20, hours: 24 },
] as const;

const boostAbi = parseAbi(["function boost(address coin, uint256 plan) returns (uint64)"]);

/** The chain to pay a boost on: one with a Boost contract, the user's richest first. */
export function boostChains(): NeuronChain[] {
  return CHAINS.filter((c) => !!c.boost);
}
export const BOOST_ON = () => boostChains().length > 0;

export function boostCalls(chain: NeuronChain, coin: Address, plan: number): Call[] {
  const price = BigInt(BOOST_PLANS[plan].price) * 1_000_000n;
  return [call(chain.usdc, usdcAbi, "approve", [chain.boost!, price]), call(chain.boost!, boostAbi, "boost", [coin, BigInt(plan)])];
}

/** Coins boosted right now: sasa coin ids, latest end first. */
export async function fetchBoosted(): Promise<{ coinId: string; until: number }[]> {
  if (!BOOST_ON()) return [];
  const { data } = await db.from("boosted_coins").select("coin_id, until").order("until", { ascending: false }).limit(12);
  return ((data ?? []) as { coin_id: string; until: string }[]).map((r) => ({ coinId: r.coin_id, until: Date.parse(r.until) }));
}

/** When a coin's boost ends (ms), or null. */
export function useBoostedUntil(coinAddress: string | null): number | null {
  const [until, setUntil] = useState<number | null>(null);
  useEffect(() => {
    if (!coinAddress || !BOOST_ON()) return;
    let alive = true;
    const load = () =>
      db
        .from("coin_boost")
        .select("until")
        .eq("coin", coinAddress.toLowerCase())
        .maybeSingle()
        .then(({ data }) => alive && setUntil(data ? Date.parse((data as { until: string }).until) : null));
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [coinAddress]);
  return until && until > Date.now() ? until : null;
}

export function leftText(until: number): string {
  const m = Math.max(0, Math.round((until - Date.now()) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
}
