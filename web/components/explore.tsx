"use client";

import { GetAppButton } from "@/components/getapp";
import { BoostedRow } from "@/components/boost";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChainChip, CoinAvatar, SkeletonTile, useCoins, usd } from "@/components/coins";
import { CoinTile, LiveTicker } from "@/components/discover";
import { CHAINS, TARGET_USD } from "@/lib/config";
import { coinHref, fetchCoinCount, type Coin, type SortKey } from "@/lib/data";
import { fetchPrices } from "@/lib/price";
import { Landing } from "@/components/landing";
import { ScrollRow } from "@/components/scrollrow";
import { useSparks } from "@/lib/spark";
import { compactUsd } from "@/lib/format";
import { EXT_NETWORKS, fetchExtCoins, fetchExtCount, type ExtCoin, type ExtSort } from "@/lib/extcoins";
import { ExtTile } from "@/components/exttile";
import { MERGED_SORTS, rankMerged } from "@/lib/rank";

// Sorts that also apply to coins from other DEXs (the rest are about our curves).
// Trending is ranked by 24h volume for everyone (see lib/rank.ts).
const EXT_SORT: Partial<Record<SortKey, ExtSort>> = { trending: "volume", gainers: "gainers", losers: "losers", new: "new" };

const SORTS: { id: SortKey; label: string }[] = [
  { id: "trending", label: "🔥 Trending" },
  { id: "gainers", label: "Top gainers 24h" },
  { id: "losers", label: "Top losers 24h" },
  { id: "hot", label: "Closest to graduate" },
  { id: "bonding", label: "Bonding" },
  { id: "new", label: "Newest" },
  { id: "graduated", label: "Graduated" },
];

// Minimum 24h volume and liquidity, in USD. Liquidity of a coin still on its
// curve is the money in its curves; other DEXs report their pool's liquidity.
const VOLUME_FILTERS = [0, 10_000, 50_000, 100_000, 500_000] as const;
const LIQUIDITY_FILTERS = [0, 5_000, 25_000, 100_000] as const;
const filterLabel = (v: number) => (v === 0 ? "Any" : `$${v >= 1000 ? `${v / 1000}K` : v}+`);

// Coins shown at first and added by each "Load more".
const STEP = 24;

