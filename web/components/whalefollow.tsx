"use client";

/**
 * Following a whale: one tap, and a phone alert comes whenever that trader opens, adds to,
 * cuts or closes a futures position (indexer/whales.mjs). The list of followed whales is shared
 * by every button on the page.
 */
import { useEffect, useSyncExternalStore, useState } from "react";
import { useWallet } from "./wallet";
import { enablePush, sessionToken } from "@/lib/alerts";
import { followWhale, myFollows, unfollowWhale } from "@/lib/hldata";
import { friendlyError } from "@/lib/format";

let follows: Set<string> | null = null;
let loadedFor: string | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

/** Loads the follows once a session exists (no signature asked just to look). */
export function useFollows(): Set<string> | null {
  const w = useWallet();
  const me = w.address?.toLowerCase() ?? null;
  const snap = useSyncExternalStore(
    subscribe,
    () => follows,
    () => null
  );
  useEffect(() => {
    if (loadedFor === me && follows) return;
    // another wallet (or none): its own list, never the last one's
    if (loadedFor !== me) {
      follows = null;
      loadedFor = me;
      emit();
    }
    if (!me || !sessionToken()) return;
    void myFollows(w.signMessage)
      .then((l) => {
        if (loadedFor !== me) return; // the wallet changed meanwhile
        follows = new Set(l);
        emit();
      })
      .catch(() => {});
  }, [me, w.signMessage]);
  return snap;
}

export function FollowButton({ whale, compact = false }: { whale: string; compact?: boolean }) {
  const w = useWallet();
  const set = useFollows();
  const on = !!set?.has(whale.toLowerCase());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setErr(null);
    if (!w.address) {
      setErr("Log in to get alerts.");
      return;
    }
    setBusy(true);
    // asked right away, while the tap still counts (browsers only ask from a tap)
    const perm = !on && typeof Notification !== "undefined" && Notification.permission === "default" ? Notification.requestPermission().catch(() => null) : null;
    try {
      const mine = w.address.toLowerCase();
      if (!follows || loadedFor !== mine) {
        follows = new Set(await myFollows(w.signMessage));
        loadedFor = mine;
      }
      if (on) {
        await unfollowWhale(w.signMessage, whale);
        follows.delete(whale.toLowerCase());
      } else {
        await followWhale(w.signMessage, whale);
        follows.add(whale.toLowerCase());
        // the phone alerts switch on once the browser's question is answered (never blocks the button)
        void Promise.resolve(perm).then(() => enablePush().catch(() => {}));
      }
      follows = new Set(follows);
      loadedFor = w.address.toLowerCase();
      emit();
    } catch (x) {
      setErr(friendlyError(x));
    } finally {
      setBusy(false);
    }
  };
  const label = on ? "Alerts on" : "Get alerts";
  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        onClick={(e) => void toggle(e)}
        disabled={busy}
        aria-pressed={on}
        aria-label={`${on ? "Stop alerts for" : "Get alerts for"} ${whale.slice(0, 6)}…${whale.slice(-4)}`}
        title={on ? "You get a phone alert when this trader opens or closes a position. Tap to stop." : "Get a phone alert when this trader opens or closes a position"}
        className={
          (compact ? "h-8 w-8 justify-center " : "h-9 px-3.5 gap-1.5 ") +
          "inline-flex items-center rounded-xl border font-semibold text-[0.8125rem] transition-colors disabled:opacity-50 " +
          (on ? "border-emerald bg-emerald text-on-accent" : "border-line text-ink-2 hover:border-ink-3 hover:text-ink")
        }
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {!compact && (busy ? "…" : label)}
      </button>
      {err && <span className="mt-1 text-[0.6875rem] text-danger max-w-[12rem] text-right">{err}</span>}
    </span>
  );
}
