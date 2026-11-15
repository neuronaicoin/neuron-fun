"use client";

/**
 * The 60% creator program (rewards/creator.mjs): a coin launched on sasa that holds a $10K market
 * cap for an hour pays its creator 60% of every trade's fee from then on (sasa keeps 40%), for as
 * long as it stays above. Paid in USDC to the creator's sasa account once a day.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { db } from "@/lib/data";

export const BONUS = { mc: "$10K", hold: "1 hour", share: "60%" } as const;
const CHAINS_TEXT = "Solana, Base, BNB, Robinhood and Arc";

/** On the create page, right above the form: what the creator gets. */
export function CreatorBonusNote() {
  return (
    <div className="rounded-2xl border border-emerald/50 bg-emerald-soft px-4 py-3 flex items-start gap-3 min-w-0">
      <span className="text-[1.375rem] leading-none mt-0.5" aria-hidden="true">💸</span>
      <div className="min-w-0">
        <div className="font-display font-extrabold text-[1rem] sm:text-[1.0625rem] leading-snug">
          Hit {BONUS.mc} market cap, keep it {BONUS.hold}: <span className="text-emerald-dark">{BONUS.share} of every trade&apos;s fee is yours</span>
        </div>
        <p className="text-[0.8125rem] text-ink-2 mt-1 leading-snug">
          As long as your coin stays above {BONUS.mc}, you get {BONUS.share} of the trading fees (sasa keeps 40%). Paid in USDC to your account every day. {CHAINS_TEXT}.
        </p>
      </div>
    </div>
  );
}

/** A band for Explore and the home page: the offer and a way to the create page. */
export function CreatorBonusBanner() {
  return (
    <Link
      href="/race/launch/"
      className="group relative overflow-hidden rounded-2xl px-4 py-3 sm:px-5 sm:py-3.5 flex items-center gap-3 min-w-0 text-white"
      style={{ background: "linear-gradient(100deg,#0d7a52 0%,#12a36b 55%,#f26b1d 130%)" }}
    >
      <span className="text-[1.5rem] sm:text-[1.75rem] leading-none shrink-0" aria-hidden="true">💸</span>
      <span className="min-w-0 flex-1">
        <span className="block font-display font-extrabold text-[0.9375rem] sm:text-[1.125rem] leading-tight">
          Launch a coin. Pass {BONUS.mc}. Earn {BONUS.share} of EVERY trade.
        </span>
        <span className="block text-[0.75rem] sm:text-[0.8125rem] text-white/85 leading-snug mt-0.5">
          Keep {BONUS.mc} market cap for {BONUS.hold} and {BONUS.share} of the trading fees go to you, paid daily in USDC.
        </span>
      </span>
      <span className="shrink-0 h-9 px-3.5 rounded-xl bg-white text-[#0d7a52] font-bold text-[0.8125rem] sm:text-[0.875rem] grid place-items-center group-hover:opacity-90">
        Launch
      </span>
    </Link>
  );
}

/** On the Earn page: what the creator bonus has paid this person so far. */
export function CreatorBonusCard({ address }: { address: string | null | undefined }) {
  const [s, setS] = useState<{ earned: number; paid: number; pending: number; coins: number } | null>(null);
  useEffect(() => {
    if (!address) return setS(null);
    let alive = true;
    db.rpc("creator_bonus_summary", { p_owner: address.toLowerCase() }).then(({ data, error }) => {
      if (!alive || error) return;
      const r = ((data ?? []) as Record<string, unknown>[])[0] ?? {};
      setS({ earned: Number(r.earned) / 1e6 || 0, paid: Number(r.paid) / 1e6 || 0, pending: Number(r.pending) / 1e6 || 0, coins: Number(r.coins) || 0 });
    });
    return () => {
      alive = false;
    };
  }, [address]);
  const usd = (v: number) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <section className="rounded-xl border border-line p-4 sm:p-5 bg-surface" aria-label="Creator bonus">
      <h2 className="font-display font-bold text-[1.125rem]">Your coins: {BONUS.share} of the fees</h2>
      <p className="text-[0.875rem] text-ink-2 mt-1">
        A coin you launch that keeps {BONUS.mc} market cap for {BONUS.hold} pays you <b className="text-ink">{BONUS.share} of every trade&apos;s fee</b> while it stays above, in USDC every day.
      </p>
      {address ? (
        <div className="grid grid-cols-2 gap-2 mt-3 text-center">
          <div className="rounded-xl bg-paper border border-line px-2 py-2.5">
            <div className="font-display font-bold text-[1.0625rem]">{s ? usd(s.earned) : "…"}</div>
            <div className="text-[0.6875rem] text-ink-3">earned from {s?.coins ?? 0} {s?.coins === 1 ? "coin" : "coins"}</div>
          </div>
          <div className="rounded-xl bg-paper border border-line px-2 py-2.5">
            <div className="font-display font-bold text-[1.0625rem]">{s ? usd(s.pending) : "…"}</div>
            <div className="text-[0.6875rem] text-ink-3">on its way (daily, from $0.50)</div>
          </div>
        </div>
      ) : null}
      <Link href="/race/launch/" className="mt-3 w-full h-11 rounded-xl bg-emerald text-on-accent font-bold flex items-center justify-center">
        Launch a coin
      </Link>
    </section>
  );
}
