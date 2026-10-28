"use client";

/**
 * "Is it safe?": paste a coin's address, pick its chain, get a safety score and the reasons
 * (lib/evmscan.ts). ?n=<chain>&a=<address> runs it straight away (links, shares).
 */
import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SCAN_CHAINS, scanCoin, type ScanResult } from "@/lib/evmscan";

export default function Page() {
  return (
    <Suspense fallback={<div className="max-w-2xl mx-auto px-4 py-10"><div className="shimmer h-40 rounded-3xl" /></div>}>
      <Scan />
    </Suspense>
  );
}

const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;

function Scan() {
  const q = useSearchParams();
  const [chain, setChain] = useState(() => (SCAN_CHAINS.some((c) => c.id === q.get("n")) ? q.get("n")! : SCAN_CHAINS[0].id));
  const [addr, setAddr] = useState(() => q.get("a") ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanResult | null | undefined>(undefined);
  const [scanned, setScanned] = useState<{ chain: string; addr: string } | null>(null);

  const run = useCallback(async (c: string, a: string) => {
    const t = a.trim();
    if (!EVM.test(t)) return;
    setBusy(true);
    setResult(undefined);
    try {
      setResult(await scanCoin(c, t));
    } catch {
      setResult(null);
    } finally {
      setScanned({ chain: c, addr: t });
      setBusy(false);
      try {
        const u = new URL(window.location.href);
        u.searchParams.set("n", c);
        u.searchParams.set("a", t);
        window.history.replaceState(null, "", u.toString());
      } catch {}
    }
  }, []);

  // opened from a link: check it right away
  useEffect(() => {
    const a = q.get("a");
    if (a && EVM.test(a)) void run(chain, a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const t = addr.trim();
  const cur = SCAN_CHAINS.find((c) => c.id === chain)!;
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10 pb-28 md:pb-12">
      <h1 className="font-display font-bold text-[1.75rem] sm:text-[2.25rem] tracking-tight">🛡️ Is it safe?</h1>
      <p className="text-ink-2 mt-1.5 text-[0.9375rem]">Paste any coin&apos;s contract address. In seconds: can it be sold, can the owner print more, who holds it, is the liquidity locked. Free.</p>

      <div className="mt-5 flex flex-wrap gap-2" role="radiogroup" aria-label="Chain">
        {SCAN_CHAINS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={chain === c.id}
            onClick={() => setChain(c.id)}
            className={"h-9 px-3.5 rounded-xl border-[1.5px] text-[0.8125rem] font-semibold inline-flex items-center gap-1.5 " + (chain === c.id ? "border-ink bg-surface" : "border-line text-ink-2")}
          >
            <span className="w-2 h-2 rounded-full" style={{ background: c.color }} aria-hidden="true" />
            {c.label}
          </button>
        ))}
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(chain, t);
        }}
      >
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="0x… contract address"
          aria-label="Contract address"
          autoComplete="off"
          spellCheck={false}
          className="flex-1 min-w-0 h-12 px-4 rounded-2xl border border-line bg-paper font-mono text-[0.875rem] outline-none focus:border-ink-3"
        />
        <button type="submit" disabled={busy || !EVM.test(t)} className="h-12 px-5 rounded-2xl bg-emerald text-on-accent font-bold disabled:opacity-50">
          {busy ? "Checking…" : "Check"}
        </button>
      </form>
      {SOL.test(t) && !t.startsWith("0x") && (
        <p className="mt-2 text-[0.8125rem] text-ink-2">
          That&apos;s a Solana address.{" "}
          <Link href={`/x/?n=solana&a=${t}`} className="text-emerald font-semibold">
            Open it on sasa: its safety scan is on the coin page →
          </Link>
        </p>
      )}

      {busy && <div className="mt-6 shimmer h-48 rounded-3xl" aria-label="Checking" />}
      {!busy && result === null && scanned && (
        <p className="mt-6 rounded-2xl bg-warn-bg text-warn-ink px-4 py-3 text-[0.875rem]">
          We couldn&apos;t find a coin at this address on {SCAN_CHAINS.find((c) => c.id === scanned.chain)?.label}. Check the address and the chain.
        </p>
      )}
      {!busy && result && scanned && <Result r={result} chain={SCAN_CHAINS.find((c) => c.id === scanned.chain)?.label ?? cur.label} addr={scanned.addr} />}

      <p className="mt-8 text-[0.75rem] text-ink-3">
        Information, not advice. A clean check doesn&apos;t mean the price will go up, and new tricks appear all the time. Only put in what you can lose.
      </p>
    </div>
  );
}

