"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { ordersAbi } from "./abis";
import { CHAINS, type NeuronChain } from "./config";
import { clientFor, db } from "./data";

/** One of the user's open auto orders (take profit, stop loss or buy the dip). */
export type MyOrder = {
  id: bigint;
  chain: NeuronChain;
  curve: string; // lower-case
  kind: "tp" | "sl" | "dip";
  amount: bigint; // tokens for a sell, dollars (6 decimals) for a dip buy
  minOut: bigint;
  maxOut: bigint;
  /** Price per whole token (dollars, raw 6/18 ratio like virtualNative/virtualToken) where it fills. */
  trigger: number;
  coinId: string | null;
  symbol: string | null;
  name: string | null;
  logo: string | null;
};

const MAX = (1n << 256n) - 1n;
/** Ask every page listing orders to read them again (after placing or cancelling one). */
export const ORDERS_CHANGED = "sasa-orders";
export function ordersChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ORDERS_CHANGED));
}

function kindOf(isBuy: boolean, maxOut: bigint): MyOrder["kind"] {
  return isBuy ? "dip" : maxOut === MAX ? "tp" : "sl";
}

/**
 * The price that fills the order, as dollars-per-token in raw units (so it compares with
 * virtualNative / virtualToken): a take profit sells once `amount` fetches minOut, a stop
 * loss once it fetches no more than maxOut, a dip buy once `amount` dollars get minOut coins.
 */
function triggerOf(kind: MyOrder["kind"], amount: bigint, minOut: bigint, maxOut: bigint): number {
  if (kind === "dip") return minOut > 0n ? Number(amount) / Number(minOut) : 0;
  if (amount === 0n) return 0;
  return kind === "tp" ? Number(minOut) / Number(amount) : Number(maxOut) / Number(amount);
}

async function load(address: Address): Promise<MyOrder[]> {
  const seen = new Set<string>();
  const chains = CHAINS.filter((c) => c.orders && !seen.has(c.orders) && seen.add(c.orders));
  const per = await Promise.all(
    chains.map(async (c) => {
      const pub = clientFor(c);
      const ids = (await pub.readContract({ address: c.orders!, abi: ordersAbi, functionName: "ordersOf", args: [address] }).catch(() => [])) as bigint[];
      const rows = await Promise.all(
        ids.slice(-60).map(async (id) => {
          const r = (await pub.readContract({ address: c.orders!, abi: ordersAbi, functionName: "orders", args: [id] })) as readonly [
            Address, Address, Address, Address, boolean, boolean, bigint, bigint, bigint, bigint,
          ];
          if (!r[5]) return null;
          const kind = kindOf(r[4], r[9]);
          const o: MyOrder = {
            id,
            chain: c,
            curve: r[1].toLowerCase(),
            kind,
            amount: r[7],
            minOut: r[8],
            maxOut: r[9],
            trigger: triggerOf(kind, r[7], r[8], r[9]),
            coinId: null,
            symbol: null,
            name: null,
            logo: null,
          };
          return o;
        })
      );
      return rows.filter((o): o is MyOrder => o !== null);
    })
  );
  const list = per.flat();
  // Which coin each order is on.
  const curves = [...new Set(list.map((o) => o.curve))];
  if (curves.length) {
    const { data: ks } = await db.from("curves").select("chain_id,curve,coin_id").in("curve", curves);
    const rows = (ks ?? []) as { chain_id: number; curve: string; coin_id: string }[];
    const ids = [...new Set(rows.map((r) => r.coin_id))];
    const { data: cs } = ids.length ? await db.from("coins").select("id,name,symbol,logo").in("id", ids) : { data: [] };
    const coins = new Map(((cs ?? []) as { id: string; name: string; symbol: string; logo: string }[]).map((c) => [c.id, c]));
    const byCurve = new Map(rows.map((r) => [`${r.chain_id}:${r.curve.toLowerCase()}`, r.coin_id]));
    for (const o of list) {
      const id = byCurve.get(`${o.chain.chain.id}:${o.curve}`);
      const c = id ? coins.get(id) : undefined;
      if (!id) continue;
      o.coinId = id;
      o.name = c?.name ?? null;
      o.symbol = c?.symbol ?? null;
      o.logo = c?.logo ?? null;
    }
  }
  return list.sort((a, b) => Number(b.id - a.id));
}

/** The user's open auto orders on every chain, kept fresh (30 s, and right after changes). */
export function useMyOrders(address: Address | null | undefined): { orders: MyOrder[] | null; reload: () => void } {
  const [orders, setOrders] = useState<MyOrder[] | null>(null);
  const reload = useCallback(() => {
    if (!address) return setOrders([]);
    load(address)
      .then(setOrders)
      .catch(() => setOrders((o) => o ?? []));
  }, [address]);
  useEffect(() => {
    reload();
    const t = setInterval(() => document.visibilityState === "visible" && reload(), 30_000);
    window.addEventListener(ORDERS_CHANGED, reload);
    return () => {
      clearInterval(t);
      window.removeEventListener(ORDERS_CHANGED, reload);
    };
  }, [reload]);
  return { orders, reload };
}

export const ORDER_LABEL: Record<MyOrder["kind"], string> = { tp: "Take profit", sl: "Stop loss", dip: "Buy the dip" };
export const ORDER_COLOR: Record<MyOrder["kind"], string> = { tp: "#0f9d62", sl: "#d64532", dip: "#3b6ff5" };
