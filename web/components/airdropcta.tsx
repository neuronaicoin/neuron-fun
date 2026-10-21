"use client";

/** Ways into the Airdrop page: a band at the top of Explore and a button in the top bar. */
import Link from "next/link";
import { useWallet } from "./wallet";

const ORANGE = "linear-gradient(90deg, #FF6B1A, #FFB020)";

export function AirdropBanner() {
  return (
    <div className="px-4 sm:px-6 pt-3 sm:pt-4">
      <Link
        href="/points/"
        className="flex items-center gap-3 rounded-2xl px-3.5 py-3 sm:px-5 sm:py-3.5 text-[#1A130D] hover:opacity-95"
        style={{ background: ORANGE }}
      >
        <span className="text-[1.625rem] leading-none shrink-0" aria-hidden="true">🪂</span>
        <span className="min-w-0 flex-1">
          <span className="block font-display font-bold text-[0.9375rem] sm:text-[1.0625rem]">Airdrop is live</span>
          <span className="block text-[0.8125rem] sm:text-[0.875rem] leading-snug">Create coins and trade. The more you do, the bigger it gets.</span>
        </span>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
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
