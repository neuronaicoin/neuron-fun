"use client";

import { USD_MODE } from "@/lib/config";
import { CoinLinksRow } from "@/components/coinlinks";
import { ContractAddress } from "@/components/contract";
import { HolderMap } from "@/components/holdermap";
import { LockBadge } from "@/components/lock";
import { Confetti, useGraduationParty } from "@/components/confetti";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatEther, formatUnits, parseEther, parseUnits, type Hex } from "viem";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { CoinAvatar, ChainChip, ChainRace, ProgressBar, Skeleton, SkeletonRows, StarButton, timeAgo } from "@/components/coins";
import { PriceChart, TradesFeed } from "@/components/market";
import { LiveStats } from "@/components/livestats";
import { QuickTrade } from "@/components/trade";
import { MobileTradeBar } from "@/components/mobiletrade";
import { ShareButton, coinShareUrl, postOnX } from "@/components/share";
import { BoostButton } from "@/components/boost";
import { TrustCard } from "@/components/trust";
import { FeeBox } from "@/components/feebox";
import { CoinAlertButton } from "@/components/alerts";
import { ForumCard } from "@/components/forumcard";
import { CoinComments } from "@/components/comments";
import { alertLinesFor, useAlerts } from "@/lib/alerts";
import { useBuyerMarkers } from "@/lib/social";
import { ORDER_COLOR, ORDER_LABEL, useMyOrders } from "@/lib/myorders";
import { CoinOrders } from "@/components/myorders";
import { curveAbi, tokenAbi } from "@/lib/abis";
import { SLIPPAGE_BPS, explorerAddress, explorerTx } from "@/lib/config";
import { clientFor, fetchCoin, type Coin, type CurveInfo } from "@/lib/data";
import { fmtEth, fmtTokens, friendlyError, shortAddr } from "@/lib/format";

export default function CoinPageWrapper() {
  return (
    <Suspense fallback={<div className="max-w-5xl mx-auto px-4 py-10"><Skeleton className="h-64" /></div>}>
      <CoinPage />
    </Suspense>
  );
}

