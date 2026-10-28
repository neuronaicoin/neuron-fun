"use client";

/** Ways into the Airdrop page: a band at the top of Explore and a button in the top bar. */
import Link from "next/link";
import { useWallet } from "./wallet";

const ORANGE = "linear-gradient(90deg, #FF6B1A, #FFB020)";

export function AirdropBanner() {
  return (
    <div className="px-4 sm:px-6 pt-3 sm:pt-4">
      <Link
        href="/compete/"
        className="flex items-center gap-3 rounded-2xl px-3.5 py-3 sm:px-5 sm:py-3.5 text-[#1A130D] hover:opacity-95"
        style={{ background: ORANGE }}
      >
        <span className="text-[1.625rem] leading-none shrink-0" aria-hidden="true">🏆</span>
        <span className="min-w-0 flex-1">
          <span className="block font-display font-bold text-[0.9375rem] sm:text-[1.0625rem]">Win up to $100,000: launch a coin on sasa</span>
          <span className="block text-[0.8125rem] sm:text-[0.875rem] leading-snug">The creator whose coins trade the most by Nov 25 wins. Plus the airdrop.</span>
        </span>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </Link>
    </div>
  );
}

/** A slim live band under the airdrop one on Explore: the way into sasa Bot (phones have no menu link). */
export function BotBanner() {
  return (
    <div className="px-4 sm:px-6 pt-2">
      <Link href="/bot/" className="flex items-center gap-3 rounded-2xl px-3.5 py-2.5 sm:px-5 border border-line bg-surface hover:border-emerald/50 transition-colors">
        <span className="relative flex w-2.5 h-2.5 shrink-0" aria-hidden="true">
          <span className="absolute inset-0 rounded-full bg-up animate-ping opacity-60" />
          <span className="relative w-2.5 h-2.5 rounded-full bg-up" />
        </span>
        <span className="min-w-0 flex-1 text-[0.8125rem] sm:text-[0.875rem]">
          <b className="font-display">🤖 sasa Bot is live</b>
          <span className="text-ink-3"> · WHALES, traps and trends, as they happen</span>
        </span>
        <span className="text-[0.75rem] font-extrabold px-1.5 py-0.5 rounded bg-emerald text-on-accent shrink-0">NEW</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-ink-3" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </Link>
    </div>
  );
}

/** Top-bar button on phones and tablets (computers have "Airdrop" in the menu). Logged in, the
 * bar is fuller, so small phones get just the parachute. */
export function AirdropButton() {
  const { address, hintAddress } = useWallet();
  // a returning visitor counts as logged in while the login is restored (no jump in the bar)
  const inn = !!(address ?? hintAddress);
  return (
    <Link
      href="/points/"
      title="Airdrop"
      className="lg:hidden h-10 px-2.5 rounded-xl flex items-center gap-1 text-white font-bold text-[0.875rem] shrink-0"
      style={{ background: "#FF6B1A" }}
    >
      <span aria-hidden="true">🪂</span>
      <span className={inn ? "hidden sm:inline" : "hidden min-[380px]:inline"}>Airdrop</span>
    </Link>
  );
}
