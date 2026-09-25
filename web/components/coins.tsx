"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Coin, CurveInfo } from "@/lib/data";
import { fetchCoins, isImageUrl, coinHref, type SortKey } from "@/lib/data";
import type { NeuronChain } from "@/lib/config";
import { TARGET_USD } from "@/lib/config";
import { fmtEth } from "@/lib/format";

export function CoinAvatar({ logo, symbol, size = 48 }: { logo: string; symbol: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };
  if (logo && isImageUrl(logo) && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logo} alt="" style={style} className="rounded-2xl object-cover bg-mist shrink-0" onError={() => setBroken(true)} />;
  }
  const letter = (symbol || "?").slice(0, 1).toUpperCase();
  return (
    <span style={style} className="rounded-2xl bg-emerald-soft text-emerald-dark font-display font-semibold flex items-center justify-center shrink-0" aria-hidden="true">
      <span style={{ fontSize: size * 0.42 }}>{letter}</span>
    </span>
  );
}

export function ChainChip({ chain, muted = false }: { chain: NeuronChain; muted?: boolean }) {
  return (
    <span
      className={"inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px] font-semibold border " + (muted ? "border-line text-ink-3 bg-paper" : "border-transparent text-white")}
      style={muted ? undefined : { background: chain.color }}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" aria-hidden="true" />
      {chain.short}
    </span>
  );
}

export const usd = (n: number | null, digits = 0) =>
  n === null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;

export function ProgressBar({ coin, big = false }: { coin: Coin; big?: boolean }) {
  const pct = Math.round(coin.progress * 100);
  const done = !!coin.graduatedOn;
  return (
    <div>
      <div className={"flex justify-between items-baseline " + (big ? "text-[15px]" : "text-[13px]")}>
        <span className="font-semibold">{done ? "Graduated" : `${pct}% to graduation`}</span>
        <span className="text-ink-3 font-mono">
          {done ? `on ${coin.graduatedOn!.chain.short}` : `${usd(coin.totalUsd, 2)} / ${usd(TARGET_USD)}`}
        </span>
      </div>
      <div className={"mt-2 rounded-full bg-line/70 overflow-hidden " + (big ? "h-3" : "h-2")} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-emerald transition-all duration-700" style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
    </div>
  );
}

/** Each chain's share of the race, with the leader marked. */
export function ChainRace({ coin }: { coin: Coin }) {
  const total = coin.curves.reduce((s, c) => s + (c.usd ?? 0), 0);
  const leader = [...coin.curves].filter((c) => c.state === "trading").sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0];
  return (
    <ul className="grid gap-3">
      {coin.curves.map((c) => (
        <RaceRow key={c.chain.key} c={c} share={total > 0 ? (c.usd ?? 0) / total : 0} leading={!coin.graduatedOn && c === leader} />
      ))}
    </ul>
  );
}

function RaceRow({ c, share, leading }: { c: CurveInfo; share: number; leading: boolean }) {
  const label = c.state === "graduated" ? "Winner" : c.state === "closed" ? "Closed" : leading ? "Leading" : "";
  return (
    <li>
      <div className="flex items-center justify-between gap-3 text-[14px]">
        <span className="flex items-center gap-2">
          <ChainChip chain={c.chain} muted={c.state === "closed"} />
          {label && (
            <span className={"text-[12px] font-semibold " + (c.state === "graduated" || leading ? "text-emerald" : "text-ink-3")}>{label}</span>
          )}
        </span>
        <span className="font-mono text-ink-2">
          {usd(c.usd, 2)} <span className="text-ink-3">· {fmtEth(c.realNative, 5)}</span>
        </span>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-line/60 overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.round(share * 100)}%`, background: c.chain.color, opacity: c.state === "closed" ? 0.35 : 1 }} />
      </div>
    </li>
  );
}

export function CoinCard({ coin }: { coin: Coin }) {
  return (
    <Link href={coinHref(coin)} className="block bg-surface border border-line rounded-2xl p-4 sm:p-5 hover:border-emerald transition-colors">
      <div className="flex items-center gap-3.5">
        <CoinAvatar logo={coin.logo} symbol={coin.symbol} />
        <div className="min-w-0 flex-1">
          <div className="font-display font-semibold text-[17px] truncate">{coin.name}</div>
          <div className="text-[13px] text-ink-2">${coin.symbol} · {timeAgo(coin.createdAt)}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-3">
        {coin.curves.map((c) => (
          <ChainChip key={c.chain.key} chain={c.chain} muted={c.state === "closed"} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 mt-3 text-[12px] text-ink-3">
        <span><strong className="text-ink font-semibold">{coin.holders}</strong> holders</span>
        <span><strong className="text-ink font-semibold">{coin.trades24h}</strong> trades 24h</span>
        <span className="text-right">
          <strong className="text-emerald font-semibold">{coin.buys24h}</strong>/<strong className="text-danger font-semibold">{coin.sells24h}</strong> b/s
        </span>
      </div>
      <div className="mt-3 pt-3 border-t border-mist">
        <ProgressBar coin={coin} />
      </div>
    </Link>
  );
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function Stat({ label, value, dark = false }: { label: string; value: string; dark?: boolean }) {
  return (
    <div className="min-w-0">
      <div className={"text-[12px] " + (dark ? "text-[#a9bab3]" : "text-ink-3")}>{label}</div>
      <div className="font-mono text-[15px] truncate">{value}</div>
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={"animate-pulse rounded-2xl bg-line/60 " + className} />;
}

export function useCoins(sort: SortKey, search: string) {
  const [coins, setCoins] = useState<Coin[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setError("");
      const { coins } = await fetchCoins({ sort, search });
      setCoins(coins);
    } catch {
      setError("Could not load coins. Check your connection and try again.");
    }
  }, [sort, search]);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);
  return { coins, error, reload: load };
}
