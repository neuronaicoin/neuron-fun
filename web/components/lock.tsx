"use client";

import { timeLeft, useLocks, useNow } from "@/lib/lock";

/** "🔒 Dev locked · 3h 12m": shown while the creator's coins can't move. */
export function LockBadge({
  coinId,
  size = "md",
  onArt = false,
  className = "",
}: {
  coinId: string;
  size?: "sm" | "md";
  /** Sits on top of coin artwork: dark glass instead of green. */
  onArt?: boolean;
  className?: string;
}) {
  const locks = useLocks([coinId]);
  const now = useNow(size === "sm" ? 60_000 : 15_000);
  const until = locks.get(coinId);
  if (!until || until <= now) return null;
  const left = timeLeft(until, now);
  const at = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <span
      title={`The creator can't sell or move their coins until ${at}. Set at launch; nobody can lift it early.`}
      className={
        "inline-flex items-center gap-1 rounded-full font-semibold whitespace-nowrap " +
        (onArt ? "bg-black/60 text-white backdrop-blur-sm " : "bg-up/15 text-up ") +
        (size === "sm" ? "h-5 sm:h-6 px-1.5 sm:px-2 text-[0.625rem] sm:text-[0.6875rem]" : "h-7 px-2.5 text-[0.75rem]") +
        " " +
        className
      }
    >
      <svg width={size === "sm" ? 10 : 12} height={size === "sm" ? 10 : 12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      {size === "sm" ? `Dev locked` : `Dev locked · ${left}`}
    </span>
  );
}
