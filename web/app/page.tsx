"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CoinCard, ChainChip, Skeleton, Stat, useCoins, usd } from "@/components/coins";
import { CHAINS, TARGET_USD } from "@/lib/config";

type Tab = "hot" | "new" | "graduated";
const TABS: { id: Tab; label: string; note: string }[] = [
  { id: "hot", label: "Closest", note: "Coins closest to graduating." },
  { id: "new", label: "Newest", note: "Coins created most recently." },
  { id: "graduated", label: "Graduated", note: "Coins that made it, and where." },
];

export default function Home() {
  const { coins, error, reload } = useCoins();
  const [tab, setTab] = useState<Tab>("hot");

  const list = useMemo(() => {
    if (!coins) return [];
    if (tab === "graduated") return coins.filter((c) => c.graduatedOn);
    const live = coins.filter((c) => !c.graduatedOn);
    if (tab === "hot") return [...live].sort((a, b) => b.progress - a.progress);
    return live;
  }, [coins, tab]);

  const graduatedCount = coins?.filter((c) => c.graduatedOn).length ?? 0;
  const liveUsd = coins?.filter((c) => !c.graduatedOn).reduce((s, c) => s + (c.totalUsd ?? 0), 0) ?? null;

  return (
    <div>
      <section className="max-w-6xl mx-auto px-4 sm:px-6 pt-10 sm:pt-16 pb-10 grid gap-10 lg:grid-cols-[1.3fr_1fr] lg:items-center">
        <div>
          <p className="font-mono text-[12px] tracking-[0.14em] text-emerald">ONE COIN. EVERY CHAIN.</p>
          <h1 className="font-display font-semibold text-[40px] leading-[1.05] sm:text-[60px] tracking-tight mt-4">
            Launch once. Live on every chain.
          </h1>
          <p className="text-[17px] sm:text-[19px] leading-relaxed text-ink-2 mt-5 max-w-xl">
            Create a coin on several chains at the same time. Buyers on every chain push it toward graduation together,
            so it gets there much faster. The chain with the most money wins, and the coin lives on there.
          </p>
          <div className="mt-7 flex flex-col sm:flex-row gap-3">
            <Link href="/create/" className="h-13 px-7 rounded-xl bg-emerald text-white text-[16px] font-semibold flex items-center justify-center hover:bg-emerald-dark">
              Create a coin
            </Link>
            <a href="#explore" className="h-13 px-7 rounded-xl border border-ink text-ink text-[16px] font-semibold flex items-center justify-center">
              Explore coins
            </a>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
            <span>Live on</span>
            {CHAINS.map((c) => (
              <ChainChip key={c.key} chain={c} />
            ))}
          </div>
        </div>

        <div className="bg-night text-mist rounded-3xl p-6 sm:p-7">
          <div className="flex items-center justify-between">
            <span className="text-[14px] font-semibold text-[#a9bab3]">Racing to graduate right now</span>
            <span className="flex items-center gap-2 font-mono text-[12px] text-mint">
              <span className="w-2 h-2 rounded-full bg-mint animate-pulse" aria-hidden="true" /> LIVE
            </span>
          </div>
          <div className="font-mono text-[40px] sm:text-[46px] leading-none mt-4 tracking-tight">{coins ? usd(liveUsd, 2) : "…"}</div>
          <div className="h-px bg-night-line my-6" />
          <div className="grid grid-cols-3 gap-4">
            <Stat dark label="Coins" value={coins ? String(coins.length) : "…"} />
            <Stat dark label="Graduated" value={coins ? String(graduatedCount) : "…"} />
            <Stat dark label="Target" value={usd(TARGET_USD)} />
          </div>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-4 sm:px-6 pb-12">
        <ol className="grid gap-4 sm:grid-cols-3">
          {[
            ["1", "Pick your chains", "Name your coin, add a picture and choose where it launches. One form, every chain you pick."],
            ["2", "Everyone pushes together", "Buys on every chain add up. One progress bar shows how close the coin is to graduating."],
            ["3", "The winner takes it", "At the target, the chain with the most money wins. The coin moves to a locked pool there; buyers elsewhere can move over or take their money back."],
          ].map(([n, t, d]) => (
            <li key={n} className="border-t-2 border-ink pt-5">
              <span className="font-mono text-[13px] text-emerald">0{n}</span>
              <h3 className="font-display font-semibold text-[20px] mt-2">{t}</h3>
              <p className="text-[15px] leading-relaxed text-ink-2 mt-2">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="explore" className="max-w-6xl mx-auto px-4 sm:px-6 py-12 scroll-mt-20">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <h2 className="font-display font-semibold text-[28px] sm:text-[34px] tracking-tight">Explore</h2>
          <div role="tablist" aria-label="Sort coins" className="grid grid-cols-3 gap-1 p-1 bg-line/60 rounded-xl">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={"h-10 px-4 rounded-lg text-[14px] font-semibold " + (tab === t.id ? "bg-white text-ink shadow-sm" : "text-ink-2")}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[14px] text-ink-3 mt-3">{TABS.find((t) => t.id === tab)?.note}</p>

        {error && (
          <div className="mt-6 p-4 rounded-2xl bg-warn-bg text-warn-ink text-[15px] flex items-center justify-between gap-4">
            <span>{error}</span>
            <button type="button" onClick={reload} className="font-semibold underline">Try again</button>
          </div>
        )}

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {!coins && !error && [0, 1, 2].map((i) => <Skeleton key={i} className="h-44" />)}
          {list.map((c) => (
            <CoinCard key={c.id} coin={c} />
          ))}
        </div>
        {coins && list.length === 0 && (
          <div className="mt-6 text-center py-12 border border-dashed border-line rounded-2xl">
            <p className="text-ink-2">{tab === "graduated" ? "No graduates yet." : "No coins racing right now. Start one."}</p>
            <Link href="/create/" className="inline-flex mt-4 h-11 px-6 rounded-xl bg-emerald text-white font-semibold items-center">
              Create a coin
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
