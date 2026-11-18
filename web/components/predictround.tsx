"use client";

/**
 * A price prediction shown as a live round: "will BTC be above $64,050 at 16:45?"
 * The chart is the coin's real price from Hyperliquid (1-minute candles, then the live mid every 2 seconds),
 * the dashed line is the target, and a dot marks where you got in. Up = the market's "Yes" side, Down = "No";
 * buying still goes through the normal Predict sheet (Hyperliquid's order book).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { info } from "@/lib/perps";
import { bestOf, priceText, PREDICT_FEE_TENTHS_BP, PREDICT_MIN, type PredictOutcome } from "@/lib/predict";

type Pt = { t: number; p: number };

// ------------------------------------------------------------------ live prices, shared by every card

const series = new Map<string, Pt[]>();
const subs = new Map<string, Set<() => void>>();
let poll: ReturnType<typeof setInterval> | null = null;
const loaded = new Set<string>();

async function loadHistory(coin: string) {
  if (loaded.has(coin)) return;
  loaded.add(coin);
  try {
    const end = Date.now();
    const rows = await info<{ t: number; c: string }[]>({ type: "candleSnapshot", req: { coin, interval: "1m", startTime: end - 60 * 60_000, endTime: end } });
    const hist = (Array.isArray(rows) ? rows : []).map((r) => ({ t: r.t + 60_000, p: Number(r.c) })).filter((r) => r.p > 0 && r.t <= end);
    const live = series.get(coin) ?? [];
    series.set(coin, [...hist, ...live.filter((x) => x.t > (hist[hist.length - 1]?.t ?? 0))]);
    subs.get(coin)?.forEach((f) => f());
  } catch {
    loaded.delete(coin);
  }
}

async function tick() {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  if (!subs.size) return;
  try {
    const mids = await info<Record<string, string>>({ type: "allMids" });
    const t = Date.now();
    for (const [coin, fs] of subs) {
      const p = Number(mids?.[coin]);
      if (!(p > 0)) continue;
      const arr = series.get(coin) ?? [];
      arr.push({ t, p });
      // keep about an hour
      while (arr.length && arr[0].t < t - 65 * 60_000) arr.shift();
      series.set(coin, arr);
      fs.forEach((f) => f());
    }
  } catch {
    /* next tick */
  }
}

function useLive(coin: string | undefined): Pt[] {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!coin) return;
    const f = () => bump((n) => n + 1);
    if (!subs.has(coin)) subs.set(coin, new Set());
    subs.get(coin)!.add(f);
    void loadHistory(coin);
    if (!poll) {
      void tick();
      poll = setInterval(() => void tick(), 2_000);
    }
    return () => {
      subs.get(coin)?.delete(f);
      if (!subs.get(coin)?.size) subs.delete(coin);
      if (!subs.size && poll) {
        clearInterval(poll);
        poll = null;
      }
    };
  }, [coin]);
  return coin ? (series.get(coin) ?? []) : [];
}

// ------------------------------------------------------------------ where you got in (this device)

