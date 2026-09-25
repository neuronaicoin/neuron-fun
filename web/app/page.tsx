"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChainChip, Skeleton, useCoins, usd } from "@/components/coins";
import { CoinTile, GraduationRadar, LiveTicker } from "@/components/discover";
import { CHAINS, TARGET_USD } from "@/lib/config";
import type { SortKey } from "@/lib/data";
import { fetchPrices } from "@/lib/price";

const SORTS: { id: SortKey; label: string }[] = [
  { id: "hot", label: "Closest to graduating" },
  { id: "active", label: "Most active" },
  { id: "new", label: "Newest" },
  { id: "graduated", label: "Graduated" },
];

export default function Discover() {
  const [sort, setSort] = useState<SortKey>("hot");
  const [chain, setChain] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const { coins, error, reload } = useCoins(sort === "hot" ? "new" : sort, search);
  const [ethUsd, setEthUsd] = useState<number | null>(null);

  useEffect(() => {
    fetchPrices().then((p) => setEthUsd(p?.ETH ?? null));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const list = useMemo(() => {
    let l = coins ?? [];
    if (chain !== "all") l = l.filter((c) => c.curves.some((k) => k.chain.key === chain));
    if (sort === "hot") l = l.filter((c) => !c.graduatedOn).sort((a, b) => b.progress - a.progress);
    return l;
  }, [coins, sort, chain]);

  const racing = coins?.filter((c) => !c.graduatedOn) ?? [];
  const liveUsd = coins ? racing.reduce((s, c) => s + (c.totalUsd ?? 0), 0) : null;
  const trades24h = coins?.reduce((s, c) => s + c.trades24h, 0) ?? null;

  return (
    <div>
      {coins && <LiveTicker coins={coins} ethUsd={ethUsd} />}

      <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-6 sm:pt-10">
        <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
          <div className="relative overflow-hidden rounded-3xl border border-line bg-surface p-6 sm:p-10">
            <div
              className="absolute inset-0 opacity-[0.07] pointer-events-none"
              style={{ backgroundImage: "radial-gradient(#2fd39b 1px, transparent 1px)", backgroundSize: "22px 22px" }}
              aria-hidden="true"
            />
            <div className="relative">
              <p className="font-mono text-[11px] sm:text-[12px] tracking-[0.16em] text-emerald">ONE COIN · EVERY CHAIN</p>
              <h1 className="font-display font-semibold text-[34px] sm:text-[58px] leading-[1.02] tracking-tight mt-3">
                Launch once.
                <br />
                <span className="text-emerald">Live on every chain.</span>
              </h1>
              <p className="text-[15px] sm:text-[18px] text-ink-2 mt-4 max-w-xl">
                Buyers on every chain push your coin to graduation together. The chain with the most money wins.
              </p>
              <div className="mt-6 grid grid-cols-3 gap-3 max-w-md">
                <div>
                  <div className="font-mono text-[20px] sm:text-[26px]">{coins ? usd(liveUsd, 0) : "…"}</div>
                  <div className="text-[12px] text-ink-3">racing now</div>
                </div>
                <div>
                  <div className="font-mono text-[20px] sm:text-[26px]">{trades24h ?? "…"}</div>
                  <div className="text-[12px] text-ink-3">trades 24h</div>
                </div>
                <div>
                  <div className="font-mono text-[20px] sm:text-[26px]">{coins ? coins.length : "…"}</div>
                  <div className="text-[12px] text-ink-3">coins</div>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-emerald/40 bg-emerald-soft p-6 sm:p-8 flex flex-col justify-between gap-6">
            <div>
              <h2 className="font-display font-semibold text-[28px] sm:text-[36px] leading-tight">
                Create on <span className="text-emerald">{CHAINS.length} chains</span> at once
              </h2>
              <div className="flex flex-wrap gap-2 mt-4">
                {CHAINS.map((c) => (
                  <ChainChip key={c.key} chain={c} />
                ))}
              </div>
              <p className="text-[14px] text-ink-2 mt-4">Graduates at {usd(TARGET_USD)} across all chains.</p>
            </div>
            <Link href="/create/" className="h-13 px-6 rounded-2xl bg-emerald text-on-accent text-[16px] font-bold flex items-center justify-between hover:bg-emerald-dark">
              Launch a coin <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </div>
      </section>

      {coins && coins.some((c) => !c.graduatedOn) && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-8">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2 h-2 rounded-full bg-warn-ink animate-pulse" aria-hidden="true" />
            <h2 className="font-display font-semibold text-[18px] sm:text-[20px]">About to graduate</h2>
          </div>
          <GraduationRadar coins={coins} ethUsd={ethUsd} />
        </section>
      )}

      <section id="explore" className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-10 scroll-mt-20">
        <div className="rounded-3xl border border-line bg-surface p-4 sm:p-6">
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
            <div>
              <h2 className="font-display font-semibold text-[26px] sm:text-[32px] tracking-tight">Coins</h2>
              <p className="font-mono text-[12px] text-ink-3 tracking-wider mt-1">{coins ? `${list.length} SHOWN` : "LOADING"}</p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 w-full lg:w-auto">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Name or ticker"
                aria-label="Search coins"
                className="h-11 px-4 rounded-xl border border-line bg-paper focus:border-emerald sm:w-56"
              />
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                aria-label="Sort coins"
                className="h-11 px-3 rounded-xl border border-line bg-paper text-ink font-semibold text-[14px]"
              >
                {SORTS.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-2 mt-4 overflow-x-auto pb-1" role="tablist" aria-label="Chain">
            {[{ key: "all", short: "All chains" }, ...CHAINS].map((c) => (
              <button
                key={c.key}
                type="button"
                role="tab"
                aria-selected={chain === c.key}
                onClick={() => setChain(c.key)}
                className={"h-9 px-4 rounded-full text-[13px] font-semibold shrink-0 border " + (chain === c.key ? "bg-emerald text-on-accent border-emerald" : "border-line text-ink-2")}
              >
                {c.short}
              </button>
            ))}
          </div>

          {error && (
            <div className="mt-5 p-4 rounded-2xl bg-warn-bg text-warn-ink text-[15px] flex items-center justify-between gap-4">
              <span>{error}</span>
              <button type="button" onClick={reload} className="font-semibold underline">Try again</button>
            </div>
          )}

          <div className="mt-5 grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
            {!coins && !error && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="aspect-[3/4]" />)}
            {list.map((c) => (
              <CoinTile key={c.id} coin={c} ethUsd={ethUsd} />
            ))}
          </div>
          {coins && list.length === 0 && (
            <div className="mt-5 text-center py-12 border border-dashed border-line rounded-2xl">
              <p className="text-ink-2">{search ? "Nothing matches that search." : sort === "graduated" ? "No graduates yet." : "No coins here yet. Start one."}</p>
              <Link href="/create/" className="inline-flex mt-4 h-11 px-6 rounded-xl bg-emerald text-on-accent font-semibold items-center">Create a coin</Link>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