export function Discover({ withLanding = false }: { withLanding?: boolean }) {
  const [sort, setSort] = useState<SortKey>("trending");
  const [chain, setChain] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const { coins, error, reload, hasMore, loadMore, loadingMore } = useCoins(sort, search);
  const [minVol, setMinVol] = useState(0);
  const [minLiq, setMinLiq] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [shown, setShown] = useState(STEP);
  const [growing, setGrowing] = useState(false);
  // A new tab, chain, search or filter starts from the top again.
  useEffect(() => setShown(STEP), [sort, chain, search, minVol, minLiq]);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  // Coins from every other DEX on the same chains, shown after ours.
  const [ext, setExt] = useState<ExtCoin[] | null>(null);
  const [extTotal, setExtTotal] = useState<number | null>(null);
  useEffect(() => {
    fetchExtCount().then(setExtTotal);
  }, []);
  const extSort = EXT_SORT[sort];
  // Ask for one step more than shown, so we know whether "Load more" has anything to add.
  const extLimit = shown + STEP;
  const firstExt = useRef(true);
  useEffect(() => {
    firstExt.current = true;
  }, [extSort, chain, search, minVol, minLiq]);
  useEffect(() => {
    if (!extSort) {
      setExt([]);
      return;
    }
    let alive = true;
    // Only a new list blanks the grid; loading more keeps what's on screen.
    if (firstExt.current) setExt(null);
    firstExt.current = false;
    const load = () =>
      fetchExtCoins(extSort, chain === "all" ? null : chain, search, extLimit, { minVol, minLiq })
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
  }, [extSort, chain, search, extLimit, minVol, minLiq]);

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
    if (minVol > 0) l = l.filter((c) => (ethUsd ? c.volumeNative24h * ethUsd : 0) >= minVol);
    if (minLiq > 0) l = l.filter((c) => (c.totalUsd ?? 0) >= minLiq);
    return l;
  }, [coins, chain, minVol, minLiq, ethUsd]);

  // One fair list: our coins and other DEXs' ranked by the same measure.
  const ranked = useMemo(
    () => (MERGED_SORTS.has(sort) ? rankMerged(list, ext ?? [], sort, ethUsd) : list.map((c) => ({ kind: "ours" as const, coin: c }))),
    [list, ext, sort, ethUsd]
  );
  const visible = ranked.slice(0, shown);
  const extFull = !!extSort && (ext?.length ?? 0) >= extLimit;
  const canGrow = ranked.length > shown || hasMore || extFull;
  const filtered = minVol > 0 || minLiq > 0;

  async function grow() {
    setGrowing(true);
    try {
      // Fetch the next page of our coins too when we're about to run out of them.
      if (hasMore && list.length < shown + STEP) await loadMore();
      setShown((n) => n + STEP);
    } finally {
      setGrowing(false);
    }
  }

  const sparks = useSparks(useMemo(() => visible.flatMap((r) => (r.kind === "ours" ? [r.coin.id] : [])), [visible]));
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
          <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl border border-line bg-surface px-4 py-3 sm:p-10">
            <div
              className="absolute inset-0 opacity-[0.07] pointer-events-none"
              style={{ backgroundImage: "radial-gradient(#2fd39b 1px, transparent 1px)", backgroundSize: "22px 22px" }}
              aria-hidden="true"
            />
            <div className="relative">
              <p className="hidden sm:block font-mono text-[0.75rem] tracking-[0.16em] text-emerald">
                CREATE <span aria-hidden="true">→</span> MULTI-CHAIN <span className="text-[1.35em] leading-none align-[-0.1em]">🔥</span>{" "}
                <span aria-hidden="true">→</span> BONDING <span aria-hidden="true">→</span> GRADUATE{" "}
                <span className="text-[1.35em] leading-none align-[-0.1em]">🚀</span>
              </p>
              <HeroMessages />
              <div className="mt-2 sm:mt-6 grid grid-cols-4 gap-2 sm:gap-3 max-w-lg">
                <div>
                  <div className="font-mono text-[1rem] sm:text-[1.625rem]">{coins ? compactUsd(liveUsd) : <StatSkeleton />}</div>
                  <div className="text-[0.6875rem] sm:text-[0.75rem] text-ink-3">racing now</div>
                </div>
                <div>
                  <div className="font-mono text-[1rem] sm:text-[1.625rem]">{trades24h ?? <StatSkeleton />}</div>
                  <div className="text-[0.6875rem] sm:text-[0.75rem] text-ink-3">trades 24h</div>
                </div>
                <div>
                  <div className="font-mono text-[1rem] sm:text-[1.625rem]">{total ?? <StatSkeleton />}</div>
                  <div className="text-[0.6875rem] sm:text-[0.75rem] text-ink-3 truncate">launched here</div>
                </div>
                {/* Kept apart from our launchpad's numbers so neither is inflated. */}
                <div>
                  <div className="font-mono text-[1rem] sm:text-[1.625rem]">{extTotal ?? <StatSkeleton />}</div>
                  <div className="text-[0.6875rem] sm:text-[0.75rem] text-ink-3">to trade</div>
                </div>
              </div>
            </div>
          </div>

          <div className="hidden lg:flex relative overflow-hidden rounded-3xl border border-line bg-surface p-8 flex-col justify-between gap-6">
            <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-emerald/10 blur-3xl pointer-events-none" aria-hidden="true" />
            <div className="relative">
              <h2 className="font-display font-semibold text-[1.75rem] sm:text-[2.25rem] leading-tight">
                Create on <span className="text-emerald">multiple chains</span> at once
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
        <GetAppButton />
        <Link href="/traders/" className="h-10 px-4 shrink-0 rounded-xl border border-line bg-surface font-semibold text-[0.875rem] flex items-center">🏆 Top traders</Link>
        <Link href="/points/#invite" className="h-10 px-4 shrink-0 rounded-xl border border-line bg-surface font-semibold text-[0.875rem] flex items-center">⚡ Invite &amp; earn</Link>
        <a href="/forum/" className="h-10 px-4 shrink-0 rounded-xl border border-line bg-surface font-semibold text-[0.875rem] flex items-center">💬 Forum</a>
      </nav>

      <section id="explore" className="max-w-7xl mx-auto px-4 sm:px-6 pt-4 pb-8 sm:py-8 scroll-mt-20">
        <div className="rounded-3xl border border-line bg-surface p-4 sm:p-6">
          <BoostedRow />
          <AlmostThere coins={racing} />
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
                <Link
                  href="/points/#invite"
                  className="hidden lg:inline-flex h-9 px-3.5 rounded-xl border border-line bg-paper text-ink font-bold text-[0.8125rem] items-center gap-1.5 hover:border-emerald/60"
                >
                  ⚡ Invite &amp; earn
                </Link>
              </div>
              <p className="font-mono text-[0.75rem] text-ink-3 tracking-wider mt-1">{coins ? `${visible.length} SHOWN` : "LOADING"}</p>
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

          {/* Phones: volume and liquidity sit behind one button, so coins show on the first screen. */}
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
            className={"sm:hidden mt-2.5 h-10 px-4 rounded-xl border text-[0.875rem] font-semibold flex items-center gap-2 " + (minVol || minLiq ? "border-emerald text-emerald" : "border-line")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" strokeLinecap="round" /></svg>
            Filters{minVol || minLiq ? ` (${(minVol ? 1 : 0) + (minLiq ? 1 : 0)})` : ""}
            <span aria-hidden="true" className="text-ink-3">{showFilters ? "▴" : "▾"}</span>
          </button>
          <div className={(showFilters ? "grid" : "hidden") + " mt-2.5 gap-2.5 sm:flex sm:flex-wrap"}>
            <FilterRow label="Volume 24h" values={VOLUME_FILTERS} value={minVol} onChange={setMinVol} />
            <FilterRow label="Liquidity" values={LIQUIDITY_FILTERS} value={minLiq} onChange={setMinLiq} />
          </div>

          {error && (
            <div className="mt-5 p-4 rounded-2xl bg-warn-bg text-warn-ink text-[0.9375rem] flex items-center justify-between gap-4">
              <span>{error}</span>
              <button type="button" onClick={reload} className="font-semibold underline">Try again</button>
            </div>
          )}

          <div className="mt-5 grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
            {!coins && !error && [0, 1, 2, 3, 4, 5, 6, 7].map((i) => <SkeletonTile key={i} />)}
            {coins &&
              visible.map((r) =>
                r.kind === "ours" ? (
                  <CoinTile key={r.coin.id} coin={r.coin} ethUsd={ethUsd} spark={sparks.get(r.coin.id)} />
                ) : (
                  <ExtTile key={`${r.coin.network}:${r.coin.address}`} coin={r.coin} />
                )
              )}
            {coins && (growing || (ext === null && !!extSort)) && [0, 1, 2, 3].map((i) => <SkeletonTile key={`more-${i}`} />)}
          </div>
          {coins && visible.length > 0 && (
            <div className="mt-6 flex flex-col items-center gap-2">
              {canGrow ? (
                <button
                  type="button"
                  onClick={() => void grow()}
                  disabled={growing || loadingMore}
                  className="h-12 px-8 rounded-xl border border-line bg-paper text-ink font-semibold hover:border-emerald disabled:opacity-50"
                >
                  {growing || loadingMore ? "Loading…" : "Load more"}
                </button>
              ) : null}
              <p className="text-[0.75rem] text-ink-3">
                {canGrow ? `Showing ${visible.length}` : `All ${visible.length} shown`}
              </p>
            </div>
          )}
          {coins && ranked.length === 0 && ext !== null && (
            <div className="mt-5 text-center py-12 border border-dashed border-line rounded-2xl">
              <p className="text-ink-2">
                {filtered
                  ? "No coins match these filters."
                  : search
                    ? "Nothing matches that search."
                    : sort === "graduated"
                      ? "No graduates yet."
                      : sort === "bonding"
                        ? "No coins on their bonding curve right now."
                        : "No coins here yet. Start one."}
              </p>
              {filtered ? (
                <button
                  type="button"
                  onClick={() => {
                    setMinVol(0);
                    setMinLiq(0);
                  }}
                  className="inline-flex mt-4 h-11 px-6 rounded-xl border border-line bg-paper font-semibold items-center hover:border-emerald"
                >
                  Clear filters
                </button>
              ) : (
                <Link href="/create/" className="inline-flex mt-4 h-11 px-6 rounded-xl bg-emerald text-on-accent font-semibold items-center">Create a coin</Link>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
    </>
  );
}

function StatSkeleton() {
  return <span className="shimmer block h-[1.25rem] sm:h-[1.625rem] w-14 rounded-md my-[0.25rem]" aria-hidden="true" />;
}

/** A filter in the same box style as the chain picker above it: label first, then the minimums. */
function FilterRow({ label, values, value, onChange }: { label: string; values: readonly number[]; value: number; onChange: (v: number) => void }) {
  return (
    <div
      className="flex items-center gap-1 p-1 rounded-2xl border border-line bg-paper w-full sm:w-fit overflow-x-auto [scrollbar-width:none]"
      role="group"
      aria-label={`Minimum ${label.toLowerCase()}`}
    >
      <span className="shrink-0 h-6 pl-2.5 pr-3 mr-0.5 border-r border-line text-[0.8125rem] font-bold text-ink whitespace-nowrap flex items-center">
        {label}
      </span>
      {values.map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={
            "shrink-0 h-9 px-3 sm:px-4 rounded-xl text-[0.8125rem] font-semibold whitespace-nowrap flex items-center justify-center " +
            (value === v ? "bg-ink text-paper shadow-sm" : "text-ink-2 hover:text-ink")
          }
        >
          {filterLabel(v)}
        </button>
      ))}
    </div>
  );
}

/**
 * The hero's headline and line under it: one of sasa's real features, changing every
 * 25 seconds (the dots jump to one). Every line here must be true on the live site.
 * Each headline is two short lines (the second in the accent colour), so the card
 * keeps its height as they change.
 */
const HERO_MESSAGES: { a: string[]; b: string[]; sub: string }[] = [
  { a: ["No wallet.", "No gas."], b: ["No bridge.", "Just buy."], sub: "Sign in with email, add USDC from any chain and buy any coin in one tap." },
  { a: ["One sentence."], b: ["Your coin,", "made by AI."], sub: "Describe an idea. Get a name, ticker, logo and story in seconds, ready to launch." },
  { a: ["Launch once."], b: ["Live on", "every chain."], sub: "Buyers on every chain push your coin to graduation together. The chain with the most money wins." },
  { a: ["Spot a top trader?"], b: ["Copy in", "one tap."], sub: "Follow the best traders and get their buys as signals you can copy or skip." },
  { a: ["Set your exit."], b: ["It sells", "itself."], sub: "Take profit, stop loss and buy-the-dip orders fill on their own, even while you sleep." },
  { a: ["Every hot coin."], b: ["One place", "to trade them."], sub: "Coins from sasa and other DEXs, ranked by real volume. No head start for anyone." },
  { a: ["Invite a friend."], b: ["Share", "their fees."], sub: "Friends start with 100 points. You earn a share of sasa's fees on their trades for a year." },
];
const HERO_EVERY_MS = 25_000;

function HeroMessages() {
  const [i, setI] = useState(0);
  const [tick, setTick] = useState(0); // restarts the timer when someone picks a dot
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") setI((n) => (n + 1) % HERO_MESSAGES.length);
    }, HERO_EVERY_MS);
    return () => clearInterval(t);
  }, [tick]);
  const m = HERO_MESSAGES[i];
  // The last phrase of the second line takes the accent colour ("Just buy.").
  const words = (parts: string[], accentLast = false) =>
    parts.map((w, k) => (
      <span key={k} className={"whitespace-nowrap" + (accentLast && k === parts.length - 1 ? " text-emerald" : "")}>
        {k > 0 ? " " : ""}
        {w}
      </span>
    ));
  return (
    <>
      <h1
        key={i}
        className="hero-swap font-display font-semibold text-[1.1875rem] sm:text-[2.75rem] lg:text-[clamp(2.5rem,4.1vw,3.625rem)] leading-[1.1] tracking-tight sm:mt-3 min-h-[2.2em]"
      >
        {words(m.a)}
        <br />
        {words(m.b, true)}
      </h1>
      <p key={`s${i}`} className="hero-swap hidden sm:block text-[1.125rem] text-ink-2 mt-4 max-w-xl min-h-[3.4em]">
        {m.sub}
      </p>
      <div className="hidden sm:flex gap-1.5 mt-3" role="group" aria-label="More about sasa">
        {HERO_MESSAGES.map((_, k) => (
          <button
            key={k}
            type="button"
            aria-label={`Show message ${k + 1}`}
            aria-pressed={k === i}
            onClick={() => {
              setI(k);
              setTick((t) => t + 1);
            }}
            className="h-5 flex items-center group"
          >
            <span className={"block h-1.5 rounded-full transition-all " + (k === i ? "w-5 bg-emerald" : "w-1.5 bg-line group-hover:bg-ink-3")} />
          </button>
        ))}
      </div>
    </>
  );
}


