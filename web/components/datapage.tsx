"use client";

/**
 * Data: what the crypto market is doing right now, for everyone (no trading here, open in every
 * country). Market Fear & Greed, the market's pulse, whale trades as they happen, the top traders
 * (follow one for phone alerts), funding across exchanges, and the day's movers. Live from
 * Hyperliquid; the top traders and the Fear & Greed history come from sasa's indexer.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { MarketSwitch } from "./marketswitch";
import { FollowButton } from "./whalefollow";
import { compactUsd } from "@/lib/format";
import { fetchPerpMarkets, type PerpMarket } from "@/lib/perps";
import { fearGreed, fgLabel, type FearGreed } from "@/lib/feargreed.js";
import { fetchFearHistory, fetchFundingVenues, fetchWhales, whaleName, type FgPoint, type FundingRow, type Whale } from "@/lib/hldata";
import { hlOnStatus, hlSubscribe } from "@/lib/hlws";

const pct = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`);
const tone = (v: number | null | undefined) => (!v ? "text-ink-3" : v > 0 ? "text-up" : "text-danger");
const signedUsd = (v: number) => `${v >= 0 ? "+" : "−"}${compactUsd(Math.abs(v))}`;
function px(v: number) {
  if (!Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return Number(v.toPrecision(5)).toLocaleString("en-US", { maximumSignificantDigits: 5 });
}

/** The five zones of the dial, fear to greed. */
const ZONES = [
  { to: 25, color: "#e5484d" },
  { to: 45, color: "#f76b15" },
  { to: 56, color: "#e2a336" },
  { to: 76, color: "#46a758" },
  { to: 100, color: "#12a150" },
];
export const zoneColor = (score: number) => (ZONES.find((z) => score < z.to) ?? ZONES[ZONES.length - 1]).color;

export function DataPage() {
  const [markets, setMarkets] = useState<PerpMarket[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchPerpMarkets()
        .then((m) => alive && (setMarkets(m), setErr(false)))
        .catch(() => alive && setErr(true));
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const fg = useMemo(() => (markets ? fearGreed(markets) : null), [markets]);

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-5 sm:py-8 pb-28 md:pb-12">
      <MarketSwitch at="data" />
      <div className="mt-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
        <h1 className="font-display font-bold text-[1.75rem] sm:text-[2.5rem] tracking-tight leading-none">Market data</h1>
        <p className="text-ink-3 text-[0.875rem]">Live from Hyperliquid, the biggest on-chain futures exchange.</p>
      </div>
      {err && !markets && <p className="mt-4 rounded-xl px-3 py-2 bg-warn-bg text-warn-ink text-[0.875rem]">Hyperliquid can&apos;t be reached right now. The numbers come back by themselves.</p>}

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <FearGreedCard fg={fg} />
        <Pulse markets={markets} fg={fg} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] items-start">
        <WhaleTape markets={markets} />
        <TopTraders />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] items-start">
        <Funding markets={markets} />
        <Movers markets={markets} />
      </div>

      <p className="mt-6 text-[0.75rem] text-ink-3 max-w-2xl">
        Market data only, not advice. Fear &amp; Greed is sasa&apos;s own reading of Hyperliquid&apos;s markets: how many are up, Bitcoin&apos;s day, the average move, and what longs pay in
        funding.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ fear & greed

