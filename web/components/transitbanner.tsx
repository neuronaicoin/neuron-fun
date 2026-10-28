"use client";

/**
 * "Your money is on its way": a clear card while money moves between Cash, Futures and Solana
 * (lib/transit.ts). The total already counts it; this says so in words, with how long it
 * usually takes, so nobody thinks it's gone. Hides by itself when it lands.
 */
import { useEffect, useState } from "react";
import { onTransit, transitList, type TransitEntry } from "@/lib/transit";
import { money } from "@/lib/portfolio";

const WHERE: Record<NonNullable<TransitEntry["to"]>, string> = { cash: "your Cash", futures: "your Futures balance", coin: "your coin" };

export function TransitBanner({ className = "" }: { className?: string }) {
  const [list, setList] = useState<TransitEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const read = () => setList(transitList());
    read();
    const off = onTransit(read);
    const t = setInterval(() => {
      setNow(Date.now());
      read();
    }, 1000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);
  if (!list.length) return null;
  return (
    <div className={"flex flex-col gap-2 " + className} role="status" aria-live="polite">
      {list.map((e) => {
        const took = Math.max(0, now - (e.at ?? now));
        const eta = e.etaMs ?? 60_000;
        const pct = Math.min(95, (took / eta) * 100);
        const left = Math.max(0, eta - took);
        const mins = Math.floor(took / 60_000);
        const secs = Math.floor((took % 60_000) / 1000);
        return (
          <div key={e.id} className="rounded-2xl border-2 border-emerald bg-emerald-soft px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="text-[1.5rem] shrink-0 animate-pulse" aria-hidden="true">
                💸
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-bold text-[0.9375rem]">
                  {money(e.usd)} on its way to {WHERE[e.to ?? "coin"]}
                </div>
                <div className="text-[0.8125rem] text-ink-2">
                  {left > 0 ? `Usually about ${Math.max(1, Math.round(eta / 60_000))} min` : "Almost there"} · {mins}:{String(secs).padStart(2, "0")} so far. It&apos;s safe and already counted in your total.
                </div>
              </div>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-paper overflow-hidden" aria-hidden="true">
              <div className="h-full rounded-full bg-emerald transition-[width] duration-1000" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
