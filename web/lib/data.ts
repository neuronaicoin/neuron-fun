import { createClient } from "@supabase/supabase-js";
import { createPublicClient, formatEther, http, type Address, type PublicClient } from "viem";
import { CHAINS, SUPABASE_KEY, SUPABASE_URL, TARGET_USD, chainById, type NeuronChain } from "./config";
import { fetchPrices } from "./price";

export const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// ------------------------------------------------------------------ chain clients (for transactions)

const clients = new Map<number, PublicClient>();
export function clientFor(c: NeuronChain): PublicClient {
  let p = clients.get(c.chain.id);
  if (!p) {
    p = createPublicClient({ chain: c.chain, transport: http() }) as PublicClient;
    clients.set(c.chain.id, p);
  }
  return p;
}

// ------------------------------------------------------------------ types

export type CurveState = "trading" | "closed" | "graduated";
const STATES: CurveState[] = ["trading", "closed", "graduated"];

export type CurveInfo = {
  chain: NeuronChain;
  curve: Address;
  token: Address;
  state: CurveState;
  realNative: bigint;
  virtualNative: bigint;
  virtualToken: bigint;
  holders: number;
  usd: number | null;
};

export type Coin = {
  id: string;
  creator: Address;
  launchKey: string;
  name: string;
  symbol: string;
  logo: string;
  description: string;
  createdAt: string;
  curves: CurveInfo[];
  totalUsd: number | null;
  progress: number;
  graduatedOn: CurveInfo | null;
  holders: number;
  trades24h: number;
  buys24h: number;
  sells24h: number;
  volumeNative24h: number;
  lastTradeAt: string | null;
};

export type Trade = {
  chainId: number;
  txHash: string;
  ts: string;
  coinId: string;
  curve: string;
  trader: string;
  isBuy: boolean;
  nativeAmount: number; // wei, as a float (display only)
  tokenAmount: number;
  price: number; // native per token
};

type CurveJson = {
  chain_id: number;
  curve: string;
  token: string;
  state: number;
  real_native: string;
  virtual_native: string;
  virtual_token: string;
  holders: number;
};

type SummaryRow = {
  id: string;
  creator: string;
  launch_key: string;
  name: string;
  symbol: string;
  logo: string;
  description: string;
  created_at: string;
  graduated_chain: number | null;
  curves: CurveJson[];
  trades_24h: number;
  buys_24h: number;
  sells_24h: number;
  volume_native_24h: string;
  last_trade_at: string | null;
};

const SUMMARY_COLS =
  "id,creator,launch_key,name,symbol,logo,description,created_at,graduated_chain,curves,trades_24h,buys_24h,sells_24h,volume_native_24h,last_trade_at";

function toCoin(r: SummaryRow, prices: Record<string, number> | null): Coin {
  const curves: CurveInfo[] = [];
  for (const k of r.curves ?? []) {
    const chain = chainById(k.chain_id);
    if (!chain) continue; // a chain this site doesn't know yet
    const realNative = BigInt(k.real_native.split(".")[0]);
    const price = prices?.[chain.priceSymbol];
    curves.push({
      chain,
      curve: k.curve as Address,
      token: k.token as Address,
      state: STATES[k.state] ?? "trading",
      realNative,
      virtualNative: BigInt(k.virtual_native.split(".")[0]),
      virtualToken: BigInt(k.virtual_token.split(".")[0]),
      holders: k.holders ?? 0,
      usd: price ? Number(formatEther(realNative)) * price : null,
    });
  }
  const graduatedOn = curves.find((c) => c.state === "graduated") ?? null;
  const open = curves.filter((c) => c.state === "trading");
  const priced = open.every((c) => c.usd !== null);
  const totalUsd = priced ? open.reduce((s, c) => s + (c.usd ?? 0), 0) : null;
  return {
    id: r.id,
    creator: r.creator as Address,
    launchKey: r.launch_key,
    name: r.name,
    symbol: r.symbol,
    logo: r.logo,
    description: r.description,
    createdAt: r.created_at,
    curves: curves.sort((a, b) => a.chain.short.localeCompare(b.chain.short)),
    totalUsd,
    progress: graduatedOn ? 1 : totalUsd === null ? 0 : Math.min(1, totalUsd / TARGET_USD),
    graduatedOn,
    holders: curves.reduce((s, c) => s + c.holders, 0),
    trades24h: r.trades_24h,
    buys24h: r.buys_24h,
    sells24h: r.sells_24h,
    volumeNative24h: Number(r.volume_native_24h) / 1e18,
    lastTradeAt: r.last_trade_at,
  };
}

function toTrade(r: Record<string, unknown>): Trade {
  return {
    chainId: r.chain_id as number,
    txHash: r.tx_hash as string,
    ts: r.ts as string,
    coinId: r.coin_id as string,
    curve: r.curve as string,
    trader: r.trader as string,
    isBuy: r.is_buy as boolean,
    nativeAmount: Number(r.native_amount),
    tokenAmount: Number(r.token_amount),
    price: Number(r.price),
  };
}

// ------------------------------------------------------------------ queries

export type SortKey = "hot" | "new" | "graduated" | "active";

