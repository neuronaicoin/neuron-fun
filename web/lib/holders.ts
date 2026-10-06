import type { Coin, CurveInfo } from "./data";
import { db } from "./data";
import { allSets } from "./contracts";

export type MapHolder = { addr: string; amount: number; share: number };
export type HolderMapData = {
  holders: MapHolder[];
  /** Pairs of wallets that sent this coin to each other. */
  links: [string, string][];
  /** Whole tokens the shares are measured against (1B per chain shown). */
  supply: number;
};

const SUPPLY_PER_CHAIN = 1e9;
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

/** sasa's own contracts on the chains shown: never counted as holders. */
function systemAddrs(curves: CurveInfo[]): string[] {
  const out = new Set<string>([ZERO, DEAD]);
  for (const c of curves) {
    out.add(c.curve.toLowerCase());
    out.add(c.chain.poolManager.toLowerCase());
    if (c.chain.orders) out.add(c.chain.orders.toLowerCase());
    for (const s of allSets(c.chain)) {
      out.add(s.migrator.toLowerCase());
      out.add(s.router.toLowerCase());
      out.add(s.factory.toLowerCase());
    }
  }
  return [...out];
}

/**
 * The biggest holders of a coin (on one chain, or all chains added up) and
 * the wallets that sent it to each other.
 */
export async function fetchHolderMap(coin: Coin, chainKey: string | null, limit = 60): Promise<HolderMapData> {
  const curves = coin.curves.filter((c) => !chainKey || c.chain.key === chainKey);
  const skip = systemAddrs(coin.curves);
  const skipSet = new Set(skip);
  const per = await Promise.all(
    curves.map(async (c) => {
      const { data, error } = await db
        .from("balances")
        .select("holder,amount")
        .eq("chain_id", c.chain.chain.id)
        .eq("token", c.token.toLowerCase())
        .gt("amount", 0)
        .order("amount", { ascending: false })
        .limit(limit + 8);
      if (error) throw error;
      return (data ?? []) as { holder: string; amount: number | string }[];
    })
  );
  const sum = new Map<string, number>();
  for (const rows of per)
    for (const r of rows) {
      const a = r.holder.toLowerCase();
      if (skipSet.has(a)) continue;
      sum.set(a, (sum.get(a) ?? 0) + Number(r.amount) / 1e18);
    }
  const supply = SUPPLY_PER_CHAIN * Math.max(1, curves.length);
  const holders = [...sum.entries()]
    .map(([addr, amount]) => ({ addr, amount, share: amount / supply }))
    .filter((h) => h.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);

  let links: [string, string][] = [];
  const shown = new Set(holders.map((h) => h.addr));
  const chainIds = new Set(curves.map((c) => c.chain.chain.id));
  try {
    const { data } = await db.rpc("holder_links", { p_coin: coin.id, p_skip: skip });
    const seen = new Set<string>();
    links = ((data ?? []) as { chain_id: number; a: string; b: string }[])
      .filter((r) => chainIds.has(r.chain_id))
      .map((r) => [r.a.toLowerCase(), r.b.toLowerCase()] as [string, string])
      .filter(([a, b]) => shown.has(a) && shown.has(b))
      .filter(([a, b]) => {
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  } catch {
    links = []; // holders.sql not run yet: the map simply has no links
  }
  return { holders, links, supply };
}

/** Places circles (largest first) in a spiral so none overlap. Deterministic. */
export function packCircles<T extends { r: number }>(items: T[], w: number, h: number): (T & { x: number; y: number })[] {
  const out: (T & { x: number; y: number })[] = [];
  const cx = w / 2;
  const cy = h / 2;
  for (const it of items) {
    let done = false;
    for (let t = 0; t < 6000 && !done; t++) {
      const ang = t * 0.35;
      const rad = t * 0.75;
      const x = cx + Math.cos(ang) * rad;
      const y = cy + Math.sin(ang) * rad * 0.78;
      if (x - it.r < 2 || x + it.r > w - 2 || y - it.r < 2 || y + it.r > h - 2) continue;
      if (out.every((o) => Math.hypot(o.x - x, o.y - y) >= o.r + it.r + 3)) {
        out.push({ ...it, x, y });
        done = true;
      }
    }
  }
  return out;
}

export type FirstBuyer = {
  addr: string;
  /** When the wallet first bought. */
  firstAt: string;
  /** Dollars spent on buys among the trades read. */
  boughtUsd: number;
  /** Share of supply the wallet holds now (0 = sold everything). */
  share: number;
  /** Sent or received this coin to or from another wallet. */
  linked: boolean;
};

/**
 * "Who bought": the first wallets to buy a coin, what they paid and what
 * they still hold. Read from trades, balances and transfers (no new tables).
 */
export async function fetchFirstBuyers(coin: Coin, ethUsd: number | null, count = 30): Promise<FirstBuyer[]> {
  const skip = systemAddrs(coin.curves);
  const skipSet = new Set(skip);
  const { data, error } = await db
    .from("trades")
    .select("trader,native_amount,ts")
    .eq("coin_id", coin.id)
    .eq("is_buy", true)
    .order("ts", { ascending: true })
    .order("log_index", { ascending: true })
    .limit(400);
  if (error) throw error;
  const order: string[] = [];
  const byAddr = new Map<string, { firstAt: string; spent: number }>();
  for (const r of (data ?? []) as { trader: string; native_amount: number | string; ts: string }[]) {
    const a = (r.trader ?? "").toLowerCase();
    if (!a || skipSet.has(a)) continue;
    const usd = ethUsd ? (Number(r.native_amount) / 1e18) * ethUsd : 0;
    const cur = byAddr.get(a);
    if (cur) cur.spent += usd;
    else {
      if (order.length >= count) continue;
      order.push(a);
      byAddr.set(a, { firstAt: r.ts, spent: usd });
    }
  }
  if (!order.length) return [];

  // What each of them holds now, all chains added up.
  const held = new Map<string, number>();
  const perChain = await Promise.all(
    coin.curves.map(async (c) => {
      const { data, error } = await db
        .from("balances")
        .select("holder,amount")
        .eq("chain_id", c.chain.chain.id)
        .eq("token", c.token.toLowerCase())
        .in("holder", order);
      if (error) throw error;
      return (data ?? []) as { holder: string; amount: number | string }[];
    })
  );
  for (const rows of perChain)
    for (const r of rows) {
      const a = r.holder.toLowerCase();
      held.set(a, (held.get(a) ?? 0) + Number(r.amount) / 1e18);
    }
  const supply = SUPPLY_PER_CHAIN * Math.max(1, coin.curves.length);

  // Wallets that moved this coin between each other.
  const linked = new Set<string>();
  try {
    const { data: pairs } = await db.rpc("holder_links", { p_coin: coin.id, p_skip: skip });
    for (const p of (pairs ?? []) as { a: string; b: string }[]) {
      linked.add(p.a.toLowerCase());
      linked.add(p.b.toLowerCase());
    }
  } catch {
    /* no links available: nobody is marked */
  }

  return order.map((addr) => ({
    addr,
    firstAt: byAddr.get(addr)!.firstAt,
    boughtUsd: byAddr.get(addr)!.spent,
    share: Math.max(0, (held.get(addr) ?? 0) / supply),
    linked: linked.has(addr),
  }));
}
