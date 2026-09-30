"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChainChip, Skeleton, useCoins, usd } from "@/components/coins";
import { CoinTile, LiveTicker } from "@/components/discover";
import { CHAINS, TARGET_USD } from "@/lib/config";
import { fetchCoinCount, type SortKey } from "@/lib/data";
import { fetchPrices } from "@/lib/price";
import { Landing } from "@/components/landing";
import { ScrollRow } from "@/components/scrollrow";
import { useSparks } from "@/lib/spark";
import { compactUsd } from "@/lib/format";
import { EXT_NETWORKS, fetchExtCoins, fetchExtCount, type ExtCoin, type ExtSort } from "@/lib/extcoins";
import { ExtTile } from "@/components/exttile";

// Sorts that also apply to coins from other DEXs (the rest are about our curves).
const EXT_SORT: Partial<Record<SortKey, ExtSort>> = { trending: "trending", gainers: "gainers", losers: "losers", new: "new" };

const SORTS: { id: SortKey; label: string }[] = [
  { id: "trending", label: "🔥 Trending" },
  { id: "gainers", label: "Top gainers 24h" },
  { id: "losers", label: "Top losers 24h" },
  { id: "hot", label: "Closest to graduate" },
  { id: "bonding", label: "Bonding" },
  { id: "new", label: "Newest" },
  { id: "graduated", label: "Graduated" },
];

