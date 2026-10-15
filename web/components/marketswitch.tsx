"use client";

/** Spot | Futures, on top of the Market and Futures pages. */
import Link from "next/link";

export function MarketSwitch({ at }: { at: "spot" | "futures" }) {
  const tabs = [
    { id: "spot", href: "/market/", label: "Spot" },
    { id: "futures", href: "/futures/", label: "Futures" },
  ] as const;
  return (
    <nav className="inline-flex bg-night rounded-full p-1" aria-label="Spot or futures">
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          aria-current={at === t.id ? "page" : undefined}
          className={"h-9 px-5 rounded-full text-[0.875rem] font-semibold flex items-center " + (at === t.id ? "bg-paper text-ink shadow-sm" : "text-ink-2 hover:text-ink")}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
