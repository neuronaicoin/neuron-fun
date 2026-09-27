/**
 * A tiny in-page signal: "a trade just landed on this curve". The trade box
 * fires it; charts and trade lists react at once instead of waiting for
 * their next scheduled refresh.
 */
export type TradeSignal = { chainId: number; curve: string; coinId: string; nativePerToken: number | null };

const EVENT = "sasa:trade";

export function signalTrade(s: TradeSignal) {
  window.dispatchEvent(new CustomEvent<TradeSignal>(EVENT, { detail: s }));
}

/** Calls `fn` for every trade signal; returns an unsubscribe function. */
export function onTrade(fn: (s: TradeSignal) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<TradeSignal>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}

/** Runs `fn` a few times shortly after a trade, while the indexer catches up. */
export function burst(fn: () => void, delays = [1200, 2500, 4500, 8000]): () => void {
  const timers = delays.map((d) => setTimeout(fn, d));
  return () => timers.forEach(clearTimeout);
}
