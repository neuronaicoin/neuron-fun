"use client";

import { useEffect, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { fetchRaceCandles, fmtPrice, type RaceCandle } from "@/lib/race";
import { onTrade } from "@/lib/live";

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
const PREFS = "sasa-race-chart";

const CACHE = new Map<string, RaceCandle[]>();

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
  const box = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("line");
  const [frame, setFrame] = useState<number>(60);
  const [empty, setEmpty] = useState(false);
  const [hover, setHover] = useState<{ price: number; time: number } | null>(null);

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
    const key = `${coinId}:${chainId ?? "all"}:${frame}`;
    const first = fetchRaceCandles(coinId, chainId, frame).catch(() => null);

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
        handleScroll: { vertTouchDrag: false },
        localization: { priceFormatter: (p: number) => fmtPrice(p) },
      });
      const priceFormat = { type: "custom" as const, minMove: 1e-12, formatter: (p: number) => fmtPrice(p) };
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
      chart.subscribeCrosshairMove((p) => {
        if (!alive) return;
        const d = p.time !== undefined ? (p.seriesData.get(series) as { value?: number; close?: number } | undefined) : undefined;
        const v = d?.value ?? d?.close;
        setHover(v !== undefined && p.time !== undefined ? { price: v, time: Number(p.time) } : null);
      });
      let fitted = false;
      const apply = (rows: RaceCandle[]) => {
        setEmpty(rows.length === 0);
        if (mode === "line") {
          (series as ISeriesApi<"Area">).setData(rows.map((r) => ({ time: r.t as UTCTimestamp, value: r.close })));
          // tint the line red when the shown period ends below where it started
          if (rows.length > 1) {
            const c = rows[rows.length - 1].close >= rows[0].open ? up : down;
            (series as ISeriesApi<"Area">).applyOptions({ lineColor: c, topColor: c + "33", bottomColor: c + "00" });
          }
        } else {
          (series as ISeriesApi<"Candlestick">).setData(
            rows.map((r) => ({ time: r.t as UTCTimestamp, open: r.open, high: r.high, low: r.low, close: r.close }))
          );
        }
        if (!fitted && rows.length && chart) {
          if (rows.length > 80) chart.timeScale().fitContent();
          else chart.timeScale().setVisibleLogicalRange({ from: rows.length - Math.max(50, rows.length + 8), to: rows.length + 2 });
          fitted = true;
        }
      };
      const load = async (pending?: Promise<RaceCandle[] | null>) => {
        try {
          const rows = pending ? await pending : await fetchRaceCandles(coinId, chainId, frame);
          if (!alive || !rows) return;
          CACHE.set(key, rows);
          apply(rows);
        } catch {
          // next tick
        }
      };
      const cached = CACHE.get(key);
      if (cached) apply(cached);
      await load(first);
      timer = setInterval(() => void load(), 5_000);
      stopTrade = onTrade((s) => {
        if (s.coinId.toLowerCase() !== coinId.toLowerCase()) return;
        [1200, 3000, 6000].forEach((d) => setTimeout(() => alive && void load(), d));
      });
    })();

    return () => {
      alive = false;
      stopTrade?.();
      if (timer) clearInterval(timer);
      const c = chart;
      if (c) requestAnimationFrame(() => {
        try {
          c.remove();
        } catch {}
      });
    };
  }, [coinId, chainId, frame, mode]);

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
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
        {hover && (
          <span className="ml-auto text-[0.8125rem] text-ink-2 tabular-nums">
            {fmtPrice(hover.price)} · {new Date(hover.time * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
      <div className="relative w-full" style={{ height }}>
        <div ref={box} className="absolute inset-0" />
        {empty && (
          <div className="absolute inset-0 grid place-items-center text-ink-3 text-[0.875rem] pointer-events-none">No trades yet. The first one draws the chart.</div>
        )}
      </div>
    </div>
  );
}
