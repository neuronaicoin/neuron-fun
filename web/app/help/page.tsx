"use client";

import { IS_TESTNET } from "@/lib/config";

import { useState } from "react";
import { sessionToken } from "@/lib/alerts";

const FAQ: { q: string; a: string }[] = [
  { q: "Does sasa have a token?", a: "No. sasa has no token and no airdrop. Any coin using the sasa or Sasapad name or logo, on any chain, is not made by us. We only announce news from @sasapadfun on X and t.me/sasapadfun on Telegram." },
  ...(IS_TESTNET
    ? [
        { q: "Is this real money?", a: "Not yet. sasa runs on testnets: the USDC here is free test money with no value. Tap your balance or “Deposit”, then “Get $100 free test USDC” to try everything." },
        { q: "How do I get test USDC?", a: "Tap “Deposit”, then “Get $100 free test USDC”. On a race page you can also get $100 of test USDC on that chain. Each faucet works once a day." },
      ]
    : [
        { q: "How do I add money?", a: "Tap “＋” next to your balance. Send USDC on the Base network to the address shown (or scan the QR code). Only USDC on Base: other coins or networks can be lost." },
        { q: "How do I take money out?", a: "Tap “↑” next to your balance (or “Withdraw”). Paste a Base address, choose the amount and confirm. On an exchange, pick USDC on the Base network." },
      ]),
  { q: "How does a launch race work?", a: "A new coin goes live on Base, BNB Chain, Robinhood Chain and Arc at the same time, with the same contract address. For five minutes anyone can buy on any chain. Then the chain with the most money wins: the other pools close, their money moves into the winner's pool (minus a 2% hand-over fee), everyone's coins move to the winning chain automatically, and that pool is locked forever." },
  { q: "Which chain should I buy on?", a: "During a race, any chain you like: buying on a chain helps it win. If your chain loses, you don't lose your coins: they are moved to the winning chain automatically. After the race the coin trades on the winning chain." },
  { q: "What are sasa's fees?", a: "Race coins: 2% per trade, of which 30% goes to the coin's creator (or to buybacks that burn the coin, if the creator chose that) and 70% to sasa. Right after launch the fee starts higher and falls to 2% within the first few minutes, to slow down sniper bots. When a race ends, the losing pools' money pays a 2% hand-over fee. Coins from other DEXs: 0.7% per trade. Deposits and withdrawals: no sasa fee." },
  { q: "Do I pay network fees?", a: "Yes, they are small (usually cents). Signed in with email or Google, they are paid in USDC from your balance, so you never need ETH or BNB. With your own wallet (like MetaMask) you pay them in the chain's own coin." },
  { q: "What does it cost to create a coin?", a: "A first buy on each chain of the race, in USDC (we recommend $5 or more per chain), plus a few cents of network fees per chain. The creator then earns 30% of every trading fee on the winning pool, forever." },
  { q: "Can the creator pull the money out?", a: "No. Nobody can: not the creator, not sasa. The winning pool is locked forever by the contracts. The creator can sell coins they bought, like anyone else, and their buys are labeled “Creator” in the trades list." },
  { q: "My trade says it failed but my balance changed.", a: "Sometimes the network confirms slowly. Refresh the page after a few seconds; your balance and trades will show the real result." },
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
              {message.trim().length > 0 && message.trim().length < 10 && (
                <span className="block mt-1 text-[0.75rem] text-ink-3">At least 10 characters ({10 - message.trim().length} more).</span>
              )}
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
