"use client";
import { useEffect } from "react";

/**
 * "Buy $10" shortcuts: a button anywhere on a coin page opens the Buy box with the amount
 * already in it. The trade box that mounts next (the phone sheet) takes the pending amount;
 * one already on screen (desktop) hears the event.
 */
let pending: { usd: number; at: number } | null = null;

export function quickBuy(usd: number) {
  pending = { usd, at: Date.now() };
  window.dispatchEvent(new CustomEvent<number>("sasa:quickbuy", { detail: usd }));
}

/** The amount a quick-buy button just asked for ("" when none, or it's stale). */
export function takeQuickUsd(): string {
  if (!pending || Date.now() - pending.at > 4000) return "";
  return String(pending.usd);
}

export function useQuickBuy(onUsd: (usd: number) => void) {
  useEffect(() => {
    const h = (e: Event) => {
      const v = Number((e as CustomEvent<number>).detail);
      if (Number.isFinite(v) && v > 0) onUsd(v);
    };
    window.addEventListener("sasa:quickbuy", h);
    return () => window.removeEventListener("sasa:quickbuy", h);
  }, [onUsd]);
}
