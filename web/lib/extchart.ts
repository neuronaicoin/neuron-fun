import type { RaceCandle } from "./race";

/**
 * Price candles of a coin from another DEX, from GeckoTerminal's free public API
 * (the same source the indexer uses for these coins). Drawn with sasa's own chart.
 */
const GT = "https://api.geckoterminal.com/api/v2";

/** Our time frames (seconds) in GeckoTerminal's terms. */
function gtFrame(sec: number): { timeframe: "minute" | "hour" | "day"; aggregate: number } {
  if (sec <= 60) return { timeframe: "minute", aggregate: 1 };
  if (sec <= 300) return { timeframe: "minute", aggregate: 5 };
  if (sec <= 900) return { timeframe: "minute", aggregate: 15 };
  if (sec <= 3600) return { timeframe: "hour", aggregate: 1 };
  if (sec <= 14400) return { timeframe: "hour", aggregate: 4 };
  return { timeframe: "day", aggregate: 1 };
}

/** Candles in dollars per coin, oldest first. `token` makes sure the price is of this coin, not the pool's other side. */
/** Recent answers: a time frame switched back and forth doesn't spend the free API's calls again. */
const RECENT = new Map<string, { at: number; rows: RaceCandle[] }>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchExtCandles(network: string, pool: string, token: string, frameSec: number): Promise<RaceCandle[]> {
  const { timeframe, aggregate } = gtFrame(frameSec);
  const url = `${GT}/networks/${encodeURIComponent(network)}/pools/${pool}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=300&currency=usd&token=${token}`;
  const hit = RECENT.get(url);
  if (hit && Date.now() - hit.at < 20_000) return hit.rows;
  // the free API allows about 30 calls a minute: when it says "too many", wait and ask again
  let r: Response | null = null;
  for (let i = 0; i < 3; i++) {
    r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (r && r.ok) break;
    if (r && r.status !== 429 && r.status < 500) break;
    if (i < 2) await sleep(1500 * 2 ** i);
  }
  if (!r || !r.ok) {
    if (hit) return hit.rows;
    throw new Error(`chart data ${r ? r.status : "unreachable"}`);
  }
  const j = (await r.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
  const list = j.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) throw new Error("chart data missing");
  const rows = list
    .filter((c) => Array.isArray(c) && c.length >= 5 && c.slice(0, 5).every((v) => Number.isFinite(Number(v))) && Number(c[4]) > 0)
    .map((c) => ({ t: Number(c[0]), open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), volume: Number(c[5] ?? 0) }))
    .sort((a, b) => a.t - b.t)
    .filter((c, i, a) => i === 0 || c.t !== a[i - 1].t);
  RECENT.set(url, { at: Date.now(), rows });
  if (RECENT.size > 60) RECENT.delete(RECENT.keys().next().value as string);
  return rows;
}
