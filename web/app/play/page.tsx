"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { RacePick } from "@/components/racepick";
import { RACE_CHAINS, fetchRaceCoins, racePhase, type RaceCoin } from "@/lib/race";

/**
 * Play: small games about the four-chain race. No score, no points, no prizes: just which
 * chain wins. Each game is a self-contained page (public/play/*.html) shown in a frame that
 * grows to the game's height, so it never scrolls inside a box.
 */
const GAMES = [
  { id: "chain-run", name: "Chain Run", line: "Back a chain and run its lane to the finish.", src: "/play/chain-run.html" },
  { id: "pump-tower", name: "Pump Tower", line: "Pump your chain's tower. Stop on red. 30 seconds.", src: "/play/pump-tower.html" },
  { id: "predict", name: "Who wins?", line: "Pick the winning chain of a live race.", src: "" },
] as const;
type GameId = (typeof GAMES)[number]["id"];
const SAVE = "sasa-play-game";

export default function PlayPage() {
  const [game, setGame] = useState<GameId>("chain-run");
  const [height, setHeight] = useState(760);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    try {
      const g = localStorage.getItem(SAVE);
      if (GAMES.some((x) => x.id === g)) setGame(g as GameId);
    } catch {}
  }, []);
  // The game is on our own site, so the page can watch its height directly.
  const watch = useRef<ResizeObserver | null>(null);
  const onLoad = () => {
    watch.current?.disconnect();
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    const fit = () => {
      const h = Math.ceil(doc.body.getBoundingClientRect().height);
      if (Number.isFinite(h) && h > 200 && h < 5000) setHeight(h);
    };
    fit();
    watch.current = new ResizeObserver(fit);
    watch.current.observe(doc.body);
  };
  useEffect(() => () => watch.current?.disconnect(), []);
  // The first game can finish loading before this page is ready to listen: measure it then.
  useEffect(() => {
    if (frame.current?.contentDocument?.readyState === "complete") onLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game]);
  const pick = (g: GameId) => {
    setGame(g);
    try {
      localStorage.setItem(SAVE, g);
    } catch {}
  };
  const current = GAMES.find((g) => g.id === game)!;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 sm:py-8 pb-28 md:pb-12 flex flex-col gap-4 min-w-0">
      <div>
        <h1 className="font-display font-bold text-[1.625rem] sm:text-[2.25rem] tracking-tight">Play</h1>
        <p className="text-ink-2 text-[0.9375rem]">Quick games about the four-chain race, and live races to call. No score, no points: just which chain wins.</p>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:max-w-2xl" role="tablist" aria-label="Games">
        {GAMES.map((g) => (
          <button
            key={g.id}
            type="button"
            role="tab"
            aria-selected={game === g.id}
            onClick={() => pick(g.id)}
            className={"rounded-2xl border p-3 text-left min-w-0 " + (game === g.id ? "border-ink ring-1 ring-ink" : "border-line")}
          >
            <div className="font-bold text-[0.9375rem]">{g.name}</div>
            <div className="text-[0.75rem] text-ink-3 leading-snug mt-0.5">{g.line}</div>
          </button>
        ))}
      </div>

      {current.id === "predict" ? (
        <PredictList />
      ) : (
      <iframe
        ref={frame}
        key={current.id}
        src={current.src}
        title={current.name}
        className="w-full rounded-3xl border border-line bg-[#0f0e0d] block"
        style={{ height }}
        loading="eager"
        onLoad={onLoad}
      />
      )}

      <p className="text-[0.8125rem] text-ink-3">
        The real thing works the same way: every coin launches on Base, BNB Chain, Robinhood Chain and Arc at once, and the chain with the most money after five minutes keeps it.{" "}
        <Link href="/race/" className="text-emerald-dark font-semibold">
          How races work
        </Link>
      </p>
    </div>
  );
}

/** Live races to call: pick a chain on each, come back when it's decided. No points. */
function PredictList() {
  const [races, setRaces] = useState<RaceCoin[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!RACE_CHAINS.length) {
      setRaces([]);
      return;
    }
    let alive = true;
    const load = () =>
      fetchRaceCoins(30)
        .then((r) => alive && setRaces(r))
        .catch(() => alive && setRaces((c) => c ?? []));
    load();
    const t = setInterval(load, 10_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(tick);
    };
  }, []);
  if (races === null) return <div className="h-40 rounded-3xl bg-line/50 animate-pulse" />;
  const live = races.filter((r) => racePhase(r, now) === "racing");
  const done = races.filter((r) => racePhase(r, now) === "decided").slice(0, 6);
  return (
    <div className="flex flex-col gap-3">
      {live.length === 0 ? (
        <p className="rounded-3xl border border-line p-5 text-[0.9375rem] text-ink-2">
          No race is running right now. Races last five minutes; check back soon, or{" "}
          <Link href="/race/launch/" className="text-emerald-dark font-semibold">
            launch one
          </Link>
          .
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {live.map((r) => (
            <RacePick key={r.id} coin={r} now={now} compact />
          ))}
        </div>
      )}
      {done.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {done.map((r) => (
            <RacePick key={r.id} coin={r} now={now} compact />
          ))}
        </div>
      )}
    </div>
  );
}
