"use client";

import { parseAbi } from "viem";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { call, type Call } from "@/lib/tx";
import { useWallet } from "./wallet";
import { ChainChip } from "./coins";
import { curveAbi, migratorAbi, tokenAbi } from "@/lib/abis";
import { clientFor, type Coin, type CurveInfo } from "@/lib/data";
import { fmtEth, friendlyError } from "@/lib/format";
import { migratorFor } from "@/lib/contracts";

const ANYONE: Address = "0x000000000000000000000000000000000000c0de";

type Row = {
  curve: CurveInfo;
  waiting: bigint; // creator share still in the curve
  poolFees: bigint | null; // uncollected pool fees (graduated chain)
  buybackFund: bigint | null; // migrator fund (graduated chain, buyback mode)
  migrator: Address; // this coin's own migrator (older coins keep theirs)
  claimable: bigint | null; // your holder rewards on this chain
};

const COPY = {
  creator: {
    title: "Creator's share",
    text: "The creator keeps their share: 0.3% of every trade is saved for them below. Anyone can send it to the creator's wallet; it never goes anywhere else.",
  },
  buyback: {
    title: "Buyback & burn",
    text: "The creator chose \"Buyback & burn\": 0.3% of every trade buys this coin back and burns it. Anyone can run a buyback.",
  },
  holders: { title: "Rewards for holders", text: "0.3% of every trade is paid out to holders in USDC, in proportion to what they hold." },
} as const;

/**
 * Shows where this coin's creator share goes and lets anyone move it along:
 * collect for the creator, share with holders, or run a buyback. Holders see
 * and claim their own rewards here.
 */
const migratorV6BuybackAbi = parseAbi(["function buybackFunds(bytes32 coin) view returns (uint256)"]);

