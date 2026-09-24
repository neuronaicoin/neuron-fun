"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CoinCard, CoinAvatar, Skeleton, Stat, useSiteData } from "@/components/coins";
import { fmtEth, fmtTokens } from "@/lib/format";

type Tab = "new" | "biggest" | "burned";
const TABS: { id: Tab; label: string; note: string }[] = [
  { id: "new", label: "Newest", note: "Coins created most recently." },
  { id: "biggest", label: "Biggest", note: "Coins with the highest market value." },
  { id: "burned", label: "Most burned", note: "Coins that have burned the most for their family." },
];

export default function Home() {
  const { data, error, reload } = useSiteData();
  const [tab, setTab] = useState<Tab>("new");

  const sorted = useMemo(() => {
    if (!data) return [];
    const list = [...data.coins];
    if (tab === "biggest") list.sort((a, b) => ((b.marketCapWei ?? 0n) > (a.marketCapWei ?? 0n) ? 1 : -1));
    if (tab === "burned") list.sort((a, b) => (b.burnedForParentWei > a.burnedForParentWei ? 1 : -1));
    return list;
  }, [data, tab]);

  const totalBurnSpend = data?.coins.reduce((s, c) => s + c.burnedForParentWei, 0n) ?? null;

  return (
    <div>
      {/* Hero */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 pt-10 sm:pt-16 pb-10 grid gap-10 lg:grid-cols-[1.3fr_1fr] lg:items-center">
        <div>
          <p className="font-mono text-[12px] tracking-[0.14em] text-emerald">MEME COINS, WITH A FAMILY</p>
          <h1 className="font-display font-semibold text-[40px] leading-[1.05] sm:text-[60px] tracking-tight mt-4">
            Every meme is born into a family.
          </h1>
          <p className="text-[17px] sm:text-[19px] leading-relaxed text-ink-2 mt-5 max-w-xl">
            Create a coin in a minute and pick a family coin for it. Every time your coin is bought or sold, part of the
            fee buys the family coin and burns it forever.
          </p>
          <div className="mt-7 flex flex-col sm:flex-row gap-3">
            <Link href="/create/" className="h-13 px-7 rounded-xl bg-emerald text-white text-[16px] font-semibold flex items-center justify-center hover:bg-emerald-dark">
              Create a coin
            </Link>
            <a href="#explore" className="h-13 px-7 rounded-xl border border-ink text-ink text-[16px] font-semibold flex items-center justify-center">
              Explore coins
            </a>
          </div>
        </div>

        <div className="bg-night text-mist rounded-3xl p-6 sm:p-7">
          <div className="flex items-center justify-between">
            <span className="text-[14px] font-semibold text-[#a9bab3]">$NEURON burned so far</span>
            <span className="flex items-center gap-2 font-mono text-[12px] text-mint">
              <span className="w-2 h-2 rounded-full bg-mint animate-pulse" aria-hidden="true" /> LIVE
            </span>
          </div>
          <div className="font-mono text-[40px] sm:text-[46px] leading-none mt-4 tracking-tight">
            {data ? fmtTokens(data.neuronBurned) : "…"}
          </div>
          <div className="h-px bg-night-line my-6" />
          <div className="grid grid-cols-2 gap-4">
            <Stat dark label="Coins created" value={data ? String(data.coins.length) : "…"} />
            <Stat dark label="Spent on burns" value={data ? fmtEth(totalBurnSpend, 5) : "…"} />
          </div>
        </div>
      </section>

      {/* How it works, short */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 pb-12">
        <ol className="grid gap-4 sm:grid-cols-3">
          {[
            ["1", "Pick a family", "Choose an existing coin as your coin's family. Its community notices you from day one."],
            ["2", "Create your coin", "Name it, add a picture, done. The money pool is locked forever, so nobody can pull it out."],
            ["3", "Every trade feeds the family", "Part of every trading fee buys the family coin and burns it. You earn a share too."],
          ].map(([n, t, d]) => (
            <li key={n} className="border-t-2 border-ink pt-5">
              <span className="font-mono text-[13px] text-emerald">0{n}</span>
              <h3 className="font-display font-semibold text-[20px] mt-2">{t}</h3>
              <p className="text-[15px] leading-relaxed text-ink-2 mt-2">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Families */}
      <section className="bg-night text-mist">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12">
          <h2 className="font-display font-semibold text-[28px] sm:text-[34px] tracking-tight">Families</h2>
          <p className="text-[#a9bab3] mt-2 text-[15px]">Coins you can pick as a family, and what their children have burned for them.</p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {!data &&
              [0, 1].map((i) => <div key={i} className="h-28 rounded-2xl bg-night-2 animate-pulse" />)}
            {data?.parents.map((p) => (
              <div key={p.token} className="border border-night-line rounded-2xl p-5">
                <div className="flex items-center gap-3">
                  <CoinAvatar logo={p.logo} symbol={p.symbol} size={42} />
                  <div className="min-w-0">
                    <div className="font-display font-semibold truncate">{p.name}</div>
                    <div className="text-[13px] text-[#a9bab3]">${p.symbol}</div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 mt-4">
                  <Stat dark label="Children" value={String(p.children)} />
                  <Stat dark label="Spent on burns" value={fmtEth(p.burnedForItWei, 5)} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Explore */}
      <section id="explore" className="max-w-6xl mx-auto px-4 sm:px-6 py-12 scroll-mt-20">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <h2 className="font-display font-semibold text-[28px] sm:text-[34px] tracking-tight">Explore</h2>
          <div role="tablist" aria-label="Sort coins" className="grid grid-cols-3 gap-1 p-1 bg-line/60 rounded-xl sm:w-auto">
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
          {!data && !error && [0, 1, 2].map((i) => <Skeleton key={i} className="h-40" />)}
          {sorted.map((c) => (
            <CoinCard key={c.token} coin={c} />
          ))}
        </div>
        {data && data.coins.length === 0 && (
          <div className="mt-6 text-center py-12 border border-dashed border-line rounded-2xl">
            <p className="text-ink-2">No coins yet. Be the first.</p>
            <Link href="/create/" className="inline-flex mt-4 h-11 px-6 rounded-xl bg-emerald text-white font-semibold items-center">
              Create a coin
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
