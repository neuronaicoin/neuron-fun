"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatEther, formatUnits, parseEther, parseUnits, type Hex } from "viem";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { CoinAvatar, ChainChip, ChainRace, ProgressBar, Skeleton, timeAgo } from "@/components/coins";
import { CoinStats, PriceChart, TopHolders, TradesFeed } from "@/components/market";
import { QuickTrade } from "@/components/trade";
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
        <h1 className="font-display font-semibold text-[28px]">Coin not found</h1>
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
      <Link href="/" className="text-[14px] font-semibold text-emerald">← All coins</Link>

      <div className="mt-5 flex items-start gap-4">
        <CoinAvatar logo={coin.logo} symbol={coin.symbol} size={68} />
        <div className="min-w-0">
          <h1 className="font-display font-semibold text-[26px] sm:text-[36px] leading-tight tracking-tight break-words">{coin.name}</h1>
          <p className="text-ink-2 text-[15px] mt-1">
            ${coin.symbol} · created {timeAgo(coin.createdAt)} by <span className="font-mono">{shortAddr(coin.creator)}</span>
          </p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {coin.curves.map((c) => (
              <ChainChip key={c.chain.key} chain={c.chain} muted={c.state === "closed"} />
            ))}
          </div>
        </div>
      </div>
      {coin.description && <p className="text-[16px] text-ink-2 mt-4 leading-relaxed max-w-2xl">{coin.description}</p>}

      {winner && (
        <div className="mt-6 rounded-2xl bg-emerald-soft border border-emerald/40 text-ink p-5 sm:p-6">
          <p className="font-mono text-[12px] tracking-[0.14em] text-mint">GRADUATED</p>
          <h2 className="font-display font-semibold text-[22px] sm:text-[26px] mt-2">Winning chain: {winner.chain.name}</h2>
          <p className="text-[#a9bab3] mt-2 text-[15px] leading-relaxed">
            ${coin.symbol} now trades in a locked pool on {winner.chain.short}. That is where the coin lives from here on.
            On the other chains buying has stopped; holders there can take their money back at any time.
          </p>
        </div>
      )}

      <div className="mt-6">
        <CoinStats coin={coin} ethUsd={ethUsd} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px] lg:items-start">
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
                      className={"h-9 px-3 rounded-xl border-2 text-[13px] font-semibold " + (c.chain.key === chartCurve.chain.key ? "border-emerald" : "border-line")}
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
              <h2 className="font-display font-semibold text-[18px] mb-3">The race</h2>
              <ChainRace coin={coin} />
            </div>
          </div>

          <div className="bg-surface border border-line rounded-2xl p-5 sm:p-6">
            <h2 className="font-display font-semibold text-[18px] mb-2">Trades</h2>
            <TradesFeed coinId={coin.id} ethUsd={ethUsd} />
          </div>

          {chartCurve && (
            <div className="bg-surface border border-line rounded-2xl p-5 sm:p-6">
              <h2 className="font-display font-semibold text-[18px] mb-3">Top holders on {chartCurve.chain.short}</h2>
              <TopHolders curve={chartCurve} />
            </div>
          )}

          <CreatorBox coin={coin} onChange={load} />

          <div className="bg-surface border border-line rounded-2xl p-5 sm:p-6 text-[14px] text-ink-2 grid gap-2">
            <h2 className="font-display font-semibold text-[18px] text-ink mb-1">Details</h2>
            {coin.curves.map((c) => (
              <div key={c.chain.key} className="flex justify-between gap-4">
                <span>{c.chain.short} coin</span>
                <a className="font-mono text-emerald" href={explorerAddress(c.chain, c.token)} target="_blank" rel="noreferrer">{shortAddr(c.token)}</a>
              </div>
            ))}
          </div>
        </div>
        <div className="order-1 lg:order-2 lg:sticky lg:top-20">
          <QuickTrade coin={coin} ethUsd={ethUsd} onTraded={load} />
        </div>
      </div>
    </div>
  );
}

function CreatorBox({ coin, onChange }: { coin: Coin; onChange: () => void }) {
  const { address, switchTo, walletClient } = useWallet();
  const [fees, setFees] = useState<Record<string, bigint>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const isCreator = !!address && address.toLowerCase() === coin.creator.toLowerCase();

  const load = useCallback(async () => {
    if (!isCreator) return;
    const entries = await Promise.all(
      coin.curves.map(async (c: CurveInfo) => {
        const f = (await clientFor(c.chain).readContract({ address: c.curve, abi: curveAbi, functionName: "creatorFees" })) as bigint;
        return [c.chain.key, f] as const;
      })
    );
    setFees(Object.fromEntries(entries));
  }, [coin.curves, isCreator]);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  if (!isCreator) return null;

  async function claim(c: CurveInfo) {
    if (!address) return;
    setError("");
    try {
      setBusy(c.chain.key);
      await switchTo(c.chain.chain);
      const hash = await walletClient(c.chain.chain).writeContract({ chain: c.chain.chain, account: address, address: c.curve, abi: curveAbi, functionName: "claimCreatorFees" });
      await clientFor(c.chain).waitForTransactionReceipt({ hash });
      await load();
      onChange();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="bg-surface border border-emerald rounded-2xl p-5 sm:p-6">
      <h2 className="font-display font-semibold text-[18px]">Your earnings as the creator</h2>
      <p className="text-[14px] text-ink-2 mt-1">0.3% of every trade on every chain.</p>
      <ul className="mt-4 grid gap-2">
        {coin.curves.map((c) => (
          <li key={c.chain.key} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <ChainChip chain={c.chain} />
              <span className="font-mono text-[14px]">{fmtEth(fees[c.chain.key] ?? null, 6)}</span>
            </span>
            <button
              type="button"
              disabled={!fees[c.chain.key] || !!busy}
              onClick={() => claim(c)}
              className="h-9 px-4 rounded-lg bg-emerald text-on-accent text-[14px] font-semibold disabled:opacity-40"
            >
              {busy === c.chain.key ? "…" : "Collect"}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="mt-3 text-[14px] text-danger">{error}</p>}
    </div>
  );
}
