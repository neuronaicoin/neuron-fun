"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { CoinAvatar, CoinCard, ChainChip, Skeleton, usd } from "@/components/coins";
import { TradesFeed } from "@/components/market";
import { coinHref, fetchPortfolio, nativePerToken } from "@/lib/data";
import { shortAddr } from "@/lib/format";

type Portfolio = Awaited<ReturnType<typeof fetchPortfolio>>;

export default function MePage() {
  const { address } = useWallet();
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!address) return;
    try {
      setError("");
      setData(await fetchPortfolio(address));
    } catch {
      setError("Could not load your coins. Try again in a moment.");
    }
  }, [address]);

  useEffect(() => {
    setData(null);
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const ethUsd = data?.prices?.ETH ?? null;
  const holdings = useMemo(
    () =>
      (data?.holdings ?? [])
        .map((h) => ({ ...h, valueEth: h.amount * nativePerToken(h.curve) }))
        .sort((a, b) => b.valueEth - a.valueEth),
    [data]
  );
  const totalEth = holdings.reduce((s, h) => s + h.valueEth, 0);
  const names = useMemo(
    () => new Map(holdings.map((h) => [h.coin.id, { name: h.coin.name, symbol: h.coin.symbol, href: coinHref(h.coin) }])),
    [holdings]
  );

  if (!address) {
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-semibold text-[30px]">Your coins</h1>
        <p className="text-ink-2 mt-3">Connect your wallet to see the coins you created, what you hold on every chain and your trades.</p>
        <div className="mt-6">
          <ConnectButton full />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <h1 className="font-display font-semibold text-[30px] sm:text-[40px] tracking-tight">Your coins</h1>
      <p className="text-ink-3 font-mono text-[14px] mt-1">{shortAddr(address)}</p>

      {error && <p className="mt-4 text-danger text-[14px]">{error}</p>}

      <div className="mt-6 grid grid-cols-3 gap-3">
        {[
          ["Holdings value", data ? (ethUsd ? usd(totalEth * ethUsd, 2) : `${totalEth.toFixed(4)} ETH`) : "…"],
          ["Coins held", data ? String(holdings.length) : "…"],
          ["Coins created", data ? String(data.created.length) : "…"],
        ].map(([l, v]) => (
          <div key={l} className="bg-white border border-line rounded-2xl p-4">
            <div className="text-[12px] text-ink-3">{l}</div>
            <div className="font-mono text-[18px] sm:text-[22px] mt-1">{v}</div>
          </div>
        ))}
      </div>

      <section className="mt-10">
        <h2 className="font-display font-semibold text-[22px]">What you hold</h2>
        <div className="mt-4 bg-white border border-line rounded-2xl divide-y divide-mist">
          {!data && <Skeleton className="h-24 m-4" />}
          {data && holdings.length === 0 && <p className="p-6 text-ink-3 text-[15px]">Nothing yet. Find a coin you like on the home page.</p>}
          {holdings.map((h) => (
            <Link key={h.coin.id + h.curve.chain.key} href={coinHref(h.coin)} className="flex items-center gap-3 p-4 hover:bg-paper">
              <CoinAvatar logo={h.coin.logo} symbol={h.coin.symbol} size={40} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold truncate">{h.coin.name}</div>
                <div className="flex items-center gap-2 text-[12px] text-ink-3 mt-0.5">
                  <ChainChip chain={h.curve.chain} muted={h.curve.state === "closed"} />
                  {h.curve.state === "closed" && <span className="text-warn-ink">closed: sell to get your money back</span>}
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-[15px]">{ethUsd ? usd(h.valueEth * ethUsd, 2) : `${h.valueEth.toFixed(5)} ETH`}</div>
                <div className="font-mono text-[12px] text-ink-3">{h.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${h.coin.symbol}</div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="font-display font-semibold text-[22px]">Coins you created</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {!data && <Skeleton className="h-52" />}
          {data?.created.map((c) => (
            <CoinCard key={c.id} coin={c} />
          ))}
        </div>
        {data && data.created.length === 0 && (
          <div className="mt-2 text-center py-10 border border-dashed border-line rounded-2xl">
            <p className="text-ink-2">You haven&apos;t created a coin yet.</p>
            <Link href="/create/" className="inline-flex mt-4 h-11 px-6 rounded-xl bg-emerald text-white font-semibold items-center">Create a coin</Link>
          </div>
        )}
        {data && data.created.length > 0 && (
          <p className="mt-3 text-[13px] text-ink-3">Open a coin to collect your creator earnings on each chain.</p>
        )}
      </section>

      <section className="mt-10">
        <h2 className="font-display font-semibold text-[22px]">Your trades</h2>
        <div className="mt-4 bg-white border border-line rounded-2xl p-4 sm:p-5">
          <TradesFeed trader={address} names={names} ethUsd={ethUsd} limit={30} />
        </div>
      </section>
    </div>
  );
}
