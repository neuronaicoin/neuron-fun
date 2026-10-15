"use client";

/**
 * "Create with AI" on the launch page: one topic in, one coin out (name, ticker, story and one
 * picture), filled straight into the form. Ten a day per account; the picture is stored with
 * the coin itself like an upload, no image hosting.
 */
import { useState } from "react";
import { useWallet } from "./wallet";
import { ConnectButton } from "./chrome";
import { aiCoin, IDEA_SPARKS } from "@/lib/ai";
import { fileToLogo } from "@/lib/image";
import { friendlyError } from "@/lib/format";

export type AiFill = { name: string; symbol: string; description: string; logo: string | null; logoError: string | null };

/** The AI picture as the same small JPEG an upload becomes. */
async function toCoinLogo(dataUrl: string): Promise<string | null> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    return await fileToLogo(new File([blob], "logo.jpg", { type: blob.type || "image/jpeg" }));
  } catch {
    return null;
  }
}

export function AiCoinPanel({ onFill }: { onFill: (f: AiFill) => void }) {
  const { address, signMessage } = useWallet();
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function make(topic: string) {
    const text = topic.trim().slice(0, 200);
    if (text.length < 3 || busy) {
      if (text.length < 3) setError("Write a few words about your coin first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const c = await aiCoin(signMessage, text);
      const logo = c.image ? await toCoinLogo(c.image) : null;
      onFill({ name: c.name, symbol: c.symbol, description: c.description, logo, logoError: logo ? null : (c.imageError ?? "Couldn't use the picture. Upload your own.") });
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!address) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[0.875rem] text-ink-2">Log in to create a coin with AI.</p>
        <ConnectButton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-[0.8125rem] text-ink-3">What's your coin about?</span>
        <textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value.slice(0, 200))}
          rows={2}
          maxLength={200}
          placeholder="A cat that surfs the ocean waves"
          className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-[1rem] outline-none focus:border-ink-3 resize-none min-w-0"
        />
      </label>
      <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1">
        {IDEA_SPARKS.map(([label, text]) => (
          <button
            key={label}
            type="button"
            disabled={busy}
            onClick={() => {
              setIdea(text);
              void make(text);
            }}
            className="shrink-0 h-8 px-3 rounded-full border border-line text-[0.8125rem] text-ink-2 hover:border-ink-3 disabled:opacity-50"
          >
            {label}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => void make(idea)}
        disabled={busy}
        className="h-11 rounded-full bg-ink text-paper font-semibold text-[0.9375rem] disabled:opacity-60"
      >
        {busy ? "Creating your coin…" : "Create my coin"}
      </button>
      <p className="text-[0.75rem] text-ink-3">One picture, a name, a ticker and a short story. You can change anything before you launch. 10 a day.</p>
      {error && (
        <p className="text-[0.8125rem] text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
