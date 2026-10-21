"use client";

/**
 * Airdrop: what counts toward the future sasa airdrop (coins created, dollars traded), your
 * place on the list, the top of the list, and invites. Only what people did is shown: never a
 * score, a ratio or an amount.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { toast } from "@/components/alerts";
import { Avatar } from "@/components/social";
import { followOnX, postOnX } from "@/components/share";
import { Skeleton, usd } from "@/components/coins";
import { fetchPrices } from "@/lib/price";
import { displayName, profileHref, useProfiles, type Profile } from "@/lib/social";
import { fetchAirdropBoard, fetchMyAirdrop, fetchRewards, type Airdrop, type AirdropRow, type Rewards } from "@/lib/points";

const fmt = (n: number) => n.toLocaleString("en-US");
const money = (n: number) => (n >= 1000 ? usd(n, 0) : usd(n, 2));

export default function PointsPage() {
  const { address } = useWallet();
  const me = address?.toLowerCase() ?? null;
  const [mine, setMine] = useState<Airdrop | null>(null);
  const [board, setBoard] = useState<AirdropRow[] | null>(null);
  const [rewards, setRewards] = useState<Rewards | null>(null);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [error, setError] = useState(false);

  // Links like /points/#invite open straight at the invite card.
  useEffect(() => {
    if (window.location.hash !== "#invite") return;
    const t = setTimeout(() => document.getElementById("invite")?.scrollIntoView({ block: "start", behavior: "smooth" }), 250);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    fetchAirdropBoard(100)
      .then(setBoard)
      .catch(() => {
        setBoard([]);
        setError(true);
      });
    fetchPrices()
      .then((p) => setEthUsd(p?.ETH ?? null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setMine(null);
    setRewards(null);
    if (!me) return;
    fetchMyAirdrop(me)
      .then((a) => setMine(a ?? { coins: 0, traded: 0, rank: 0, players: 0 }))
      .catch(() => setError(true));
    fetchRewards(me).then(setRewards).catch(() => {});
  }, [me]);

  const profiles = useProfiles(useMemo(() => [...(board ?? []).map((r) => r.owner), ...(me ? [me] : [])], [board, me]));
  const myProfile = me ? profiles.get(me) : undefined;
  const inviteLink = me && typeof window !== "undefined" ? `${window.location.origin}/?ref=${myProfile?.username ?? me}` : "";
  // older rewards are in wei (ETH), the dollar ones in USDC units: shown together in dollars
  const toUsd = (wei: number, usdc = 0) =>
    wei === 0 || ethUsd ? usd((ethUsd ? (wei / 1e18) * ethUsd : 0) + usdc / 1e6, 2) : `${(wei / 1e18).toFixed(5)} ETH + ${usd(usdc / 1e6, 2)}`;
  const top = (board ?? []).slice(0, 50);

  function shareOnX() {
    postOnX(
      "Farming the @sasapadfun airdrop 🪂 Create a coin, trade, the more you do the bigger it gets 👇",
      inviteLink || "https://sasapad.fun/points/"
    );
  }

  async function share() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      toast("Invite link copied");
    } catch {
      toast("Copy the link from the box");
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5 sm:py-10 pb-28 md:pb-12">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl border border-line bg-surface p-5 sm:p-7">
        <p className="relative text-[0.8125rem] text-ink-3">🪂 sasa airdrop</p>
        <h1 className="relative font-display font-bold text-[1.625rem] sm:text-[2.25rem] leading-[1.1] tracking-tight mt-1">Create coins. Trade. Earn the airdrop.</h1>
        <p className="relative text-ink-2 mt-2 max-w-[58ch] text-[0.9375rem]">
          The sasa token isn&apos;t out yet. When it comes, early users get the airdrop. The more coins you create and the more you trade, the bigger your share. No limit.
        </p>

        <ol className="relative grid sm:grid-cols-3 gap-2.5 mt-5">
          <Step n={1} title="Follow @sasapadfun" note="The airdrop is announced only there">
            <button type="button" onClick={followOnX} className="h-9 px-3 rounded-lg border border-line bg-paper text-[0.8125rem] font-bold hover:border-emerald">
              Follow on X
            </button>
          </Step>
          <Step n={2} title="Create a coin" note="Every coin counts">
            <Link href="/race/launch/" className="h-9 px-3 rounded-lg bg-emerald text-on-accent text-[0.8125rem] font-bold flex items-center hover:bg-emerald-dark">
              Create a coin
            </Link>
          </Step>
          <Step n={3} title="Trade" note="Every dollar counts, any coin">
            <Link href="/explore/" className="h-9 px-3 rounded-lg border border-line bg-paper text-[0.8125rem] font-bold flex items-center hover:border-emerald">
              Find coins
            </Link>
          </Step>
        </ol>

        {!address ? (
          <div className="relative mt-5 max-w-xs">
            <ConnectButton full />
          </div>
        ) : !mine ? (
          <Skeleton className="relative h-24 mt-5" />
        ) : (
          <div className="relative grid grid-cols-3 gap-2.5 mt-5">
            <Stat label="Coins you created" value={fmt(mine.coins)} note={mine.coins ? "Create more to grow it" : "Create your first one"} />
            <Stat label="You traded" value={money(mine.traded)} note={mine.traded ? "Buys and sells" : "Make your first trade"} />
            <Stat label="Your place" value={mine.rank > 0 ? `#${fmt(mine.rank)}` : "—"} note={mine.rank > 0 ? `of ${fmt(Math.max(mine.players, 1))} people` : "Not on the list yet"} />
          </div>
        )}
      </section>

      {error && <p className="text-[0.875rem] text-ink-3 mt-4">The list is being set up. Check back in a few minutes.</p>}

      <div className="grid gap-4 mt-4 lg:grid-cols-[1.15fr_1fr] lg:items-start">
        {/* The list */}
        <section className="rounded-3xl border border-line bg-surface p-4 sm:p-5" aria-label="Airdrop list">
          <div className="flex items-baseline justify-between">
            <h2 className="font-display font-bold text-[1.125rem]">Top of the list</h2>
            <span className="text-[0.75rem] text-ink-3">updates live</span>
          </div>
          {board === null ? (
            <Skeleton className="h-48 mt-3" />
          ) : top.length === 0 ? (
            <p className="text-[0.875rem] text-ink-3 mt-3">No one is on the list yet. Be the first.</p>
          ) : (
            <>
              <div className="flex items-center gap-3 px-2 pt-3 pb-1 text-[0.6875rem] text-ink-3">
                <span className="w-8 text-center shrink-0">#</span>
                <span className="flex-1">Who</span>
                <span className="w-14 text-right shrink-0">Coins</span>
                <span className="w-20 text-right shrink-0">Traded</span>
              </div>
              <ol>
                {top.map((r) => (
                  <Row key={r.owner} r={r} isMe={r.owner === me} profile={profiles.get(r.owner)} />
                ))}
                {mine && me && mine.rank > 0 && !top.some((r) => r.owner === me) && (
                  <Row r={{ owner: me, coins: mine.coins, traded: mine.traded, rank: mine.rank }} isMe profile={myProfile} />
                )}
              </ol>
            </>
          )}
        </section>

        {/* Invites */}
        <section id="invite" className="scroll-mt-24 rounded-xl border border-line p-4 sm:p-5 bg-surface" aria-label="Invite friends">
          <h2 className="font-display font-bold text-[1.125rem]">Invite friends</h2>
          <p className="text-[0.875rem] text-ink-2 mt-1">
            You get <b className="text-ink">25% of sasa&apos;s fees</b> from their trades for a year, paid daily into your cash.
          </p>
          {address ? (
            <>
              <div className="flex gap-2 mt-3">
                <input
                  readOnly
                  value={inviteLink}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Your invite link"
                  className="flex-1 min-w-0 h-11 rounded-xl border border-line bg-surface px-3 font-mono text-[0.75rem] sm:text-[0.8125rem]"
                />
                <button type="button" onClick={() => void share()} className="h-11 px-4 rounded-xl border border-line bg-surface font-bold shrink-0">
                  Copy
                </button>
              </div>
              <button type="button" onClick={shareOnX} className="mt-2 w-full h-11 rounded-xl bg-ink text-mist font-bold flex items-center justify-center gap-2">
                <XLogo /> Post my invite on X
              </button>
              <div className="grid grid-cols-2 gap-2 mt-3 text-center">
                <Mini value={fmt(rewards?.friends ?? 0)} label="friends joined" />
                <Mini value={rewards ? toUsd(rewards.earned, rewards.usdEarned) : "—"} label="earned in fees" />
              </div>
              {rewards && rewards.earned + rewards.usdEarned > 0 && (
                <p className="text-[0.75rem] text-ink-3 mt-2">
                  {toUsd(rewards.paid, rewards.usdPaid)} paid · {toUsd(rewards.pending, rewards.usdPending)} on its way (paid once a day, from $0.50)
                </p>
              )}
              {!myProfile?.username && (
                <p className="text-[0.75rem] text-ink-3 mt-2">
                  Tip: <Link href="/me/" className="font-semibold text-emerald">pick a username</Link> for a shorter link.
                </p>
              )}
            </>
          ) : (
            <p className="text-[0.875rem] text-ink-3 mt-3">Log in to get your invite link.</p>
          )}
        </section>
      </div>

      <p className="text-[0.75rem] text-ink-3 mt-5 max-w-[80ch]">
        There is no sasa token yet. The date and the amounts haven&apos;t been decided; they&apos;ll be announced only on @sasapadfun on X. Any &quot;sasa token&quot; you see
        before that is fake. Counted on Base, BNB Chain, Robinhood Chain and Arc. Rules can change before the airdrop.
      </p>
    </div>
  );
}

