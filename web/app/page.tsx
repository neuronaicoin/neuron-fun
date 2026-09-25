"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CoinCard, ChainChip, Skeleton, useCoins, usd } from "@/components/coins";
import { TradesFeed } from "@/components/market";
import { CHAINS, TARGET_USD } from "@/lib/config";
import { coinHref, type SortKey } from "@/lib/data";
import { fetchPrices } from "@/lib/price";

const TABS: { id: SortKey; label: string }[] = [
  { id: "hot", label: "Closest" },
  { id: "active", label: "Active" },
  { id: "new", label: "Newest" },
  { id: "graduated", label: "Graduated" },
];

export default function Home() {
  const [tab, setTab] = useState<SortKey>("hot");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const { coins, error, reload } = useCoins(tab === "hot" ? "new" : tab, search);
  const [ethUsd, setEthUsd] = useState<number | null>(null);

  useEffect(() => {
    fetchPrices().then((p) => setEthUsd(p?.ETH ?? null));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const list = useMemo(() => {
    if (!coins) return [];
    if (tab === "hot") return coins.filter((c) => !c.graduatedOn).sort((a, b) => b.progress - a.progress);
    return coins;
  }, [coins, tab]);

  const names = useMemo(
    () => new Map((coins ?? []).map((c) => [c.id, { name: c.name, symbol: c.symbol, href: coinHref(c) }])),
    [coins]
  );
  const racing = coins?.filter((c) => !c.graduatedOn) ?? [];
  const liveUsd = coins ? racing.reduce((s, c) => s + (c.totalUsd ?? 0), 0) : null;
  const trades24h = coins?.reduce((s, c) => s + c.trades24h, 0) ?? null;

  return (
    <div>
      <section className="max-w-6xl mx-auto px-4 sm:px-6 pt-8 sm:pt-16 pb-8 sm:pb-10 grid gap-8 lg:grid-cols-[1.3fr_1fr] lg:items-center">
        <div>
          <p className="font-mono text-[11px] sm:text-[12px] tracking-[0.14em] text-emerald">ONE COIN. EVERY CHAIN.</p>
          <h1 className="font-display font-semibold text-[34px] leading-[1.05] sm:text-[60px] tracking-tight mt-3 sm:mt-4">
            Launch once.
            <br />
            Live on every chain.
          </h1>
          <p className="text-[16px] sm:text-[19px] leading-relaxed text-ink-2 mt-4 sm:mt-5 max-w-xl">
            Buyers on every chain push your coin to graduation together. The chain with the most money wins.
          </p>
          <div className="mt-6 grid grid-cols-2 sm:flex gap-3">
            <Link href="/create/" className="h-12 sm:h-13 px-6 rounded-xl bg-emerald text-white text-[16px] font-semibold flex items-center justify-center hover:bg-emerald-dark">
              Create a coin
            </Link>
            <a href="#explore" className="h-12 sm:h-13 px-6 rounded-xl border border-ink text-ink text-[16px] font-semibold flex items-center justify-center">
              Explore
            </a>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
            <span>Live on</span>
            {CHAINS.map((c) => (
              <ChainChip key={c.key} chain={c} />
            ))}
          </div>
        </div>

        <div className="bg-night text-mist rounded-3xl p-5 sm:p-7">
          <div className="flex items-center justify-between">
            <span className="text-[13px] sm:text-[14px] font-semibold text-[#a9bab3]">Racing to graduate</span>
            <span className="flex items-center gap-2 font-mono text-[12px] text-mint">
              <span className="w-2 h-2 rounded-full bg-mint animate-pulse" aria-hidden="true" /> LIVE
            </span>
          </div>
          <div className="font-mono text-[34px] sm:text-[46px] leading-none mt-3 sm:mt-4 tracking-tight">{coins ? usd(liveUsd, 2) : "…"}</div>
          <div className="h-px bg-night-line my-5" />
          <div className="grid grid-cols-3 gap-3 text-[12px] text-[#a9bab3]">
            <div><div className="font-mono text-[18px] text-mist">{coins ? racing.length : "…"}</div>racing</div>
            <div><div className="font-mono text-[18px] text-mist">{trades24h ?? "…"}</div>trades 24h</div>
            <div><div className="font-mono text-[18px] text-mist">{usd(TARGET_USD)}</div>target</div>
          </div>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-4 sm:px-6 pb-4">
        <div className="bg-white border border-line rounded-2xl p-4 sm:p-5">
          <div className="flex items-center justify-between mb-1">
            <h2 className="font-display font-semibold text-[17px]">Live trades</h2>
            <span className="flex items-center gap-2 font-mono text-[11px] text-emerald">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald animate-pulse" aria-hidden="true" /> LIVE
            </span>
          </div>
          <TradesFeed names={names} ethUsd={ethUsd} limit={6} />
        </div>
      </section>

      <section id="explore" className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12 scroll-mt-20">
        <div className="flex flex-col gap-4">
          <div className="flex items-end justify-between gap-4">
            <h2 className="font-display font-semibold text-[26px] sm:text-[34px] tracking-tight">Explore</h2>
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or ticker"
            className="w-full h-12 px-4 rounded-xl border border-line bg-white focus:border-emerald"
            aria-label="Search coins"
          />
          <div role="tablist" aria-label="Sort coins" className="grid grid-cols-4 gap-1 p-1 bg-line/60 rounded-xl">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={"h-10 px-2 rounded-lg text-[13px] sm:text-[14px] font-semibold " + (tab === t.id ? "bg-white text-ink shadow-sm" : "text-ink-2")}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mt-6 p-4 rounded-2xl bg-warn-bg text-warn-ink text-[15px] flex items-center justify-between gap-4">
            <span>{error}</span>
            <button type="button" onClick={reload} className="font-semibold underline">Try again</button>
          </div>
        )}

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {!coins && !error && [0, 1, 2].map((i) => <Skeleton key={i} className="h-52" />)}
          {list.map((c) => (
            <CoinCard key={c.id} coin={c} />
          ))}
        </div>
        {coins && list.length === 0 && (
          <div className="mt-6 text-center py-12 border border-dashed border-line rounded-2xl">
            <p className="text-ink-2">{search ? "Nothing matches that search." : tab === "graduated" ? "No graduates yet." : "No coins yet. Start one."}</p>
            <Link href="/create/" className="inline-flex mt-4 h-11 px-6 rounded-xl bg-emerald text-white font-semibold items-center">
              Create a coin
            </Link>
          </div>
        )}
      </section>

      <section className="max-w-6xl mx-auto px-4 sm:px-6 pb-12">
        <ol className="grid gap-4 sm:grid-cols-3">
          {[
            ["1", "Pick your chains", "Name your coin, add a picture and choose where it launches. One form, every chain you pick."],
            ["2", "Everyone pushes together", "Buys on every chain add up. One progress bar shows how close the coin is to graduating."],
            ["3", "The winner takes it", "At the target, the chain with the most money wins and the coin moves to a locked pool there. Holders elsewhere can always take their money back."],
          ].map(([n, t, d]) => (
            <li key={n} className="border-t-2 border-ink pt-5">
              <span className="font-mono text-[13px] text-emerald">0{n}</span>
              <h3 className="font-display font-semibold text-[20px] mt-2">{t}</h3>
              <p className="text-[15px] leading-relaxed text-ink-2 mt-2">{d}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
