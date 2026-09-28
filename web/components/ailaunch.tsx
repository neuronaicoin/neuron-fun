"use client";

/**
 * "Your coin, designed in seconds": one sentence in, three ideas out (name,
 * ticker, story and an AI-drawn logo). Tapping one fills the launch form.
 */
import { useRef, useState } from "react";
import { useWallet } from "./wallet";
import { ConnectButton } from "./chrome";
import { aiIdeas, aiLogo, IDEA_SPARKS, type AiIdea } from "@/lib/ai";
import { fileToLogo } from "@/lib/image";
import { friendlyError } from "@/lib/format";

type Card = AiIdea & { logo: string | null; logoState: "loading" | "done" | "failed" };
export type AiPick = { name: string; symbol: string; description: string; logo: string | null };

export function AiLaunch({ onPick }: { onPick: (p: AiPick) => Promise<void> | void }) {
  const { address, signMessage } = useWallet();
  const [idea, setIdea] = useState("");
  const [spark, setSpark] = useState<string | null>(null);
  const [cards, setCards] = useState<Card[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState<number | null>(null);
  const run = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);

  async function drawLogo(i: number, art: string, id: number) {
    try {
      const img = await aiLogo(signMessage, art);
      if (run.current !== id) return;
      setCards((c) => c && c.map((x, k) => (k === i ? { ...x, logo: img, logoState: "done" } : x)));
    } catch {
      if (run.current !== id) return;
      setCards((c) => c && c.map((x, k) => (k === i ? { ...x, logoState: "failed" } : x)));
    }
  }

  async function make() {
    const text = (idea.trim() || "A cat that surfs the waves of the ocean").slice(0, 200);
    const id = ++run.current;
    setBusy(true);
    setError("");
    setChosen(null);
    setCards(null);
    try {
      const list = await aiIdeas(signMessage, text);
      if (run.current !== id) return;
      const next: Card[] = list.map((x) => ({ ...x, logo: null, logoState: "loading" }));
      setCards(next);
      next.forEach((x, i) => void drawLogo(i, x.art, id));
    } catch (e) {
      if (run.current === id) setError(friendlyError(e));
    } finally {
      if (run.current === id) setBusy(false);
    }
  }

  async function pick(i: number) {
    const c = cards?.[i];
    if (!c) return;
    setChosen(i);
    let logo: string | null = null;
    if (c.logo) {
      try {
        // Same size and format as an uploaded picture (a small JPEG stored with the coin).
        const blob = await (await fetch(c.logo)).blob();
        logo = await fileToLogo(new File([blob], "logo.jpg", { type: blob.type || "image/jpeg" }));
      } catch {
        logo = null;
      }
    }
    await onPick({ name: c.name, symbol: c.symbol, description: c.description, logo });
  }

  return (
    <section aria-label="Launch with AI" className="ai-glow relative rounded-3xl bg-surface p-4 sm:p-6">
      <span className="inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-[0.75rem] font-bold text-white bg-gradient-to-r from-emerald to-[#f472b6]">✨ AI</span>
      <h2 className="font-display font-bold text-[1.25rem] sm:text-[1.375rem] tracking-tight mt-2.5">Your coin, designed in seconds</h2>
      <p className="text-ink-2 text-[0.875rem] sm:text-[0.9375rem] mt-1 max-w-[52ch]">
        Tell us your idea in one sentence. Our AI creates the name, ticker, story and logo for you. Pick the one you love and launch.
      </p>

      <textarea
        ref={input}
        value={idea}
        onChange={(e) => setIdea(e.target.value.slice(0, 200))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && address && !busy) {
            e.preventDefault();
            void make();
          }
        }}
        rows={2}
        maxLength={200}
        placeholder="e.g. A cat that surfs the waves of the ocean"
        aria-label="Describe your coin idea"
        className="mt-3 w-full rounded-2xl border border-line bg-paper px-4 py-3 text-[1rem] outline-none focus:border-emerald resize-y min-h-[4.5rem]"
      />

      <p className="text-[0.75rem] font-semibold text-ink-3 mt-3">Need a spark? Try one:</p>
      <div className="mt-2 flex gap-1.5 overflow-x-auto no-scrollbar -mr-4 pr-4 sm:mr-0 sm:pr-0 sm:flex-wrap">
        {IDEA_SPARKS.map(([label, text]) => (
          <button
            key={label}
            type="button"
            aria-pressed={spark === label}
            onClick={() => {
              setSpark(label);
              setIdea(text);
              input.current?.focus();
            }}
            className={
              "h-8 px-3 shrink-0 rounded-full border text-[0.8125rem] font-semibold whitespace-nowrap " +
              (spark === label ? "border-emerald text-ink bg-emerald-soft" : "border-line bg-paper text-ink-2 hover:border-emerald/60")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {address ? (
        <button
          type="button"
          onClick={() => void make()}
          disabled={busy}
          className="mt-4 w-full h-12 sm:h-13 rounded-2xl bg-gradient-to-r from-emerald to-[#ff8a3d] text-white font-bold text-[1rem] flex items-center justify-center gap-2 disabled:opacity-60"
        >
          {busy ? "✨ Thinking…" : cards ? "↻ New ideas" : "✨ Make it for me"}
        </button>
      ) : (
        <div className="mt-4">
          <ConnectButton full />
        </div>
      )}
      <p className="text-center text-[0.75rem] text-ink-3 mt-2">Free · 10 AI ideas a day per account</p>

      {error && (
        <p role="alert" className="mt-3 text-[0.875rem] rounded-xl bg-warn-bg text-warn-ink px-3 py-2">
          {error}
        </p>
      )}

      {(busy || cards) && (
        <div className="mt-4 grid gap-2.5 sm:grid-cols-3" role="radiogroup" aria-label="AI suggestions" aria-busy={busy}>
          {busy &&
            [0, 1, 2].map((i) => <div key={i} className="shimmer rounded-2xl h-24 sm:h-60" />)}
          {!busy &&
            cards?.map((c, i) => (
              <button
                key={c.symbol + i}
                type="button"
                role="radio"
                aria-checked={chosen === i}
                onClick={() => void pick(i)}
                className={
                  "text-left rounded-2xl border-2 p-2.5 flex sm:flex-col gap-3 items-center sm:items-stretch " +
                  (chosen === i ? "border-emerald bg-emerald-soft" : "border-line bg-surface hover:border-emerald/60")
                }
              >
                <span className="relative w-20 sm:w-full aspect-square shrink-0 rounded-xl overflow-hidden bg-night">
                  {c.logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.logo} alt="" className="absolute inset-0 w-full h-full object-cover" />
                  ) : c.logoState === "loading" ? (
                    <span className="shimmer absolute inset-0" />
                  ) : (
                    <span className="absolute inset-0 flex items-center justify-center font-display font-bold text-[1.5rem] text-white/90 bg-gradient-to-br from-emerald to-[#7c3aed]">
                      {c.symbol.slice(0, 2)}
                    </span>
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block font-bold text-[0.9375rem] truncate">{c.name}</span>
                  <span className="block font-mono text-[0.75rem] text-ink-3">${c.symbol}</span>
                  <span className="block text-[0.75rem] text-ink-2 mt-1 leading-snug line-clamp-3">{c.description}</span>
                </span>
              </button>
            ))}
        </div>
      )}
      {cards && !busy && (
        <p className="text-[0.75rem] text-ink-3 mt-2">
          {chosen === null ? "Tap one to fill the form below. You can still change anything." : "Filled in below. Change anything you like, then launch."}
        </p>
      )}
    </section>
  );
}
