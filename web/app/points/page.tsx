"use client";

/**
 * Points, Season 0: your points, rank and streak, quests, invite link with
 * what your invites earned, and the leaderboard.
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
import { displayName, profileHref, useProfiles } from "@/lib/social";
import { claimQuest, QUESTS, boostFor, fetchBoard, fetchMyPoints, fetchRewards, type BoardRow, type MyPoints, type Rewards } from "@/lib/points";

const fmt = (n: number) => n.toLocaleString("en-US");

export default function PointsPage() {
  const { address, signMessage } = useWallet();
  const me = address?.toLowerCase() ?? null;
  const [mine, setMine] = useState<MyPoints | null>(null);
  const [board, setBoard] = useState<BoardRow[] | null>(null);
  const [rewards, setRewards] = useState<Rewards | null>(null);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetchBoard(50)
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
    fetchMyPoints(me).then(setMine).catch(() => setError(true));
    fetchRewards(me).then(setRewards).catch(() => {});
  }, [me]);

  const profiles = useProfiles(useMemo(() => [...(board ?? []).map((r) => r.owner), ...(me ? [me] : [])], [board, me]));
  const myProfile = me ? profiles.get(me) : undefined;
  const inviteLink = me && typeof window !== "undefined" ? `${window.location.origin}/?ref=${myProfile?.username ?? me}` : "";
  const done = new Set(mine?.quests ?? []);
  const boost = boostFor(mine?.streak ?? 0);
  const toUsd = (wei: number) => (ethUsd ? usd((wei / 1e18) * ethUsd, 2) : `${(wei / 1e18).toFixed(5)} ETH`);

  async function questAction(a: "follow" | "share") {
    if (a === "share") {
      shareOnX();
      return;
    }
    followOnX();
    if (!address) return;
    try {
      await claimQuest(signMessage, "follow_x");
      setMine((m) => (m && !m.quests.includes("follow_x") ? { ...m, quests: [...m.quests, "follow_x"], total: m.total + 50 } : m));
      toast("Thanks for following! +50 points");
    } catch {}
  }

  function shareOnX() {
    postOnX(
      inviteLink
        ? "I'm on @sasapadfun, the meme coin launchpad that launches on every chain at once 🚀 Join with my link and start with 100 points 👇"
        : "Found @sasapadfun: launch a meme coin on every chain at once, designed by AI from one sentence 🚀",
      inviteLink || "https://sasapad.fun"
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
        <div aria-hidden="true" className="pointer-events-none absolute -top-24 -right-24 w-80 h-80 rounded-full bg-emerald/25 blur-3xl" />
        <p className="relative font-mono text-[0.6875rem] sm:text-[0.75rem] tracking-[0.14em] text-emerald">SEASON 0 · RANKS THE EARLIEST SASA USERS</p>
        <h1 className="relative font-display font-extrabold text-[1.75rem] sm:text-[2.5rem] leading-[1.05] tracking-tight mt-2">Earn points. Climb the board.</h1>
        <p className="relative text-ink-2 mt-2 max-w-[58ch] text-[0.9375rem]">
          Points show how active you are on sasa. The more you trade, launch and invite, the higher you climb. Top players get an OG badge on their profile for good.
        </p>

        {!address ? (
          <div className="relative mt-5 max-w-xs">
            <ConnectButton full />
          </div>
        ) : !mine ? (
          <Skeleton className="relative h-24 mt-5" />
        ) : (
          <div className="relative grid grid-cols-2 lg:grid-cols-4 gap-2.5 mt-5">
            <Stat label="Your points" value={fmt(mine.total)} note={mine.today ? `+${fmt(mine.today)} from trading today` : "Trade today to earn more"} />
            <Stat label="Rank" value={mine.total > 0 ? `#${fmt(mine.rank)}` : "—"} note={`of ${fmt(Math.max(mine.players, 1))} players`} />
            <div className="rounded-2xl border border-line bg-paper px-3.5 py-3">
              <div className="text-[0.75rem] text-ink-3">Daily streak</div>
              <div className="font-display font-bold text-[1.375rem]">
                {mine.streak} {mine.streak === 1 ? "day" : "days"}
              </div>
              <div className="flex gap-1 mt-1" aria-label={`${Math.min(mine.streak, 7)} of 7 days`}>
                {Array.from({ length: 7 }, (_, i) => (
                  <span key={i} className={"h-2.5 flex-1 rounded-full " + (i < Math.min(mine.streak, 7) ? "bg-emerald" : "bg-line")} />
                ))}
              </div>
            </div>
            <Stat label="Trading boost" value={`${boost.toFixed(boost % 1 ? 1 : 0)}×`} note={boost >= 2 ? "Maxed. Keep your streak!" : "7 days in a row → 2×"} />
          </div>
        )}
      </section>

      {error && <p className="text-[0.875rem] text-ink-3 mt-4">Points are being set up. Check back in a few minutes.</p>}

      <div className="grid gap-4 mt-4 lg:grid-cols-[1.15fr_1fr] lg:items-start">
        {/* Quests + daily */}
        <section className="rounded-3xl border border-line bg-surface p-4 sm:p-5" aria-label="How to earn">
          <div className="flex items-baseline justify-between">
            <h2 className="font-display font-bold text-[1.125rem]">Quests</h2>
            <span className="text-[0.75rem] text-ink-3">once each</span>
          </div>
          <ul className="mt-2 divide-y divide-line">
            {QUESTS.map((q) => {
              const ok = done.has(q.id);
              return (
                <li key={q.id} className="flex items-center gap-3 py-2.5">
                  <span className={"w-10 h-10 rounded-xl flex items-center justify-center text-[1.125rem] shrink-0 " + (ok ? "bg-up/15" : "bg-paper")} aria-hidden="true">
                    {ok ? "✅" : q.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={"block font-semibold text-[0.9375rem] " + (ok ? "line-through text-ink-3" : "")}>{q.title}</span>
                    <span className="block text-[0.75rem] text-ink-3">{q.note}</span>
                  </span>
                  {ok ? (
                    <span className="font-mono font-bold text-[0.8125rem] text-up shrink-0">+{q.pts}</span>
                  ) : (
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="font-mono font-bold text-[0.8125rem] text-warn-ink">+{q.pts}</span>
                      {q.action ? (
                        <button
                          type="button"
                          onClick={() => void questAction(q.action!)}
                          className="h-8 px-3 rounded-lg border border-line bg-paper text-[0.75rem] font-bold flex items-center hover:border-emerald"
                        >
                          Go
                        </button>
                      ) : (
                        <Link href={q.href ?? "/"} className="h-8 px-3 rounded-lg border border-line bg-paper text-[0.75rem] font-bold flex items-center hover:border-emerald">
                          Go
                        </Link>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="flex items-baseline justify-between mt-5">
            <h2 className="font-display font-bold text-[1.125rem]">Every day</h2>
            <span className="text-[0.75rem] text-ink-3">resets at midnight UTC</span>
          </div>
          <ul className="mt-2 divide-y divide-line text-[0.875rem]">
            <Daily icon="📈" title="Trade" note="1 point per $1 traded, up to 500 a day" pts="up to +500" />
            <Daily icon="🔥" title="Keep your streak" note="Trade every day to grow your boost" pts="up to 2×" />
            <Daily icon="🎓" title="Your coin graduates" note="For every coin you launched that reaches its target" pts="+1,000" />
          </ul>
          <p className="text-[0.75rem] text-ink-3 mt-3">Trades in coins you launched yourself don&apos;t earn trading points.</p>
        </section>

        {/* On phones the invite card comes first: it's the one people act on. */}
        <div className="grid gap-4 order-first lg:order-none">
          {/* Invites */}
          <section className="rounded-3xl border border-line p-4 sm:p-5 bg-gradient-to-br from-emerald-soft to-surface" aria-label="Invite friends">
            <h2 className="font-display font-bold text-[1.125rem]">Invite friends, earn together</h2>
            <p className="text-[0.875rem] text-ink-2 mt-1">
              Your friends start with <b className="text-ink">100 points</b>. You get <b className="text-ink">20% of the points</b> they earn, plus{" "}
              <b className="text-ink">20% of sasa&apos;s fees</b> from their trades for a year, paid daily into your cash.
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
                <button
                  type="button"
                  onClick={shareOnX}
                  className="mt-2 w-full h-11 rounded-xl bg-ink text-mist font-bold flex items-center justify-center gap-2"
                >
                  <XLogo /> Post my invite on X
                </button>
                <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                  <Mini value={fmt(mine?.friends ?? 0)} label="friends joined" />
                  <Mini value={`+${fmt(mine?.friendsPts ?? 0)}`} label="points from friends" />
                  <Mini value={rewards ? toUsd(rewards.earned) : "—"} label="earned in fees" />
                </div>
                {rewards && rewards.earned > 0 && (
                  <p className="text-[0.75rem] text-ink-3 mt-2">
                    {toUsd(rewards.paid)} paid · {toUsd(rewards.pending)} on its way (paid once a day)
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

          {/* Leaderboard */}
          <section className="rounded-3xl border border-line bg-surface p-4 sm:p-5" aria-label="Leaderboard">
            <div className="flex items-baseline justify-between">
              <h2 className="font-display font-bold text-[1.125rem]">Leaderboard</h2>
              <span className="text-[0.75rem] text-ink-3">Season 0</span>
            </div>
            {board === null ? (
              <Skeleton className="h-48 mt-3" />
            ) : board.length === 0 ? (
              <p className="text-[0.875rem] text-ink-3 mt-3">No one has points yet. Be the first.</p>
            ) : (
              <ol className="mt-2">
                {board.slice(0, 20).map((r) => {
                  const p = profiles.get(r.owner);
                  const isMe = r.owner === me;
                  return (
                    <li key={r.owner} className={"flex items-center gap-3 px-2 py-2 rounded-xl " + (isMe ? "bg-emerald-soft" : "")}>
                      <span className="w-8 text-center font-mono text-[0.8125rem] text-ink-3 shrink-0">{r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : r.rank}</span>
                      <Link href={p ? profileHref(p) : `/u/${r.owner}/`} className="flex items-center gap-2.5 min-w-0 flex-1">
                        {p ? <Avatar profile={p} size={30} /> : <span className="w-[30px] h-[30px] rounded-full bg-line shrink-0" />}
                        <span className="font-semibold text-[0.875rem] truncate">{isMe ? "You" : p ? displayName(p) : `${r.owner.slice(0, 6)}…${r.owner.slice(-4)}`}</span>
                      </Link>
                      <span className="font-mono font-bold text-[0.875rem] tabular-nums shrink-0">{fmt(r.total)}</span>
                    </li>
                  );
                })}
                {mine && me && mine.total > 0 && !board.slice(0, 20).some((r) => r.owner === me) && (
                  <li className="flex items-center gap-3 px-2 py-2 rounded-xl bg-emerald-soft mt-1">
                    <span className="w-8 text-center font-mono text-[0.8125rem] text-ink-3 shrink-0">{mine.rank}</span>
                    <span className="flex items-center gap-2.5 min-w-0 flex-1">
                      {myProfile ? <Avatar profile={myProfile} size={30} /> : <span className="w-[30px] h-[30px] rounded-full bg-line shrink-0" />}
                      <span className="font-semibold text-[0.875rem]">You</span>
                    </span>
                    <span className="font-mono font-bold text-[0.875rem] tabular-nums shrink-0">{fmt(mine.total)}</span>
                  </li>
                )}
              </ol>
            )}
          </section>
        </div>
      </div>

      <p className="text-[0.75rem] text-ink-3 mt-5 max-w-[80ch]">
        Points are for ranking and profile badges. They aren&apos;t money, can&apos;t be sold or traded, and don&apos;t promise a token or any other reward. Wash
        trading, fake accounts and self-invites are removed from the board. Rules can change during the season.
      </p>
    </div>
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

function Daily({ icon, title, note, pts }: { icon: string; title: string; note: string; pts: string }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="w-10 h-10 rounded-xl bg-paper flex items-center justify-center text-[1.125rem] shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{title}</span>
        <span className="block text-[0.75rem] text-ink-3">{note}</span>
      </span>
      <span className="font-mono font-bold text-[0.8125rem] text-warn-ink shrink-0">{pts}</span>
    </li>
  );
}

function XLogo() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
