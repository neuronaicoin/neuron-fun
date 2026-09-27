"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChainChip, CoinAvatar, Skeleton } from "@/components/coins";
import { BarChart, Donut, Panel, Sparkline, short, type Slice } from "@/components/statcharts";
import { CHAINS, chainById } from "@/lib/config";
import { coinHref, fetchStats, type FeeMode, type Leader, type LeaderKind } from "@/lib/data";
import { fetchPrices } from "@/lib/price";

type Stats = Awaited<ReturnType<typeof fetchStats>>;

const RANGES = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All", days: 3650 },
];

const MODE_META: Record<FeeMode, { label: string; color: string }> = {
  creator: { label: "To creator", color: "var(--color-emerald)" },
  holders: { label: "To holders", color: "#3B6FF5" },
  buyback: { label: "Buyback & burn", color: "var(--color-mint)" },
};

const LEADERS: { kind: LeaderKind; label: string; sub: (l: Leader) => string }[] = [
  { kind: "volume", label: "Volume", sub: (l) => `${l.trades.toLocaleString("en-US")} trades` },
  { kind: "fees", label: "Creator earnings", sub: (l) => MODE_META[l.feeMode].label.toLowerCase() },
  { kind: "holders", label: "Holder payouts", sub: () => "paid to holders" },
  { kind: "burn", label: "Burned", sub: () => "bought back & burned" },
];

