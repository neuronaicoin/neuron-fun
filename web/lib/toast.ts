/**
 * One big, clear notice after a trade ("Bought 1.2M SPICY for $10"), shown on top of every page.
 * A tiny store any component can push to; <TradeToast /> in the app shell draws it.
 */
export type Toast = {
  id: number;
  kind: "buy" | "sell" | "ok" | "error";
  title: string;
  body?: string;
  href?: string;
  hrefLabel?: string;
  logo?: string | null;
};

let current: Toast | null = null;
let seq = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

export function subscribeToast(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
export const getToast = () => current;
export const getServerToast = () => null;

export function showToast(t: Omit<Toast, "id">, ms = 5_000) {
  current = { ...t, id: ++seq };
  listeners.forEach((l) => l());
  // a short buzz on phones that support it
  try {
    if (t.kind !== "error") navigator.vibrate?.(35);
  } catch {}
  if (timer) clearTimeout(timer);
  timer = setTimeout(hideToast, ms);
}

export function hideToast() {
  current = null;
  if (timer) clearTimeout(timer);
  timer = null;
  listeners.forEach((l) => l());
}
