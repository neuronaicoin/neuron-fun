import { IS_TESTNET } from "./config";
import { db } from "./data";

/**
 * Stats for trades of other DEXs' coins. After a trade the page tells the API its transaction;
 * the API checks it on chain and with Relay before it counts (edge/exttrade-api.js). A trade to
 * another chain takes a few seconds to finish, so the page asks again a few times.
 */
const NETWORK_CHAIN: Record<string, number> = { base: 8453, bsc: 56, robinhood: 4663, arc: 5042 };

export async function reportExtTrade(t: { chainId: number; tx: string; network: string; coin: string; side: "buy" | "sell" }) {
  if (IS_TESTNET) return;
  const coinChain = NETWORK_CHAIN[t.network];
  if (!coinChain) return;
  const body = JSON.stringify({ chainId: t.chainId, tx: t.tx, side: t.side, coin: t.coin, coinChain });
  for (const wait of [4000, 15000, 45000, 120000]) {
    await new Promise((r) => setTimeout(r, wait));
    try {
      const r = await fetch("/api/exttrade", { method: "POST", headers: { "content-type": "application/json" }, body });
      const j = (await r.json().catch(() => ({}))) as { pending?: boolean };
      if (!r.ok || !j.pending) return;
    } catch {
      /* try again */
    }
  }
}

export type ExtStats = {
  recent: { volume: number; trades: number; traders: number };
  all: { volume: number; trades: number; traders: number };
  chains: { chainId: number; volume: number; trades: number }[];
};

/** Other DEXs' coins traded on sasa: last 24 hours and all time. */
export async function fetchExtStats(): Promise<ExtStats> {
  const { data, error } = await db.rpc("ext_stats", { p_since: new Date(Date.now() - 24 * 3600e3).toISOString() });
  if (error) throw error;
  const d = (data ?? {}) as Record<string, Record<string, unknown> | Record<string, unknown>[]>;
  const tot = (x: unknown) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return { volume: Number(o.volume ?? 0), trades: Number(o.trades ?? 0), traders: Number(o.traders ?? 0) };
  };
  return {
    recent: tot(d.recent),
    all: tot(d.all),
    chains: ((d.chains ?? []) as Record<string, unknown>[]).map((c) => ({ chainId: Number(c.chain_id), volume: Number(c.volume ?? 0), trades: Number(c.trades ?? 0) })),
  };
}
