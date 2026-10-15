"use client";

import { useEffect, useState } from "react";

/**
 * "Use sasa as an app": puts sasa on the phone's home screen, where it opens full screen
 * like an app. Shown on every phone and tablet (top of More), never inside the installed app.
 * - Android Chrome (and others that offer it): the browser's own install prompt, one tap.
 * - Android browsers without it: a one-line how-to (menu ⋮ → Add to Home screen).
 * - iPhone / iPad: Apple has no install prompt, so a two-step how-to opens (Share → Add to
 *   Home Screen).
 * - Wallet and social apps' built-in browsers can't install anything: open the site in
 *   Safari / Chrome first (with a Copy link button).
 */

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };


// The browser fires this once, often before React mounts: keep it for when the button renders.
let saved: InstallPrompt | null = null;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we show our own button instead of the mini-bar
    saved = e as InstallPrompt;
    listeners.forEach((f) => f());
  });
  window.addEventListener("appinstalled", () => {
    saved = null;
    listeners.forEach((f) => f());
  });
}

function standalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: fullscreen)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch gives it away.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isPhoneOrTablet(): boolean {
  return window.matchMedia?.("(pointer: coarse)").matches && window.innerWidth < 1100;
}

type Mode = "prompt" | "ios" | "android" | "inapp";

/** Wallet and social apps' own browsers can't add sites to the home screen. */
function inAppBrowser(): boolean {
  return /MetaMask|Trust\s?Wallet|CoinbaseWallet|OKApp|Bitget|Phantom|Rainbow|Telegram|Instagram|FBAN|FBAV|Line\/|Twitter|TikTok|wv\)/i.test(navigator.userAgent);
}

/** What the button does here, or null to show nothing (computers, and inside the installed app). */
function useInstall(): Mode | null {
  const [mode, setMode] = useState<Mode | null>(null);
  useEffect(() => {
    const decide = () => {
      if (standalone() || !isPhoneOrTablet()) return setMode(null);
      if (saved) return setMode("prompt");
      if (inAppBrowser()) return setMode("inapp");
      setMode(isIos() ? "ios" : "android");
    };
    decide();
    listeners.add(decide);
    return () => {
      listeners.delete(decide);
    };
  }, []);
  return mode;
}

const LABEL = "Use sasa as an app";

/** "Use sasa as an app": always offered on phones and tablets (top of More). */
export function GetAppButton({ className = "", variant = "chip" }: { className?: string; variant?: "chip" | "tile" }) {
  const mode = useInstall();
  const [howTo, setHowTo] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!mode) return null;

  const go = async () => {
    if (mode === "prompt" && saved) {
      const p = saved;
      await p.prompt();
      const { outcome } = await p.userChoice.catch(() => ({ outcome: "dismissed" }));
      if (outcome === "accepted") saved = null;
      return;
    }
    setHowTo(true);
  };

  const share = (
    <span className="inline-flex items-center align-middle px-1.5 py-0.5 rounded-md border border-line bg-paper" aria-label="Share">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3v12M8 7l4-4 4 4" />
        <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
      </svg>
    </span>
  );

  return (
    <>
      {variant === "chip" ? (
        <button
          type="button"
          onClick={() => void go()}
          className={"h-10 px-4 shrink-0 rounded-xl border border-line bg-surface font-semibold text-[0.875rem] flex items-center gap-1.5 " + className}
        >
          {LABEL}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void go()}
          className={"flex items-center gap-3 px-1 py-3 border-b border-line text-left w-full " + className}
        >
          <span className="w-10 h-10 rounded-xl bg-emerald-soft text-emerald grid place-items-center shrink-0" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="6" y="2" width="12" height="20" rx="2.5" />
              <path d="M11 18h2" />
            </svg>
          </span>
          <span className="min-w-0">
            <span className="block font-semibold text-[0.9375rem]">{LABEL}</span>
            <span className="block text-[0.75rem] text-ink-3 leading-snug">sasa on your home screen, full screen</span>
          </span>
        </button>
      )}
      {howTo && (
        <div className="fixed inset-0 z-[80] bg-black/55" onClick={() => setHowTo(false)} role="dialog" aria-modal="true" aria-label={LABEL}>
          <div
            className="absolute left-1/2 -translate-x-1/2 w-[min(22rem,calc(100vw-2rem))] rounded-3xl bg-surface border border-line p-5 text-center shadow-xl"
            style={{ bottom: "calc(6.5rem + env(safe-area-inset-bottom, 0px))" }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="font-display font-bold text-[1.125rem]">Add sasa to your home screen</p>
            {mode === "ios" ? (
              // Apple lets only the browser's own Share menu add a site to the home screen
              <p className="mt-2 text-[0.9375rem] text-ink-2 leading-snug">
                Tap {share} (in Safari it&apos;s below; on newer iPhones <b>⋯</b> then <b>Share</b>), then <b>Add to Home Screen</b>.
              </p>
            ) : mode === "android" ? (
              <p className="mt-2 text-[0.9375rem] text-ink-2 leading-snug">
                Tap the browser menu <b>⋮</b> (top right), then <b>Add to Home screen</b> or <b>Install app</b>.
              </p>
            ) : (
              <>
                <p className="mt-2 text-[0.9375rem] text-ink-2 leading-snug">
                  This app&apos;s built-in browser can&apos;t add sites to your home screen. Open <b>{typeof location !== "undefined" ? location.host : "sasapad.fun"}</b> in{" "}
                  {isIos() ? "Safari" : "Chrome"}, then tap <b>{LABEL}</b> there.
                </p>
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard
                      ?.writeText(location.origin + "/")
                      .then(() => setCopied(true))
                      .catch(() => {})
                  }
                  className="mt-3 h-10 px-5 rounded-xl border border-line font-semibold text-[0.875rem]"
                >
                  {copied ? "Link copied" : "Copy link"}
                </button>
              </>
            )}
            <button type="button" onClick={() => setHowTo(false)} className="mt-4 h-10 px-5 rounded-xl bg-emerald text-on-accent font-semibold text-[0.875rem] block mx-auto">
              Got it
            </button>
          </div>
          {mode === "ios" && (
            // the arrow points at Safari's Share button in the bar below
            <div
              aria-hidden="true"
              className="absolute left-1/2 -translate-x-1/2 text-white text-[2.25rem] leading-none animate-bounce motion-reduce:animate-none"
              style={{ bottom: "calc(0.5rem + env(safe-area-inset-bottom, 0px))" }}
            >
              ⬇
            </div>
          )}
        </div>
      )}
    </>
  );
}
