"use client";

/**
 * "Buyback & burn" coins: how full the next buyback is. The creator's share of every trade
 * collects in sasa's RaceBuilder on the chain (buybackFunds); each time it reaches one chunk
 * (BUYBACK_CHUNK, $100) sasa's keeper spends it on the coin and burns what it bought.
 * Read straight from the chain every 15 s. Nothing shows when it can't be read.
 */
import { useEffect, useState } from "react";
import { parseAbi, type Address } from "viem";
import { raceClient, type RaceChain } from "@/lib/race";

const builderAbi = parseAbi(["function buybackFunds(address coin) view returns (uint256)", "function BUYBACK_CHUNK() view returns (uint256)"]);
const erc20Abi = parseAbi(["function decimals() view returns (uint8)"]);

export function RaceBuyback({ chain, coin }: { chain: RaceChain; coin: Address }) {
  const [v, setV] = useState<{ fund: number; chunk: number } | null>(null);
  useEffect(() => {
    const builder = chain.builder;
    if (!builder) return;
    let alive = true;
    const c = raceClient(chain);
    const load = async () => {
      try {
        const [fund, chunk, dec] = await Promise.all([
          c.readContract({ address: builder, abi: builderAbi, functionName: "buybackFunds", args: [coin] }),
          c.readContract({ address: builder, abi: builderAbi, functionName: "BUYBACK_CHUNK" }),
          c.readContract({ address: chain.usd, abi: erc20Abi, functionName: "decimals" }),
        ]);
        const k = 10 ** Number(dec);
        if (alive && chunk > 0n) setV({ fund: Number(fund) / k, chunk: Number(chunk) / k });
      } catch {
        // not readable here: no bar
      }
    };
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [chain, coin]);
  if (!v) return null;
  const pct = Math.min(100, (v.fund / v.chunk) * 100);
  const usd = (n: number) => `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;
  return (
    <section className="rounded-2xl border border-emerald/40 bg-emerald-soft/60 px-4 py-3 flex flex-col gap-2" aria-label="Buyback progress">
      <div className="flex items-baseline justify-between gap-3">
        <b className="text-[0.9375rem] text-emerald-dark">Buyback progress</b>
        <span className="font-mono tabular-nums text-[0.8125rem] text-ink-2">
          {usd(v.fund)} / {usd(v.chunk)} · {pct.toFixed(0)}%
        </span>
      </div>
      <div className="h-2 rounded-full bg-night overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className="h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none" style={{ width: `${pct}%`, background: "linear-gradient(90deg, var(--color-emerald), var(--color-mint))" }} />
      </div>
      <p className="text-[0.75rem] text-ink-3">The creator&apos;s share of every trade fills this. When it&apos;s full, the coin is bought back on {chain.short} and burned.</p>
    </section>
  );
}
