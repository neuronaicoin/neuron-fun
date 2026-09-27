"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CoinAvatar, Skeleton, usd } from "@/components/coins";
import { CHAINS } from "@/lib/config";
import { coinHref, fetchStats, type DailyStat } from "@/lib/data";
import { fetchPrices } from "@/lib/price";
import { shortAddr } from "@/lib/format";

type Stats = Awaited<ReturnType<typeof fetchStats>>;
const RANGES = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All", days: 3650 },
];

function money(eth: number, ethUsd: number | null) {
  if (!ethUsd) return `${eth.toFixed(4)} ETH`;
  const v = eth * ethUsd;
  return v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : usd(v, 2);
}

/** Minimal bar chart: no chart library, so the page stays light. */
function Bars({ data, pick, color, format }: { data: DailyStat[]; pick: (d: DailyStat) => number; color: string; format: (v: number) => string }) {
  const values = data.map(pick);
  const max = Math.max(1e-12, ...values);
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? values.length - 1;
  return (
    <div>
      <div className="flex justify-between text-[0.75rem] text-ink-3 font-mono h-5">
        <span>{data[shown]?.day ?? ""}</span>
        <span className="text-ink">{values.length ? format(values[shown]) : ""}</span>
      </div>
      <div className="mt-2 h-40 flex items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
        {values.map((v, i) => (
          <div
            key={data[i].day}
            onMouseEnter={() => setHover(i)}
            className="flex-1 rounded-t-[3px] min-h-[2px] transition-opacity"
            style={{ height: `${(v / max) * 100}%`, background: color, opacity: hover === null || hover === i ? 1 : 0.45 }}
          />
        ))}
      </div>
      <div className="flex justify-between text-[0.6875rem] text-ink-3 font-mono mt-2">
        <span>{data[0]?.day.slice(5)}</span>
        <span>{data[data.length - 1]?.day.slice(5)}</span>
      </div>
    </div>
  );
}