export default function StatsPage() {
  const [days, setDays] = useState(30);
  const [chain, setChain] = useState<number | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [board, setBoard] = useState<LeaderKind>("volume");

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

  const usdOf = (eth: number) => (ethUsd ? eth * ethUsd : null);
  const money = (eth: number) => {
    const v = usdOf(eth);
    return v === null ? `${short(eth)} ETH` : short(v, "$");
  };

  const t = stats?.totals;
  const daily = stats ? stats.daily.slice(-90) : [];
  const labels = daily.map((d) => d.day);
  const volSeries = daily.map((d) => usdOf(d.volume) ?? d.volume);
  const revSeries = daily.map((d) => usdOf(d.revenue) ?? d.revenue);
  const payoutTotal = t ? t.fees * 0.3 : 0;

  const modeLaunches: Slice[] = useMemo(
    () => (stats?.modes ?? []).map((m) => ({ label: MODE_META[m.mode].label, value: m.launches, color: MODE_META[m.mode].color, detail: m.launches.toLocaleString("en-US") })),
    [stats]
  );
  const modeFees: Slice[] = useMemo(
    () => (stats?.modes ?? []).map((m) => ({ label: MODE_META[m.mode].label, value: m.share, color: MODE_META[m.mode].color, detail: money(m.share) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stats, ethUsd]
  );
  const chainTotal = (stats?.chains ?? []).reduce((a, c) => a + c.volume, 0);
  const chainSlices: Slice[] = (stats?.chains ?? []).map((c) => {
    const ch = chainById(c.chainId);
    return { label: ch?.short ?? `Chain ${c.chainId}`, value: c.volume, color: ch?.color ?? "var(--color-ink-3)", detail: money(c.volume) };
  });

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5 sm:py-10">
      {/* Title and filters */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-mono text-[0.6875rem] tracking-[0.16em] text-emerald">
            <span className="w-1.5 h-1.5 rounded-full bg-up animate-pulse" aria-hidden="true" /> LIVE · ON-CHAIN
          </p>
          <h1 className="font-display font-bold text-[1.875rem] sm:text-[2.75rem] tracking-tight mt-1">Stats</h1>
          <p className="text-ink-2 text-[0.875rem] sm:text-[1rem]">Every launch, trade and payout on sasa, across every chain.</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 overflow-x-auto no-scrollbar" role="tablist" aria-label="Chain">
          {[{ id: null as number | null, label: "All chains" }, ...CHAINS.map((c) => ({ id: c.chain.id as number | null, label: c.short }))].map((c) => (
            <button
              key={c.label}
              type="button"
              role="tab"
              aria-selected={chain === c.id}
              onClick={() => setChain(c.id)}
              className={"h-8 px-3 rounded-lg text-[0.8125rem] font-semibold shrink-0 " + (chain === c.id ? "bg-ink text-mist" : "text-ink-2 hover:text-ink")}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1 p-1 rounded-xl bg-surface border border-line" role="tablist" aria-label="Period">
          {RANGES.map((r) => (
            <button
              key={r.label}
              type="button"
              role="tab"
              aria-selected={days === r.days}
              onClick={() => setDays(r.days)}
              className={"h-7 px-2.5 rounded-lg font-mono text-[0.75rem] " + (days === r.days ? "bg-ink text-mist" : "text-ink-3 hover:text-ink")}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="mt-6 text-danger">{error}</p>}

      {/* Headline numbers */}
      <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "Volume", value: t ? money(t.volume) : null, sub: t ? `${t.trades.toLocaleString("en-US")} trades` : "", spark: volSeries },
          { label: "Protocol revenue", value: t ? money(t.fees * 0.7) : null, sub: "0.7% of every trade", spark: revSeries },
          { label: "Paid to creators & holders", value: t ? money(payoutTotal) : null, sub: "0.3% of every trade", spark: daily.map((d) => usdOf(d.fees * 0.3) ?? d.fees * 0.3) },
          { label: "Coins launched", value: t ? t.launches.toLocaleString("en-US") : null, sub: t ? `${t.graduated.toLocaleString("en-US")} graduated` : "", spark: daily.map((d) => d.launches) },
        ].map((k) => (
          <div key={k.label} className="rounded-3xl border border-line bg-surface p-4 sm:p-5 min-w-0 overflow-hidden">
            <div className="text-[0.75rem] sm:text-[0.8125rem] text-ink-3 truncate">{k.label}</div>
            <div className="font-display font-bold text-[1.5rem] sm:text-[2.125rem] leading-tight mt-1 tabular-nums">{k.value ?? <Skeleton className="h-8 w-24" />}</div>
            <div className="text-[0.6875rem] sm:text-[0.75rem] text-ink-3 mt-0.5 truncate">{k.sub}</div>
            <Sparkline values={k.spark} className="mt-2" />
          </div>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          ["Unique creators", t ? t.creators.toLocaleString("en-US") : null],
          ["Traders", t ? t.traders.toLocaleString("en-US") : null],
          ["Holders now", t ? t.holders.toLocaleString("en-US") : null],
          ["Bought back & burned", t ? money(t.buyback) : null],
        ].map(([l, v]) => (
          <div key={l} className="rounded-2xl border border-line bg-surface px-4 py-3 min-w-0">
            <div className="text-[0.6875rem] sm:text-[0.75rem] text-ink-3 truncate">{l}</div>
            <div className="font-mono text-[1.0625rem] sm:text-[1.25rem] mt-0.5 tabular-nums">{v ?? "…"}</div>
          </div>
        ))}
      </div>

      {/* Daily charts */}
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)] lg:grid-cols-2 gap-3">
        <Panel title="Daily volume" subtitle="Across the selected chains">
          {stats ? <BarChart labels={labels} values={volSeries} format={(v) => (ethUsd ? short(v, "$") : `${short(v)} ETH`)} /> : <Skeleton className="h-60" />}
        </Panel>
        <Panel title="Daily protocol revenue" subtitle="0.7% of every trade">
          {stats ? <BarChart labels={labels} values={revSeries} color="var(--color-mint)" format={(v) => (ethUsd ? short(v, "$") : `${short(v)} ETH`)} /> : <Skeleton className="h-60" />}
        </Panel>
        <Panel title="Coins launched per day">
          {stats ? <BarChart labels={labels} values={daily.map((d) => d.launches)} color="#3B6FF5" integer format={(v) => Math.round(v).toLocaleString("en-US")} /> : <Skeleton className="h-60" />}
        </Panel>
        <Panel title="Graduations per day" subtitle="Coins that reached the target and locked their pool">
          {stats ? <BarChart labels={labels} values={daily.map((d) => d.graduations)} color="var(--color-up)" integer format={(v) => Math.round(v).toLocaleString("en-US")} /> : <Skeleton className="h-60" />}
        </Panel>
      </div>

      {/* Rings */}
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)] lg:grid-cols-3 gap-3">
        <Panel title="Launches by fee mode" subtitle="Where creators send their 0.3%">
          {stats ? <Donut slices={modeLaunches} center={(t?.launches ?? 0).toLocaleString("en-US")} centerLabel="coins" /> : <Skeleton className="h-32" />}
        </Panel>
        <Panel title="Creator-side fees by mode" subtitle="The 0.3% share, by where it went">
          {stats ? <Donut slices={modeFees} center={money(payoutTotal)} centerLabel="paid out" /> : <Skeleton className="h-32" />}
        </Panel>
        <Panel title="Volume by chain" subtitle="One coin, every chain">
          {stats ? <Donut slices={chainSlices} center={money(chainTotal)} centerLabel="volume" /> : <Skeleton className="h-32" />}
        </Panel>
      </div>

      {/* Chains */}
      <Panel title="Chains" subtitle="The same figures per chain. Tap one to filter the page." className="mt-3">
        {!stats && <Skeleton className="h-32" />}
        <ul className="grid gap-1">
          {stats?.chains.map((c) => {
            const ch = chainById(c.chainId);
            if (!ch) return null;
            const share = chainTotal > 0 ? (c.volume / chainTotal) * 100 : 0;
            return (
              <li key={c.chainId}>
                <button
                  type="button"
                  onClick={() => setChain(chain === c.chainId ? null : c.chainId)}
                  className={"w-full grid grid-cols-[1fr_auto] sm:grid-cols-[180px_1fr_140px_100px] items-center gap-3 rounded-2xl px-3 py-3 text-left hover:bg-paper " + (chain === c.chainId ? "bg-paper" : "")}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <ChainChip chain={ch} />
                  </span>
                  <span className="hidden sm:block">
                    <Sparkline values={c.spark} color={ch.color} height={32} />
                  </span>
                  <span className="text-right">
                    <span className="block font-mono text-[0.9375rem] tabular-nums">{money(c.volume)}</span>
                    <span className="block text-[0.6875rem] text-ink-3">volume · {share.toFixed(0)}%</span>
                  </span>
                  <span className="hidden sm:block text-right">
                    <span className="block font-mono text-[0.9375rem] tabular-nums">{c.holders.toLocaleString("en-US")}</span>
                    <span className="block text-[0.6875rem] text-ink-3">holders</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Panel>

      {/* Leaderboards */}
      <Panel
        title="Leaderboards"
        subtitle="Top coins in the selected period"
        className="mt-3"
        right={
          <div className="hidden sm:flex gap-1 p-1 rounded-xl bg-paper" role="tablist" aria-label="Leaderboard">
            {LEADERS.map((l) => (
              <button
                key={l.kind}
                type="button"
                role="tab"
                aria-selected={board === l.kind}
                onClick={() => setBoard(l.kind)}
                className={"h-8 px-3 rounded-lg text-[0.8125rem] font-semibold " + (board === l.kind ? "bg-surface text-ink shadow-sm" : "text-ink-3")}
              >
                {l.label}
              </button>
            ))}
          </div>
        }
      >
        <div className="sm:hidden flex gap-1 overflow-x-auto no-scrollbar -mt-1 mb-3" role="tablist" aria-label="Leaderboard">
          {LEADERS.map((l) => (
            <button
              key={l.kind}
              type="button"
              role="tab"
              aria-selected={board === l.kind}
              onClick={() => setBoard(l.kind)}
              className={"h-8 px-3 rounded-lg text-[0.8125rem] font-semibold shrink-0 " + (board === l.kind ? "bg-ink text-mist" : "text-ink-2")}
            >
              {l.label}
            </button>
          ))}
        </div>
        <Leaderboard rows={stats?.leaders[board] ?? null} sub={LEADERS.find((l) => l.kind === board)!.sub} money={money} />
      </Panel>

      {/* How fees work */}
      <Panel title="How fees are split" subtitle="The same on every chain, before and after graduation" className="mt-3">
        <dl className="grid gap-0 text-[0.875rem]">
          {[
            ["Trade fee", "1% of every buy and sell"],
            ["Protocol", "0.7%"],
            ["Creator side", "0.3%, sent by the coin's fee mode: to the creator, to holders, or to buy back and burn"],
            ["After graduation", "The locked pool charges the same 1%; the split stays the same"],
            ["Launch fee", "None, only network gas"],
          ].map(([k, v]) => (
            <div key={k} className="grid grid-cols-[130px_1fr] sm:grid-cols-[200px_1fr] gap-3 py-2.5 border-b border-line last:border-0">
              <dt className="text-ink-3">{k}</dt>
              <dd className="text-right sm:text-left">{v}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <p className="mt-5 text-[0.75rem] text-ink-3">
        Figures come from sasa&apos;s own index of on-chain events and refresh every 30 seconds. Dollar values use the current ETH price.
      </p>
    </div>
  );
}

function Leaderboard({ rows, sub, money }: { rows: Leader[] | null; sub: (l: Leader) => string; money: (eth: number) => string }) {
  if (!rows) return <Skeleton className="h-64" />;
  if (rows.length === 0) return <p className="text-[0.875rem] text-ink-3 py-8 text-center">Nothing here in this period yet.</p>;
  const podium = rows.slice(0, 3);
  const rest = rows.slice(3);
  const medal = ["#FFB020", "#C9CED6", "#D08A4E"];
  return (
    <div>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {podium.map((l, i) => {
          const ch = l.chainId !== null ? chainById(l.chainId) : null;
          return (
            <Link
              key={l.coinId}
              href={coinHref({ id: l.coinId })}
              className="relative rounded-2xl border border-line bg-paper p-3 sm:p-4 hover:border-emerald/60 min-w-0"
              style={i === 0 ? { boxShadow: "inset 0 0 0 1px rgba(255,176,32,0.45)" } : undefined}
            >
              <span className="absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center font-display font-bold text-[0.75rem] text-[#1a120c]" style={{ background: medal[i] }}>
                {i + 1}
              </span>
              <CoinAvatar logo={l.logo} symbol={l.symbol} size={44} />
              <div className="mt-2 font-semibold text-[0.875rem] truncate">{l.name}</div>
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-[0.6875rem] text-ink-3 truncate">${l.symbol}</span>
                {ch && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: ch.color }} aria-label={ch.short} />}
              </div>
              <div className="font-display font-bold text-[1rem] sm:text-[1.25rem] mt-2 tabular-nums">{money(l.value)}</div>
              <div className="text-[0.6875rem] text-ink-3 truncate">{sub(l)}</div>
            </Link>
          );
        })}
      </div>
      {rest.length > 0 && (
        <ol className="mt-3 grid gap-0.5" start={4}>
          {rest.map((l, i) => {
            const ch = l.chainId !== null ? chainById(l.chainId) : null;
            return (
              <li key={l.coinId}>
                <Link href={coinHref({ id: l.coinId })} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-paper">
                  <span className="w-5 text-[0.75rem] font-mono text-ink-3">{i + 4}</span>
                  <CoinAvatar logo={l.logo} symbol={l.symbol} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="font-semibold text-[0.875rem] truncate">{l.name}</span>
                      {ch && <ChainChip chain={ch} />}
                    </span>
                    <span className="block text-[0.75rem] text-ink-3 truncate">{sub(l)}</span>
                  </span>
                  <span className="font-mono text-[0.875rem] tabular-nums">{money(l.value)}</span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
