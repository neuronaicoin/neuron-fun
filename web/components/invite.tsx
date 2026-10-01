"use client";

/** Compact invite card: your points, your invite link with Copy, and a way to the full Points page. */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useMyTotal } from "@/lib/points";
import { copyText } from "./contract";
import { toast } from "./alerts";

export function InviteCard({ address, username }: { address: string; username: string | null }) {
  const total = useMyTotal(address);
  const [origin, setOrigin] = useState("https://sasapad.fun");
  useEffect(() => setOrigin(window.location.origin), []);
  const link = `${origin}/?ref=${username ?? address.toLowerCase()}`;
  const shown = link.replace(/^https?:\/\//, "");

  async function copy() {
    toast((await copyText(link)) ? "Invite link copied" : "Couldn't copy. Open Points to copy it from the box.");
  }

  return (
    <section className="rounded-3xl border border-line p-4 sm:p-5 bg-gradient-to-br from-emerald-soft to-surface" aria-label="Invite friends">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display font-bold text-[1.0625rem] sm:text-[1.125rem]">Invite friends, earn together</h2>
          <p className="text-[0.8125rem] text-ink-2 mt-1 leading-snug">
            They start with 100 points. You get 20% of their points and 25% of sasa&apos;s fees from their trades for a year.
          </p>
        </div>
        <Link
          href="/points/"
          className="h-9 px-3 rounded-xl border border-line bg-surface font-bold text-[0.8125rem] flex items-center gap-1 shrink-0 hover:border-emerald/60"
          title="Your points"
        >
          <span aria-hidden="true">⚡</span>
          <span className="font-mono tabular-nums">{total === null ? "…" : total.toLocaleString("en-US")}</span>
        </Link>
      </div>
      <div className="flex gap-2 mt-3">
        <span className="flex-1 min-w-0 h-11 rounded-xl border border-line bg-surface px-3 font-mono text-[0.75rem] sm:text-[0.8125rem] flex items-center">
          <span className="truncate select-all">{shown}</span>
        </span>
        <button type="button" onClick={() => void copy()} className="h-11 px-4 rounded-xl bg-emerald text-on-accent font-bold shrink-0 hover:bg-emerald-dark">
          Copy link
        </button>
      </div>
    </section>
  );
}
