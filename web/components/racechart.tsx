"use client";

import { useEffect, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { fetchRaceCandles, fmtPrice, type RaceCandle } from "@/lib/race";
import { compactUsd } from "@/lib/format";
import { onTrade } from "@/lib/live";

export type Candle = RaceCandle;

/** Time frames: label and candle size in seconds. */
const FRAMES = [
  { label: "1m", sec: 60 },
  { label: "5m", sec: 300 },
  { label: "15m", sec: 900 },
  { label: "1h", sec: 3600 },
  { label: "4h", sec: 14400 },
  { label: "1D", sec: 86400 },
] as const;
type Mode = "line" | "candles";
/** Market cap (price x supply) or price per coin. */
type Value = "mc" | "price";
/** Every race coin has a billion. */
const RACE_SUPPLY = 1_000_000_000;
const PREFS = "sasa-race-chart";

const CACHE = new Map<string, Candle[]>();

function cssVar(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Price chart of one race coin (dollars per coin). Line or candles, six time frames.
 * Draws from the cache at once, then refreshes every 5 s and right after the user trades.
 */
export function RaceChart({ coinId, chainId, height = 360 }: { coinId: string; chainId: number | null; height?: number }) {
  return (
    <PriceChart
      cacheKey={`${coinId}:${chainId ?? "all"}`}
      load={(frame) => fetchRaceCandles(coinId, chainId, frame)}
      tradeCoinId={coinId}
      mcFactor={RACE_SUPPLY}
      height={height}
    />
  );
}

/**
 * sasa's own price chart, for any coin: `load` returns the candles of one time frame
 * (seconds), oldest first. Refreshes every `refreshMs`; `onFail` is called when the
 * first load fails (the caller can show something else instead).
 */
export function PriceChart({
  cacheKey,
  load: loadCandles,
  tradeCoinId,
  height = 360,
  refreshMs = 5_000,
  emptyText = "No trades yet. The first one draws the chart.",
  onFail,
  mcFactor,
}: {
  cacheKey: string;
  load: (frameSec: number) => Promise<Candle[]>;
  tradeCoinId?: string;
  height?: number;
  refreshMs?: number;
  emptyText?: string;
  onFail?: () => void;
  /** price x this = market cap; given: the chart opens on market cap, with a Price switch */
  mcFactor?: number;
}) {
  const loadRef = useRef(loadCandles);
  loadRef.current = loadCandles;
  const failRef = useRef(onFail);
  failRef.current = onFail;
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [mode, setMode] = useState<Mode>("line");
  const [frame, setFrame] = useState<number>(60);
  const [empty, setEmpty] = useState(false);
  const [hover, setHover] = useState<{ price: number; time: number } | null>(null);
  const [value, setValue] = useState<Value>("mc");
  const k = mcFactor && mcFactor > 0 && value === "mc" ? mcFactor : 1;
  const fmt = (v: number) => (k === 1 ? fmtPrice(v) : compactUsd(v));
  const fmtRef = useRef(fmt);
  fmtRef.current = fmt;

  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS) ?? "{}") as { mode?: Mode; frame?: number };
      if (p.mode === "line" || p.mode === "candles") setMode(p.mode);
      if (FRAMES.some((f) => f.sec === p.frame)) setFrame(p.frame!);
    } catch {}
  }, []);
  const save = (p: { mode?: Mode; frame?: number }) => {
    try {
      localStorage.setItem(PREFS, JSON.stringify({ mode, frame, ...p }));
    } catch {}
  };

  useEffect(() => {
    if (!box.current) return;
    let alive = true;
    let chart: IChartApi | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopTrade: (() => void) | null = null;
    const key = `${cacheKey}:${frame}`;
    const first = loadRef.current(frame).catch(() => null);

    (async () => {
      const lc = await import("lightweight-charts");
      if (!alive || !box.current) return;
      const up = cssVar("--color-up", "#12a150");
      const down = cssVar("--color-danger", "#e5484d");
      const ink3 = cssVar("--color-ink-3", "#75757b");
      const line = cssVar("--color-line", "#ebebe8");
      chart = lc.createChart(box.current, {
        autoSize: true,
        layout: { background: { color: "transparent" }, textColor: ink3, fontSize: 11 },
        grid: { vertLines: { visible: false }, horzLines: { color: line } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3, barSpacing: 8, minBarSpacing: 2 },
        crosshair: { mode: 1 },
        // phones: vertical swipes keep scrolling the page; pinch, the buttons and sideways drags zoom and pan
        handleScroll: { vertTouchDrag: false, horzTouchDrag: true, mouseWheel: true, pressedMouseMove: true },
        // mouse wheel zooms, dragging the price or time axis stretches it, double-click on an axis resets it
        // two-finger pinch is our own (below): it zooms prices as well as time
        handleScale: { mouseWheel: true, pinch: false, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true } },
        localization: { priceFormatter: (p: number) => fmtRef.current(p) },
      });
      const priceFormat = { type: "custom" as const, minMove: 1e-12, formatter: (p: number) => fmtRef.current(p) };
      let series: ISeriesApi<"Area"> | ISeriesApi<"Candlestick">;
      if (mode === "line") {
        series = chart.addSeries(lc.AreaSeries, {
          lineColor: up,
          topColor: up + "33",
          bottomColor: up + "00",
          lineWidth: 2,
          priceFormat,
          lastValueVisible: true,
          priceLineVisible: false,
          crosshairMarkerRadius: 4,
        });
      } else {
        series = chart.addSeries(lc.CandlestickSeries, {
          upColor: up,
          downColor: down,
          wickUpColor: up,
          wickDownColor: down,
          borderVisible: false,
          priceFormat,
          priceLineVisible: false,
        });
      }
      chartRef.current = chart;
      chart.subscribeCrosshairMove((p) => {
        if (!alive) return;
        const d = p.time !== undefined ? (p.seriesData.get(series) as { value?: number; close?: number } | undefined) : undefined;
        const v = d?.value ?? d?.close;
        setHover(v !== undefined && p.time !== undefined ? { price: v, time: Number(p.time) } : null);
      });
      let fitted = false;
      const apply = (rows: Candle[]) => {
        setEmpty(rows.length === 0);
        if (mode === "line") {
          (series as ISeriesApi<"Area">).setData(rows.map((r) => ({ time: r.t as UTCTimestamp, value: r.close * k })));
          // tint the line red when the shown period ends below where it started
          if (rows.length > 1) {
            const c = rows[rows.length - 1].close >= rows[0].open ? up : down;
            (series as ISeriesApi<"Area">).applyOptions({ lineColor: c, topColor: c + "33", bottomColor: c + "00" });
          }
        } else {
          (series as ISeriesApi<"Candlestick">).setData(
            rows.map((r) => ({ time: r.t as UTCTimestamp, open: r.open * k, high: r.high * k, low: r.low * k, close: r.close * k }))
          );
        }
        if (!fitted && rows.length && chart) {
          if (rows.length > 80) chart.timeScale().fitContent();
          else chart.timeScale().setVisibleLogicalRange({ from: rows.length - Math.max(50, rows.length + 8), to: rows.length + 2 });
          fitted = true;
        }
      };
      const load = async (pending?: Promise<Candle[] | null>) => {
        try {
          const rows = pending ? await pending : await loadRef.current(frame);
          if (!alive) return;
          if (!rows) {
            if (pending && !CACHE.get(key)) failRef.current?.();
            return;
          }
          CACHE.set(key, rows);
          apply(rows);
        } catch {
          // next tick
        }
      };
      const cached = CACHE.get(key);
      if (cached) apply(cached);
      await load(first);
      timer = setInterval(() => void load(), refreshMs);
      if (tradeCoinId)
        stopTrade = onTrade((s) => {
          if (s.coinId.toLowerCase() !== tradeCoinId.toLowerCase()) return;
          [1200, 3000, 6000].forEach((d) => setTimeout(() => alive && void load(), d));
        });
    })();

    return () => {
      alive = false;
      chartRef.current = null;
      stopTrade?.();
      if (timer) clearInterval(timer);
      const c = chart;
      if (c) requestAnimationFrame(() => {
        try {
          c.remove();
        } catch {}
      });
    };
  }, [cacheKey, tradeCoinId, refreshMs, frame, mode, k]);

  // Two fingers: spreading them apart zooms in, pinching zooms out; sideways spread works on
  // time, up-and-down spread on prices (like the mouse wheel and dragging the axes).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let start: { dx: number; dy: number; from: number; to: number; pFrom: number; pTo: number } | null = null;
    const spread = (t: TouchList) => ({ dx: Math.abs(t[0].clientX - t[1].clientX) + 20, dy: Math.abs(t[0].clientY - t[1].clientY) + 20 });
    const onStart = (e: TouchEvent) => {
      const c = chartRef.current;
      if (!c || e.touches.length !== 2) return;
      const r = c.timeScale().getVisibleLogicalRange();
      const p = c.priceScale("right").getVisibleRange();
      if (!r || !p) return;
      start = { ...spread(e.touches), from: r.from, to: r.to, pFrom: p.from, pTo: p.to };
    };
    const onMove = (e: TouchEvent) => {
      const c = chartRef.current;
      if (!c || !start || e.touches.length !== 2) return;
      e.preventDefault(); // the page itself must not zoom or scroll
      const now = spread(e.touches);
      const kx = Math.min(8, Math.max(0.125, start.dx / now.dx));
      const ky = Math.min(8, Math.max(0.125, start.dy / now.dy));
      const width = Math.max(10, (start.to - start.from) * kx);
      c.timeScale().setVisibleLogicalRange({ from: start.to - width, to: start.to });
      const mid = (start.pFrom + start.pTo) / 2;
      const half = ((start.pTo - start.pFrom) / 2) * ky;
      const ps = c.priceScale("right");
      ps.setAutoScale(false);
      ps.setVisibleRange({ from: mid - half, to: mid + half });
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) start = null;
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  /** Zoom buttons: keep the newest candle on the right edge, show fewer or more candles. */
  const zoom = (k: "in" | "out" | "reset") => {
    const c = chartRef.current;
    if (!c) return;
    const ts = c.timeScale();
    if (k === "reset") {
      ts.fitContent();
      c.priceScale("right").applyOptions({ autoScale: true });
      return;
    }
    const r = ts.getVisibleLogicalRange();
    if (!r) return;
    const width = Math.max(10, (r.to - r.from) * (k === "in" ? 0.6 : 1.6));
    ts.setVisibleLogicalRange({ from: r.to - width, to: r.to });
  };

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        {mcFactor && mcFactor > 0 ? (
          <div className="flex bg-night rounded-full p-1" role="group" aria-label="Show">
            {(["mc", "price"] as Value[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setValue(v)}
                className={"h-8 px-3.5 rounded-full text-[0.8125rem] font-medium " + (value === v ? "bg-paper text-ink shadow-sm" : "text-ink-2")}
                aria-pressed={value === v}
              >
                {v === "mc" ? "MC" : "Price"}
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex bg-night rounded-full p-1" role="group" aria-label="Chart type">
          {(["line", "candles"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                save({ mode: m });
              }}
              className={"h-8 px-3.5 rounded-full text-[0.8125rem] font-medium capitalize " + (mode === m ? "bg-paper text-ink shadow-sm" : "text-ink-2")}
              aria-pressed={mode === m}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="flex bg-night rounded-full p-1 overflow-x-auto max-w-full no-scrollbar" role="group" aria-label="Time frame">
          {FRAMES.map((f) => (
            <button
              key={f.sec}
              type="button"
              onClick={() => {
                setFrame(f.sec);
                save({ frame: f.sec });
              }}
              className={"h-8 px-3 rounded-full text-[0.8125rem] font-medium shrink-0 " + (frame === f.sec ? "bg-paper text-ink shadow-sm" : "text-ink-2")}
              aria-pressed={frame === f.sec}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex bg-night rounded-full p-1" role="group" aria-label="Zoom">
          {[
            { k: "out", label: "−", title: "Zoom out" },
            { k: "in", label: "+", title: "Zoom in" },
            { k: "reset", label: "⟲", title: "Reset zoom" },
          ].map((b) => (
            <button
              key={b.k}
              type="button"
              title={b.title}
              aria-label={b.title}
              onClick={() => zoom(b.k as "in" | "out" | "reset")}
              className="h-8 w-8 rounded-full text-[1rem] font-semibold text-ink-2 hover:bg-paper hover:text-ink"
            >
              {b.label}
            </button>
          ))}
        </div>
        {hover && (
          <span className="ml-auto text-[0.8125rem] text-ink-2 tabular-nums">
            {fmt(hover.price)} · {new Date(hover.time * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
      <div className="relative w-full" style={{ height }}>
        <div ref={box} className="absolute inset-0" />
        {empty && (
          <div className="absolute inset-0 grid place-items-center text-ink-3 text-[0.875rem] pointer-events-none">{emptyText}</div>
        )}
      </div>
    </div>
  );
}
