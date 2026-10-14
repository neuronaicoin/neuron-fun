"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * Play: small games about the four-chain race. No score, no points, no prizes: just which
 * chain wins. Each game is a self-contained page (public/play/*.html) shown in a frame that
 * grows to the game's height, so it never scrolls inside a box.
 */
const GAMES = [
  { id: "chain-run", name: "Chain Run", line: "Back a chain and run its lane to the finish.", src: "/play/chain-run.html" },
  { id: "pump-tower", name: "Pump Tower", line: "Pump your chain's tower. Stop on red. 30 seconds.", src: "/play/pump-tower.html" },
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
        <p className="text-ink-2 text-[0.9375rem]">Quick games about the four-chain race. No score, no points: just which chain wins.</p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:max-w-md" role="tablist" aria-label="Games">
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

      <p className="text-[0.8125rem] text-ink-3">
        The real thing works the same way: every coin launches on Base, BNB Chain, Robinhood Chain and Arc at once, and the chain with the most money after five minutes keeps it.{" "}
        <Link href="/race/" className="text-emerald-dark font-semibold">
          How races work
        </Link>
      </p>
    </div>
  );
}
