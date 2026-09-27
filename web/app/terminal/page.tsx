"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatEther } from "viem";
import { useWallet } from "@/components/wallet";
import { ChainChip, ChainRace, CoinAvatar, ProgressBar, Skeleton, timeAgo, useCoins, usd } from "@/components/coins";
import { coinMarketCapUsd, compactUsd, RaceBar } from "@/components/discover";
import { PriceChart, TopHolders, TradesFeed } from "@/components/market";
import { QuickTrade } from "@/components/trade";
import { TrustCard } from "@/components/trust";
import { tokenAbi } from "@/lib/abis";
import { explorerAddress } from "@/lib/config";
import { clientFor, coinHref, fetchCoin, fetchTrades, nativePerToken, type Coin, type SortKey } from "@/lib/data";
import { fetchPrices } from "@/lib/price";
import { shortAddr } from "@/lib/format";

export default function TerminalPage() {
  return (
    <Suspense fallback={<div className="p-6"><Skeleton className="h-96" /></div>}>
      <Terminal />
    </Suspense>
  );
}

type MobileTab = "markets" | "chart" | "trade";

function Terminal() {
  const params = useSearchParams();
  const [selected, setSelected] = useState<string>((params.get("id") ?? "").toLowerCase());
  const [sort, setSort] = useState<SortKey>("hot");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<MobileTab>(params.get("id") ? "chart" : "markets");
  const { coins } = useCoins(sort, search);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [coin, setCoin] = useState<Coin | null>(null);

  useEffect(() => {
    fetchPrices().then((p) => setEthUsd(p?.ETH ?? null));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Default to the first coin in the list.
  useEffect(() => {
    if (!selected && coins && coins.length) setSelected(coins[0].id);
  }, [coins, selected]);

  const loadCoin = useCallback(async () => {
    if (!selected) return;
    try {
      const { coin, prices } = await fetchCoin(selected);
      if (prices?.ETH) setEthUsd(prices.ETH);
      setCoin(coin);
    } catch {
      /* keep the last good data */
    }
  }, [selected]);

  useEffect(() => {
    setCoin(null);
    loadCoin();
    const t = setInterval(loadCoin, 6_000);
    return () => clearInterval(t);
  }, [loadCoin]);

  const choose = (id: string) => {
    setSelected(id);
    setTab("chart");
    try {
      window.history.replaceState(null, "", `/terminal/?id=${encodeURIComponent(id)}`);
    } catch {}
  };

  return (
    <div className="max-w-[1500px] mx-auto px-3 sm:px-4 py-3 sm:py-4">
      {/* Phone: one panel at a time */}
      <div className="lg:hidden grid grid-cols-3 gap-1 p-1 mb-3 rounded-2xl bg-surface border border-line" role="tablist" aria-label="Terminal view">
        {(["markets", "chart", "trade"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={"h-10 rounded-xl text-[14px] font-semibold capitalize " + (tab === t ? "bg-ink text-on-accent" : "text-ink-2")}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-[300px_minmax(0,1fr)_360px] lg:items-start">
        <aside className={(tab === "markets" ? "block" : "hidden") + " lg:block lg:sticky lg:top-[76px]"}>
          <Markets
            coins={coins}
            ethUsd={ethUsd}
            selected={selected}
            onChoose={choose}
            sort={sort}
            setSort={setSort}
            query={query}
            setQuery={setQuery}
          />
        </aside>

        <section className={(tab === "chart" ? "block" : "hidden") + " lg:block min-w-0"}>
          {coin ? <Center coin={coin} ethUsd={ethUsd} /> : <Skeleton className="h-[640px]" />}
        </section>

        <aside className={(tab === "trade" ? "block" : "hidden") + " lg:block lg:sticky lg:top-[76px] grid gap-3"}>
          {coin ? (
            <>
              <QuickTrade coin={coin} ethUsd={ethUsd} onTraded={loadCoin} />
              <div className="mt-3"><TrustCard coin={coin} /></div>
              <div className="mt-3 rounded-3xl border border-line bg-surface p-4 sm:p-5">
                <ProgressBar coin={coin} />
                <div className="mt-4">
                  <ChainRace coin={coin} />
                </div>
              </div>
            </>
          ) : (
            <Skeleton className="h-[480px]" />
          )}
        </aside>
      </div>
    </div>
  );
}

function Markets(props: {
  coins: Coin[] | null;
  ethUsd: number | null;
  selected: string;
  onChoose: (id: string) => void;
  sort: SortKey;
  setSort: (s: SortKey) => void;
  query: string;
  setQuery: (q: string) => void;
}) {
  const { coins, ethUsd, selected, onChoose, sort, setSort, query, setQuery } = props;
  return (
    <div className="rounded-3xl border border-line bg-surface overflow-hidden">
      <div className="p-3 border-b border-line">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name or ticker"
          aria-label="Search coins"
          className="w-full h-10 px-3 rounded-xl border border-line bg-paper text-[14px] focus:border-emerald"
        />
        <div className="grid grid-cols-3 gap-1 mt-2" role="tablist" aria-label="Sort">
          {([["hot", "Closest"], ["active", "Active"], ["new", "New"]] as const).map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={sort === k}
              onClick={() => setSort(k)}
              className={"h-8 rounded-lg text-[12px] font-semibold " + (sort === k ? "bg-ink text-on-accent" : "text-ink-2")}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <ul className="max-h-[70dvh] lg:max-h-[calc(100dvh-220px)] overflow-y-auto divide-y divide-line">
        {!coins && [0, 1, 2, 3, 4].map((i) => <li key={i} className="p-3"><Skeleton className="h-10" /></li>)}
        {coins?.length === 0 && <li className="p-6 text-center text-[14px] text-ink-3">No coins found.</li>}
        {coins?.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onChoose(c.id)}
              className={"w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-paper " + (c.id === selected ? "bg-paper" : "")}
            >
              <CoinAvatar logo={c.logo} symbol={c.symbol} size={36} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[14px] truncate">{c.name}</span>
                  <span className="font-mono text-[13px] shrink-0">{compactUsd(coinMarketCapUsd(c, ethUsd))}</span>
                </span>
                <span className="flex items-center justify-between gap-2 mt-1">
                  <span className="text-[12px] text-ink-3">${c.symbol} · {c.curves.length} chain{c.curves.length > 1 ? "s" : ""}</span>
                  <span className="text-[12px] font-mono text-ink-2">{c.graduatedOn ? "Graduated" : `${Math.round(c.progress * 100)}%`}</span>
                </span>
                <span className="block mt-1.5"><RaceBar coin={c} /></span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type CenterTab = "trades" | "holders" | "position" | "about";

function Center({ coin, ethUsd }: { coin: Coin; ethUsd: number | null }) {
  const [chartChain, setChartChain] = useState("");
  const [tab, setTab] = useState<CenterTab>("trades");
  const chartCurve =
    coin.curves.find((c) => c.chain.key === chartChain) ??
    coin.graduatedOn ??
    [...coin.curves].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0];
  const mc = coinMarketCapUsd(coin, ethUsd);

  return (
    <div className="grid gap-3">
      <div className="rounded-3xl border border-line bg-surface p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <CoinAvatar logo={coin.logo} symbol={coin.symbol} size={52} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-display font-bold text-[22px] sm:text-[26px] leading-tight truncate">{coin.name}</h1>
              <Link href={coinHref(coin)} className="text-[12px] text-ink-3 underline">Coin page</Link>
            </div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <span className="text-[13px] text-ink-3 mr-1">${coin.symbol}</span>
              {coin.curves.map((c) => (
                <ChainChip key={c.chain.key} chain={c.chain} muted={c.state === "closed"} />
              ))}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          {[
            ["Market cap", compactUsd(mc)],
            ["Graduation", coin.graduatedOn ? "Done" : `${Math.round(coin.progress * 100)}%`],
            ["Holders", String(coin.holders)],
            ["Volume 24h", ethUsd ? usd(coin.volumeNative24h * ethUsd, 0) : `${coin.volumeNative24h.toFixed(3)} ETH`],
          ].map(([l, v]) => (
            <div key={l} className="rounded-2xl bg-paper px-3 py-2.5">
              <div className="text-[11px] text-ink-3">{l}</div>
              <div className="font-mono text-[16px] mt-0.5">{v}</div>
            </div>
          ))}
        </div>
      </div>

      {chartCurve && (
        <div className="rounded-3xl border border-line bg-surface p-4 sm:p-5">
          {coin.curves.length > 1 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {coin.curves.map((c) => (
                <button
                  key={c.chain.key}
                  type="button"
                  onClick={() => setChartChain(c.chain.key)}
                  className={"h-8 px-3 rounded-full text-[12px] font-semibold border " + (c.chain.key === chartCurve.chain.key ? "border-emerald text-ink" : "border-line text-ink-2")}
                >
                  {c.chain.short}
                </button>
              ))}
            </div>
          )}
          <PriceChart curve={chartCurve} ethUsd={chartCurve.chain.priceSymbol === "ETH" ? ethUsd : null} />
        </div>
      )}

      <div className="rounded-3xl border border-line bg-surface">
        <div className="flex gap-1 p-2 border-b border-line overflow-x-auto" role="tablist" aria-label="Details">
          {([["trades", "Trades"], ["holders", "Holders"], ["position", "My position"], ["about", "About"]] as const).map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={"h-9 px-4 rounded-xl text-[13px] font-semibold shrink-0 " + (tab === k ? "bg-paper text-ink" : "text-ink-3")}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="p-4 sm:p-5">
          {tab === "trades" && <TradesFeed coinId={coin.id} ethUsd={ethUsd} limit={30} />}
          {tab === "holders" && chartCurve && <TopHolders curve={chartCurve} />}
          {tab === "position" && <Position coin={coin} ethUsd={ethUsd} />}
          {tab === "about" && (
            <div className="grid gap-3 text-[14px] text-ink-2">
              {coin.description ? <p className="leading-relaxed">{coin.description}</p> : <p className="text-ink-3">No description.</p>}
              <div className="flex justify-between gap-4">
                <span>Created</span>
                <span>{timeAgo(coin.createdAt)} by <span className="font-mono">{shortAddr(coin.creator)}</span></span>
              </div>
              {coin.curves.map((c) => (
                <div key={c.chain.key} className="flex justify-between gap-4">
                  <span>{c.chain.short} coin</span>
                  <a className="font-mono text-emerald" href={explorerAddress(c.chain, c.token)} target="_blank" rel="noreferrer">
                    {shortAddr(c.token)}
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** What this wallet put in, took out, and holds now, across every chain. */
function Position({ coin, ethUsd }: { coin: Coin; ethUsd: number | null }) {
  const { address } = useWallet();
  const [data, setData] = useState<{ spent: number; back: number; nowEth: number; tokens: number } | null>(null);

  useEffect(() => {
    if (!address) return;
    let alive = true;
    (async () => {
      const [trades, holdings] = await Promise.all([
        fetchTrades({ coinId: coin.id, trader: address, limit: 500 }),
        Promise.all(
          coin.curves.map(async (c) => {
            const raw = (await clientFor(c.chain)
              .readContract({ address: c.token, abi: tokenAbi, functionName: "balanceOf", args: [address] })
              .catch(() => 0n)) as bigint;
            const tokens = Number(formatEther(raw));
            return { tokens, eth: tokens * nativePerToken(c) };
          })
        ),
      ]);
      const spent = trades.filter((t) => t.isBuy).reduce((s, t) => s + t.nativeAmount / 1e18, 0);
      const back = trades.filter((t) => !t.isBuy).reduce((s, t) => s + t.nativeAmount / 1e18, 0);
      const nowEth = holdings.reduce((s, h) => s + h.eth, 0);
      const tokens = holdings.reduce((s, h) => s + h.tokens, 0);
      if (alive) setData({ spent, back, nowEth, tokens });
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [address, coin.id, coin.curves]);

  const show = (eth: number) => (ethUsd ? usd(eth * ethUsd, 2) : `${eth.toFixed(5)} ETH`);
  if (!address) return <p className="text-[14px] text-ink-3">Connect your wallet to see your position.</p>;
  if (!data) return <Skeleton className="h-24" />;
  if (data.spent === 0 && data.tokens === 0) return <p className="text-[14px] text-ink-3">You don&apos;t hold ${coin.symbol} yet.</p>;
  const result = data.nowEth + data.back - data.spent;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {[
        ["Holding now", show(data.nowEth)],
        ["You spent", show(data.spent)],
        ["You got back", show(data.back)],
        ["Result", `${result >= 0 ? "+" : ""}${show(result)}`],
      ].map(([l, v], i) => (
        <div key={l} className="rounded-2xl bg-paper px-3 py-2.5">
          <div className="text-[11px] text-ink-3">{l}</div>
          <div className={"font-mono text-[15px] mt-0.5 " + (i === 3 ? (result >= 0 ? "text-up" : "text-danger") : "")}>{v}</div>
        </div>
      ))}
    </div>
  );
}
