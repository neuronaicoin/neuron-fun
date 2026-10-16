"use client";

/**
 * Order book and the latest trades of one Hyperliquid market, live (lib/hlws.ts). The book
 * shows the closest prices on each side with depth bars; trades flash in as they happen, and
 * big ones (whales) stand out.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { hlSubscribe } from "@/lib/hlws";
import { HL_API } from "@/lib/perps";
import { compactUsd } from "@/lib/format";
import { fmtPx } from "./perpschart";

type Level = { px: number; sz: number };
type Book = { bids: Level[]; asks: Level[] };
type Trade = { id: string; px: number; sz: number; buy: boolean; time: number };

/** A trade this big (dollars) is shown as a whale. */
export const WHALE_USD = 100_000;

type RawLevel = { px: string; sz: string; n: number };
export function parseBook(d: unknown): Book | null {
  const levels = (d as { levels?: [RawLevel[], RawLevel[]] })?.levels;
  if (!Array.isArray(levels) || levels.length !== 2) return null;
  const side = (l: RawLevel[]) =>
    (Array.isArray(l) ? l : []).map((x) => ({ px: Number(x.px), sz: Number(x.sz) })).filter((x) => x.px > 0 && x.sz > 0);
  return { bids: side(levels[0]), asks: side(levels[1]) };
}

type RawTrade = { coin: string; side: "B" | "A"; px: string; sz: string; time: number; tid: number; hash: string };
export function parseTrades(d: unknown, coin: string): Trade[] {
  return (Array.isArray(d) ? (d as RawTrade[]) : [])
    .filter((t) => t && t.coin === coin)
    .map((t) => ({ id: `${t.tid}:${t.hash}`, px: Number(t.px), sz: Number(t.sz), buy: t.side === "B", time: Number(t.time) }))
    .filter((t) => t.px > 0 && t.sz > 0);
}

function sizeFmt(v: number) {
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (v >= 1) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return v.toLocaleString("en-US", { maximumSignificantDigits: 3 });
}

