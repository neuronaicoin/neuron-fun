"use client";

/**
 * Market: the 500 biggest coins, plus the coins only Hyperliquid's spot market has (HYPE, KNTQ…), in one
 * list where every coin shows once. All bought and sold with USDC.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Skeleton } from "@/components/coins";
import { compactUsd } from "@/lib/format";
import { fmtPrice } from "@/lib/race";
import { extNetwork } from "@/lib/extcoins";
import { fetchTopCoins, topHref, type TopCoin } from "@/lib/topcoins";
import { MarketSwitch } from "@/components/marketswitch";
import { useSpotDesk } from "@/components/hlspot";
import { fetchHlSpot, newSpotOnly, spotHref, type HlSpot } from "@/lib/hlspot";

/** One Market row: a top-500 coin (opens its coin page) or a spot-only coin (opens the trade sheet). */
type Row = {
  key: string;
  name: string;
  symbol: string;
  image: string | null;
  rank: number | null;
  price: number | null;
  change24h: number | null;
  change7d: number | null;
  mcap: number | null;
  vol24h: number | null;
  spark: number[] | null;
  top?: TopCoin;
  spot?: HlSpot;
};
const fromTop = (c: TopCoin): Row => ({ key: c.id, name: c.name, symbol: c.symbol, image: c.image, rank: c.rank, price: c.priceUsd, change24h: c.change24h, change7d: c.change7d, mcap: c.mcapUsd, vol24h: c.vol24h, spark: c.spark, top: c });
const fromSpot = (m: HlSpot): Row => ({ key: "s:" + m.coin, name: m.name, symbol: m.token, image: null, rank: null, price: m.price, change24h: m.change24h, change7d: null, mcap: m.mcap, vol24h: m.vol24h, spark: null, spot: m });

type Sort = "top" | "gainers" | "losers" | "volume";
const SORTS: { id: Sort; label: string }[] = [
  { id: "top", label: "Top" },
  { id: "gainers", label: "Gainers" },
  { id: "losers", label: "Losers" },
  { id: "volume", label: "Volume" },
];
const STEP = 100;

