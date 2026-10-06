"use client";

import { BoostedRow } from "@/components/boost";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CoinAvatar, useCoins, usd } from "@/components/coins";
import { coinMarketCapUsd } from "@/components/discover";
import { TARGET_USD } from "@/lib/config";
import { coinHref, isImageUrl, type Coin, type SortKey } from "@/lib/data";
import { fetchPrices } from "@/lib/price";
import { Landing } from "@/components/landing";
import { compactUsd } from "@/lib/format";
import { EXT_NETWORKS, extHref, extNetwork, fetchExtCoins, type ExtCoin, type ExtSort } from "@/lib/extcoins";
import { MERGED_SORTS, rankMerged, type Ranked } from "@/lib/rank";

// Sorts that also apply to coins from other DEXs (the rest are about our curves).
// Trending is ranked by 24h volume for everyone (see lib/rank.ts).
const EXT_SORT: Partial<Record<SortKey, ExtSort>> = { trending: "volume", gainers: "gainers", losers: "losers", new: "new" };

const SORTS: { id: SortKey; label: string }[] = [
  { id: "trending", label: "Trending" },
  { id: "new", label: "New" },
  { id: "hot", label: "Almost graduating" },
  { id: "bonding", label: "Bonding" },
  { id: "graduated", label: "Graduated" },
  { id: "gainers", label: "Gainers" },
  { id: "losers", label: "Losers" },
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
  // Coins from every other DEX on the same chains, shown after ours.
  const [ext, setExt] = useState<ExtCoin[] | null>(null);
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

  const racing = coins?.filter((c) => !c.graduatedOn) ?? [];
  const rows = visible.map((r) => toRow(r, ethUsd));
  const loading = !coins && !error;
  const moreLoading = !!coins && (growing || (ext === null && !!extSort));

  return (
    <>
    {withLanding && (
      <div className="landing-root">
        <Landing />
      </div>
    )}
    <div className="app-root">
      <section id="explore" className="max-w-7xl mx-auto pb-8 scroll-mt-20">
        <div className="px-4 sm:px-6 pt-4 sm:pt-6 flex items-center gap-3">
          <h1 className="font-display font-bold text-[1.375rem] sm:text-[1.625rem] tracking-tight shrink-0">Explore</h1>
          <div className="flex-1" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search coins"
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            className="h-10 w-full max-w-[13rem] sm:max-w-[20rem] min-w-0 px-3 rounded-xl border border-line bg-paper text-ink placeholder:text-ink-3 focus:border-ink-3 outline-none"
          />
        </div>

        <div className="px-4 sm:px-6">
          <BoostedRow />
          <AlmostThere coins={racing} />
        </div>

        <div className="mt-3 border-b border-line">
          <div className="ex-tabs flex gap-5 sm:gap-6 overflow-x-auto px-4 sm:px-6" role="tablist" aria-label="Sort coins">
            {SORTS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={sort === s.id}
                onClick={(e) => {
                  setSort(s.id);
                  e.currentTarget.scrollIntoView({ inline: "nearest", block: "nearest" });
                }}
                className={
                  "shrink-0 -mb-px py-3 border-b-2 text-[0.9375rem] whitespace-nowrap " +
                  (sort === s.id ? "border-ink text-ink font-semibold" : "border-transparent text-ink-3 font-medium hover:text-ink")
                }
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="px-4 sm:px-6 pt-2.5 flex items-center gap-2">
          <div className="ex-tabs flex-1 min-w-0 flex gap-1 overflow-x-auto" role="group" aria-label="Chain">
            {[{ key: "all", short: "All chains", color: "" }, ...EXT_NETWORKS.map((n) => ({ key: n.id, short: n.label, color: n.color }))].map((c) => (
              <button
                key={c.key}
                type="button"
                aria-pressed={chain === c.key}
                onClick={() => setChain(c.key)}
                className={
                  "shrink-0 h-8 px-3 rounded-lg text-[0.8125rem] whitespace-nowrap flex items-center gap-1.5 " +
                  (chain === c.key ? "bg-night-2 text-ink font-semibold" : "text-ink-3 font-medium hover:text-ink")
                }
              >
                {c.color && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: c.color }} aria-hidden="true" />}
                {c.short}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
            className={"shrink-0 h-8 px-3 rounded-lg border text-[0.8125rem] font-medium flex items-center gap-1.5 " + (minVol || minLiq ? "border-ink text-ink" : "border-line text-ink-2")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" strokeLinecap="round" /></svg>
            Filters{minVol || minLiq ? ` (${(minVol ? 1 : 0) + (minLiq ? 1 : 0)})` : ""}
          </button>
        </div>
        {showFilters && (
          <div className="px-4 sm:px-6 pt-2.5 grid gap-2 sm:flex sm:flex-wrap sm:gap-4">
            <FilterRow label="Volume 24h" values={VOLUME_FILTERS} value={minVol} onChange={setMinVol} />
            <FilterRow label="Liquidity" values={LIQUIDITY_FILTERS} value={minLiq} onChange={setMinLiq} />
          </div>
        )}

        {error && (
          <div className="mx-4 sm:mx-6 mt-4 p-4 rounded-xl bg-warn-bg text-warn-ink text-[0.9375rem] flex items-center justify-between gap-4">
            <span>{error}</span>
            <button type="button" onClick={reload} className="font-semibold underline shrink-0">Try again</button>
          </div>
        )}

        {/* Phones: one coin per row. */}
        <ul className="md:hidden mt-2 border-t border-line">
          {loading && Array.from({ length: 10 }, (_, i) => <RowSkeleton key={i} />)}
          {rows.map((r) => <CoinRow key={r.key} r={r} />)}
          {moreLoading && Array.from({ length: 4 }, (_, i) => <RowSkeleton key={`m${i}`} />)}
        </ul>

        {/* Computers and tablets: a table. */}
        <div className="hidden md:block mt-2 px-2 lg:px-3">
          <table className="w-full border-collapse text-[0.875rem]">
            <thead>
              <tr className="text-[0.75rem] text-ink-3 text-right">
                <th className="font-medium text-left py-2.5 px-3">Coin</th>
                <th className="font-medium py-2.5 px-3">Market cap</th>
                <th className="font-medium py-2.5 px-3">24h</th>
                <th className="font-medium py-2.5 px-3">Volume 24h</th>
                <th className="font-medium py-2.5 px-3 hidden lg:table-cell">Liquidity</th>
                <th className="font-medium py-2.5 px-3 hidden lg:table-cell">Holders</th>
                <th className="font-medium py-2.5 px-3">Age</th>
                <th className="font-medium py-2.5 px-3 w-[9.5rem]">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && Array.from({ length: 12 }, (_, i) => <TableSkeleton key={i} />)}
              {rows.map((r) => <CoinTableRow key={r.key} r={r} />)}
              {moreLoading && Array.from({ length: 4 }, (_, i) => <TableSkeleton key={`m${i}`} />)}
            </tbody>
          </table>
        </div>

        {coins && visible.length > 0 && (
          <div className="mt-5 px-4 flex flex-col items-center gap-2">
            {canGrow ? (
              <button
                type="button"
                onClick={() => void grow()}
                disabled={growing || loadingMore}
                className="h-11 px-8 rounded-xl border border-line text-ink font-semibold hover:bg-night disabled:opacity-50"
              >
                {growing || loadingMore ? "Loading…" : "Load more"}
              </button>
            ) : null}
            <p className="text-[0.75rem] text-ink-3">{canGrow ? `Showing ${visible.length}` : `All ${visible.length} shown`}</p>
          </div>
        )}
        {coins && ranked.length === 0 && ext !== null && (
          <div className="mx-4 sm:mx-6 mt-5 text-center py-12 border border-dashed border-line rounded-xl">
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
                className="inline-flex mt-4 h-11 px-6 rounded-xl border border-line font-semibold items-center"
              >
                Clear filters
              </button>
            ) : (
              <Link href="/create/" className="inline-flex mt-4 h-11 px-6 rounded-xl bg-emerald text-on-accent font-semibold items-center">Create a coin</Link>
            )}
          </div>
        )}
      </section>
    </div>
    </>
  );
}