export default function StatsPage() {
  const [days, setDays] = useState(30);
  const [chain, setChain] = useState<number | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchPrices().then((p) => setEthUsd(p?.ETH ?? null));
  }, []);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchStats(days, chain)
        .then((s) => alive && (setStats(s), setError("")))
        .catch(() => alive && setError("Could not load stats. Try again in a moment."));
    setStats(null);
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [days, chain]);

  // Charts show at most the last 90 days so bars stay readable.
  const daily = stats ? stats.daily.slice(-90) : [];
  const t = stats?.totals;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display font-bold text-[2.125rem] sm:text-[2.75rem] tracking-tight">Stats</h1>
          <p className="text-ink-2 mt-1">Every launch on sasa, across every chain. Straight from the chain, updated live.</p>
        </div>
        <span className="flex items-center gap-2 text-[0.8125rem] text-ink-3">
          <span className="w-2 h-2 rounded-full bg-up animate-pulse" aria-hidden="true" /> live
        </span>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="Chain">
          {[{ id: null as number | null, label: "All chains" }, ...CHAINS.map((c) => ({ id: c.chain.id as number | null, label: c.short }))].map((c) => (
            <button
              key={c.label}
              type="button"
              role="tab"
              aria-selected={chain === c.id}
              onClick={() => setChain(c.id)}
              className={"h-9 px-4 rounded-full text-[0.875rem] font-semibold shrink-0 " + (chain === c.id ? "bg-ink text-on-accent" : "text-ink-2")}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1" role="tablist" aria-label="Period">
          {RANGES.map((r) => (
            <button
              key={r.label}
              type="button"
              role="tab"
              aria-selected={days === r.days}
              onClick={() => setDays(r.days)}
              className={"h-9 px-3 rounded-full text-[0.8125rem] font-mono " + (days === r.days ? "bg-surface border border-line text-ink" : "text-ink-3")}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="mt-6 text-danger">{error}</p>}

      <div className="mt-6 grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          ["Volume", t ? money(t.volume, ethUsd) : null, t ? `${t.trades.toLocaleString("en-US")} trades` : ""],
          ["Paid to creators", t ? money(t.fees * 0.3, ethUsd) : null, "0.3% of every trade"],
          ["Coins launched", t ? t.launches.toLocaleString("en-US") : null, t ? `${t.graduated} graduated` : ""],
          ["Traders", t ? t.traders.toLocaleString("en-US") : null, t ? `${t.holders.toLocaleString("en-US")} holders now` : ""],
        ].map(([label, value, sub]) => (
          <div key={label} className="rounded-3xl border border-line bg-surface p-4 sm:p-5">
            <div className="text-[0.8125rem] text-ink-3">{label}</div>
            <div className="font-display font-bold text-[1.625rem] sm:text-[2rem] mt-1 leading-tight">{value ?? <Skeleton className="h-8 w-24" />}</div>
            <div className="text-[0.75rem] text-ink-3 mt-1">{sub}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-3xl border border-line bg-surface p-4 sm:p-5">
          <h2 className="font-display font-bold text-[1.125rem]">Daily volume</h2>
          <div className="mt-3">{stats ? <Bars data={daily} pick={(d) => d.volume} color="#ff6b1a" format={(v) => money(v, ethUsd)} /> : <Skeleton className="h-48" />}</div>
        </div>
        <div className="rounded-3xl border border-line bg-surface p-4 sm:p-5">
          <h2 className="font-display font-bold text-[1.125rem]">New coins per day</h2>
          <div className="mt-3">{stats ? <Bars data={daily} pick={(d) => d.launches} color="#ffb020" format={(v) => String(v)} /> : <Skeleton className="h-48" />}</div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-3xl border border-line bg-surface p-4 sm:p-5">
          <h2 className="font-display font-bold text-[1.125rem]">Top coins by volume</h2>
          {!stats && <Skeleton className="h-48 mt-3" />}
          {stats && stats.topCoins.length === 0 && <p className="text-ink-3 text-[0.875rem] mt-3">No trades in this period.</p>}
          <ol className="mt-3 grid gap-1">
            {stats?.topCoins.map((c, i) => (
              <li key={c.coinId}>
                <Link href={coinHref({ id: c.coinId })} className="flex items-center gap-3 rounded-2xl px-2 py-2 hover:bg-paper">
                  <span className="w-5 text-[0.8125rem] font-mono text-ink-3">{i + 1}</span>
                  <CoinAvatar logo={c.logo} symbol={c.symbol} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-[0.875rem] truncate">{c.name}</span>
                    <span className="block text-[0.75rem] text-ink-3">${c.symbol} · {c.trades} trades</span>
                  </span>
                  <span className="font-mono text-[0.875rem]">{money(c.volume, ethUsd)}</span>
                </Link>
              </li>
            ))}
          </ol>
        </div>
        <div className="rounded-3xl border border-line bg-surface p-4 sm:p-5">
          <h2 className="font-display font-bold text-[1.125rem]">Top creators by earnings</h2>
          {!stats && <Skeleton className="h-48 mt-3" />}
          {stats && stats.topCreators.length === 0 && <p className="text-ink-3 text-[0.875rem] mt-3">No earnings in this period.</p>}
          <ol className="mt-3 grid gap-1">
            {stats?.topCreators.map((c, i) => (
              <li key={c.creator} className="flex items-center gap-3 px-2 py-2">
                <span className="w-5 text-[0.8125rem] font-mono text-ink-3">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[0.875rem]">{shortAddr(c.creator)}</span>
                  <span className="block text-[0.75rem] text-ink-3">{c.coins} coin{c.coins === 1 ? "" : "s"}</span>
                </span>
                <span className="font-mono text-[0.875rem] text-up">{money(c.earned, ethUsd)}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <p className="mt-6 text-[0.75rem] text-ink-3">
        Figures come from sasa&apos;s own index of on-chain events. Dollar values use the current ETH price.
      </p>
    </div>
  );
}
