import { db } from "./data";
import { RACE_SUPPLY, leadLane, raceChain, type RaceChain, type RaceCoin } from "./race";

/**
 * Who is up and who is down on a race coin, from its trades (every chain counted together: at
 * the end of the race the coins on the losing chains are moved to the same wallet on the winner).
 *   in       dollars paid for buys          out    dollars received for sells
 *   held     coins still held (bought − sold)
 *   value    held × the coin's price now    pnl    out + value − in
 *   entryMc  the market cap the wallet got in at, on average
 */
export type WalletPnl = {
  trader: string;
  in: number;
  out: number;
  held: number;
  value: number;
  pnl: number;
  pnlPct: number | null;
  entryMc: number | null;
  lastTs: number;
};

type TradeRow = { price_usd?: number | string; trader: string; is_buy: boolean; usd_amount: number | string; token_amount: number | string; ts: string; coin_id?: string; chain_id?: number };

/** A price whose market cap would be over $1T is a broken pool (an early BNB launch), not a price. */
const sane = (p: number | null | undefined) => !!p && p > 0 && p * RACE_SUPPLY < 1e12;

/** The coin's price now: the winner's after the race, else the chain with the most money. */
export function coinPrice(c: RaceCoin): number | null {
  const lane = c.winner ? c.lanes.find((l) => l.chain.chainId === c.winner!.chainId) : leadLane(c);
  if (sane(lane?.priceUsd)) return lane!.priceUsd;
  const ok = c.lanes.filter((l) => sane(l.priceUsd)).sort((a, b) => b.poolUsd - a.poolUsd)[0];
  return ok?.priceUsd ?? null;
}

function fold(rows: TradeRow[], price: number, supply = RACE_SUPPLY): WalletPnl[] {
  const by = new Map<string, { in: number; out: number; got: number; gave: number; lastTs: number }>();
  for (const r of rows) {
    if (r.price_usd !== undefined && !sane(Number(r.price_usd))) continue;
    const k = r.trader.toLowerCase();
    const w = by.get(k) ?? { in: 0, out: 0, got: 0, gave: 0, lastTs: 0 };
    const usd = Number(r.usd_amount) || 0;
    const tok = Number(r.token_amount) || 0;
    if (r.is_buy) {
      w.in += usd;
      w.got += tok;
    } else {
      w.out += usd;
      w.gave += tok;
    }
    w.lastTs = Math.max(w.lastTs, new Date(r.ts).getTime());
    by.set(k, w);
  }
  return [...by.entries()].map(([trader, w]) => {
    const held = Math.max(0, w.got - w.gave);
    const value = held * price;
    // coins sold that this wallet never bought here (moved in from another wallet): their cost is
    // unknown, so only the part of the sales covered by its own buys counts
    const out = w.gave > w.got && w.gave > 0 ? w.out * (w.got / w.gave) : w.out;
    const pnl = out + value - w.in;
    return {
      trader,
      in: w.in,
      out,
      held,
      value,
      pnl,
      pnlPct: w.in > 0.5 ? (pnl / w.in) * 100 : null,
      entryMc: w.got > 0 ? (w.in / w.got) * supply : null,
      lastTs: w.lastTs,
    };
  });
}

async function pages(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>, max: number): Promise<TradeRow[]> {
  const out: TradeRow[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await q(from, Math.min(max, from + 1000) - 1);
    if (error) throw error;
    const rows = (data ?? []) as TradeRow[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

/** Everyone who traded the coin, biggest position first (wallets that sold everything last). */
export async function fetchCoinPnl(coin: RaceCoin, max = 3000, supply = RACE_SUPPLY): Promise<WalletPnl[]> {
  const price = coinPrice(coin) ?? 0;
  const rows = await pages(
    (a, b) =>
      db
        .from("race_trades")
        .select("trader,is_buy,usd_amount,token_amount,price_usd,ts")
        .eq("coin_id", coin.id.toLowerCase())
        .neq("via", "system")
        .order("ts", { ascending: false })
        .range(a, b),
    max
  );
  return fold(rows, price, supply)
    .filter((w) => w.in > 0 || w.held > 0)
    .sort((x, y) => y.value - x.value || y.pnl - x.pnl);
}

export type BigWin = WalletPnl & { coin: RaceCoin; chain: RaceChain | null };

/** The week's best trades on sasa: one per wallet, the coin it made the most on. */
export async function fetchWeekWins(coins: RaceCoin[], top = 8): Promise<BigWin[]> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const byId = new Map(coins.map((c) => [c.id.toLowerCase(), c]));
  const rows = await pages(
    (a, b) =>
      db
        .from("race_trades")
        .select("coin_id,chain_id,trader,is_buy,usd_amount,token_amount,price_usd,ts")
        .gte("ts", since)
        .neq("via", "system")
        .order("ts", { ascending: false })
        .range(a, b),
    6000
  );
  const perCoin = new Map<string, TradeRow[]>();
  for (const r of rows) {
    const id = (r.coin_id ?? "").toLowerCase();
    if (!byId.has(id)) continue;
    (perCoin.get(id) ?? perCoin.set(id, []).get(id)!).push(r);
  }
  const best = new Map<string, BigWin>();
  for (const [id, list] of perCoin) {
    const coin = byId.get(id)!;
    const price = coinPrice(coin);
    if (!price) continue;
    for (const w of fold(list, price)) {
      if (w.pnl < 1) continue;
      const prev = best.get(w.trader);
      if (!prev || w.pnl > prev.pnl) best.set(w.trader, { ...w, coin, chain: coin.winner ?? raceChain(Number(list[0].chain_id)) ?? null });
    }
  }
  return [...best.values()].sort((a, b) => b.pnl - a.pnl).slice(0, top);
}
