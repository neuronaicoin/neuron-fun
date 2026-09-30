"use client";

import { useState } from "react";
import { sessionToken } from "@/lib/alerts";

const FAQ: { q: string; a: string }[] = [
  { q: "Is this real money?", a: "Not yet. sasa runs on testnet: the USDC here is free test money with no value. Tap “Get $100” to try everything for free." },
  { q: "How do I get test USDC?", a: "Tap your balance or “Deposit”, then “Get $100”. You can do it once a day on each chain." },
  { q: "Do I need to pick a chain?", a: "No. sasa picks the best price for you when you buy, and sells where you hold. You can still change it with “change” in the trade box." },
  { q: "My trade says it failed but my balance changed.", a: "Sometimes the network confirms slowly. Refresh the page after a few seconds; your balance and trades will show the real result." },
  { q: "What does “graduation” mean?", a: "When a coin raises its target across all chains, it moves to a trading pool with liquidity locked forever. The chain that raised the most wins; the others close and holders there can always sell." },
  { q: "What is a creator lock?", a: "A creator can lock their own coins for 1 or 24 hours at launch. Nobody can lift it early. Locked coins get a “Dev locked” badge." },
  { q: "How do invite rewards work?", a: "Share your invite link from the Points page. Friends start with 100 points, and you earn points plus a share of sasa’s fees from their trades, paid daily." },
  { q: "Do I pay network fees?", a: "Signed in with email: no, sasa pays them. With your own wallet (like MetaMask) you need a little of the chain’s coin for fees." },
];

export default function HelpPage() {
  const [open, setOpen] = useState<number | null>(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [trap, setTrap] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<number | null>(null);
  const [error, setError] = useState("");
  const ready = name.trim().length >= 2 && /\S+@\S+\.\S+/.test(email.trim()) && message.trim().length >= 10;

  async function send() {
    setBusy(true);
    setError("");
    try {
      const token = sessionToken();
      const r = await fetch("/api/help", {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ name, email, message, website: trap, page: document.referrer || "" }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; id?: number; error?: string };
      if (!r.ok) throw new Error(j.error ?? "Couldn't send it. Try again.");
      setSent(j.id ?? 0);
      setMessage("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send it. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded-2xl border border-line bg-paper px-4 text-[1rem] text-ink outline-none focus:border-emerald";
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-10 pb-28 md:pb-12">
      <h1 className="font-display font-bold text-[1.75rem] sm:text-[2.25rem]">How can we help?</h1>
      <p className="text-ink-2 mt-1">Quick answers first. Still stuck? Write to us below and we’ll reply by email.</p>

      <section className="mt-6 rounded-3xl border border-line bg-surface divide-y divide-line">
        {FAQ.map((f, i) => (
          <div key={f.q}>
            <button
              type="button"
              onClick={() => setOpen(open === i ? null : i)}
              aria-expanded={open === i}
              className="w-full flex items-center justify-between gap-3 text-left px-4 sm:px-5 py-4 font-semibold text-[0.9375rem]"
            >
              {f.q}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" className={"shrink-0 text-ink-3 transition-transform " + (open === i ? "rotate-180" : "")}>
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            {open === i && <p className="px-4 sm:px-5 pb-4 -mt-1 text-[0.875rem] text-ink-2 leading-relaxed">{f.a}</p>}
          </div>
        ))}
      </section>

      <section className="mt-6 rounded-3xl border border-line bg-surface p-4 sm:p-6" id="contact">
        <h2 className="font-display font-semibold text-[1.25rem]">Contact us</h2>
        {sent !== null ? (
          <div className="mt-3 rounded-2xl bg-emerald-soft border border-emerald/40 p-4" role="status">
            <p className="font-semibold">Got it{sent ? ` (#${sent})` : ""}. We’ll reply to {email} soon.</p>
            <button type="button" onClick={() => setSent(null)} className="mt-2 text-[0.875rem] font-semibold text-emerald">
              Send another message
            </button>
          </div>
        ) : (
          <div className="mt-3 grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1">
                <span className="text-[0.8125rem] text-ink-3">Your name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" className={input + " h-12"} />
              </label>
              <label className="grid gap-1">
                <span className="text-[0.8125rem] text-ink-3">Email (we reply here)</span>
                <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" inputMode="email" autoComplete="email" maxLength={200} className={input + " h-12"} />
              </label>
            </div>
            <label className="grid gap-1">
              <span className="text-[0.8125rem] text-ink-3">How can we help?</span>
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} maxLength={4000} className={input + " py-3 resize-y"} placeholder="Tell us what happened, and the coin or page if it helps." />
            </label>
            {/* Only bots fill this in. */}
            <input value={trap} onChange={(e) => setTrap(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" name="website" />
            {error && (
              <p role="alert" className="text-danger text-[0.875rem]">
                {error}
              </p>
            )}
            <button type="button" disabled={!ready || busy} onClick={() => void send()} className="h-13 rounded-2xl bg-emerald text-on-accent font-bold disabled:opacity-40">
              {busy ? "Sending…" : "Send"}
            </button>
            <p className="text-[0.75rem] text-ink-3">We never ask for your password, keys or recovery phrase. Only official site: sasapad.fun.</p>
          </div>
        )}
      </section>
    </div>
  );
}
