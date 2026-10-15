/**
 * Chart indicators, worked out from the candles (closing prices): moving average (MA),
 * exponential moving average (EMA), Bollinger bands, RSI and volume. Each one the user adds has
 * its own settings (MA 20, MA 50, MA 200 …) and they are remembered in this browser.
 */

export type IndKind = "ma" | "ema" | "bb" | "rsi" | "vol";
export type Indicator = { id: string; kind: IndKind; period: number; mult?: number; color: string };

export const IND_INFO: Record<IndKind, { name: string; short: string; period: number; mult?: number; min: number; max: number; help: string }> = {
  ma: { name: "Moving average", short: "MA", period: 20, min: 1, max: 500, help: "Average closing price of the last N candles." },
  ema: { name: "Exponential moving average", short: "EMA", period: 21, min: 1, max: 500, help: "Like MA, but recent candles count more." },
  bb: { name: "Bollinger bands", short: "BB", period: 20, mult: 2, min: 2, max: 500, help: "MA with bands N standard deviations above and below." },
  rsi: { name: "RSI", short: "RSI", period: 14, min: 2, max: 200, help: "Momentum from 0 to 100; above 70 is often called overbought, below 30 oversold." },
  vol: { name: "Volume", short: "Vol", period: 0, min: 0, max: 0, help: "Dollars traded in each candle." },
};

export const IND_COLORS = ["#f5a524", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6", "#ef4444", "#84cc16", "#64748b"];
export const MAX_INDICATORS = 12;
const STORE = "sasa-perps-indicators";

/** What a new chart starts with: volume and one 20-candle average. */
export const DEFAULT_INDICATORS: Indicator[] = [
  { id: "vol", kind: "vol", period: 0, color: "#64748b" },
  { id: "ma20", kind: "ma", period: 20, color: IND_COLORS[0] },
];

/** A clean, safe copy of saved settings (anything odd is dropped). */
export function cleanIndicators(raw: unknown): Indicator[] {
  if (!Array.isArray(raw)) return DEFAULT_INDICATORS;
  const out: Indicator[] = [];
  const ids = new Set<string>();
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const kind = r.kind as IndKind;
    const info = IND_INFO[kind];
    if (!info) continue;
    if (kind === "vol" && out.some((x) => x.kind === "vol")) continue;
    let id = typeof r.id === "string" && /^[a-z0-9-]{1,24}$/.test(r.id) ? r.id : `${kind}${out.length}`;
    while (ids.has(id)) id += "x";
    ids.add(id);
    const period = kind === "vol" ? 0 : clampInt(r.period, info.min, info.max, info.period);
    const color = typeof r.color === "string" && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : IND_COLORS[out.length % IND_COLORS.length];
    const ind: Indicator = { id, kind, period, color };
    if (kind === "bb") ind.mult = clampNum(r.mult, 0.5, 5, 2);
    out.push(ind);
    if (out.length >= MAX_INDICATORS) break;
  }
  return out;
}

function clampInt(v: unknown, min: number, max: number, dflt: number) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}
function clampNum(v: unknown, min: number, max: number, dflt: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 10) / 10)) : dflt;
}

export function loadIndicators(): Indicator[] {
  try {
    const s = localStorage.getItem(STORE);
    return s === null ? DEFAULT_INDICATORS : cleanIndicators(JSON.parse(s));
  } catch {
    return DEFAULT_INDICATORS;
  }
}
export function saveIndicators(list: Indicator[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {}
}

/** A label like "MA 50" or "BB 20 2". */
export function indLabel(i: Indicator): string {
  const s = IND_INFO[i.kind].short;
  if (i.kind === "vol") return s;
  if (i.kind === "bb") return `${s} ${i.period} ${i.mult ?? 2}`;
  return `${s} ${i.period}`;
}

/** Values line up with the input; `null` where there aren't enough candles yet. */
export function sma(v: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(v.length).fill(null);
  if (n < 1) return out;
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= n) sum -= v[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** EMA seeded with the simple average of the first N values (the usual way charts do it). */
export function ema(v: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(v.length).fill(null);
  if (n < 1 || v.length < n) return out;
  const k = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += v[i];
  e /= n;
  out[n - 1] = e;
  for (let i = n; i < v.length; i++) {
    e = v[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** Bollinger: middle (MA) and bands at ± mult population standard deviations. */
export function bollinger(v: number[], n: number, mult: number): { mid: (number | null)[]; up: (number | null)[]; low: (number | null)[] } {
  const mid = sma(v, n);
  const up: (number | null)[] = new Array(v.length).fill(null);
  const low: (number | null)[] = new Array(v.length).fill(null);
  for (let i = n - 1; i < v.length; i++) {
    const m = mid[i];
    if (m === null) continue;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (v[j] - m) ** 2;
    const sd = Math.sqrt(s / n);
    up[i] = m + mult * sd;
    low[i] = m - mult * sd;
  }
  return { mid, up, low };
}

/** RSI with Wilder's smoothing (as on TradingView and most exchanges). */
export function rsi(v: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(v.length).fill(null);
  if (n < 1 || v.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = v[i] - v[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  const val = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[n] = val();
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = val();
  }
  return out;
}
