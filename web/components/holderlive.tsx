"use client";

/**
 * Holders now and the change over the last 15 minutes: green ▲ when more wallets hold the coin,
 * red ▼ when fewer. A short flash when the number moves. Data: lib/holderlive.ts.
 */
import { useEffect, useRef, useState } from "react";
import { compactCount, fetchHolderLive, type HolderLive } from "@/lib/holderlive";

/** The holder count with its 15-minute change, inline (cards, facts). */
export function HolderCount({ live, compact = false }: { live: HolderLive | undefined; compact?: boolean }) {
  const prev = useRef<number | null>(null);
  const [flash, setFlash] = useState("");
  useEffect(() => {
    if (!live) return;
    if (prev.current !== null && live.holders !== prev.current) {
      setFlash(live.holders > prev.current ? "flash-up" : "flash-down");
      const t = setTimeout(() => setFlash(""), 900);
      prev.current = live.holders;
      return () => clearTimeout(t);
    }
    prev.current = live.holders;
  }, [live]);
  if (!live) return null;
  const ch = live.change;
  return (
    <span className={"inline-flex items-baseline gap-1 rounded px-0.5 whitespace-nowrap " + flash} title="Holders, and the change in the last 15 minutes">
      <span>{compact ? compactCount(live.holders) : live.holders.toLocaleString("en-US")}</span>
      {!compact && <span className="text-ink-3"> holders</span>}
      {ch !== null && ch !== 0 && (
        <span className={ch > 0 ? "text-up font-semibold" : "text-danger font-semibold"}>
          {ch > 0 ? "▲" : "▼"}
          {Math.abs(ch).toLocaleString("en-US")}
        </span>
      )}
    </span>
  );
}

/** A coin page's own holder count, refreshed every 30 seconds. */
export function useHolderLive(key: string | null): HolderLive | undefined {
  const [live, setLive] = useState<HolderLive | undefined>(undefined);
  useEffect(() => {
    setLive(undefined);
    if (!key) return;
    let alive = true;
    const load = () =>
      fetchHolderLive([key])
        .then((m) => alive && setLive(m.get(key)))
        .catch(() => {});
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [key]);
  return live;
}

/** For a coin page: a small box "Holders 1,234 ▲12 in 15 min". Hidden until there is a count. */
export function HolderBox({ holderKey }: { holderKey: string | null }) {
  const live = useHolderLive(holderKey);
  if (!live) return null;
  const ch = live.change;
  return (
    <div className="rounded-2xl border border-line px-4 py-3 flex items-center justify-between gap-3 min-w-0">
      <div className="min-w-0">
        <div className="text-[0.8125rem] text-ink-3">Holders</div>
        <div className="text-[1.25rem] font-bold tabular-nums font-mono">
          <HolderCount live={live} compact={false} />
        </div>
      </div>
      <div className="text-right text-[0.8125rem] shrink-0">
        {ch === null ? (
          <span className="text-ink-3">Tracking…</span>
        ) : ch === 0 ? (
          <span className="text-ink-3">No change in 15 min</span>
        ) : (
          <span className={ch > 0 ? "text-up font-semibold" : "text-danger font-semibold"}>
            {ch > 0 ? `+${ch.toLocaleString("en-US")} new` : `${ch.toLocaleString("en-US")} left`} in 15 min
          </span>
        )}
      </div>
    </div>
  );
}
