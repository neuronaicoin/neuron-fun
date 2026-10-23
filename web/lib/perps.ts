import { IS_TESTNET } from "./config";
import { perpsBlocked } from "./perpsgeo.js";

/**
 * Perps (leverage) on Hyperliquid: sasa's own screen, Hyperliquid's exchange. Prices, markets,
 * charts and the user's positions come from Hyperliquid's free public API; orders carry sasa's
 * builder code (0.07%). Money stays in the user's own Hyperliquid account (their sasa address).
 */
export const HL_API = "https://api.hyperliquid.xyz";
/** Trading opens at mainnet; the test site shows Hyperliquid's real markets read-only. */
export const PERPS_TRADING = !IS_TESTNET;
/** Highest leverage sasa offers (a market's own limit can be lower). */
export const MAX_LEV = 20;
export const DEFAULT_LEV = 5;
/** sasa's fee on every perps trade (Hyperliquid builder fee, tenths of a basis point: 70 = 0.07%). */
export const BUILDER_FEE_TENTHS_BP = 70;
export const BUILDER_FEE = 0.0007;
/** Hyperliquid's own taker fee at the base tier (about; it falls with volume). */
export const HL_TAKER_FEE = 0.00045;
/** Hyperliquid's smallest order, in dollars of position. */
export const MIN_NOTIONAL = 10;

/** Which tab a market sits under on the Futures screen. */
export type PerpGroup = "crypto" | "stocks" | "commodities" | "indices" | "fx";

export type PerpMarket = {
  /** Hyperliquid's name: "BTC" on the main exchange, "xyz:TSLA" on a builder exchange (HIP-3). */
  coin: string;
  /** What the screen shows: "BTC", "TSLA". */
  label: string;
  /** Company / asset name when known ("Tesla", "Gold"). */
  name: string | null;
  /** "" = Hyperliquid's main exchange; else the HIP-3 exchange's short name ("xyz"). */
  dex: string;
  group: PerpGroup;
  /** Hyperliquid's asset id used in orders (main: its place in the list; HIP-3: 100000 + 10000 × exchange + place). */
  index: number;
  szDecimals: number;
  /** Hyperliquid's limit for this market. */
  hlMaxLev: number;
  /** What sasa allows: the lower of 20x and Hyperliquid's limit. */
  maxLev: number;
  onlyIsolated: boolean;
  mark: number;
  prevDay: number;
  change24h: number | null;
  volume24h: number;
  openInterestUsd: number;
  funding: number;
};

export type PerpPosition = {
  coin: string;
  /** Coins: positive long, negative short. */
  size: number;
  side: "long" | "short";
  entry: number;
  value: number;
  pnl: number;
  roe: number;
  liq: number | null;
  lev: number;
  margin: number;
  funding: number;
};

export type PerpAccount = {
  accountValue: number;
  withdrawable: number;
  marginUsed: number;
  positions: PerpPosition[];
};

export type PerpOrder = { coin: string; oid: number; side: "B" | "A"; type: string; triggerPx: number | null; limitPx: number; size: number; reduceOnly: boolean; tpsl: "tp" | "sl" | null };
export type PerpFill = { coin: string; px: number; sz: number; side: "B" | "A"; time: number; dir: string; pnl: number; fee: number; hash: string; tid: number };

const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? 0 : Number(v));

