"use client";

import { useState } from "react";
import { ProChart } from "./perpschart";
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
/** Market cap (price x supply) or price per coin. */
type Value = "mc" | "price";
/** Every race coin has a billion. */
const RACE_SUPPLY = 1_000_000_000;
const PREFS = "sasa-race-chart";

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
      seconds
      bleed
    />
  );
}

/**
 * sasa's own price chart, for any coin: `load` returns the candles of one time frame
 * (seconds), oldest first. Refreshes every `refreshMs` and right after the user trades the coin;
 * `onFail` is called when the first load fails (the caller can show something else instead).
 * Same chart as Futures (components/perpschart.tsx): indicators, OHLC legend, zoom, Auto scale.
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
  seconds = false,
  bleed = false,
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
  /** offer 1s and 15s candles too (sasa's own coins: every trade is indexed) */
  seconds?: boolean;
  /** phones: edge to edge */
  bleed?: boolean;
}) {
  const [value, setValue] = useState<Value>("mc");
  const k = mcFactor && mcFactor > 0 && value === "mc" ? mcFactor : 1;
  const load = (frame: number) =>
    loadCandles(frame).then((rows) =>
      k === 1 ? rows : rows.map((r) => ({ ...r, open: r.open * k, high: r.high * k, low: r.low * k, close: r.close * k }))
    );
  const refreshOn = tradeCoinId
    ? (refresh: () => void) =>
        onTrade((s) => {
          if (s.coinId.toLowerCase() === tradeCoinId.toLowerCase()) refresh();
        })
    : undefined;
  return (
    <ProChart
      cacheKey={`${cacheKey}:${k === 1 ? "price" : `mc${Number(k.toPrecision(3))}`}`}
      load={load}
      refreshMs={refreshMs}
      refreshOn={refreshOn}
      frames={seconds ? [{ label: "1s", sec: 1 }, { label: "15s", sec: 15 }, ...FRAMES] : [...FRAMES]}
      defaultFrame={60}
      defaultMode="line"
      prefsKey={PREFS}
      format={k === 1 ? fmtPrice : compactUsd}
      height={height}
      emptyText={() => emptyText}
      onFail={onFail}
      bleed={bleed}
      toolbarStart={
        mcFactor && mcFactor > 0 ? (
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
        ) : null
      }
    />
  );
}
