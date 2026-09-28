"use client";

import Link from "next/link";
import { ScrollRow } from "@/components/scrollrow";
import { Confetti, useGraduationParty } from "@/components/confetti";
import { Sparkline } from "@/components/spark";
import { useSparks } from "@/lib/spark";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatEther } from "viem";
import { useWallet } from "@/components/wallet";
import { ChainChip, ChainRace, ChangeBadge, CoinAvatar, ProgressBar, Skeleton, StarButton, timeAgo, useCoins, usd } from "@/components/coins";
import { coinMarketCapUsd, compactUsd, RaceBar } from "@/components/discover";
import { PriceChart, TopHolders, TradesFeed } from "@/components/market";
import { QuickTrade } from "@/components/trade";
import { MobileTradeBar } from "@/components/mobiletrade";
import { ShareButton } from "@/components/share";
import { Sheet } from "@/components/chrome";
import { TrustCard } from "@/components/trust";
import { FeeBox } from "@/components/feebox";
import { CoinAlertButton } from "@/components/alerts";
import { alertLinesFor, useAlerts } from "@/lib/alerts";
import { useBuyerMarkers } from "@/lib/social";
import { forumBoardUrl } from "@/lib/forum";
import { LiveStats } from "@/components/livestats";
import { CoinComments } from "@/components/comments";
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

