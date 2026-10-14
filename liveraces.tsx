"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { CoinAvatar } from "@/components/coins";
import { compactUsd } from "@/lib/format";
import { RACE_CHAINS, clock, fetchRaceCoins, laneUsd, leadLane, raceHref, racePhase, type RaceCoin } from "@/lib/race";

/**
 * The race wall at the top of Explore: live races in big cards (every chain's money side by
 * side, the clock, who leads), then the races that just finished with their winner. Rows
 * scroll sideways, so the Explore list below keeps its layout. Shows `fallback` (the
 * "coming soon" banner) while there are no races.
 */
export function LiveRaces({ fallback }: { fallback?: ReactNode }) {
  const [races, setRaces] = useState<RaceCoin[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!RACE_CHAINS.length) return;
    let alive = true;
    const load = () =>
      fetchRaceCoins(18)
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
  const live = races.filter((r) => racePhase(r, now) !== "decided");
  const done = races.filter((r) => racePhase(r, now) === "decided").slice(0, 6);
  const liveUsd = live.reduce((s, r) => s + r.lanes.reduce((a, l) => a + laneUsd(l), 0), 0);

  return (
    <section className="px-4 sm:px-6 pt-4 sm:pt-6 flex flex-col gap-3 min-w-0" aria-label="Races">
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
        <h2 className="text-[1.125rem] sm:text-[1.25rem] font-bold tracking-tight">Races</h2>
        {live.length > 0 && (
          <span className="inline-flex items-center gap-1.5 text-[0.8125rem] font-semibold text-emerald-dark">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald animate-pulse" />
            {live.length} live · {compactUsd(liveUsd)} racing
          </span>
        )}
        <Link href="/race/launch/" className="ml-auto text-[0.875rem] font-semibold text-emerald-dark shrink-0">
          Launch a race →
        </Link>
      </div>

      {live.length > 0 && (
        <div className="flex gap-3 overflow-x-auto no-scrollbar -mx-4 px-4 sm:mx-0 sm:px-0 pb-1 snap-x">
          {live.map((r) => (
            <LiveCard key={r.id} race={r} now={now} />
          ))}
        </div>
      )}

      {done.length > 0 && (
        <>
          <h3 className="text-[0.8125rem] font-semibold text-ink-3 mt-1">Just finished</h3>
          <div className="flex gap-3 overflow-x-auto no-scrollbar -mx-4 px-4 sm:mx-0 sm:px-0 pb-1 snap-x">
            {done.map((r) => (
              <DoneCard key={r.id} race={r} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** A race still running: each chain's money as a bar with its dollar amount, the clock, the leader. */
function LiveCard({ race, now }: { race: RaceCoin; now: number }) {
  const phase = racePhase(race, now);
  const max = Math.max(1, ...race.lanes.map(laneUsd));
  const total = race.lanes.reduce((s, l) => s + laneUsd(l), 0);
  const buys = race.lanes.reduce((s, l) => s + l.buys, 0);
  const lead = leadLane(race);
  const leads = lead && laneUsd(lead) > 0 ? lead.chain.chainId : null;
  return (
    <Link
      href={raceHref(race.id)}
      className="snap-start shrink-0 w-[17.5rem] sm:w-[20rem] rounded-2xl border border-line bg-surface p-4 flex flex-col gap-3.5 hover:border-ink-3 transition-colors"
    >
      <div className="flex items-center gap-3 min-w-0">
        <CoinAvatar logo={race.logo} symbol={race.symbol} size={44} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-[1rem] truncate">{race.name}</div>
          <div className="text-[0.75rem] text-ink-3 truncate">{race.symbol}</div>
        </div>
        <div className="shrink-0 text-right">
          {phase === "racing" ? (
            <>
              <div className="font-mono text-[1.125rem] font-bold tabular-nums text-emerald-dark leading-none">{clock(race.endsAt - now)}</div>
              <div className="text-[0.625rem] text-ink-3 mt-1">left</div>
            </>
          ) : (
            <span className="text-[0.75rem] font-semibold text-ink-3">Counting…</span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {race.lanes.map((l) => {
          const out = l.state === 3;
          return (
            <div key={l.chain.chainId} className="grid grid-cols-[4.5rem_minmax(0,1fr)_3.25rem] gap-2 items-center">
              <span className={"text-[0.75rem] truncate " + (leads === l.chain.chainId ? "font-bold text-ink" : out ? "text-ink-3" : "text-ink-2")}>{l.chain.short}</span>
              <div className="h-2 bg-night rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-[width] duration-700"
                  style={{ width: `${Math.max(3, Math.round((laneUsd(l) / max) * 100))}%`, background: l.chain.color, opacity: out ? 0.35 : 1 }}
                />
              </div>
              <span className="text-[0.75rem] text-right tabular-nums text-ink-2 truncate">{compactUsd(laneUsd(l))}</span>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2 text-[0.75rem] text-ink-3 min-w-0">
        <span className="truncate">
          {compactUsd(total)} raised · {buys.toLocaleString("en-US")} {buys === 1 ? "buy" : "buys"}
        </span>
        <span className="shrink-0 font-semibold text-emerald-dark">Trade →</span>
      </div>
    </Link>
  );
}

/** A finished race: the winner and what the race raised in total. */
function DoneCard({ race }: { race: RaceCoin }) {
  const total = race.totalUsd ?? race.lanes.reduce((s, l) => s + laneUsd(l), 0);
  return (
    <Link
      href={raceHref(race.id)}
      className="snap-start shrink-0 w-[14rem] sm:w-[15rem] rounded-2xl border border-line bg-surface p-3 flex items-center gap-2.5 hover:border-ink-3 transition-colors min-w-0"
    >
      <CoinAvatar logo={race.logo} symbol={race.symbol} size={36} />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-[0.875rem] truncate">{race.name}</div>
        <div className="text-[0.75rem] text-ink-3 truncate">raised {compactUsd(total)}</div>
      </div>
      {race.winner ? (
        <span className="shrink-0 text-[0.6875rem] font-bold text-white rounded-full px-2 py-0.5" style={{ background: race.winner.color }}>
          🏆 {race.winner.short}
        </span>
      ) : (
        <span className="shrink-0 text-[0.6875rem] font-semibold text-ink-3">No winner</span>
      )}
    </Link>
  );
}
