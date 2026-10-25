/**
 * The first trades of a Solana coin launched on sasa, read straight from Solana (sasa's node),
 * for the minutes before the market lists (GeckoTerminal) have the coin: the trade list and the
 * chart show from the very first trade.
 *
 * Light on the node: one call for the latest transactions of the coin's launch curve, then one
 * per transaction we haven't read yet (a transaction never changes, so each is read once).
 * Shared by the list and the chart, at most one read every 8 s per coin.
 */
import { SOL_RPC } from "./solana";
import type { RaceCandle } from "./race";
import type { ExtTrade } from "./extchart";

type Bal = { mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null; uiAmountString?: string } };
type Tx = {
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: Bal[];
    postTokenBalances?: Bal[];
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
  } | null;
  transaction: { message: { accountKeys: (string | { pubkey: string })[] } };
};

/** One trade on the curve: tokens (whole coins) and SOL moved, by whom. */
type CurveTrade = { sig: string; t: number; buy: boolean; tokens: number; sol: number; trader: string };

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(SOL_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message?: string } };
  if (!r.ok || j.error) throw new Error(j.error?.message ?? `Solana ${r.status}`);
  return j.result as T;
}

const READ = new Map<string, CurveTrade | null>(); // by signature (null: not a trade of this coin)
const LAST = new Map<string, { at: number; list: CurveTrade[] }>();
const INFLIGHT = new Map<string, Promise<CurveTrade[]>>();

/** Rent of a launch curve account (166 bytes): in the SOL of the coin's very first transaction. */
const CURVE_RENT = (128 + 166) * 6960;

function parse(sig: string, tx: Tx | null, mint: string, curve: string): CurveTrade | null {
  if (!tx || !tx.meta || tx.meta.err || !tx.blockTime) return null;
  // the transaction's own accounts, then any loaded from lookup tables (the balances follow this order)
  const keys = [
    ...tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey)),
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const signer = keys[0];
  const amount = (list: Bal[] | undefined) =>
    (list ?? []).filter((b) => b.mint === mint && b.owner === signer).reduce((n, b) => n + Number(b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount ?? 0), 0);
  const dTokens = amount(tx.meta.postTokenBalances) - amount(tx.meta.preTokenBalances);
  if (!dTokens) return null;
  // the SOL that went into (buy) or out of (sell) the curve itself: the trade's real size,
  // without network fees, trading fees or the rent of accounts the transaction opened
  const ci = keys.indexOf(curve);
  if (ci < 0) return null;
  const pre = tx.meta.preBalances[ci];
  const dSol = (tx.meta.postBalances[ci] - pre - (pre === 0 ? CURVE_RENT : 0)) / 1e9;
  const buy = dTokens > 0;
  const sol = Math.abs(dSol);
  if (!sol) return null;
  return { sig, t: tx.blockTime * 1000, buy, tokens: Math.abs(dTokens), sol, trader: signer };
}

/** The coin's latest curve trades (newest first). */
async function curveTrades(curve: string, mint: string): Promise<CurveTrade[]> {
  const k = `${curve}:${mint}`;
  const hit = LAST.get(k);
  if (hit && Date.now() - hit.at < 8_000) return hit.list;
  const running = INFLIGHT.get(k);
  if (running) return running;
  const p = (async () => {
    const sigs = await rpc<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [curve, { limit: 25, commitment: "confirmed" }]);
    const fresh = sigs.filter((s) => !s.err && !READ.has(s.signature));
    // read the new ones a few at a time
    for (let i = 0; i < fresh.length; i += 5) {
      await Promise.all(
        fresh.slice(i, i + 5).map(async (s) => {
          const tx = await rpc<Tx | null>("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]).catch(() => undefined);
          if (tx !== undefined) READ.set(s.signature, parse(s.signature, tx, mint, curve));
        })
      );
    }
    const list = sigs.map((s) => READ.get(s.signature)).filter((x): x is CurveTrade => !!x).sort((a, b) => b.t - a.t);
    LAST.set(k, { at: Date.now(), list });
    return list;
  })().finally(() => INFLIGHT.delete(k));
  INFLIGHT.set(k, p);
  return p;
}

/** SOL in dollars (Coinbase's public price), refreshed every minute. */
let solUsd: { at: number; v: number } | null = null;
async function solPrice(): Promise<number | null> {
  if (solUsd && Date.now() - solUsd.at < 60_000) return solUsd.v;
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot");
    const v = Number(((await r.json()) as { data?: { amount?: string } }).data?.amount);
    if (Number.isFinite(v) && v > 0) solUsd = { at: Date.now(), v };
  } catch {
    // keep the last one
  }
  return solUsd?.v ?? null;
}

/** The trade list's rows, from the curve. */
export async function fetchCurveTrades(curve: string, mint: string): Promise<ExtTrade[]> {
  const [list, usd] = await Promise.all([curveTrades(curve, mint), solPrice()]);
  return list.map((t) => ({ id: t.sig, t: t.t, buy: t.buy, usd: usd ? t.sol * usd : 0, trader: t.trader, tx: t.sig }));
}

/** Price candles (dollars per coin) of `frameSec`, from the curve trades. */
export async function fetchCurveCandles(curve: string, mint: string, frameSec: number): Promise<RaceCandle[]> {
  const [list, usd] = await Promise.all([curveTrades(curve, mint), solPrice()]);
  if (!usd || !list.length) return [];
  const rows = new Map<number, RaceCandle>();
  for (const t of [...list].sort((a, b) => a.t - b.t)) {
    const price = (t.sol / t.tokens) * usd;
    if (!Number.isFinite(price) || price <= 0) continue;
    const b = Math.floor(t.t / 1000 / frameSec) * frameSec;
    const c = rows.get(b);
    if (!c) rows.set(b, { t: b, open: price, high: price, low: price, close: price, volume: t.sol * usd });
    else {
      c.high = Math.max(c.high, price);
      c.low = Math.min(c.low, price);
      c.close = price;
      c.volume += t.sol * usd;
    }
  }
  return [...rows.values()].sort((a, b) => a.t - b.t);
}
