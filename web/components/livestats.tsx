"use client";

/**
 * Live numbers for one coin: market cap, holders, volume and the buy / sell
 * balance. Refreshes every few seconds, and at once after a trade on this page.
 * Numbers that change flash green (up) or red (down).
 */
import { USD_MODE } from "@/lib/config";
import { useEffect, useRef, useState } from "react";
import { fetchCoin, type Coin } from "@/lib/data";
import { burst, onTrade } from "@/lib/live";
import { coinMarketCapUsd, compactUsd } from "./discover";
import { usd } from "./coins";

function useFlash(value: number | null): string {
  const prev = useRef<number | null>(value);
  const [cls, setCls] = useState("");
  useEffect(() => {
    if (value !== null && prev.current !== null && value !== prev.current) {
      setCls(value > prev.current ? "flash-up" : "flash-down");
      const t = setTimeout(() => setCls(""), 900);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);
  return cls;
}

function Stat({ label, value, raw, big = false }: { label: string; value: string; raw: number | null; big?: boolean }) {
  const flash = useFlash(raw);
  return (
    // Phones: label and value on one line (short boxes, the chart starts higher up);
    // wider screens: label above a bigger value.
    <div className="rounded-xl sm:rounded-2xl bg-paper border border-line px-2.5 py-1.5 sm:px-3 sm:py-2.5 min-w-0 flex items-baseline justify-between gap-1.5 sm:block">
      <div className="text-[0.6875rem] sm:text-[0.75rem] text-ink-3 truncate shrink-0">{label}</div>
      <div className={"font-mono font-medium sm:mt-0.5 truncate rounded text-right sm:text-left " + (big ? "text-[0.9375rem] sm:text-[1.3rem] " : "text-[0.875rem] sm:text-[1.0625rem] ") + flash}>
        {value}
      </div>
    </div>
  );
}

export function LiveStats({ coin: initial, ethUsd: initialUsd }: { coin: Coin; ethUsd: number | null }) {
  const [coin, setCoin] = useState(initial);
  const [ethUsd, setEthUsd] = useState(initialUsd);
  useEffect(() => setCoin(initial), [initial]);
  useEffect(() => setEthUsd(initialUsd), [initialUsd]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchCoin(initial.id)
        .then(({ coin, prices }) => {
          if (!alive || !coin) return;
          setCoin(coin);
          if (prices?.ETH) setEthUsd(prices.ETH);
        })
        .catch(() => {});
    const t = setInterval(() => document.visibilityState === "visible" && load(), 3000);
    let stop: (() => void) | null = null;
    const off = onTrade((s) => {
      if (s.coinId !== initial.id) return;
      stop?.();
      stop = burst(load, [500, 1500, 3000, 6000]);
    });
    return () => {
      alive = false;
      clearInterval(t);
      off();
      stop?.();
    };
  }, [initial.id]);

  const mc = coinMarketCapUsd(coin, ethUsd);
  const vol = ethUsd ? coin.volumeNative24h * ethUsd : null;
  const total = coin.buys24h + coin.sells24h;
  const buyShare = total > 0 ? coin.buys24h / total : 0.5;
  // The live summary has no 24h change; keep the list's value until it does.
  const change = coin.change24h ?? initial.change24h;

  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 sm:gap-2">
        <Stat label="Market cap" value={compactUsd(mc)} raw={mc} big />
        <Stat label="24h change" value={change === null ? "—" : `${change >= 0 ? "+" : "−"}${Math.abs(change * 100).toFixed(1)}%`} raw={change} />
        <Stat label="Holders" value={String(coin.holders)} raw={coin.holders} />
        <Stat label="Volume 24h" value={vol !== null ? usd(vol, vol < 100 ? 2 : 0) : USD_MODE ? "—" : `${coin.volumeNative24h.toFixed(3)} ETH`} raw={coin.volumeNative24h} />
      </div>
      <div className="rounded-2xl bg-paper border border-line px-3 py-2.5">
        <div className="flex items-center justify-between text-[0.75rem] sm:text-[0.8125rem] font-semibold">
          <span className="text-up">
            Buys {coin.buys24h} <span className="font-normal text-ink-3">({Math.round(buyShare * 100)}%)</span>
          </span>
          <span className="text-ink-3 font-normal hidden sm:inline">Last 24 hours · {total} trades</span>
          <span className="text-danger">
            <span className="font-normal text-ink-3">({Math.round((1 - buyShare) * 100)}%)</span> Sells {coin.sells24h}
          </span>
        </div>
        <div className="mt-2 h-2.5 rounded-full overflow-hidden flex bg-line" role="img" aria-label={`${Math.round(buyShare * 100)}% buys, ${Math.round((1 - buyShare) * 100)}% sells in the last 24 hours`}>
          <div className="h-full bg-up transition-[width] duration-500" style={{ width: `${buyShare * 100}%` }} />
          <div className="h-full bg-danger transition-[width] duration-500" style={{ width: `${(1 - buyShare) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
