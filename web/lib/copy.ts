/**
 * Copy trading on the client. A trader lets followers copy them; a follower
 * copies a trader with a dollar amount or a share of the trader's trade.
 * Each trade becomes a signal the follower applies or rejects. Private data
 * (your signals, your settings) goes through /api/social with the session;
 * the public board comes straight from the database.
 */
import { ensureSession, type SignFn } from "./alerts";
import { db } from "./data";
import { forgetProfile, socialApi } from "./social";

export type CopyMode = "fixed" | "pct";
export type CopySetting = { trader: string; mode: CopyMode; amount: number; copySells: boolean };
export type CopyResult = { trader: string; applied: number; rejected: number; paid: number; worth: number };

export type Signal = {
  id: number;
  trader: string;
  coinId: string;
  chainId: number;
  curve: string;
  isBuy: boolean;
  traderNative: number;
  /** Native per token the trader paid or got. */
  traderPrice: number;
  traderUsd: number | null;
  suggestUsd: number | null;
  sellPct: number | null;
  status: "pending" | "applied" | "rejected";
  appliedTx: string | null;
  createdAt: string;
  coin: { name: string; symbol: string; logo: string } | null;
};

type SigRow = {
  id: number;
  trader: string;
  coin_id: string;
  chain_id: number;
  curve: string;
  is_buy: boolean;
  trader_native: number | string;
  trader_price: number | string;
  trader_usd: number | string | null;
  suggest_usd: number | string | null;
  sell_pct: number | string | null;
  status: Signal["status"];
  applied_tx: string | null;
  created_at: string;
};

const num = (v: number | string | null) => (v === null || v === undefined ? null : Number(v));

export async function setAllowCopy(sign: SignFn, me: string, on: boolean): Promise<boolean> {
  await ensureSession(sign);
  const j = await socialApi<{ allowCopy: boolean }>("allow-copy", { on });
  forgetProfile(me);
  return j.allowCopy;
}

export async function saveCopy(sign: SignFn, trader: string, s: Omit<CopySetting, "trader"> | null): Promise<void> {
  await ensureSession(sign);
  await socialApi("copy", s ? { trader, on: true, mode: s.mode, amount: s.amount, copySells: s.copySells } : { trader, on: false });
  forgetProfile(trader);
}

export async function fetchCopying(sign: SignFn): Promise<{ copying: CopySetting[]; results: CopyResult[] }> {
  await ensureSession(sign);
  const j = await socialApi<{
    copying: { trader: string; mode: CopyMode; amount: number | string; copy_sells: boolean }[];
    results: { trader: string; applied: number; rejected: number; paid: number | string; worth: number | string }[];
  }>("copy-list", {});
  return {
    copying: j.copying.map((r) => ({ trader: r.trader, mode: r.mode, amount: Number(r.amount), copySells: r.copy_sells })),
    results: j.results.map((r) => ({ trader: r.trader, applied: r.applied, rejected: r.rejected, paid: Number(r.paid), worth: Number(r.worth) })),
  };
}

export async function fetchSignals(sign: SignFn): Promise<Signal[]> {
  await ensureSession(sign);
  const j = await socialApi<{ signals: SigRow[]; coins: { id: string; name: string; symbol: string; logo: string }[] }>("signals", {});
  const coins = new Map(j.coins.map((c) => [c.id, c]));
  return j.signals.map((r) => ({
    id: Number(r.id),
    trader: r.trader,
    coinId: r.coin_id,
    chainId: r.chain_id,
    curve: r.curve,
    isBuy: r.is_buy,
    traderNative: Number(r.trader_native),
    traderPrice: Number(r.trader_price),
    traderUsd: num(r.trader_usd),
    suggestUsd: num(r.suggest_usd),
    sellPct: num(r.sell_pct),
    status: r.status,
    appliedTx: r.applied_tx,
    createdAt: r.created_at,
    coin: coins.get(r.coin_id) ?? null,
  }));
}

export async function actOnSignal(sign: SignFn, id: number, action: "apply" | "reject", tx?: string): Promise<void> {
  await ensureSession(sign);
  await socialApi("signal", { id, action, tx });
}

export type BoardRow = { trader: string; copiers: number; applied: number; avgReturn: number | null; earned: number };

/** "Best to copy": traders ranked by how their copiers' buys did. */
export async function fetchCopyBoard(days = 30): Promise<BoardRow[]> {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const { data, error } = await db.rpc("copy_board", { p_since: since, p_limit: 50 });
  if (error) throw error;
  return ((data ?? []) as { trader: string; copiers: number; applied: number; avg_return: number | string | null; earned: number | string }[]).map(
    (r) => ({ trader: r.trader, copiers: r.copiers, applied: r.applied, avgReturn: num(r.avg_return), earned: Number(r.earned) })
  );
}
