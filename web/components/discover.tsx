"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { TARGET_USD, chainById } from "@/lib/config";
import { coinHref, fetchTrades, isImageUrl, marketCapNative, type Coin, type Trade } from "@/lib/data";
import { shortAddr } from "@/lib/format";
import { ChainChip, timeAgo, usd } from "./coins";

/** Market value in dollars: the biggest of the coin's chains (the one that matters). */
export function coinMarketCapUsd(coin: Coin, ethUsd: number | null): number | null {
  if (!ethUsd) return null;
  const caps = coin.curves.filter((c) => c.state !== "closed").map((c) => marketCapNative(c) * ethUsd);
  return caps.length ? Math.max(...caps) : null;
}

export function compactUsd(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(n < 10 ? 2 : 0)}`;
}

/** Deterministic artwork for coins without a picture. */
function hue(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function CoinArt({ coin, className = "", small = false }: { coin: Coin; className?: string; small?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (coin.logo && isImageUrl(coin.logo) && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={coin.logo} alt="" className={"w-full h-full object-cover " + className} onError={() => setBroken(true)} />;
  }
  const h = hue(coin.id);
  return (
    <div
      className={"w-full h-full flex items-center justify-center " + className}
      style={{ background: `radial-gradient(120% 90% at 20% 10%, hsl(${h} 70% 42%), hsl(${(h + 60) % 360} 60% 14%) 70%)` }}
    >
      <span className="font-display font-bold text-white/90" style={{ fontSize: small ? "22px" : "clamp(36px, 8vw, 84px)" }}>
        {(coin.symbol || "?").slice(0, 2).toUpperCase()}
      </span>
    </div>
  );
}

/** The progress bar, split by chain: each chain's share of the target in its own colour. */
export function RaceBar({ coin, thick = false }: { coin: Coin; thick?: boolean }) {
  const h = thick ? "h-3" : "h-2";
  if (coin.graduatedOn) {
    return (
      <div className={"w-full rounded-full overflow-hidden " + h} style={{ background: coin.graduatedOn.chain.color }} />
    );
  }
  let left = 100;
  return (
    <div className={"w-full rounded-full bg-line overflow-hidden flex " + h}>
      {coin.curves
        .filter((c) => c.state === "trading")
        .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
        .map((c) => {
          const w = Math.min(left, ((c.usd ?? 0) / TARGET_USD) * 100);
          left -= w;
          return <div key={c.chain.key} className="h-full" style={{ width: `${w}%`, background: c.chain.color }} />;
        })}
    </div>
  );
}

/** A coin card. Flashes when a new trade lands. */
export function CoinTile({ coin, ethUsd }: { coin: Coin; ethUsd: number | null }) {
  const last = useRef(coin.lastTradeAt);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (coin.lastTradeAt && last.current && coin.lastTradeAt !== last.current) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 2600);
      last.current = coin.lastTradeAt;
      return () => clearTimeout(t);
    }
    last.current = coin.lastTradeAt;
  }, [coin.lastTradeAt]);

  const pct = Math.round(coin.progress * 100);
  return (
    <Link
      href={coinHref(coin)}
      className={"group block rounded-3xl bg-surface border border-line p-2.5 sm:p-3 hover:border-emerald/60 transition-colors " + (flash ? "flash" : "")}
    >
      <div className="relative aspect-square rounded-2xl overflow-hidden bg-night">
        <CoinArt coin={coin} className="transition-transform duration-500 group-hover:scale-105" />
        <div className="absolute top-2 left-2 right-2 flex gap-1 overflow-hidden">
          {coin.curves.map((c) => (
            <span
              key={c.chain.key}
              className={"h-5 sm:h-6 px-1.5 sm:px-2 rounded-full text-[10px] sm:text-[11px] font-semibold flex items-center shrink-0 " + (c.state === "closed" ? "bg-black/60 text-white/60" : "text-white")}
              style={c.state === "closed" ? undefined : { background: c.chain.color }}
            >
              {c.chain.short}
            </span>
          ))}
        </div>
        {coin.graduatedOn ? (
          <span className="absolute bottom-2 right-2 h-6 px-2 rounded-full text-[11px] font-bold bg-emerald text-on-accent flex items-center">Graduated</span>
        ) : pct >= 80 ? (
          <span className="absolute bottom-2 right-2 h-6 px-2 rounded-full text-[11px] font-bold bg-warn-ink text-on-accent flex items-center">🔥 {pct}%</span>
        ) : null}
      </div>
      <div className="px-1.5 sm:px-2 pt-3 pb-1">
        <div className="font-display font-semibold text-[16px] sm:text-[19px] leading-tight truncate">{coin.name}</div>
        <div className="text-[12px] sm:text-[13px] text-ink-3 mt-0.5">${coin.symbol}</div>
        <div className="flex items-baseline gap-1.5 mt-2">
          <span className="font-display font-semibold text-[20px] sm:text-[24px]">{compactUsd(coinMarketCapUsd(coin, ethUsd))}</span>
          <span className="text-[11px] text-ink-3">MC</span>
        </div>
        <div className="flex justify-between text-[11px] sm:text-[12px] text-ink-3 mt-2 mb-1.5">
          <span>{coin.graduatedOn ? `Won on ${coin.graduatedOn.chain.short}` : "Graduation"}</span>
          <span className="font-mono text-ink-2">{pct}%</span>
        </div>
        <RaceBar coin={coin} />
        <div className="flex justify-between items-center text-[11px] sm:text-[12px] mt-3 pt-2.5 border-t border-line">
          <span className="font-mono text-ink-3 truncate">{coin.holders} holders · {shortAddr(coin.creator)}</span>
          <span className="text-emerald font-semibold shrink-0 ml-2">{timeAgo(coin.createdAt)}</span>
        </div>
      </div>
    </Link>
  );
}

/** The coins closest to graduating, big. */
export function GraduationRadar({ coins, ethUsd }: { coins: Coin[]; ethUsd: number | null }) {
  const top = coins
    .filter((c) => !c.graduatedOn && c.totalUsd !== null)
    .sort((a, b) => b.progress - a.progress)
    .slice(0, 3);
  if (top.length === 0) return null;
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {top.map((c, i) => {
        const left = Math.max(0, TARGET_USD - (c.totalUsd ?? 0));
        return (
          <Link key={c.id} href={coinHref(c)} className="flex gap-3 items-center rounded-2xl bg-surface border border-line p-3 hover:border-emerald/60">
            <div className="relative w-16 h-16 rounded-xl overflow-hidden shrink-0">
              <CoinArt coin={c} small />
              <span className="absolute bottom-0 left-0 right-0 text-center text-[10px] font-bold bg-black/60 text-white">#{i + 1}</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex justify-between items-baseline gap-2">
                <span className="font-semibold truncate">{c.name}</span>
                <span className="font-display font-semibold text-emerald">{Math.round(c.progress * 100)}%</span>
              </div>
              <div className="mt-2">
                <RaceBar coin={c} />
              </div>
              <div className="text-[12px] text-ink-3 mt-1.5 truncate">
                {left > 0 ? `${usd(left, 2)} to go` : "Graduating now"} · MC {compactUsd(coinMarketCapUsd(c, ethUsd))}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

/** Scrolling strip of the latest trades across the whole site. */
export function LiveTicker({ coins, ethUsd }: { coins: Coin[]; ethUsd: number | null }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchTrades({ limit: 24 })
        .then((t) => alive && setTrades(t))
        .catch(() => {});
    load();
    const t = setInterval(load, 6_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const byId = new Map(coins.map((c) => [c.id, c]));
  const items = trades
    .map((t) => ({ t, coin: byId.get(t.coinId), chain: chainById(t.chainId) }))
    .filter((x) => x.coin && x.chain);
  if (items.length === 0) return null;
  const row = items.map(({ t, coin, chain }) => (
    <Link key={t.txHash + t.curve} href={coinHref(coin!)} className="flex items-center gap-2 px-4 shrink-0 text-[13px]">
      <span className={t.isBuy ? "text-emerald font-semibold" : "text-danger font-semibold"}>{t.isBuy ? "BUY" : "SELL"}</span>
      <span className="font-semibold">${coin!.symbol}</span>
      <span className="font-mono text-ink-2">{ethUsd ? usd((t.nativeAmount / 1e18) * ethUsd, 2) : `${(t.nativeAmount / 1e18).toFixed(4)} ETH`}</span>
      <ChainChip chain={chain!} />
      <span className="text-ink-3">{timeAgo(t.ts)}</span>
      <span className="text-line">|</span>
    </Link>
  ));
  return (
    <div className="border-b border-line bg-paper overflow-hidden" aria-label="Latest trades">
      <div className="ticker-track flex w-max py-2">
        <div className="flex">{row}</div>
        <div className="flex" aria-hidden="true">{row}</div>
      </div>
    </div>
  );
}
