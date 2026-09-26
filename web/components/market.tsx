"use client";

import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, HistogramSeries, createChart, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { chainById, explorerAddress, explorerTx } from "@/lib/config";
import { fetchCandles, fetchTopHolders, fetchTrades, type Coin, type CurveInfo, type Trade } from "@/lib/data";
import { fmtTokens, shortAddr } from "@/lib/format";
import { ChainChip, timeAgo, usd } from "./coins";

const RANGES = [
  { label: "1m", s: 60 },
  { label: "5m", s: 300 },
  { label: "15m", s: 900 },
  { label: "1h", s: 3600 },
  { label: "1d", s: 86400 },
];

/**
 * Market-value candles for one curve (price x 1B supply, in dollars when a
 * price is available, otherwise in the chain's coin).
 */
export function PriceChart({ curve, ethUsd }: { curve: CurveInfo; ethUsd: number | null }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [range, setRange] = useState(300);
  const [empty, setEmpty] = useState(false);
  const unit = ethUsd ? "$" : curve.chain.chain.nativeCurrency.symbol;

  useEffect(() => {
    if (!box.current) return;
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#7b8c85", fontFamily: "IBM Plex Mono, monospace", fontSize: 11 },
      grid: { vertLines: { color: "rgba(127,150,140,0.12)" }, horzLines: { color: "rgba(127,150,140,0.12)" } },
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
    chartRef.current = chart;

    let alive = true;
    const load = async () => {
      try {
        const rows = await fetchCandles(curve.chain.chain.id, curve.curve, range);
        if (!alive) return;
        const k = 1e9 * (ethUsd ?? 1);
        setEmpty(rows.length === 0);
        candles.setData(
          rows.map((r) => ({ time: r.t as UTCTimestamp, open: r.open * k, high: r.high * k, low: r.low * k, close: r.close * k }))
        );
        vol.setData(
          rows.map((r) => ({ time: r.t as UTCTimestamp, value: r.volume * (ethUsd ?? 1), color: r.close >= r.open ? "rgba(31,157,116,0.35)" : "rgba(194,85,58,0.35)" }))
        );
      } catch {
        /* next refresh */
      }
    };
    load();
    const t = setInterval(load, 8_000);
    return () => {
      alive = false;
      clearInterval(t);
      chart.remove();
      chartRef.current = null;
    };
  }, [curve.chain.chain.id, curve.curve, range, ethUsd, unit]);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <span className="text-[13px] font-semibold text-ink-2">Market value on {curve.chain.short}</span>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.s}
              type="button"
              onClick={() => setRange(r.s)}
              className={"h-8 min-w-10 px-2 rounded-lg font-mono text-[12px] " + (range === r.s ? "bg-ink text-on-accent" : "bg-mist text-ink-2")}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="relative h-[300px] sm:h-[360px]">
        <div ref={box} className="absolute inset-0" />
        {empty && (
          <div className="absolute inset-0 flex items-center justify-center text-[14px] text-ink-3">No trades yet. The first buy starts the chart.</div>
        )}
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
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [coinId, trader, limit]);

  if (!rows) return <div className="h-40 rounded-2xl bg-line/50 animate-pulse" />;
  if (rows.length === 0) return <p className="text-[14px] text-ink-3 py-6 text-center">No trades yet.</p>;
  return (
    <ul className="divide-y divide-mist">
      {rows.map((t) => {
        const chain = chainById(t.chainId);
        const eth = t.nativeAmount / 1e18;
        const n = names?.get(t.coinId);
        return (
          <li key={t.txHash + t.curve} className="flex items-center gap-3 py-2.5 text-[13px]">
            <span className={"w-12 shrink-0 font-semibold " + (t.isBuy ? "text-emerald" : "text-danger")}>{t.isBuy ? "Buy" : "Sell"}</span>
            {!compact && chain && <ChainChip chain={chain} />}
            <span className="min-w-0 flex-1 truncate">
              {n ? (
                <a href={n.href} className="font-semibold text-ink">${n.symbol}</a>
              ) : (
                <span className="font-mono text-ink-2">{fmtTokens(BigInt(Math.round(t.tokenAmount)))}</span>
              )}
              {chain && (
                <a className="font-mono text-ink-3 ml-2" href={explorerAddress(chain, t.trader)} target="_blank" rel="noreferrer">
                  {shortAddr(t.trader)}
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
    const exclude = [curve.curve, "0x000000000000000000000000000000000000dead"];
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
  }, [curve.chain.chain.id, curve.token, curve.curve]);
  if (!rows) return <div className="h-32 rounded-2xl bg-line/50 animate-pulse" />;
  if (rows.length === 0) return <p className="text-[14px] text-ink-3">No holders yet.</p>;
  return (
    <ol className="grid gap-2 text-[13px]">
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
          <div className="text-[12px] text-ink-3">{l}</div>
          <div className="font-mono text-[17px] mt-0.5">{v}</div>
        </div>
      ))}
    </div>
  );
}
