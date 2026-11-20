"use client";

/**
 * DexScreener-style activity block for a coin page: 5M / 1H / 6H / 24H change on top, and for
 * the picked window the trades, volume and traders, each split into buys and sells with a bar.
 *  - sasa race coins: counted from our own trades (race_trades) on the chart's chain
 *  - coins from other DEXs: DexScreener's pair numbers (its free public API)
 * Refreshes by itself; nothing shows until there is something to show.
 */
import { useEffect, useMemo, useState } from "react";
import { db } from "@/lib/data";

type Win = "5m" | "1h" | "6h" | "24h";
const WINS: { k: Win; label: string; ms: number }[] = [
  { k: "5m", label: "5M", ms: 5 * 60_000 },
  { k: "1h", label: "1H", ms: 60 * 60_000 },
  { k: "6h", label: "6H", ms: 6 * 60 * 60_000 },
  { k: "24h", label: "24H", ms: 24 * 60 * 60_000 },
];

type Stats = { change: number | null; buys: number; sells: number; buyVol: number | null; sellVol: number | null; vol: number | null; buyers: number | null; sellers: number | null };
type All = Record<Win, Stats>;

const usd = (v: number) =>
  v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(v >= 100 ? 0 : 2)}`;
const pct = (v: number | null) => (v === null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(2)}%`);

function Split({ label, total, a, b, la, lb }: { label: string; total: string; a: number; b: number; la: string; lb: string }) {
  const share = a + b > 0 ? a / (a + b) : 0.5;
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] sm:grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 items-center py-2 border-t border-line first:border-t-0">
      <div className="min-w-0">
        <div className="text-[0.6875rem] text-ink-3 uppercase tracking-wide">{label}</div>
        <div className="font-mono font-semibold text-[0.9375rem] truncate">{total}</div>
      </div>
      <div className="min-w-0">
        <div className="flex justify-between text-[0.75rem] font-mono gap-2">
          <span className="text-up truncate">{la}</span>
          <span className="text-danger truncate text-right">{lb}</span>
        </div>
        <div className="mt-1 h-1.5 rounded-full overflow-hidden flex bg-paper">
          <span className="h-full bg-up" style={{ width: `${share * 100}%` }} />
          <span className="h-full bg-danger flex-1" />
        </div>
      </div>
    </div>
  );
}

function Panel({ all }: { all: All }) {
  const [win, setWin] = useState<Win>("24h");
  const s = all[win];
  return (
    <section className="rounded-2xl border border-line bg-surface overflow-hidden min-w-0" aria-label="Trading activity">
      <div className="grid grid-cols-4 border-b border-line">
        {WINS.map((w) => {
          const c = all[w.k].change;
          const on = w.k === win;
          return (
            <button
              key={w.k}
              type="button"
              onClick={() => setWin(w.k)}
              aria-pressed={on}
              className={"py-2 px-1 text-center min-w-0 border-l border-line first:border-l-0 " + (on ? "bg-paper" : "hover:bg-paper/60")}
            >
              <div className={"text-[0.6875rem] " + (on ? "text-ink font-bold" : "text-ink-3")}>{w.label}</div>
              <div className={"font-mono font-semibold text-[0.8125rem] sm:text-[0.875rem] truncate " + (c === null ? "text-ink-3" : c >= 0 ? "text-up" : "text-danger")}>{pct(c)}</div>
            </button>
          );
        })}
      </div>
      <div className="px-3 sm:px-4 py-1">
        <Split label="Txns" total={(s.buys + s.sells).toLocaleString("en-US")} a={s.buys} b={s.sells} la={`${s.buys.toLocaleString("en-US")} buys`} lb={`${s.sells.toLocaleString("en-US")} sells`} />
        {s.buyVol !== null && s.sellVol !== null ? (
          <Split label="Volume" total={usd(s.buyVol + s.sellVol)} a={s.buyVol} b={s.sellVol} la={`${usd(s.buyVol)} bought`} lb={`${usd(s.sellVol)} sold`} />
        ) : s.vol !== null ? (
          <div className="flex items-center justify-between py-2 border-t border-line">
            <span className="text-[0.6875rem] text-ink-3 uppercase tracking-wide">Volume</span>
            <span className="font-mono font-semibold text-[0.9375rem]">{usd(s.vol)}</span>
          </div>
        ) : null}
        {s.buyers !== null && s.sellers !== null && (
          <Split label="Traders" total={(s.buyers + s.sellers).toLocaleString("en-US")} a={s.buyers} b={s.sellers} la={`${s.buyers} buyers`} lb={`${s.sellers} sellers`} />
        )}
      </div>
    </section>
  );
}

const empty = (): Stats => ({ change: null, buys: 0, sells: 0, buyVol: 0, sellVol: 0, vol: null, buyers: 0, sellers: 0 });

