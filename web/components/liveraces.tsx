"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { CoinAvatar } from "@/components/coins";
import { compactUsd } from "@/lib/format";
import { RACE_CHAINS, clock, fetchRaceCoins, laneUsd, raceHref, racePhase, type RaceCoin } from "@/lib/race";

/**
 * Row of the newest races at the top of Explore: live ones with their clock, finished ones
 * with the winner. Shows `fallback` (the "coming soon" banner) while there are none.
 * It only adds this row; the Explore list below is not touched.
 */
export function LiveRaces({ fallback }: { fallback?: ReactNode }) {
  const [races, setRaces] = useState<RaceCoin[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!RACE_CHAINS.length) return;
    let alive = true;
    const load = () =>
      fetchRaceCoins(12)
        .then((r) => alive && setRaces(r))
        .catch(() => alive && setRaces((cur) => cur ?? []));
    load();
    const t = setInterval(load, 10_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(tick);
    };
  }, []);

  if (!RACE_CHAINS.length || races === null || races.length === 0) return <>{fallback}</>;
  const live = races.filter((r) => racePhase(r, now) !== "decided").length;

  return (
    <section className="px-4 sm:px-6 pt-4 sm:pt-6 flex flex-col gap-3 min-w-0" aria-label="Races">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[1.125rem] sm:text-[1.25rem] font-bold tracking-tight">Races</h2>
        {live > 0 && (
          <span className="inline-flex items-center gap-1.5 text-[0.8125rem] font-semibold text-emerald-dark">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald animate-pulse" />
            {live} live
          </span>
        )}
        <Link href="/race/launch/" className="ml-auto text-[0.875rem] font-semibold text-emerald-dark shrink-0">
          Launch a race →
        </Link>
      </div>
      <div className="flex gap-3 overflow-x-auto no-scrollbar -mx-4 px-4 sm:mx-0 sm:px-0 pb-1 snap-x">
        {races.map((r) => (
          <RaceCard key={r.id} race={r} now={now} />
        ))}
      </div>
    </section>
  );
}

function RaceCard({ race, now }: { race: RaceCoin; now: number }) {
  const phase = racePhase(race, now);
  const max = Math.max(1, ...race.lanes.map(laneUsd));
  const total = race.totalUsd ?? race.lanes.reduce((s, l) => s + laneUsd(l), 0);
  return (
    <Link
      href={raceHref(race.id)}
      className="snap-start shrink-0 w-[15.5rem] sm:w-[17rem] rounded-2xl border border-line bg-surface p-3.5 flex flex-col gap-3 hover:border-ink-3 transition-colors"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <CoinAvatar logo={race.logo} symbol={race.symbol} size={40} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-[0.9375rem] truncate">{race.name}</div>
          <div className="text-[0.75rem] text-ink-3 truncate">
            {race.symbol} · {compactUsd(total)}
          </div>
        </div>
        {phase === "racing" ? (
          <span className="shrink-0 text-[0.75rem] font-bold tabular-nums text-emerald-dark">{clock(race.endsAt - now)}</span>
        ) : race.winner ? (
          <span className="shrink-0 text-[0.6875rem] font-bold text-white rounded-full px-2 py-0.5" style={{ background: race.winner.color }}>
            {race.winner.short}
          </span>
        ) : (
          <span className="shrink-0 text-[0.6875rem] font-semibold text-ink-3">Counting</span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {race.lanes.map((l) => (
          <div key={l.chain.chainId} className="grid grid-cols-[4.25rem_minmax(0,1fr)] gap-2 items-center">
            <span className={"text-[0.6875rem] truncate " + (l.state === 3 ? "text-ink-3" : "text-ink-2")}>{l.chain.short}</span>
            <div className="h-1.5 bg-night rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-[width] duration-700"
                style={{ width: `${Math.max(3, Math.round((laneUsd(l) / max) * 100))}%`, background: l.chain.color, opacity: l.state === 3 ? 0.35 : 1 }}
              />
            </div>
          </div>
        ))}
      </div>
    </Link>
  );
}
