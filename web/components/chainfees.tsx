"use client";

/**
 * Admin: what sasa earned on the other chains, like the Solana panel (components/solfees.tsx).
 *  - Race coins (Base, BNB, Robinhood, Arc): every trade pays the pool fee; each collection sends
 *    70% to sasa and 30% to the coin's side (contracts-v7 RaceBuilder*, CREATOR_SIDE_BPS).
 *    indexer/race.mjs records every collection (race_fees).
 *  - Elysium: sasa's launch fee on every coin, plus sasa's share of each coin's pool fees,
 *    read straight from the launcher (contracts-elysium/src/SasaV3Launcher.sol).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, parseAbi, type Address } from "viem";
import { useWallet } from "./wallet";
import { authedGet } from "@/lib/alerts";
import { friendlyError } from "@/lib/format";
import { fetchPrices } from "@/lib/price";
import { RACE_CHAINS, raceHref } from "@/lib/race";
import { ELYSIUM, elysiumClient, launcherAbi } from "@/lib/elysium";

type Row = { coin_id: string; chain_id: number; native: number; collections: number; last: string; name: string | null; symbol: string | null; launched: string | null };

const SASA_SIDE = 0.7;
const money = (v: number) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amt = (v: number, sym: string) => (sym === "USDC" ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v.toLocaleString("en-US", { maximumFractionDigits: 6 })) + " " + sym;

function chainOf(id: number) {
  return RACE_CHAINS.find((c) => c.chainId === id) ?? null;
}

export function RaceFeesPanel() {
  const { address, signMessage } = useWallet();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [prices, setPrices] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const r = await authedGet<{ rows: Row[] }>(signMessage, "bot/racefees");
      setRows(r.rows ?? []);
    } catch (e) {
      setError(friendlyError(e));
    }
    fetchPrices().then(setPrices).catch(() => {});
  }, [signMessage]);

  useEffect(() => {
    if (!address) return;
    void load();
  }, [address, load]);

  const sym = (id: number) => chainOf(id)?.chain.nativeCurrency.symbol ?? "?";
  const usdOf = useCallback(
    (id: number, v: number) => {
      const s = sym(id);
      if (s === "USDC" || s === "USD") return v;
      const p = prices?.[s];
      return p ? v * p : null;
    },
    [prices]
  );
  const sasaUsd = (r: Row) => usdOf(r.chain_id, r.native * SASA_SIDE);

  // per chain totals
  const perChain = useMemo(() => {
    const m = new Map<number, { native: number; coins: number }>();
    for (const r of rows ?? []) {
      const o = m.get(r.chain_id) ?? { native: 0, coins: 0 };
      o.native += r.native * SASA_SIDE;
      o.coins += 1;
      m.set(r.chain_id, o);
    }
    return [...m.entries()].sort((a, b) => (usdOf(b[0], b[1].native) ?? 0) - (usdOf(a[0], a[1].native) ?? 0));
  }, [rows, usdOf]);
  const total = perChain.reduce((s, [id, o]) => s + (usdOf(id, o.native) ?? 0), 0);
  const sorted = useMemo(() => [...(rows ?? [])].sort((a, b) => (sasaUsd(b) ?? 0) - (sasaUsd(a) ?? 0)), [rows, prices]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="rounded-3xl border border-line bg-surface p-4 sm:p-6 flex flex-col gap-4 min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display font-bold text-[1.375rem]">Race coins: Base, BNB, Robinhood, Arc</h2>
          <p className="text-ink-3 text-[0.875rem]">Every trade pays the pool fee. Each collection sends 70% to sasa and 30% to the coin&apos;s side. Fees not collected yet are under &quot;Fees waiting in pools&quot; above.</p>
        </div>
        <button type="button" onClick={() => void load()} className="h-9 px-4 rounded-full border border-line text-[0.875rem] shrink-0">
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="rounded-2xl bg-night p-3 sm:p-4 min-w-0 col-span-2 lg:col-span-1">
          <div className="text-[0.75rem] text-ink-3">sasa&apos;s 70%, collected</div>
          <div className="font-display font-bold text-[1.25rem] truncate">{rows === null || !prices ? "…" : money(total)}</div>
          <div className="text-[0.75rem] text-ink-3">{rows === null ? "" : `${rows.length} coin pools`}</div>
        </div>
        {perChain.map(([id, o]) => {
          const u = usdOf(id, o.native);
          return (
            <div key={id} className="rounded-2xl bg-night p-3 sm:p-4 min-w-0">
              <div className="text-[0.75rem] text-ink-3">{chainOf(id)?.short ?? id}</div>
              <div className="font-display font-bold text-[1.125rem] truncate">{u === null ? "…" : money(u)}</div>
              <div className="text-[0.75rem] text-ink-3 truncate">{amt(o.native, sym(id))}</div>
            </div>
          );
        })}
      </div>

      {error && <p className="text-[0.8125rem] text-danger">{error}</p>}

      {sorted.length > 0 && (
        <div className="overflow-x-auto -mx-1 px-1 max-h-[32rem] overflow-y-auto">
          <table className="w-full text-[0.8125rem] min-w-[34rem]">
            <thead className="sticky top-0 bg-surface">
              <tr className="text-ink-3 text-left">
                <th className="py-1 pr-3 font-normal">Coin</th>
                <th className="py-1 pr-3 font-normal">Chain</th>
                <th className="py-1 pr-3 font-normal">Launched</th>
                <th className="py-1 pr-3 font-normal text-right">sasa earned</th>
                <th className="py-1 font-normal text-right">Collections</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const u = sasaUsd(r);
                return (
                  <tr key={r.coin_id + r.chain_id} className="border-t border-line">
                    <td className="py-2 pr-3">
                      <a href={raceHref(r.coin_id)} className="font-semibold hover:underline">
                        {r.name || r.coin_id.slice(0, 8)} {r.symbol && <span className="text-ink-3 font-normal">${r.symbol}</span>}
                      </a>
                    </td>
                    <td className="py-2 pr-3">{chainOf(r.chain_id)?.short ?? r.chain_id}</td>
                    <td className="py-2 pr-3 text-ink-3 whitespace-nowrap">{r.launched ? new Date(r.launched).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—"}</td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">
                      <b>{u === null ? "…" : money(u)}</b>
                      <div className="text-ink-3">{amt(r.native * SASA_SIDE, sym(r.chain_id))}</div>
                    </td>
                    <td className="py-2 text-right">{r.collections}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length === 0 && <p className="text-[0.875rem] text-ink-3">No fees collected yet.</p>}
    </section>
  );
}

const elyExtra = parseAbi(["function treasury() view returns (address)"]);

export function ElysiumFeesPanel() {
  const [d, setD] = useState<{ coins: number; launchFee: bigint; treasury: Address; balance: bigint } | null>(null);
  const [hype, setHype] = useState<number | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const c = elysiumClient();
      const [coins, launchFee, treasury] = await Promise.all([
        c.readContract({ address: ELYSIUM.launcher, abi: launcherAbi, functionName: "coinCount" }),
        c.readContract({ address: ELYSIUM.launcher, abi: launcherAbi, functionName: "launchFee" }),
        c.readContract({ address: ELYSIUM.launcher, abi: elyExtra, functionName: "treasury" }),
      ]);
      const balance = await c.getBalance({ address: treasury });
      setD({ coins: Number(coins), launchFee, treasury, balance });
    } catch (e) {
      setError(friendlyError(e));
    }
    fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }) })
      .then((r) => r.json())
      .then((j: Record<string, string>) => setHype(Number(j?.HYPE) || null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const h = (v: bigint) => Number(formatUnits(v, 18));
  const usd = (v: bigint) => (hype ? money(h(v) * hype) : "…");
  const launchIncome = d ? d.launchFee * BigInt(d.coins) : 0n;

  return (
    <section className="rounded-3xl border border-line bg-surface p-4 sm:p-6 flex flex-col gap-4 min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display font-bold text-[1.375rem]">Elysium</h2>
          <p className="text-ink-3 text-[0.875rem]">sasa gets the launch fee of every coin and its share of each coin&apos;s pool fees, paid in HYPE to the treasury.</p>
        </div>
        <button type="button" onClick={() => void load()} className="h-9 px-4 rounded-full border border-line text-[0.875rem] shrink-0">
          Refresh
        </button>
      </div>
      {error && <p className="text-[0.8125rem] text-danger">{error}</p>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-2xl bg-night p-3 sm:p-4 min-w-0">
          <div className="text-[0.75rem] text-ink-3">Coins launched</div>
          <div className="font-display font-bold text-[1.25rem]">{d ? d.coins : "…"}</div>
        </div>
        <div className="rounded-2xl bg-night p-3 sm:p-4 min-w-0">
          <div className="text-[0.75rem] text-ink-3">Launch fees earned</div>
          <div className="font-display font-bold text-[1.25rem] truncate">{d ? usd(launchIncome) : "…"}</div>
          <div className="text-[0.75rem] text-ink-3">{d ? `${h(d.launchFee)} HYPE a coin` : ""}</div>
        </div>
        <div className="rounded-2xl bg-night p-3 sm:p-4 min-w-0 col-span-2">
          <div className="text-[0.75rem] text-ink-3">In the Elysium treasury now</div>
          <div className="font-display font-bold text-[1.25rem] truncate">{d ? usd(d.balance) : "…"}</div>
          <div className="text-[0.75rem] text-ink-3 truncate">
            {d ? `${h(d.balance).toLocaleString("en-US", { maximumFractionDigits: 4 })} HYPE · ${d.treasury.slice(0, 6)}…${d.treasury.slice(-4)}` : ""}
          </div>
        </div>
      </div>
    </section>
  );
}