export function Discover({ withLanding = false }: { withLanding?: boolean }) {
  const [sort, setSort] = useState<SortKey>("trending");
  const [chain, setChain] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const { coins, error, reload, hasMore, loadMore, loadingMore } = useCoins(sort, search);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  // Coins from every other DEX on the same chains, shown after ours.
  const [ext, setExt] = useState<ExtCoin[] | null>(null);
  const [extTotal, setExtTotal] = useState<number | null>(null);
  useEffect(() => {
    fetchExtCount().then(setExtTotal);
  }, []);
  const extSort = EXT_SORT[sort];
  useEffect(() => {
    if (!extSort) {
      setExt([]);
      return;
    }
    let alive = true;
    setExt(null);
    const load = () =>
      fetchExtCoins(extSort, chain === "all" ? null : chain, search)
        .then((l) => alive && setExt(l))
        .catch(() => alive && setExt((e) => e ?? []));
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [extSort, chain, search]);

  useEffect(() => {
    fetchPrices().then((p) => setEthUsd(p?.ETH ?? null));
    fetchCoinCount().then(setTotal);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const list = useMemo(() => {
    let l = coins ?? [];
    if (chain !== "all") l = l.filter((c) => c.curves.some((k) => k.chain.key === chain));
    return l;
  }, [coins, sort, chain]);

  const sparks = useSparks(useMemo(() => list.map((c) => c.id), [list]));
  const racing = coins?.filter((c) => !c.graduatedOn) ?? [];
  const liveUsd = coins ? racing.reduce((s, c) => s + (c.totalUsd ?? 0), 0) : null;
  const trades24h = coins?.reduce((s, c) => s + c.trades24h, 0) ?? null;

  return (
    <>
    {withLanding && (
      <div className="landing-root">
        <Landing />
      </div>
    )}
    <div className="app-root">
      {coins && <LiveTicker coins={coins} ethUsd={ethUsd} />}

      <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-3 sm:pt-10">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[1.6fr_1fr]">
          <div className="relative overflow-hidden rounded-3xl border border-line bg-surface p-4 sm:p-10">
            <div
              className="absolute inset-0 opacity-[0.07] pointer-events-none"
              style={{ backgroundImage: "radial-gradient(#2fd39b 1px, transparent 1px)", backgroundSize: "22px 22px" }}
              aria-hidden="true"
            />
            <div className="relative">
              <p className="hidden sm:block font-mono text-[0.75rem] tracking-[0.16em] text-emerald">ONE COIN · EVERY CHAIN</p>
              <h1 className="font-display font-semibold text-[1.5rem] sm:text-[3.625rem] leading-[1.05] tracking-tight sm:mt-3">
                Launch once.
                <br />
                <span className="text-emerald">Live on every chain.</span>
              </h1>
              <p className="hidden sm:block text-[1.125rem] text-ink-2 mt-4 max-w-xl">
                Buyers on every chain push your coin to graduation together. The chain with the most money wins.
              </p>
              <div className="mt-3 sm:mt-6 grid grid-cols-4 gap-2 sm:gap-3 max-w-lg">
                <div>
                  <div className="font-mono text-[1.25rem] sm:text-[1.625rem]">{coins ? compactUsd(liveUsd) : "…"}</div>
                  <div className="text-[0.75rem] text-ink-3">racing now</div>
                </div>
                <div>
                  <div className="font-mono text-[1.25rem] sm:text-[1.625rem]">{trades24h ?? "…"}</div>
                  <div className="text-[0.75rem] text-ink-3">trades 24h</div>
                </div>
                <div>
                  <div className="font-mono text-[1.25rem] sm:text-[1.625rem]">{total ?? "…"}</div>
                  <div className="text-[0.75rem] text-ink-3">launched here</div>
                </div>
                {/* Kept apart from our launchpad's numbers so neither is inflated. */}
                <div>
                  <div className="font-mono text-[1.25rem] sm:text-[1.625rem]">{extTotal ?? "…"}</div>
                  <div className="text-[0.75rem] text-ink-3">to trade</div>
                </div>
              </div>
            </div>
          </div>

          <div className="hidden lg:flex relative overflow-hidden rounded-3xl border border-line bg-surface p-8 flex-col justify-between gap-6">
            <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-emerald/10 blur-3xl pointer-events-none" aria-hidden="true" />
            <div className="relative">
              <h2 className="font-display font-semibold text-[1.75rem] sm:text-[2.25rem] leading-tight">
                Create on <span className="text-emerald">{CHAINS.length} chains</span> at once
              </h2>
              <div className="flex flex-wrap gap-2 mt-4">
                {CHAINS.map((c) => (
                  <ChainChip key={c.key} chain={c} />
                ))}
              </div>
              <p className="text-[0.875rem] text-ink-2 mt-4">Graduates at {usd(TARGET_USD)} across all chains.</p>
            </div>
            <Link href="/create/" className="relative h-13 px-6 rounded-2xl bg-emerald text-on-accent text-[1rem] font-bold flex items-center justify-between hover:bg-emerald-dark">
              Launch a coin <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </div>
      </section>

      <nav aria-label="More" className="lg:hidden max-w-7xl mx-auto px-4 pt-3 flex gap-2 overflow-x-auto no-scrollbar">
        <Link href="/swipe/" className="h-10 px-4 shrink-0 rounded-xl bg-emerald text-on-accent font-bold text-[0.875rem] flex items-center">🔥 Swipe</Link>
        <Link href="/traders/" className="h-10 px-4 shrink-0 rounded-xl border border-line bg-surface font-semibold text-[0.875rem] flex items-center">🏆 Top traders</Link>
        <a href="/forum/" className="h-10 px-4 rounded-xl border border-line bg-surface font-semibold text-[0.875rem] flex items-center">💬 Forum</a>
      </nav>

      <section id="explore" className="max-w-7xl mx-auto px-4 sm:px-6 pt-4 pb-8 sm:py-8 scroll-mt-20">
        <div className="rounded-3xl border border-line bg-surface p-4 sm:p-6">
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="font-display font-semibold text-[1.625rem] sm:text-[2rem] tracking-tight">Coins</h2>
                <Link
                  href="/swipe/"
                  className="hidden lg:inline-flex h-9 px-3.5 rounded-xl bg-emerald-soft text-emerald font-bold text-[0.8125rem] items-center gap-1.5 hover:bg-emerald hover:text-on-accent"
                >
                  🔥 Swipe to discover
                </Link>
              </div>
              <p className="font-mono text-[0.75rem] text-ink-3 tracking-wider mt-1">{coins ? `${list.length} SHOWN` : "LOADING"}</p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 w-full lg:w-auto">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Name or ticker"
                aria-label="Search coins"
                className="h-11 px-4 rounded-xl border border-line bg-paper focus:border-emerald sm:w-56"
              />

            </div>
          </div>
          <ScrollRow label="Sort coins" className="mt-4">
            {SORTS.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={sort === s.id}
                onClick={(e) => {
                  setSort(s.id);
                  e.currentTarget.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
                }}
                className={
                  "h-10 w-[9.75rem] sm:w-[10.5rem] shrink-0 px-3 rounded-xl text-[0.8125rem] sm:text-[0.875rem] font-semibold whitespace-nowrap border flex items-center justify-center " +
                  (sort === s.id ? "bg-emerald text-on-accent border-emerald shadow-[0_4px_14px_rgba(242,96,12,0.25)]" : "bg-paper border-line text-ink-2 hover:text-ink hover:border-emerald/50")
                }
              >
                {s.label}
              </button>
            ))}
          </ScrollRow>
          <div
            className="mt-2.5 flex gap-1 p-1 rounded-2xl border border-line bg-paper w-full sm:w-fit overflow-x-auto [scrollbar-width:none]"
            role="group"
            aria-label="Chain"
          >
            {[{ key: "all", short: "All chains", color: "" }, ...EXT_NETWORKS.map((n) => ({ key: n.id, short: n.label, color: n.color }))].map((c) => (
              <button
                key={c.key}
                type="button"
                aria-pressed={chain === c.key}
                onClick={() => setChain(c.key)}
                className={
                  "shrink-0 h-9 px-3 sm:px-4 rounded-xl text-[0.8125rem] font-semibold whitespace-nowrap flex items-center justify-center gap-2 " +
                  (chain === c.key ? "bg-ink text-paper shadow-sm" : "text-ink-2 hover:text-ink")
                }
              >
                {c.color && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c.color }} aria-hidden="true" />}
                {c.short}
              </button>
            ))}
          </div>

          {error && (
            <div className="mt-5 p-4 rounded-2xl bg-warn-bg text-warn-ink text-[0.9375rem] flex items-center justify-between gap-4">
              <span>{error}</span>
              <button type="button" onClick={reload} className="font-semibold underline">Try again</button>
            </div>
          )}

          <div className="mt-5 grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
            {!coins && !error && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="aspect-[3/4]" />)}
            {list.map((c) => (
              <CoinTile key={c.id} coin={c} ethUsd={ethUsd} spark={sparks.get(c.id)} />
            ))}
            {(ext ?? []).map((c) => (
              <ExtTile key={`${c.network}:${c.address}`} coin={c} />
            ))}
          </div>
          {coins && hasMore && (
            <div className="mt-6 flex justify-center">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="h-11 px-6 rounded-xl border border-line text-ink font-semibold hover:border-emerald disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Show more"}
              </button>
            </div>
          )}
          {coins && list.length === 0 && ext !== null && ext.length === 0 && (
            <div className="mt-5 text-center py-12 border border-dashed border-line rounded-2xl">
              <p className="text-ink-2">{search ? "Nothing matches that search." : sort === "graduated" ? "No graduates yet." : sort === "bonding" ? "No coins on their bonding curve right now." : "No coins here yet. Start one."}</p>
              <Link href="/create/" className="inline-flex mt-4 h-11 px-6 rounded-xl bg-emerald text-on-accent font-semibold items-center">Create a coin</Link>
            </div>
          )}
        </div>
      </section>
    </div>
    </>
  );
}
