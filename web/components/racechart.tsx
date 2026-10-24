"use client";

import { useEffect, useState } from "react";
import { ProChart } from "./perpschart";
import { LiveChart, type LiveRange, type LiveTrade } from "./livechart";
import { fetchRaceCandles, fetchRaceTrades, fmtPrice, type RaceCandle } from "@/lib/race";
import { useWallet } from "./wallet";
import { useFollowing, useProfiles } from "@/lib/social";
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
/** The live line (default) or the Pro chart (candles, indicators): remembered on this device. */
const VIEW_KEY = "sasa-chart-view";

/** The "All" range: candles small enough to show the coin's whole life in a few hundred points. */
function allFrame(sinceMs: number | undefined, frames: number[]): number {
  const age = sinceMs ? Math.max(60, (Date.now() - sinceMs) / 1000) : 7 * 86400;
  return frames.find((f) => age / f <= 400) ?? frames[frames.length - 1];
}

/**
 * Price chart of one race coin (dollars per coin). Line or candles, six time frames.
 * Draws from the cache at once, then refreshes every 5 s and right after the user trades.
 */
/** A buy at least this big shows as a whale on the line. */
const WHALE_USD = 500;

/**
 * The latest trades of a race coin for the live line, polled every few seconds: who they were
 * (the creator, you, people you follow, whales) is worked out here.
 */
function useLiveTrades(coinId: string, chainId: number | null, creator?: string): LiveTrade[] | undefined {
  const { address: me } = useWallet();
  const following = useFollowing();
  const [rows, setRows] = useState<Awaited<ReturnType<typeof fetchRaceTrades>> | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetchRaceTrades(coinId, 60).then((r) => alive && setRows(r)).catch(() => {});
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 3_000);
    const stop = onTrade((s) => s.coinId.toLowerCase() === coinId.toLowerCase() && [1200, 3000].forEach((d) => setTimeout(load, d)));
    return () => {
      alive = false;
      clearInterval(t);
      stop();
    };
  }, [coinId]);
  const followedHere = (rows ?? []).map((r) => r.trader.toLowerCase()).filter((a) => following.set.has(a));
  const profiles = useProfiles([...new Set(followedHere)]);
  if (!rows) return undefined;
  const dev = creator?.toLowerCase();
  const mine = me?.toLowerCase();
  return rows
    .filter((r) => chainId === null || r.chain.chainId === chainId)
    .map((r) => {
      const a = r.trader.toLowerCase();
      const name = profiles.get(a)?.username ?? null;
      const who: LiveTrade["who"] =
        a === dev ? "dev" : a === mine ? "you" : following.set.has(a) ? "follow" : r.isBuy && r.usd >= WHALE_USD ? "whale" : null;
      return { id: `${r.txHash}:${r.logIndex}`, t: r.ts, buy: r.isBuy, usd: r.usd, who, label: name ? name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2) : a.slice(2, 4) };
    });
}

export function RaceChart({
  coinId,
  chainId,
  height = 360,
  supply = RACE_SUPPLY,
  creator,
  since,
}: {
  coinId: string;
  chainId: number | null;
  height?: number;
  supply?: number;
  /** the coin's creator (shown as DEV on the line) */
  creator?: string;
  /** launch time (ms) */
  since?: number;
}) {
  const trades = useLiveTrades(coinId, chainId, creator);
  return (
    <PriceChart
      trades={trades}
      since={since}
      cacheKey={`${coinId}:${chainId ?? "all"}`}
      load={(frame) => fetchRaceCandles(coinId, chainId, frame)}
      tradeCoinId={coinId}
      mcFactor={supply}
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
  trades,
  since,
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
  /** sasa's own coins: the latest trades, drawn on the live line */
  trades?: LiveTrade[];
  /** when the coin started trading (ms): sizes the "All" range */
  since?: number;
}) {
  const [value, setValue] = useState<Value>("mc");
  const [pro, setPro] = useState(false);
  useEffect(() => {
    try {
      setPro(localStorage.getItem(VIEW_KEY) === "pro");
    } catch {}
  }, []);
  const choose = (p: boolean) => {
    setPro(p);
    try {
      localStorage.setItem(VIEW_KEY, p ? "pro" : "live");
    } catch {}
  };
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
  const valueToggle =
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
    ) : null;
  const viewButton = (toPro: boolean) => (
    <button
      type="button"
      onClick={() => choose(toPro)}
      className="h-10 px-3.5 rounded-full border border-line text-[0.8125rem] font-semibold text-ink-2 hover:text-ink"
      aria-label={toPro ? "Show candles and indicators" : "Show the live line"}
    >
      {toPro ? "Candles" : "Live line"}
    </button>
  );
  if (!pro) {
    const frames = seconds ? [1, 15, 60, 300, 900, 3600, 14400, 86400] : [60, 300, 900, 3600, 14400, 86400];
    const ranges: LiveRange[] = seconds
      ? [
          { label: "5m", frame: 1, span: 300 },
          { label: "1h", frame: 15, span: 3600 },
          { label: "1D", frame: 300, span: 86400 },
          { label: "All", frame: allFrame(since, frames), span: null },
        ]
      : [
          { label: "1h", frame: 60, span: 3600 },
          { label: "6h", frame: 300, span: 21600 },
          { label: "1D", frame: 900, span: 86400 },
          { label: "1W", frame: 14400, span: 604800 },
        ];
    return (
      <LiveChart
        key={k === 1 ? "price" : "mc"}
        cacheKey={`${cacheKey}:${k === 1 ? "price" : `mc${Number(k.toPrecision(3))}`}`}
        load={load}
        ranges={ranges}
        defaultRange={seconds ? "All" : "1D"}
        format={k === 1 ? fmtPrice : compactUsd}
        height={Math.min(height, 340)}
        refreshMs={refreshMs}
        refreshOn={refreshOn}
        trades={trades}
        emptyText={emptyText}
        onFail={onFail}
        bleed={bleed}
        toolbarStart={valueToggle}
        toolbarEnd={viewButton(true)}
      />
    );
  }
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
        <>
          {valueToggle}
          {viewButton(false)}
        </>
      }
    />
  );
}
