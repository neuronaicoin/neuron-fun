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

/** Pools GeckoTerminal doesn't know (the coin came from DexScreener): the coin's busiest pool there instead, or none. */
const POOL = new Map<string, string | null>();

async function gtGet(url: string): Promise<Response | null> {
  // the free API allows about 30 calls a minute: when it says "too many", wait and ask again
  let r: Response | null = null;
  for (let i = 0; i < 3; i++) {
    r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (r && r.ok) break;
    if (r && r.status !== 429 && r.status < 500) break;
    if (i < 2) await sleep(1500 * 2 ** i);
  }
  return r;
}

async function otherPool(network: string, token: string): Promise<string | null> {
  const k = `${network}:${token}`.toLowerCase();
  if (POOL.has(k)) return POOL.get(k)!;
  const r = await gtGet(`${GT}/networks/${encodeURIComponent(network)}/tokens/${token}/pools?page=1`);
  if (!r) throw new Error("chart data unreachable");
  if (!r.ok && r.status !== 404) throw new Error(`chart data ${r.status}`);
  const j = r.ok ? ((await r.json().catch(() => null)) as { data?: { attributes?: { address?: string } }[] } | null) : null;
  // EVM pools are 0x addresses; Solana pools are base58
  const addr = j?.data?.find((p) => /^0x[0-9a-fA-F]{40}$|^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.attributes?.address ?? ""))?.attributes?.address ?? null;
  POOL.set(k, addr);
  return addr;
}

/** An empty list means "no chart for this coin" (the chart says so at once instead of waiting). */
export async function fetchExtCandles(network: string, pool: string, token: string, frameSec: number): Promise<RaceCandle[]> {
  const { timeframe, aggregate } = gtFrame(frameSec);
  const known = POOL.get(`${network}:${token}`.toLowerCase());
  const use = known === undefined ? pool : known;
  if (use === null) return [];
  const url = `${GT}/networks/${encodeURIComponent(network)}/pools/${use}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=300&currency=usd&token=${token}`;
  const hit = RECENT.get(url);
  if (hit && Date.now() - hit.at < 20_000) return hit.rows;
  const r = await gtGet(url);
  if (r && r.status === 404 && known === undefined) {
    // GeckoTerminal doesn't have this pool: try the coin's own pool list once
    const other = await otherPool(network, token);
    if (!other || other.toLowerCase() === pool.toLowerCase()) {
      POOL.set(`${network}:${token}`.toLowerCase(), null);
      return [];
    }
    return fetchExtCandles(network, pool, token, frameSec);
  }
  if (r && r.status === 404) return [];
  if (!r || !r.ok) {
    if (hit) return hit.rows;
    throw new Error(`chart data ${r ? r.status : "unreachable"}`);
  }
  const j = (await r.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
  const list = j.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const rows = list
    .filter((c) => Array.isArray(c) && c.length >= 5 && c.slice(0, 5).every((v) => Number.isFinite(Number(v))) && Number(c[4]) > 0)
    .map((c) => ({ t: Number(c[0]), open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), volume: Number(c[5] ?? 0) }))
    .sort((a, b) => a.t - b.t)
    .filter((c, i, a) => i === 0 || c.t !== a[i - 1].t);
  RECENT.set(url, { at: Date.now(), rows });
  if (RECENT.size > 60) RECENT.delete(RECENT.keys().next().value as string);
  return rows;
}

/** One trade on another DEX's pool (GeckoTerminal's last 24 hours, newest first). */
export type ExtTrade = { id: string; t: number; buy: boolean; usd: number; trader: string; tx: string };

/** The latest trades of a coin's pool; [] when there are none or the pool isn't known. */
export async function fetchExtTrades(network: string, pool: string, token: string): Promise<ExtTrade[]> {
  const known = POOL.get(`${network}:${token}`.toLowerCase());
  let use = known === undefined ? pool : known;
  if (use === null) return [];
  const url = (p: string) => `${GT}/networks/${encodeURIComponent(network)}/pools/${p}/trades?token=${token}`;
  let r = await gtGet(url(use));
  if (r && r.status === 404 && known === undefined) {
    const other = await otherPool(network, token);
    if (!other || other.toLowerCase() === pool.toLowerCase()) return [];
    use = other;
    r = await gtGet(url(use));
  }
  if (!r || !r.ok) {
    if (r && r.status === 404) return [];
    throw new Error(`trades ${r ? r.status : "unreachable"}`);
  }
  type A = { block_timestamp?: string; kind?: string; volume_in_usd?: string; tx_from_address?: string; tx_hash?: string };
  const j = (await r.json()) as { data?: { id?: string; attributes?: A }[] };
  return (j.data ?? [])
    .map((d): ExtTrade | null => {
      const a = d.attributes ?? {};
      const t = Date.parse(a.block_timestamp ?? "");
      const usd = Number(a.volume_in_usd);
      if (!Number.isFinite(t) || !Number.isFinite(usd) || (a.kind !== "buy" && a.kind !== "sell")) return null;
      return { id: d.id ?? `${a.tx_hash}:${t}`, t, buy: a.kind === "buy", usd, trader: a.tx_from_address ?? "", tx: a.tx_hash ?? "" };
    })
    .filter((x): x is ExtTrade => x !== null)
    .sort((a, b) => b.t - a.t);
}
