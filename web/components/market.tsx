"use client";

import { useEffect, useRef, useState } from "react";
import type { IChartApi, UTCTimestamp } from "lightweight-charts";
import { burst, onTrade } from "@/lib/live";
import { chainById, explorerAddress, explorerTx } from "@/lib/config";
import { fetchCandles, fetchTopHolders, fetchTrades, type Coin, type CurveInfo, type Trade } from "@/lib/data";
import { fmtTokens, shortAddr } from "@/lib/format";
import { ChainChip, timeAgo, usd } from "./coins";

const RANGES = [
  { label: "1m", s: 60 },
  { label: "5m", s: 300 },
  { label: "15m", s: 900 },
  { label: "1h", s: 3600 },
  { label: "4h", s: 14400 },
  { label: "1d", s: 86400 },
];

/** Chart view settings, remembered between visits. */
type ChartPrefs = { range: number; volume: boolean; mode: "normal" | "log" | "percent"; auto: boolean };
const PREFS_KEY = "sasa-chart";
function loadPrefs(): ChartPrefs {
  const d: ChartPrefs = { range: 300, volume: true, mode: "normal", auto: true };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<ChartPrefs>) };
  } catch {
    return d;
  }
}
// lightweight-charts PriceScaleMode: 0 normal, 1 logarithmic, 2 percentage.
const SCALE_MODE = { normal: 0, log: 1, percent: 2 } as const;

/**
 * Market-value candles for one curve (price x 1B supply, in dollars when a
 * price is available, otherwise in the chain's coin).
 */
