"use client";

/** Top traders (leaderboard) and the Following feed. */
import { BadgeIcons } from "@/components/badges";
import { useBadges } from "@/lib/badges";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { Avatar, FollowButton } from "@/components/social";
import { CopyBadge, CopyButton } from "@/components/copy";
import { TraderBubbles } from "@/components/traderbubbles";
import { SkeletonRows, timeAgo, usd } from "@/components/coins";
import { coinHref, db, type Trade } from "@/lib/data";
import { fetchPrices } from "@/lib/price";
import {
  displayName,
  fetchFeed,
  fetchLeaderboard,
  isQuickSeller,
  profileHref,
  useFollowing,
  useProfiles,
  winRate,
  type Period,
  type TraderStats,
} from "@/lib/social";
import { signed } from "@/lib/portfolio";

export default function TradersPage() {
  return (
    <Suspense fallback={null}>
      <Traders />
    </Suspense>
  );
}

function Traders() {
  const params = useSearchParams();
  const [tab, setTab] = useState<"top" | "following">(params.get("tab") === "following" ? "following" : "top");
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  useEffect(() => {
    fetchPrices().then((p) => setEthUsd(p?.ETH ?? null)).catch(() => {});
  }, []);
  return (
    <div className="max-w-3xl mx-auto px-4 py-8 sm:py-12">
      <div className="flex gap-1 p-1 rounded-2xl bg-paper border border-line w-max" role="tablist" aria-label="Traders">
        {(
          [
            ["top", "Top traders"],
            ["following", "Following"],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => {
              setTab(k);
              history.replaceState(null, "", k === "following" ? "?tab=following" : location.pathname);
            }}
            className={"h-10 px-4 rounded-xl text-[0.9375rem] font-semibold " + (tab === k ? "bg-surface text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2")}
          >
            {l}
          </button>
        ))}
      </div>
      <Link href="/copy/?tab=best" className="mt-3 inline-flex items-center gap-1.5 text-[0.875rem] font-bold text-emerald">
        Best traders to copy
      </Link>
      {tab === "top" ? <Leaderboard ethUsd={ethUsd} /> : <Following ethUsd={ethUsd} />}
    </div>
  );
}

