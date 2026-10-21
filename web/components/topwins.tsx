"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/social";
import { CoinAvatar } from "@/components/coins";
import { fetchRaceCoins, raceHref } from "@/lib/race";
import { fetchWeekWins, type BigWin } from "@/lib/pnl";
import { displayName, useProfiles } from "@/lib/social";
import { gainLabel, signedUsd } from "@/components/holderspnl";

/** "Biggest wins this week": the wallets that made the most on one sasa coin in the last 7 days. */
export function TopWins() {
  const [wins, setWins] = useState<BigWin[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchRaceCoins(200)
        .then((coins) => fetchWeekWins(coins))
        .then((w) => alive && setWins(w))
        .catch(() => alive && setWins((prev) => prev ?? []));
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const profiles = useProfiles((wins ?? []).map((w) => w.trader));
  // still loading: keep its room (no jump); none this week: nothing
  if (wins === null) return <div className="h-[137px] sm:h-[153px]" aria-hidden="true" />;
  if (wins.length === 0) return null;

  return (
    <section aria-label="Biggest wins this week" className="px-4 sm:px-6 pt-4">
      <div className="flex items-baseline gap-2">
        <h2 className="font-display font-bold text-[1.0625rem]">Biggest wins this week</h2>
        <span className="text-[0.75rem] text-ink-3">on sasa coins</span>
      </div>
      <div className="mt-2.5 -mx-4 sm:mx-0 px-4 sm:px-0 flex gap-2.5 overflow-x-auto no-scrollbar snap-x">
        {wins.map((w, i) => {
          const p = profiles.get(w.trader) ?? { address: w.trader, username: null, color: "#e7e5e0", emoji: "", avatar: null };
          return (
            <Link
              key={w.trader}
              href={raceHref(w.coin.id)}
              className="snap-start shrink-0 w-[11.5rem] rounded-2xl border border-line bg-surface p-3 flex flex-col gap-2 hover:border-ink-3"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[0.75rem] font-bold text-ink-3 w-4 shrink-0">{i + 1}</span>
                <Avatar profile={p} size={24} />
                <span className="text-[0.8125rem] font-semibold truncate">{displayName(p)}</span>
              </div>
              <div className="flex items-end justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[1.25rem] font-extrabold tabular-nums text-up leading-tight">{signedUsd(w.pnl)}</div>
                  <div className="text-[0.75rem] text-ink-3 truncate">
                    on {w.coin.symbol} {w.pnlPct !== null && <b className="text-ink-2 font-semibold">{gainLabel(w.pnlPct)}</b>}
                  </div>
                </div>
                <CoinAvatar logo={w.coin.logo} symbol={w.coin.symbol} size={30} />
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
