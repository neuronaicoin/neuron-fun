"use client";

import { useState } from "react";
import { Sheet } from "./chrome";
import { SUPABASE_URL } from "@/lib/config";
import type { Coin } from "@/lib/data";

const SITE = "https://sasapad.fun";

/** Public link to a coin; X, Telegram and Discord show its share card. */
export const coinShareUrl = (coinId: string) => `${SITE}/coin/?id=${encodeURIComponent(coinId)}`;
/** The card image the indexer draws for each coin. */
export const coinCardUrl = (coinId: string) =>
  `${SUPABASE_URL}/storage/v1/object/public/cards/${coinId.toLowerCase().replace(/[^0-9a-z]/g, "-")}.png`;

/** Opens X's composer with text and a link (X adds the link's card itself). */
export function postOnX(text: string, url?: string) {
  const q = new URLSearchParams({ text });
  if (url) q.set("url", url);
  window.open(`https://x.com/intent/post?${q.toString()}`, "_blank", "noopener,noreferrer");
}

export function ShareButton({ coin }: { coin: Coin }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [imgOk, setImgOk] = useState(true);
  const url = coinShareUrl(coin.id);
  const text = coin.graduatedOn
    ? `$${coin.symbol} graduated on ${coin.graduatedOn.chain.short} 🎓 Liquidity locked forever.`
    : `$${coin.symbol} is racing on every chain at once 🏁 ${Math.round(coin.progress * 100)}% to graduation.`;
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Share this coin"
        title="Share"
        className="w-9 h-9 rounded-xl border border-line text-ink-3 hover:text-ink flex items-center justify-center shrink-0"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v12" />
          <path d="m7 8 5-5 5 5" />
          <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
        </svg>
      </button>
      {open && (
        <Sheet title={`Share $${coin.symbol}`} onClose={() => setOpen(false)}>
          {imgOk ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={coinCardUrl(coin.id)}
              alt={`${coin.name} share card`}
              className="w-full aspect-[1200/630] rounded-2xl border border-line object-cover bg-paper"
              onError={() => setImgOk(false)}
            />
          ) : (
            <div className="w-full aspect-[1200/630] rounded-2xl border border-line bg-paper flex items-center justify-center text-[0.875rem] text-ink-3 text-center px-6">
              The card for this coin is being drawn. The link still works.
            </div>
          )}
          <p className="text-[0.8125rem] text-ink-3 mt-3">{text}</p>
          <div className="grid gap-2 mt-4">
            <button type="button" onClick={() => postOnX(text, url)} className="h-12 rounded-2xl bg-ink text-mist font-bold flex items-center justify-center gap-2">
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              Post on X
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() =>
                  navigator.clipboard.writeText(url).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                }
                className="h-11 rounded-2xl border border-line font-semibold text-[0.875rem]"
              >
                {copied ? "Copied ✓" : "Copy link"}
              </button>
              <button
                type="button"
                disabled={!canNativeShare}
                onClick={() => navigator.share({ title: `${coin.name} ($${coin.symbol}) on sasa`, text, url }).catch(() => {})}
                className="h-11 rounded-2xl border border-line font-semibold text-[0.875rem] disabled:opacity-40"
              >
                Share…
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