function Terminal() {
  const params = useSearchParams();
  const [selected, setSelected] = useState<string>((params.get("id") ?? "").toLowerCase());
  const [sort, setSort] = useState<SortKey>("trending");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [marketsOpen, setMarketsOpen] = useState(false);
  // Phones: the coin list fills the screen; tapping a coin opens it (chart + trade).
  const [phoneView, setPhoneView] = useState<"list" | "coin">(params.get("id") ? "coin" : "list");
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
    setPhoneView("coin");
    if (window.matchMedia("(max-width: 1023px)").matches) window.scrollTo(0, 0);
    try {
      window.history.replaceState(null, "", `/terminal/?id=${encodeURIComponent(id)}`);
    } catch {}
  };

  return (
    <div className="max-w-[1500px] mx-auto px-3 sm:px-4 py-2 sm:py-4">
      {/* Phones: a full-width list of coins, or the chosen coin with a way back */}
      {phoneView === "list" ? (
        <div className="lg:hidden">
          <Markets
            coins={coins}
            ethUsd={ethUsd}
            selected={selected}
            onChoose={choose}
            sort={sort}
            setSort={setSort}
            query={query}
            setQuery={setQuery}
            full
          />
        </div>
      ) : (
        <div className="lg:hidden flex items-center justify-between gap-2 mb-2">
          <button
            type="button"
            onClick={() => {
              setPhoneView("list");
              window.scrollTo(0, 0);
            }}
            className="h-10 px-3 -ml-1 rounded-xl text-emerald font-semibold text-[0.9375rem] flex items-center gap-1"
          >
            ← All coins
          </button>
          <button type="button" onClick={() => setMarketsOpen(true)} aria-label="Search coins" className="w-10 h-10 rounded-xl border border-line text-ink-2 flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </button>
        </div>
      )}
      {marketsOpen && (
        <Sheet title="Coins" onClose={() => setMarketsOpen(false)}>
          <Markets
            coins={coins}
            ethUsd={ethUsd}
            selected={selected}
            onChoose={(id) => {
              choose(id);
              setMarketsOpen(false);
            }}
            sort={sort}
            setSort={setSort}
            query={query}
            setQuery={setQuery}
          />
        </Sheet>
      )}

      <div className={(phoneView === "list" ? "hidden lg:grid " : "grid ") + "grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-[300px_minmax(0,1fr)_360px] lg:items-start"}>
        <aside className="hidden lg:block lg:sticky lg:top-[76px]">
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

        <section className="min-w-0">
          {coin ? <Center coin={coin} ethUsd={ethUsd} /> : <Skeleton className="h-[640px]" />}
        </section>

        <aside className="min-w-0 lg:sticky lg:top-[76px]">
          {coin ? (
            <>
              <div className="hidden lg:block">
                <QuickTrade coin={coin} ethUsd={ethUsd} onTraded={loadCoin} />
              </div>
              <div className="mt-3"><FeeBox coin={coin} onChange={loadCoin} /></div>
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
      {coin && phoneView === "coin" && <MobileTradeBar coin={coin} ethUsd={ethUsd} onTraded={loadCoin} />}
    </div>
  );
}

/** Market tabs, shared by the desktop list and the phone strip. */
const MARKET_TABS: readonly (readonly [SortKey, string])[] = [
  ["watchlist", "★"],
  ["trending", "🔥 Trending"],
  ["gainers", "Gainers"],
  ["losers", "Losers"],
  ["hot", "Closest to grad."],
  ["bonding", "Bonding"],
  ["new", "New"],
  ["graduated", "Graduated"],
];

function MarketTabs({ sort, setSort }: { sort: SortKey; setSort: (s: SortKey) => void }) {
  return (
    <ScrollRow label="Sort" edge="surface">
      {MARKET_TABS.map(([k, l]) => (
        <button
          key={k}
          type="button"
          aria-pressed={sort === k}
          aria-label={k === "watchlist" ? "Favourites" : undefined}
          onClick={(e) => {
            setSort(k);
            e.currentTarget.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
          }}
          className={
            "h-9 px-3.5 rounded-xl text-[0.8125rem] font-semibold shrink-0 whitespace-nowrap " +
            (sort === k ? "bg-emerald text-on-accent" : "text-ink-2 hover:text-ink hover:bg-paper")
          }
        >
          {l}
        </button>
      ))}
    </ScrollRow>
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
  /** Phones: no height cap, the page scrolls. */
  full?: boolean;
}) {
  const { coins, ethUsd, selected, onChoose, sort, setSort, query, setQuery, full = false } = props;
  const sparks = useSparks(useMemo(() => (coins ?? []).map((c) => c.id), [coins]));
  return (
    <div className="rounded-3xl border border-line bg-surface overflow-hidden">
      <div className="p-3 border-b border-line">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name or ticker"
          aria-label="Search coins"
          className="w-full h-10 px-3 rounded-xl border border-line bg-paper text-[0.875rem] focus:border-emerald"
        />
        <div className="mt-2">
          <MarketTabs sort={sort} setSort={setSort} />
        </div>
      </div>
      <ul className={(full ? "" : "max-h-[70dvh] lg:max-h-[calc(100dvh-220px)] overflow-y-auto ") + "divide-y divide-line"}>
        {!coins && [0, 1, 2, 3, 4].map((i) => <li key={i} className="p-3"><Skeleton className="h-10" /></li>)}
        {coins?.length === 0 && <li className="p-6 text-center text-[0.875rem] text-ink-3">No coins found.</li>}
        {coins?.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onChoose(c.id)}
              className={"w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-paper " + (c.id === selected ? "bg-paper" : "")}
            >
              <CoinAvatar logo={c.logo} symbol={c.symbol} size={36} />
              <span className="min-w-0 flex-1">
                <span className="grid grid-cols-[minmax(0,1fr)_3.5rem_auto] items-center gap-2">
                  <span className="min-w-0">
                    <span className="block font-semibold text-[0.875rem] truncate">{c.name}</span>
                    <span className="block text-[0.75rem] text-ink-3 truncate mt-0.5">
                      ${c.symbol} · {c.graduatedOn ? "graduated" : `${Math.round(c.progress * 100)}% to grad.`}
                    </span>
                  </span>
                  <Sparkline pts={sparks.get(c.id)} fill={false} className="w-14 h-6" />
                  <span className="text-right shrink-0">
                    <span className="block font-mono font-bold tabular-nums text-[0.875rem]">{compactUsd(coinMarketCapUsd(c, ethUsd))}</span>
                    <ChangeBadge value={c.change24h} className="block text-[0.75rem] font-semibold mt-0.5" />
                  </span>
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

type CenterTab = "trades" | "comments" | "holders" | "position" | "about";

function Center({ coin, ethUsd }: { coin: Coin; ethUsd: number | null }) {
  const [chartChain, setChartChain] = useState("");
  const [tab, setTab] = useState<CenterTab>("trades");
  const chartCurve =
    coin.curves.find((c) => c.chain.key === chartChain) ??
    coin.graduatedOn ??
    [...coin.curves].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0];
  const mc = coinMarketCapUsd(coin, ethUsd);
  const { alerts } = useAlerts();
  const alertLines = useMemo(() => alertLinesFor(alerts, coin.id), [alerts, coin.id]);
  const buyerMarkers = useBuyerMarkers(coin.id, chartCurve?.curve ?? null, ethUsd);
  const party = useGraduationParty(coin.id, !!coin.graduatedOn);
  const [partyDone, setPartyDone] = useState(false);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      {party && !partyDone && <Confetti onDone={() => setPartyDone(true)} />}
      <div className="rounded-3xl border border-line bg-surface p-3.5 sm:p-5">
        <div className="flex items-start gap-3">
          <CoinAvatar logo={coin.logo} symbol={coin.symbol} size={46} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-display font-bold text-[1.375rem] sm:text-[1.625rem] leading-tight truncate">{coin.name}</h1>
              <Link href={coinHref(coin)} className="text-[0.75rem] text-ink-3 underline">Coin page</Link>
              <a href={forumBoardUrl(coin)} className="text-[0.75rem] text-ink-3 underline">Forum</a>
            </div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <span className="text-[0.8125rem] text-ink-3 mr-1">${coin.symbol}</span>
              {coin.curves.map((c) => (
                <ChainChip key={c.chain.key} chain={c.chain} muted={c.state === "closed"} />
              ))}
            </div>
          </div>
          <div className="flex gap-1.5 shrink-0">
            <ShareButton coin={coin} />
            <CoinAlertButton coin={coin} ethUsd={ethUsd} />
            <StarButton coinId={coin.id} />
          </div>
        </div>
        <div className="mt-3 sm:mt-4">
          <LiveStats coin={coin} ethUsd={ethUsd} />
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
                  className={"h-8 px-3 rounded-full text-[0.75rem] font-semibold border " + (c.chain.key === chartCurve.chain.key ? "border-emerald text-ink" : "border-line text-ink-2")}
                >
                  {c.chain.short}
                </button>
              ))}
            </div>
          )}
          <PriceChart curve={chartCurve} ethUsd={chartCurve.chain.priceSymbol === "ETH" ? ethUsd : null} alertLines={alertLines} markers={buyerMarkers} />
        </div>
      )}

      <div className="rounded-3xl border border-line bg-surface">
        <div className="flex gap-1 p-2 border-b border-line overflow-x-auto" role="tablist" aria-label="Details">
          {([["trades", "Trades"], ["comments", "Comments"], ["holders", "Holders"], ["position", "My position"], ["about", "About"]] as const).map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={"h-9 px-4 rounded-xl text-[0.8125rem] font-semibold shrink-0 " + (tab === k ? "bg-paper text-ink" : "text-ink-3")}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="p-4 sm:p-5">
          {tab === "trades" && <TradesFeed coinId={coin.id} ethUsd={ethUsd} limit={30} />}
          {tab === "holders" && chartCurve && <TopHolders curve={chartCurve} />}
          {tab === "position" && <Position coin={coin} ethUsd={ethUsd} />}
          {tab === "comments" && <CoinComments coin={coin} bare />}
          {tab === "about" && (
            <div className="grid gap-3 text-[0.875rem] text-ink-2">
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
  if (!address) return <p className="text-[0.875rem] text-ink-3">Connect your wallet to see your position.</p>;
  if (!data) return <Skeleton className="h-24" />;
  if (data.spent === 0 && data.tokens === 0) return <p className="text-[0.875rem] text-ink-3">You don&apos;t hold ${coin.symbol} yet.</p>;
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
          <div className="text-[0.6875rem] text-ink-3">{l}</div>
          <div className={"font-mono text-[0.9375rem] mt-0.5 " + (i === 3 ? (result >= 0 ? "text-up" : "text-danger") : "")}>{v}</div>
        </div>
      ))}
    </div>
  );
}
