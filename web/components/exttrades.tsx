"use client";

/**
 * Who bought and sold a coin from another DEX (and sasa's Solana coins): the pool's latest
 * trades from GeckoTerminal, refreshed every 15 s while the page is open. The same trades go
 * onto the live chart (bursts at the tip, you and whales on the line).
 */
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "./wallet";
import { fetchExtTrades, type ExtTrade } from "@/lib/extchart";
import { solWalletOf } from "@/lib/solheld";
import { isSolExt, type ExtCoin } from "@/lib/extcoins";
import { shortAddr } from "@/lib/format";
import type { LiveTrade } from "./livechart";

const WHALE_USD = 500;
const TX: Record<string, string> = {
  base: "https://basescan.org/tx/",
  bsc: "https://bscscan.com/tx/",
  eth: "https://etherscan.io/tx/",
  robinhood: "https://explorer.chain.robinhood.com/tx/",
  arc: "https://arcscan.app/tx/",
  solana: "https://solscan.io/tx/",
};

/**
 * The pool's latest trades (null while the first load runs, [] when there are none). `curve`:
 * a sasa coin's launch curve, read straight from Solana while the market lists don't have the
 * coin yet (its first minutes).
 */
export function useExtTrades(coin: ExtCoin, curve?: string | null): ExtTrade[] | null {
  const [rows, setRows] = useState<ExtTrade[] | null>(null);
  const { network, pool, address } = coin;
  useEffect(() => {
    if (!pool && !curve) return setRows([]);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      let r: ExtTrade[] | null = null;
      if (pool) r = await fetchExtTrades(network, pool, address).catch(() => null);
      let fromCurve = false;
      if ((!r || !r.length) && curve) {
        const { fetchCurveTrades } = await import("@/lib/solcurvetrades");
        const c = await fetchCurveTrades(curve, address).catch(() => null);
        if (c && c.length) {
          r = c;
          fromCurve = true;
        }
      }
      if (!alive) return;
      setRows((cur) => r ?? cur ?? []);
      // a brand-new coin read from Solana: every 5 s; otherwise every 15 s
      timer = setTimeout(() => (document.visibilityState === "visible" ? void load() : (timer = setTimeout(load, 5_000))), fromCurve ? 5_000 : 15_000);
    };
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [network, pool, address, curve]);
  return rows;
}

/** The addresses that are "you" on this coin's chain (sasa address, and the Solana wallet). */
function useMine(coin: ExtCoin): Set<string> {
  const { address } = useWallet();
  return useMemo(() => {
    const s = new Set<string>();
    if (!address) return s;
    s.add(address.toLowerCase());
    if (isSolExt(coin.network)) {
      const sol = solWalletOf(address);
      if (sol) s.add(sol.toLowerCase());
    }
    return s;
  }, [address, coin.network]);
}

/** The same trades for the live chart. */
export function useExtLiveTrades(coin: ExtCoin, rows: ExtTrade[] | null): LiveTrade[] | undefined {
  const mine = useMine(coin);
  return useMemo(
    () =>
      rows?.map((r) => ({
        id: r.id,
        t: r.t,
        buy: r.buy,
        usd: r.usd,
        who: mine.has(r.trader.toLowerCase()) ? ("you" as const) : r.buy && r.usd >= WHALE_USD ? ("whale" as const) : null,
      })),
    [rows, mine]
  );
}

const ago = (t: number) => {
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
const usd = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);

/** The list under the chart: buy / sell, dollars, who, when (each opens on the explorer). */
export function ExtTradesList({ coin, rows }: { coin: ExtCoin; rows: ExtTrade[] | null }) {
  const mine = useMine(coin);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const tx = TX[coin.network];
  return (
    <section className="rounded-3xl border border-line bg-surface p-4 sm:p-5 min-w-0" aria-label="Latest trades">
      <h2 className="font-display font-semibold text-[1.0625rem]">Trades</h2>
      {rows === null ? (
        <div className="mt-3 flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-9 rounded-xl shimmer" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-[0.875rem] text-ink-3">No trades in the last 24 hours.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {rows.slice(0, 30).map((r) => {
            const me = mine.has(r.trader.toLowerCase());
            const row = (
              <>
                <span className={"w-10 shrink-0 font-semibold " + (r.buy ? "text-up" : "text-danger")}>{r.buy ? "Buy" : "Sell"}</span>
                <span className="w-20 shrink-0 font-mono tabular-nums text-ink">{usd(r.usd)}</span>
                <span className="flex-1 min-w-0 truncate font-mono text-ink-2">
                  {me ? <b className="font-sans text-emerald-dark">You</b> : shortAddr(r.trader)}
                  {!me && r.buy && r.usd >= WHALE_USD && <span className="ml-1.5 font-sans text-[0.75rem] font-semibold text-[#3b82f6]">whale</span>}
                </span>
                <span className="shrink-0 text-ink-3 tabular-nums">{ago(r.t)}</span>
              </>
            );
            return (
              <li key={r.id}>
                {tx && r.tx ? (
                  <a href={tx + r.tx} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 py-2.5 text-[0.8125rem] hover:bg-night/50 -mx-2 px-2 rounded-lg">
                    {row}
                  </a>
                ) : (
                  <div className="flex items-center gap-3 py-2.5 text-[0.8125rem]">{row}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
