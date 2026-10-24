"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CoinAvatar, Skeleton, timeAgo } from "@/components/coins";
import { RaceChart } from "@/components/racechart";
import { RaceBuyback } from "@/components/racebuyback";
import { HoldersPnl } from "@/components/holderspnl";
import { useChainSupply } from "@/lib/usesupply";
import { RaceTradeBox } from "@/components/racetrade";
import { CreatorKit, RaceShareButton } from "@/components/raceshare";
import { CoinLinksRow } from "@/components/coinlinks";
import { RaceChat } from "@/components/racechat";
import { RaceReplay } from "@/components/racereplay";
import { Confetti } from "@/components/confetti";
import { compactUsd, shortAddr } from "@/lib/format";
import { onTrade } from "@/lib/live";
import {
  clock,
  fetchRaceCoin,
  fetchRaceHolders,
  fetchRaceTrades,
  fmtPrice,
  laneUsd,
  leadLane,
  raceExplorerAddress,
  raceExplorerTx,
  racePhase,
  type RaceCoin,
  type RaceHolder,
  type RaceLane,
  type RaceTrade,
} from "@/lib/race";

export default function RacePageWrapper() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RacePage />
    </Suspense>
  );
}

function PageSkeleton() {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-4">
      <Skeleton className="h-20" />
      <Skeleton className="h-80" />
    </div>
  );
}

/** Ticks every second while the race runs, every 30 s after. */
function useNow(fast: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000);
    return () => clearInterval(t);
  }, [fast]);
  return now;
}