function CoinPage() {
  const params = useSearchParams();
  const legacy = params.get("c") && params.get("k") ? `${params.get("c")}:${params.get("k")}` : "";
  const id = (params.get("id") ?? legacy).toLowerCase();
  const valid = /^0x[0-9a-f]{40}:0x[0-9a-f]{64}$/.test(id);
  const [coin, setCoin] = useState<Coin | null>(null);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [chartChain, setChartChain] = useState("");
  const { alerts } = useAlerts();
  const alertLines = useMemo(() => alertLinesFor(alerts, id), [alerts, id]);
  const wallet = useWallet();
  const { orders: myOrders } = useMyOrders(wallet.address);
  const markerCurve = coin
    ? (coin.curves.find((c) => c.chain.key === chartChain) ?? coin.graduatedOn ?? [...coin.curves].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0])?.curve ?? null
    : null;
  const buyerMarkers = useBuyerMarkers(id, markerCurve, ethUsd);

  const load = useCallback(async () => {
    if (!valid) return;
    try {
      const { coin, prices } = await fetchCoin(id);
      setEthUsd(prices?.ETH ?? null);
      if (!coin) setNotFound(true);
      else setCoin(coin);
    } catch {
      /* keep what we have; the next refresh may work */
    }
  }, [id, valid]);

  useEffect(() => {
    load();
    const t = setInterval(load, 8_000);
    return () => clearInterval(t);
  }, [load]);
  const party = useGraduationParty(coin?.id ?? "", !!coin?.graduatedOn);
  const [partyDone, setPartyDone] = useState(false);
  const [allTrades, setAllTrades] = useState(false);
  // Computers show the safety check next to the buy box; phones show it folded under the race.
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  if (!valid || notFound) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-semibold text-[1.75rem]">Coin not found</h1>
        <p className="text-ink-2 mt-3">This link doesn&apos;t point to a sasa coin, or it was created moments ago. Try again in a few seconds.</p>
        <Link href="/explore/" className="inline-flex mt-6 h-12 px-6 rounded-xl bg-emerald text-on-accent font-semibold items-center">Explore coins</Link>
      </div>
    );
  }
  if (!coin) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-10" aria-busy="true" aria-label="Loading coin">
        <Skeleton className="h-4 w-20 rounded-md" />
        <div className="mt-4 sm:mt-5 flex items-start gap-3 sm:gap-4">
          <Skeleton className="w-14 h-14 shrink-0" />
          <div className="flex-1 min-w-0 grid gap-2">
            <Skeleton className="h-7 sm:h-9 w-1/2 rounded-lg" />
            <Skeleton className="h-4 w-2/5 rounded-md" />
            <Skeleton className="h-8 w-56 max-w-full rounded-xl" />
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}
        </div>
        <div className="mt-4 sm:mt-6 grid grid-cols-[minmax(0,1fr)] gap-4 sm:gap-6 lg:grid-cols-[1fr_380px] lg:items-start">
          <div className="grid gap-4 sm:gap-6 min-w-0">
            <Skeleton className="h-72 sm:h-96" />
            <div className="border border-line rounded-xl p-4 sm:p-5">
              <SkeletonRows rows={4} avatar="none" />
            </div>
          </div>
          <Skeleton className="hidden lg:block h-[420px]" />
        </div>
      </div>
    );
  }

  const winner = coin.graduatedOn;
  const chartCurve =
    coin.curves.find((c) => c.chain.key === chartChain) ??
    winner ??
    [...coin.curves].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0];

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 sm:py-8">
      {party && !partyDone && <Confetti onDone={() => setPartyDone(true)} />}
      <Link href="/explore/" className="inline-flex items-center gap-1 text-[0.875rem] font-medium text-ink-3 hover:text-ink">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        Explore
      </Link>

      <div className="mt-3 sm:mt-4 flex items-start gap-3 sm:gap-4">
        <CoinAvatar logo={coin.logo} symbol={coin.symbol} size={48} />
        <div className="min-w-0 flex-1">
          <h1 className="font-display font-bold text-[1.375rem] sm:text-[1.875rem] leading-tight tracking-tight break-words">{coin.name}</h1>
          <LockBadge coinId={coin.id} className="mt-2" />
          <p className="text-ink-3 text-[0.875rem] mt-0.5">
            ${coin.symbol} · created {timeAgo(coin.createdAt)} by <span className="font-mono">{shortAddr(coin.creator)}</span>
          </p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {coin.curves.map((c) => (
              <ChainChip key={c.chain.key} chain={c.chain} muted={c.state === "closed" || c.state === "moved"} />
            ))}
          </div>
          <CoinLinksRow coinId={coin.id} creator={coin.creator} className="mt-2" />
          <ContractAddress
            className="mt-2"
            note={coin.omni && !winner && coin.curves.length > 1 ? `same on ${coin.curves.map((c) => c.chain.short).join(" · ")}` : undefined}
            entries={(winner ? [winner] : caCurves(coin.curves)).map((c) => ({
              key: c.chain.key,
              label: c.chain.short,
              color: c.chain.color,
              address: c.token,
              explorer: explorerAddress(c.chain, c.token),
            }))}
          />
        </div>
        <div className="flex gap-1.5 shrink-0">
          <ShareButton coin={coin} />
          <CoinAlertButton coin={coin} ethUsd={ethUsd} />
          <StarButton coinId={coin.id} />
        </div>
      </div>
      {coin.description && <p className="text-[0.9375rem] text-ink-2 mt-3 leading-relaxed max-w-2xl">{coin.description}</p>}
      <div className="mt-3 empty:hidden">
        <BoostButton coin={coin} />
      </div>

      {winner && (
        <div className="mt-5 rounded-xl border border-line text-ink p-4 sm:p-5">
          <h2 className="font-display font-semibold text-[1.125rem] sm:text-[1.25rem]">Graduated on {winner.chain.name}</h2>
          <p className="text-ink-2 mt-1.5 text-[0.9375rem] leading-relaxed">
            ${coin.symbol} now trades in a locked pool on {winner.chain.short}. That is where the coin lives from here on.
            {coin.omni
              ? "Coins held on the other chains moved here automatically, to the same address."
              : "On the other chains buying has stopped; holders there can take their money back at any time."}
          </p>
          <button
            type="button"
            onClick={() =>
              postOnX(`$${coin.symbol} just graduated on ${winner.chain.short} 🎓 Liquidity locked forever on @sasapadfun`, coinShareUrl(coin.id))
            }
            className="mt-3 h-10 px-4 rounded-xl border border-line font-semibold inline-flex items-center gap-2"
          >
            Share on X
          </button>
        </div>
      )}

      <div className="mt-4 sm:mt-5">
        <LiveStats coin={coin} ethUsd={ethUsd} />
      </div>

      <div className="mt-4 sm:mt-6 grid grid-cols-[minmax(0,1fr)] gap-4 sm:gap-6 lg:grid-cols-[1fr_380px] lg:items-start">
        <div className="order-2 lg:order-1 grid gap-6 min-w-0">
          {chartCurve && (
            <div className="border border-line rounded-xl p-3 sm:p-4">
              {!USD_MODE && coin.curves.length > 1 && (
                <div className="flex flex-wrap gap-2 mb-4">
                  {coin.curves.map((c) => (
                    <button
                      key={c.chain.key}
                      type="button"
                      onClick={() => setChartChain(c.chain.key)}
                      className={"h-9 px-3 rounded-xl border-2 text-[0.8125rem] font-semibold " + (c.chain.key === chartCurve.chain.key ? "border-emerald" : "border-line")}
                    >
                      {c.chain.short}
                    </button>
                  ))}
                </div>
              )}
              <PriceChart curve={chartCurve} coin={USD_MODE ? coin : undefined} ethUsd={chartCurve.chain.priceSymbol === "ETH" || chartCurve.chain.priceSymbol === "USDC" ? ethUsd : null} alertLines={alertLines} markers={buyerMarkers} orderMarks={(myOrders ?? [])
                // The dollar chart is one line for the whole coin (all chains), so every order on
                // this coin belongs on it; per-chain charts show that chain's orders only.
                .filter((o) =>
                  USD_MODE
                    ? coin.curves.some((c) => c.chain.chain.id === o.chain.chain.id && c.curve.toLowerCase() === o.curve)
                    : o.chain.chain.id === chartCurve.chain.chain.id && o.curve === chartCurve.curve.toLowerCase()
                )
                .map((o) => ({ perToken: o.trigger, color: ORDER_COLOR[o.kind], title: ORDER_LABEL[o.kind] }))} />
            </div>
          )}

          <div className="border border-line rounded-xl p-4 sm:p-5">
            <ProgressBar coin={coin} big />
            <div className="mt-6">
              <h2 className="font-display font-semibold text-[1.125rem] mb-3">The race</h2>
              <ChainRace coin={coin} />
            </div>
          </div>

          {/* Phones: the user's open orders on this coin, right under the chart. */}
          <div className="lg:hidden empty:hidden">
            <CoinOrders coin={coin} />
          </div>
          {/* Phones: the safety check sits here, folded, so the chart comes first. */}
          {!wide && <TrustCard coin={coin} collapsible />}

          <div className="border border-line rounded-xl p-4 sm:p-5">
            <h2 className="font-display font-semibold text-[1.125rem] mb-2">Trades</h2>
            <TradesFeed coinId={coin.id} ethUsd={ethUsd} limit={allTrades ? 25 : 7} />
            <button
              type="button"
              onClick={() => setAllTrades((v) => !v)}
              className="mt-2 w-full h-10 rounded-xl border border-line text-[0.8125rem] font-semibold text-ink-2 hover:bg-night"
            >
              {allTrades ? "Show fewer" : "Show more trades"}
            </button>
          </div>

          <HolderMap coin={coin} />

          <CoinComments coin={coin} />

          <ForumCard coin={coin} />

          <FeeBox coin={coin} onChange={load} />

          <div className="border border-line rounded-xl p-4 sm:p-5 text-[0.875rem] text-ink-2 grid gap-2">
            <h2 className="font-display font-semibold text-[1.125rem] text-ink mb-1">Details</h2>
            {coin.curves.map((c) => (
              <div key={c.chain.key} className="flex justify-between gap-4">
                <span>{c.chain.short} coin</span>
                <a className="font-mono text-emerald" href={explorerAddress(c.chain, c.token)} target="_blank" rel="noreferrer">{shortAddr(c.token)}</a>
              </div>
            ))}
          </div>
        </div>
        {/* On phones this holds only the bottom buy bar's spacer, so it goes last. */}
        <div className="order-3 lg:order-2 lg:sticky lg:top-20">
          <div className="hidden lg:block">
            <QuickTrade coin={coin} ethUsd={ethUsd} onTraded={load} />
            <div className="mt-3 empty:hidden">
              <CoinOrders coin={coin} />
            </div>
          </div>
          <MobileTradeBar coin={coin} ethUsd={ethUsd} onTraded={load} />
          {wide && <div className="mt-3"><TrustCard coin={coin} /></div>}
        </div>
      </div>
    </div>
  );
}

/** Curves whose address people want first: open ones, richest first (all of them if none is open). */
function caCurves(curves: CurveInfo[]): CurveInfo[] {
  const open = curves.filter((c) => c.state !== "closed");
  return [...(open.length ? open : curves)].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
}
