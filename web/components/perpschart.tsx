"use client";

/**
 * The Perps chart: Hyperliquid's candles, live. History comes from the info API, then every
 * trade moves the last candle through the live feed (lib/hlws.ts); if the feed drops, the chart
 * polls every few seconds until it is back. Indicators (MA, EMA, Bollinger, RSI, volume) are the
 * user's own picks, each with its own settings, remembered in this browser. The user's open
 * position (entry, liquidation) and TP/SL show as lines on the chart.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IChartApi, IPriceLine, ISeriesApi, MouseEventParams, Time, UTCTimestamp } from "lightweight-charts";
import { usePinchZoom } from "./racechart";
import { Sheet } from "./chrome";
import { fetchPerpCandles, hlInterval, type PerpCandle } from "@/lib/perps";
import { hlOnStatus, hlSubscribe, type HlWsCandle } from "@/lib/hlws";
import {
  IND_COLORS,
  IND_INFO,
  MAX_INDICATORS,
  bollinger,
  ema,
  indLabel,
  loadIndicators,
  rsi,
  saveIndicators,
  sma,
  type IndKind,
  type Indicator,
} from "@/lib/indicators";
import { compactUsd } from "@/lib/format";

const FRAMES = [
  { label: "1m", sec: 60 },
  { label: "5m", sec: 300 },
  { label: "15m", sec: 900 },
  { label: "1h", sec: 3600 },
  { label: "4h", sec: 14400 },
  { label: "1D", sec: 86400 },
] as const;
type Mode = "line" | "candles";
const PREFS = "sasa-perps-chart";
const RSI_PANE_PX = 120;
const CACHE = new Map<string, PerpCandle[]>();

export type ChartLine = { price: number; label: string; kind: "entry" | "liq" | "tp" | "sl" };

function cssVar(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** A price with the market's own decimals, thousands separated. */
export function fmtPx(v: number, dec: number): string {
  if (!Number.isFinite(v)) return "—";
  // 5 significant digits, like Hyperliquid's own prices, never more decimals than the market has
  const d = Math.min(dec, Math.max(0, 4 - Math.floor(Math.log10(Math.max(Math.abs(v), 1e-12)))));
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Folds one live candle into the list (same start: replaces the last; newer: adds one). */
export function mergeCandle(rows: PerpCandle[], c: PerpCandle): "same" | "new" | "old" {
  const last = rows[rows.length - 1];
  if (last && c.t < last.t) return "old";
  if (last && c.t === last.t) {
    rows[rows.length - 1] = c;
    return "same";
  }
  rows.push(c);
  if (rows.length > 3000) rows.splice(0, rows.length - 3000);
  return "new";
}

export function wsCandle(d: HlWsCandle): PerpCandle | null {
  const close = Number(d.c);
  const c = { t: Math.floor(Number(d.t) / 1000), open: Number(d.o), high: Number(d.h), low: Number(d.l), close, volume: Number(d.v) * close };
  return Number.isFinite(c.t) && close > 0 && c.high > 0 && c.low > 0 ? c : null;
}

type Legend = { t: number; o: number; h: number; l: number; c: number; v: number; ind: { label: string; color: string; value: string }[] };

type IndSeries = { ind: Indicator; series: ISeriesApi<"Line" | "Histogram">[] };

export function PerpsChart({ coin, decimals, lines = [], height = 400 }: { coin: string; decimals: number; lines?: ChartLine[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Area"> | null>(null);
  const rowsRef = useRef<PerpCandle[]>([]);
  const indRef = useRef<IndSeries[]>([]);
  /** Each indicator's values (lined up with the candles), from the last full draw: the legend reads them. */
  const valsRef = useRef(new Map<string, (number | null)[][]>());
  const lcRef = useRef<typeof import("lightweight-charts") | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const [mode, setMode] = useState<Mode>("candles");
  const [frame, setFrame] = useState<number>(900);
  const [inds, setInds] = useState<Indicator[]>([]);
  const [indsReady, setIndsReady] = useState(false);
  const [picker, setPicker] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [live, setLive] = useState(false);
  const [legend, setLegend] = useState<Legend | null>(null);
  const [ready, setReady] = useState(0);
  const hovering = useRef(false);
  const decRef = useRef(decimals);
  decRef.current = decimals;
  const indsRef = useRef(inds);
  indsRef.current = inds;
  const hasRsi = inds.some((i) => i.kind === "rsi");

  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS) ?? "{}") as { mode?: Mode; frame?: number };
      if (p.mode === "line" || p.mode === "candles") setMode(p.mode);
      if (FRAMES.some((f) => f.sec === p.frame)) setFrame(p.frame!);
    } catch {}
    setInds(loadIndicators());
    setIndsReady(true);
  }, []);
  const save = (p: { mode?: Mode; frame?: number }) => {
    try {
      localStorage.setItem(PREFS, JSON.stringify({ mode, frame, ...p }));
    } catch {}
  };
  const changeInds = useCallback((next: Indicator[]) => {
    setInds(next);
    saveIndicators(next);
  }, []);

  /** The legend for one candle (the hovered one, or the newest). */
  const legendAt = useCallback((idx: number): Legend | null => {
    const rows = rowsRef.current;
    const r = rows[idx];
    if (!r) return null;
    const dec = decRef.current;
    const ind: Legend["ind"] = [];
    for (const s of indRef.current) {
      const i = s.ind;
      if (i.kind === "vol") continue;
      const vals = valsRef.current.get(i.id);
      const at = (k: number) => vals?.[k]?.[idx] ?? null;
      let value = "—";
      if (i.kind === "bb") value = `${fmtOrDash(at(0), dec)} / ${fmtOrDash(at(2), dec)}`;
      else if (i.kind === "rsi") value = at(0) === null ? "—" : (at(0) as number).toFixed(1);
      else value = fmtOrDash(at(0), dec);
      ind.push({ label: indLabel(i), color: i.color, value });
    }
    return { t: r.t, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume, ind };
  }, []);

  /** Draws every indicator from the candles (all of them, or only the newest point). */
  const drawInds = useCallback((onlyLast: boolean) => {
    const rows = rowsRef.current;
    if (!rows.length) return;
    const closes = rows.map((r) => r.close);
    const up = cssVar("--color-up", "#12a150");
    const down = cssVar("--color-danger", "#e5484d");
    const pts = (vals: (number | null)[]) => {
      if (onlyLast) {
        const i = rows.length - 1;
        return vals[i] === null ? [] : [{ time: rows[i].t as UTCTimestamp, value: vals[i] as number }];
      }
      const out: { time: UTCTimestamp; value: number }[] = [];
      vals.forEach((v, i) => {
        if (v !== null && Number.isFinite(v)) out.push({ time: rows[i].t as UTCTimestamp, value: v });
      });
      return out;
    };
    const put = (s: ISeriesApi<"Line" | "Histogram">, data: { time: UTCTimestamp; value: number; color?: string }[]) => {
      try {
        if (onlyLast) data.forEach((d) => s.update(d));
        else s.setData(data);
      } catch {}
    };
    const vals = valsRef.current;
    vals.clear();
    for (const { ind, series } of indRef.current) {
      if (ind.kind === "vol") {
        const from = onlyLast ? rows.length - 1 : 0;
        put(
          series[0],
          rows.slice(from).map((r) => ({ time: r.t as UTCTimestamp, value: r.volume, color: (r.close >= r.open ? up : down) + "55" }))
        );
      } else if (ind.kind === "bb") {
        const b = bollinger(closes, ind.period, ind.mult ?? 2);
        vals.set(ind.id, [b.up, b.mid, b.low]);
        put(series[0], pts(b.up));
        put(series[1], pts(b.mid));
        put(series[2], pts(b.low));
      } else {
        const v = ind.kind === "ma" ? sma(closes, ind.period) : ind.kind === "ema" ? ema(closes, ind.period) : rsi(closes, ind.period);
        vals.set(ind.id, [v]);
        put(series[0], pts(v));
      }
    }
  }, []);

  // ---------------------------------------------------------------- the chart and its data
  useEffect(() => {
    if (!box.current) return;
    let alive = true;
    let chart: IChartApi | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let stopWs: (() => void) | null = null;
    let stopStatus: (() => void) | null = null;
    let legendTimer: ReturnType<typeof setTimeout> | null = null;
    let indTimer: ReturnType<typeof setTimeout> | null = null;
    const key = `${coin}:${frame}`;
    const first = fetchPerpCandles(coin, frame).catch(() => null);
    rowsRef.current = [];

    (async () => {
      const lc = await import("lightweight-charts");
      if (!alive || !box.current) return;
      lcRef.current = lc;
      const up = cssVar("--color-up", "#12a150");
      const down = cssVar("--color-danger", "#e5484d");
      const ink3 = cssVar("--color-ink-3", "#75757b");
      const line = cssVar("--color-line", "#ebebe8");
      const dec = decRef.current;
      chart = lc.createChart(box.current, {
        autoSize: true,
        layout: { background: { color: "transparent" }, textColor: ink3, fontSize: 11, panes: { separatorColor: line, enableResize: true } },
        grid: { vertLines: { color: line + "88" }, horzLines: { color: line } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.12 } },
        timeScale: {
          borderVisible: false,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 4,
          barSpacing: 7,
          minBarSpacing: 1,
          tickMarkFormatter: (time: Time, type: number) => {
            const d = new Date(Number(time) * 1000);
            if (type === 0) return String(d.getFullYear());
            if (type === 1) return d.toLocaleString("en-US", { month: "short" });
            if (type === 2) return String(d.getDate());
            return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
          },
        },
        crosshair: { mode: 0 },
        handleScroll: { vertTouchDrag: false, horzTouchDrag: true, mouseWheel: true, pressedMouseMove: true },
        handleScale: { mouseWheel: true, pinch: false, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true } },
        localization: {
          timeFormatter: (t: Time) =>
            new Date(Number(t) * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }),
        },
      });
      const priceFormat = { type: "price" as const, precision: dec, minMove: 1 / 10 ** dec };
      const series =
        mode === "line"
          ? chart.addSeries(lc.AreaSeries, { lineColor: up, topColor: up + "33", bottomColor: up + "00", lineWidth: 2, priceFormat, priceLineVisible: true, crosshairMarkerRadius: 4 })
          : chart.addSeries(lc.CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false, priceFormat, priceLineVisible: true });
      chartRef.current = chart;
      mainRef.current = series;
      setReady((n) => n + 1);

      chart.subscribeCrosshairMove((p: MouseEventParams<Time>) => {
        if (!alive) return;
        if (p.time === undefined || p.logical === undefined) {
          hovering.current = false;
          setLegend(legendAt(rowsRef.current.length - 1));
          return;
        }
        hovering.current = true;
        const idx = rowsRef.current.findIndex((r) => r.t === Number(p.time));
        setLegend(legendAt(idx >= 0 ? idx : rowsRef.current.length - 1));
      });

      const point = (r: PerpCandle) =>
        mode === "line" ? { time: r.t as UTCTimestamp, value: r.close } : { time: r.t as UTCTimestamp, open: r.open, high: r.high, low: r.low, close: r.close };
      const showAll = (rows: PerpCandle[], fit: boolean) => {
        rowsRef.current = rows.slice();
        setEmpty(rows.length === 0);
        (series as ISeriesApi<"Candlestick">).setData(rows.map(point) as never);
        drawInds(false);
        if (fit && rows.length && chart) {
          const n = rows.length;
          chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 120), to: n + 4 });
        }
        if (!hovering.current) setLegend(legendAt(rows.length - 1));
      };
      const reload = async (fit = false) => {
        const rows = await fetchPerpCandles(coin, frame).catch(() => null);
        if (!alive || !rows) return;
        CACHE.set(key, rows);
        showAll(rows, fit);
      };

      const cached = CACHE.get(key);
      if (cached) showAll(cached, true);
      const rows = await first;
      if (!alive) return;
      if (rows) {
        CACHE.set(key, rows);
        showAll(rows, !cached);
      }

      // live: each trade moves the newest candle
      const onCandle = (d: unknown) => {
        if (!alive) return;
        const c = wsCandle(d as HlWsCandle);
        if (!c || (d as HlWsCandle).s !== coin) return;
        const r = mergeCandle(rowsRef.current, c);
        if (r === "old") return;
        try {
          (series as ISeriesApi<"Candlestick">).update(point(c) as never);
        } catch {
          return;
        }
        // the candle itself moves on every trade; indicators follow a few times a second
        // (a new candle: everything redrawn at once, so the closed candle keeps its final values)
        if (r === "new") {
          if (indTimer) clearTimeout(indTimer);
          indTimer = null;
          drawInds(false);
          setEmpty(false);
        } else if (!indTimer)
          indTimer = setTimeout(() => {
            indTimer = null;
            if (alive) drawInds(true);
          }, 250);
        // the legend follows the newest candle a few times a second, not on every trade
        if (!hovering.current && !legendTimer)
          legendTimer = setTimeout(() => {
            legendTimer = null;
            if (alive && !hovering.current) setLegend(legendAt(rowsRef.current.length - 1));
          }, 250);
      };
      stopWs = hlSubscribe({ type: "candle", coin, interval: hlInterval(frame) }, onCandle);
      let everUp = false;
      let isLive = false;
      stopStatus = hlOnStatus((isUp) => {
        const back = isUp && !isLive && everUp;
        isLive = isUp;
        if (isUp) everUp = true;
        if (!alive) return;
        setLive(isUp);
        // the feed came back after a drop: fill what was missed while it was down
        if (back) void reload();
      });
      // without the live feed (blocked network, old browser) the chart still moves every 5 s
      poll = setInterval(() => {
        if (document.visibilityState === "visible" && !isLive) void reload();
      }, 5_000);
    })();

    return () => {
      alive = false;
      chartRef.current = null;
      mainRef.current = null;
      indRef.current = [];
      priceLinesRef.current = [];
      stopWs?.();
      stopStatus?.();
      if (poll) clearInterval(poll);
      if (legendTimer) clearTimeout(legendTimer);
      if (indTimer) clearTimeout(indTimer);
      const c = chart;
      if (c)
        requestAnimationFrame(() => {
          try {
            c.remove();
          } catch {}
        });
    };
  }, [coin, frame, mode, drawInds, legendAt]);

  // ---------------------------------------------------------------- indicator series
  useEffect(() => {
    const chart = chartRef.current;
    const lc = lcRef.current;
    if (!chart || !lc || !indsReady) return;
    for (const s of indRef.current) for (const x of s.series) chart.removeSeries(x);
    indRef.current = [];
    const dec = decimals;
    const priceFormat = { type: "price" as const, precision: dec, minMove: 1 / 10 ** dec };
    const lineOpts = (color: string, width: 1 | 2 = 1, style = 0) => ({
      color,
      lineWidth: width,
      lineStyle: style,
      priceFormat,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    for (const ind of inds) {
      if (ind.kind === "vol") {
        const s = chart.addSeries(lc.HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false });
        chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        indRef.current.push({ ind, series: [s] });
      } else if (ind.kind === "bb") {
        const a = chart.addSeries(lc.LineSeries, lineOpts(ind.color));
        const b = chart.addSeries(lc.LineSeries, lineOpts(ind.color, 1, 2));
        const c = chart.addSeries(lc.LineSeries, lineOpts(ind.color));
        indRef.current.push({ ind, series: [a, b, c] });
      } else if (ind.kind === "rsi") {
        const s = chart.addSeries(lc.LineSeries, { ...lineOpts(ind.color, 2), priceFormat: { type: "price", precision: 1, minMove: 0.1 }, lastValueVisible: true }, 1);
        s.createPriceLine({ price: 70, color: "#94a3b8", lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
        s.createPriceLine({ price: 30, color: "#94a3b8", lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
        indRef.current.push({ ind, series: [s] });
      } else {
        indRef.current.push({ ind, series: [chart.addSeries(lc.LineSeries, lineOpts(ind.color, 2))] });
      }
    }
    // the RSI pane: a fixed strip under the prices; gone when no RSI is left
    const panes = chart.panes();
    for (let i = panes.length - 1; i >= 1; i--) if (panes[i].getSeries().length === 0) chart.removePane(i);
    if (chart.panes().length > 1) chart.panes()[1].setHeight(RSI_PANE_PX);
    drawInds(false);
    if (!hovering.current) setLegend(legendAt(rowsRef.current.length - 1));
  }, [inds, indsReady, ready, decimals, drawInds, legendAt]);

  // ---------------------------------------------------------------- position lines
  const linesKey = JSON.stringify(lines);
  useEffect(() => {
    const s = mainRef.current;
    if (!s) return;
    for (const p of priceLinesRef.current) {
      try {
        s.removePriceLine(p);
      } catch {}
    }
    priceLinesRef.current = [];
    const color = { entry: cssVar("--color-ink-3", "#75757b"), liq: cssVar("--color-danger", "#e5484d"), tp: cssVar("--color-up", "#12a150"), sl: "#f59e0b" };
    for (const l of JSON.parse(linesKey) as ChartLine[]) {
      if (!(l.price > 0)) continue;
      priceLinesRef.current.push(s.createPriceLine({ price: l.price, color: color[l.kind], lineWidth: 1, lineStyle: l.kind === "entry" ? 0 : 2, axisLabelVisible: true, title: l.label }));
    }
  }, [linesKey, ready]);

  usePinchZoom(box, chartRef);

  // Dragging the chart up or down (or the price axis, or a pinch) turns the price autoscale off;
  // an "Auto" button then brings it back, like on TradingView.
  const [manualScale, setManualScale] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const check = () =>
      setTimeout(() => {
        const c = chartRef.current;
        if (!c) return;
        try {
          setManualScale(!c.priceScale("right").options().autoScale);
        } catch {}
      }, 50);
    el.addEventListener("pointerup", check);
    el.addEventListener("touchend", check);
    el.addEventListener("dblclick", check);
    el.addEventListener("wheel", check, { passive: true });
    window.addEventListener("pointerup", check);
    return () => {
      window.removeEventListener("pointerup", check);
      el.removeEventListener("dblclick", check);
      el.removeEventListener("pointerup", check);
      el.removeEventListener("touchend", check);
      el.removeEventListener("wheel", check);
    };
  }, []);
  useEffect(() => setManualScale(false), [coin, frame, mode]);
  const autoScale = () => {
    chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
    setManualScale(false);
  };

  const zoom = (k: "in" | "out" | "reset") => {
    const c = chartRef.current;
    if (!c) return;
    const ts = c.timeScale();
    if (k === "reset") {
      const n = rowsRef.current.length;
      ts.setVisibleLogicalRange({ from: Math.max(0, n - 120), to: n + 4 });
      c.priceScale("right").applyOptions({ autoScale: true });
      setManualScale(false);
      return;
    }
    const r = ts.getVisibleLogicalRange();
    if (!r) return;
    const width = Math.max(10, (r.to - r.from) * (k === "in" ? 0.6 : 1.6));
    ts.setVisibleLogicalRange({ from: r.to - width, to: r.to });
  };

  const chg = legend && legend.o > 0 ? (legend.c / legend.o - 1) * 100 : null;
  const tone = chg === null ? "" : chg >= 0 ? "text-up" : "text-danger";
  const shownInds = useMemo(() => inds.filter((i) => i.kind !== "vol").length, [inds]);

  return (
    <div className="flex flex-col gap-2.5 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
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
        <div className="flex bg-night rounded-full p-1" role="group" aria-label="Chart type">
          {(["candles", "line"] as Mode[]).map((m) => (
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
        <button
          type="button"
          onClick={() => setPicker(true)}
          className="h-10 px-3.5 rounded-full bg-night text-[0.8125rem] font-semibold flex items-center gap-1.5 hover:text-ink text-ink-2"
          aria-haspopup="dialog"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M3 17l5-6 4 4 8-10" />
            <path d="M3 21h18" />
          </svg>
          Indicators{shownInds ? ` · ${shownInds}` : ""}
        </button>
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
        <span className={"ml-auto flex items-center gap-1.5 text-[0.75rem] " + (live ? "text-up" : "text-ink-3")} title={live ? "Prices stream live" : "Updating every few seconds"}>
          <span className={"w-2 h-2 rounded-full " + (live ? "bg-up animate-pulse" : "bg-ink-3")} aria-hidden="true" />
          {live ? "Live" : "Connecting…"}
        </span>
      </div>

      <div className="relative w-full" style={{ height: height + (hasRsi ? RSI_PANE_PX : 0) }}>
        <div ref={box} className="absolute inset-0" />
        {legend && (
          <div className="absolute left-1 top-0 z-[2] pointer-events-none text-[0.6875rem] sm:text-[0.75rem] font-mono tabular-nums leading-5 bg-surface/70 rounded-md px-1 max-w-[calc(100%-5rem)]">
            <div className="flex flex-wrap gap-x-2">
              <span className="text-ink-3">{new Date(legend.t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</span>
              <span>O <b className={tone}>{fmtPx(legend.o, decimals)}</b></span>
              <span>H <b className={tone}>{fmtPx(legend.h, decimals)}</b></span>
              <span>L <b className={tone}>{fmtPx(legend.l, decimals)}</b></span>
              <span>C <b className={tone}>{fmtPx(legend.c, decimals)}</b></span>
              {chg !== null && <b className={tone}>{`${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(2)}%`}</b>}
              {inds.some((i) => i.kind === "vol") && <span className="text-ink-3">Vol {compactUsd(legend.v)}</span>}
            </div>
            {legend.ind.length > 0 && (
              <div className="flex flex-wrap gap-x-2">
                {legend.ind.map((x, i) => (
                  <span key={i} style={{ color: x.color }}>
                    {x.label} {x.value}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        {empty && <div className="absolute inset-0 grid place-items-center text-ink-3 text-[0.875rem] pointer-events-none">No price data yet.</div>}
        {manualScale && (
          <button
            type="button"
            onClick={autoScale}
            title="Fit the prices on screen again"
            className="absolute right-16 bottom-8 z-[2] h-7 px-2.5 rounded-lg bg-surface border border-line text-[0.75rem] font-semibold text-ink-2 hover:text-ink shadow-sm"
          >
            Auto
          </button>
        )}
      </div>

      {picker && <IndicatorSheet inds={inds} onChange={changeInds} onClose={() => setPicker(false)} />}
    </div>
  );
}

function fmtOrDash(v: number | null, dec: number) {
  return v === null || !Number.isFinite(v) ? "—" : fmtPx(v, dec);
}

// ------------------------------------------------------------------ the picker

function IndicatorSheet({ inds, onChange, onClose }: { inds: Indicator[]; onChange: (l: Indicator[]) => void; onClose: () => void }) {
  const add = (kind: IndKind) => {
    if (inds.length >= MAX_INDICATORS) return;
    const info = IND_INFO[kind];
    const used = new Set(inds.map((i) => i.color));
    const color = kind === "vol" ? "#64748b" : (IND_COLORS.find((c) => !used.has(c)) ?? IND_COLORS[inds.length % IND_COLORS.length]);
    // a second MA starts at a different length than the first (20, then 50, 100, 200)
    let period = info.period;
    if (kind === "ma" || kind === "ema") {
      const taken = new Set(inds.filter((i) => i.kind === kind).map((i) => i.period));
      period = [info.period, 50, 100, 200, 9, 12, 26].find((p) => !taken.has(p)) ?? info.period;
    }
    let id = `${kind}${Date.now().toString(36).slice(-6)}`;
    while (inds.some((i) => i.id === id)) id += "x";
    const ind: Indicator = { id, kind, period: kind === "vol" ? 0 : period, color };
    if (kind === "bb") ind.mult = info.mult;
    onChange([...inds, ind]);
  };
  const patch = (id: string, p: Partial<Indicator>) => onChange(inds.map((i) => (i.id === id ? { ...i, ...p } : i)));
  const remove = (id: string) => onChange(inds.filter((i) => i.id !== id));

  return (
    <Sheet title="Indicators" onClose={onClose}>
      <div className="flex flex-col gap-4 pb-4">
        <div>
          <h3 className="text-[0.75rem] font-semibold uppercase tracking-wide text-ink-3 mb-2">On the chart</h3>
          {inds.length === 0 ? (
            <p className="text-[0.875rem] text-ink-3">Nothing yet. Add one below.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {inds.map((i) => (
                <IndRow key={i.id} ind={i} onPatch={(p) => patch(i.id, p)} onRemove={() => remove(i.id)} />
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="text-[0.75rem] font-semibold uppercase tracking-wide text-ink-3 mb-2">Add</h3>
          <ul className="flex flex-col gap-1.5">
            {(Object.keys(IND_INFO) as IndKind[]).map((k) => {
              const off = inds.length >= MAX_INDICATORS || (k === "vol" && inds.some((i) => i.kind === "vol"));
              return (
                <li key={k}>
                  <button
                    type="button"
                    disabled={off}
                    onClick={() => add(k)}
                    className="w-full text-left rounded-2xl border border-line px-3.5 py-2.5 hover:border-ink-3 disabled:opacity-40 flex items-center gap-3"
                  >
                    <span className="w-9 h-9 rounded-xl bg-paper grid place-items-center text-[0.75rem] font-bold shrink-0">{IND_INFO[k].short}</span>
                    <span className="min-w-0">
                      <span className="block font-semibold text-[0.875rem]">{IND_INFO[k].name}</span>
                      <span className="block text-[0.75rem] text-ink-3">{IND_INFO[k].help}</span>
                    </span>
                    <span className="ml-auto text-[1.25rem] text-ink-3" aria-hidden="true">
                      +
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[0.75rem] text-ink-3">Add the same one more than once with different lengths, like MA 50 and MA 100. Your picks are saved on this device.</p>
        </div>
      </div>
    </Sheet>
  );
}

function IndRow({ ind, onPatch, onRemove }: { ind: Indicator; onPatch: (p: Partial<Indicator>) => void; onRemove: () => void }) {
  const info = IND_INFO[ind.kind];
  // typed text is kept as is until it's a valid number, so clearing the box to type "50" works
  const [period, setPeriod] = useState(String(ind.period));
  const [mult, setMult] = useState(String(ind.mult ?? 2));
  const commitPeriod = (t: string) => {
    setPeriod(t);
    const n = Math.round(Number(t));
    if (t !== "" && Number.isFinite(n) && n >= info.min && n <= info.max) onPatch({ period: n });
  };
  const commitMult = (t: string) => {
    setMult(t);
    const n = Number(t);
    if (t !== "" && Number.isFinite(n) && n >= 0.5 && n <= 5) onPatch({ mult: Math.round(n * 10) / 10 });
  };
  const nextColor = () => {
    const i = IND_COLORS.indexOf(ind.color);
    onPatch({ color: IND_COLORS[(i + 1) % IND_COLORS.length] });
  };
  return (
    <li className="flex items-center gap-2 rounded-2xl bg-paper px-3 py-2">
      <button type="button" onClick={nextColor} aria-label="Change color" title="Change color" className="w-6 h-6 rounded-full shrink-0 border border-line" style={{ background: ind.color }} />
      <span className="font-semibold text-[0.875rem] w-12 shrink-0">{info.short}</span>
      {ind.kind !== "vol" ? (
        <label className="flex items-center gap-1 text-[0.75rem] text-ink-3">
          Length
          <input
            value={period}
            onChange={(e) => commitPeriod(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
            onBlur={() => setPeriod(String(ind.period))}
            inputMode="numeric"
            aria-label={`${info.short} length`}
            className="w-14 h-9 rounded-lg border border-line bg-surface px-2 text-[0.875rem] text-ink font-mono outline-none focus:border-ink-3"
          />
        </label>
      ) : (
        <span className="text-[0.75rem] text-ink-3">Bars under the prices</span>
      )}
      {ind.kind === "bb" && (
        <label className="flex items-center gap-1 text-[0.75rem] text-ink-3">
          Width
          <input
            value={mult}
            onChange={(e) => commitMult(e.target.value.replace(/[^0-9.]/g, "").slice(0, 3))}
            onBlur={() => setMult(String(ind.mult ?? 2))}
            inputMode="decimal"
            aria-label="Bollinger width in standard deviations"
            className="w-12 h-9 rounded-lg border border-line bg-surface px-2 text-[0.875rem] text-ink font-mono outline-none focus:border-ink-3"
          />
        </label>
      )}
      <button type="button" onClick={onRemove} aria-label={`Remove ${indLabel(ind)}`} className="ml-auto w-9 h-9 rounded-full text-ink-3 hover:text-danger text-[1.25rem] leading-none">
        ×
      </button>
    </li>
  );
}