/** A sasa race coin: its last 24 hours of trades on one chain. */
export function RaceActivity({ coinId, chainId }: { coinId: string; chainId: number | null }) {
  const [all, setAll] = useState<All | null>(null);
  useEffect(() => {
    if (!chainId) return;
    let alive = true;
    const load = async () => {
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const id = coinId.toLowerCase();
      const [{ data: rows }, { data: before }] = await Promise.all([
        db
          .from("race_trades")
          .select("ts,is_buy,usd_amount,price_usd,trader")
          .eq("coin_id", id)
          .eq("chain_id", chainId)
          .neq("via", "system")
          .gte("ts", since)
          .order("ts", { ascending: true })
          .limit(5000),
        db.from("race_trades").select("price_usd").eq("coin_id", id).eq("chain_id", chainId).neq("via", "system").lt("ts", since).order("ts", { ascending: false }).limit(1),
      ]);
      if (!alive) return;
      const t = ((rows ?? []) as Record<string, unknown>[]).map((r) => ({
        ts: new Date(r.ts as string).getTime(),
        buy: !!r.is_buy,
        usd: Number(r.usd_amount) || 0,
        price: Number(r.price_usd) || 0,
        who: String(r.trader || "").toLowerCase(),
      }));
      const prev24 = Number(((before ?? []) as Record<string, unknown>[])[0]?.price_usd) || null;
      const last = t.length ? t[t.length - 1].price : prev24;
      const now = Date.now();
      const out = {} as All;
      for (const w of WINS) {
        const from = now - w.ms;
        const inWin = t.filter((x) => x.ts >= from);
        const s = empty();
        // the price when the window opened: the last trade before it (or the first one in it)
        const beforeWin = t.filter((x) => x.ts < from);
        const start = beforeWin.length ? beforeWin[beforeWin.length - 1].price : w.k === "24h" && prev24 ? prev24 : inWin[0]?.price ?? null;
        s.change = start && last && start > 0 && inWin.length ? ((last - start) / start) * 100 : inWin.length || !last ? null : 0;
        const buyers = new Set<string>();
        const sellers = new Set<string>();
        for (const x of inWin) {
          if (x.buy) {
            s.buys++;
            s.buyVol! += x.usd;
            buyers.add(x.who);
          } else {
            s.sells++;
            s.sellVol! += x.usd;
            sellers.add(x.who);
          }
        }
        s.buyers = buyers.size;
        s.sellers = sellers.size;
        out[w.k] = s;
      }
      setAll(out);
    };
    void load().catch(() => {});
    const iv = setInterval(() => document.visibilityState === "visible" && void load().catch(() => {}), 10_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [coinId, chainId]);
  if (!all || all["24h"].buys + all["24h"].sells === 0) return null;
  return <Panel all={all} />;
}

/** DexScreener's chain names for the networks sasa lists. */
const DS_CHAIN: Record<string, string> = { base: "base", bsc: "bsc", eth: "ethereum", solana: "solana", robinhood: "robinhood", arc: "arc", ely: "elysium" };

type DsKey = "m5" | "h1" | "h6" | "h24";
/** DexScreener names its windows m5 / h1 / h6 / h24. */
const DS_KEY: Record<Win, DsKey> = { "5m": "m5", "1h": "h1", "6h": "h6", "24h": "h24" };
type DsPair = {
  pairAddress?: string;
  liquidity?: { usd?: number };
  priceChange?: Partial<Record<DsKey, number>>;
  txns?: Partial<Record<DsKey, { buys?: number; sells?: number }>>;
  volume?: Partial<Record<DsKey, number>>;
};

/** A coin from another DEX: DexScreener's numbers for its pool (or its biggest pool). */
export function ExtActivity({ network, address, pool }: { network: string; address: string; pool?: string | null }) {
  const [pair, setPair] = useState<DsPair | null>(null);
  useEffect(() => {
    const chain = DS_CHAIN[network];
    if (!chain) return;
    let alive = true;
    const load = () =>
      fetch(`https://api.dexscreener.com/tokens/v1/${chain}/${address}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((list: DsPair[]) => {
          if (!alive || !Array.isArray(list) || !list.length) return;
          const mine = pool ? list.find((p) => (p.pairAddress ?? "").toLowerCase() === pool.toLowerCase()) : null;
          const best = mine ?? [...list].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
          setPair(best ?? null);
        })
        .catch(() => {});
    void load();
    const iv = setInterval(() => document.visibilityState === "visible" && void load(), 20_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [network, address, pool]);
  const all = useMemo(() => {
    if (!pair) return null;
    const out = {} as All;
    for (const w of WINS) {
      const key = DS_KEY[w.k];
      const tx = pair.txns?.[key];
      const c = pair.priceChange?.[key];
      out[w.k] = {
        change: typeof c === "number" ? c : null,
        buys: tx?.buys ?? 0,
        sells: tx?.sells ?? 0,
        buyVol: null,
        sellVol: null,
        vol: typeof pair.volume?.[key] === "number" ? (pair.volume![key] as number) : null,
        buyers: null,
        sellers: null,
      };
    }
    return out;
  }, [pair]);
  if (!all || all["24h"].buys + all["24h"].sells === 0) return null;
  return <Panel all={all} />;
}
