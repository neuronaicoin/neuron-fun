"use client";

/** Spot | Futures | Predict | Data, on top of the Market, Futures and Data pages. */
import Link from "next/link";

export function MarketSwitch({ at }: { at: "spot" | "futures" | "predict" | "data" }) {
  const tabs = [
    { id: "spot", href: "/market/", label: "Spot" },
    { id: "futures", href: "/futures/", label: "Futures" },
    { id: "predict", href: "/predict/", label: "Predict" },
    { id: "data", href: "/data/", label: "Data" },
  ] as const;
  return (
    <nav className="inline-flex rounded-2xl p-1 bg-surface border border-line shadow-sm" aria-label="Spot, futures or data">
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          aria-current={at === t.id ? "page" : undefined}
          className={
            "h-10 px-3 sm:px-6 rounded-xl text-[0.9375rem] font-bold flex items-center transition-colors " +
            (at === t.id ? "bg-emerald text-on-accent shadow-sm" : "text-ink hover:bg-paper")
          }
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