export async function info<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`${HL_API}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  if (!r.ok) throw new Error(`Hyperliquid ${r.status}`);
  return (await r.json()) as T;
}

type Universe = { name: string; szDecimals: number; maxLeverage: number; onlyIsolated?: true; isDelisted?: true; marginMode?: string }[];
type Ctx = { prevDayPx: string; dayNtlVlm: string; markPx: string; funding: string; openInterest: string };

// ------------------------------------------------------------------ stocks, commodities, indices (HIP-3)

const COMMODITIES = new Set(["GOLD", "SILVER", "CL", "OIL", "WTI", "BRENTOIL", "BRENT", "NATGAS", "COPPER", "PLATINUM", "PALLADIUM", "URANIUM", "ALUMINIUM", "ALUMINUM", "COFFEE", "COCOA", "CORN", "WHEAT", "SOYBEAN", "SUGAR", "XAU", "XAG"]);
const INDICES = new Set(["XYZ100", "SPX", "SP500", "US500", "NDX", "NAS100", "US100", "DJI", "US30", "RUT", "RUSSELL", "VIX", "DAX", "GER40", "JP225", "NIKKEI", "HSI", "KOSPI", "FTSE", "UK100", "SMALL2000", "MAG7"]);
const FX = new Set(["EUR", "JPY", "GBP", "CHF", "AUD", "CAD", "NZD", "CNH", "DXY", "EURUSD", "USDJPY", "GBPUSD", "KRW", "MXN", "TRY"]);
const NAMES: Record<string, string> = {
  TSLA: "Tesla", NVDA: "Nvidia", AAPL: "Apple", MSFT: "Microsoft", AMZN: "Amazon", GOOGL: "Alphabet", GOOG: "Alphabet", META: "Meta",
  NFLX: "Netflix", AMD: "AMD", INTC: "Intel", HOOD: "Robinhood", COIN: "Coinbase", MSTR: "Strategy", PLTR: "Palantir", ORCL: "Oracle",
  BABA: "Alibaba", TSM: "TSMC", AVGO: "Broadcom", CRCL: "Circle", UBER: "Uber", DIS: "Disney", NKE: "Nike", JPM: "JPMorgan",
  GME: "GameStop", SNDK: "SanDisk", MU: "Micron", SMSN: "Samsung", SKHX: "SK Hynix", RIVN: "Rivian", LLY: "Eli Lilly",
  GOLD: "Gold", SILVER: "Silver", CL: "Crude oil", OIL: "Crude oil", WTI: "Crude oil", BRENTOIL: "Brent oil", BRENT: "Brent oil",
  NATGAS: "Natural gas", COPPER: "Copper", PLATINUM: "Platinum", PALLADIUM: "Palladium", URANIUM: "Uranium", XAU: "Gold", XAG: "Silver",
  XYZ100: "Nasdaq 100", NDX: "Nasdaq 100", NAS100: "Nasdaq 100", SPX: "S&P 500", SP500: "S&P 500", US500: "S&P 500", DJI: "Dow Jones",
  US30: "Dow Jones", VIX: "Volatility index", DAX: "DAX", JP225: "Nikkei 225", EUR: "Euro", JPY: "Japanese yen", GBP: "British pound", DXY: "Dollar index",
};

/** The tab a builder-exchange market belongs to, from its symbol. */
export function groupOf(label: string): PerpGroup {
  const s = label.toUpperCase();
  if (COMMODITIES.has(s)) return "commodities";
  if (INDICES.has(s)) return "indices";
  if (FX.has(s)) return "fx";
  return "stocks";
}

type Dex = { name: string; index: number };
let dexesP: Promise<Dex[]> | null = null;
/** Hyperliquid's builder exchanges (HIP-3), read once per visit. */
export function perpDexes(): Promise<Dex[]> {
  if (!dexesP) {
    dexesP = info<({ name: string } | null)[]>({ type: "perpDexs" })
      .then((rows) => (Array.isArray(rows) ? rows : []).flatMap((d, index) => (index > 0 && d && typeof d.name === "string" && d.name ? [{ name: d.name, index }] : [])))
      .catch(() => {
        dexesP = null; // try again next time
        return [];
      });
  }
  return dexesP;
}

function marketsOf(meta: { universe: Universe }, ctxs: Ctx[], dex: Dex | null): PerpMarket[] {
  const out: PerpMarket[] = [];
  (meta?.universe ?? []).forEach((u, i) => {
    const c = ctxs?.[i];
    if (!c || u.isDelisted) return;
    const mark = num(c.markPx);
    const prev = num(c.prevDayPx);
    if (mark <= 0) return;
    const label = dex ? u.name.slice(u.name.indexOf(":") + 1) : u.name;
    out.push({
      coin: u.name,
      label,
      name: dex ? (NAMES[label.toUpperCase()] ?? null) : null,
      dex: dex?.name ?? "",
      group: dex ? groupOf(label) : "crypto",
      index: dex ? 100_000 + dex.index * 10_000 + i : i,
      szDecimals: u.szDecimals,
      hlMaxLev: u.maxLeverage,
      maxLev: Math.max(1, Math.min(MAX_LEV, u.maxLeverage)),
      onlyIsolated: !!u.onlyIsolated || u.marginMode === "strictIsolated" || u.marginMode === "noCross",
      mark,
      prevDay: prev,
      change24h: prev > 0 ? (mark / prev - 1) * 100 : null,
      volume24h: num(c.dayNtlVlm),
      openInterestUsd: num(c.openInterest) * mark,
      funding: num(c.funding),
    });
  });
  return out;
}

/** Builder exchanges paid in USDC that have markets (learned from the last market read). */
let usableDexes: Dex[] | null = null;
const dexesInUse = async () => usableDexes ?? (await perpDexes());

/**
 * The stocks, commodities, indices and FX of Hyperliquid's builder exchanges (HIP-3): only
 * those paid in USDC (the same money as the rest), no crypto (`skip` = the main exchange's
 * coins), one market per symbol (the busiest). Busiest first.
 */
export async function fetchBuilderMarkets(skip: Set<string>, signal?: AbortSignal): Promise<PerpMarket[]> {
  const dexes = await perpDexes();
  const usable: Dex[] = [];
  const more = await Promise.all(
    dexes.map((d) =>
      info<[{ universe: Universe; collateralToken?: number }, Ctx[]]>({ type: "metaAndAssetCtxs", dex: d.name }, signal)
        .then(([dm, dc]) => {
          if ((dm?.collateralToken ?? 0) !== 0) return [];
          const ms = marketsOf(dm, dc, d);
          if (ms.length) usable.push(d);
          return ms;
        })
        .catch(() => [] as PerpMarket[])
    )
  );
  if (dexes.length) usableDexes = usable;
  const best = new Map<string, PerpMarket>();
  for (const m of more.flat()) {
    const k = m.label.toUpperCase();
    if (skip.has(k) || m.volume24h <= 0) continue;
    const cur = best.get(k);
    if (!cur || m.volume24h > cur.volume24h) best.set(k, m);
  }
  return [...best.values()].sort((a, b) => b.volume24h - a.volume24h);
}

/** Every live market on Hyperliquid's main exchange (crypto), busiest first. */
export async function fetchPerpMarkets(signal?: AbortSignal): Promise<PerpMarket[]> {
  const [meta, ctxs] = await info<[{ universe: Universe }, Ctx[]]>({ type: "metaAndAssetCtxs" }, signal);
  return marketsOf(meta, ctxs, null).sort((a, b) => b.volume24h - a.volume24h);
}

export const INTERVAL: Record<number, string> = { 60: "1m", 300: "5m", 900: "15m", 3600: "1h", 14400: "4h", 86400: "1d" };
/** Hyperliquid's name for a time frame (seconds), the nearest one it has. */
export const hlInterval = (frameSec: number) =>
  INTERVAL[Object.keys(INTERVAL).map(Number).reduce((best, s) => (Math.abs(s - frameSec) < Math.abs(best - frameSec) ? s : best), 3600)];
/** Decimals a price can have on this market (Hyperliquid: 6 minus the size decimals). */
export const priceDecimals = (m: Pick<PerpMarket, "szDecimals">) => Math.max(0, 6 - m.szDecimals);
/** Decimals the chart shows: 5 significant digits at today's price, within the market's own limit. */
export const chartDecimals = (m: Pick<PerpMarket, "szDecimals" | "mark">) =>
  Math.min(priceDecimals(m), Math.max(0, 4 - Math.floor(Math.log10(Math.max(m.mark, 1e-12)))));

export type PerpCandle = { t: number; open: number; high: number; low: number; close: number; volume: number };

/** Candles for sasa's chart (time in seconds, volume in dollars): `bars` of them, enough for a 200 average. */
export async function fetchPerpCandles(coin: string, frameSec: number, bars = 700): Promise<PerpCandle[]> {
  const sec = Object.keys(INTERVAL).map(Number).reduce((best, s) => (Math.abs(s - frameSec) < Math.abs(best - frameSec) ? s : best), 3600);
  const end = Date.now();
  const start = end - sec * 1000 * bars;
  const rows = await info<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>({ type: "candleSnapshot", req: { coin, interval: INTERVAL[sec], startTime: start, endTime: end } });
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({ t: Math.floor(r.t / 1000), open: num(r.o), high: num(r.h), low: num(r.l), close: num(r.c), volume: num(r.v) * num(r.c) }))
    .filter((r) => r.close > 0)
    .sort((a, b) => a.t - b.t);
}

type Clearing = {
  marginSummary: { accountValue: string; totalMarginUsed: string };
  withdrawable: string;
  assetPositions: {
    position: {
      coin: string;
      szi: string;
      entryPx: string;
      positionValue: string;
      unrealizedPnl: string;
      returnOnEquity: string;
      liquidationPx: string | null;
      marginUsed: string;
      leverage: { value: number };
      cumFunding: { sinceOpen: string };
    };
  }[];
};

function accountOf(s: Clearing | null): PerpAccount {
  return {
    accountValue: num(s?.marginSummary?.accountValue),
    withdrawable: num(s?.withdrawable),
    marginUsed: num(s?.marginSummary?.totalMarginUsed),
    positions: (s?.assetPositions ?? [])
      .map(({ position: p }) => {
        const size = num(p.szi);
        return {
          coin: p.coin,
          size,
          side: (size >= 0 ? "long" : "short") as "long" | "short",
          entry: num(p.entryPx),
          value: num(p.positionValue),
          pnl: num(p.unrealizedPnl),
          roe: num(p.returnOnEquity) * 100,
          liq: p.liquidationPx === null ? null : num(p.liquidationPx) || null,
          lev: num(p.leverage?.value),
          margin: num(p.marginUsed),
          // Hyperliquid counts funding paid as positive: show it as money in (+) / out (−)
          funding: -num(p.cumFunding?.sinceOpen),
        };
      })
      .filter((p) => p.size !== 0),
  };
}

/**
 * The user's perps account: money in it, what can be moved out, open positions. Positions on
 * the builder exchanges (stocks, commodities…) are added in; what can be moved out is the main
 * exchange's (money on a builder exchange goes back there by itself).
 */
export async function fetchPerpAccount(user: string, signal?: AbortSignal): Promise<PerpAccount> {
  const u = user.toLowerCase();
  const [s, dexes] = await Promise.all([info<Clearing>({ type: "clearinghouseState", user: u }, signal), dexesInUse()]);
  const main = accountOf(s);
  const others = await Promise.all(dexes.map((d) => info<Clearing>({ type: "clearinghouseState", user: u, dex: d.name }, signal).then(accountOf).catch(() => null)));
  for (const a of others) {
    if (!a || (a.accountValue === 0 && a.positions.length === 0)) continue;
    main.accountValue += a.accountValue;
    main.marginUsed += a.marginUsed;
    main.positions.push(...a.positions);
  }
  return main;
}

type RawOrder = { coin: string; oid: number; side: "B" | "A"; orderType: string; isTrigger: boolean; triggerPx: string; limitPx: string; sz: string; reduceOnly: boolean };

function ordersOf(rows: RawOrder[] | null): PerpOrder[] {
  return (Array.isArray(rows) ? rows : []).map((o) => ({
    coin: o.coin,
    oid: o.oid,
    side: o.side,
    type: o.orderType,
    triggerPx: o.isTrigger ? num(o.triggerPx) : null,
    limitPx: num(o.limitPx),
    size: num(o.sz),
    reduceOnly: o.reduceOnly,
    tpsl: /^Take Profit/.test(o.orderType) ? "tp" : /^Stop/.test(o.orderType) ? "sl" : null,
  }));
}

export async function fetchPerpOrders(user: string, signal?: AbortSignal): Promise<PerpOrder[]> {
  const u = user.toLowerCase();
  const [rows, dexes] = await Promise.all([info<RawOrder[]>({ type: "frontendOpenOrders", user: u }, signal), dexesInUse()]);
  const more = await Promise.all(dexes.map((d) => info<RawOrder[]>({ type: "frontendOpenOrders", user: u, dex: d.name }, signal).catch(() => null)));
  return [...ordersOf(rows), ...more.flatMap(ordersOf)];
}

/** "xyz:TSLA" → "TSLA" (main-exchange names stay as they are). */
export const coinLabel = (coin: string) => coin.slice(coin.indexOf(":") + 1);

export async function fetchPerpFills(user: string, signal?: AbortSignal): Promise<PerpFill[]> {
  const rows = await info<{ coin: string; px: string; sz: string; side: "B" | "A"; time: number; dir: string; closedPnl: string; fee: string; hash: string; tid?: number }[]>(
    { type: "userFills", user: user.toLowerCase() },
    signal
  );
  return (Array.isArray(rows) ? rows : [])
    .slice(0, 50)
    .map((f) => ({ coin: f.coin, px: num(f.px), sz: num(f.sz), side: f.side, time: f.time, dir: f.dir, pnl: num(f.closedPnl), fee: num(f.fee), hash: f.hash, tid: Number(f.tid) || 0 }));
}

// ------------------------------------------------------------------ order math

/**
 * About where an isolated position is liquidated (Hyperliquid's formula, ignoring funding and
 * fees): maintenance margin is half the initial margin at the market's highest leverage.
 */
export function liqPrice(side: "long" | "short", entry: number, lev: number, hlMaxLev: number): number {
  const l = 1 / (2 * hlMaxLev);
  const room = 1 / lev - l;
  if (room <= 0) return entry;
  return side === "long" ? entry * (1 - room / (1 - l)) : entry * (1 + room / (1 + l));
}

/** A coin amount in Hyperliquid's format: at most szDecimals decimals, rounded down. */
export function sizeString(coins: number, szDecimals: number): string {
  const f = 10 ** szDecimals;
  const v = Math.floor(coins * f + 1e-9) / f;
  return v.toFixed(szDecimals).replace(/\.?0+$/, "") || "0";
}

/**
 * A price in Hyperliquid's format: at most 5 significant digits and at most (6 − szDecimals)
 * decimals; whole numbers are always allowed.
 */
export function priceString(px: number, szDecimals: number): string {
  if (!(px > 0)) return "0";
  if (Number.isInteger(px) && px >= 1e5) return String(px);
  const sig = Number(px.toPrecision(5));
  const maxDec = Math.max(0, 6 - szDecimals);
  return sig.toFixed(maxDec).replace(/\.?0+$/, "");
}

export type OrderPlan = {
  notional: number;
  coins: string;
  liq: number;
  fees: number;
  ok: boolean;
  why: string | null;
};

/** What a market order of `margin` dollars at `lev`x would be. */
/** `entryPx`: a limit order's price (default: today's price, a market order). */
export function planOrder(m: PerpMarket, side: "long" | "short", margin: number, lev: number, available: number, entryPx = m.mark): OrderPlan {
  const notional = margin * lev;
  const at = entryPx > 0 ? entryPx : m.mark;
  const coins = sizeString(notional / at, m.szDecimals);
  // builder exchanges (stocks…) charge up to a few times Hyperliquid's base fee: count it double
  const fees = notional * (HL_TAKER_FEE * (m.dex ? 2 : 1) + BUILDER_FEE);
  const liq = liqPrice(side, at, lev, m.hlMaxLev);
  let why: string | null = null;
  if (!(margin > 0)) why = "Enter an amount.";
  else if (notional < MIN_NOTIONAL) why = `The smallest position is $${MIN_NOTIONAL} (amount × leverage).`;
  else if (Number(coins) <= 0) why = "That amount is too small for this coin.";
  else if (lev > m.maxLev) why = `Up to ${m.maxLev}x on ${m.label}.`;
  else if (margin + fees > available + 1e-9) why = "Not enough in your futures balance. Add money first.";
  return { notional, coins, liq, fees, ok: !why, why };
}

// ------------------------------------------------------------------ where the visitor is

/**
 * Whether Perps is offered where the visitor is (functions/geo.js). If the answer can't be had,
 * trading stays hidden: better a retry than leverage where it isn't allowed.
 */
export async function perpsAllowedHere(): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch("/geo", { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { perps?: boolean; country?: string; region?: string };
        if (typeof j.perps === "boolean") return j.perps && !perpsBlocked(j.country, j.region);
      }
    } catch {
      /* try again */
    }
    await new Promise((res) => setTimeout(res, 800));
  }
  return false;
}
