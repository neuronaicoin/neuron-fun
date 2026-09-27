import { PostgrestClient } from "@supabase/postgrest-js";
import { createPublicClient, fallback, formatEther, http, type Address, type PublicClient } from "viem";
import { ALCHEMY_KEY, CHAINS, SUPABASE_KEY, SUPABASE_URL, TARGET_USD, chainById, type NeuronChain } from "./config";
import { fetchPrices } from "./price";

/** Read-only database client (just the query part of Supabase, to keep the page light). */
export const db = new PostgrestClient(`${SUPABASE_URL}/rest/v1`, {
  headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
});

// ------------------------------------------------------------------ chain clients (for transactions)

const clients = new Map<number, PublicClient>();
export function clientFor(c: NeuronChain): PublicClient {
  let p = clients.get(c.chain.id);
  if (!p) {
    // Alchemy first (fast), the chain's public RPC if Alchemy is unreachable.
    p = createPublicClient({
      chain: c.chain,
      transport: fallback([http(`https://${c.alchemyNetwork}.g.alchemy.com/v2/${ALCHEMY_KEY}`), http()]),
      pollingInterval: 500,
    }) as PublicClient;
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
  /** Where the creator's share of fees goes (fixed at launch). */
  feeMode: FeeMode;
  /** Price change over the last 24 hours (0.5 = +50%); null when unknown. */
  change24h: number | null;
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

export type FeeMode = "creator" | "buyback" | "holders";
const FEE_MODES: FeeMode[] = ["creator", "buyback", "holders"];

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
  fee_mode: number | null;
  change_24h?: number | string | null;
};

const SUMMARY_COLS =
  "id,creator,launch_key,name,symbol,logo,description,created_at,graduated_chain,curves,trades_24h,buys_24h,sells_24h,volume_native_24h,last_trade_at,fee_mode";

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
    feeMode: FEE_MODES[r.fee_mode ?? 0] ?? "creator",
    change24h: r.change_24h === null || r.change_24h === undefined ? null : Number(r.change_24h),
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

/**
 * trending: most trades in 24 h · gainers / losers: 24 h price change ·
 * hot: still racing, closest to graduation · new · graduated · active: latest trade.
 */
export type SortKey = "watchlist" | "trending" | "gainers" | "losers" | "hot" | "new" | "graduated" | "active";

/** The market list's columns: the coin summary plus its 24 h price change. */
const LIST_COLS = SUMMARY_COLS + ",change_24h";
export const PAGE_SIZE = 24;

/**
 * Coins for the home page, a page at a time, from the precomputed coin_list
 * (rebuilt by the indexer every few seconds), so it stays instant at any size.
 */
export async function fetchCoins(opts: { sort?: SortKey; search?: string; page?: number } = {}) {
  const prices = await fetchPrices();
  let q = db.from("coin_list").select(LIST_COLS);
  if (opts.sort === "watchlist") {
    const { getWatchlist } = await import("./watchlist");
    const ids = getWatchlist();
    if (ids.length === 0) return { coins: [] as Coin[], prices, hasMore: false };
    q = q.in("id", ids).order("last_trade_at", { ascending: false, nullsFirst: false });
  }
  if (opts.search) {
    const s = opts.search.replace(/[%,()*]/g, " ").trim();
    if (s) q = q.or(`name.ilike.%${s}%,symbol.ilike.%${s}%`);
  }
  if (opts.sort === "graduated") q = q.not("graduated_chain", "is", null).order("graduated_at", { ascending: false });
  else if (opts.sort === "active") q = q.order("last_trade_at", { ascending: false, nullsFirst: false });
  else if (opts.sort === "hot") q = q.is("graduated_chain", null).order("open_native", { ascending: false });
  else if (opts.sort === "trending")
    q = q.order("trades_24h", { ascending: false }).order("volume_native_24h", { ascending: false }).order("last_trade_at", { ascending: false, nullsFirst: false });
  else if (opts.sort === "gainers") q = q.not("change_24h", "is", null).gt("change_24h", 0).order("change_24h", { ascending: false });
  else if (opts.sort === "losers") q = q.not("change_24h", "is", null).lt("change_24h", 0).order("change_24h", { ascending: true });
  else q = q.order("created_at", { ascending: false });
  const from = (opts.page ?? 0) * PAGE_SIZE;
  const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
  if (error) throw error;
  const coins = (data as unknown as SummaryRow[]).map((r) => toCoin(r, prices));
  return { coins, prices, hasMore: coins.length === PAGE_SIZE };
}

/** Total number of coins (all chains, all states). */
export async function fetchCoinCount(): Promise<number | null> {
  const { count, error } = await db.from("coin_list").select("id", { count: "exact", head: true });
  return error ? null : count;
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

// ------------------------------------------------------------------ stats

export type DailyStat = { day: string; volume: number; trades: number; traders: number; fees: number; launches: number };
export type Totals = { volume: number; trades: number; traders: number; fees: number; launches: number; graduated: number; holders: number };
export type TopCoin = { coinId: string; name: string; symbol: string; logo: string; volume: number; trades: number };
export type TopCreator = { creator: string; coins: number; earned: number };

/** Everything the stats page shows. Amounts are in ETH (whole units). */
export async function fetchStats(days: number, chainId: number | null) {
  const args = { p_days: days, p_chain: chainId };
  const [daily, totals, coins, creators] = await Promise.all([
    db.rpc("stats_daily", args),
    db.rpc("stats_totals", args),
    db.rpc("stats_top_coins", { ...args, p_limit: 10 }),
    db.rpc("stats_top_creators", { ...args, p_limit: 10 }),
  ]);
  for (const r of [daily, totals, coins, creators]) if (r.error) throw r.error;
  const eth = (v: unknown) => Number(v) / 1e18;
  const t = ((totals.data as Record<string, unknown>[]) ?? [])[0] ?? {};
  return {
    daily: ((daily.data as Record<string, unknown>[]) ?? []).map((r) => ({
      day: r.day as string,
      volume: eth(r.volume_native),
      trades: Number(r.trades),
      traders: Number(r.traders),
      fees: eth(r.fees_native),
      launches: Number(r.launches),
    })) as DailyStat[],
    totals: {
      volume: eth(t.volume_native ?? 0),
      trades: Number(t.trades ?? 0),
      traders: Number(t.traders ?? 0),
      fees: eth(t.fees_native ?? 0),
      launches: Number(t.launches ?? 0),
      graduated: Number(t.graduated ?? 0),
      holders: Number(t.holders ?? 0),
    } as Totals,
    topCoins: ((coins.data as Record<string, unknown>[]) ?? []).map((r) => ({
      coinId: r.coin_id as string,
      name: r.name as string,
      symbol: r.symbol as string,
      logo: r.logo as string,
      volume: eth(r.volume_native),
      trades: Number(r.trades),
    })) as TopCoin[],
    topCreators: ((creators.data as Record<string, unknown>[]) ?? []).map((r) => ({
      creator: r.creator as string,
      coins: Number(r.coins),
      earned: eth(r.earned_native),
    })) as TopCreator[],
  };
}
