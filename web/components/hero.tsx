"use client";

/**
 * The first screen of sasapad.fun: what sasa is in one line, two big ways in (launch a coin, see
 * what the WHALES buy) and a live box from sasa Bot (/api/bot/live) so the page is never still.
 * The contest, Elysium and sasa Bot bands sit under it as one slim row.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { compactUsd } from "@/lib/format";
import { V6 } from "@/lib/config";
import { RACE_CHAINS } from "@/lib/race";
import { solanaFor } from "@/lib/solana";
import { ELYSIUM, ELYSIUM_LISTED } from "@/lib/elysium";
import { timeAgo } from "./coins";
import { useWallet } from "./wallet";

type Buy = { id: number; at: string; wallet: string; mint: string; symbol: string | null; usd: number; mc: number; coins: number; runners: number; now_mc: number | null };
type Scan = { mint: string; symbol: string | null; at: string; score: number | null; passed: boolean; why: string | null };
type Theme = { theme: string; n1: number; prev: number };
type Live = { scanned: number; smart: number; buys: Buy[]; scans: Scan[]; trends: Theme[]; at: string };

type Row = { key: string; badge: string; text: string; sub: string; right: string; tone: "up" | "dn" | "hot" };

const short = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

function rowsOf(d: Live): Row[] {
  const skew = Date.parse(d.at) - Date.now();
  const ago = (iso: string) => timeAgo(new Date(Date.parse(iso) - (Number.isFinite(skew) ? skew : 0)).toISOString());
  const out: Row[] = [];
  for (const b of d.buys.slice(0, 2)) {
    const ch = b.now_mc && b.mc ? ((b.now_mc - b.mc) / b.mc) * 100 : null;
    out.push({
      key: `b${b.id}`,
      badge: b.runners >= 2 ? `${b.runners}/${b.coins} RAN 3x` : "WHALE",
      text: `bought ${compactUsd(b.usd)} of $${b.symbol || short(b.mint)}`,
      sub: `${short(b.wallet)} · ${ago(b.at)}`,
      right: ch === null ? "new" : `${ch >= 0 ? "+" : ""}${Math.round(ch)}%`,
      tone: ch !== null && ch < 0 ? "dn" : "up",
    });
  }
  const trap = d.scans.find((s) => !s.passed && s.why);
  if (trap)
    out.push({ key: `t${trap.mint}`, badge: "TRAP", text: `$${trap.symbol || short(trap.mint)} flagged`, sub: `${trap.why} · ${ago(trap.at)}`, right: "blocked", tone: "dn" });
  const t = d.trends.find((x) => x.prev > 0 && x.n1 > x.prev) ?? d.trends[0];
  if (t) {
    const up = t.prev > 0 ? Math.round(((t.n1 - t.prev) / t.prev) * 100) : null;
    out.push({ key: `h${t.theme}`, badge: "TREND", text: `${t.theme.charAt(0).toUpperCase() + t.theme.slice(1)}${up !== null ? ` +${up}% this hour` : " is taking off"}`, sub: `${t.n1} coins in the last hour`, right: "hot", tone: "hot" });
  }
  return out;
}

function LiveBox() {
  const [d, setD] = useState<Live | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/bot/live", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<Live>) : null))
        .then((j) => alive && j && setD(j))
        .catch(() => {});
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 8_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const rows = d ? rowsOf(d) : [];
  return (
    <Link href="/bot/" className="block rounded-[22px] bg-[#0f0b08] text-[#fff4ec] p-3.5 sm:p-4 hover:brightness-110 transition">
      <span className="flex justify-between text-[0.6875rem] font-extrabold tracking-[0.08em] text-[#a8978a]">
        <span>LIVE · RIGHT NOW</span>
        <span className="flex items-center gap-1.5 text-up">
          <span className="relative flex w-2 h-2">
            <span className="absolute inset-0 rounded-full bg-up animate-ping opacity-60" />
            <span className="relative w-2 h-2 rounded-full bg-up" />
          </span>
          LIVE
        </span>
      </span>
      <span className="mt-2.5 grid gap-2">
        {rows.length === 0 &&
          [0, 1, 2].map((i) => <span key={i} className="block h-[54px] rounded-[14px] bg-[#1b1410] border border-[#2e231a] animate-pulse" />)}
        {rows.map((r) => (
          <span key={r.key} className="flex items-center gap-2.5 rounded-[14px] bg-[#1b1410] border border-[#2e231a] px-3 py-2.5 min-w-0">
            <span className="text-[0.625rem] font-black px-1.5 py-0.5 rounded-md bg-[#3a2414] text-[#ffb27a] shrink-0">{r.badge}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[0.875rem] truncate">{r.text}</span>
              <span className="block text-[0.75rem] text-[#a8978a] truncate">{r.sub}</span>
            </span>
            <span className={"text-[0.8125rem] font-extrabold shrink-0 " + (r.tone === "dn" ? "text-danger" : "text-up")}>{r.right}</span>
          </span>
        ))}
      </span>
      {d && (
        <span className="block mt-2.5 text-[0.75rem] text-[#a8978a]">
          {d.smart.toLocaleString("en-US")} wallets followed · {d.scanned.toLocaleString("en-US")} coins scanned in 24h →
        </span>
      )}
    </Link>
  );
}

export function Hero() {
  const { address } = useWallet();
  const chains = [
    ...(solanaFor(address) ? ["Solana"] : []),
    ...RACE_CHAINS.map((c) => c.short),
    ...(ELYSIUM_LISTED ? [ELYSIUM.testnet ? "Elysium · Nov 9" : "Elysium"] : []),
  ].filter((c, i, a) => a.indexOf(c) === i);
  return (
    <div className="px-4 sm:px-6 pt-3 sm:pt-5">
      <div
        className="rounded-[28px] border border-[#f3dccb] dark:border-line p-5 sm:p-10 grid gap-6 lg:grid-cols-[1.2fr_1fr] lg:items-center"
        style={{ background: "radial-gradient(120% 140% at 100% 0%, rgba(255,107,26,.22) 0%, rgba(255,107,26,.06) 45%, transparent 100%)" }}
      >
        <div>
          <h1 className="font-display font-black text-[2.125rem] sm:text-[3.25rem] leading-[1.05] tracking-tight">
            Launch a coin in <span className="text-[#FF6B1A]">one tap</span>.<br />
            Trade what the <span className="text-[#FF6B1A]">WHALES</span> buy.
          </h1>
          <p className="mt-3 text-ink-2 text-[1rem] sm:text-[1.0625rem] leading-relaxed max-w-xl">
            No wallet needed: log in with email, pay with dollars. Check any coin for traps before you buy.
          </p>
          <div className="flex flex-wrap gap-1.5 mt-3.5">
            {chains.map((c) => (
              <span key={c} className="text-[0.75rem] font-bold px-2.5 py-1 rounded-full bg-surface border border-line">
                {c}
              </span>
            ))}
          </div>
          <div className="grid sm:grid-cols-[auto_auto] sm:justify-start gap-2.5 mt-5">
            <Link
              href={V6 ? "/create/" : "/race/launch/"}
              className="h-14 px-7 rounded-2xl bg-[#FF6B1A] text-white font-display font-extrabold text-[1.0625rem] grid place-items-center shadow-[0_8px_24px_rgba(255,107,26,.35)] hover:brightness-105"
            >
              🚀 Launch a coin
            </Link>
            <Link href="/bot/" className="h-14 px-7 rounded-2xl bg-ink text-mist font-display font-extrabold text-[1.0625rem] grid place-items-center hover:opacity-90">
              🐋 See what WHALES buy
            </Link>
          </div>
        </div>
        <LiveBox />
      </div>
    </div>
  );
}

/** The contest, Elysium and sasa Bot as one slim row under the hero. */
export function HeroStrip() {
  const pill = "min-w-0 flex-1 rounded-2xl px-3.5 py-3 text-[0.8125rem] font-bold truncate hover:brightness-105";
  return (
    <div className="px-4 sm:px-6 pt-3 flex flex-col sm:flex-row gap-2">
      <Link href="/compete/" className={pill + " text-[#1A130D]"} style={{ background: "linear-gradient(90deg,#FF6B1A,#FFB020)" }}>
        🏆 Win up to $100,000 · launch a coin
      </Link>
      {ELYSIUM_LISTED && (
        <Link href="/elysium/" className={pill} style={{ background: "#0f3b3a", color: "#e8f6fa" }}>
          {ELYSIUM.testnet ? "🧪 Elysium testnet: free airdrop points" : "🔥 Elysium is live: 3x points this week"}
        </Link>
      )}
      <Link href="/scan/" className={pill + " bg-surface border border-line"}>
        🛡️ Is it safe? Check any coin
      </Link>
    </div>
  );
}
