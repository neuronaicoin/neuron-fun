"use client";

import { useEffect, useState } from "react";

/**
 * "📲 Get the app": puts sasa on the phone's home screen, where it opens full screen
 * like an app.
 *
 * Shown only on phones and tablets, never inside the installed app.
 * - Android / Chrome: the browser's own install prompt (one tap). Chrome stops offering
 *   it once installed and offers it again after an uninstall, so the button follows.
 * - iPhone / iPad (Safari): Apple has no install prompt and doesn't tell a page whether
 *   it was added, so a two-step how-to opens; "Done, I added it" hides the button for
 *   14 days (if it was removed meanwhile, it comes back after that).
 */

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const ADDED_KEY = "sasa-app-added";
const HIDE_MS = 14 * 24 * 60 * 60 * 1000;

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

function addedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(ADDED_KEY) ?? 0);
    return at > 0 && Date.now() - at < HIDE_MS;
  } catch {
    return false;
  }
}

/** What the button should do here, or null to show nothing. */
function useInstall(): "android" | "ios" | null {
  const [mode, setMode] = useState<"android" | "ios" | null>(null);
  useEffect(() => {
    const decide = () => {
      if (standalone() || !isPhoneOrTablet()) return setMode(null);
      if (isIos()) return setMode(addedRecently() ? null : "ios");
      setMode(saved ? "android" : null);
    };
    decide();
    listeners.add(decide);
    return () => {
      listeners.delete(decide);
    };
  }, []);
  return mode;
}

export function GetAppButton({ className = "", variant = "chip" }: { className?: string; variant?: "chip" | "tile" }) {
  const mode = useInstall();
  const [howTo, setHowTo] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (!mode || hidden) return null;

  const go = async () => {
    if (mode === "android" && saved) {
      const p = saved;
      await p.prompt();
      const { outcome } = await p.userChoice.catch(() => ({ outcome: "dismissed" }));
      if (outcome === "accepted") {
        saved = null;
        setHidden(true);
      }
      return;
    }
    setHowTo(true);
  };

  return (
    <>
      {variant === "chip" ? (
        <button
          type="button"
          onClick={() => void go()}
          className={"h-10 px-4 shrink-0 rounded-xl border border-line bg-surface font-semibold text-[0.875rem] flex items-center gap-1.5 " + className}
        >
          <span aria-hidden="true">📲</span> Get the app
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void go()}
          className={"rounded-2xl border border-line bg-paper hover:border-emerald/60 p-3 flex flex-col gap-1 min-h-[5.5rem] text-left " + className}
        >
          <span className="text-[1.375rem] leading-none" aria-hidden="true">📲</span>
          <span className="font-semibold text-[0.9375rem]">Get the app</span>
          <span className="text-[0.6875rem] text-ink-3 leading-snug">sasa on your home screen</span>
        </button>
      )}
      {howTo && (
        // iPhone: Apple lets only Safari's own Share menu add a site to the home screen, so we
        // point at that button (bottom of the screen in Safari) with one short line.
        <div className="fixed inset-0 z-[80] bg-black/55" onClick={() => setHowTo(false)} role="dialog" aria-modal="true" aria-label="Get the app">
          <div
            className="absolute left-1/2 -translate-x-1/2 w-[min(22rem,calc(100vw-2rem))] rounded-3xl bg-surface border border-line p-5 text-center shadow-xl"
            style={{ bottom: "calc(6.5rem + env(safe-area-inset-bottom, 0px))" }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="font-display font-bold text-[1.125rem]">Add sasa to your home screen</p>
            <p className="mt-2 text-[0.9375rem] text-ink-2 leading-snug">
              Tap{" "}
              <span className="inline-flex items-center align-middle px-1.5 py-0.5 rounded-md border border-line bg-paper" aria-label="Share">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3v12M8 7l4-4 4 4" />
                  <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
                </svg>
              </span>{" "}
              below (on newer iPhones: <b>⋯</b> then <b>Share</b>), then <b>Add to Home Screen</b>.
            </p>
            <button
              type="button"
              onClick={() => {
                try {
                  localStorage.setItem(ADDED_KEY, String(Date.now()));
                } catch {}
                setHowTo(false);
                setHidden(true);
              }}
              className="mt-4 h-10 px-5 rounded-xl bg-emerald text-on-accent font-semibold text-[0.875rem]"
            >
              Got it
            </button>
          </div>
          {/* The arrow points at Safari's Share button in the bar below. */}
          <div
            aria-hidden="true"
            className="absolute left-1/2 -translate-x-1/2 text-white text-[2.25rem] leading-none animate-bounce motion-reduce:animate-none"
            style={{ bottom: "calc(0.5rem + env(safe-area-inset-bottom, 0px))" }}
          >
            ⬇
          </div>
        </div>
      )}
    </>
  );
}