function Gauge({ score }: { score: number | null }) {
  // 180° dial, 0 on the left; the needle swings in once, then follows the score
  const r = 120;
  const cx = 150;
  const cy = 150;
  const pt = (v: number, rad = r) => {
    const a = Math.PI * (1 - v / 100);
    return [cx + rad * Math.cos(a), cy - rad * Math.sin(a)] as const;
  };
  let from = 0;
  const arcs = ZONES.map((z) => {
    const [x1, y1] = pt(from + 0.8);
    const [x2, y2] = pt(z.to - 0.8);
    const d = `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
    from = z.to;
    return { d, color: z.color };
  });
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (score === null) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return setShown(score);
    const id = requestAnimationFrame(() => setShown(score));
    return () => cancelAnimationFrame(id);
  }, [score]);
  const angle = -90 + (shown / 100) * 180;
  return (
    <svg viewBox="0 0 300 170" className="w-full max-w-[22rem]" role="img" aria-label={score === null ? "Loading" : `Market Fear and Greed: ${score} of 100, ${fgLabel(score)}`}>
      {arcs.map((a, i) => (
        <path key={i} d={a.d} fill="none" stroke={a.color} strokeWidth={22} strokeLinecap="butt" opacity={score === null ? 0.25 : 1} />
      ))}
      {[0, 25, 50, 75, 100].map((v) => {
        const [x, y] = pt(v, r - 26);
        return (
          <text key={v} x={x} y={y + 4} textAnchor="middle" className="fill-ink-3" fontSize="10" fontFamily="Instrument Sans, sans-serif">
            {v}
          </text>
        );
      })}
      <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: `${cx}px ${cy}px`, transition: "transform 1.1s cubic-bezier(.2,.9,.25,1.05)" }} opacity={score === null ? 0 : 1}>
        <path d={`M ${cx - 5} ${cy} L ${cx} ${cy - r + 8} L ${cx + 5} ${cy} Z`} className="fill-ink" />
      </g>
      <circle cx={cx} cy={cy} r={9} className="fill-ink" />
      <circle cx={cx} cy={cy} r={3.5} className="fill-surface" />
    </svg>
  );
}

function FearGreedCard({ fg }: { fg: FearGreed | null }) {
  const [hist, setHist] = useState<FgPoint[] | null>(null);
  useEffect(() => {
    void fetchFearHistory(30)
      .then(setHist)
      .catch(() => setHist([]));
  }, []);
  const ago = (days: number) => {
    if (!hist?.length) return null;
    const t = Date.now() - days * 86400e3;
    let best: FgPoint | null = null;
    for (const p of hist) if (p.t <= t + 3600e3) best = p;
    return best;
  };
  const past = [
    { k: "Yesterday", p: ago(1) },
    { k: "Last week", p: ago(7) },
    { k: "Last month", p: ago(28) },
  ];
  const drivers = fg
    ? [
        { k: "Markets up today", v: fg.parts.breadth, text: `${Math.round(fg.upShare * 100)}% of the 50 busiest` },
        { k: "Bitcoin today", v: fg.parts.bitcoin, text: pct(fg.btcMove, 1) },
        { k: "Average move", v: fg.parts.momentum, text: pct(fg.avgMove, 1) },
        { k: "Funding", v: fg.parts.funding, text: `${fg.fundingYear >= 0 ? "Longs pay" : "Shorts pay"} ${Math.abs(fg.fundingYear).toFixed(0)}% a year` },
      ]
    : null;
  const color = fg ? zoneColor(fg.score) : undefined;

  return (
    <section className="rounded-3xl border border-line bg-surface p-5 sm:p-6 min-w-0" aria-labelledby="fg-title">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="fg-title" className="font-display font-bold text-[1.125rem]">
          Market Fear &amp; Greed
        </h2>
        <span className="text-[0.75rem] text-ink-3">Updates every 15 s</span>
      </div>
      <div className="mt-3 grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center">
        <div className="flex flex-col items-center">
          <Gauge score={fg?.score ?? null} />
          <div className="mt-2 text-center">
            <div className="font-display font-extrabold text-[3.25rem] leading-none tabular-nums" style={{ color }}>
              {fg ? fg.score : <span className="text-ink-3">··</span>}
            </div>
            <div className="mt-1 font-display font-bold text-[1.125rem]" style={{ color }}>
              {fg ? fg.label : "Reading the market…"}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-4 min-w-0">
          <ul className="grid grid-cols-3 gap-2" aria-label="Earlier readings">
            {past.map(({ k, p }) => (
              <li key={k} className="rounded-2xl bg-paper px-3 py-2.5 min-w-0">
                <div className="text-[0.6875rem] text-ink-3 truncate">{k}</div>
                {p ? (
                  <>
                    <div className="font-display font-bold text-[1.25rem] tabular-nums leading-tight" style={{ color: zoneColor(p.score) }}>
                      {p.score}
                    </div>
                    <div className="text-[0.6875rem] text-ink-2 truncate">{fgLabel(p.score)}</div>
                  </>
                ) : (
                  <div className="font-display font-bold text-[1.25rem] text-ink-3 leading-tight">—</div>
                )}
              </li>
            ))}
          </ul>
          {hist && hist.length > 1 && <History hist={hist} />}
          <ul className="flex flex-col gap-2.5" aria-label="What moves the number">
            {(drivers ?? Array.from({ length: 4 }, () => null)).map((d, i) => (
              <li key={i} className="min-w-0">
                {d ? (
                  <>
                    <div className="flex items-baseline justify-between gap-2 text-[0.8125rem]">
                      <span className="text-ink-2">{d.k}</span>
                      <span className="font-mono text-[0.75rem] text-ink-3 truncate">{d.text}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-paper overflow-hidden" aria-hidden="true">
                      <div className="h-full rounded-full" style={{ width: `${Math.round(d.v * 100)}%`, background: zoneColor(d.v * 100) }} />
                    </div>
                  </>
                ) : (
                  <div className="h-6 shimmer rounded" />
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** 30 days of daily readings, coloured by zone. */
function History({ hist }: { hist: FgPoint[] }) {
  const w = 300;
  const h = 44;
  const xs = (i: number) => (i / (hist.length - 1)) * w;
  const ys = (v: number) => h - (v / 100) * h;
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-11" role="img" aria-label="The last 30 days">
        <line x1="0" x2={w} y1={ys(50)} y2={ys(50)} className="stroke-line" strokeDasharray="3 4" />
        {hist.slice(1).map((p, i) => (
          <line key={i} x1={xs(i)} y1={ys(hist[i].score)} x2={xs(i + 1)} y2={ys(p.score)} stroke={zoneColor((p.score + hist[i].score) / 2)} strokeWidth="2.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <figcaption className="flex justify-between text-[0.6875rem] text-ink-3">
        <span>30 days ago</span>
        <span>Today</span>
      </figcaption>
    </figure>
  );
}

// ------------------------------------------------------------------ pulse

function Pulse({ markets, fg }: { markets: PerpMarket[] | null; fg: FearGreed | null }) {
  const btc = markets?.find((m) => m.coin === "BTC") ?? null;
  const eth = markets?.find((m) => m.coin === "ETH") ?? null;
  const oi = markets?.reduce((s, m) => s + m.openInterestUsd, 0) ?? null;
  const vol = markets?.reduce((s, m) => s + m.volume24h, 0) ?? null;
  const items: { k: string; v: string; sub: string; subTone?: string; href?: string }[] = [
    { k: "Bitcoin", v: btc ? `$${px(btc.mark)}` : "—", sub: btc ? pct(btc.change24h) : "", subTone: tone(btc?.change24h), href: "/futures/?c=BTC" },
    { k: "Ethereum", v: eth ? `$${px(eth.mark)}` : "—", sub: eth ? pct(eth.change24h) : "", subTone: tone(eth?.change24h), href: "/futures/?c=ETH" },
    { k: "Open positions", v: oi !== null ? compactUsd(oi) : "—", sub: "on all markets" },
    { k: "Traded today", v: vol !== null ? compactUsd(vol) : "—", sub: "last 24 hours" },
    {
      k: "Funding",
      v: fg ? `${fg.fundingYear >= 0 ? "+" : "−"}${Math.abs(fg.fundingYear).toFixed(1)}%` : "—",
      sub: fg ? (fg.fundingYear >= 0 ? "a year, longs pay shorts" : "a year, shorts pay longs") : "",
    },
    { k: "Markets", v: markets ? String(markets.length) : "—", sub: fg ? `${Math.round(fg.upShare * 100)}% of the busiest are up` : "" },
  ];
  return (
    <section className="rounded-3xl border border-line bg-surface p-5 sm:p-6 min-w-0" aria-labelledby="pulse-title">
      <h2 id="pulse-title" className="font-display font-bold text-[1.125rem]">
        Right now
      </h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-4">
        {items.map((it) => {
          const body = (
            <>
              <dt className="text-[0.75rem] text-ink-3">{it.k}</dt>
              <dd className="m-0">
                <div className="font-display font-bold text-[1.375rem] sm:text-[1.5rem] tabular-nums leading-tight">{markets ? it.v : <span className="inline-block w-24 h-6 shimmer rounded" />}</div>
                <div className={"text-[0.75rem] " + (it.subTone ?? "text-ink-3")}>{it.sub}</div>
              </dd>
            </>
          );
          return (
            <div key={it.k} className="relative rounded-xl -m-1.5 p-1.5 hover:bg-paper">
              {body}
              {it.href && (
                <Link href={it.href} className="absolute inset-0 rounded-xl" aria-label={`Trade ${it.k}`}>
                  <span className="sr-only">Trade {it.k}</span>
                </Link>
              )}
            </div>
          );
        })}
      </dl>
    </section>
  );
}

// ------------------------------------------------------------------ whale trades

type Big = { id: string; coin: string; buy: boolean; usd: number; px: number; time: number };
const TAPE_LEVELS = [100_000, 500_000, 1_000_000] as const;

function usePageVisible() {
  const [v, setV] = useState(true);
  useEffect(() => {
    const on = () => setV(document.visibilityState === "visible");
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return v;
}

function ago(ms: number) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function WhaleTape({ markets }: { markets: PerpMarket[] | null }) {
  const [rows, setRows] = useState<Big[]>([]);
  const [min, setMin] = useState<number>(TAPE_LEVELS[0]);
  const [live, setLive] = useState(false);
  const [, tick] = useState(0);
  const fresh = useRef(new Set<string>());
  // the 20 busiest markets (the whales are there)
  const coins = useMemo(() => (markets ?? []).slice(0, 20).map((m) => m.coin), [markets]);
  // sorted: the busiest-first order changes all the time, the set hardly ever
  const coinsKey = [...coins].sort().join(",");
  const visible = usePageVisible();
  useEffect(() => {
    // a hidden tab doesn't need the feed (phones: battery and data)
    if (!coinsKey || !visible) return;
    // one order often fills against many resting orders: its pieces share the transaction, so they
    // are added up before the size is judged
    let pieces = new Map<string, Big>();
    const stops = coinsKey.split(",").map((c) =>
      hlSubscribe({ type: "trades", coin: c }, (d) => {
        for (const t of (Array.isArray(d) ? d : []) as { coin: string; side: "B" | "A"; px: string; sz: string; time: number; tid: number; hash: string }[]) {
          if (t.coin !== c) continue;
          const usd = Number(t.px) * Number(t.sz);
          if (!(usd > 0)) continue;
          const k = `${t.hash}:${t.side}:${c}`;
          const o = pieces.get(k);
          if (o) {
            o.px = (o.px * o.usd + Number(t.px) * usd) / (o.usd + usd);
            o.usd += usd;
            o.time = Math.max(o.time, Number(t.time));
          } else pieces.set(k, { id: k, coin: c, buy: t.side === "B", usd, px: Number(t.px), time: Number(t.time) });
        }
      })
    );
    const stopStatus = hlOnStatus(setLive);
    const flush = setInterval(() => {
      if (!pieces.size) return;
      const add = [...pieces.values()].filter((r) => r.usd >= TAPE_LEVELS[0]);
      pieces = new Map();
      if (!add.length) return;
      setRows((old) => {
        const seen = new Set(old.map((r) => r.id));
        const next = add.filter((r) => !seen.has(r.id) && (seen.add(r.id), true)).sort((a, b) => b.time - a.time);
        next.forEach((r) => fresh.current.add(r.id));
        setTimeout(() => {
          next.forEach((r) => fresh.current.delete(r.id));
          tick((n) => n + 1);
        }, 1600);
        return [...next, ...old].sort((a, b) => b.time - a.time).slice(0, 120);
      });
    }, 400);
    const clock = setInterval(() => tick((n) => n + 1), 5_000);
    return () => {
      stops.forEach((s) => s());
      stopStatus();
      clearInterval(flush);
      clearInterval(clock);
    };
  }, [coinsKey, visible]);
  const shown = rows.filter((r) => r.usd >= min).slice(0, 40);
  // buying vs selling among the whale trades of the last 15 minutes
  const recent = rows.filter((r) => Date.now() - r.time < 15 * 60e3);
  const buyUsd = recent.filter((r) => r.buy).reduce((s, r) => s + r.usd, 0);
  const sellUsd = recent.filter((r) => !r.buy).reduce((s, r) => s + r.usd, 0);
  const total = buyUsd + sellUsd;
  const biggest = Math.max(...shown.map((r) => r.usd), min * 4);

  return (
    <section className="rounded-3xl border border-line bg-surface p-5 sm:p-6 min-w-0" aria-labelledby="tape-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="tape-title" className="font-display font-bold text-[1.125rem]">
            Whale trades
          </h2>
          <p className="text-[0.8125rem] text-ink-3">Every big trade on the 20 busiest markets, as it happens.</p>
        </div>
        <span className={"shrink-0 flex items-center gap-1.5 text-[0.75rem] " + (live ? "text-up" : "text-ink-3")}>
          <span className={"w-2 h-2 rounded-full " + (live ? "bg-up animate-pulse" : "bg-ink-3")} aria-hidden="true" />
          {live ? "Live" : "Connecting…"}
        </span>
      </div>

      <div className="mt-4" aria-label="Whales buying or selling, last 15 minutes">
        <div className="flex justify-between text-[0.75rem] mb-1">
          <span className="text-up font-semibold">Buying {total ? compactUsd(buyUsd) : ""}</span>
          <span className="text-ink-3">last 15 min</span>
          <span className="text-danger font-semibold">{total ? compactUsd(sellUsd) : ""} Selling</span>
        </div>
        <div className="h-2.5 rounded-full overflow-hidden flex bg-paper">
          {total > 0 && (
            <>
              <div className="h-full bg-up transition-[width] duration-700" style={{ width: `${(buyUsd / total) * 100}%` }} />
              <div className="h-full bg-danger flex-1" />
            </>
          )}
        </div>
      </div>

      <div className="mt-4 flex gap-1" role="group" aria-label="Smallest trade shown">
        {TAPE_LEVELS.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={min === v}
            onClick={() => setMin(v)}
            className={"h-8 px-3 rounded-lg text-[0.8125rem] font-semibold " + (min === v ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper")}
          >
            {compactUsd(v)}+
          </button>
        ))}
      </div>

      <ol className="mt-3 flex flex-col gap-1 min-h-[22rem] max-h-[29rem] overflow-y-auto no-scrollbar" aria-live="off">
        {shown.length === 0 ? (
          <li className="py-12 text-center text-[0.875rem] text-ink-3">{markets ? "Watching for the next big trade…" : "Loading markets…"}</li>
        ) : (
          shown.map((r) => (
            <li
              key={r.id}
              className={"relative rounded-xl px-3 py-2 grid grid-cols-[2.6rem_minmax(0,1fr)_auto] items-center gap-2 overflow-hidden transition-colors duration-1000 " + (fresh.current.has(r.id) ? (r.buy ? "bg-up/15" : "bg-danger/15") : "")}
            >
              {/* the bar's length is the trade's size */}
              <span
                className={"absolute inset-y-1 left-1 rounded-lg " + (r.buy ? "bg-up/10" : "bg-danger/10")}
                style={{ width: `${Math.max(6, (Math.log(r.usd / (min * 0.9)) / Math.log(biggest / (min * 0.9))) * 100)}%` }}
                aria-hidden="true"
              />
              <span className="relative text-[0.75rem] text-ink-3 tabular-nums">{ago(r.time)}</span>
              <Link href={`/futures/?c=${encodeURIComponent(r.coin)}`} className="relative min-w-0 flex items-baseline gap-2 hover:underline">
                <b className="font-semibold text-[0.9375rem] truncate">{r.coin}</b>
                <span className={"text-[0.75rem] font-semibold " + (r.buy ? "text-up" : "text-danger")}>{r.buy ? "bought" : "sold"}</span>
                <span className="text-[0.75rem] text-ink-3 font-mono truncate">at {px(r.px)}</span>
              </Link>
              <span className={"relative font-display font-bold tabular-nums " + (r.usd >= 1_000_000 ? "text-[1.0625rem]" : "text-[0.9375rem]") + (r.buy ? " text-up" : " text-danger")}>{compactUsd(r.usd)}</span>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------ top traders

type Period = "pnlMonth" | "pnlWeek" | "pnlAll";

function TopTraders() {
  const [whales, setWhales] = useState<Whale[] | null>(null);
  const [period, setPeriod] = useState<Period>("pnlMonth");
  useEffect(() => {
    void fetchWhales()
      .then(setWhales)
      .catch(() => setWhales([]));
  }, []);
  const [all, setAll] = useState(false);
  const list = useMemo(() => (whales ? [...whales].sort((a, b) => b[period] - a[period]).slice(0, all ? 50 : 10) : null), [whales, period, all]);
  return (
    <section className="rounded-3xl border border-line bg-surface p-5 sm:p-6 min-w-0" aria-labelledby="top-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="top-title" className="font-display font-bold text-[1.125rem]">
            Top traders
          </h2>
          <p className="text-[0.8125rem] text-ink-3">The biggest winners on Hyperliquid. Open one to see what they hold right now.</p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Profit over">
          {(
            [
              ["pnlWeek", "7 days"],
              ["pnlMonth", "30 days"],
              ["pnlAll", "All time"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={period === k}
              onClick={() => setPeriod(k)}
              className={"h-8 px-3 rounded-lg text-[0.8125rem] font-semibold " + (period === k ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {list === null ? (
        <div className="mt-4 flex flex-col gap-2">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="h-12 shimmer rounded-xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <p className="mt-6 py-10 text-center text-[0.875rem] text-ink-3">The top traders list fills in a few minutes after sasa starts reading Hyperliquid.</p>
      ) : (
        <table className="mt-3 w-full text-[0.875rem] border-separate border-spacing-y-1">
          <thead>
            <tr className="text-[0.75rem] text-ink-3 text-left">
              <th className="font-normal pl-2 w-8">#</th>
              <th className="font-normal">Trader</th>
              <th className="font-normal text-right">Profit</th>
              <th className="font-normal text-right hidden sm:table-cell">Return</th>
              <th className="font-normal text-right hidden md:table-cell">Account</th>
              <th className="font-normal w-10">
                <span className="sr-only">Alerts</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((w, i) => (
              <tr key={w.address} className="group">
                <td className="pl-2 py-2 rounded-l-xl group-hover:bg-paper text-ink-3 tabular-nums">{i + 1}</td>
                <td className="py-2 group-hover:bg-paper min-w-0">
                  <Link href={`/data/whale/?a=${w.address}`} className="flex items-center gap-2.5 min-w-0">
                    <Avatar address={w.address} />
                    <span className="min-w-0">
                      <span className="block font-semibold truncate max-w-[9rem] sm:max-w-[14rem]">{whaleName(w, w.address)}</span>
                      <span className="block text-[0.6875rem] text-ink-3 font-mono">
                        {w.address.slice(0, 6)}…{w.address.slice(-4)}
                      </span>
                    </span>
                  </Link>
                </td>
                <td className={"py-2 group-hover:bg-paper text-right font-display font-bold tabular-nums " + tone(w[period])}>{signedUsd(w[period])}</td>
                <td className={"py-2 group-hover:bg-paper text-right tabular-nums hidden sm:table-cell " + tone(w.roiMonth)}>{period === "pnlMonth" ? pct(w.roiMonth, 0) : "—"}</td>
                <td className="py-2 group-hover:bg-paper text-right tabular-nums hidden md:table-cell text-ink-2">{compactUsd(w.accountValue)}</td>
                <td className="py-2 pr-2 rounded-r-xl group-hover:bg-paper text-right">
                  <FollowButton whale={w.address} compact />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {whales && whales.length > 10 && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-2 w-full h-10 rounded-xl border border-line text-[0.875rem] font-semibold text-ink-2 hover:border-ink-3 hover:text-ink">
          {all ? "Show the top 10" : `Show the top ${Math.min(50, whales.length)}`}
        </button>
      )}
      <p className="mt-3 text-[0.75rem] text-ink-3">Tap the bell to get a phone alert when a trader opens or closes a position.</p>
    </section>
  );
}

/** A little mark made from the address (each trader looks different at a glance). */
export function Avatar({ address, size = 32 }: { address: string; size?: number }) {
  let h = 2166136261;
  for (const ch of address.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const hue = h % 360;
  const hue2 = (hue + 40 + ((h >> 8) % 80)) % 360;
  return (
    <span
      className="shrink-0 rounded-full"
      style={{ width: size, height: size, background: `conic-gradient(from ${h % 360}deg, hsl(${hue} 75% 55%), hsl(${hue2} 80% 45%), hsl(${hue} 75% 55%))` }}
      aria-hidden="true"
    />
  );
}

// ------------------------------------------------------------------ funding

type FundTab = "longs" | "shorts" | "compare";

function Funding({ markets }: { markets: PerpMarket[] | null }) {
  const [tab, setTab] = useState<FundTab>("longs");
  const [venues, setVenues] = useState<FundingRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchFundingVenues()
        .then((v) => alive && setVenues(v))
        .catch(() => alive && setVenues((x) => x ?? []));
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  // Hyperliquid's own funding from the live markets (busiest 80, so tiny markets don't crowd the list)
  const hl = useMemo(
    () =>
      (markets ?? [])
        .slice(0, 80)
        .map((m) => ({ coin: m.coin, year: m.funding * 24 * 365 * 100 }))
        .filter((r) => Number.isFinite(r.year)),
    [markets]
  );
  const rows = tab === "longs" ? [...hl].sort((a, b) => b.year - a.year).slice(0, 12) : [...hl].sort((a, b) => a.year - b.year).slice(0, 12);
  const maxAbs = Math.max(10, ...rows.map((r) => Math.abs(r.year)));
  const busy = new Set((markets ?? []).slice(0, 80).map((m) => m.coin));
  const compare = (venues ?? [])
    .filter((v) => busy.has(v.coin) && v.hl !== null && (v.binance !== null || v.bybit !== null))
    .map((v) => {
      const others = [v.binance, v.bybit].filter((x): x is number => x !== null);
      const gap = Math.max(...others.map((o) => Math.abs((v.hl as number) - o)));
      return { ...v, gap };
    })
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 12);

  return (
    <section className="rounded-3xl border border-line bg-surface p-5 sm:p-6 min-w-0" aria-labelledby="fund-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="fund-title" className="font-display font-bold text-[1.125rem]">
            Funding
          </h2>
          <p className="text-[0.8125rem] text-ink-3">What one side pays the other to keep a position open, as a year&apos;s worth.</p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Funding view">
          {(
            [
              ["longs", "Longs pay most"],
              ["shorts", "Shorts pay most"],
              ["compare", "vs Binance, Bybit"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={tab === k}
              onClick={() => setTab(k)}
              className={"h-8 px-3 rounded-lg text-[0.8125rem] font-semibold whitespace-nowrap " + (tab === k ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab !== "compare" ? (
        !markets ? (
          <div className="mt-4 h-72 shimmer rounded-xl" />
        ) : (
          <ul className="mt-4 flex flex-col gap-1.5">
            {rows.map((r) => {
              const w = (Math.abs(r.year) / maxAbs) * 50;
              return (
                <li key={r.coin}>
                  <Link href={`/futures/?c=${encodeURIComponent(r.coin)}`} className="grid grid-cols-[5rem_minmax(0,1fr)_5rem] items-center gap-3 rounded-lg px-1 py-1 hover:bg-paper">
                    <b className="font-semibold text-[0.875rem] truncate">{r.coin}</b>
                    {/* centred at zero: right = longs pay, left = shorts pay */}
                    <span className="relative h-3" aria-hidden="true">
                      <span className="absolute inset-y-0 left-1/2 w-px bg-line" />
                      <span className={"absolute inset-y-0 rounded-sm " + (r.year >= 0 ? "bg-up/70" : "bg-danger/70")} style={r.year >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />
                    </span>
                    <span className={"text-right font-mono text-[0.8125rem] tabular-nums " + tone(r.year)}>{pct(r.year, 1)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )
      ) : venues === null ? (
        <div className="mt-4 h-72 shimmer rounded-xl" />
      ) : compare.length === 0 ? (
        <p className="mt-6 py-10 text-center text-[0.875rem] text-ink-3">Other exchanges&apos; funding isn&apos;t available right now.</p>
      ) : (
        <table className="mt-3 w-full text-[0.8125rem]">
          <thead>
            <tr className="text-[0.75rem] text-ink-3">
              <th className="font-normal text-left py-1">Coin</th>
              <th className="font-normal text-right">Hyperliquid</th>
              <th className="font-normal text-right">Binance</th>
              <th className="font-normal text-right">Bybit</th>
              <th className="font-normal text-right">Gap</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {compare.map((r) => (
              <tr key={r.coin} className="border-t border-line">
                <td className="py-2 font-sans font-semibold">{r.coin}</td>
                <td className={"text-right " + tone(r.hl)}>{pct(r.hl, 1)}</td>
                <td className={"text-right " + tone(r.binance)}>{pct(r.binance, 1)}</td>
                <td className={"text-right " + tone(r.bybit)}>{pct(r.bybit, 1)}</td>
                <td className="text-right font-sans font-bold">{r.gap.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-[0.75rem] text-ink-3">Green: longs pay shorts. Red: shorts pay longs. A big gap between exchanges can be traded both ways.</p>
    </section>
  );
}

// ------------------------------------------------------------------ movers

type MoveTab = "up" | "down" | "oi" | "vol";

function Movers({ markets }: { markets: PerpMarket[] | null }) {
  const [tab, setTab] = useState<MoveTab>("up");
  const live = (markets ?? []).filter((m) => m.volume24h > 250_000);
  const ch = (m: PerpMarket) => m.change24h ?? 0;
  const list =
    tab === "up"
      ? [...live].sort((a, b) => ch(b) - ch(a))
      : tab === "down"
        ? [...live].sort((a, b) => ch(a) - ch(b))
        : tab === "oi"
          ? [...live].sort((a, b) => b.openInterestUsd - a.openInterestUsd)
          : [...live].sort((a, b) => b.volume24h - a.volume24h);
  return (
    <section className="rounded-3xl border border-line bg-surface p-5 sm:p-6 min-w-0" aria-labelledby="move-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="move-title" className="font-display font-bold text-[1.125rem]">
          Movers
        </h2>
        <div className="flex gap-1" role="group" aria-label="Sort by">
          {(
            [
              ["up", "Up most"],
              ["down", "Down most"],
              ["oi", "Most open"],
              ["vol", "Most traded"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={tab === k}
              onClick={() => setTab(k)}
              className={"h-8 px-2.5 rounded-lg text-[0.8125rem] font-semibold whitespace-nowrap " + (tab === k ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {!markets ? (
        <div className="mt-4 h-72 shimmer rounded-xl" />
      ) : (
        <ol className="mt-3 flex flex-col">
          {list.slice(0, 10).map((m, i) => (
            <li key={m.coin} className={i ? "border-t border-line" : ""}>
              <Link href={`/futures/?c=${encodeURIComponent(m.coin)}`} className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto_auto] items-center gap-3 py-2.5 px-1 rounded-lg hover:bg-paper">
                <span className="text-[0.75rem] text-ink-3 tabular-nums">{i + 1}</span>
                <b className="font-semibold truncate">{m.coin}</b>
                <span className="font-mono text-[0.8125rem] text-ink-2 tabular-nums">
                  {tab === "oi" ? compactUsd(m.openInterestUsd) : tab === "vol" ? compactUsd(m.volume24h) : `$${px(m.mark)}`}
                </span>
                <span className={"w-16 text-right font-mono text-[0.8125rem] font-semibold tabular-nums " + tone(m.change24h)}>{pct(m.change24h, 1)}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
