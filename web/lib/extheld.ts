"use client";

/**
 * Other DEXs' coins (and Market's top coins) the user holds, for "You" and the header total.
 * Which coins: every coin the user bought on sasa, from two places so nothing is missed — this
 * browser's own list (written the moment a buy goes through, so it shows at once) and the
 * server's record of verified trades (ext_held(), so it follows the user to other devices).
 * How many: read on the coin's own chain. Worth: the coin lists' last price.
 */
import { erc20Abi, type Address } from "viem";
import { db } from "./data";
import { toExt, extHref } from "./extcoins";
import { xChain, xClient } from "./extcross";
import { topHref } from "./topcoins";

export type ExtHolding = {
  network: string;
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  image: string | null;
  tokens: number;
  priceUsd: number | null;
  valueUsd: number;
  change24h: number | null;
  href: string;
};

const NETWORK_CHAIN: Record<string, number> = { base: 8453, bsc: 56, robinhood: 4663, arc: 5042, eth: 1 };
const CHAIN_NETWORK: Record<number, string> = Object.fromEntries(Object.entries(NETWORK_CHAIN).map(([n, c]) => [c, n]));

type Seen = { network: string; address: string; name?: string; symbol?: string; image?: string | null; topId?: string | null };
const key = (user: string) => `sasa.held.${user.toLowerCase()}`;

function readLocal(user: string): Seen[] {
  try {
    const v = JSON.parse(localStorage.getItem(key(user)) ?? "[]");
    return Array.isArray(v) ? (v as Seen[]).filter((x) => x && typeof x.address === "string" && typeof x.network === "string") : [];
  } catch {
    return [];
  }
}

/** Called right after a buy of another DEX's coin goes through. */
export function rememberExtBuy(user: string, c: Seen) {
  if (!NETWORK_CHAIN[c.network]) return;
  try {
    const list = readLocal(user).filter((x) => !(x.network === c.network && x.address.toLowerCase() === c.address.toLowerCase()));
    list.unshift({ ...c, address: c.address.toLowerCase() });
    localStorage.setItem(key(user), JSON.stringify(list.slice(0, 200)));
  } catch {
    /* private window: the server's list still has it once the trade is verified */
  }
}

/** Every coin of other DEXs the user bought, with what's held now (dust and zero left out). */
export async function fetchExtHoldings(user: string, prev: ExtHolding[] = []): Promise<ExtHolding[]> {
  // what was shown last time: kept when a read fails, so a busy node doesn't make coins vanish
  const last = new Map(prev.map((h) => [`${h.network}:${h.address.toLowerCase()}`, h]));
  const local = readLocal(user);
  const server = await Promise.resolve(db.rpc("ext_held", { p_trader: user.toLowerCase() }))
    .then(({ data, error }) => (error ? [] : ((data ?? []) as { coin: string; coin_chain: number }[])))
    .then((rows) => rows.flatMap((r): Seen[] => (CHAIN_NETWORK[Number(r.coin_chain)] && r.coin ? [{ network: CHAIN_NETWORK[Number(r.coin_chain)], address: r.coin.toLowerCase() }] : [])))
    .catch(() => [] as Seen[]);
  const all = new Map<string, Seen>();
  const before: Seen[] = prev.map((h) => ({ network: h.network, address: h.address, name: h.name, symbol: h.symbol, image: h.image }));
  for (const s of [...before, ...server, ...local]) {
    const k = `${s.network}:${s.address.toLowerCase()}`;
    all.set(k, { ...all.get(k), ...s, address: s.address.toLowerCase() });
  }
  if (!all.size) return [];
  const list = [...all.values()].slice(0, 60);

  // prices: the live lists first, then the top coins, then the archive
  const addrs = list.map((s) => s.address);
  const [live, tops] = await Promise.all([
    Promise.resolve(db.from("ext_coins_all").select("*").in("address", addrs)).then(({ data }) => (data ?? []) as Record<string, unknown>[], () => [] as Record<string, unknown>[]),
    Promise.resolve(db.from("top_coins_pub").select("cg_id,address,network,name,symbol,image,price_usd,change_24h").in("address", addrs)).then(({ data }) => (data ?? []) as Record<string, unknown>[], () => [] as Record<string, unknown>[]),
  ]);
  const priced = new Map<string, { name: string; symbol: string; image: string | null; price: number | null; change: number | null; topId: string | null }>();
  for (const r of live) {
    const e = toExt(r);
    priced.set(`${e.network}:${e.address.toLowerCase()}`, { name: e.name, symbol: e.symbol, image: e.image, price: e.priceUsd, change: e.change24h, topId: null });
  }
  for (const r of tops) {
    const k = `${String(r.network)}:${String(r.address).toLowerCase()}`;
    const p = Number(r.price_usd);
    const cur = priced.get(k);
    priced.set(k, {
      name: cur?.name ?? String(r.name ?? ""),
      symbol: cur?.symbol ?? String(r.symbol ?? ""),
      image: cur?.image ?? (typeof r.image === "string" ? r.image : null),
      price: cur?.price ?? (Number.isFinite(p) && p > 0 ? p : null),
      change: cur?.change ?? (Number.isFinite(Number(r.change_24h)) ? Number(r.change_24h) : null),
      topId: String(r.cg_id ?? "") || null,
    });
  }

  const out = await Promise.all(
    list.map(async (s): Promise<ExtHolding | null> => {
      const chainId = NETWORK_CHAIN[s.network];
      const chain = xChain(chainId);
      if (!chain) return null;
      const pub = xClient(chain);
      const token = s.address as Address;
      const k = `${s.network}:${s.address}`;
      const read = () => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [user as Address] });
      const [bal, dec] = await Promise.all([
        read().catch(() => new Promise((r) => setTimeout(r, 400)).then(read)).catch(() => undefined),
        pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
      ]);
      if (bal === undefined) return last.get(k) ?? null; // couldn't read it: as last shown
      if (bal === 0n) return null;
      const tokens = Number(bal) / 10 ** Number(dec);
      const p = priced.get(k);
      const price = p?.price ?? last.get(k)?.priceUsd ?? null;
      const valueUsd = price ? tokens * price : 0;
      // under a cent of a priced coin: dust, not shown
      if (price && valueUsd < 0.01) return null;
      const topId = p?.topId ?? s.topId ?? null;
      return {
        network: s.network,
        chainId,
        address: s.address,
        name: p?.name || s.name || s.symbol || "Coin",
        symbol: p?.symbol || s.symbol || "",
        image: p?.image ?? s.image ?? null,
        tokens,
        priceUsd: price,
        valueUsd,
        change24h: p?.change ?? null,
        href: topId ? topHref(topId) : extHref({ network: s.network, address: s.address }),
      };
    })
  );
  return out.filter((h): h is ExtHolding => h !== null).sort((a, b) => b.valueUsd - a.valueUsd);
}