/** Coins close to graduating (70%+): a last push often comes from seeing that. Plain data, no paid placement. */
function AlmostThere({ coins }: { coins: Coin[] }) {
  const near = coins
    .filter((c) => !c.graduatedOn && !c.graduating && c.progress >= 0.7 && c.progress < 1)
    .sort((a, b) => b.progress - a.progress)
    .slice(0, 10);
  if (!near.length) return null;
  return (
    <section aria-label="Almost graduating" className="mb-5">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="font-display font-bold text-[1.0625rem] flex items-center gap-2">
          <span className="almost-live" aria-hidden="true" />
          🎓 Almost graduating
        </h3>
        <span className="text-[0.6875rem] text-ink-3">70%+ of the way</span>
      </div>
      <div className="flex gap-2.5 overflow-x-auto no-scrollbar pb-2 pt-1 px-0.5 snap-x snap-mandatory">
        {near.map((c) => {
          const pct = Math.min(99, Math.floor(c.progress * 100));
          const hot = pct >= 90;
          const left = c.totalUsd !== null ? Math.max(0, TARGET_USD - c.totalUsd) : null;
          // The tip grows as the coin gets closer: 0.95rem at 90% up to ~1.5rem at 99%.
          const tipSize = hot ? 0.95 + (pct - 90) * 0.06 : 0.85;
          return (
            <Link
              key={c.id}
              href={coinHref(c)}
              className={"almost-card snap-start shrink-0 w-[13.75rem] rounded-2xl border-[1.5px] bg-paper p-2.5 relative overflow-hidden " + (hot ? "almost-hot border-emerald" : "border-line hover:border-emerald/60")}
            >
              {hot && <span className="absolute top-2 right-2 rounded-full bg-emerald text-on-accent text-[0.625rem] font-extrabold tracking-wide px-1.5 py-0.5">HOT</span>}
              <span className="flex items-center gap-2.5">
                <CoinAvatar logo={c.logo} symbol={c.symbol} size={40} />
                <span className="min-w-0">
                  <b className="block truncate pr-8">{c.name}</b>
                  <span className={"block font-mono font-semibold text-[0.875rem] " + (hot ? "text-emerald" : "text-up")}>
                    {pct}%<span className="font-sans font-normal text-[0.6875rem] text-ink-3 ml-1">graduated</span>
                  </span>
                  {left !== null && <span className="block text-[0.6875rem] text-ink-3">{usd(left, left < 100 ? 2 : 0)} to go</span>}
                </span>
              </span>
              <span className="relative block h-2.5 rounded-full bg-line mt-3.5 mb-1 mr-2.5" aria-hidden="true">
                <span className="almost-fill absolute inset-y-0 left-0 rounded-full overflow-hidden" style={{ width: `${pct}%` }} />
                {hot && (
                  <>
                    <span className="almost-spark absolute -top-3" style={{ left: `${pct - 6}%` }}>✨</span>
                    <span className="almost-spark absolute -top-3.5 [animation-delay:.8s]" style={{ left: `${pct - 2}%` }}>✨</span>
                  </>
                )}
                <span className="almost-tip absolute top-1/2 leading-none" style={{ left: `${pct}%`, fontSize: `${tipSize}rem` }}>
                  {hot ? "🔥" : "⭐"}
                </span>
                <span className="absolute -right-2.5 top-1/2 -translate-y-1/2 text-[0.95rem] leading-none">🎓</span>
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
