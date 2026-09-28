"use client";

/**
 * "You": profile, portfolio (cash, coins with profit / loss and quick sell),
 * coins you created and your trades. Deposit and Withdraw stay pinned at the bottom.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { CoinCard, Skeleton } from "@/components/coins";
import { TradesFeed } from "@/components/market";
import { PositionRow } from "@/components/portfolio";
import { Avatar, EditProfileSheet } from "@/components/social";
import { AllowCopyCard } from "@/components/copy";
import { FollowListSheet } from "@/components/follows";
import { coinHref, fetchPortfolio } from "@/lib/data";
import { money, openMoney, pctText, refreshPortfolio, signed, useMoney, CASH_SYMBOL } from "@/lib/portfolio";
import { displayName, fetchProfile, type Profile } from "@/lib/social";

type Data = Awaited<ReturnType<typeof fetchPortfolio>>;

export default function MePage() {
  const { address } = useWallet();
  const { portfolio: p } = useMoney();
  const [data, setData] = useState<Data | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [list, setList] = useState<"followers" | "following" | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (!address) return;
    fetchPortfolio(address).then(setData).catch(() => {});
    fetchProfile(address).then(setProfile).catch(() => {});
    void refreshPortfolio();
  }, [address]);

  useEffect(() => {
    setData(null);
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  const ethUsd = data?.prices?.ETH ?? p?.ethUsd ?? null;
  const names = useMemo(
    () => new Map((data?.holdings ?? []).map((h) => [h.coin.id, { name: h.coin.name, symbol: h.coin.symbol, href: coinHref(h.coin) }])),
    [data]
  );

  if (!address) {
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-semibold text-[1.875rem]">You</h1>
        <p className="text-ink-2 mt-3">Log in to see your money, the coins you hold and the ones you created.</p>
        <div className="mt-6">
          <ConnectButton full />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-6 sm:pt-10 pb-40 md:pb-28">
      {/* Profile */}
      <div className="flex items-center gap-4">
        {profile ? <Avatar profile={profile} size={64} /> : <span className="w-16 h-16 rounded-full bg-line animate-pulse shrink-0" />}
        <div className="min-w-0 flex-1">
          <h1 className="font-display font-semibold text-[1.5rem] sm:text-[1.875rem] tracking-tight truncate">
            {profile ? (profile.username ? displayName(profile) : "You") : "…"}
          </h1>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.875rem] mt-0.5">
            <button type="button" onClick={() => setList("followers")} className="hover:text-emerald">
              <b className="font-mono">{profile?.followers ?? 0}</b> <span className="text-ink-2">followers</span>
            </button>
            <button type="button" onClick={() => setList("following")} className="hover:text-emerald">
              <b className="font-mono">{profile?.following ?? 0}</b> <span className="text-ink-2">following</span>
            </button>
          </div>
        </div>
        {profile && (
          <button type="button" onClick={() => setEditing(true)} className="h-10 px-4 rounded-xl border border-line font-semibold text-[0.875rem] hover:border-emerald shrink-0">
            Edit
          </button>
        )}
      </div>
      <div className="flex gap-2 mt-4 overflow-x-auto no-scrollbar -mx-1 px-1">
        {[
          ["/traders/", "🏆 Top traders", false],
          ["/traders/?tab=following", "👥 Following feed", false],
          ["/copy/", "🪞 Copy signals", false],
          ["/forum/", "💬 Forum", true],
          [`/u/${address.toLowerCase()}/`, "🙂 Public profile", true],
        ].map(([href, label, plain]) =>
          plain ? (
            <a key={href as string} href={href as string} className="h-10 px-4 rounded-xl border border-line bg-surface font-semibold text-[0.875rem] flex items-center shrink-0 whitespace-nowrap hover:border-emerald">
              {label}
            </a>
          ) : (
            <Link key={href as string} href={href as string} className="h-10 px-4 rounded-xl border border-line bg-surface font-semibold text-[0.875rem] flex items-center shrink-0 whitespace-nowrap hover:border-emerald">
              {label}
            </Link>
          )
        )}
      </div>

      {/* Money */}
      <section className="mt-6 rounded-3xl border border-line bg-surface p-4 sm:p-6" aria-label="Your money">
        {!p ? (
          <Skeleton className="h-24" />
        ) : (
          <>
            <div className="text-[0.8125rem] text-ink-3">Total balance</div>
            <div className="font-display text-[2.25rem] sm:text-[2.75rem] font-bold tracking-tight leading-none mt-1">{money(p.totalUsd)}</div>
            {p.coinsUsd > 0 && (
              <div className={"font-mono text-[0.9375rem] font-semibold mt-1.5 " + (p.dayUsd >= 0 ? "text-up" : "text-danger")}>
                {signed(p.dayUsd)} ({pctText(p.dayPct)}) today
              </div>
            )}
            <div className="grid grid-cols-3 gap-2 mt-4">
              <div className="rounded-2xl bg-paper border border-line px-3 py-2.5">
                <div className="text-[0.75rem] text-ink-3">Cash</div>
                <div className="font-mono font-semibold text-[1.0625rem] mt-0.5 text-up">{money(p.cashUsd)}</div>
                <div className="text-[0.6875rem] text-ink-3">{CASH_SYMBOL}</div>
              </div>
              <div className="rounded-2xl bg-paper border border-line px-3 py-2.5">
                <div className="text-[0.75rem] text-ink-3">Coins</div>
                <div className="font-mono font-semibold text-[1.0625rem] mt-0.5">{money(p.coinsUsd)}</div>
                <div className={"text-[0.6875rem] font-semibold " + (p.openPnlUsd >= 0 ? "text-up" : "text-danger")}>{signed(p.openPnlUsd)} open</div>
              </div>
              <div className="rounded-2xl bg-paper border border-line px-3 py-2.5">
                <div className="text-[0.75rem] text-ink-3">Realized</div>
                <div className={"font-mono font-semibold text-[1.0625rem] mt-0.5 " + (p.realizedUsd >= 0 ? "text-up" : "text-danger")}>{signed(p.realizedUsd)}</div>
                <div className="text-[0.6875rem] text-ink-3">from sells</div>
              </div>
            </div>
          </>
        )}
      </section>

      {/* Copy trading: let followers copy me */}
      {profile && (
        <div className="mt-6">
          <AllowCopyCard profile={profile} onChange={load} />
        </div>
      )}

      {/* Coins held */}
      <section className="mt-8">
        <h2 className="font-display font-semibold text-[1.25rem]">Your coins</h2>
        <div className="mt-3 rounded-3xl border border-line bg-surface px-4 sm:px-5">
          {!p ? (
            <Skeleton className="h-24 my-4" />
          ) : p.positions.length === 0 ? (
            <p className="py-6 text-ink-2 text-[0.9375rem]">
              Nothing yet. <Link href="/explore/" className="text-emerald font-semibold">Find a coin you like</Link>.
            </p>
          ) : (
            <ul>
              {p.positions.map((pos) => (
                <PositionRow key={pos.coin.id} pos={pos} big />
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Created */}
      <section className="mt-8">
        <h2 className="font-display font-semibold text-[1.25rem]">Coins you created</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {!data && <Skeleton className="h-40" />}
          {data?.created.map((c) => (
            <CoinCard key={c.id} coin={c} />
          ))}
        </div>
        {data && data.created.length === 0 && (
          <div className="mt-1 text-center py-8 border border-dashed border-line rounded-2xl">
            <p className="text-ink-2">You haven&apos;t created a coin yet.</p>
            <Link href="/create/" className="inline-flex mt-3 h-11 px-6 rounded-xl bg-emerald text-on-accent font-semibold items-center">Create a coin</Link>
          </div>
        )}
      </section>

      {/* Trades */}
      <section className="mt-8">
        <h2 className="font-display font-semibold text-[1.25rem]">Your trades</h2>
        <div className="mt-3 bg-surface border border-line rounded-3xl p-4 sm:p-5">
          <TradesFeed trader={address} names={names} ethUsd={ethUsd} limit={30} />
        </div>
      </section>

      {/* Deposit / Withdraw, pinned above the bottom menu on phones and at the bottom on computers */}
      <div
        className="fixed inset-x-0 z-30 px-3 py-2 bg-mist/95 backdrop-blur border-t border-line md:py-3"
        style={{ bottom: "var(--money-bar-bottom)" }}
      >
        <div className="grid grid-cols-2 gap-2 max-w-3xl mx-auto">
          <button type="button" onClick={() => openMoney({ kind: "deposit" })} className="h-12 rounded-2xl bg-up text-on-accent text-[1rem] font-bold shadow-sm hover:brightness-110">
            ＋ Deposit
          </button>
          <button type="button" onClick={() => openMoney({ kind: "withdraw" })} className="h-12 rounded-2xl bg-emerald text-on-accent text-[1rem] font-bold shadow-sm hover:bg-emerald-dark">
            Withdraw
          </button>
        </div>
      </div>

      {list && <FollowListSheet address={address} kind={list} onClose={() => setList(null)} />}
      {editing && profile && (
        <EditProfileSheet
          current={profile}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            fetchProfile(address).then(setProfile).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
