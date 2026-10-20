"use client";

import { useEffect, useState } from "react";
import { RACE_SUPPLY, chainSupply, type RaceChain } from "./race";

/** Coins on one chain now (for its market cap), refreshed every minute. 1B until read. */
export function useChainSupply(chain: RaceChain | null | undefined, coin: string): number {
  const [v, setV] = useState(RACE_SUPPLY);
  const id = chain?.chainId ?? null;
  useEffect(() => {
    if (!chain) return;
    let alive = true;
    const load = () => chainSupply(chain, coin).then((s) => alive && setV(s));
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, coin]);
  return v;
}
