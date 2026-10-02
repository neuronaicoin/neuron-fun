"use client";

import Link from "next/link";
import { useState } from "react";
import { useWallet } from "./wallet";
import { toast } from "./alerts";
import { CoinAvatar } from "./coins";
import { ordersAbi } from "@/lib/abis";
import { coinHref, type Coin } from "@/lib/data";
import { friendlyError } from "@/lib/format";
import { ORDER_COLOR, ORDER_LABEL, ordersChanged, useAutoPanelOpen, useMyOrders, type MyOrder } from "@/lib/myorders";
import { call } from "@/lib/tx";

const SHORT: Record<MyOrder["kind"], string> = { tp: "TP", sl: "SL", dip: "DIP" };

function describe(o: MyOrder): string {
  if (o.kind === "dip") return `$${(Number(o.amount) / 1e6).toFixed(2)} set aside, buys on a dip`;
  const out = Number(o.kind === "tp" ? o.minOut : o.maxOut) / 1e6;
  return o.kind === "tp" ? `Sells when it's worth $${out.toFixed(2)}` : `Sells if it falls to $${out.toFixed(2)}`;
}

function useCancel() {
  const { send } = useWallet();
  const [busy, setBusy] = useState<string>("");
  const cancel = async (o: MyOrder) => {
    if (!o.chain.orders) return;
    try {
      setBusy(`${o.chain.key}-${o.id}`);
      await send(o.chain.chain, [call(o.chain.orders, ordersAbi, "cancel", [o.id])], () => {});
      toast(o.kind === "dip" ? "Cancelled. Your money is back in your cash." : "Cancelled");
      ordersChanged();
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy("");
    }
  };
  return { busy, cancel };
}

function Row({ o, showCoin, busy, onCancel, lost }: { o: MyOrder; showCoin: boolean; busy: boolean; onCancel: () => void; lost?: string }) {
  return (
    <li className="flex items-center gap-3 py-2.5 border-t border-line first:border-t-0 min-w-0">
      {showCoin ? (
        <CoinAvatar logo={o.logo ?? ""} symbol={o.symbol ?? "?"} size={36} />
      ) : (
        <span className="h-7 px-2 shrink-0 rounded-lg text-white text-[0.75rem] font-bold flex items-center" style={{ background: ORDER_COLOR[o.kind] }}>
          {SHORT[o.kind]}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {showCoin && o.coinId ? (
          <Link href={coinHref({ id: o.coinId })} className="block font-semibold truncate hover:text-emerald">
            ${o.symbol ?? "?"} · {ORDER_LABEL[o.kind]}
          </Link>
        ) : (
          <span className="block font-semibold truncate">{ORDER_LABEL[o.kind]}</span>
        )}
        {lost ? (
          <span className="block text-[0.75rem] text-danger leading-snug">
            {o.chain.short} lost the race, so this can&apos;t fill. Cancel it and set it again on {lost}.
          </span>
        ) : (
          <span className="block text-[0.75rem] text-ink-3 truncate">
            {describe(o)} · {o.chain.short}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="h-8 px-3 shrink-0 rounded-lg border border-line bg-surface text-[0.8125rem] font-semibold hover:border-danger disabled:opacity-50"
      >
        {busy ? "…" : "Cancel"}
      </button>
    </li>
  );
}

/** Coin page: the user's open orders on this coin (shown under the trade box). */
export function CoinOrders({ coin }: { coin: Coin }) {
  const { address } = useWallet();
  const { orders } = useMyOrders(address);
  const { busy, cancel } = useCancel();
  const curves = new Set(coin.curves.map((c) => `${c.chain.chain.id}:${c.curve.toLowerCase()}`));
  const mine = (orders ?? []).filter((o) => curves.has(`${o.chain.chain.id}:${o.curve}`));
  const panelOpen = useAutoPanelOpen();
  if (!address || !mine.length || panelOpen) return null;
  return (
    <section className="rounded-3xl border border-line bg-surface p-4" aria-label="Your auto orders">
      <h2 className="font-display font-bold text-[1rem]">Your orders on ${coin.symbol}</h2>
      <ul className="mt-1">
        {mine.map((o) => (
          <Row
            key={`${o.chain.key}-${o.id}`}
            o={o}
            showCoin={false}
            busy={busy === `${o.chain.key}-${o.id}`}
            onCancel={() => void cancel(o)}
            lost={
              coin.graduatedOn && coin.curves.some((c) => c.chain.chain.id === o.chain.chain.id && c.state === "moved")
                ? coin.graduatedOn.chain.short
                : undefined
            }
          />
        ))}
      </ul>
    </section>
  );
}

/** You page: every open order, on every coin. */
export function AllOrders() {
  const { address } = useWallet();
  const { orders } = useMyOrders(address);
  const { busy, cancel } = useCancel();
  if (!address || !orders || !orders.length) return null;
  return (
    <section className="rounded-3xl border border-line bg-surface p-4 sm:p-5" aria-label="Open orders">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display font-bold text-[1.125rem]">Open orders</h2>
        <span className="text-[0.75rem] text-ink-3">{orders.length} waiting</span>
      </div>
      <ul className="mt-1">
        {orders.map((o) => (
          <Row key={`${o.chain.key}-${o.id}`} o={o} showCoin busy={busy === `${o.chain.key}-${o.id}`} onCancel={() => void cancel(o)} />
        ))}
      </ul>
    </section>
  );
}
