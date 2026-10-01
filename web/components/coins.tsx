"use client";

import { USD_MODE } from "@/lib/config";
import { toggleWatch, useWatchlist } from "@/lib/watchlist";

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
      className={"inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[0.75rem] font-semibold border " + (muted ? "border-line text-ink-3 bg-paper" : "border-transparent text-white")}
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
      <div className={"flex justify-between items-baseline " + (big ? "text-[0.9375rem]" : "text-[0.8125rem]")}>
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
  // After graduation the race is over: say who won, simply (no closed chains to decode).
  const winner = coin.curves.find((c) => c.state === "graduated");
  if (winner)
    return (
      <p className="flex items-center gap-2 text-[0.875rem]">
        <span aria-hidden="true">🎉</span>
        <span>
          Graduated on <b>{winner.chain.short}</b>. Liquidity is locked forever.
        </span>
      </p>
    );
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
      <div className="flex items-center justify-between gap-3 text-[0.875rem]">
        <span className="flex items-center gap-2">
          <ChainChip chain={c.chain} muted={c.state === "closed"} />
          {label && (
            <span className={"text-[0.75rem] font-semibold " + (c.state === "graduated" || leading ? "text-emerald" : "text-ink-3")}>{label}</span>
          )}
        </span>
        <span className="font-mono text-ink-2">
          {usd(c.usd, 2)}
          {/* Dollar edition: the amount already is dollars; don't say it twice. */}
          {!USD_MODE && <span className="text-ink-3"> · {fmtEth(c.realNative, 5)}</span>}
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
          <div className="font-display font-semibold text-[1.0625rem] truncate">{coin.name}</div>
          <div className="text-[0.8125rem] text-ink-2">${coin.symbol} · {timeAgo(coin.createdAt)}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-3">
        {coin.curves.map((c) => (
          <ChainChip key={c.chain.key} chain={c.chain} muted={c.state === "closed"} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 mt-3 text-[0.75rem] text-ink-3">
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
      <div className={"text-[0.75rem] " + (dark ? "text-[#a9bab3]" : "text-ink-3")}>{label}</div>
      <div className="font-mono text-[0.9375rem] truncate">{value}</div>
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={"shimmer rounded-2xl " + className} aria-hidden="true" />;
}

/** Placeholder shaped like an Explore coin tile (picture, name, MC line, bar). */
export function SkeletonTile() {
  return (
    <div className="rounded-3xl bg-surface border border-line p-2.5 sm:p-3" aria-hidden="true">
      <div className="shimmer aspect-square rounded-2xl" />
      <div className="px-1.5 sm:px-2 pt-3 pb-1">
        <div className="shimmer h-4 sm:h-5 w-3/4 rounded-md" />
        <div className="shimmer h-3 w-1/3 rounded-md mt-2" />
        <div className="flex items-end justify-between gap-2 mt-3">
          <div className="shimmer h-5 sm:h-6 w-2/5 rounded-md" />
          <div className="shimmer h-5 w-12 rounded-full" />
        </div>
        <div className="shimmer h-2 w-full rounded-full mt-3" />
      </div>
    </div>
  );
}

/** Placeholder rows: a round or square picture, two lines and a value on the right. */
export function SkeletonRows({ rows = 5, avatar = "round", className = "" }: { rows?: number; avatar?: "round" | "square" | "none"; className?: string }) {
  return (
    <ul className={"grid " + className} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-center gap-3 py-2.5">
          {avatar !== "none" && <span className={"shimmer w-9 h-9 shrink-0 " + (avatar === "round" ? "rounded-full" : "rounded-xl")} />}
          <span className="flex-1 min-w-0 grid gap-1.5">
            <span className="shimmer h-3.5 rounded-md" style={{ width: `${55 + ((i * 17) % 30)}%` }} />
            <span className="shimmer h-2.5 rounded-md" style={{ width: `${30 + ((i * 11) % 20)}%` }} />
          </span>
          <span className="shimmer h-4 w-16 rounded-md shrink-0" />
        </li>
      ))}
    </ul>
  );
}

export function useCoins(sort: SortKey, search: string) {
  const [coins, setCoins] = useState<Coin[] | null>(null);
  const [pages, setPages] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  // Reload every page shown so far (keeps the list fresh while scrolling).
  const load = useCallback(
    async (n: number) => {
      try {
        setError("");
        const all: Coin[] = [];
        let more = false;
        for (let p = 0; p < n; p++) {
          const r = await fetchCoins({ sort, search, page: p });
          all.push(...r.coins);
          more = r.hasMore;
          if (!r.hasMore) break;
        }
        setCoins(all);
        setHasMore(more);
      } catch {
        setError("Could not load coins. Check your connection and try again.");
      }
    },
    [sort, search]
  );

  useEffect(() => {
    setCoins(null);
    setPages(1);
    load(1);
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => load(pages), 12_000);
    return () => clearInterval(t);
  }, [load, pages]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    const next = pages + 1;
    setPages(next);
    await load(next);
    setLoadingMore(false);
  }, [load, pages]);

  return { coins, error, reload: () => load(pages), hasMore, loadMore, loadingMore };
}

/** 24 h price change: green up, red down, grey when there's no history yet. */
export function ChangeBadge({ value, className = "" }: { value: number | null; className?: string }) {
  if (value === null || !Number.isFinite(value)) return <span className={"font-mono text-ink-3 " + className}>—</span>;
  const pct = value * 100;
  const text = Math.abs(pct) >= 1000 ? `${(pct / 1000).toFixed(1)}K%` : `${Math.abs(pct) >= 100 ? pct.toFixed(0) : pct.toFixed(1)}%`;
  const up = pct > 0.05;
  const down = pct < -0.05;
  return (
    <span className={"font-mono tabular-nums " + (up ? "text-up" : down ? "text-danger" : "text-ink-3") + " " + className}>
      {up ? "+" : ""}
      {text}
    </span>
  );
}

/** ☆ / ★ favourite switch. */
export function StarButton({ coinId, className = "" }: { coinId: string; className?: string }) {
  const ids = useWatchlist();
  const on = ids.has(coinId);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleWatch(coinId);
      }}
      aria-pressed={on}
      aria-label={on ? "Remove from favourites" : "Add to favourites"}
      title={on ? "Remove from favourites" : "Add to favourites"}
      className={"w-9 h-9 rounded-xl border border-line flex items-center justify-center shrink-0 " + (on ? "text-mint" : "text-ink-3 hover:text-ink") + " " + className}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" />
      </svg>
    </button>
  );
}
