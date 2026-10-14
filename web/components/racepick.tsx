"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { postOnX } from "./share";
import { raceShareUrl } from "./raceshare";
import { racePhase, raceHref, type RaceCoin } from "@/lib/race";

/**
 * "Who wins?": pick the chain you think wins a live race. Just for fun: no points, no
 * prizes. The pick stays in this browser; when the race is decided it says whether it
 * was right, with a one-tap post. "Back your pick" opens the trade box on that chain.
 */
const key = (id: string) => `sasa-pick:${id.toLowerCase()}`;

export function usePick(coinId: string): [number | null, (chainId: number) => void] {
  const [pick, setPick] = useState<number | null>(null);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(key(coinId)));
      setPick(Number.isFinite(v) && v > 0 ? v : null);
    } catch {}
  }, [coinId]);
  const save = (chainId: number) => {
    setPick(chainId);
    try {
      localStorage.setItem(key(coinId), String(chainId));
    } catch {}
  };
  return [pick, save];
}

export function RacePick({ coin, now, onBack, compact = false }: { coin: RaceCoin; now: number; onBack?: (chainId: number) => void; compact?: boolean }) {
  const [pick, setPick] = usePick(coin.id);
  const phase = racePhase(coin, now);
  const open = coin.lanes.filter((l) => l.state !== 3);
  const picked = coin.lanes.find((l) => l.chain.chainId === pick) ?? null;

  // finished: say how the pick went
  if (phase === "decided") {
    if (!picked) return null;
    const won = coin.winner?.chainId === picked.chain.chainId;
    return (
      <section className={"rounded-2xl border p-4 flex flex-col gap-2 min-w-0 " + (won ? "border-emerald/50 bg-emerald-soft/40" : "border-line")}>
        <div className="font-bold text-[1rem]">
          {won ? `Your pick won ✓ ${picked.chain.short} took the race` : `${coin.winner ? coin.winner.short : "Another chain"} won. Your pick was ${picked.chain.short}.`}
        </div>
        {won && (
          <button
            type="button"
            onClick={() => postOnX(`called it: $${coin.symbol} won on ${picked.chain.short} 🏁`, raceShareUrl(coin.id), { symbol: coin.symbol, chains: [picked.chain.short] })}
            className="self-start h-9 px-4 rounded-full bg-ink text-mist font-semibold text-[0.8125rem]"
          >
            Post it on X
          </button>
        )}
      </section>
    );
  }
  if (phase !== "racing" || open.length < 2) return null;

  return (
    <section className="rounded-2xl border border-line p-4 flex flex-col gap-3 min-w-0">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className={compact ? "font-bold text-[0.9375rem]" : "text-[1.125rem] font-bold"}>
          {compact ? (
            <Link href={raceHref(coin.id)} className="hover:underline">
              {coin.name} <span className="text-ink-3 font-semibold">{coin.symbol}</span>
            </Link>
          ) : (
            "Who wins?"
          )}
        </h2>
        <span className="text-[0.75rem] text-ink-3">{picked ? `Your pick: ${picked.chain.short}` : "Just for fun, no points"}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {open.map((l) => (
          <button
            key={l.chain.chainId}
            type="button"
            onClick={() => setPick(l.chain.chainId)}
            aria-pressed={pick === l.chain.chainId}
            className={"h-10 rounded-xl border text-[0.875rem] font-semibold flex items-center justify-center gap-2 min-w-0 " + (pick === l.chain.chainId ? "border-ink ring-1 ring-ink" : "border-line text-ink-2")}
          >
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: l.chain.color }} />
            <span className="truncate">{l.chain.short}</span>
          </button>
        ))}
      </div>
      {picked && onBack && (
        <button type="button" onClick={() => onBack(picked.chain.chainId)} className="self-start text-[0.8125rem] font-semibold text-emerald-dark underline underline-offset-2">
          Back your pick: buy on {picked.chain.short}
        </button>
      )}
      {picked && !onBack && (
        <Link href={raceHref(coin.id)} className="self-start text-[0.8125rem] font-semibold text-emerald-dark underline underline-offset-2">
          Watch the race and back your pick
        </Link>
      )}
    </section>
  );
}
