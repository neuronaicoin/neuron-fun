"use client";

/**
 * Admin: what sasa earns from the coins launched on Solana and from trades made on the site.
 *  - Creator fees: every buy and sell of a sasa Solana coin (on any app) pays the coin's creator
 *    fee; half of it goes to sasa. The keeper (indexer/solkeeper.mjs) pays it out and records it.
 *  - sasa's trading fee: buys and sells made on sasa go through Relay with sasa's fee on top;
 *    Relay holds what hasn't been claimed yet.
 */
import { useCallback, useEffect, useState } from "react";
import { useWallet } from "./wallet";
import { authedGet } from "@/lib/alerts";
import { friendlyError } from "@/lib/format";
import { RELAY_FEE_TO } from "@/lib/config";

type SolFeeCoin = {
  mint: string;
  name: string | null;
  symbol: string | null;
  kind: string;
  status: string;
  created_at: string;
  paid_at: string | null;
  paid_lamports: number | string;
  payouts: number;
  mcap_usd: number | null;
};

const LAMPORTS = 1e9;
const money = (v: number) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sol = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 4 }) + " SOL";

export function SolFeesPanel() {
  const { address, signMessage } = useWallet();
  const [coins, setCoins] = useState<SolFeeCoin[] | null>(null);
  const [treasury, setTreasury] = useState<string | null>(null);
  const [solUsd, setSolUsd] = useState<number | null>(null);
  const [relay, setRelay] = useState<number | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const r = await authedGet<{ coins: SolFeeCoin[]; treasury: string | null }>(signMessage, "bot/solfees");
      setCoins(r.coins ?? []);
      setTreasury(r.treasury);
    } catch (e) {
      setError(friendlyError(e));
    }
    fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot")
      .then((r) => r.json())
      .then((j: { data?: { amount?: string } }) => setSolUsd(Number(j?.data?.amount) || null))
      .catch(() => {});
    fetch(`https://api.relay.link/app-fees/${RELAY_FEE_TO}/balances`)
      .then((r) => r.json())
      .then((j: { balances?: { amountUsd?: number | string }[] }) => setRelay((j.balances ?? []).reduce((s, b) => s + (Number(b.amountUsd) || 0), 0)))
      .catch(() => setRelay(null));
  }, [signMessage]);

  useEffect(() => {
    if (!address) return;
    void load();
  }, [address, load]);

  // the keeper records every payout in full: sasa's part is half of it
  const sasaSol = (c: SolFeeCoin) => Number(c.paid_lamports || 0) / LAMPORTS / 2;
  const totalSol = (coins ?? []).reduce((s, c) => s + sasaSol(c), 0);
  const usdOf = (v: number) => (solUsd ? money(v * solUsd) : "…");

  return (
    <section className="rounded-3xl border border-line bg-surface p-4 sm:p-6 flex flex-col gap-4 min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display font-bold text-[1.375rem]">Solana coins &amp; trading fees</h2>
          <p className="text-ink-3 text-[0.875rem]">
            Every buy and sell of a coin launched on sasa pays its creator fee, half to sasa. Trades made on sasa also pay sasa&apos;s trading fee.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="h-9 px-4 rounded-full border border-line text-[0.875rem] shrink-0">
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <div className="rounded-2xl bg-night p-3 sm:p-4 min-w-0">
          <div className="text-[0.75rem] text-ink-3">sasa&apos;s half of creator fees, paid</div>
          <div className="font-display font-bold text-[1.25rem] truncate">{coins === null ? "…" : usdOf(totalSol)}</div>
          <div className="text-[0.75rem] text-ink-3">{coins === null ? "" : sol(totalSol)} · paid out every 30 min</div>
        </div>
        <div className="rounded-2xl bg-night p-3 sm:p-4 min-w-0">
          <div className="text-[0.75rem] text-ink-3">Trading fees waiting at Relay</div>
          <div className="font-display font-bold text-[1.25rem] truncate">{relay === null ? "…" : money(relay)}</div>
          <div className="text-[0.75rem] text-ink-3">All chains, not claimed yet</div>
        </div>
        <div className="rounded-2xl bg-night p-3 sm:p-4 min-w-0 col-span-2 lg:col-span-1">
          <div className="text-[0.75rem] text-ink-3">Coins launched on Solana</div>
          <div className="font-display font-bold text-[1.25rem]">{coins === null ? "…" : coins.length}</div>
          {treasury && (
            <a href={`https://solscan.io/account/${treasury}`} target="_blank" rel="noreferrer" className="text-[0.75rem] text-emerald font-semibold hover:underline break-all">
              Solana treasury ↗
            </a>
          )}
        </div>
      </div>

      {error && <p className="text-[0.8125rem] text-danger">{error}</p>}

      {coins && coins.length > 0 && (
        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full text-[0.8125rem] min-w-[34rem]">
            <thead>
              <tr className="text-ink-3 text-left">
                <th className="py-1 pr-3 font-normal">Coin</th>
                <th className="py-1 pr-3 font-normal">Launched</th>
                <th className="py-1 pr-3 font-normal text-right">sasa earned</th>
                <th className="py-1 pr-3 font-normal text-right">Payouts</th>
                <th className="py-1 font-normal text-right">Market cap</th>
              </tr>
            </thead>
            <tbody>
              {coins.map((c) => (
                <tr key={c.mint} className="border-t border-line">
                  <td className="py-2 pr-3">
                    <a href={`https://solscan.io/token/${c.mint}`} target="_blank" rel="noreferrer" className="font-semibold hover:underline">
                      {c.name || c.mint.slice(0, 6)} <span className="text-ink-3 font-normal">${c.symbol}</span>
                    </a>
                    {c.kind !== "pump" && <span className="ml-1.5 text-[0.6875rem] text-ink-3">{c.kind}</span>}
                  </td>
                  <td className="py-2 pr-3 text-ink-3 whitespace-nowrap">{new Date(c.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</td>
                  <td className="py-2 pr-3 text-right whitespace-nowrap">
                    <b>{usdOf(sasaSol(c))}</b>
                    <div className="text-ink-3">{sol(sasaSol(c))}</div>
                  </td>
                  <td className="py-2 pr-3 text-right">{c.payouts}</td>
                  <td className="py-2 text-right whitespace-nowrap">{c.mcap_usd ? money(c.mcap_usd) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {coins && coins.length === 0 && <p className="text-[0.875rem] text-ink-3">No Solana coins yet.</p>}
    </section>
  );
}