export function OrderBook({ coin, decimals, rows = 10, split = false }: { coin: string; decimals: number; rows?: number; split?: boolean }) {
  const [tab, setTab] = useState<"book" | "trades">("book");
  const [book, setBook] = useState<Book | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const pending = useRef<Trade[]>([]);

  // the book: a snapshot at once, then every change from the live feed
  useEffect(() => {
    let alive = true;
    setBook(null);
    void fetch(`${HL_API}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "l2Book", coin }) })
      .then((r) => r.json())
      .then((d) => {
        const b = parseBook(d);
        if (alive && b) setBook((now) => now ?? b);
      })
      .catch(() => {});
    const stop = hlSubscribe({ type: "l2Book", coin }, (d) => {
      if ((d as { coin?: string })?.coin !== coin) return;
      const b = parseBook(d);
      if (alive && b) setBook(b);
    });
    return () => {
      alive = false;
      stop();
    };
  }, [coin]);

  // trades: gathered and shown a few times a second (busy markets trade many times a second)
  useEffect(() => {
    let alive = true;
    setTrades([]);
    pending.current = [];
    const stop = hlSubscribe({ type: "trades", coin }, (d) => {
      const t = parseTrades(d, coin);
      if (t.length) pending.current.push(...t);
    });
    const tick = setInterval(() => {
      if (!alive || !pending.current.length) return;
      const fresh = pending.current.splice(0).sort((a, b) => b.time - a.time);
      setTrades((old) => {
        const seen = new Set(old.map((x) => x.id));
        const add: Trade[] = [];
        for (const x of fresh) if (!seen.has(x.id)) (seen.add(x.id), add.push(x));
        return [...add, ...old].slice(0, 60);
      });
    }, 250);
    return () => {
      alive = false;
      clearInterval(tick);
      stop();
    };
  }, [coin]);

  const view = useMemo(() => {
    if (!book) return null;
    const asks = book.asks.slice(0, rows);
    const bids = book.bids.slice(0, rows);
    // running totals from the middle outwards, for the depth bars
    let acc = 0;
    const askRows = asks.map((l) => ((acc += l.sz), { ...l, total: acc }));
    acc = 0;
    const bidRows = bids.map((l) => ((acc += l.sz), { ...l, total: acc }));
    const max = Math.max(askRows[askRows.length - 1]?.total ?? 0, bidRows[bidRows.length - 1]?.total ?? 0) || 1;
    const bestAsk = asks[0]?.px ?? 0;
    const bestBid = bids[0]?.px ?? 0;
    const mid = bestAsk && bestBid ? (bestAsk + bestBid) / 2 : bestAsk || bestBid;
    const spread = bestAsk && bestBid ? bestAsk - bestBid : 0;
    return { askRows: askRows.reverse(), bidRows, max, mid, spread, spreadPct: mid ? (spread / mid) * 100 : 0 };
  }, [book, rows]);

  const head = (third: string) => (
    <div className="mt-2 grid grid-cols-3 px-1.5 text-[0.6875rem] text-ink-3">
      <span>Price</span>
      <span className="text-right">Size ({coin})</span>
      <span className="text-right">{third}</span>
    </div>
  );

  const bookList = !view ? (
    <div className="mt-1 flex flex-col gap-1">
      {Array.from({ length: rows * 2 + 1 }, (_, i) => (
        <div key={i} className="h-5 shimmer rounded" />
      ))}
    </div>
  ) : (
    <div className="mt-1 font-mono text-[0.75rem] tabular-nums">
      {view.askRows.map((l) => (
        <BookRow key={`a${l.px}`} l={l} max={view.max} dec={decimals} side="ask" />
      ))}
      <div className="my-1 px-1.5 py-1.5 rounded-lg bg-paper flex items-baseline justify-between gap-2">
        <span className="text-[0.9375rem] font-semibold text-ink">{fmtPx(view.mid, decimals)}</span>
        <span className="text-[0.6875rem] text-ink-3 truncate" title="Gap between the best buy and sell price">
          Spread {fmtPx(view.spread, decimals)} ({view.spreadPct.toFixed(3)}%)
        </span>
      </div>
      {view.bidRows.map((l) => (
        <BookRow key={`b${l.px}`} l={l} max={view.max} dec={decimals} side="bid" />
      ))}
    </div>
  );

  const tradeList =
    trades.length === 0 ? (
      <p className="py-10 text-center text-[0.8125rem] text-ink-3">Waiting for the next trade…</p>
    ) : (
      <ul className="mt-1 font-mono text-[0.75rem] tabular-nums overflow-y-auto no-scrollbar" style={{ maxHeight: `${(rows * 2 + 2) * 1.375}rem` }}>
        {trades.map((t) => {
          const usd = t.px * t.sz;
          const whale = usd >= WHALE_USD;
          return (
            <li
              key={t.id}
              className={"grid grid-cols-3 px-1.5 h-[1.375rem] items-center rounded " + (whale ? (t.buy ? "bg-up/10 font-bold" : "bg-danger/10 font-bold") : "")}
              title={`${t.buy ? "Buy" : "Sell"} · ${compactUsd(usd)}`}
            >
              <span className={t.buy ? "text-up" : "text-danger"}>{fmtPx(t.px, decimals)}</span>
              <span className="text-right text-ink-2">
                {whale && (
                  <span className="mr-1 font-sans text-[0.625rem] px-1 rounded bg-ink text-paper align-middle" aria-label="Whale trade">
                    {compactUsd(usd)}
                  </span>
                )}
                {sizeFmt(t.sz)}
              </span>
              <span className="text-right text-ink-3">{new Date(t.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</span>
            </li>
          );
        })}
      </ul>
    );

  if (split)
    // wide but not huge screens: book and trades next to each other under the chart
    return (
      <section className="rounded-3xl border border-line bg-surface p-3 min-w-0 grid grid-cols-2 gap-4" aria-label={`${coin} order book and trades`}>
        <div className="min-w-0">
          <h3 className="px-1.5 text-[0.8125rem] font-semibold">Order book</h3>
          {head("Total")}
          {bookList}
        </div>
        <div className="min-w-0">
          <h3 className="px-1.5 text-[0.8125rem] font-semibold">Trades</h3>
          {head("Time")}
          {tradeList}
        </div>
      </section>
    );

  return (
    <section className="rounded-3xl border border-line bg-surface p-3 min-w-0 flex flex-col" aria-label={`${coin} order book and trades`}>
      <div className="flex gap-1 p-1 rounded-xl bg-paper" role="tablist">
        {(
          [
            ["book", "Order book"],
            ["trades", "Trades"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={"flex-1 h-8 rounded-lg text-[0.8125rem] font-semibold " + (tab === k ? "bg-surface text-ink shadow-sm" : "text-ink-3")}
          >
            {label}
          </button>
        ))}
      </div>
      {head(tab === "book" ? "Total" : "Time")}
      {tab === "book" ? bookList : tradeList}
    </section>
  );
}

function BookRow({ l, max, dec, side }: { l: Level & { total: number }; max: number; dec: number; side: "bid" | "ask" }) {
  const w = Math.min(100, (l.total / max) * 100);
  return (
    <div className="relative grid grid-cols-3 px-1.5 h-[1.375rem] items-center">
      <span className={"absolute inset-y-0.5 right-0 rounded-sm " + (side === "bid" ? "bg-up/12" : "bg-danger/12")} style={{ width: `${w}%` }} aria-hidden="true" />
      <span className={"relative " + (side === "bid" ? "text-up" : "text-danger")}>{fmtPx(l.px, dec)}</span>
      <span className="relative text-right text-ink-2">{sizeFmt(l.sz)}</span>
      <span className="relative text-right text-ink-3">{sizeFmt(l.total)}</span>
    </div>
  );
}