export function PriceChart({ curve, ethUsd }: { curve: CurveInfo; ethUsd: number | null }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [prefs, setPrefs] = useState<ChartPrefs>({ range: 300, volume: true, mode: "normal", auto: true });
  const range = prefs.range;
  const volRef = useRef<{ applyOptions: (o: { visible: boolean }) => void } | null>(null);
  const [empty, setEmpty] = useState(false);
  const setPref = (p: Partial<ChartPrefs>) =>
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  useEffect(() => setPrefs(loadPrefs()), []);
  const unit = ethUsd ? "$" : curve.chain.chain.nativeCurrency.symbol;

  useEffect(() => {
    if (!box.current) return;
    let alive = true;
    let chart: IChartApi | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopSignal: (() => void) | null = null;
    let stopBurst: (() => void) | null = null;
    (async () => {
      // The chart library is only downloaded on pages that show a chart.
      const { createChart, CandlestickSeries, HistogramSeries } = await import("lightweight-charts");
      if (!alive || !box.current) return;
      chart = createChart(box.current, {
        autoSize: true,
        layout: { background: { color: "transparent" }, textColor: "#8f7f73", fontFamily: "IBM Plex Mono, monospace", fontSize: 11 },
        grid: { vertLines: { color: "rgba(143,127,115,0.12)" }, horzLines: { color: "rgba(143,127,115,0.12)" } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
        crosshair: { mode: 1 },
      });
      const candles = chart.addSeries(CandlestickSeries, {
        upColor: "#1f9d74",
        downColor: "#c2553a",
        wickUpColor: "#1f9d74",
        wickDownColor: "#c2553a",
        borderVisible: false,
        priceFormat: { type: "custom", minMove: 0.0001, formatter: (p: number) => fmtMoney(p, unit) },
      });
      const vol = chart.addSeries(HistogramSeries, {
        priceScaleId: "",
        priceFormat: { type: "volume" },
        color: "rgba(31,157,116,0.35)",
        lastValueVisible: false,
        priceLineVisible: false,
      });
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volRef.current = vol;
      chartRef.current = chart;

      let first = true;
      let lastBar: { time: UTCTimestamp; open: number; high: number; low: number; close: number } | null = null;
      const load = async () => {
        try {
          const rows = await fetchCandles(curve.chain.chain.id, curve.curve, range);
          if (!alive) return;
          const k = 1e9 * (ethUsd ?? 1);
          setEmpty(rows.length === 0);
          const bars = rows.map((r) => ({ time: r.t as UTCTimestamp, open: r.open * k, high: r.high * k, low: r.low * k, close: r.close * k }));
          candles.setData(bars);
          lastBar = bars.length ? bars[bars.length - 1] : null;
          vol.setData(
            rows.map((r) => ({ time: r.t as UTCTimestamp, value: r.volume * (ethUsd ?? 1), color: r.close >= r.open ? "rgba(31,157,116,0.35)" : "rgba(194,85,58,0.35)" }))
          );
          if (first && chart) {
            chart.timeScale().fitContent();
            first = false;
          }
        } catch {
          /* next refresh */
        }
      };
      await load();
      timer = setInterval(load, 6_000);

      // A trade on this curve: move the last candle now, then fetch the real data.
      stopSignal = onTrade((sig) => {
        if (!alive || sig.chainId !== curve.chain.chain.id || sig.curve.toLowerCase() !== curve.curve.toLowerCase()) return;
        if (sig.nativePerToken !== null) {
          const price = sig.nativePerToken * 1e9 * (ethUsd ?? 1);
          const bucket = (Math.floor(Date.now() / 1000 / range) * range) as UTCTimestamp;
          const bar =
            lastBar && lastBar.time === bucket
              ? { ...lastBar, high: Math.max(lastBar.high, price), low: Math.min(lastBar.low, price), close: price }
              : { time: bucket, open: lastBar?.close ?? price, high: Math.max(lastBar?.close ?? price, price), low: Math.min(lastBar?.close ?? price, price), close: price };
          if (!lastBar || bar.time >= lastBar.time) {
            candles.update(bar);
            lastBar = bar;
            setEmpty(false);
          }
        }
        stopBurst?.();
        stopBurst = burst(() => void load());
      });
    })();
    return () => {
      alive = false;
      stopSignal?.();
      stopBurst?.();
      if (timer) clearInterval(timer);
      chart?.remove();
      chartRef.current = null;
      volRef.current = null;
    };
  }, [curve.chain.chain.id, curve.curve, range, ethUsd, unit]);

  // Scale mode, auto-fit and the volume bars follow the toggles without rebuilding the chart.
  useEffect(() => {
    const apply = () => {
      const chart = chartRef.current;
      if (!chart) return false;
      chart.priceScale("right").applyOptions({ mode: SCALE_MODE[prefs.mode], autoScale: prefs.auto });
      volRef.current?.applyOptions({ visible: prefs.volume });
      return true;
    };
    if (apply()) return;
    // The chart loads asynchronously; try again once it's there.
    const t = setInterval(() => apply() && clearInterval(t), 200);
    return () => clearInterval(t);
  }, [prefs.mode, prefs.auto, prefs.volume, range, curve.curve]);

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="hidden sm:inline text-[0.8125rem] font-semibold text-ink-2">Market value on {curve.chain.short}</span>
        <div className="flex gap-1 overflow-x-auto no-scrollbar" role="tablist" aria-label="Candle size">
          {RANGES.map((r) => (
            <button
              key={r.s}
              type="button"
              role="tab"
              aria-selected={range === r.s}
              onClick={() => setPref({ range: r.s })}
              className={"h-7 min-w-9 px-2 rounded-lg font-mono text-[0.75rem] shrink-0 " + (range === r.s ? "bg-ink text-mist" : "text-ink-2 hover:text-ink")}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="relative h-[280px] sm:h-[360px]">
        <div ref={box} className="absolute inset-0" />
        {empty && (
          <div className="absolute inset-0 flex items-center justify-center text-[0.875rem] text-ink-3">No trades yet. The first buy starts the chart.</div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 mt-2 text-[0.75rem] font-mono">
        <button
          type="button"
          aria-pressed={prefs.volume}
          onClick={() => setPref({ volume: !prefs.volume })}
          className={"h-7 px-2.5 rounded-lg " + (prefs.volume ? "bg-paper text-ink" : "text-ink-3")}
        >
          Volume
        </button>
        <div className="flex gap-1">
          <button type="button" aria-pressed={prefs.mode === "percent"} title="Percent scale" onClick={() => setPref({ mode: prefs.mode === "percent" ? "normal" : "percent" })} className={"h-7 min-w-8 px-2 rounded-lg " + (prefs.mode === "percent" ? "bg-paper text-ink" : "text-ink-3")}>
            %
          </button>
          <button type="button" aria-pressed={prefs.mode === "log"} title="Logarithmic scale" onClick={() => setPref({ mode: prefs.mode === "log" ? "normal" : "log" })} className={"h-7 px-2 rounded-lg " + (prefs.mode === "log" ? "bg-paper text-ink" : "text-ink-3")}>
            log
          </button>
          <button type="button" aria-pressed={prefs.auto} title="Fit prices to the view" onClick={() => setPref({ auto: !prefs.auto })} className={"h-7 px-2 rounded-lg " + (prefs.auto ? "bg-paper text-ink" : "text-ink-3")}>
            auto
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtMoney(v: number, unit: string) {
  const s =
    v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(2)}K` : v >= 1 ? v.toFixed(2) : v.toPrecision(3);
  return unit === "$" ? `$${s}` : `${s} ${unit}`;
}

/** Live list of buys and sells. Pass a coinId for one coin, or nothing for the whole site. */
/** Buybacks send coins to the burn address; show them as what they are. */
const isBurn = (a: string) => a.toLowerCase() === "0x000000000000000000000000000000000000dead";

export function TradesFeed({ coinId, trader, names, ethUsd, limit = 25, compact = false }: {
  coinId?: string;
  trader?: string;
  names?: Map<string, { name: string; symbol: string; href: string }>;
  ethUsd: number | null;
  limit?: number;
  compact?: boolean;
}) {
  const [rows, setRows] = useState<Trade[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchTrades({ coinId, trader, limit })
        .then((r) => alive && setRows(r))
        .catch(() => {});
    load();
    const t = setInterval(load, 5_000);
    // After a trade, refresh a few times quickly while the indexer catches up.
    let stopBurst: (() => void) | null = null;
    const stopSignal = onTrade((sig) => {
      if (coinId && sig.coinId !== coinId) return;
      stopBurst?.();
      stopBurst = burst(load);
    });
    return () => {
      alive = false;
      clearInterval(t);
      stopSignal();
      stopBurst?.();
    };
  }, [coinId, trader, limit]);

  if (!rows) return <div className="h-40 rounded-2xl bg-line/50 animate-pulse" />;
  if (rows.length === 0) return <p className="text-[0.875rem] text-ink-3 py-6 text-center">No trades yet.</p>;
  return (
    <ul className="divide-y divide-mist">
      {rows.map((t) => {
        const chain = chainById(t.chainId);
        const eth = t.nativeAmount / 1e18;
        const n = names?.get(t.coinId);
        return (
          <li key={t.txHash + t.curve} className="flex items-center gap-3 py-2.5 text-[0.8125rem]">
            <span className={"w-12 shrink-0 font-semibold " + (isBurn(t.trader) ? "text-mint" : t.isBuy ? "text-up" : "text-danger")}>
              {isBurn(t.trader) ? "Burn" : t.isBuy ? "Buy" : "Sell"}
            </span>
            {!compact && chain && <ChainChip chain={chain} />}
            <span className="min-w-0 flex-1 truncate">
              {n ? (
                <a href={n.href} className="font-semibold text-ink">${n.symbol}</a>
              ) : (
                <span className="font-mono text-ink-2">{fmtTokens(BigInt(Math.round(t.tokenAmount)))}</span>
              )}
              {chain && (
                <a className="font-mono text-ink-3 ml-2" href={explorerAddress(chain, t.trader)} target="_blank" rel="noreferrer">
                  {isBurn(t.trader) ? <span className="font-sans font-semibold text-mint">🔥 Buyback</span> : shortAddr(t.trader)}
                </a>
              )}
            </span>
            <span className="font-mono text-right">{ethUsd ? usd(eth * ethUsd, 2) : `${eth.toFixed(5)} ETH`}</span>
            <span className="w-16 text-right text-ink-3 shrink-0">
              {chain ? (
                <a href={explorerTx(chain, t.txHash)} target="_blank" rel="noreferrer">{timeAgo(t.ts)}</a>
              ) : (
                timeAgo(t.ts)
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Biggest holders on one chain, leaving out the curve itself and burn addresses. */
export function TopHolders({ curve }: { curve: CurveInfo }) {
  const [rows, setRows] = useState<{ holder: string; amount: number }[] | null>(null);
  useEffect(() => {
    let alive = true;
    const exclude = [curve.curve, curve.chain.poolManager, "0x000000000000000000000000000000000000dead"];
    const load = () =>
      fetchTopHolders(curve.chain.chain.id, curve.token, exclude)
        .then((r) => alive && setRows(r))
        .catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [curve.chain.chain.id, curve.token, curve.curve, curve.chain.poolManager]);
  if (!rows) return <div className="h-32 rounded-2xl bg-line/50 animate-pulse" />;
  if (rows.length === 0) return <p className="text-[0.875rem] text-ink-3">No holders yet.</p>;
  return (
    <ol className="grid gap-2 text-[0.8125rem]">
      {rows.map((r, i) => (
        <li key={r.holder} className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <span className="w-5 text-ink-3 font-mono">{i + 1}</span>
            <a className="font-mono" href={explorerAddress(curve.chain, r.holder)} target="_blank" rel="noreferrer">{shortAddr(r.holder)}</a>
          </span>
          <span className="font-mono text-ink-2">{((r.amount / 1e9) * 100).toFixed(2)}%</span>
        </li>
      ))}
    </ol>
  );
}

export function CoinStats({ coin, ethUsd }: { coin: Coin; ethUsd: number | null }) {
  const items = [
    ["Holders", String(coin.holders)],
    ["Trades 24h", String(coin.trades24h)],
    ["Buys / sells 24h", `${coin.buys24h} / ${coin.sells24h}`],
    ["Volume 24h", ethUsd ? usd(coin.volumeNative24h * ethUsd, 2) : `${coin.volumeNative24h.toFixed(4)} ETH`],
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {items.map(([l, v]) => (
        <div key={l} className="bg-surface border border-line rounded-2xl p-3.5">
          <div className="text-[0.75rem] text-ink-3">{l}</div>
          <div className="font-mono text-[1.0625rem] mt-0.5">{v}</div>
        </div>
      ))}
    </div>
  );
}
