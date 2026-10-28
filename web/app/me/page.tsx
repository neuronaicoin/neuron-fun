"use client";

/**
 * "You": profile, portfolio (cash, coins with profit / loss and quick sell),
 * coins you created and your trades. Deposit and Withdraw stay pinned at the bottom.
 */
import { TransitBanner } from "@/components/transitbanner";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { CoinCard, Skeleton, SkeletonRows } from "@/components/coins";
import { TradesFeed } from "@/components/market";
import { ExtPositionRow, FuturesBlock, PositionRow, RacePositionRow } from "@/components/portfolio";
import { V6 } from "@/lib/config";
import { RACE_CHAINS, fetchRaceCoins, type RaceCoin } from "@/lib/race";
import { CoinAvatar } from "@/components/coins";
import { raceHref } from "@/lib/race";
import { AllOrders } from "@/components/myorders";
import { MyAutoOrders } from "@/components/autopanel";
import { autoAnywhere } from "@/lib/auto";
import { Avatar, EditProfileSheet } from "@/components/social";
import { AllowCopyCard } from "@/components/copy";
import { InviteCard } from "@/components/invite";
import { FollowListSheet } from "@/components/follows";
import { coinHref, fetchPortfolio } from "@/lib/data";
import { money, openMoney, pctText, refreshPortfolio, signed, useMoney, CASH_SYMBOL } from "@/lib/portfolio";
import { displayName, fetchProfile, type Profile } from "@/lib/social";
import { extHref, fetchSasaSolCoins, money as compactUsd, type ExtCoin } from "@/lib/extcoins";
import { solanaFor } from "@/lib/solana";

type Data = Awaited<ReturnType<typeof fetchPortfolio>>;