function Leaderboard({ ethUsd }: { ethUsd: number | null }) {
  const [period, setPeriod] = useState<Period>("w");
  const [view, setView] = useState<"bubbles" | "list">("bubbles");
  const [rows, setRows] = useState<TraderStats[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setRows(null);
    setError("");
    fetchLeaderboard(period)
      .then(setRows)
      .catch(() => setError("Couldn't load the leaderboard. Try again in a moment."));
  }, [period]);
  const profiles = useProfiles((rows ?? []).map((r) => r.trader));
  const badges = useBadges((rows ?? []).map((r) => r.trader));
  return (
    <>
      <h1 className="font-display font-semibold text-[1.75rem] sm:text-[2.25rem] tracking-tight mt-6">Top traders</h1>
      <p className="text-ink-2 mt-1">Ranked by profit from sells. A small minimum volume keeps one lucky trade off the top.</p>
      <div className="flex items-center justify-between gap-2 flex-wrap mt-4">
      <div className="flex gap-1 p-1 rounded-2xl bg-paper border border-line w-max" role="group" aria-label="Period">
        {(
          [
            ["d", "Today"],
            ["w", "7 days"],
            ["a", "All time"],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            aria-pressed={period === k}
            onClick={() => setPeriod(k)}
            className={"h-9 px-3.5 rounded-xl text-[0.8125rem] font-semibold " + (period === k ? "bg-surface text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2")}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="flex gap-1 p-1 rounded-2xl bg-paper border border-line w-max" role="group" aria-label="View">
        {(
          [
            ["bubbles", "Bubbles"],
            ["list", "List"],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            aria-pressed={view === k}
            onClick={() => setView(k)}
            className={"h-9 px-3.5 rounded-xl text-[0.8125rem] font-semibold " + (view === k ? "bg-surface text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2")}
          >
            {l}
          </button>
        ))}
      </div>
      </div>
      {error && <p className="text-danger text-[0.875rem] mt-4">{error}</p>}
      {rows === null && !error ? (
        <div className="mt-4 bg-surface border border-line rounded-2xl px-3 sm:px-4">
          <SkeletonRows rows={6} />
        </div>
      ) : rows && rows.length === 0 ? (
        <p className="text-ink-2 mt-6">No one qualifies yet for this period. Trade and you could be first.</p>
      ) : view === "bubbles" && rows ? (
        <TraderBubbles rows={rows} profiles={profiles} ethUsd={ethUsd} />
      ) : (
        <ol className="mt-4 bg-surface border border-line rounded-2xl divide-y divide-line">
          {(rows ?? []).map((r, i) => {
            const p = profiles.get(r.trader);
            const wr = winRate(r);
            const pnl = ethUsd !== null ? r.realized * ethUsd : null;
            return (
              <li key={r.trader} className="flex items-center gap-3 px-3 sm:px-4 py-3">
                <span className={"w-7 text-center font-mono text-[0.875rem] shrink-0 " + (i < 3 ? "text-[1.1rem]" : "text-ink-3")}>
                  {i + 1}
                </span>
                <a href={p ? profileHref(p) : `/u/${r.trader}/`} className="flex items-center gap-3 min-w-0 flex-1">
                  {p ? <Avatar profile={p} size={40} /> : <span className="w-10 h-10 rounded-full bg-line shrink-0" />}
                  <span className="min-w-0">
                    <span className="block font-semibold truncate">
                      {p ? displayName(p) : `${r.trader.slice(0, 6)}…`}
                      {isQuickSeller(r) && <span className="ml-1 text-[0.6875rem] text-ink-3 font-normal" title="Often sells within minutes of buying">quick seller</span>}
                      {p && p.allowCopy && !p.hideTrades && <CopyBadge className="ml-1.5 align-middle" />}
                    </span>
                    <span className="flex items-center gap-1.5 text-[0.75rem] text-ink-3 min-w-0">
                      <BadgeIcons badges={badges.get(r.trader.toLowerCase())} />
                      <span className="truncate">
                        {wr !== null ? `${Math.round(wr * 100)}% win · ` : ""}
                        {r.trades} trades
                      </span>
                    </span>
                  </span>
                </a>
                <span className={"font-mono text-[0.9375rem] shrink-0 " + (r.realized >= 0 ? "text-up" : "text-danger")}>
                  {pnl !== null ? signed(pnl) : "—"}
                </span>
                {p &&
                  (p.allowCopy && !p.hideTrades ? (
                    <>
                      {/* Copying follows them too, so phones only get the Copy button. */}
                      <span className="hidden sm:block">
                        <FollowButton profile={p} />
                      </span>
                      <CopyButton profile={p} />
                    </>
                  ) : (
                    <FollowButton profile={p} />
                  ))}
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

function Following({ ethUsd }: { ethUsd: number | null }) {
  const { address } = useWallet();
  const { set } = useFollowing();
  const [feed, setFeed] = useState<Trade[] | null>(null);
  const [coins, setCoins] = useState<Map<string, { name: string; symbol: string }>>(new Map());
  const followees = useMemo(() => [...set], [set]);
  const load = useCallback(async () => {
    const t = await fetchFeed(followees).catch(() => [] as Trade[]);
    setFeed(t);
    const ids = [...new Set(t.map((x) => x.coinId))];
    if (ids.length) {
      const { data } = await db.from("coins").select("id,name,symbol").in("id", ids);
      setCoins(new Map(((data ?? []) as { id: string; name: string; symbol: string }[]).map((c) => [c.id, c])));
    }
  }, [followees]);
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);
  const profiles = useProfiles((feed ?? []).map((t) => t.trader));

  if (!address)
    return (
      <div className="mt-8 max-w-sm">
        <p className="text-ink-2 mb-4">Log in to follow traders and see their trades here.</p>
        <ConnectButton full />
      </div>
    );
  return (
    <>
      <h1 className="font-display font-semibold text-[1.75rem] sm:text-[2.25rem] tracking-tight mt-6">Following</h1>
      <p className="text-ink-2 mt-1">
        Trades from the {followees.length} {followees.length === 1 ? "person" : "people"} you follow. You get an alert when they buy.
      </p>
      {feed === null ? (
        <div className="mt-4 bg-surface border border-line rounded-2xl px-3 sm:px-4">
          <SkeletonRows rows={6} />
        </div>
      ) : feed.length === 0 ? (
        <p className="text-ink-2 mt-6">
          Nothing yet. <a href="/traders/" className="text-emerald font-semibold">Find traders to follow</a>.
        </p>
      ) : (
        <ul className="mt-4 bg-surface border border-line rounded-2xl divide-y divide-line">
          {feed.map((t) => {
            const p = profiles.get(t.trader.toLowerCase());
            const c = coins.get(t.coinId);
            const amount = ethUsd !== null ? usd((t.nativeAmount / 1e18) * ethUsd, 2) : `${(t.nativeAmount / 1e18).toFixed(5)} ETH`;
            return (
              <li key={t.txHash + t.coinId + t.trader} className="flex items-center gap-3 px-3 sm:px-4 py-3">
                <a href={p ? profileHref(p) : `/u/${t.trader}/`} className="shrink-0">
                  {p ? <Avatar profile={p} size={40} /> : <span className="block w-10 h-10 rounded-full bg-line" />}
                </a>
                <div className="min-w-0 flex-1 text-[0.9375rem]">
                  <div className="leading-snug">
                    <a href={p ? profileHref(p) : `/u/${t.trader}/`} className="font-semibold">{p ? displayName(p) : t.trader.slice(0, 6)}</a>{" "}
                    <span className={t.isBuy ? "text-up font-semibold" : "text-danger font-semibold"}>{t.isBuy ? "bought" : "sold"}</span> <b>{amount}</b> of{" "}
                    <Link href={coinHref({ id: t.coinId })} className="font-bold hover:text-emerald">${c?.symbol ?? "…"}</Link>
                  </div>
                  <div className="text-[0.8125rem] text-ink-3 truncate">{c?.name ?? ""} · {timeAgo(t.ts)}</div>
                </div>
                {t.isBuy && (
                  <Link href={`${coinHref({ id: t.coinId })}&buy=1`} className="h-9 px-4 rounded-xl bg-up text-on-accent font-bold text-[0.8125rem] flex items-center shrink-0">
                    Buy
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