/** Coins for the home page. Sorting by closeness to graduation happens in the browser. */
export async function fetchCoins(opts: { sort?: SortKey; search?: string; limit?: number } = {}) {
  const prices = await fetchPrices();
  let q = db.from("coin_summary").select(SUMMARY_COLS);
  if (opts.search) {
    const s = opts.search.replace(/[%,()]/g, " ").trim();
    if (s) q = q.or(`name.ilike.%${s}%,symbol.ilike.%${s}%`);
  }
  if (opts.sort === "graduated") q = q.not("graduated_chain", "is", null).order("graduated_at", { ascending: false });
  else if (opts.sort === "active") q = q.order("last_trade_at", { ascending: false, nullsFirst: false });
  else q = q.order("created_at", { ascending: false });
  const { data, error } = await q.limit(opts.limit ?? 60);
  if (error) throw error;
  const coins = (data as SummaryRow[]).map((r) => toCoin(r, prices));
  return { coins, prices };
}

export async function fetchCoin(id: string) {
  const prices = await fetchPrices();
  const { data, error } = await db.from("coin_summary").select(SUMMARY_COLS).eq("id", id.toLowerCase()).maybeSingle();
  if (error) throw error;
  return { coin: data ? toCoin(data as SummaryRow, prices) : null, prices };
}

export async function fetchTrades(filter: { coinId?: string; trader?: string; limit?: number }) {
  let q = db
    .from("trades")
    .select("chain_id,tx_hash,ts,coin_id,curve,trader,is_buy,native_amount,token_amount,price")
    .order("ts", { ascending: false })
    .order("log_index", { ascending: false });
  if (filter.coinId) q = q.eq("coin_id", filter.coinId);
  if (filter.trader) q = q.eq("trader", filter.trader.toLowerCase());
  const { data, error } = await q.limit(filter.limit ?? 40);
  if (error) throw error;
  return (data ?? []).map(toTrade);
}

export type Candle = { t: number; open: number; high: number; low: number; close: number; volume: number };

export async function fetchCandles(chainId: number, curve: string, bucketSeconds: number): Promise<Candle[]> {
  const { data, error } = await db.rpc("candles", { p_chain_id: chainId, p_curve: curve, p_bucket: bucketSeconds, p_limit: 500 });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[])
    .map((r) => ({
      t: Math.floor(new Date(r.t as string).getTime() / 1000),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume) / 1e18,
    }))
    .sort((a, b) => a.t - b.t);
}

export async function fetchTopHolders(chainId: number, token: string, exclude: string[], limit = 10) {
  const { data, error } = await db
    .from("balances")
    .select("holder,amount")
    .eq("chain_id", chainId)
    .eq("token", token.toLowerCase())
    .gt("amount", 0)
    .order("amount", { ascending: false })
    .limit(limit + exclude.length);
  if (error) throw error;
  const skip = new Set(exclude.map((a) => a.toLowerCase()));
  return (data ?? [])
    .filter((r) => !skip.has((r.holder as string).toLowerCase()))
    .slice(0, limit)
    .map((r) => ({ holder: r.holder as string, amount: Number(r.amount) / 1e18 }));
}

/** Everything the dashboard shows for one wallet. */
export async function fetchPortfolio(address: string) {
  const me = address.toLowerCase();
  const prices = await fetchPrices();
  const [created, bals] = await Promise.all([
    db.from("coin_summary").select(SUMMARY_COLS).eq("creator", me).order("created_at", { ascending: false }),
    db.from("balances").select("chain_id,token,amount").eq("holder", me).gt("amount", 0),
  ]);
  if (created.error) throw created.error;
  if (bals.error) throw bals.error;
  const tokens = (bals.data ?? []) as { chain_id: number; token: string; amount: string }[];
  let holdings: { coin: Coin; curve: CurveInfo; amount: number }[] = [];
  if (tokens.length) {
    const curves = await db.from("curves").select("chain_id,token,coin_id").in("token", tokens.map((t) => t.token));
    if (curves.error) throw curves.error;
    const coinIds = [...new Set((curves.data ?? []).map((c) => c.coin_id as string))];
    const coins = coinIds.length ? await db.from("coin_summary").select(SUMMARY_COLS).in("id", coinIds) : { data: [], error: null };
    if (coins.error) throw coins.error;
    const byId = new Map((coins.data as SummaryRow[]).map((r) => [r.id, toCoin(r, prices)]));
    holdings = tokens.flatMap((t) => {
      const cv = (curves.data ?? []).find((c) => c.chain_id === t.chain_id && c.token === t.token);
      const coin = cv && byId.get(cv.coin_id as string);
      const curve = coin?.curves.find((k) => k.chain.chain.id === t.chain_id && k.token.toLowerCase() === t.token);
      return coin && curve ? [{ coin, curve, amount: Number(t.amount) / 1e18 }] : [];
    });
  }
  return {
    created: (created.data as SummaryRow[]).map((r) => toCoin(r, prices)),
    holdings,
    prices,
  };
}

// ------------------------------------------------------------------ helpers

/** Curve price in native coin per whole token (display only). */
export function nativePerToken(c: { virtualNative: bigint; virtualToken: bigint }): number {
  return Number(c.virtualNative) / Number(c.virtualToken);
}

/** Market value of a coin on one chain, in native coin (1e9 supply). */
export function marketCapNative(c: { virtualNative: bigint; virtualToken: bigint }): number {
  return nativePerToken(c) * 1e9;
}

export function isImageUrl(s: string): boolean {
  return /^https:\/\/\S+$/i.test(s) || /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
}

export function coinHref(c: { creator: string; launchKey: string } | { id: string }) {
  const id = "id" in c ? c.id : `${c.creator.toLowerCase()}:${c.launchKey}`;
  return `/coin/?id=${encodeURIComponent(id)}`;
}

export const CHAIN_LIST = CHAINS;
