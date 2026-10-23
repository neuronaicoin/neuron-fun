"use client";

/**
 * sasa accounts keep their money on Base. Dollars left on another chain (change from a cross-chain
 * trade, a refund) are sent back to Base on their own, in the background, so "Cash" is always
 * money that can be spent right away and nobody has to know which chain it sat on.
 *
 * Only for email (embedded) accounts, only while the page is open and visible, at most once per
 * chain every few minutes, and only amounts worth moving (Across's fee under a fifth of it). A
 * chain with nothing to pay the network fee there is skipped quietly.
 */
import { useEffect, useRef } from "react";
import type { Address } from "viem";
import { useWallet } from "./wallet";
import { RACE_CHAINS } from "@/lib/race";
import { crossReady, homeChain, pendingList, usdDecimals } from "@/lib/racecross";
import { crossSendHome, spareThere } from "@/lib/racecrossflow";
import { afterTrade } from "@/lib/portfolio";

const EVERY_MS = 3 * 60_000;
const FIRST_MS = 20_000;
const RETRY_MS = 15 * 60_000;
const MIN_USD = 1;
const KEY = "sasa:sweep:v1";

function lastTry(chainId: number): number {
  try {
    const m = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>;
    return m[String(chainId)] ?? 0;
  } catch {
    return 0;
  }
}
function markTry(chainId: number) {
  try {
    const m = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>;
    m[String(chainId)] = Date.now();
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {}
}

export function AutoSweep() {
  const w = useWallet();
  const running = useRef(false);
  const ready = !!w.address && w.embedded && !w.restoring;

  useEffect(() => {
    if (!ready) return;
    const home = homeChain();
    if (!home) return;
    const user = w.address as Address;
    let alive = true;

    const sweep = async () => {
      if (!alive || running.current || document.visibilityState !== "visible") return;
      running.current = true;
      try {
        for (const dest of RACE_CHAINS) {
          if (!alive || !crossReady(dest)) continue;
          if (Date.now() - lastTry(dest.chainId) < RETRY_MS) continue;
          // money already on its way from there, or a buy on its way to there: leave it alone
          const busy = pendingList().some(
            (p) => (p.kind === "home" && p.originChainId === dest.chainId) || (p.kind !== "home" && p.chainId === dest.chainId)
          );
          if (busy) continue;
          const spare = await spareThere(dest, user).catch(() => 0n);
          if (spare === 0n) continue;
          const dec = await usdDecimals(dest).catch(() => null);
          if (dec === null || Number(spare) / 10 ** dec < MIN_USD) continue;
          markTry(dest.chainId);
          try {
            // Across's fee at most a fifth of the amount, or it waits for more to gather
            const r = await crossSendHome({ s: { user, sendHome: w.send, sendThere: w.sendOwnGas }, home, dest, amount: spare, maxFeeBps: 2_000 });
            console.info(`[sasa] moved $${r.usdOut.toFixed(2)} from ${dest.short} to Base (fee $${r.feeUsd.toFixed(2)})`);
            afterTrade();
          } catch (e) {
            // no gas there, too little to move, a network hiccup: try again later, quietly
            console.info(`[sasa] left ${dest.short}'s dollars where they are for now: ${(e as Error)?.message ?? e}`);
          }
        }
      } finally {
        running.current = false;
      }
    };

    const first = setTimeout(() => void sweep(), FIRST_MS);
    const t = setInterval(() => void sweep(), EVERY_MS);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, w.address]);

  return null;
}
