"use client";

import { useEffect, useState } from "react";
import { Sheet } from "@/components/chrome";

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
        <Sheet title="Get the app" onClose={() => setHowTo(false)}>
          <p className="text-[0.9375rem] text-ink-2 leading-snug">Two taps and sasa sits on your home screen, full screen like an app.</p>
          <ol className="mt-4 grid gap-3">
            <li className="flex items-center gap-3 rounded-2xl border border-line bg-paper p-3">
              <span className="w-8 h-8 shrink-0 rounded-full bg-ink text-paper font-bold flex items-center justify-center">1</span>
              <span className="text-[0.9375rem] leading-snug">
                Tap{" "}
                <span className="inline-flex items-center align-middle px-1.5 py-0.5 rounded-md border border-line bg-surface" aria-label="Share">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3v12M8 7l4-4 4 4" />
                    <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
                  </svg>
                </span>{" "}
                <b>Share</b> in Safari's bar
              </span>
            </li>
            <li className="flex items-center gap-3 rounded-2xl border border-line bg-paper p-3">
              <span className="w-8 h-8 shrink-0 rounded-full bg-ink text-paper font-bold flex items-center justify-center">2</span>
              <span className="text-[0.9375rem] leading-snug">
                Choose <b>Add to Home Screen</b>, then <b>Add</b>
              </span>
            </li>
          </ol>
          <button
            type="button"
            onClick={() => {
              try {
                localStorage.setItem(ADDED_KEY, String(Date.now()));
              } catch {}
              setHowTo(false);
              setHidden(true);
            }}
            className="mt-4 w-full h-12 rounded-2xl bg-emerald text-on-accent font-semibold"
          >
            Done, I added it
          </button>
        </Sheet>
      )}
    </>
  );
}
