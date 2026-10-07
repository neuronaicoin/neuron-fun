"use client";

import { IS_TESTNET } from "@/lib/config";
import { useState } from "react";
import { Sheet } from "./chrome";
import { SUPABASE_URL } from "@/lib/config";
import type { Coin } from "@/lib/data";
import { useCoinLinks } from "@/lib/coinlinks";

const SITE = "https://sasapad.fun";

/** Public link to a coin; X, Telegram and Discord show its share card. */
export const coinShareUrl = (coinId: string) => `${SITE}/coin/?id=${encodeURIComponent(coinId)}`;
/** The card image the indexer draws for each coin. */
export const coinCardUrl = (coinId: string) =>
  `${SUPABASE_URL}/storage/v1/object/public/cards/${coinId.toLowerCase().replace(/[^0-9a-z]/g, "-")}.png`;

export const SASA_X = "sasapadfun";
/** Fired whenever someone opens the X composer from sasa (the points quest listens). */
export const SHARED_X_EVENT = "sasa:shared-x";

/** A coin being shared: its ticker, chain name(s) and the project's own X account if known. */
export type ShareCoinTags = { symbol: string; chains?: string[]; handle?: string | null };

const CHAIN_TAG: Record<string, string> = {
  robinhood: "RobinhoodChain", "robinhood chain": "RobinhoodChain", base: "Base", bnb: "BNBChain", "bnb chain": "BNBChain", bsc: "BNBChain",
  arc: "Arc", ethereum: "Ethereum", eth: "Ethereum",
};
const cleanHandle = (h?: string | null) => {
  const v = (h ?? "").trim().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").replace(/^@/, "").split(/[/?#]/)[0];
  return /^[A-Za-z0-9_]{1,15}$/.test(v) && v.toLowerCase() !== SASA_X ? v : null;
};

/**
 * Rule for every coin post: tag the coin's own project account (when it has one) and
 * end with exactly three hashtags: the coin's ticker, #memecoin and its chain.
 */
export function coinTags(c: ShareCoinTags): { handle: string | null; tags: string[] } {
  const tags: string[] = [];
  const tick = c.symbol.replace(/^\$/, "").replace(/[^A-Za-z0-9_]/g, "");
  if (/^[A-Za-z][A-Za-z0-9_]{0,24}$/.test(tick) && tick.toLowerCase() !== "memecoin") tags.push(`#${tick}`);
  tags.push("#memecoin");
  for (const ch of c.chains ?? []) {
    const t = CHAIN_TAG[ch.trim().toLowerCase()];
    if (t && !tags.includes(`#${t}`) && tags.length < 3) tags.push(`#${t}`);
  }
  for (const extra of ["#crypto", "#memecoins"]) if (tags.length < 3) tags.push(extra);
  return { handle: cleanHandle(c.handle), tags: tags.slice(0, 3) };
}

/**
 * Opens X's composer with text and a link (X adds the link's card itself).
 * Every post mentions @sasapadfun, so each share also shows people where it came from.
 * Coin posts (`coin` given) also tag the project's X account and add three hashtags.
 */
export function postOnX(text: string, url?: string, coin?: ShareCoinTags) {
  // While we're on testnet, every post says so: nobody should think this is live money.
  const honest = IS_TESTNET && !/testnet/i.test(text) ? `${text}\n\n🧪 On testnet now (free test USDC) · mainnet soon` : text;
  let t = /@sasapadfun/i.test(honest) ? honest : `${honest}\n\nvia @${SASA_X}`;
  if (coin) {
    const { handle, tags } = coinTags(coin);
    if (handle && !new RegExp(`@${handle}\\b`, "i").test(t)) t += ` · @${handle}`;
    t = t.replace(/(\s#[A-Za-z0-9_]+)+\s*$/, "") + `\n\n${tags.join(" ")}`;
  }
  const q = new URLSearchParams({ text: t });
  if (url) q.set("url", url);
  // The X app (if installed) gets the whole post, link included, in one message.
  openX(`https://x.com/intent/post?${q.toString()}`, `twitter://post?message=${encodeURIComponent(url ? `${t}\n${url}` : t)}`);
  window.dispatchEvent(new Event(SHARED_X_EVENT));
}

/** Opens X's "follow @sasapadfun" screen. */
export function followOnX() {
  openX(`https://x.com/intent/follow?screen_name=${SASA_X}`, `twitter://user?screen_name=${SASA_X}`);
}

/**
 * Phones: open the X app straight away when it's installed (signed in, post pre-filled);
 * otherwise, a moment later, X's web page in this tab. (Web links alone often land on X's
 * login page instead of the app, especially from the home-screen app.)
 * Computers: a new tab.
 */
function openX(url: string, appUrl?: string) {
  const phone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  if (!phone) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  if (!appUrl) {
    window.location.href = url;
    return;
  }
  let left = false;
  const onHide = () => {
    if (document.visibilityState === "hidden") left = true;
  };
  document.addEventListener("visibilitychange", onHide);
  window.location.href = appUrl;
  setTimeout(() => {
    document.removeEventListener("visibilitychange", onHide);
    if (!left) window.location.href = url; // no app: the web version
  }, 1500);
}

export function ShareButton({ coin }: { coin: Coin }) {
  const links = useCoinLinks(coin.id);
  const tagInfo: ShareCoinTags = { symbol: coin.symbol, chains: (coin.graduatedOn ? [coin.graduatedOn] : coin.curves).map((k) => k.chain.short), handle: links?.x ?? null };
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [imgOk, setImgOk] = useState(true);
  const url = coinShareUrl(coin.id);
  const text = coin.graduatedOn
    ? `$${coin.symbol} graduated on ${coin.graduatedOn.chain.short} 🎓 Liquidity locked forever on @${SASA_X}`
    : `$${coin.symbol} is racing on every chain at once 🏁 ${Math.round(coin.progress * 100)}% to graduation on @${SASA_X}`;
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
            <button type="button" onClick={() => postOnX(text, url, tagInfo)} className="h-12 rounded-2xl bg-ink text-mist font-bold flex items-center justify-center gap-2">
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