function Step({ n, title, note, children }: { n: number; title: string; note: string; children: React.ReactNode }) {
  return (
    <li className="rounded-2xl border border-line bg-paper px-3.5 py-3 flex flex-col gap-2">
      <div className="flex items-start gap-2.5">
        <span className="w-6 h-6 rounded-full bg-ink text-mist text-[0.75rem] font-bold flex items-center justify-center shrink-0">{n}</span>
        <span className="min-w-0">
          <span className="block font-semibold text-[0.9375rem]">{title}</span>
          <span className="block text-[0.75rem] text-ink-3">{note}</span>
        </span>
      </div>
      <div className="flex">{children}</div>
    </li>
  );
}

function Row({ r, isMe, profile }: { r: AirdropRow; isMe: boolean; profile: Profile | undefined }) {
  return (
    <li className={"flex items-center gap-3 px-2 py-2 rounded-xl " + (isMe ? "bg-emerald-soft" : "")}>
      <span className="w-8 text-center font-mono text-[0.8125rem] text-ink-3 shrink-0">{r.rank}</span>
      <Link href={profile ? profileHref(profile) : `/u/${r.owner}/`} className="flex items-center gap-2.5 min-w-0 flex-1">
        {profile ? <Avatar profile={profile} size={28} /> : <span className="w-[28px] h-[28px] rounded-full bg-line shrink-0" />}
        <span className="font-semibold text-[0.875rem] truncate">{isMe ? "You" : profile ? displayName(profile) : `${r.owner.slice(0, 6)}…${r.owner.slice(-4)}`}</span>
      </Link>
      <span className="w-14 text-right font-mono text-[0.8125rem] tabular-nums shrink-0">{fmt(r.coins)}</span>
      <span className="w-20 text-right font-mono font-bold text-[0.8125rem] tabular-nums shrink-0">{money(r.traded)}</span>
    </li>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-2xl border border-line bg-paper px-3.5 py-3 min-w-0">
      <div className="text-[0.75rem] text-ink-3">{label}</div>
      <div className="font-display font-bold text-[1.375rem] truncate">{value}</div>
      <div className="text-[0.6875rem] sm:text-[0.75rem] text-ink-3 truncate">{note}</div>
    </div>
  );
}

function Mini({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl bg-surface border border-line px-2 py-2.5 min-w-0">
      <div className="font-display font-bold text-[1rem] sm:text-[1.0625rem] truncate">{value}</div>
      <div className="text-[0.6875rem] text-ink-3 leading-tight">{label}</div>
    </div>
  );
}

function XLogo() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
