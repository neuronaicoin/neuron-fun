"use client";

/**
 * "Can you sell it?": a plain-words read of how deep the coin's pool is next to its market cap,
 * how much can be sold before the price drops 10%, and how far a $1K / $5K / $25K sell would
 * push it. Rough on purpose: it treats the pool as a full-range pool (x·y = k) holding `poolUsd`
 * of dollars on its dollar side, so concentrated pools are usually a little deeper than shown.
 */
import { useState } from "react";

const usd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`);

/** Price drop (0…1) after selling `s` dollars into a pool with `y` dollars on its dollar side. */
const dropAfter = (y: number, s: number) => 1 - (y / (y + s)) ** 2;
/** Dollars that can be sold before the price falls by `d` (0…1). */
const sellableFor = (y: number, d: number) => y * (1 / Math.sqrt(1 - d) - 1);

export function SellCheck({ poolUsd, mcap }: { poolUsd: number | null | undefined; mcap: number | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (!poolUsd || poolUsd <= 0 || !mcap || mcap <= 0) return null;
  const ratio = (poolUsd * 2) / mcap;
  const verdict =
    ratio >= 0.1
      ? { label: "Easy to sell", cls: "text-up", dot: "bg-up", note: "The pool is deep for a coin this size." }
      : ratio >= 0.03
        ? { label: "Careful", cls: "text-[#d97706]", dot: "bg-[#f59e0b]", note: "Bigger sells will move the price a lot." }
        : { label: "Hard to sell", cls: "text-danger", dot: "bg-danger", note: "The pool is thin next to the market cap: selling much at once drops the price hard." };
  const ten = sellableFor(poolUsd, 0.1);
  return (
    <section className="rounded-2xl border border-line bg-surface min-w-0" aria-label="Can you sell it?">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full flex items-center gap-3 px-3 sm:px-4 py-3 text-left">
        <span className={"w-2.5 h-2.5 rounded-full shrink-0 " + verdict.dot} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-[0.75rem] text-ink-3">Can you sell it?</span>
          <span className={"block font-bold text-[0.9375rem] " + verdict.cls}>{verdict.label}</span>
        </span>
        <span className="text-[0.8125rem] text-ink-3 shrink-0">
          ~{usd(ten)} before -10% <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </span>
      </button>
      {open && (
        <div className="px-3 sm:px-4 pb-3 text-[0.8125rem] flex flex-col gap-2">
          <p className="text-ink-2">
            {verdict.note} Pool: about {usd(poolUsd * 2)} next to a {usd(mcap)} market cap.
          </p>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[1_000, 5_000, 25_000].map((s) => (
              <div key={s} className="rounded-xl bg-paper border border-line px-1 py-2 min-w-0">
                <div className="text-[0.6875rem] text-ink-3">Sell {usd(s)}</div>
                <div className="font-mono font-semibold text-danger">-{Math.min(99, dropAfter(poolUsd, s) * 100).toFixed(1)}%</div>
              </div>
            ))}
          </div>
          <p className="text-[0.75rem] text-ink-3">Rough estimate from the pool size. Other trades at the same time change it.</p>
        </div>
      )}
    </section>
  );
}
