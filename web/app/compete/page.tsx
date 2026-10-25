"use client";

/** The creator competition: countdown, prize steps, the creators board, your place and the rules. */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@/components/wallet";
import { Skeleton, usd } from "@/components/coins";
import { Avatar } from "@/components/social";
import { displayName, profileHref, useProfiles } from "@/lib/social";
import { COMP, STEPS, fetchCompBoard, prizeFor, type CompRow } from "@/lib/compete";

const fmt = (n: number) => n.toLocaleString("en-US");
const money = (n: number) => (n >= 1000 ? usd(n, 0) : usd(n, 2));
const short = (n: number) => (n >= 1e6 ? `$${n / 1e6}M` : n >= 1e3 ? `$${n / 1e3}K` : `$${n}`);

function left(ms: number) {
  if (ms <= 0) return "Ended";
  const d = Math.floor(ms / 86400e3), h = Math.floor((ms % 86400e3) / 3600e3), m = Math.floor((ms % 3600e3) / 60e3);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`;
}

export default function CompetePage() {
  const { address, hintAddress } = useWallet();
  const me = (address ?? hintAddress)?.toLowerCase() ?? null;
  const [board, setBoard] = useState<CompRow[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const start = Date.parse(COMP.from), end = Date.parse(COMP.to);

  useEffect(() => {
    let alive = true;
    const load = () => fetchCompBoard(100).then((b) => alive && setBoard(b)).catch(() => alive && setBoard((b) => b ?? []));
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    const c = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(c);
    };
  }, []);

  const profiles = useProfiles(useMemo(() => (board ?? []).slice(0, 50).map((r) => r.creator), [board]));
  const leader = board?.[0] ?? null;
  const mine = me ? board?.find((r) => r.creator === me) ?? null : null;
  const started = now >= start;
  const pct = leader ? Math.min(100, (leader.volume / STEPS[STEPS.length - 1]) * 100) : 0;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-5 sm:py-10 pb-28 md:pb-12">
      <section className="rounded-3xl p-5 sm:p-8 text-[#1A130D]" style={{ background: "linear-gradient(120deg, #FF6B1A, #FFB020)" }}>
        <p className="text-[0.875rem] font-semibold">🏆 Creator competition · until Nov 25</p>
        <h1 className="font-display font-bold text-[2rem] sm:text-[3rem] leading-[1.05] tracking-tight mt-1">Win up to $100,000</h1>
        <p className="mt-2 max-w-[58ch] text-[0.9375rem] sm:text-[1rem]">
          Launch coins on sasa and bring your community. The creator whose coins get the most trading volume wins. You also earn 30% of your coins&apos; fees, and every trade counts for the airdrop.
        </p>
        <div className="grid grid-cols-3 gap-2 mt-5 max-w-lg">
          <Box label={started ? "Ends in" : "Starts in"} value={left(started ? end - now : start - now)} />
          <Box label="Leader's volume" value={leader ? money(leader.volume) : "$0"} />
          <Box label="Prize now" value={money(prizeFor(leader?.volume ?? 0))} />
        </div>
        <div className="mt-4 max-w-lg">
          <div className="h-2.5 rounded-full bg-[#1A130D]/15 overflow-hidden">
            <div className="h-full rounded-full bg-[#1A130D]" style={{ width: `${pct}%` }} />
          </div>
          <div className="grid grid-cols-5 gap-1 mt-2 text-[0.6875rem] leading-tight">
            {STEPS.map((v) => (
              <div key={v} className={"rounded-lg px-1.5 py-1 text-center " + ((leader?.volume ?? 0) >= v ? "bg-[#1A130D] text-white" : "bg-white/60")}>
                <div className="font-bold">{short(prizeFor(v))}</div>
                <div>at {short(v)}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <Link href="/race/launch/" className="h-11 px-5 rounded-xl bg-[#1A130D] text-white font-bold flex items-center">Launch a coin</Link>
          <Link href="/explore/" className="h-11 px-5 rounded-xl bg-white/80 font-bold flex items-center">Find sasa coins</Link>
        </div>
      </section>

      {mine && (
        <div className="mt-4 rounded-2xl border border-line bg-surface px-4 py-3 flex items-center justify-between">
          <span className="text-[0.875rem] text-ink-2">Your place</span>
          <span className="font-mono font-bold">#{fmt(mine.rank)} · {money(mine.volume)} · {fmt(mine.coins)} coin{mine.coins === 1 ? "" : "s"}</span>
        </div>
      )}

      <section className="mt-4 rounded-3xl border border-line bg-surface p-4 sm:p-5" aria-label="Leaderboard">
        <h2 className="font-display font-bold text-[1.125rem]">Leaderboard</h2>
        {board === null ? (
          <Skeleton className="h-48 mt-3" />
        ) : board.length === 0 ? (
          <p className="text-[0.875rem] text-ink-3 mt-3">{started ? "No coins launched yet. Launch the first one and take the top spot." : "The board opens when the competition starts."}</p>
        ) : (
          <>
            <div className="flex items-center gap-3 px-2 pt-3 pb-1 text-[0.6875rem] text-ink-3">
              <span className="w-8 text-center shrink-0">#</span>
              <span className="flex-1">Creator</span>
              <span className="w-14 text-right shrink-0">Coins</span>
              <span className="w-24 text-right shrink-0">Volume</span>
            </div>
            <ol>
              {board.slice(0, 50).map((r) => {
                const p = profiles.get(r.creator);
                const isMe = r.creator === me;
                return (
                  <li key={r.creator} className={"flex items-center gap-3 px-2 py-2 rounded-xl " + (isMe ? "bg-emerald-soft" : "")}>
                    <span className="w-8 text-center font-mono text-[0.8125rem] text-ink-3 shrink-0">{r.rank === 1 ? "🏆" : r.rank}</span>
                    <Link href={p ? profileHref(p) : `/u/${r.creator}/`} className="flex items-center gap-2.5 min-w-0 flex-1">
                      {p ? <Avatar profile={p} size={28} /> : <span className="w-[28px] h-[28px] rounded-full bg-line shrink-0" />}
                      <span className="font-semibold text-[0.875rem] truncate">{isMe ? "You" : p ? displayName(p) : `${r.creator.slice(0, 6)}…${r.creator.slice(-4)}`}</span>
                    </Link>
                    <span className="w-14 text-right font-mono text-[0.8125rem] tabular-nums shrink-0">{fmt(r.coins)}</span>
                    <span className="w-24 text-right font-mono font-bold text-[0.8125rem] tabular-nums shrink-0">{money(r.volume)}</span>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </section>

      <section className="mt-4 rounded-3xl border border-line bg-surface p-4 sm:p-5 text-[0.875rem] text-ink-2">
        <h2 className="font-display font-bold text-[1.125rem] text-ink">Rules</h2>
        <ul className="mt-2 flex flex-col gap-1.5 list-disc pl-5">
          <li>
            Runs from {new Date(start).toUTCString().slice(5, 16)} to {new Date(end).toUTCString().slice(5, 16)} (UTC).
          </li>
          <li>Anyone who launches a coin on sasa during the competition takes part. No sign-up, and no limit on how many coins you launch.</li>
          <li>Your score is the trading volume of all the coins you launched, added together: buys and sells by other people, on every chain, through any app. Your own trades and launch buys don&apos;t count. Coins launched on Solana aren&apos;t part of this competition.</li>
          <li>Only first place wins. The prize is {(COMP.rate * 100).toFixed(2)}% of the winner&apos;s volume, up to {money(COMP.max)}. Below {money(COMP.min)} volume there is no prize.</li>
          <li>Paid in USDC on Base to the winning wallet within 7 days of the end.</li>
          <li>Team wallets can&apos;t win. Trades between linked wallets to fake volume, or any abuse, can be excluded. sasa&apos;s decision is final.</li>
          <li>Trading meme coins is risky. Only trade what you can afford to lose.</li>
        </ul>
      </section>
    </div>
  );
}

function Box({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-white/70 px-3 py-2.5 min-w-0">
      <div className="text-[0.6875rem] font-semibold truncate">{label}</div>
      <div className="font-display font-bold text-[1.0625rem] sm:text-[1.25rem] truncate">{value}</div>
    </div>
  );
}