export function FeeBox({ coin, onChange }: { coin: Coin; onChange: () => void }) {
  const { address, send: sendCalls } = useWallet();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const mode = coin.feeMode;
  const isCreator = !!address && address.toLowerCase() === coin.creator.toLowerCase();

  const load = useCallback(async () => {
    const out = await Promise.all(
      coin.curves.map(async (c): Promise<Row> => {
        const pub = clientFor(c.chain);
        const waiting = (await pub
          .readContract({ address: c.curve, abi: curveAbi, functionName: "creatorFees" })
          .catch(() => 0n)) as bigint;
        let poolFees: bigint | null = null;
        let buybackFund: bigint | null = null;
        const migrator = c.state === "graduated" ? await migratorFor(c) : c.chain.migrator;
        if (c.state === "graduated") {
          poolFees = await pub
            .simulateContract({ account: ANYONE, address: migrator, abi: migratorAbi, functionName: "collectFees", args: [c.token] })
            .then((r) => (r.result as readonly [bigint, bigint])[0])
            .catch(() => null);
          if (mode === "buyback") {
            buybackFund = (await pub
              .readContract({
                address: migrator,
                // v6 keeps buyback money per coin id (the coin's launch key here); v5 per token.
                abi: (coin.omni ? migratorV6BuybackAbi : migratorAbi) as typeof migratorAbi,
                functionName: "buybackFunds",
                args: [(coin.omni ? coin.launchKey : c.token) as Address],
              })
              .catch(() => null)) as bigint | null;
          }
        }
        const claimable =
          mode === "holders" && address
            ? ((await pub.readContract({ address: c.token, abi: tokenAbi, functionName: "claimable", args: [address] }).catch(() => null)) as bigint | null)
            : null;
        return { curve: c, waiting, poolFees, buybackFund, claimable, migrator };
      })
    );
    setRows(out);
  }, [coin.curves, mode, address]);

  useEffect(() => {
    load().catch(() => {});
    const t = setInterval(() => load().catch(() => {}), 20_000);
    return () => clearInterval(t);
  }, [load]);

  async function send(key: string, c: CurveInfo, one: Call, doneText: string) {
    if (!address) return;
    setError("");
    setDone("");
    try {
      setBusy(key);
      await sendCalls(c.chain.chain, [one]);
      setDone(doneText);
      await load();
      onChange();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  const moveLabel = (c: CurveInfo) =>
    mode === "holders"
      ? "Share with holders"
      : mode === "buyback"
        ? c.state === "trading"
          ? "Run buyback"
          : c.state === "graduated"
            ? "Send to pool buyback"
            : "Pay out to creator"
        : "Pay out to creator";

  // In creator mode only the creator needs this box.
  if (mode === "creator" && !isCreator) return null;

  return (
    <div className="bg-surface border border-line rounded-3xl p-5 sm:p-6">
      <h2 className="font-display font-bold text-[1.125rem]">{COPY[mode].title}</h2>
      <p className="text-[0.875rem] text-ink-2 mt-1">{COPY[mode].text}</p>

      {!rows && <div className="mt-4 h-16 rounded-2xl bg-paper animate-pulse" />}

      {rows && mode === "holders" && address && (
        <div className="mt-4 rounded-2xl bg-paper p-4">
          <div className="text-[0.8125rem] text-ink-3">Your rewards</div>
          <ul className="mt-2 grid gap-2">
            {rows.map((r) => (
              <li key={r.curve.chain.key} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <ChainChip chain={r.curve.chain} />
                  <span className="font-mono text-[0.9375rem]">{fmtEth(r.claimable ?? 0n, 6)}</span>
                </span>
                <button
                  type="button"
                  disabled={!r.claimable || !!busy}
                  onClick={() =>
                    send(`claim-${r.curve.chain.key}`, r.curve, call(r.curve.token, tokenAbi, "claim", [address]), "Rewards sent to your wallet.")
                  }
                  className="h-9 px-3 rounded-xl bg-up text-on-accent text-[0.875rem] font-semibold whitespace-nowrap shrink-0 disabled:opacity-40"
                >
                  {busy === `claim-${r.curve.chain.key}` ? "…" : "Claim"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows && (
        <ul className="mt-4 grid gap-3">
          {rows.map((r) => {
            const c = r.curve;
            return (
              <li key={c.chain.key} className="grid gap-2">
                {r.waiting > 0n && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-x-2 gap-y-1 flex-wrap min-w-0 text-[0.875rem]">
                      <ChainChip chain={c.chain} muted={c.state === "closed"} />
                      <span className="text-ink-3">saved for the creator</span>
                      <span className="font-mono">{fmtEth(r.waiting, 6)}</span>
                    </span>
                    <button
                      type="button"
                      disabled={!address || !!busy}
                      onClick={() =>
                        send(`move-${c.chain.key}`, c, call(c.curve, curveAbi, "claimCreatorFees"), "Done.")
                      }
                      className="h-9 px-3 rounded-xl bg-emerald text-on-accent text-[0.8125rem] font-semibold whitespace-nowrap shrink-0 disabled:opacity-40"
                    >
                      {busy === `move-${c.chain.key}` ? "…" : moveLabel(c)}
                    </button>
                  </div>
                )}
                {r.poolFees !== null && r.poolFees > 0n && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-x-2 gap-y-1 flex-wrap min-w-0 text-[0.875rem]">
                      <ChainChip chain={c.chain} />
                      <span className="text-ink-3">pool fees</span>
                      <span className="font-mono">{fmtEth(r.poolFees, 6)}</span>
                    </span>
                    <button
                      type="button"
                      disabled={!address || !!busy}
                      onClick={() =>
                        send(`collect-${c.chain.key}`, c, call(r.migrator, migratorAbi, "collectFees", [c.token]), "Pool fees collected.")
                      }
                      className="h-9 px-3 rounded-xl border border-line text-[0.8125rem] font-semibold whitespace-nowrap shrink-0 disabled:opacity-40"
                    >
                      {busy === `collect-${c.chain.key}` ? "…" : "Collect"}
                    </button>
                  </div>
                )}
                {r.buybackFund !== null && r.buybackFund > 0n && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-x-2 gap-y-1 flex-wrap min-w-0 text-[0.875rem]">
                      <ChainChip chain={c.chain} />
                      <span className="text-ink-3">buyback fund</span>
                      <span className="font-mono">{fmtEth(r.buybackFund, 6)}</span>
                    </span>
                    <button
                      type="button"
                      disabled={!address || !!busy}
                      onClick={() =>
                        send(`buyback-${c.chain.key}`, c, call(r.migrator, migratorAbi, "buyback", [c.token]), "Bought back and burned.")
                      }
                      className="h-9 px-3 rounded-xl bg-emerald text-on-accent text-[0.8125rem] font-semibold whitespace-nowrap shrink-0 disabled:opacity-40"
                    >
                      {busy === `buyback-${c.chain.key}` ? "…" : "Run buyback"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {rows && rows.every((r) => r.waiting === 0n && !r.poolFees && !r.buybackFund) && (
        <p className="text-[0.8125rem] text-ink-3 mt-3">Nothing waiting right now. Fees build up with every trade.</p>
      )}
      {!address && mode !== "creator" && <p className="text-[0.75rem] text-ink-3 mt-3">Connect a wallet to run these. Anyone can.</p>}
      {error && <p className="mt-3 text-[0.8125rem] text-danger">{error}</p>}
      {done && <p className="mt-3 text-[0.8125rem] text-up">{done}</p>}
    </div>
  );
}
