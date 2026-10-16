/**
 * The Data tab: market numbers anyone can see (no trading, open in every country).
 * Live from Hyperliquid's free public API (markets, funding on other exchanges, any trader's
 * positions) and, from sasa's indexer (indexer/whales.mjs, data.sql), the top traders list and
 * the hourly Market Fear & Greed history.
 */
import { db } from "./data";
import { info } from "./perps";
import { authedDelete, authedGet, authedPost, type SignFn } from "./alerts";

export type Venue = "hl" | "binance" | "bybit";
/** A coin's funding, a year's worth in %, on each exchange (null where it isn't listed). */
export type FundingRow = { coin: string; hl: number | null; binance: number | null; bybit: number | null };

const VENUES: Record<string, Venue> = { HlPerp: "hl", BinPerp: "binance", BybitPerp: "bybit" };
/** Hours between payments when the answer doesn't say (Hyperliquid pays every hour). */
const DEFAULT_HOURS: Record<Venue, number> = { hl: 1, binance: 8, bybit: 8 };

type RawPredicted = [string, ([string, { fundingRate: string; nextFundingTime: number; fundingIntervalHours?: number } | null] | null)[]][];

/** One payment's rate → a year's worth, in %. */
export const annualize = (rate: number, hours: number) => rate * (24 / hours) * 365 * 100;

export function parsePredicted(raw: unknown): FundingRow[] {
  const out: FundingRow[] = [];
  for (const row of (Array.isArray(raw) ? raw : []) as RawPredicted) {
    if (!Array.isArray(row) || typeof row[0] !== "string" || !Array.isArray(row[1])) continue;
    const r: FundingRow = { coin: row[0], hl: null, binance: null, bybit: null };
    for (const v of row[1]) {
      if (!Array.isArray(v) || !v[1]) continue;
      const venue = VENUES[v[0]];
      const rate = Number(v[1].fundingRate);
      if (!venue || !Number.isFinite(rate)) continue;
      const hours = Number(v[1].fundingIntervalHours) > 0 ? Number(v[1].fundingIntervalHours) : DEFAULT_HOURS[venue];
      r[venue] = annualize(rate, hours);
    }
    out.push(r);
  }
  return out;
}

export async function fetchFundingVenues(signal?: AbortSignal): Promise<FundingRow[]> {
  return parsePredicted(await info<unknown>({ type: "predictedFundings" }, signal));
}

// ------------------------------------------------------------------ top traders (indexer)

export type Whale = {
  address: string;
  rank: number;
  name: string | null;
  accountValue: number;
  pnlDay: number;
  pnlWeek: number;
  pnlMonth: number;
  pnlAll: number;
  roiMonth: number;
  volMonth: number;
};

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
function toWhale(r: Record<string, unknown>): Whale {
  return {
    address: String(r.address ?? "").toLowerCase(),
    rank: n(r.rank),
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 40) : null,
    accountValue: n(r.account_value),
    pnlDay: n(r.pnl_day),
    pnlWeek: n(r.pnl_week),
    pnlMonth: n(r.pnl_month),
    pnlAll: n(r.pnl_all),
    roiMonth: n(r.roi_month) * 100,
    volMonth: n(r.vol_month),
  };
}

export async function fetchWhales(): Promise<Whale[]> {
  const { data, error } = await db.from("whales_pub").select("*").order("rank", { ascending: true }).limit(100);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(toWhale);
}

export async function fetchWhale(address: string): Promise<Whale | null> {
  const { data, error } = await db.from("whales_pub").select("*").eq("address", address.toLowerCase()).maybeSingle();
  if (error) throw error;
  return data ? toWhale(data as Record<string, unknown>) : null;
}

/** "Whale #3" for listed traders (their chosen name if they set one on Hyperliquid). */
export const whaleName = (w: Pick<Whale, "rank" | "name"> | null, address: string) =>
  w?.name ? w.name : w?.rank ? `Whale #${w.rank}` : `${address.slice(0, 6)}…${address.slice(-4)}`;

export const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

// ------------------------------------------------------------------ fear & greed history (indexer)

export type FgPoint = { t: number; score: number };

/** One value a day (the day's last), oldest first. */
export async function fetchFearHistory(days = 30): Promise<FgPoint[]> {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const { data, error } = await db.from("fear_greed_pub").select("t,score").gte("t", since).order("t", { ascending: true }).limit(days * 24 + 48);
  if (error) throw error;
  const byDay = new Map<string, FgPoint>();
  for (const r of (data ?? []) as { t: string; score: number }[]) {
    const t = new Date(r.t).getTime();
    byDay.set(new Date(t).toISOString().slice(0, 10), { t, score: Number(r.score) });
  }
  return [...byDay.values()];
}

// ------------------------------------------------------------------ following whales (alerts)

export async function myFollows(sign: SignFn): Promise<string[]> {
  const r = await authedGet<{ whales: string[] }>(sign, "whales/follow");
  return (r.whales ?? []).map((a) => a.toLowerCase());
}
export async function followWhale(sign: SignFn, whale: string): Promise<void> {
  await authedPost(sign, "whales/follow", { whale: whale.toLowerCase() });
}
export async function unfollowWhale(sign: SignFn, whale: string): Promise<void> {
  await authedDelete(sign, `whales/follow/${whale.toLowerCase()}`);
}
