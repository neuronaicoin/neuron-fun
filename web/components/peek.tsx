"use client";

import { useEffect, useState } from "react";
import { peekCoin, type CoinPeek } from "@/lib/coincache";
import { compactUsd } from "@/lib/format";

/**
 * A coin page while its data loads: if the list it came from already knew the coin,
 * its name, picture and market cap show at once (no blank page), with the rest shimmering.
 */
export function PeekLoading() {
  const [peek, setPeek] = useState<CoinPeek | null>(null);
  useEffect(() => {
    setPeek(peekCoin(window.location.pathname + window.location.search));
  }, []);
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-4 page-in" aria-busy="true">
      {peek ? (
        <div className="flex items-center gap-3">
          <span className="shrink-0 w-14 h-14 rounded-full overflow-hidden bg-night">
            {peek.image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={peek.image} alt="" className="w-full h-full object-cover" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <b className="block font-display font-bold text-[1.375rem] leading-tight truncate">{peek.name}</b>
            <span className="block text-[0.875rem] text-ink-3 truncate">
              {peek.symbol}
              {peek.where ? ` · ${peek.where}` : ""}
            </span>
          </span>
          <span className="shrink-0 text-right font-mono">
            <b className="block text-[1.25rem] tabular-nums">{compactUsd(peek.mc)}</b>
            <span className="block text-[0.75rem] text-ink-3">Market cap</span>
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <span className="shimmer shrink-0 w-14 h-14 rounded-full" />
          <span className="flex-1 grid gap-2">
            <span className="shimmer h-5 w-1/2 rounded" />
            <span className="shimmer h-3.5 w-1/3 rounded" />
          </span>
        </div>
      )}
      <div className="shimmer h-[280px] sm:h-[360px] rounded-2xl mt-4" />
      <div className="grid gap-2 mt-4">
        <span className="shimmer h-12 rounded-xl" />
        <span className="shimmer h-12 rounded-xl" />
      </div>
    </div>
  );
}
