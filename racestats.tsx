"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CoinAvatar, Skeleton } from "@/components/coins";
import { compactUsd } from "@/lib/format";
import { RACE_CHAINS, fetchRaceStats, raceHref, type RaceStatCoin, type RaceStats } from "@/lib/race";

/** The race part of the Stats page: last 24 hours, the chain league and the records. */
export function RaceStatsSection() {
  const [s, setS] = useState<RaceStats | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!RACE_CHAINS.length) return;
    let alive = true;
    const load = () =>
      fetchRaceStats()
        .then((r) => alive && (setS(r), setError(false)))
        .catch(() => alive && setError(true));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!RACE_CHAINS.length) return null;
  const n = (v: number) => v.toLocaleString("en-US");

  return (
    <section className="mt-5 flex flex-col gap-3" aria-label="Race stats">
      <h2 className="font-display font-bold text-[1.25rem] sm:text-[1.5rem] tracking-tight">Races</h2>
      {error && !s && <p className="text-danger text-[0.875rem]">Could not load race stats. Try again in a moment.</p>}

      {/* last 24 hours */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "Races, last 24h", value: s ? n(s.recent.races) : null, sub: s ? `${n(s.all.races)} all time` : "" },
          { label: "Volume, last 24h", value: s ? compactUsd(s.recent.volume) : null, sub: s ? `${compactUsd(s.all.volume)} all time` : "" },
          { label: "Trades, last 24h", value: s ? n(s.recent.trades) : null, sub: s ? `${n(s.all.trades)} all time` : "" },
          { label: "Traders, last 24h", value: s ? n(s.recent.traders) : null, sub: s ? `${n(s.recent.newTraders)} new` : "" },
        ].map((k) => (
          <div key={k.label} className="rounded-3xl border border-line bg-surface p-4 sm:p-5 min-w-0 overflow-hidden">
            <div className="text-[0.75rem] sm:text-[0.8125rem] text-ink-3 truncate">{k.label}</div>
            <div className="font-display font-bold text-[1.375rem] sm:text-[1.75rem] tabular-nums mt-1 truncate">{k.value ?? <Skeleton className="h-7 w-20" />}</div>
            <div className="text-[0.75rem] text-ink-3 mt-0.5 truncate">{k.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* chain league */}
        <div className="rounded-3xl border border-line bg-surface p-4 sm:p-6 min-w-0">
          <h3 className="font-display font-bold text-[1.0625rem] sm:text-[1.1875rem]">Chain league</h3>
          <p className="text-[0.8125rem] text-ink-3 mt-0.5">Which chain wins the races, all time.</p>
          <div className="mt-4 flex flex-col">
            <div className="grid grid-cols-[1.25rem_minmax(0,1fr)_2.75rem_3.5rem_3.25rem] sm:grid-cols-[1.5rem_minmax(0,1fr)_4rem_5rem_5rem] gap-2 text-[0.6875rem] sm:text-[0.75rem] text-ink-3 pb-2 border-b border-line">
              <span>#</span>
              <span>Chain</span>
              <span className="text-right">Wins</span>
              <span className="text-right">Volume</span>
              <span className="text-right">Traders</span>
            </div>
            {s
              ? s.league.map((l, i) => (
                  <div
                    key={l.chain.chainId}
                    className="grid grid-cols-[1.25rem_minmax(0,1fr)_2.75rem_3.5rem_3.25rem] sm:grid-cols-[1.5rem_minmax(0,1fr)_4rem_5rem_5rem] gap-2 items-center py-2.5 border-b border-line last:border-0 text-[0.8125rem] sm:text-[0.875rem]"
                  >
                    <span className="text-ink-3 tabular-nums">{i + 1}</span>
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: l.chain.color }} />
                      <span className="font-semibold truncate">{l.chain.short}</span>
                    </span>
                    <span className="text-right tabular-nums">
                      <b>{n(l.wins)}</b>
                      <span className="text-ink-3 hidden sm:inline">/{n(l.races)}</span>
                    </span>
                    <span className="text-right tabular-nums truncate">{l.volume > 0 ? compactUsd(l.volume) : "$0"}</span>
                    <span className="text-right tabular-nums">{n(l.traders)}</span>
                  </div>
                ))
              : RACE_CHAINS.map((c) => <Skeleton key={c.chainId} className="h-9 w-full mt-2" />)}
          </div>
        </div>

        {/* records */}
        <div className="rounded-3xl border border-line bg-surface p-4 sm:p-6 min-w-0">
          <h3 className="font-display font-bold text-[1.0625rem] sm:text-[1.1875rem]">Records</h3>
          <p className="text-[0.8125rem] text-ink-3 mt-0.5">The biggest moments so far.</p>
          <div className="mt-3 flex flex-col">
            <Record label="Biggest race" coin={s?.biggestRace} loading={!s} value={(c) => `${compactUsd(c.usd ?? 0)}${c.chain ? ` · won on ${c.chain.short}` : ""}`} />
            <Record label="Biggest single buy" coin={s?.biggestBuy} loading={!s} value={(c) => `${compactUsd(c.usd ?? 0)}${c.chain ? ` on ${c.chain.short}` : ""}`} />
            <Record label="Most traders in one race" coin={s?.mostTraders} loading={!s} value={(c) => `${n(c.traders ?? 0)} traders`} />
          </div>
        </div>
      </div>
    </section>
  );
}

function Record({ label, coin, loading, value }: { label: string; coin: RaceStatCoin | null | undefined; loading: boolean; value: (c: RaceStatCoin) => string }) {
  return (
    <div className="py-3 border-b border-line last:border-0 min-w-0">
      <div className="text-[0.75rem] text-ink-3">{label}</div>
      {loading ? (
        <Skeleton className="h-9 w-full mt-1.5" />
      ) : coin ? (
        <Link href={raceHref(coin.id)} className="mt-1.5 flex items-center gap-2.5 min-w-0 group">
          <CoinAvatar logo={coin.logo} symbol={coin.symbol} size={32} />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-[0.875rem] truncate group-hover:underline">{coin.name}</span>
            <span className="block text-[0.75rem] text-ink-2 truncate">{value(coin)}</span>
          </span>
        </Link>
      ) : (
        <div className="text-[0.875rem] text-ink-3 mt-1">Not yet. Could be yours.</div>
      )}
    </div>
  );
}
