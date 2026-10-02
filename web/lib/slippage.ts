"use client";

import { useEffect, useState } from "react";
import { SLIPPAGE_BPS } from "./config";

/** Price-move limits a trader can pick (basis points): the trade is cancelled past it. */
export const SLIPPAGE_CHOICES = [100n, 300n, 500n, 1000n] as const;
const KEY = "sasa-slippage";
const EVENT = "sasa-slippage";

function read(): bigint {
  try {
    const v = BigInt(localStorage.getItem(KEY) ?? "");
    return SLIPPAGE_CHOICES.includes(v as (typeof SLIPPAGE_CHOICES)[number]) ? v : SLIPPAGE_BPS;
  } catch {
    return SLIPPAGE_BPS;
  }
}

/** The trader's price-move limit (remembered on this device), and a setter. */
export function useSlippage(): [bigint, (bps: bigint) => void] {
  const [bps, setBps] = useState<bigint>(SLIPPAGE_BPS);
  useEffect(() => {
    setBps(read());
    const on = () => setBps(read());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const set = (v: bigint) => {
    try {
      localStorage.setItem(KEY, v.toString());
    } catch {}
    setBps(v);
    window.dispatchEvent(new Event(EVENT));
  };
  return [bps, set];
}

export const slippagePct = (bps: bigint) => `${Number(bps) / 100}%`;
