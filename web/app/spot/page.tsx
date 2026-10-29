"use client";

/** A spot-only coin's own page (HYPE, KNTQ, HFUN…): big live chart, trade box, share. /spot/?c=HYPE */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PerpsChart } from "@/components/perpschart";
import { SpotTrade, spotDecimals, useSpotDesk } from "@/components/hlspot";
import { postOnX } from "@/components/share";
import { compactUsd } from "@/lib/format";
import { fmtPrice } from "@/lib/race";
import { fetchHlSpot, spotPageUrl, type HlSpot } from "@/lib/hlspot";

const pct = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
const tone = (v: number | null) => (v === null ? "text-ink-3" : v >= 0 ? "text-up" : "text-danger");

export default function Page() {
  return (
    <Suspense fallback={<div className="max-w-6xl mx-auto px-4 py-10"><div className="shimmer h-40 rounded-3xl" /></div>}>
      <SpotPage />
    </Suspense>
  );
}

function SpotPage() {
  const want = (useSearchParams().get("c") ?? "").toUpperCase();
  const [m, setM] = useState<HlSpot | null | undefined>(undefined);
  const desk = useSpotDesk();

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchHlSpot()
        .then((l) => alive && setM(l.find((x) => x.token.toUpperCase() === want) ?? null))
        .catch(() => alive && setM((x) => x ?? null));
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [want]);

  if (m === undefined) return <div className="max-w-6xl mx-auto px-4 py-10"><div className="shimmer h-40 rounded-3xl" /></div>;
  if (m === null)
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-bold text-[1.5rem]">Coin not found</h1>
        <Link href="/market/" className="inline-flex mt-5 h-11 px-6 rounded-xl bg-emerald text-on-accent font-semibold items-center">Back to Market</Link>
      </div>
    );

  const have = desk.bal.get(m.token) ?? 0;
  const share = () => {
    const move = m.change24h !== null ? ` ${pct(m.change24h)} today` : "";
    const tag = /^[A-Za-z][A-Za-z0-9_]{0,24}$/.test(m.token) ? `#${m.token} ` : "";
    postOnX(`$${m.token}${move} 👀\n\ntrading it with plain USDC on sasa. one tap, no bridging\n\n${tag}#crypto`, spotPageUrl(m.token));
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 sm:py-8 pb-28 md:pb-12">
      <Link href="/market/" className="text-[0.875rem] text-ink-3 hover:text-ink">← Market</Link>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-14 h-14 rounded-2xl bg-paper border border-line grid place-items-center font-display font-bold text-[1.25rem] text-ink-2 shrink-0" aria-hidden="true">
            {m.token.slice(0, 1)}
          </span>
          <div className="min-w-0">
            <h1 className="font-display font-bold text-[1.375rem] sm:text-[1.75rem] leading-tight truncate">{m.name}</h1>
            <div className="flex items-center gap-2 mt-1">
              <span className="font-mono text-[0.8125rem] text-ink-3">${m.token}</span>
              <button type="button" onClick={share} className="h-7 px-2.5 rounded-lg border border-line text-[0.75rem] font-semibold hover:border-emerald/60 flex items-center gap-1">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Z" /></svg>
                Share
              </button>
            </div>
          </div>
        </div>
        <div className="flex items-end gap-6">
          <div>
            <div className="font-display font-bold text-[1.75rem] sm:text-[2.25rem] leading-none tabular-nums">{fmtPrice(m.price)}</div>
            <div className={"mt-1 text-[0.9375rem] font-semibold " + tone(m.change24h)}>{pct(m.change24h)} today</div>
          </div>
          <dl className="hidden sm:grid grid-cols-2 gap-x-5 gap-y-0.5 text-[0.8125rem]">
            <dt className="text-ink-3">Volume 24h</dt>
            <dd className="font-mono tabular-nums text-right">{compactUsd(m.vol24h)}</dd>
            <dt className="text-ink-3">Market cap</dt>
            <dd className="font-mono tabular-nums text-right">{m.mcap ? compactUsd(m.mcap) : "—"}</dd>
          </dl>
        </div>
      </div>

      <div className="mt-5 grid lg:grid-cols-[minmax(0,1fr)_22rem] gap-5 items-start">
        <div className="rounded-3xl border border-line bg-surface p-3 sm:p-4 min-w-0">
          <PerpsChart coin={m.coin} decimals={spotDecimals(m)} height={480} />
        </div>
        <div className="rounded-3xl border border-line bg-surface p-4 sm:p-5 lg:sticky lg:top-20">
          <SpotTrade m={m} have={have} canTrade={desk.canTrade} blocked={desk.blocked} trade={desk.trade} />
          {have * m.price >= 0.5 && (
            <p className="mt-3 text-[0.8125rem] text-ink-2 text-center">
              You hold {have.toLocaleString("en-US", { maximumFractionDigits: 4 })} {m.token} (about {compactUsd(have * m.price)})
            </p>
          )}
        </div>
      </div>
      <p className="mt-3 text-[0.75rem] text-ink-3">Live price and chart. Paid with USDC from your balance.</p>
    </div>
  );
}
