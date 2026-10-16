"use client";

/** Spot | Futures, on top of the Market and Futures pages. */
import Link from "next/link";

export function MarketSwitch({ at }: { at: "spot" | "futures" }) {
  const tabs = [
    { id: "spot", href: "/market/", label: "Spot" },
    { id: "futures", href: "/futures/", label: "Futures" },
  ] as const;
  return (
    <nav className="inline-flex rounded-2xl p-1 bg-surface border border-line shadow-sm" aria-label="Spot or futures">
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          aria-current={at === t.id ? "page" : undefined}
          className={
            "h-10 px-6 rounded-xl text-[0.9375rem] font-bold flex items-center transition-colors " +
            (at === t.id ? "bg-emerald text-on-accent shadow-sm" : "text-ink hover:bg-paper")
          }
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
