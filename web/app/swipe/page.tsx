"use client";

/**
 * Discover: a deck of live coins. Swipe right to buy (opens the buy sheet,
 * amount already filled in, one tap to confirm), left to skip, up to save to
 * favourites. Buttons and the arrow keys do the same on a computer.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sheet } from "@/components/chrome";
import { toast } from "@/components/alerts";
import { CoinArt, ChangePill, coinMarketCapUsd, compactUsd } from "@/components/discover";
import { LockBadge } from "@/components/lock";
import { Sparkline } from "@/components/spark";
import { QuickTrade } from "@/components/trade";
import { coinHref, fetchCoins, type Coin } from "@/lib/data";
import { useSparks } from "@/lib/spark";
import { getWatchlist, toggleWatch } from "@/lib/watchlist";

const SEEN_KEY = "sasa-swipe-seen";
const AMOUNTS = [5, 10, 25] as const;
const FLING = 110; // px to count as a swipe
type Act = "buy" | "skip" | "save";

function readSeen(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}
function markSeen(id: string) {
  try {
    const s = readSeen();
    s.add(id);
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-400)));
  } catch {}
}

export default function SwipePage() {
  const [deck, setDeck] = useState<Coin[] | null>(null);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [amount, setAmount] = useState<number>(5);
  const [buying, setBuying] = useState<Coin | null>(null);
  const [error, setError] = useState(false);
  const [leaving, setLeaving] = useState<{ id: string; act: Act } | null>(null);

  const load = useCallback(async () => {
    setError(false);
    try {
      const seen = readSeen();
      const pages = await Promise.all([0, 1].map((page) => fetchCoins({ sort: "trending", page })));
      const all = pages.flatMap((p) => p.coins);
      setEthUsd(pages[0].prices?.ETH ?? null);
      const uniq = [...new Map(all.map((c) => [c.id, c])).values()];
      // Only coins you can still buy.
      const open = uniq.filter((c) => c.curves.some((k) => k.state !== "closed"));
      setDeck(open.filter((c) => !seen.has(c.id)));
    } catch {
      setError(true);
      setDeck([]);
    }
  }, []);

  useEffect(() => {
    void load();
    try {
      const a = Number(localStorage.getItem("sasa-swipe-amount"));
      if ((AMOUNTS as readonly number[]).includes(a)) setAmount(a);
    } catch {}
  }, [load]);

  const top3 = (deck ?? []).slice(0, 3);
  const sparks = useSparks(useMemo(() => top3.map((c) => c.id), [top3]));
  const current = deck?.[0];

  const act = useCallback(
    (a: Act) => {
      if (!current || leaving) return;
      setLeaving({ id: current.id, act: a });
      markSeen(current.id);
      if (a === "save") {
        if (!getWatchlist().includes(current.id)) toggleWatch(current.id);
        toast(`$${current.symbol} saved to favourites ★`);
      }
      if (a === "buy") setBuying(current);
      setTimeout(() => {
        setDeck((d) => (d ? d.slice(1) : d));
        setLeaving(null);
      }, 280);
    },
    [current, leaving]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (buying || (e.target as HTMLElement)?.closest("input,textarea")) return;
      if (e.key === "ArrowRight") act("buy");
      else if (e.key === "ArrowLeft") act("skip");
      else if (e.key === "ArrowUp") {
        e.preventDefault();
        act("save");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, buying]);

  return (
    <div className="max-w-md mx-auto px-4 pt-4 sm:pt-8 pb-28 md:pb-12">
      <div className="text-center">
        <h1 className="font-display font-bold text-[1.5rem] sm:text-[1.875rem] tracking-tight">Discover</h1>
        <p className="text-ink-3 text-[0.875rem] mt-0.5">Swipe right to buy, left to skip, up to save.</p>
      </div>

      <div className="relative mt-4 h-[min(34rem,calc(100dvh-22rem))] min-h-[27rem]">
        {deck === null ? (
          <div className="shimmer absolute inset-0 rounded-2xl" />
        ) : !current ? (
          <div className="absolute inset-0 rounded-2xl border border-line bg-surface flex flex-col items-center justify-center text-center gap-2 p-6">
            <b className="font-display text-[1.125rem]">{error ? "Couldn't load coins" : "You've seen them all"}</b>
            <span className="text-ink-2 text-[0.875rem]">{error ? "Check your connection and try again." : "New coins show up all the time."}</span>
            <button
              type="button"
              onClick={() => {
                try {
                  sessionStorage.removeItem(SEEN_KEY);
                } catch {}
                setDeck(null);
                void load();
              }}
              className="mt-2 h-11 px-5 rounded-xl bg-emerald text-on-accent font-bold"
            >
              {error ? "Try again" : "Start over"}
            </button>
            <Link href="/explore/" className="text-[0.875rem] font-semibold text-emerald mt-1">
              Browse all coins
            </Link>
          </div>
        ) : (
          top3
            .map((c, i) => (
              <SwipeCard
                key={c.id}
                coin={c}
                depth={i}
                ethUsd={ethUsd}
                spark={sparks.get(c.id)}
                leaving={leaving?.id === c.id ? leaving.act : null}
                onAct={act}
              />
            ))
            .reverse()
        )}
      </div>

      <div className="flex justify-center items-center gap-5 mt-5" aria-label="Actions">
        <button
          type="button"
          onClick={() => act("skip")}
          disabled={!current}
          aria-label="Skip"
          className="w-14 h-14 rounded-full border border-line bg-surface text-danger text-[1.375rem] disabled:opacity-40"
        >
          ✕
        </button>
        <button
          type="button"
          onClick={() => act("save")}
          disabled={!current}
          aria-label="Save to favourites"
          className="w-12 h-12 rounded-full border border-line bg-surface text-ink-2 text-[1.25rem] disabled:opacity-40"
        >
          ★
        </button>
        <button
          type="button"
          onClick={() => act("buy")}
          disabled={!current}
          aria-label={`Buy $${amount}`}
          className="w-16 h-16 rounded-full bg-up text-white font-bold text-[1rem] disabled:opacity-40"
        >
          ${amount}
        </button>
      </div>

      <div className="flex justify-center items-center gap-2 mt-4 text-[0.8125rem] text-ink-3">
        Buy amount
        <div className="flex gap-1.5" role="group" aria-label="Buy amount">
          {AMOUNTS.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={amount === v}
              onClick={() => {
                setAmount(v);
                try {
                  localStorage.setItem("sasa-swipe-amount", String(v));
                } catch {}
              }}
              className={"h-8 px-3 rounded-lg border font-semibold " + (amount === v ? "border-ink text-ink" : "border-line text-ink-2")}
            >
              ${v}
            </button>
          ))}
        </div>
      </div>
      <p className="hidden md:block text-center text-[0.75rem] text-ink-3 mt-3">Keyboard: ← skip · → buy · ↑ save</p>

      {buying && (
        <Sheet title={`Buy $${buying.symbol}`} onClose={() => setBuying(null)}>
          <QuickTrade
            coin={buying}
            ethUsd={ethUsd}
            bare
            initialSide="buy"
            initialUsd={String(amount)}
            onTraded={() => {}}
            onDone={() => {
              toast(`Bought $${buying.symbol} ✓`);
              setTimeout(() => setBuying(null), 1200);
            }}
          />
          <Link href={coinHref(buying)} className="mt-3 block text-center text-[0.875rem] font-semibold text-emerald">
            Open the coin page
          </Link>
        </Sheet>
      )}
    </div>
  );
}

function SwipeCard({
  coin,
  depth,
  ethUsd,
  spark,
  leaving,
  onAct,
}: {
  coin: Coin;
  depth: number;
  ethUsd: number | null;
  spark?: number[];
  leaving: Act | null;
  onAct: (a: Act) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [d, setD] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const top = depth === 0;

  const out =
    leaving === "buy"
      ? "translate(120vw, 0) rotate(24deg)"
      : leaving === "skip"
        ? "translate(-120vw, 0) rotate(-24deg)"
        : leaving === "save"
          ? "translate(0, -120vh)"
          : null;
  const transform = out ?? (top ? `translate(${d.x}px, ${d.y}px) rotate(${d.x / 18}deg)` : `translateY(${depth * 12}px) scale(${1 - depth * 0.04})`);
  const buyO = leaving === "buy" ? 1 : Math.max(0, Math.min(1, d.x / FLING));
  const skipO = leaving === "skip" ? 1 : Math.max(0, Math.min(1, -d.x / FLING));
  const saveO = leaving === "save" ? 1 : Math.abs(d.x) < 60 ? Math.max(0, Math.min(1, -d.y / 140)) : 0;
  const pct = Math.round(coin.progress * 100);

  return (
    <div
      ref={ref}
      role={top ? "group" : undefined}
      aria-label={top ? `${coin.name}, $${coin.symbol}` : undefined}
      aria-hidden={!top}
      onPointerDown={(e) => {
        if (!top || leaving) return;
        start.current = { x: e.clientX, y: e.clientY };
        setDragging(true);
        ref.current?.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        setD({ x: e.clientX - start.current.x, y: e.clientY - start.current.y });
      }}
      onPointerUp={() => {
        if (!start.current) return;
        start.current = null;
        setDragging(false);
        if (d.x > FLING) onAct("buy");
        else if (d.x < -FLING) onAct("skip");
        else if (d.y < -140 && Math.abs(d.x) < 60) onAct("save");
        else setD({ x: 0, y: 0 });
      }}
      onPointerCancel={() => {
        start.current = null;
        setDragging(false);
        setD({ x: 0, y: 0 });
      }}
      className="absolute inset-0 rounded-2xl border border-line bg-surface overflow-hidden flex flex-col select-none"
      style={{
        transform,
        transition: dragging ? "none" : "transform 0.3s ease-out, opacity 0.3s",
        opacity: leaving ? 0 : 1,
        touchAction: top ? "none" : "auto",
        zIndex: 10 - depth,
        cursor: top ? (dragging ? "grabbing" : "grab") : "default",
      }}
    >
      <div className="relative flex-1 min-h-0 bg-night">
        <CoinArt coin={coin} />
        <div className="absolute top-3 left-3 right-3 flex gap-1.5 flex-wrap">
          {coin.curves.map((c) => (
            <span key={c.chain.key} className="h-6 px-2 rounded-full text-[0.6875rem] font-semibold text-white flex items-center" style={{ background: c.chain.color }}>
              {c.chain.short}
            </span>
          ))}
        </div>
        <LockBadge coinId={coin.id} size="sm" onArt className="absolute bottom-3 left-3" />
        {coin.graduatedOn ? (
          <span className="absolute bottom-3 right-3 h-6 px-2 rounded-full text-[0.6875rem] font-bold bg-black/65 text-white flex items-center">Graduated</span>
        ) : pct >= 80 ? (
          <span className="absolute bottom-3 right-3 h-6 px-2 rounded-full text-[0.6875rem] font-bold bg-black/65 text-white flex items-center">{pct}%</span>
        ) : null}
        <span style={{ opacity: buyO }} className="absolute top-8 left-5 -rotate-12 px-3 py-1 rounded-xl border-4 border-up text-up font-display font-extrabold text-[1.75rem]">
          BUY
        </span>
        <span style={{ opacity: skipO }} className="absolute top-8 right-5 rotate-12 px-3 py-1 rounded-xl border-4 border-danger text-danger font-display font-extrabold text-[1.75rem]">
          SKIP
        </span>
        <span style={{ opacity: saveO }} className="absolute bottom-1/3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-xl border-4 border-[#ffb020] text-[#ffb020] font-display font-extrabold text-[1.5rem] whitespace-nowrap">
          ★ SAVE
        </span>
      </div>
      <div className="p-4">
        <div className="flex items-baseline gap-2 min-w-0">
          <b className="font-display text-[1.25rem] truncate">{coin.name}</b>
          <span className="text-[0.8125rem] text-ink-3 shrink-0">{coin.symbol}</span>
        </div>
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 mt-2.5">
          <span className="leading-none">
            <span className="block text-[0.6875rem] text-ink-3">Market cap</span>
            <span className="block font-mono font-bold tabular-nums text-[1.25rem] mt-1">{compactUsd(coinMarketCapUsd(coin, ethUsd))}</span>
          </span>
          <Sparkline pts={spark} className="w-full h-9" />
          <ChangePill value={coin.change24h} />
        </div>
        {coin.description && <p className="text-[0.8125rem] text-ink-2 mt-2 line-clamp-2">{coin.description}</p>}
        <p className="text-[0.75rem] text-ink-3 mt-1.5">{coin.graduatedOn ? "Graduated · trading in its pool" : `${pct}% to graduation`}</p>
      </div>
    </div>
  );
}
