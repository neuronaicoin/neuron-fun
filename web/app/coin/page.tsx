"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatEther, formatUnits, parseEther, parseUnits, type Hex } from "viem";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { CoinAvatar, ChainChip, ChainRace, ProgressBar, Skeleton, StarButton, timeAgo } from "@/components/coins";
import { CoinStats, PriceChart, TopHolders, TradesFeed } from "@/components/market";
import { QuickTrade } from "@/components/trade";
import { MobileTradeBar } from "@/components/mobiletrade";
import { ShareButton } from "@/components/share";
import { TrustCard } from "@/components/trust";
import { FeeBox } from "@/components/feebox";
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

  if (!valid || notFound) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-semibold text-[1.75rem]">Coin not found</h1>
        <p className="text-ink-2 mt-3">This link doesn&apos;t point to a sasa coin, or it was created moments ago. Try again in a few seconds.</p>
        <Link href="/" className="inline-flex mt-6 h-12 px-6 rounded-xl bg-emerald text-on-accent font-semibold items-center">Explore coins</Link>
      </div>
    );
  }
  if (!coin) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 grid gap-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-80" />
      </div>
    );
  }

  const winner = coin.graduatedOn;
  const chartCurve =
    coin.curves.find((c) => c.chain.key === chartChain) ??
    winner ??
    [...coin.curves].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0];

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
      <Link href="/" className="text-[0.875rem] font-semibold text-emerald">← All coins</Link>

      <div className="mt-4 sm:mt-5 flex items-start gap-3 sm:gap-4">
        <CoinAvatar logo={coin.logo} symbol={coin.symbol} size={56} />
        <div className="min-w-0 flex-1">
          <h1 className="font-display font-semibold text-[1.625rem] sm:text-[2.25rem] leading-tight tracking-tight break-words">{coin.name}</h1>
          <p className="text-ink-2 text-[0.9375rem] mt-1">
            ${coin.symbol} · created {timeAgo(coin.createdAt)} by <span className="font-mono">{shortAddr(coin.creator)}</span>
          </p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {coin.curves.map((c) => (
              <ChainChip key={c.chain.key} chain={c.chain} muted={c.state === "closed"} />
            ))}
          </div>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <ShareButton coin={coin} />
          <StarButton coinId={coin.id} />
        </div>
      </div>
      {coin.description && <p className="text-[1rem] text-ink-2 mt-4 leading-relaxed max-w-2xl">{coin.description}</p>}

      {winner && (
        <div className="mt-6 rounded-2xl bg-emerald-soft border border-emerald/40 text-ink p-5 sm:p-6">
          <p className="font-mono text-[0.75rem] tracking-[0.14em] text-mint">GRADUATED</p>
          <h2 className="font-display font-semibold text-[1.375rem] sm:text-[1.625rem] mt-2">Winning chain: {winner.chain.name}</h2>
          <p className="text-[#a9bab3] mt-2 text-[0.9375rem] leading-relaxed">
            ${coin.symbol} now trades in a locked pool on {winner.chain.short}. That is where the coin lives from here on.
            On the other chains buying has stopped; holders there can take their money back at any time.
          </p>
        </div>
      )}

      <div className="mt-6">
        <CoinStats coin={coin} ethUsd={ethUsd} />
      </div>

      <div className="mt-4 sm:mt-6 grid grid-cols-[minmax(0,1fr)] gap-4 sm:gap-6 lg:grid-cols-[1fr_380px] lg:items-start">
        <div className="order-2 lg:order-1 grid gap-6 min-w-0">
          {chartCurve && (
            <div className="bg-surface border border-line rounded-2xl p-4 sm:p-5">
              {coin.curves.length > 1 && (
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
              <PriceChart curve={chartCurve} ethUsd={chartCurve.chain.priceSymbol === "ETH" ? ethUsd : null} />
            </div>
          )}

          <div className="bg-surface border border-line rounded-2xl p-5 sm:p-6">
            <ProgressBar coin={coin} big />
            <div className="mt-6">
              <h2 className="font-display font-semibold text-[1.125rem] mb-3">The race</h2>
              <ChainRace coin={coin} />
            </div>
          </div>

          <div className="bg-surface border border-line rounded-2xl p-5 sm:p-6">
            <h2 className="font-display font-semibold text-[1.125rem] mb-2">Trades</h2>
            <TradesFeed coinId={coin.id} ethUsd={ethUsd} />
          </div>

          {chartCurve && (
            <div className="bg-surface border border-line rounded-2xl p-5 sm:p-6">
              <h2 className="font-display font-semibold text-[1.125rem] mb-3">Top holders on {chartCurve.chain.short}</h2>
              <TopHolders curve={chartCurve} />
            </div>
          )}

          <FeeBox coin={coin} onChange={load} />

          <div className="bg-surface border border-line rounded-2xl p-5 sm:p-6 text-[0.875rem] text-ink-2 grid gap-2">
            <h2 className="font-display font-semibold text-[1.125rem] text-ink mb-1">Details</h2>
            {coin.curves.map((c) => (
              <div key={c.chain.key} className="flex justify-between gap-4">
                <span>{c.chain.short} coin</span>
                <a className="font-mono text-emerald" href={explorerAddress(c.chain, c.token)} target="_blank" rel="noreferrer">{shortAddr(c.token)}</a>
              </div>
            ))}
          </div>
        </div>
        <div className="order-1 lg:order-2 lg:sticky lg:top-20">
          <div className="hidden lg:block">
            <QuickTrade coin={coin} ethUsd={ethUsd} onTraded={load} />
          </div>
          <MobileTradeBar coin={coin} ethUsd={ethUsd} onTraded={load} />
          <div className="mt-3"><TrustCard coin={coin} /></div>
        </div>
      </div>
    </div>
  );
}

