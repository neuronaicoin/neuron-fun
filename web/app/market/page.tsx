"use client";

/** Market: the 300 biggest coins, each tradeable with USDC. */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Skeleton } from "@/components/coins";
import { compactUsd } from "@/lib/format";
import { fmtPrice } from "@/lib/race";
import { extNetwork } from "@/lib/extcoins";
import { fetchTopCoins, topHref, type TopCoin } from "@/lib/topcoins";
import { MarketSwitch } from "@/components/marketswitch";
import { HlSpotList } from "@/components/hlspot";

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
  // Top 300 (CoinGecko, bought on Base / BNB / Ethereum) or Hyperliquid's own spot market
  const [src, setSrc] = useState<"top" | "hl">("top");
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("src") === "hl") setSrc("hl");
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchTopCoins()
        .then((c) => alive && (setCoins(c), setError(false)))
        .catch(() => alive && setError(true));
    void load();
    // prices change every minute (each coin's own DEX pool): ask every 30 seconds
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const list = useMemo(() => {
    if (!coins) return null;
    const s = q.trim().toLowerCase();
    const hit = s ? coins.filter((c) => c.name.toLowerCase().includes(s) || c.symbol.toLowerCase().includes(s)) : coins.slice();
    const by = (f: (c: TopCoin) => number | null, desc: boolean) =>
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
    return by((c) => c.rank, false);
  }, [coins, sort, q]);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 sm:py-8 pb-28 md:pb-12">
      <MarketSwitch at="spot" />
      <h1 className="mt-3 font-display font-bold text-[1.625rem] sm:text-[2.25rem] tracking-tight">Market</h1>
      <p className="text-ink-2 text-[0.875rem] sm:text-[1rem]">
        {src === "top" ? "The 300 biggest coins. Buy and sell any of them with USDC in one tap." : "Every token on Hyperliquid's spot market: HYPE, KNTQ and more, with your dollars."}
      </p>
      <div className="mt-3 inline-flex rounded-xl border border-line bg-surface p-1" role="tablist" aria-label="Which market">
        {(
          [
            ["top", "Top 300"],
            ["hl", "Hyperliquid"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={src === id}
            onClick={() => {
              setSrc(id);
              window.history.replaceState(null, "", id === "hl" ? "?src=hl" : window.location.pathname);
            }}
            className={"h-9 px-4 rounded-lg text-[0.875rem] font-bold " + (src === id ? "bg-ink text-mist" : "text-ink-2 hover:text-ink")}
          >
            {label}
          </button>
        ))}
      </div>
      {src === "hl" ? (
        <>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search HYPE, KNTQ…"
            aria-label="Search Hyperliquid tokens"
            className="mt-4 h-10 w-full sm:w-64 rounded-xl border border-line bg-surface px-3.5 text-[0.9375rem] outline-none focus:border-ink-3"
          />
          <HlSpotList q={q} />
        </>
      ) : (
      <>

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
              const net = extNetwork(c.network);
              return (
                <li key={c.id}>
                  <Link
                    href={topHref(c.id)}
                    className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] sm:grid-cols-[2.5rem_minmax(0,1fr)_7rem_5rem_5rem_7rem_6.5rem] gap-3 items-center px-4 py-3 hover:bg-paper"
                  >
                    <span className="text-[0.8125rem] text-ink-3 tabular-nums">{c.rank ?? "—"}</span>
                    <span className="flex items-center gap-3 min-w-0">
                      {c.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.image} alt="" width={32} height={32} className="w-8 h-8 rounded-full bg-paper shrink-0" loading="lazy" />
                      ) : (
                        <span className="w-8 h-8 rounded-full bg-paper shrink-0" aria-hidden="true" />
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
                      <span className="block sm:text-right font-mono text-[0.875rem] tabular-nums">{fmtPrice(c.priceUsd)}</span>
                      <span className={"block sm:text-right font-mono text-[0.8125rem] tabular-nums " + tone(c.change24h)}>{pct(c.change24h)}</span>
                      <span className={"hidden sm:block text-right font-mono text-[0.8125rem] tabular-nums " + tone(c.change7d)}>{pct(c.change7d)}</span>
                      <span className="hidden sm:block text-right font-mono text-[0.8125rem] tabular-nums">{compactUsd(c.mcapUsd)}</span>
                      <span className="hidden sm:flex justify-end">
                        <Spark pts={c.spark} up={(c.change7d ?? 0) >= 0} />
                      </span>
                    </span>
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
      <p className="mt-3 text-[0.75rem] text-ink-3">Prices update every minute from each coin&apos;s DEX market; ranking and market caps from CoinGecko. Trades go through the best DEX price on Base, BNB Chain or Ethereum.</p>
      </>
      )}
    </div>
  );
}
