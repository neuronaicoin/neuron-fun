"use client";

/**
 * The same trading on every coin page, whatever its chain (sasa coins, race coins, other DEXs'
 * coins on Base, BNB Chain, Robinhood, Arc and Solana):
 *   phones   a Buy / Sell bar pinned above the menu; a tap opens the coin's trade box in a sheet
 *            on that side (the page itself never has to be scrolled to find it)
 *   desktop  the trade box in the right column (each page places it), this bar is hidden
 * Same look as components/mobiletrade.tsx (sasa's own coins).
 */
import { useEffect, useState, type ReactNode } from "react";
import { Sheet } from "./chrome";

export type TradeSide = "buy" | "sell";

export function TradeDock({ symbol, render, canBuy = true }: { symbol: string; render: (side: TradeSide) => ReactNode; canBuy?: boolean }) {
  const [side, setSide] = useState<TradeSide | null>(null);
  // someone copying the contract address is about to buy somewhere else: remind them it's one tap here
  const [hint, setHint] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = () => {
      if (!canBuy) return;
      setHint(true);
      if (t) clearTimeout(t);
      t = setTimeout(() => setHint(false), 7000);
    };
    window.addEventListener("sasa:ca-copied", on);
    return () => {
      window.removeEventListener("sasa:ca-copied", on);
      if (t) clearTimeout(t);
    };
  }, [canBuy]);
  // "…&buy=1" (from an alert's "Buy too") opens the Buy box right away on phones
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("buy") === "1" && window.matchMedia("(max-width: 1023px)").matches) setSide("buy");
  }, []);
  return (
    <>
      {/* keeps the last content clear of the pinned bar */}
      <div className="h-20 lg:hidden" aria-hidden="true" />
      <div className="lg:hidden fixed inset-x-0 z-30 px-3 pb-2 pt-2 bg-mist/95 backdrop-blur border-t border-line" style={{ bottom: "calc(58px + env(safe-area-inset-bottom, 0px))" }}>
        {hint && (
          <p className="max-w-lg mx-auto mb-2 rounded-xl bg-ink text-paper text-[0.8125rem] font-semibold px-3 py-2 text-center">
            Buy ${symbol} right here, no other app needed. Tap Buy.
          </p>
        )}
        <div className="grid grid-cols-2 gap-2 max-w-lg mx-auto">
          <button type="button" data-haptic-strong disabled={!canBuy} onClick={() => { setHint(false); setSide("buy"); }} className="btn-buy h-12 rounded-2xl text-[1rem] font-bold disabled:opacity-40">
            Buy
          </button>
          <button type="button" data-haptic-strong onClick={() => setSide("sell")} className="btn-sell h-12 rounded-2xl text-[1rem] font-bold">
            Sell
          </button>
        </div>
      </div>
      {side && (
        <Sheet title={`${side === "buy" ? "Buy" : "Sell"} $${symbol}`} onClose={() => setSide(null)}>
          {render(side)}
        </Sheet>
      )}
    </>
  );
}