export type Entry = { outcome: number; side: 0 | 1; t: number; p: number; usd: number };
const ENTRY_KEY = "sasa.predict.entries";
export function readEntries(): Entry[] {
  try {
    const v = JSON.parse(localStorage.getItem(ENTRY_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((e) => e && Number.isFinite(e.t) && Number.isFinite(e.p)) : [];
  } catch {
    return [];
  }
}
export function saveEntry(e: Entry) {
  try {
    const keep = readEntries().filter((x) => Date.now() - x.t < 3 * 86_400_000);
    localStorage.setItem(ENTRY_KEY, JSON.stringify([...keep, e].slice(-60)));
    window.dispatchEvent(new Event("sasa:predict-entry"));
  } catch {
    /* private mode: no dot, the buy still happened */
  }
}
function useEntries(outcome: number): Entry[] {
  const [all, setAll] = useState<Entry[]>([]);
  useEffect(() => {
    const f = () => setAll(readEntries());
    f();
    window.addEventListener("sasa:predict-entry", f);
    return () => window.removeEventListener("sasa:predict-entry", f);
  }, []);
  return all.filter((e) => e.outcome === outcome);
}
/** The coin's live price right now (for the entry dot). */
export function lastPrice(coin: string | undefined): number | null {
  const s = coin ? series.get(coin) : undefined;
  return s?.length ? s[s.length - 1].p : null;
}

// ------------------------------------------------------------------ the card

const ROUNDS = [5, 15, 60, 240, 1440].map((m) => m * 60_000);
const fmtLeft = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m left` : `${m}:${String(s % 60).padStart(2, "0")} left`;
};
/** The coin's price with enough decimals to see it move: $64,090.5 · $1,796.42 · $68.736 */
const livePx = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: v >= 10_000 ? 1 : v >= 1000 ? 2 : 0, maximumFractionDigits: v >= 10_000 ? 1 : v >= 1000 ? 2 : v >= 1 ? 4 : 6 })}`;
const gapPx = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : v >= 1 ? 2 : 4 })}`;
const money = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const CHIPS = [15, 25, 50, 100];
const FEE = PREDICT_FEE_TENTHS_BP / 100_000;

/** Real best offers for both sides, refreshed while the card is on screen. */
function useAsks(o: PredictOutcome, on: boolean): [number | null, number | null] {
  const [asks, setAsks] = useState<[number | null, number | null]>([null, null]);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      const r = await Promise.all([bestOf(o.sides[0].coin).catch(() => null), bestOf(o.sides[1].coin).catch(() => null)]);
      if (alive) setAsks([r[0]?.ask ?? null, r[1]?.ask ?? null]);
    };
    void load();
    const t = setInterval(() => void load(), 8_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [on, o.sides[0].coin, o.sides[1].coin]); // eslint-disable-line react-hooks/exhaustive-deps
  return asks;
}

/** What $usd on a side would pay: whole shares at the real best offer, plus sasa's fee. */
function payoff(usd: number, ask: number | null) {
  if (!ask || !(usd > 0)) return null;
  const shares = Math.floor(usd / ask);
  if (shares <= 0) return null;
  const cost = shares * ask * (1 + FEE);
  return { shares, cost, win: shares - cost };
}

export function RoundCard({ o, now, hot, onBet, share }: { o: PredictOutcome; now: number; hot?: boolean; onBet: (side: 0 | 1, usd: number) => void; share: () => void }) {
  const pts = useLive(o.under);
  const entries = useEntries(o.outcome);
  const box = useRef<HTMLElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return setOnScreen(true);
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting), { rootMargin: "100px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const asks = useAsks(o, onScreen);
  const [usd, setUsd] = useState(25);

  const target = o.target ?? 0;
  const last = pts.length ? pts[pts.length - 1].p : null;
  const leftMs = o.expiry ? o.expiry - now : null;
  const round = leftMs !== null ? (ROUNDS.find((r) => r >= leftMs) ?? leftMs) : null;
  const done = leftMs !== null && round ? Math.min(1, Math.max(0, 1 - leftMs / round)) : 0;
  const above = last !== null ? last >= target : null;
  const gap = last !== null ? last - target : null;

  // the chart: the last 30 minutes (15 for short rounds), target always in view
  const span = round && round <= 15 * 60_000 ? 15 * 60_000 : 30 * 60_000;
  const view = pts.filter((x) => x.t >= now - span);
  const W = 320;
  const H = 150;
  const chart = useMemo(() => {
    if (view.length < 2) return null;
    const t0 = view[0].t;
    const t1 = Math.max(view[view.length - 1].t, t0 + 1);
    let lo = Math.min(target, ...view.map((x) => x.p));
    let hi = Math.max(target, ...view.map((x) => x.p));
    const pad = Math.max((hi - lo) * 0.15, hi * 0.0002);
    lo -= pad;
    hi += pad;
    const x = (t: number) => ((t - t0) / (t1 - t0)) * (W - 8) + 2;
    const y = (p: number) => H - 6 - ((p - lo) / (hi - lo)) * (H - 12);
    const d = view.map((v, i) => `${i ? "L" : "M"}${x(v.t).toFixed(1)},${y(v.p).toFixed(1)}`).join(" ");
    return { x, y, d, t0, t1 };
  }, [view, target]);

  const payUp = payoff(usd, asks[0]);
  const payDown = payoff(usd, asks[1]);
  const lose = Math.max(payUp?.cost ?? 0, payDown?.cost ?? 0);
  const upColor = "var(--color-up, #12a150)";
  const downColor = "var(--color-danger, #e5484d)";
  const line = above === null ? "#9aa0a6" : above ? upColor : downColor;

  return (
    <article ref={box} id={`m${o.outcome}`} className={"rounded-3xl border bg-surface p-4 flex flex-col gap-3 min-w-0 " + (hot ? "border-emerald ring-1 ring-emerald" : "border-line")}>
      <div className="flex items-start gap-2">
        <h2 className="flex-1 font-semibold text-[0.9375rem] leading-snug text-ink-2">{o.title}</h2>
        <button type="button" onClick={share} aria-label="Share on X" title="Share on X" className="shrink-0 w-8 h-8 -mr-1 -mt-1 rounded-full text-ink-3 hover:text-ink hover:bg-paper flex items-center justify-center">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M18.9 2H22l-7.6 8.7L23 22h-6.8l-5.3-6.9L4.8 22H1.7l8.1-9.3L1 2h6.9l4.8 6.3L18.9 2zm-1.2 18h1.9L6.4 3.9H4.4L17.7 20z" />
          </svg>
        </button>
      </div>

      <div className="flex items-baseline gap-2 flex-wrap -mt-1">
        <span className="font-display font-bold text-[1.75rem] leading-none tabular-nums">{last !== null ? livePx(last) : "—"}</span>
        {gap !== null && (
          <span className={"text-[0.875rem] font-semibold tabular-nums " + (above ? "text-up" : "text-danger")}>
            {above ? "▲" : "▼"} {gapPx(Math.abs(gap))} {above ? "above" : "below"} target
          </span>
        )}
      </div>

      <div className="relative rounded-2xl bg-paper overflow-hidden">
        {chart ? (
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[150px] block" preserveAspectRatio="none" role="img" aria-label={`${o.under} price, last ${span / 60_000} minutes`}>
            <line x1="0" x2={W} y1={chart.y(target)} y2={chart.y(target)} stroke="#8a8f98" strokeDasharray="5 5" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <path d={chart.d} fill="none" stroke={line} strokeWidth="2.2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {entries
              .filter((e) => e.t >= chart.t0 - 60_000)
              .map((e, i) => (
                <circle key={i} cx={chart.x(Math.max(e.t, chart.t0))} cy={chart.y(e.p)} r="5" fill={e.side === 0 ? upColor : downColor} stroke="#fff" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              ))}
            {last !== null && view.length > 0 && <circle cx={chart.x(view[view.length - 1].t)} cy={chart.y(last)} r="3.5" fill={line} />}
          </svg>
        ) : (
          <div className="h-[150px] shimmer" />
        )}
        <span className="absolute left-2.5 text-[0.6875rem] text-ink-3 bg-paper/80 px-1 rounded" style={chart ? { top: `${Math.max(2, Math.min(H - 18, chart.y(target) - 17))}px` } : { top: 4 }}>
          target {priceText(target)}
        </span>
        {entries.length > 0 && (
          <span className="absolute right-2 bottom-1.5 text-[0.6875rem] text-ink-3 bg-paper/80 px-1 rounded">
            <span style={{ color: entries[entries.length - 1].side === 0 ? upColor : downColor }}>●</span> you got in at {livePx(entries[entries.length - 1].p)}
          </span>
        )}
      </div>

      {leftMs !== null && (
        <div className="flex items-center gap-3">
          <div className="flex-1 h-2 rounded-full bg-line overflow-hidden" aria-hidden="true">
            <div className="h-full bg-emerald transition-[width] duration-1000" style={{ width: `${Math.round(done * 100)}%` }} />
          </div>
          <span className="text-[0.875rem] font-semibold tabular-nums shrink-0">{leftMs > 0 ? fmtLeft(leftMs) : "Ending…"}</span>
        </div>
      )}

      <div className="rounded-2xl border border-line bg-paper p-3 flex flex-col gap-2.5">
        <div className="text-[0.8125rem] font-semibold">Your call</div>
        <div className="grid grid-cols-4 gap-1.5">
          {CHIPS.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={usd === v}
              onClick={() => setUsd(v)}
              className={"h-10 rounded-xl border font-bold text-[0.9375rem] " + (usd === v ? "border-emerald text-emerald ring-1 ring-emerald bg-surface" : "border-line bg-surface")}
            >
              ${v}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {([0, 1] as const).map((i) => (
            <button
              key={i}
              type="button"
              disabled={!o.tradable || (leftMs !== null && leftMs <= 0)}
              onClick={() => onBet(i, usd)}
              className={"h-12 rounded-2xl font-bold text-[1rem] text-white disabled:opacity-50 " + (i === 0 ? "bg-up" : "bg-danger")}
            >
              {i === 0 ? "Up ▲" : "Down ▼"} <span className="font-semibold opacity-90 text-[0.875rem]">{asks[i] ? `${Math.round(asks[i]! * 100)}¢` : ""}</span>
            </button>
          ))}
        </div>
        <p className="text-[0.75rem] text-ink-3 leading-snug">
          {payUp || payDown ? (
            <>
              {payUp && <>Up right: win <b className="text-up">{money(payUp.win)}</b>. </>}
              {payDown && <>Down right: win <b className="text-danger">{money(payDown.win)}</b>. </>}
              Wrong: lose {money(lose)}. Live prices from Hyperliquid.
            </>
          ) : asks[0] === null && asks[1] === null ? (
            "Getting live prices…"
          ) : (
            "No one is selling right now. Try again in a moment."
          )}
        </p>
      </div>
    </article>
  );
}
