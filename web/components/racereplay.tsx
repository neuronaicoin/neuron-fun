"use client";

import { useEffect, useRef, useState } from "react";
import { compactUsd } from "@/lib/format";
import { clock, fetchRaceFlow, laneUsd, type RaceCoin } from "@/lib/race";

const PLAY_MS = 10_000;

/**
 * Replay of a finished race: the five minutes in ten seconds. Each chain's bar follows the
 * buys and sells made on it, ending exactly at the money it reported for the verdict.
 */
export function RaceReplay({ coin }: { coin: RaceCoin }) {
  const [series, setSeries] = useState<{ ts: number[]; vals: number[][] } | null>(null);
  const [t, setT] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState(false);
  const raf = useRef(0);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  async function play() {
    setError(false);
    let s = series;
    if (!s) {
      try {
        const flow = await fetchRaceFlow(coin.id);
        const start = coin.launchedAt;
        const end = coin.endsAt;
        // net money in per lane over the race window, then shifted so it ends at the reported money
        const steps = 120;
        const ts = Array.from({ length: steps + 1 }, (_, i) => start + ((end - start) * i) / steps);
        const vals = coin.lanes.map((l) => {
          const mine = flow.filter((f) => f.chainId === l.chain.chainId && f.ts <= end);
          const net = ts.map((x) => mine.filter((f) => f.ts <= x).reduce((a, f) => a + f.usd, 0));
          const shift = laneUsd(l) - net[net.length - 1];
          return net.map((v) => Math.max(0, v + shift));
        });
        s = { ts, vals };
        setSeries(s);
      } catch {
        setError(true);
        return;
      }
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setT(1);
      return;
    }
    cancelAnimationFrame(raf.current);
    setPlaying(true);
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / PLAY_MS);
      setT(p);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    setT(0);
    raf.current = requestAnimationFrame(tick);
  }

  const idx = series ? Math.round(t * (series.ts.length - 1)) : 0;
  const now = series ? series.vals.map((v) => v[idx]) : coin.lanes.map(laneUsd);
  const max = Math.max(1, ...(series ? series.vals.flat() : now));
  const leader = now.indexOf(Math.max(...now));
  const left = series ? Math.max(0, coin.endsAt - series.ts[idx]) : 0;
  const done = !playing && t >= 1;

  return (
    <section className="rounded-2xl border border-line p-4 sm:p-5 flex flex-col gap-3 min-w-0" aria-label="Race replay">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-[1.125rem] font-bold">Race replay</h2>
        <div className="flex items-center gap-3">
          {series && <span className="font-mono text-[0.9375rem] font-bold tabular-nums">{clock(left)}</span>}
          <button type="button" onClick={() => void play()} disabled={playing} className="h-9 px-4 rounded-full bg-ink text-mist font-semibold text-[0.8125rem] disabled:opacity-60">
            {playing ? "Playing…" : series ? "▶ Play again" : "▶ Replay the race"}
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {coin.lanes.map((l, i) => {
          const won = done && coin.winner?.chainId === l.chain.chainId;
          return (
            <div key={l.chain.chainId} className="grid grid-cols-[5.5rem_minmax(0,1fr)_4.5rem] gap-2 items-center text-[0.8125rem] sm:text-[0.875rem]">
              <span className={"truncate " + (i === leader && series ? "font-bold" : "font-semibold")}>
                {l.chain.short}
                {won ? " 🏆" : ""}
              </span>
              <div className="h-2.5 bg-night rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.round((now[i] / max) * 100))}%`, background: l.chain.color }} />
              </div>
              <span className="tabular-nums text-right">{compactUsd(now[i])}</span>
            </div>
          );
        })}
      </div>
      <p className="text-[0.75rem] text-ink-3">
        {error ? "Couldn't load the trades. Try again in a moment." : "The five minutes in ten seconds: every chain's money as buys and sells came in."}
      </p>
    </section>
  );
}