function RacePage() {
  const params = useSearchParams();
  const id = (params.get("id") ?? "").toLowerCase();
  const valid = /^0x[0-9a-f]{64}$/.test(id);
  const [coin, setCoin] = useState<RaceCoin | null>(null);
  const [missing, setMissing] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  const [failures, setFailures] = useState(0);
  // just launched from the create page (?new=1): wait for it nicely, then celebrate
  const [fresh] = useState(() => params.get("new") === "1");
  const [party, setParty] = useState(false);
  const endParty = useCallback(() => setParty(false), []);
  useEffect(() => {
    if (!fresh || !coin) return;
    setParty(true);
    const q = new URLSearchParams(window.location.search);
    q.delete("new");
    window.history.replaceState(null, "", `${window.location.pathname}?${q.toString()}`);
  }, [fresh, !!coin]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!valid) return;
    try {
      const c = await fetchRaceCoin(id);
      if (!c) setMissing(true);
      else {
        setCoin(c);
        setMissing(false);
      }
      setFailures(0);
    } catch {
      // keep what we have; the next refresh may work
      setFailures((n) => n + 1);
    }
  }, [id, valid]);

  const live = coin ? racePhase(coin, Date.now()) !== "decided" : true;
  useEffect(() => {
    void load();
    const t = setInterval(load, fresh && !coin ? 1_000 : live ? 3_000 : 10_000);
    const stop = onTrade((s) => s.coinId.toLowerCase() === id && [1500, 4000].forEach((d) => setTimeout(load, d)));
    return () => {
      clearInterval(t);
      stop();
    };
  }, [load, live, id, fresh, !!coin]); // eslint-disable-line react-hooks/exhaustive-deps

  const now = useNow(live);
  // market cap = price × the coins that exist on that chain (not always 1B: see chainSupply)
  const supplyLane = coin ? ((coin.winner ? null : coin.lanes.find((l) => l.chain.chainId === pick && l.state !== 3)) ?? leadLane(coin) ?? coin.lanes[0]) : null;
  const supply = useChainSupply(coin?.winner ?? supplyLane?.chain, coin?.coin ?? "");

  if (valid && fresh && !coin) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-20 text-center flex flex-col gap-4 items-center" role="status" aria-live="polite">
        <span className="relative flex w-16 h-16" aria-hidden="true">
          <span className="absolute inset-0 rounded-full bg-[#ff6b1a]/25 animate-ping" />
          <span className="relative w-16 h-16 rounded-full flex items-center justify-center text-[1.75rem]" style={{ background: "linear-gradient(135deg, #ffb020, #ff6b1a)" }}>
            🚀
          </span>
        </span>
        <h1 className="text-[1.5rem] font-bold">Your coin is going live…</h1>
        <p className="text-ink-2 max-w-sm">It&apos;s on the chain. Its page opens here by itself in a few seconds.</p>
      </div>
    );
  }
  if (!valid || (missing && !coin)) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center flex flex-col gap-3 items-center">
        <h1 className="text-[1.5rem] font-bold">Race not found</h1>
        <p className="text-ink-2">The link may be wrong, or the race is a few seconds old and not indexed yet.</p>
        <Link href="/explore/" className="text-emerald font-semibold">
          Back to Explore
        </Link>
      </div>
    );
  }
  if (!coin)
    return failures >= 3 ? (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center flex flex-col gap-3 items-center">
        <h1 className="text-[1.5rem] font-bold">Can&apos;t reach the race data</h1>
        <p className="text-ink-2">The connection is slow right now. This page keeps trying by itself.</p>
      </div>
    ) : (
      <PageSkeleton />
    );

  const phase = racePhase(coin, now);
  // launched on one chain only: no race to show, it simply trades there
  const solo = coin.lanes.length === 1;
  const lead = leadLane(coin);
  const lane = (coin.winner ? null : coin.lanes.find((l) => l.chain.chainId === pick && l.state !== 3)) ?? lead ?? coin.lanes[0];
  // Before the verdict every chain has its own price; after it, the winner's is the coin's.
  const chartChain = coin.winner ? coin.winner.chainId : (lane?.chain.chainId ?? null);
  const price = lane?.priceUsd ?? null;
  const mcap = price ? price * supply : null;
  const trades = coin.lanes.reduce((s, l) => s + l.buys + l.sells, 0);
  const volume = coin.lanes.reduce((s, l) => s + l.volumeUsd, 0);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-4 pb-24 lg:pb-12 flex flex-col gap-5 sm:gap-6 min-w-0">
      {party && <Confetti onDone={endParty} />}
      <Link href="/explore/" className="text-[0.9375rem] text-ink-2 self-start">
        ‹ Explore
      </Link>

      {/* title */}
      <header className="flex gap-3 sm:gap-4 items-center min-w-0">
        <CoinAvatar logo={coin.logo} symbol={coin.symbol} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="text-[1.5rem] sm:text-[2.25rem] font-extrabold tracking-tight leading-tight break-words line-clamp-2">
            {coin.name} <span className="text-[1rem] sm:text-[1.25rem] font-bold text-ink-3 whitespace-nowrap">{coin.symbol}</span>
          </h1>
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-[0.8125rem] sm:text-[0.875rem] text-ink-2 mt-1 min-w-0">
            <span className="truncate">
              by <b className="font-semibold text-ink">{shortAddr(coin.creator)}</b>
            </span>
            <span>{timeAgo(new Date(coin.launchedAt).toISOString())}</span>
            {solo ? <SoloBadge coin={coin} /> : <PhaseBadge coin={coin} phase={phase} now={now} />}
            <RaceShareButton coin={coin} />
          </div>
          <CoinLinksRow coinId={coin.id} creator={coin.creator} className="mt-2" />
        </div>
      </header>

      <div className="flex flex-col lg:flex-row gap-5 lg:gap-8 items-start min-w-0">
        {/* left: price, chart, race, activity */}
        <div className="flex-1 min-w-0 w-full flex flex-col gap-5">
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="text-[2rem] sm:text-[2.5rem] font-extrabold tracking-tight leading-none tabular-nums">{fmtPrice(price)}</div>
              <div className="text-[0.875rem] text-ink-3 mt-1">
                {coin.winner ? `Price on ${coin.winner.short}` : lane ? `Price on ${lane.chain.short}` : "Price"}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[0.8125rem] text-ink-3">Market cap</div>
              <div className="text-[1.375rem] sm:text-[1.625rem] font-bold tabular-nums">{compactUsd(mcap)}</div>
            </div>
          </div>

          <RaceChart coinId={coin.id} chainId={chartChain} supply={supply} creator={coin.creator} since={coin.launchedAt} />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-line rounded-2xl overflow-hidden border border-line">
            <Fact label="Market cap" value={compactUsd(mcap)} />
            <Fact label="Volume" value={compactUsd(volume)} />
            <Fact label="Trades" value={trades.toLocaleString("en-US")} />
            <Fact label={solo ? "Raised" : "In the race"} value={compactUsd(coin.totalUsd ?? coin.lanes.reduce((s, l) => s + laneUsd(l), 0))} />
          </div>

          {coin.feeMode === 1 && (coin.winner || solo) && <RaceBuyback chain={coin.winner ?? coin.lanes[0].chain} coin={coin.coin} />}

          {!solo && <RaceLanes coin={coin} phase={phase} now={now} />}

          {!solo && phase === "decided" && coin.winner && <RaceReplay coin={coin} />}

          {!solo && <RaceChat coin={coin} now={now} />}

          <CreatorKit coin={coin} now={now} />

          {/* phones: the trade box comes before the activity lists */}
          <div className="lg:hidden scroll-mt-24" id="trade">
            {lane && <RaceTradeBox coin={coin} lanes={coin.lanes} lane={lane} onLane={setPick} />}
          </div>

          <Activity coin={coin} lane={lane} supply={supply} />

          {coin.description && (
            <section className="flex flex-col gap-2">
              <h2 className="text-[1.125rem] font-bold">About</h2>
              <p className="text-[0.9375rem] text-ink-2 whitespace-pre-line break-words">{coin.description}</p>
            </section>
          )}

          <section className="flex flex-col gap-2 text-[0.8125rem] text-ink-3 min-w-0">
            <div className="flex gap-2 min-w-0">
              <span className="shrink-0">Contract</span>
              {lane ? (
                <a href={raceExplorerAddress(lane.chain, coin.coin)} target="_blank" rel="noreferrer" className="font-mono text-ink-2 truncate underline-offset-2 hover:underline">
                  {coin.coin}
                </a>
              ) : (
                <span className="font-mono truncate">{coin.coin}</span>
              )}
            </div>
            <span>Same address on every chain. 1B coins in total.</span>
          </section>
        </div>

        {/* right: trade box (desktop) */}
        <aside className="hidden lg:block w-[360px] shrink-0 sticky top-20">
          {lane && <RaceTradeBox coin={coin} lanes={coin.lanes} lane={lane} onLane={setPick} />}
        </aside>
      </div>

      {/* phones: a fixed buy button that jumps to the trade box */}
      {lane && lane.state !== 3 && (
        <div
          className="lg:hidden fixed inset-x-0 z-30 px-4 pt-2 pb-2 bg-paper/95 backdrop-blur border-t border-line"
          // sits on the phone menu when it shows (it publishes its height), else on the screen's edge
          style={{ bottom: "var(--money-bar-bottom, env(safe-area-inset-bottom, 0px))" }}
        >
          <div className="flex gap-2 max-w-lg mx-auto">
            {(["buy", "sell"] as const).map((side) => (
              <a
                key={side}
                href="#trade"
                data-haptic-strong
                onClick={() => window.dispatchEvent(new CustomEvent("sasa-trade-side", { detail: side }))}
                className={
                  "flex items-center justify-center h-12 rounded-2xl font-bold text-[1rem] " +
                  (side === "buy" ? "flex-1 bg-up text-white" : "w-[34%] border-2 border-line text-ink bg-paper")
                }
              >
                {side === "buy" ? `Buy ${coin.symbol}` : "Sell"}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-3 sm:px-4 py-3 min-w-0">
      <div className="text-[0.75rem] sm:text-[0.8125rem] text-ink-3 truncate">{label}</div>
      <div className="text-[1.125rem] sm:text-[1.375rem] font-bold tabular-nums truncate">{value}</div>
    </div>
  );
}

/** A coin launched on a single chain: where it trades, no race. */
function SoloBadge({ coin }: { coin: RaceCoin }) {
  const c = coin.lanes[0]?.chain;
  if (!c) return null;
  return (
    <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full font-semibold text-[0.75rem] text-white" style={{ background: c.color }}>
      On {c.short}
    </span>
  );
}

function PhaseBadge({ coin, phase, now }: { coin: RaceCoin; phase: string; now: number }) {
  if (phase === "racing")
    return (
      <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-emerald-soft text-emerald-dark font-semibold text-[0.75rem]">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald animate-pulse" />
        Racing · {clock(coin.endsAt - now)}
      </span>
    );
  if (phase === "deciding")
    return <span className="inline-flex items-center h-6 px-2.5 rounded-full bg-night text-ink-2 font-semibold text-[0.75rem]">Counting the money…</span>;
  if (phase === "open")
    return <span className="inline-flex items-center h-6 px-2.5 rounded-full bg-night text-ink-2 font-semibold text-[0.75rem]">Trading on every chain</span>;
  if (coin.winner)
    return (
      <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full font-semibold text-[0.75rem] text-white" style={{ background: coin.winner.color }}>
        Won on {coin.winner.short}
        {!coin.confirmed && <span className="font-normal opacity-80">· confirming</span>}
      </span>
    );
  return <span className="inline-flex items-center h-6 px-2.5 rounded-full bg-night text-ink-2 font-semibold text-[0.75rem]">Race over</span>;
}

function RaceLanes({ coin, phase, now }: { coin: RaceCoin; phase: string; now: number }) {
  const max = Math.max(1, ...coin.lanes.map((l) => laneUsd(l) + (l.mergedUsd || 0)));
  return (
    <section className="rounded-2xl border border-line p-4 sm:p-5 flex flex-col gap-3 min-w-0">
      <div className="flex justify-between items-baseline gap-3 flex-wrap">
        <h2 className="text-[1.125rem] font-bold">The race</h2>
        <span className="text-[0.8125rem] text-ink-3">
          {coin.lanes.length} chains · 5 minutes
          {phase === "racing" ? ` · ${clock(coin.endsAt - now)} left` : coin.winner ? ` · ${coin.winner.short} won` : ""}
        </span>
      </div>
      {coin.lanes.map((l) => (
        <LaneRow key={l.chain.chainId} lane={l} max={max} coin={coin} phase={phase} now={now} />
      ))}
      <p className="text-[0.75rem] text-ink-3">
        The chain with the most money after five minutes wins. Its pool is locked for good; the other chains close and their holders are moved to the winner.
      </p>
    </section>
  );
}

function LaneRow({ lane, max, coin, phase, now }: { lane: RaceLane; max: number; coin: RaceCoin; phase: string; now: number }) {
  const merged = lane.mergedUsd > 0.005 ? lane.mergedUsd : 0;
  const usd = laneUsd(lane) + merged;
  const pct = Math.max(2, Math.round((usd / max) * 100));
  // the winner is known from the chains' reports right at the end; the pools close once the verdict lands
  const isWinner = !!coin.winner && coin.winner.chainId === lane.chain.chainId;
  const won = lane.state === 2 || isWinner;
  const lost = lane.state === 3 || (!!coin.winner && !isWinner);
  const note = won
    ? merged ? `Winner · +${compactUsd(merged)} merged` : lane.state === 2 ? "Winner · locked" : "Winner"
    : lost
      ? lane.state === 3 ? `Moved to ${coin.winner?.short ?? "winner"}` : `Lost · moving to ${coin.winner?.short ?? "winner"}`
      : phase === "racing" && lane.endsAt ? clock(lane.endsAt - now) : phase === "open" ? "Open" : "Counting…";
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_4.5rem] sm:grid-cols-[7rem_minmax(0,1fr)_5.5rem_8.5rem] gap-2 sm:gap-3 items-center text-[0.8125rem] sm:text-[0.875rem]">
      <span className={"font-semibold truncate " + (lost ? "text-ink-3" : "text-ink")}>{lane.chain.short}</span>
      <div className="h-2.5 bg-night rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${pct}%`, background: lane.chain.color, opacity: lost ? 0.35 : 1 }} />
      </div>
      <span className="tabular-nums text-right">{compactUsd(usd)}</span>
      <span className={"hidden sm:block truncate " + (won ? "font-bold" : "text-ink-3")} style={won ? { color: lane.chain.color } : undefined}>
        {note}
      </span>
    </div>
  );
}

function Activity({ coin, lane, supply }: { coin: RaceCoin; lane: RaceLane | undefined; supply: number }) {
  const [tab, setTab] = useState<"pnl" | "trades" | "holders">("pnl");
  const [trades, setTrades] = useState<RaceTrade[] | null>(null);
  const [holders, setHolders] = useState<RaceHolder[] | null>(null);
  const holderLane = coin.winner ? coin.lanes.find((l) => l.chain.chainId === coin.winner!.chainId) : lane;
  // the page refreshes the coin every few seconds: key the holders on the chain, not the object
  const holderChainId = holderLane?.chain.chainId ?? null;

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchRaceTrades(coin.id, 40)
        .then((t) => alive && setTrades(t))
        .catch(() => {});
    load();
    const t = setInterval(load, 4_000);
    const stop = onTrade((s) => s.coinId.toLowerCase() === coin.id && [1500, 4000].forEach((d) => setTimeout(load, d)));
    return () => {
      alive = false;
      clearInterval(t);
      stop();
    };
  }, [coin.id]);

  useEffect(() => {
    if (tab !== "holders" || !holderLane) return;
    let alive = true;
    setHolders(null);
    fetchRaceHolders(holderLane.chain, coin.coin, 20)
      .then((h) => alive && setHolders(h))
      .catch(() => alive && setHolders([]));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, holderChainId, coin.coin]);

  const tabBtn = (k: "pnl" | "trades" | "holders", label: string) => (
    <button
      type="button"
      onClick={() => setTab(k)}
      className={"py-3 px-1 text-[0.9375rem] border-b-2 -mb-px " + (tab === k ? "border-ink text-ink font-semibold" : "border-transparent text-ink-3")}
      aria-pressed={tab === k}
    >
      {label}
    </button>
  );

  return (
    <section className="min-w-0">
      <div className="flex gap-5 border-b border-line">
        {tabBtn("pnl", "Holders")}
        {tabBtn("trades", "Trades")}
        {tabBtn("holders", "Top wallets")}
      </div>
      {tab === "pnl" ? (
        <HoldersPnl coin={coin} supply={supply} />
      ) : tab === "trades" ? (
        trades === null ? (
          <Skeleton className="h-40 mt-3" />
        ) : trades.length === 0 ? (
          <p className="py-6 text-ink-3 text-[0.875rem]">No trades yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {trades.map((t) => (
              <li key={`${t.chain.chainId}:${t.txHash}:${t.logIndex}`}>
                <a
                  href={raceExplorerTx(t.chain, t.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="grid grid-cols-[3rem_minmax(0,1fr)_auto] sm:grid-cols-[3.5rem_minmax(0,1fr)_6rem_7rem_3.5rem] gap-2 sm:gap-3 items-center py-3 text-[0.875rem] tabular-nums hover:bg-night/60 px-1 rounded-lg"
                >
                  <span className={"font-semibold " + (t.isBuy ? "text-up" : "text-danger")}>{t.isBuy ? "Buy" : "Sell"}</span>
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: t.chain.color }} aria-label={t.chain.short} />
                    <span className="truncate">{t.via === "launch" ? "Creator" : shortAddr(t.trader)}</span>
                  </span>
                  <span className="text-right">${t.usd < 1 ? t.usd.toFixed(2) : t.usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                  <span className="hidden sm:block text-right text-ink-2">{fmtPrice(t.priceUsd)}</span>
                  <span className="hidden sm:block text-right text-ink-3">{ago(t.ts)}</span>
                </a>
              </li>
            ))}
          </ul>
        )
      ) : holders === null ? (
        <Skeleton className="h-40 mt-3" />
      ) : holders.length === 0 ? (
        <p className="py-6 text-ink-3 text-[0.875rem]">No holders yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {holders.map((h, i) => (
            <li key={h.holder} className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] gap-2 items-center py-3 text-[0.875rem] tabular-nums">
              <span className="text-ink-3">{i + 1}</span>
              <span className="truncate">
                {shortAddr(h.holder)}
                {h.holder.toLowerCase() === coin.creator.toLowerCase() && <span className="ml-2 text-[0.75rem] text-emerald-dark font-semibold">creator</span>}
              </span>
              <span className="text-right">{(h.share * 100).toFixed(2)}%</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ago(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
