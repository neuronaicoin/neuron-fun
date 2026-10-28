"use client";

/**
 * sasa Bot's safety scan on a Solana coin's page (edge/bot-api.js /api/bot/scan). Shown only for
 * coins the bot scanned when they launched; nothing at all for the others.
 */
import Link from "next/link";
import { useEffect, useState } from "react";

type Scan = {
  safety: number;
  verdict: "clean" | "careful" | "trap";
  why: string | null;
  checks: { label: string; pass: boolean }[];
};

export function BotSafety({ mint }: { mint: string }) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch(`/api/bot/scan?m=${encodeURIComponent(mint)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ scan: Scan | null }>) : { scan: null }))
      .then((j) => alive && setScan(j.scan ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mint]);
  if (!scan) return null;
  const bad = scan.checks.filter((c) => !c.pass);
  const tone =
    scan.verdict === "clean"
      ? { box: "border-up/30 bg-up/[0.06]", pill: "bg-up/15 text-up", ring: "var(--color-up)", label: "✅ Looks clean" }
      : scan.verdict === "careful"
        ? { box: "border-mint/30 bg-warn-bg/60", pill: "bg-warn-bg text-warn-ink", ring: "var(--color-mint)", label: "⚠️ Be careful" }
        : { box: "border-danger/30 bg-danger/[0.06]", pill: "bg-danger/15 text-danger", ring: "var(--color-danger)", label: "⛔ Trap caught" };
  const R = 2 * Math.PI * 20;
  return (
    <section className={"rounded-3xl border p-4 sm:p-5 " + tone.box}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full flex items-center gap-3.5 text-left">
        <span className="relative w-12 h-12 shrink-0">
          <svg width="48" height="48" viewBox="0 0 48 48" className="-rotate-90" aria-hidden="true">
            <circle cx="24" cy="24" r="20" fill="none" stroke="var(--color-line)" strokeWidth="5" />
            <circle cx="24" cy="24" r="20" fill="none" stroke={tone.ring} strokeWidth="5" strokeLinecap="round" strokeDasharray={R} strokeDashoffset={R - (R * scan.safety) / 100} />
          </svg>
          <span className="absolute inset-0 grid place-items-center font-display font-extrabold text-[0.9375rem]">{scan.safety}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 flex-wrap">
            <span className="font-display font-bold text-[1.0625rem]">🛡️ sasa Bot safety</span>
            <span className={"text-[0.75rem] font-bold px-2.5 py-0.5 rounded-full " + tone.pill}>{tone.label}</span>
          </span>
          <span className="block text-[0.8125rem] text-ink-2 mt-0.5">
            {bad.length === 0 ? `Passed all ${scan.checks.length} checks at launch` : scan.why ?? `${bad.length} of ${scan.checks.length} checks failed at launch`}
          </span>
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" className={"text-ink-3 shrink-0 transition-transform " + (open ? "rotate-180" : "")}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="mt-3">
          <ul className="grid sm:grid-cols-2 gap-1.5">
            {scan.checks.map((c) => (
              <li key={c.label} className="flex items-center gap-2 text-[0.8125rem]">
                <span className={"w-5 h-5 rounded-md grid place-items-center text-[0.6875rem] font-black shrink-0 " + (c.pass ? "bg-up/15 text-up" : "bg-danger/20 text-danger")}>{c.pass ? "✓" : "!"}</span>
                {c.label}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[0.75rem] text-ink-3">
            Checked in the coin&apos;s first seconds. A clean scan doesn&apos;t mean the price will go up.{" "}
            <Link href="/bot/" className="text-emerald font-semibold">
              See sasa Bot live →
            </Link>
          </p>
        </div>
      )}
    </section>
  );
}
