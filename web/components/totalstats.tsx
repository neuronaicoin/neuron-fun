"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/coins";
import { compactUsd } from "@/lib/format";
import { IS_TESTNET } from "@/lib/config";
import { RACE_CHAINS, fetchRaceStats, type RaceStats } from "@/lib/race";
import { fetchExtStats, type ExtStats } from "@/lib/exttrades";

const CHAIN_NAME: Record<number, string> = { 8453: "Base", 56: "BNB Chain", 4663: "Robinhood", 5042: "Arc", 1: "Ethereum" };

/**
 * Everything traded on sasa: race coins plus other DEXs' coins bought and sold here (each of
 * those checked on chain before it counts). Mainnet only; the test version has no such trades.
 */
export function TotalStatsSection() {
  const [race, setRace] = useState<RaceStats | null>(null);
  const [ext, setExt] = useState<ExtStats | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (IS_TESTNET) return;
    let alive = true;
    const load = () => {
      if (RACE_CHAINS.length) fetchRaceStats().then((r) => alive && setRace(r)).catch(() => {});
      fetchExtStats()
        .then((r) => alive && (setExt(r), setError(false)))
        .catch(() => alive && setError(true));
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (IS_TESTNET) return null;
  const n = (v: number) => v.toLocaleString("en-US");
  const raceReady = !RACE_CHAINS.length || !!race;
  const r24 = race?.recent.volume ?? 0;
  const rAll = race?.all.volume ?? 0;
  const ready = ext && raceReady;
  const cards = [
    { label: "Volume, last 24h", value: ready ? compactUsd(r24 + ext.recent.volume) : null, sub: ready ? `${compactUsd(rAll + ext.all.volume)} all time` : "" },
    { label: "Race coins, 24h", value: ready ? compactUsd(r24) : null, sub: ready ? `${compactUsd(rAll)} all time` : "" },
    { label: "Other coins, 24h", value: ext ? compactUsd(ext.recent.volume) : null, sub: ext ? `${compactUsd(ext.all.volume)} all time` : "" },
    { label: "Other coin trades, 24h", value: ext ? n(ext.recent.trades) : null, sub: ext ? `${n(ext.recent.traders)} traders · ${n(ext.all.trades)} all time` : "" },
  ];
  const chains = ext?.chains.filter((c) => c.volume > 0) ?? [];
  const top = chains.reduce((a, c) => a + c.volume, 0);

  return (
    <section className="mt-5 flex flex-col gap-3" aria-label="All trading on sasa">
      <h2 className="font-display font-bold text-[1.25rem] sm:text-[1.5rem] tracking-tight">All trading</h2>
      {error && !ext && <p className="text-danger text-[0.875rem]">Could not load these numbers. Try again in a moment.</p>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((k) => (
          <div key={k.label} className="rounded-3xl border border-line bg-surface p-4 sm:p-5 min-w-0 overflow-hidden">
            <div className="text-[0.75rem] sm:text-[0.8125rem] text-ink-3 truncate">{k.label}</div>
            <div className="font-display font-bold text-[1.375rem] sm:text-[1.75rem] tabular-nums mt-1 truncate">{k.value ?? <Skeleton className="h-7 w-20" />}</div>
            <div className="text-[0.75rem] text-ink-3 mt-0.5 truncate">{k.sub}</div>
          </div>
        ))}
      </div>
      {chains.length > 0 && (
        <div className="rounded-3xl border border-line bg-surface p-4 sm:p-6 min-w-0">
          <h3 className="font-display font-bold text-[1.0625rem] sm:text-[1.1875rem]">Other coins by chain</h3>
          <p className="text-[0.8125rem] text-ink-3 mt-0.5">Coins from other DEXs bought and sold on sasa, all time.</p>
          <div className="mt-3 flex flex-col">
            {chains.map((c) => (
              <div key={c.chainId} className="flex items-center gap-3 py-2 border-b border-line last:border-0 text-[0.875rem]">
                <span className="font-semibold w-24 shrink-0 truncate">{CHAIN_NAME[c.chainId] ?? `Chain ${c.chainId}`}</span>
                <span className="flex-1 h-2 rounded-full bg-paper overflow-hidden">
                  <span className="block h-full bg-emerald" style={{ width: `${top > 0 ? Math.max(2, (c.volume / top) * 100) : 0}%` }} />
                </span>
                <span className="font-mono tabular-nums w-20 text-right">{compactUsd(c.volume)}</span>
                <span className="text-ink-3 text-[0.75rem] w-20 text-right hidden sm:inline">{n(c.trades)} trades</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