function Result({ r, chain, addr }: { r: ScanResult; chain: string; addr: string }) {
  const tone =
    r.verdict === "clean"
      ? { box: "border-up/30 bg-up/[0.06]", pill: "bg-up/15 text-up", ring: "var(--color-up)", label: "✅ Looks clean" }
      : r.verdict === "careful"
        ? { box: "border-mint/30 bg-warn-bg/60", pill: "bg-warn-bg text-warn-ink", ring: "var(--color-mint)", label: "⚠️ Be careful" }
        : { box: "border-danger/30 bg-danger/[0.06]", pill: "bg-danger/15 text-danger", ring: "var(--color-danger)", label: "⛔ Trap" };
  const R = 2 * Math.PI * 26;
  const share = `https://x.com/intent/post?text=${encodeURIComponent(
    `${r.symbol ? `$${r.symbol}` : "This coin"} on ${chain}: ${tone.label.replace(/^\S+\s/, "")} (safety ${r.safety}/100) 🛡️\n\nchecked free on sasa`
  )}&url=${encodeURIComponent(typeof window !== "undefined" ? window.location.href : "https://sasapad.fun/scan/")}`;
  return (
    <section className={"mt-6 rounded-3xl border p-4 sm:p-6 " + tone.box}>
      <div className="flex items-center gap-4">
        <span className="relative w-16 h-16 shrink-0">
          <svg width="64" height="64" viewBox="0 0 64 64" className="-rotate-90" aria-hidden="true">
            <circle cx="32" cy="32" r="26" fill="none" stroke="var(--color-line)" strokeWidth="6" />
            <circle cx="32" cy="32" r="26" fill="none" stroke={tone.ring} strokeWidth="6" strokeLinecap="round" strokeDasharray={R} strokeDashoffset={R - (R * r.safety) / 100} />
          </svg>
          <span className="absolute inset-0 grid place-items-center font-display font-extrabold text-[1.25rem]">{r.safety}</span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-display font-bold text-[1.25rem] truncate">
            {r.name ?? "Coin"} {r.symbol && <span className="text-ink-3 font-semibold">${r.symbol}</span>}
          </div>
          <span className={"inline-block mt-1 text-[0.8125rem] font-bold px-2.5 py-0.5 rounded-full " + tone.pill}>{tone.label}</span>
          {r.why && <div className="text-[0.875rem] text-ink-2 mt-1">{r.why}</div>}
        </div>
      </div>
      <ul className="mt-4 grid gap-1.5">
        {r.checks.map((c) => (
          <li key={c.label} className="flex items-center gap-2.5 text-[0.875rem]">
            <span className={"w-5 h-5 rounded-md grid place-items-center text-[0.6875rem] font-black shrink-0 " + (c.pass ? "bg-up/15 text-up" : "bg-danger/20 text-danger")}>{c.pass ? "✓" : "!"}</span>
            {c.label}
          </li>
        ))}
      </ul>
      {r.info.length > 0 && <p className="mt-3 text-[0.8125rem] text-ink-3">{r.info.join(" · ")}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <a href={share} target="_blank" rel="noreferrer" className="h-10 px-4 rounded-xl bg-ink text-mist font-bold text-[0.875rem] inline-flex items-center">
          Share on X
        </a>
        <Link href={`/x/?n=${chain === "BNB Chain" ? "bsc" : chain.toLowerCase().startsWith("elysium") ? "elysium" : chain.toLowerCase() === "ethereum" ? "eth" : chain.toLowerCase()}&a=${addr.toLowerCase()}`} className="h-10 px-4 rounded-xl border border-line bg-paper font-semibold text-[0.875rem] inline-flex items-center">
          Open the coin on sasa →
        </Link>
      </div>
    </section>
  );
}