/** A filter row: label, then the minimums. */
function FilterRow({ label, values, value, onChange }: { label: string; values: readonly number[]; value: number; onChange: (v: number) => void }) {
  return (
    <div className="ex-tabs flex items-center gap-1 overflow-x-auto min-w-0" role="group" aria-label={`Minimum ${label.toLowerCase()}`}>
      <span className="shrink-0 pr-2 text-[0.8125rem] font-semibold text-ink whitespace-nowrap">{label}</span>
      {values.map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={
            "shrink-0 h-8 px-3 rounded-lg text-[0.8125rem] whitespace-nowrap " +
            (value === v ? "bg-night-2 text-ink font-semibold" : "text-ink-3 font-medium hover:text-ink")
          }
        >
          {filterLabel(v)}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ rows */

type Row = {
  key: string;
  href: string;
  name: string;
  symbol: string;
  image: string | null;
  seed: string;
  mc: number | null;
  /** Percent (12.5 = +12.5%). */
  change: number | null;
  vol: number | null;
  liq: number | null;
  holders: number | null;
  since: string | null;
  /** 0..1 while on its curve; null for coins from other DEXs. */
  progress: number | null;
  graduated: boolean;
  graduating: boolean;
  /** Chain name, shown for coins from other DEXs. */
  where: string | null;
};

function toRow(r: Ranked, ethUsd: number | null): Row {
  if (r.kind === "ours") {
    const c = r.coin;
    return {
      key: c.id,
      href: coinHref(c),
      name: c.name,
      symbol: c.symbol,
      image: c.logo && isImageUrl(c.logo) ? c.logo : null,
      seed: c.id,
      mc: coinMarketCapUsd(c, ethUsd),
      change: c.change24h === null || !Number.isFinite(c.change24h) ? null : c.change24h * 100,
      vol: ethUsd ? c.volumeNative24h * ethUsd : null,
      liq: c.totalUsd,
      holders: c.holders,
      since: c.createdAt,
      progress: c.graduatedOn ? 1 : Math.max(0, Math.min(1, c.progress)),
      graduated: !!c.graduatedOn,
      graduating: c.graduating,
      where: null,
    };
  }
  const c = r.coin;
  return {
    key: `${c.network}:${c.address}`,
    href: extHref(c),
    name: c.name,
    symbol: c.symbol,
    image: c.image,
    seed: c.address,
    mc: c.mcapUsd,
    change: c.change24h,
    vol: c.vol24h,
    liq: c.liqUsd,
    holders: null,
    since: c.poolCreated,
    progress: null,
    graduated: false,
    graduating: false,
    where: extNetwork(c.network)?.label ?? null,
  };
}

function hue(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function RowAvatar({ r, size }: { r: Row; size: number }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };
  if (r.image && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={r.image} alt="" loading="lazy" decoding="async" style={style} className="rounded-full object-cover bg-night shrink-0" onError={() => setBroken(true)} />;
  }
  return (
    <span style={{ ...style, background: `hsl(${hue(r.seed)} 55% 48%)` }} className="rounded-full text-white font-bold flex items-center justify-center shrink-0" aria-hidden="true">
      <span style={{ fontSize: size * 0.4 }}>{(r.symbol || "?").slice(0, 1).toUpperCase()}</span>
    </span>
  );
}

function Change({ v }: { v: number | null }) {
  if (v === null || !Number.isFinite(v)) return <span className="text-ink-3">—</span>;
  const a = Math.abs(v);
  const text = a >= 1000 ? `${(a / 1000).toFixed(1)}K%` : `${a >= 100 ? a.toFixed(0) : a.toFixed(1)}%`;
  const up = v > 0.05;
  const down = v < -0.05;
  return <span className={up ? "text-up" : down ? "text-danger" : "text-ink-3"}>{(up ? "+" : down ? "−" : "") + text}</span>;
}

/** "3m", "5h", "2d": short, so the row stays one line. */
function age(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function gradText(r: Row): string {
  if (r.graduated) return "Graduated";
  if (r.graduating) return "Graduating";
  if (r.progress === null) return r.where ?? "—";
  return `${Math.min(99, Math.floor(r.progress * 100))}%`;
}

function CoinRow({ r }: { r: Row }) {
  const onCurve = r.progress !== null && !r.graduated;
  return (
    <li>
      <Link href={r.href} className="ex-row flex items-center gap-3 px-4 py-3 border-b border-line">
        <RowAvatar r={r} size={40} />
        <span className="flex-1 min-w-0">
          <span className="block font-semibold text-[1rem] leading-snug truncate">{r.name}</span>
          <span className="block text-[0.8125rem] text-ink-3 truncate">
            {r.symbol} · {age(r.since)}
            {r.where ? ` · ${r.where}` : r.graduated ? " · Graduated" : ""}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-mono font-semibold text-[1rem] leading-snug">{compactUsd(r.mc)}</span>
          <span className="block font-mono text-[0.8125rem] font-medium">
            <Change v={r.change} />
          </span>
          {onCurve && (
            <span className="block h-[3px] w-14 ml-auto mt-1 rounded-full bg-line overflow-hidden" aria-label={`${gradText(r)} to graduation`}>
              <span className="block h-full bg-emerald" style={{ width: `${Math.max(3, Math.round((r.progress ?? 0) * 100))}%` }} />
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

function CoinTableRow({ r }: { r: Row }) {
  const router = useRouter();
  const onCurve = r.progress !== null && !r.graduated && !r.graduating;
  return (
    <tr className="ex-row border-t border-line cursor-pointer" onClick={() => router.push(r.href)}>
      <td className="py-2.5 px-3">
        <Link href={r.href} className="flex items-center gap-2.5 min-w-0" onClick={(e) => e.stopPropagation()}>
          <RowAvatar r={r} size={30} />
          <span className="font-semibold truncate max-w-[16rem]">{r.name}</span>
          <span className="text-ink-3 text-[0.8125rem] shrink-0">{r.symbol}</span>
        </Link>
      </td>
      <td className="py-2.5 px-3 text-right font-mono font-semibold">{compactUsd(r.mc)}</td>
      <td className="py-2.5 px-3 text-right font-mono"><Change v={r.change} /></td>
      <td className="py-2.5 px-3 text-right font-mono">{compactUsd(r.vol)}</td>
      <td className="py-2.5 px-3 text-right font-mono hidden lg:table-cell">{compactUsd(r.liq)}</td>
      <td className="py-2.5 px-3 text-right font-mono hidden lg:table-cell">{r.holders === null ? "—" : r.holders.toLocaleString("en-US")}</td>
      <td className="py-2.5 px-3 text-right text-ink-2">{age(r.since)}</td>
      <td className="py-2.5 px-3">
        {onCurve ? (
          <span className="flex items-center justify-end gap-2">
            <span className="h-1 w-16 rounded-full bg-line overflow-hidden">
              <span className="block h-full bg-emerald" style={{ width: `${Math.max(3, Math.round((r.progress ?? 0) * 100))}%` }} />
            </span>
            <span className="font-mono w-9 text-right">{gradText(r)}</span>
          </span>
        ) : (
          <span className="block text-right text-ink-3">{gradText(r)}</span>
        )}
      </td>
    </tr>
  );
}

function RowSkeleton() {
  return (
    <li className="flex items-center gap-3 px-4 py-3 border-b border-line" aria-hidden="true">
      <span className="shimmer w-10 h-10 rounded-full shrink-0" />
      <span className="flex-1 grid gap-1.5">
        <span className="shimmer h-4 w-2/3 rounded" />
        <span className="shimmer h-3 w-1/3 rounded" />
      </span>
      <span className="grid gap-1.5 justify-items-end">
        <span className="shimmer h-4 w-16 rounded" />
        <span className="shimmer h-3 w-10 rounded" />
      </span>
    </li>
  );
}

function TableSkeleton() {
  return (
    <tr className="border-t border-line" aria-hidden="true">
      <td className="py-3 px-3"><span className="flex items-center gap-2.5"><span className="shimmer w-[30px] h-[30px] rounded-full" /><span className="shimmer h-4 w-36 rounded" /></span></td>
      {Array.from({ length: 7 }, (_, i) => (
        <td key={i} className={"py-3 px-3" + (i === 3 || i === 4 ? " hidden lg:table-cell" : "")}><span className="shimmer block h-4 w-14 ml-auto rounded" /></td>
      ))}
    </tr>
  );
}

/** Coins close to graduating (70%+), as a plain row. Plain data, no paid placement. */
function AlmostThere({ coins }: { coins: Coin[] }) {
  const near = coins
    .filter((c) => !c.graduatedOn && !c.graduating && c.progress >= 0.7 && c.progress < 1)
    .sort((a, b) => b.progress - a.progress)
    .slice(0, 10);
  if (!near.length) return null;
  return (
    <section aria-label="Almost graduating" className="mt-4">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <h2 className="font-semibold text-[0.9375rem]">Almost graduating</h2>
        <span className="text-[0.75rem] text-ink-3">70% or more</span>
      </div>
      <div className="ex-tabs flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 sm:mx-0 sm:px-0">
        {near.map((c) => {
          const pct = Math.min(99, Math.floor(c.progress * 100));
          const left = c.totalUsd !== null ? Math.max(0, TARGET_USD - c.totalUsd) : null;
          return (
            <Link key={c.id} href={coinHref(c)} className="shrink-0 w-[12.5rem] rounded-xl border border-line p-2.5 hover:border-ink-3">
              <span className="flex items-center gap-2.5">
                <CoinAvatar logo={c.logo} symbol={c.symbol} size={36} />
                <span className="min-w-0">
                  <b className="block truncate font-semibold text-[0.9375rem]">{c.name}</b>
                  <span className="block text-[0.75rem] text-ink-3">
                    <span className="font-mono text-ink font-semibold">{pct}%</span>
                    {left !== null && ` · ${usd(left, left < 100 ? 2 : 0)} to go`}
                  </span>
                </span>
              </span>
              <span className="block h-1 rounded-full bg-line mt-2.5 overflow-hidden" aria-hidden="true">
                <span className="block h-full bg-emerald" style={{ width: `${pct}%` }} />
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