function Spark({ pts, up }: { pts: number[] | null; up: boolean }) {
  if (!pts || pts.length < 2) return <span className="block w-24 h-8" />;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const d = pts.map((v, i) => `${((i / (pts.length - 1)) * 96).toFixed(1)},${(30 - ((v - min) / span) * 28 - 1).toFixed(1)}`).join(" ");
  return (
    <svg viewBox="0 0 96 30" className="w-24 h-8" aria-hidden="true">
      <polyline points={d} fill="none" stroke={up ? "var(--color-up)" : "var(--color-danger)"} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const pct = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
const tone = (v: number | null) => (v === null ? "text-ink-3" : v >= 0 ? "text-up" : "text-danger");

export default function MarketPage() {
  const [coins, setCoins] = useState<TopCoin[] | null>(null);
  const [error, setError] = useState(false);
  const [sort, setSort] = useState<Sort>("top");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(STEP);
  // coins only Hyperliquid's spot market has, joined into the same list (never a second copy of a coin)
  const [spot, setSpot] = useState<HlSpot[] | null>(null);
  const desk = useSpotDesk();
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchTopCoins()
        .then((c) => alive && (setCoins(c), setError(false)))
        .catch(() => alive && setError(true));
    const loadSpot = () =>
      fetchHlSpot()
        .then((l) => alive && setSpot(l))
        .catch(() => {});
    void load();
    void loadSpot();
    // prices change every minute (each coin's own DEX pool): ask every 30 seconds
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load();
      void loadSpot();
    }, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const extra = useMemo(() => (coins && spot ? newSpotOnly(spot, coins) : []), [coins, spot]);

  // old shared links (/market/?c=KNTQ) go to the coin's own page
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("c");
    if (c) window.location.replace(spotHref(c.toUpperCase()));
  }, []);

  const list = useMemo(() => {
    if (!coins) return null;
    const all = [...coins.map(fromTop), ...extra.map(fromSpot)];
    const s = q.trim().toLowerCase();
    const hit = s ? all.filter((c) => c.name.toLowerCase().includes(s) || c.symbol.toLowerCase().includes(s)) : all;
    const by = (f: (c: Row) => number | null, desc: boolean) =>
      hit.sort((a, b) => {
        const x = f(a);
        const y = f(b);
        if (x === null) return 1;
        if (y === null) return -1;
        return desc ? y - x : x - y;
      });
    if (sort === "gainers") return by((c) => c.change24h, true);
    if (sort === "losers") return by((c) => c.change24h, false);
    if (sort === "volume") return by((c) => c.vol24h, true);
    return by((c) => c.mcap, true);
  }, [coins, extra, sort, q]);

  const held = extra.filter((m) => (desk.bal.get(m.token) ?? 0) * m.price >= 0.5);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 sm:py-8 pb-28 md:pb-12">
      <MarketSwitch at="spot" />
      <h1 className="mt-3 font-display font-bold text-[1.625rem] sm:text-[2.25rem] tracking-tight">Market</h1>
      <p className="text-ink-2 text-[0.875rem] sm:text-[1rem]">The biggest coins in crypto. Buy and sell any of them with USDC in one tap.</p>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 overflow-x-auto no-scrollbar" role="tablist" aria-label="Sort">
          {SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={sort === s.id}
              onClick={() => (setSort(s.id), setShown(STEP))}
              className={"h-9 px-3.5 rounded-lg text-[0.875rem] font-semibold shrink-0 " + (sort === s.id ? "bg-ink text-mist" : "text-ink-2 hover:text-ink")}
            >
              {s.label}
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => (setQ(e.target.value), setShown(STEP))}
          placeholder="Search"
          aria-label="Search coins"
          className="h-10 w-full sm:w-64 rounded-xl border border-line bg-surface px-3.5 text-[0.9375rem] outline-none focus:border-ink-3"
        />
      </div>

      {held.length > 0 && (
        <div className="mt-3 rounded-2xl border border-line bg-surface p-3">
          <div className="text-[0.8125rem] text-ink-3 mb-2">You hold</div>
          <div className="flex flex-wrap gap-2">
            {held.map((m) => (
              <Link key={m.coin} href={spotHref(m.token)} className="h-9 px-3 rounded-xl border border-line text-[0.875rem] font-semibold hover:border-emerald/60 inline-flex items-center">
                {m.token} · {compactUsd((desk.bal.get(m.token) ?? 0) * m.price)}
              </Link>
            ))}
          </div>
        </div>
      )}

      {error && !coins && <p className="mt-6 text-danger">Could not load the market. Try again in a moment.</p>}

      <div className="mt-4 rounded-3xl border border-line bg-surface overflow-hidden">
        <div className="hidden sm:grid grid-cols-[2.5rem_minmax(0,1fr)_7rem_5rem_5rem_7rem_6.5rem] gap-3 px-4 py-2.5 text-[0.75rem] text-ink-3 border-b border-line">
          <span>#</span>
          <span>Coin</span>
          <span className="text-right">Price</span>
          <span className="text-right">24h</span>
          <span className="text-right">7d</span>
          <span className="text-right">Market cap</span>
          <span className="text-right">Last 7 days</span>
        </div>
        {list === null ? (
          <div className="p-4 flex flex-col gap-2">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <p className="p-6 text-center text-ink-3">{q ? "No coin by that name." : "The list is being prepared. Check back in a few minutes."}</p>
        ) : (
          <ul className="divide-y divide-line">
            {list.slice(0, shown).map((c) => {
              const net = c.top ? extNetwork(c.top.network) : null;
              const cls = "w-full text-left grid grid-cols-[1.75rem_minmax(0,1fr)_auto] sm:grid-cols-[2.5rem_minmax(0,1fr)_7rem_5rem_5rem_7rem_6.5rem] gap-3 items-center px-4 py-3 hover:bg-paper";
              const body = (
                <>
                  <span className="text-[0.8125rem] text-ink-3 tabular-nums">{c.rank ?? ""}</span>
                  <span className="flex items-center gap-3 min-w-0">
                    {c.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.image} alt="" width={32} height={32} className="w-8 h-8 rounded-full bg-paper shrink-0" loading="lazy" />
                    ) : (
                      <span className="w-8 h-8 rounded-full bg-paper shrink-0 grid place-items-center text-[0.75rem] font-bold text-ink-2" aria-hidden="true">
                        {c.symbol.slice(0, 1)}
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="block font-semibold text-[0.9375rem] truncate">{c.name}</span>
                      <span className="flex items-center gap-1.5 text-[0.75rem] text-ink-3 truncate">
                        {c.symbol}
                        {net && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: net.color }} title={net.label} />}
                      </span>
                    </span>
                  </span>
                  <span className="text-right sm:contents">
                    <span className="block sm:text-right font-mono text-[0.875rem] tabular-nums">{c.price === null ? "—" : fmtPrice(c.price)}</span>
                    <span className={"block sm:text-right font-mono text-[0.8125rem] tabular-nums " + tone(c.change24h)}>{pct(c.change24h)}</span>
                    <span className={"hidden sm:block text-right font-mono text-[0.8125rem] tabular-nums " + tone(c.change7d)}>{pct(c.change7d)}</span>
                    <span className="hidden sm:block text-right font-mono text-[0.8125rem] tabular-nums">{c.mcap ? compactUsd(c.mcap) : "—"}</span>
                    <span className="hidden sm:flex justify-end">
                      <Spark pts={c.spark} up={(c.change7d ?? c.change24h ?? 0) >= 0} />
                    </span>
                  </span>
                </>
              );
              return (
                <li key={c.key}>
                  <Link href={c.top ? topHref(c.top.id) : spotHref(c.spot!.token)} className={cls}>
                    {body}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {list && list.length > shown && (
        <button type="button" onClick={() => setShown((s) => s + STEP)} className="mt-3 w-full h-11 rounded-xl border border-line text-[0.875rem] font-semibold text-ink-2 hover:border-emerald/60">
          Show more
        </button>
      )}
      <p className="mt-3 text-[0.75rem] text-ink-3">Prices update every minute from each coin&apos;s DEX market; ranking and market caps from CoinGecko. Trades go through the best price available for each coin.</p>
    </div>
  );
}
