"use client";

/**
 * Pull down from the top of any page to reload it (phones; the installed app has no browser
 * pull-to-refresh of its own). Skipped while a sheet is open, inside anything that scrolls on
 * its own, and on charts (dragging a chart must never reload the page).
 */
import { useEffect, useRef, useState } from "react";

const TRIGGER = 70;
const MAX = 96;

function blocked(t: EventTarget | null): boolean {
  let el = t instanceof Element ? t : null;
  if (document.body.style.overflow === "hidden") return true; // a sheet or picker is open
  while (el && el !== document.body) {
    if (el instanceof HTMLCanvasElement || el.matches("input[type=range], [data-no-ptr], [role=dialog], .tv-lightweight-charts")) return true;
    if (el.scrollTop > 0) return true;
    el = el.parentElement;
  }
  return false;
}

export function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const start = useRef<number | null>(null);
  const cur = useRef(0);

  useEffect(() => {
    if (!("ontouchstart" in window)) return;
    const down = (e: TouchEvent) => {
      if (busy || e.touches.length !== 1 || window.scrollY > 0 || blocked(e.target)) return (start.current = null);
      start.current = e.touches[0].clientY;
      cur.current = 0;
    };
    const move = (e: TouchEvent) => {
      if (start.current === null) return;
      const dy = e.touches[0].clientY - start.current;
      if (dy <= 0 || window.scrollY > 0) {
        cur.current = 0;
        setPull(0);
        return;
      }
      cur.current = Math.min(MAX, dy * 0.5);
      setPull(cur.current);
    };
    const up = () => {
      if (start.current === null) return;
      start.current = null;
      if (cur.current >= TRIGGER) {
        setBusy(true);
        setPull(TRIGGER);
        window.location.reload();
      } else setPull(0);
      cur.current = 0;
    };
    window.addEventListener("touchstart", down, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", up, { passive: true });
    window.addEventListener("touchcancel", up, { passive: true });
    return () => {
      window.removeEventListener("touchstart", down);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchcancel", up);
    };
  }, [busy]);

  if (pull <= 0 && !busy) return null;
  const ready = pull >= TRIGGER;
  return (
    <div
      className="fixed left-1/2 z-[60] -translate-x-1/2 pointer-events-none"
      style={{ top: `calc(env(safe-area-inset-top, 0px) + ${Math.round(pull)}px)` }}
      aria-live="polite"
    >
      <div className="w-10 h-10 rounded-full bg-surface border border-line shadow-md flex items-center justify-center">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          className={"text-emerald " + (busy ? "animate-spin" : "")}
          style={busy ? undefined : { transform: `rotate(${Math.round((pull / TRIGGER) * 270)}deg)`, opacity: ready ? 1 : 0.6 }}
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <path d="M21 4v5h-5" />
        </svg>
      </div>
      <span className="sr-only">{busy ? "Refreshing" : ready ? "Release to refresh" : "Pull to refresh"}</span>
    </div>
  );
}
