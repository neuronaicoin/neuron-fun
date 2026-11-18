/**
 * sasa Pulse: one live screen of the whole market — whale trades, futures, stocks, predict,
 * funding and the top-500 movers. Every number comes from the same live sources as the Market,
 * Futures, Predict and Data tabs (nothing here is made up or sampled).
 */
import { fetchBuilderMarkets, fetchPerpCandles, fetchPerpMarkets, info, type PerpCandle, type PerpMarket } from "./perps";
import { fetchWhaleMoves, type WhaleMove } from "./hldata";
import { fetchPredict, type PredictOutcome } from "./predict";
import { fetchTopCoins, type TopCoin } from "./topcoins";
import { fearGreed, type FearGreed } from "./feargreed.js";

export type PulseOdds = { id: number; title: string; yes: number };
export type PulseBook = { bids: [number, number][]; asks: [number, number][] };

export type PulseData = {
  at: number;
  crypto: PerpMarket[];
  stocks: PerpMarket[];
  whales: WhaleMove[];
  odds: PulseOdds[];
  top: TopCoin[];
  fg: FearGreed | null;
  /** 24h volume of every crypto + stock/commodity futures market, in $. */
  vol24h: number;
  openInterest: number;
  /** Volume-weighted hourly funding of the 50 busiest crypto markets. */
  avgFunding: number;
  whales1h: number;
  biggest1h: WhaleMove | null;
  /** Whale money opened / added in the latest moves: share going long (0..1), null with too few. */
  longShare: number | null;
};

const settle = async <T,>(p: Promise<T>, fb: T): Promise<T> => {
  try {
    return await p;
  } catch {
    return fb;
  }
};

function oddsOf(singles: PredictOutcome[], groups: { answers: PredictOutcome[]; title: string }[]): PulseOdds[] {
  const out: PulseOdds[] = [];
  const now = Date.now();
  const ok = (o: PredictOutcome) => o.tradable && o.sides[0].price !== null && (o.expiry === null || o.expiry > now);
  for (const o of singles) if (ok(o)) out.push({ id: o.outcome, title: o.title, yes: o.sides[0].price as number });
  for (const g of groups) {
    // the answer the market likes most
    const best = g.answers.filter(ok).sort((a, b) => (b.sides[0].price ?? 0) - (a.sides[0].price ?? 0))[0];
    if (best) out.push({ id: best.outcome, title: `${g.title.replace(/: which range\?$/, "")} · ${best.label}`.trim(), yes: best.sides[0].price as number });
  }
  return out.slice(0, 6);
}

/** `lite`: what the Explore strip needs (no top 500, no stocks list). */
export async function fetchPulse(opts: { lite?: boolean; signal?: AbortSignal } = {}): Promise<PulseData> {
  const { lite, signal } = opts;
  const crypto = await fetchPerpMarkets(signal);
  const skip = new Set(crypto.map((m) => m.label.toUpperCase()));
  const [stocks, whales, board, top] = await Promise.all([
    lite ? Promise.resolve([] as PerpMarket[]) : settle(fetchBuilderMarkets(skip, signal), [] as PerpMarket[]),
    settle(fetchWhaleMoves({ limit: 40 }), [] as WhaleMove[]),
    settle(fetchPredict(signal), null),
    lite ? Promise.resolve([] as TopCoin[]) : settle(fetchTopCoins(), [] as TopCoin[]),
  ]);
  const busy = crypto.slice(0, 50);
  const vsum = busy.reduce((s, m) => s + m.volume24h, 0) || 1;
  const hour = Date.now() - 3600e3;
  const recent = whales.filter((w) => w.t >= hour);
  const opens = whales.filter((w) => w.kind === "open" || w.kind === "add" || w.kind === "flip");
  const longUsd = opens.filter((w) => w.side === "long").reduce((s, w) => s + w.usd, 0);
  const allUsd = opens.reduce((s, w) => s + w.usd, 0);
  return {
    at: Date.now(),
    crypto,
    stocks: stocks.filter((m) => m.group !== "crypto"),
    whales,
    odds: board ? oddsOf(board.singles, board.groups) : [],
    top: top.filter((c) => c.change24h !== null),
    fg: fearGreed(crypto),
    vol24h: [...crypto, ...stocks].reduce((s, m) => s + m.volume24h, 0),
    openInterest: [...crypto, ...stocks].reduce((s, m) => s + m.openInterestUsd, 0),
    avgFunding: busy.reduce((s, m) => s + m.funding * m.volume24h, 0) / vsum,
    whales1h: recent.length,
    biggest1h: recent.slice().sort((a, b) => b.usd - a.usd)[0] ?? null,
    longShare: opens.length >= 4 && allUsd > 0 ? longUsd / allUsd : null,
  };
}

/** Live mid prices of every market ("BTC" → 63451.2). */
export async function fetchMids(signal?: AbortSignal): Promise<Record<string, number>> {
  const raw = await info<Record<string, string>>({ type: "allMids" }, signal);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const x = Number(v);
    if (Number.isFinite(x) && x > 0 && !k.startsWith("@") && !k.startsWith("#")) out[k] = x;
  }
  return out;
}

export async function fetchBook(coin = "BTC", signal?: AbortSignal): Promise<PulseBook> {
  const r = await info<{ levels?: [{ px: string; sz: string }[], { px: string; sz: string }[]] }>({ type: "l2Book", coin, nSigFigs: 5 }, signal);
  const map = (l: { px: string; sz: string }[] = []) => l.slice(0, 9).map((x) => [Number(x.px), Number(x.sz)] as [number, number]);
  return { bids: map(r?.levels?.[0]), asks: map(r?.levels?.[1]) };
}

export const fetchTape = (coin = "BTC"): Promise<PerpCandle[]> => fetchPerpCandles(coin, 60, 90);

/** Hourly funding → % a year. */
export const fundingYear = (hourly: number) => hourly * 24 * 365 * 100;
