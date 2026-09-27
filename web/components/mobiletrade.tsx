"use client";

import { useState } from "react";
import { Sheet } from "./chrome";
import { QuickTrade } from "./trade";
import type { Coin } from "@/lib/data";

/**
 * Phones only: Buy / Sell buttons pinned above the bottom menu. Tapping one
 * slides the trade box up from the bottom, so the chart stays in view.
 */
export function MobileTradeBar({ coin, ethUsd, onTraded }: { coin: Coin; ethUsd: number | null; onTraded: () => void }) {
  const [side, setSide] = useState<"buy" | "sell" | null>(null);
  const canBuy = coin.curves.some((c) => c.state === "trading" || c.state === "graduated");
  return (
    <>
      {/* Keeps the last content clear of the pinned bar. */}
      <div className="h-20 lg:hidden" aria-hidden="true" />
      <div
        className="lg:hidden fixed inset-x-0 z-30 px-3 pb-2 pt-2 bg-mist/95 backdrop-blur border-t border-line"
        style={{ bottom: "calc(58px + env(safe-area-inset-bottom, 0px))" }}
      >
        <div className="grid grid-cols-2 gap-2 max-w-lg mx-auto">
          <button
            type="button"
            disabled={!canBuy}
            onClick={() => setSide("buy")}
            className="h-12 rounded-2xl bg-up text-on-accent text-[1rem] font-bold disabled:opacity-40"
          >
            Buy
          </button>
          <button type="button" onClick={() => setSide("sell")} className="h-12 rounded-2xl bg-danger text-white text-[1rem] font-bold">
            Sell
          </button>
        </div>
      </div>
      {side && (
        <Sheet title={`${side === "buy" ? "Buy" : "Sell"} $${coin.symbol}`} onClose={() => setSide(null)}>
          <QuickTrade key={side} coin={coin} ethUsd={ethUsd} onTraded={onTraded} initialSide={side} bare />
        </Sheet>
      )}
    </>
  );
}