export default function MePage() {
  const { address: signedIn, hintAddress, restoring } = useWallet();
  // while the login of last time comes back, the page shows (and loads) that person's view
  const address = signedIn ?? hintAddress;
  const { portfolio: p } = useMoney();
  const [data, setData] = useState<Data | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [list, setList] = useState<"followers" | "following" | null>(null);
  const [allTrades, setAllTrades] = useState(false);
  const [editing, setEditing] = useState(false);
  // phones show the first few coins (held and created), with "Load more" for the rest
  const phone = usePhone();
  const [heldShown, setHeldShown] = useState(STEP);
  const [madeShown, setMadeShown] = useState(STEP);
  // race coins this account created
  const [myRaces, setMyRaces] = useState<RaceCoin[] | null>(RACE_CHAINS.length ? null : []);
  useEffect(() => {
    if (!address || !RACE_CHAINS.length) return;
    fetchRaceCoins(50, { creator: address }).then(setMyRaces).catch(() => setMyRaces([]));
  }, [address]);

  // Solana coins this account launched (for people who see Solana yet)
  const [mySol, setMySol] = useState<ExtCoin[]>([]);
  useEffect(() => {
    setMySol([]);
    if (!address || !solanaFor(address)) return;
    fetchSasaSolCoins(50, "", address).then(setMySol).catch(() => {});
  }, [address]);

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

  if (!address && restoring) return <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-6 sm:pt-10"><Skeleton className="h-24" /></div>;
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
        {profile ? <Avatar profile={profile} size={64} /> : <span className="rounded-full bg-line animate-pulse shrink-0" style={{ width: 64, height: 64 }} />}
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
        <button
          type="button"
          disabled={!profile}
          onClick={() => setEditing(true)}
          className="h-10 px-4 rounded-xl border border-line font-semibold text-[0.875rem] hover:border-emerald shrink-0 disabled:opacity-40"
        >
          Edit
        </button>
      </div>
      <div className="flex gap-2 mt-4 overflow-x-auto no-scrollbar -mx-1 px-1">
        {[
          ...(V6
            ? [
                ["/traders/", "Top traders", false],
                ["/traders/?tab=following", "Following feed", false],
                ["/copy/", "Copy signals", false],
              ]
            : []),
          ["/points/", "Airdrop & invites", false],
          ["/forum/", "Forum", true],
          [`/u/${address.toLowerCase()}/`, "Public profile", true],
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

      <div className="mt-4 empty:hidden">
        <AllOrders />
      </div>
      {autoAnywhere() && (
        <div className="mt-4">
          <MyAutoOrders />
        </div>
      )}

      {/* Money */}
      <TransitBanner className="mt-6" />
      <section className="mt-6 rounded-3xl border border-line bg-surface p-4 sm:p-6" aria-label="Your money">
        {!p ? (
          <div aria-hidden="true">
            <div className="text-[0.8125rem] text-ink-3">Total balance</div>
            <div className="font-display text-[2.25rem] sm:text-[2.75rem] font-bold tracking-tight leading-none mt-1 relative">
              &nbsp;
              <span className="shimmer absolute inset-y-0 left-0 w-40 rounded-xl" />
            </div>
            <div className="font-mono text-[0.9375rem] font-semibold mt-1.5">&nbsp;</div>
            {/* the same boxes as below, empty, so nothing moves when the numbers arrive */}
            <div className="grid grid-cols-3 gap-2 mt-4">
              {["Cash", "Coins", "Futures"].map((label) => (
                <div key={label} className="min-w-0 rounded-2xl bg-paper border border-line px-2.5 sm:px-3 py-2.5">
                  <div className="text-[0.75rem] text-ink-3">{label}</div>
                  <div className="font-mono font-semibold text-[0.9375rem] sm:text-[1.0625rem] mt-0.5 relative">
                    &nbsp;
                    <span className="shimmer absolute inset-y-0.5 left-0 w-3/4 rounded-md" />
                  </div>
                  <div className="text-[0.6875rem]">&nbsp;</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="text-[0.8125rem] text-ink-3">Total balance</div>
            <div className="font-display text-[2.25rem] sm:text-[2.75rem] font-bold tracking-tight leading-none mt-1">{money(p.totalUsd)}</div>
            <div className={"font-mono text-[0.9375rem] font-semibold mt-1.5 " + (p.dayUsd >= 0 ? "text-up" : "text-danger")}>
              {p.coinsUsd > 0 ? `${signed(p.dayUsd)} (${pctText(p.dayPct)}) today` : "\u00a0"}
            </div>
            {/* what the total is made of: cash, coins, futures */}
            <div className="grid grid-cols-3 gap-2 mt-4">
              <div className="min-w-0 rounded-2xl bg-paper border border-line px-2.5 sm:px-3 py-2.5">
                <div className="text-[0.75rem] text-ink-3">Cash</div>
                <div className="font-mono font-semibold text-[0.9375rem] sm:text-[1.0625rem] mt-0.5 text-up truncate">{money(p.cashUsd)}</div>
                <div className="text-[0.6875rem] text-ink-3">{CASH_SYMBOL}</div>
              </div>
              <div className="min-w-0 rounded-2xl bg-paper border border-line px-2.5 sm:px-3 py-2.5">
                <div className="text-[0.75rem] text-ink-3">Coins</div>
                <div className="font-mono font-semibold text-[0.9375rem] sm:text-[1.0625rem] mt-0.5 truncate">{money(p.coinsUsd)}</div>
                <div className={"text-[0.6875rem] font-semibold truncate " + (p.openPnlUsd >= 0 ? "text-up" : "text-danger")}>{signed(p.openPnlUsd)} open</div>
              </div>
              <Link href="/perps/" className="min-w-0 rounded-2xl bg-paper border border-line px-2.5 sm:px-3 py-2.5 hover:border-emerald/60">
                <div className="text-[0.75rem] text-ink-3">Futures</div>
                <div className="font-mono font-semibold text-[0.9375rem] sm:text-[1.0625rem] mt-0.5 truncate">{money(p.futures?.valueUsd ?? 0)}</div>
                <div
                  className={
                    "text-[0.6875rem] font-semibold truncate " +
                    (!p.futures?.positions.length ? "text-ink-3" : futuresPnl(p) >= 0 ? "text-up" : "text-danger")
                  }
                >
                  {p.futures?.positions.length ? `${signed(futuresPnl(p))} open` : "no positions"}
                </div>
              </Link>
            </div>
            {p.realizedUsd !== 0 && (
              <div className="text-[0.75rem] text-ink-3 mt-2">
                Realized from sells: <b className={"font-mono " + (p.realizedUsd >= 0 ? "text-up" : "text-danger")}>{signed(p.realizedUsd)}</b>
              </div>
            )}
          </>
        )}
      </section>

      {/* Invites and points, one tap away */}
      <div className="mt-6">
        <InviteCard address={address} username={profile?.username ?? null} />
      </div>

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
            <SkeletonRows rows={3} avatar="square" className="py-2" />
          ) : p.positions.length === 0 && p.racePositions.length === 0 && p.extPositions.length === 0 ? (
            <p className="py-6 text-ink-2 text-[0.9375rem]">
              Nothing yet. <Link href="/explore/" className="text-emerald font-semibold">Find a coin you like</Link>.
            </p>
          ) : (
            (() => {
              // one list, most valuable first, whatever chain or kind (a coin worth $5 never hides
              // behind "Load more" under one worth 2 cents)
              const rows = [
                ...p.racePositions.map((pos) => ({ v: pos.valueUsd, el: <RacePositionRow key={pos.coin.id} pos={pos} big /> })),
                ...p.positions.map((pos) => ({ v: pos.valueUsd, el: <PositionRow key={pos.coin.id} pos={pos} big /> })),
                ...p.extPositions.map((h) => ({ v: h.valueUsd, el: <ExtPositionRow key={`${h.network}:${h.address}`} h={h} big /> })),
              ]
                .sort((a, b) => b.v - a.v)
                .map((r) => r.el);
              const shown = phone ? rows.slice(0, heldShown) : rows;
              return (
                <>
                  <ul>{shown}</ul>
                  {shown.length < rows.length && (
                    <LoadMore left={rows.length - shown.length} onClick={() => setHeldShown((n) => n + MORE)} />
                  )}
                </>
              );
            })()
          )}
        </div>
      </section>

      {/* Futures: balance and open positions */}
      {p?.futures && (
        <section className="mt-8">
          <h2 className="font-display font-semibold text-[1.25rem]">Futures</h2>
          <div className="mt-3 rounded-3xl border border-line bg-surface px-4 sm:px-5 py-2">
            <FuturesBlock f={p.futures} big />
          </div>
        </section>
      )}

      {/* Created */}
      <section className="mt-8">
        <h2 className="font-display font-semibold text-[1.25rem]">Coins you created</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {myRaces === null && [0, 1].map((i) => <Skeleton key={i} className="h-[4.75rem]" />)}
          {/* newest first; phones show the last few */}
          {myRaces?.slice(0, phone ? madeShown : undefined).map((r) => (
            <Link key={r.id} href={raceHref(r.id)} className="rounded-2xl border border-line bg-surface p-4 flex items-center gap-3 hover:border-emerald min-w-0">
              <CoinAvatar logo={r.logo} symbol={r.symbol} size={44} />
              <span className="min-w-0">
                <b className="block truncate">{r.name}</b>
                <span className="block text-[0.8125rem] text-ink-3 truncate">
                  ${r.symbol} · {r.lanes.length === 1 ? `on ${r.lanes[0].chain.short}` : r.winner ? `won on ${r.winner.short}` : `${r.lanes.length} chains`}
                </span>
              </span>
            </Link>
          ))}
          {mySol.slice(0, phone ? Math.max(0, madeShown - (myRaces?.length ?? 0)) : undefined).map((c) => (
            <Link key={c.address} href={extHref(c)} className="rounded-2xl border border-line bg-surface p-4 flex items-center gap-3 hover:border-emerald min-w-0">
              <CoinAvatar logo={c.image ?? ""} symbol={c.symbol} size={44} />
              <span className="min-w-0">
                <b className="block truncate">{c.name}</b>
                <span className="block text-[0.8125rem] text-ink-3 truncate">
                  ${c.symbol} · on Solana{c.mcapUsd ? ` · ${compactUsd(c.mcapUsd)} mcap` : ""}
                </span>
              </span>
            </Link>
          ))}
          {data?.created.slice(0, phone ? Math.max(0, madeShown - (myRaces?.length ?? 0) - mySol.length) : undefined).map((c) => (
            <CoinCard key={c.id} coin={c} />
          ))}
        </div>
        {phone && (myRaces?.length ?? 0) + mySol.length + (data?.created.length ?? 0) > madeShown && (
          <div className="mt-3 rounded-2xl border border-line bg-surface px-4">
            <LoadMore left={(myRaces?.length ?? 0) + mySol.length + (data?.created.length ?? 0) - madeShown} onClick={() => setMadeShown((n) => n + MORE)} />
          </div>
        )}
        {data && data.created.length === 0 && myRaces !== null && myRaces.length === 0 && mySol.length === 0 && (
          <div className="mt-1 text-center py-8 border border-dashed border-line rounded-2xl">
            <p className="text-ink-2">You haven&apos;t created a coin yet.</p>
            <Link href="/race/launch/" className="inline-flex mt-3 h-11 px-6 rounded-xl bg-emerald text-on-accent font-semibold items-center">Create a coin</Link>
          </div>
        )}
      </section>

      {/* Trades */}
      <section className="mt-8">
        <h2 className="font-display font-semibold text-[1.25rem]">Your trades</h2>
        <div className="mt-3 bg-surface border border-line rounded-3xl p-4 sm:p-5">
          <TradesFeed trader={address} names={names} ethUsd={ethUsd} limit={allTrades ? 30 : 5} />
          <button
            type="button"
            onClick={() => setAllTrades((v) => !v)}
            className="mt-2 w-full h-10 rounded-xl border border-line text-[0.8125rem] font-semibold text-ink-2 hover:border-emerald/60"
          >
            {allTrades ? "Show fewer" : "See more"}
          </button>
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

/** First this many coins on phones, then this many more per "Load more". */
const STEP = 3;
const MORE = 10;

/** Phones (under the sm breakpoint), following the window as it resizes. */
const PHONE_Q = "(max-width: 639px)";
function usePhone() {
  // read at once (not after a first paint), so a phone never shows the full list for a moment
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(PHONE_Q);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(PHONE_Q).matches,
    () => false
  );
}

function LoadMore({ left, onClick }: { left: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="w-full h-11 my-2 rounded-xl border border-line text-[0.875rem] font-semibold text-ink-2 hover:border-emerald/60">
      Load more ({left})
    </button>
  );
}

/** Open profit / loss of the futures positions. */
function futuresPnl(p: NonNullable<ReturnType<typeof useMoney>["portfolio"]>) {
  return (p.futures?.positions ?? []).reduce((s, x) => s + x.pnl, 0);
}
