"use client";

/**
 * sasa Bot, public: live from the indexer (indexer/sniper.mjs → bot_public, edge/bot-api.js /api/bot/live).
 *   - Meme whales: wallets that keep getting in early on coins that run 3×+, buying right now
 *   - Futures whales: the top traders' big moves (whale_moves)
 *   - Safety scanner: every new coin's checks (creator, bundles, copies, buyers) and the verdict
 *   - Trend Radar: themes new coins launch on, last hour vs the hours before
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { timeAgo } from "@/components/coins";
import { compactUsd } from "@/lib/format";
import { extHref } from "@/lib/extcoins";

type Check = { label: string; pass: boolean };
type Scan = {
  mint: string;
  name: string | null;
  symbol: string | null;
  at: string;
  mc: number | null;
  sec: number | null;
  checks: Check[];
  safety: number;
  verdict: "clean" | "careful" | "trap";
  why: string | null;
};
type Buy = {
  id: number;
  at: string;
  wallet: string;
  mint: string;
  name: string | null;
  symbol: string | null;
  sol: number;
  usd: number;
  mc: number;
  coins: number;
  runners: number;
  now_mc: number | null;
};
type Move = { id: number; address: string; coin: string; kind: string; side: "long" | "short"; usd: number; px: number; lev: number; t: string; rank: number | null; name: string | null };
type Theme = { theme: string; n1: number; prev: number; hot1: number; x2: number; tracked: number; score: number; best: { name: string; symbol: string; mint: string; x: number }[] | null };
type Live = { scanned: number; traps: number; smart: number; scans: Scan[]; buys: Buy[]; trends: Theme[]; futures: Move[]; at: string };

const short = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x)}%`;

/** Polls the live feed every few seconds while the page is visible. */
function useLive() {
  const [data, setData] = useState<Live | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/api/bot/live", { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as Live;
        if (alive) {
          setData(j);
          setErr(false);
        }
      } catch {
        if (alive) setErr(true);
      }
    };
    void load();
    const t = setInterval(load, 5000);
    const vis = () => void load();
    document.addEventListener("visibilitychange", vis);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);
  return { data, err };
}

/** A number that counts up to its new value. */
function Counter({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (start === value) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 900);
      const v = Math.round(start + (value - start) * (1 - Math.pow(1 - k, 3)));
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{shown.toLocaleString("en-US")}</>;
}

/** Ids seen before: a new one gets a short glow when it slides in. */
function useFresh<T>(rows: T[], id: (r: T) => string | number) {
  const seen = useRef<Set<string | number> | null>(null);
  const fresh = new Set<string | number>();
  if (seen.current) for (const r of rows) if (!seen.current.has(id(r))) fresh.add(id(r));
  useEffect(() => {
    seen.current = new Set(rows.map(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
  return fresh;
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={"relative rounded-2xl border border-line bg-surface overflow-hidden flex flex-col " + className}>{children}</section>;
}
function CardHead({ icon, title, note }: { icon: string; title: string; note?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 sm:px-5 pt-4 pb-3">
      <h2 className="flex items-center gap-2 font-display font-bold text-[1.0625rem] sm:text-[1.1875rem]">
        <span aria-hidden="true">{icon}</span>
        {title}
      </h2>
      {note && <span className="text-[0.75rem] text-ink-3 font-medium text-right">{note}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ whales

function MemeWhales({ buys }: { buys: Buy[] }) {
  const fresh = useFresh(buys, (b) => b.id);
  if (!buys.length)
    return (
      <Empty
        icon="🐋"
        title="Watching for the first move"
        text="Big buys into brand-new coins, and wallets that keep getting in early on coins that later run 3× or more. They land here the second they happen."
      />
    );
  return (
    <ul className="flex flex-col gap-1.5 px-2.5 sm:px-3 pb-3 min-w-0">
      {buys.slice(0, 12).map((b) => {
        const since = b.now_mc && b.mc ? (b.now_mc / b.mc - 1) * 100 : null;
        return (
          <li key={b.id} className={"bot-row min-w-0 flex items-center gap-2.5 sm:gap-3 rounded-xl px-2.5 py-2.5 " + (fresh.has(b.id) ? "bot-fresh" : "bg-night/60")}>
            <span className="w-10 h-10 rounded-xl bg-emerald-soft grid place-items-center text-[1.25rem] shrink-0" aria-hidden="true">
              🐋
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[0.875rem] font-semibold min-w-0">
                <span className="font-mono truncate">{short(b.wallet)}</span>
                {b.coins > 0 ? (
                  <span className="shrink-0 text-[0.625rem] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-up/15 text-up" title={`${b.runners} of the ${b.coins} new coins this wallet bought early ran 3× or more`}>
                    {b.runners}/{b.coins} ran 3×
                  </span>
                ) : (
                  <span className="shrink-0 text-[0.625rem] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-emerald-soft text-emerald" title="One big buy into a brand-new coin">
                    WHALE BUY
                  </span>
                )}
              </span>
              <span className="block text-[0.8125rem] text-ink-3 truncate">
                bought <b className="text-ink">{compactUsd(b.usd)}</b> of <b className="text-ink">${b.symbol || short(b.mint)}</b> at {compactUsd(b.mc)} · {timeAgo(b.at)}
              </span>
            </span>
            {since !== null && (
              <span className="text-right shrink-0 hidden min-[380px]:block">
                <span className={"block font-display font-bold text-[0.9375rem] " + (since >= 0 ? "text-up" : "text-danger")}>{pct(since)}</span>
                <span className="block text-[0.6875rem] text-ink-3">since</span>
              </span>
            )}
            <Link href={extHref({ network: "solana", address: b.mint })} className="shrink-0 h-9 px-3.5 rounded-lg bg-emerald text-on-accent font-bold text-[0.8125rem] grid place-items-center hover:bg-emerald-dark">
              Buy
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

const MOVE: Record<string, string> = { open: "opened", add: "added to", cut: "cut", flip: "flipped to", close: "closed" };

function FuturesWhales({ moves }: { moves: Move[] }) {
  const fresh = useFresh(moves, (m) => m.id);
  if (!moves.length) return <Empty icon="🐋" title="Quiet right now" text="The top 100 futures traders' big moves (opens, adds, flips, closes) show up here as they happen." />;
  return (
    <ul className="flex flex-col gap-1.5 px-2.5 sm:px-3 pb-3 min-w-0">
      {moves.slice(0, 12).map((m) => (
        <li key={m.id} className={"bot-row min-w-0 " + (fresh.has(m.id) ? "bot-fresh rounded-xl" : "rounded-xl bg-night/60")}>
          <Link href={`/data/whale/?a=${m.address}`} className="flex items-center gap-3 px-2.5 py-2.5">
            <span className={"w-10 h-10 rounded-xl grid place-items-center font-display font-bold text-[0.75rem] shrink-0 " + (m.side === "long" ? "bg-up/15 text-up" : "bg-danger/15 text-danger")}>
              {m.side === "long" ? "LONG" : "SHORT"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[0.875rem] font-semibold min-w-0">
                <span className="truncate">{m.name || <span className="font-mono">{short(m.address)}</span>}</span>
                {m.rank ? <span className="shrink-0 text-[0.625rem] font-bold px-1.5 py-0.5 rounded-md bg-emerald-soft text-emerald">TOP {m.rank}</span> : null}
              </span>
              <span className="block text-[0.8125rem] text-ink-3 truncate">
                {MOVE[m.kind] ?? m.kind} {m.kind === "flip" ? m.side : ""} <b className="text-ink">{m.coin}</b> · {Math.round(Number(m.lev) || 1)}× · {timeAgo(m.t)}
              </span>
            </span>
            <span className="font-display font-bold text-[0.9375rem] shrink-0">{compactUsd(Number(m.usd))}</span>
          </Link>
        </li>
      ))}
      <li className="px-2 pt-1">
        <Link href="/data/" className="text-[0.8125rem] font-semibold text-emerald hover:underline">
          All top traders, follow and copy →
        </Link>
      </li>
    </ul>
  );
}

function Empty({ icon, title, text }: { icon: string; title: string; text: string }) {
  return (
    <div className="flex-1 grid place-items-center text-center px-6 py-10">
      <div>
        <div className="text-[2rem] bot-float" aria-hidden="true">
          {icon}
        </div>
        <div className="mt-2 font-display font-bold">{title}</div>
        <p className="mt-1 text-[0.8125rem] text-ink-3 max-w-xs mx-auto">{text}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ safety scanner

const RING = 2 * Math.PI * 46;

/** Replays the latest real scans one by one: the checks light up in turn, then the verdict. */
function Scanner({ scans }: { scans: Scan[] }) {
  const [i, setI] = useState(0);
  const [step, setStep] = useState(0);
  const list = scans.slice(0, 12);
  const s = list.length ? list[i % list.length] : null;
  const n = s?.checks.length ?? 0;
  useEffect(() => {
    if (!s) return;
    setStep(0);
    const ts: ReturnType<typeof setTimeout>[] = [];
    for (let k = 1; k <= n + 1; k++) ts.push(setTimeout(() => setStep(k), 230 * k));
    ts.push(setTimeout(() => setI((x) => x + 1), 230 * (n + 1) + 2200));
    return () => ts.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, list.length]);
  if (!s) return <Empty icon="🛡️" title="Scanner warming up" text="Every new coin gets checked here: the creator, bundled buys, copied links, real buyers." />;
  const shown = s.checks.slice(0, Math.min(step, n));
  const ok = shown.filter((c) => c.pass).length;
  const score = n ? Math.round((ok / n) * 100) : 0;
  const done = step > n;
  const color = score >= 80 ? "var(--color-up)" : score >= 55 ? "var(--color-mint)" : "var(--color-danger)";
  const v = s.verdict;
  return (
    <div className="flex-1 flex flex-col px-4 sm:px-5 pb-4">
      <div className="flex items-center gap-3.5">
        <span className="bot-scanimg relative w-14 h-14 rounded-2xl bg-night grid place-items-center font-display font-bold text-[1.125rem] text-emerald shrink-0 overflow-hidden">
          {(s.symbol || "?").slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-display font-bold text-[1.25rem] truncate">{s.name || s.symbol}</span>
          <span className="block text-[0.8125rem] text-ink-3 truncate">
            ${s.symbol} · {timeAgo(s.at)} · {compactUsd(s.mc)}
          </span>
        </span>
        <span className="relative w-[104px] h-[104px] shrink-0">
          <svg width="104" height="104" viewBox="0 0 104 104" className="-rotate-90">
            <circle cx="52" cy="52" r="46" fill="none" stroke="var(--color-line)" strokeWidth="9" />
            <circle
              cx="52"
              cy="52"
              r="46"
              fill="none"
              stroke={color}
              strokeWidth="9"
              strokeLinecap="round"
              strokeDasharray={RING}
              strokeDashoffset={RING - (RING * score) / 100}
              style={{ transition: "stroke-dashoffset .25s, stroke .25s" }}
            />
          </svg>
          <span className="absolute inset-0 grid place-items-center text-center">
            <span>
              <span className="block font-display font-extrabold text-[1.875rem] leading-none">{score}</span>
              <span className="block text-[0.5625rem] font-bold tracking-[0.12em] text-ink-3 mt-1">SAFETY</span>
            </span>
          </span>
        </span>
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-1.5">
        {s.checks.map((c, k) => {
          const on = k < step;
          return (
            <li
              key={c.label}
              className={
                "flex items-center gap-2 rounded-xl px-2.5 py-2 text-[0.75rem] sm:text-[0.8125rem] font-medium transition-all duration-200 " +
                (!on ? "opacity-25 bg-night/60" : c.pass ? "bg-night/60" : "bg-danger/10")
              }
            >
              <span
                className={
                  "w-5 h-5 rounded-md grid place-items-center text-[0.6875rem] font-black shrink-0 " +
                  (!on ? "bg-line text-ink-3" : c.pass ? "bg-up/15 text-up" : "bg-danger/20 text-danger")
                }
              >
                {!on ? "·" : c.pass ? "✓" : "!"}
              </span>
              <span className="leading-tight">{c.label}</span>
            </li>
          );
        })}
      </ul>
      <div
        className={
          "pt-4 transition-all duration-300 " + (done ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2")
        }
      >
        <div
          className={
            "rounded-xl px-3.5 py-3 flex items-center justify-between gap-3 border " +
            (v === "clean" ? "bg-up/10 border-up/30 text-up" : v === "careful" ? "bg-warn-bg border-mint/30 text-warn-ink" : "bg-danger/10 border-danger/30 text-danger")
          }
        >
          <span className="min-w-0">
            <span className="block font-display font-bold text-[1rem]">{v === "clean" ? "✅ Looks clean" : v === "careful" ? "⚠️ Be careful" : "⛔ Trap caught"}</span>
            {s.why && v !== "clean" && <span className="block text-[0.75rem] opacity-90 truncate">{s.why}</span>}
          </span>
          {v !== "trap" ? (
            <Link href={extHref({ network: "solana", address: s.mint })} className="shrink-0 h-9 px-3.5 rounded-lg bg-emerald text-on-accent font-bold text-[0.8125rem] grid place-items-center">
              {v === "clean" ? `Buy $${(s.symbol || "").slice(0, 8)}` : "See it"}
            </Link>
          ) : (
            <span className="shrink-0 text-[0.75rem] font-semibold opacity-80">Kept off your feed</span>
          )}
        </div>
      </div>
      <div className="mt-3 flex gap-1.5 overflow-hidden">
        {list.slice(0, 8).map((x) => (
          <span
            key={x.mint}
            className={
              "shrink-0 text-[0.6875rem] font-bold px-2 py-1 rounded-md " +
              (x.verdict === "clean" ? "bg-up/12 text-up" : x.verdict === "careful" ? "bg-warn-bg text-warn-ink" : "bg-danger/12 text-danger")
            }
          >
            {x.verdict === "clean" ? "✓" : x.verdict === "careful" ? "!" : "✕"} ${(x.symbol || "").slice(0, 8)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ trend radar

const EMOJI: Record<string, string> = { "AI agents": "🤖", Cats: "🐱", Dogs: "🐶", Frogs: "🐸", Trump: "🇺🇸", Elon: "🚀", "CZ / Binance": "🟡", Penguins: "🐧", Apes: "🦍" };

function Trends({ trends }: { trends: Theme[] }) {
  const list = trends.slice(0, 7);
  const [pick, setPick] = useState<string | null>(null);
  const top = list.find((t) => t.theme === pick) ?? list[0];
  const max = Math.max(1, ...list.map((t) => t.score));
  if (!list.length) return <Empty icon="📡" title="Listening" text="Trend Radar groups every new coin by its theme and shows which themes are taking off in the last hour." />;
  return (
    <div className="flex-1 flex flex-col px-2.5 sm:px-3 pb-3">
      <ul className="relative grid gap-1.5">
        {list.map((t, r) => {
          const growth = t.prev > 0 ? ((t.n1 - t.prev) / t.prev) * 100 : null;
          const sel = t.theme === top?.theme;
          return (
            <li key={t.theme}>
              <button
                type="button"
                onClick={() => setPick(t.theme)}
                className={"bot-row w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors " + (sel ? "bg-emerald-soft ring-1 ring-emerald/40" : "bg-night/60 hover:bg-night")}
              >
                <span className="w-5 font-display font-bold text-ink-3 text-[0.875rem]">{r + 1}</span>
                <span className="text-[1.25rem]" aria-hidden="true">
                  {EMOJI[t.theme] ?? "🔥"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-[0.875rem] truncate capitalize">{t.theme}</span>
                  <span className="block h-1.5 mt-1 rounded-full bg-line overflow-hidden">
                    <span className="block h-full rounded-full bg-emerald transition-all duration-700" style={{ width: `${(t.score / max) * 100}%` }} />
                  </span>
                </span>
                <span className="text-right shrink-0 w-16">
                  <span className={"block font-display font-bold text-[0.875rem] " + (growth === null || growth >= 0 ? "text-up" : "text-danger")}>{growth === null ? "NEW" : pct(growth)}</span>
                  <span className="block text-[0.6875rem] text-ink-3">{t.n1} coins/h</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {top && (
        <Link
          href={`/race/launch/?theme=${encodeURIComponent(top.theme)}`}
          className="mt-3 h-12 rounded-xl bg-emerald text-on-accent font-bold text-[0.9375rem] grid place-items-center shadow-[0_10px_30px_-10px_var(--color-emerald)] hover:bg-emerald-dark"
        >
          🚀 Launch a coin on “{top.theme.charAt(0).toUpperCase() + top.theme.slice(1)}”
        </Link>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ page

export default function BotPage() {
  const { data, err } = useLive();
  const [tab, setTab] = useState<"meme" | "futures">("meme");
  const tape = useMemo(() => (data?.scans ?? []).slice(0, 16), [data]);
  return (
    <main className="relative mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8 pt-5 sm:pt-7 pb-20">
      <style>{CSS}</style>
      <div className="bot-glow" aria-hidden="true" />
      <header className="relative flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4 sm:gap-5">
        <div>
          <h1 className="flex items-center gap-3 font-display font-extrabold text-[2rem] sm:text-[2.75rem] leading-none">
            sasa Bot
            <span className="inline-flex items-center gap-2 text-[0.75rem] font-bold tracking-[0.12em] text-up bg-up/10 border border-up/30 rounded-full px-2.5 py-1">
              <span className="bot-dot" aria-hidden="true" />
              {err && !data ? "CONNECTING" : "LIVE"}
            </span>
          </h1>
          <p className="mt-2.5 text-ink-3 text-[0.9375rem] sm:text-[1rem] max-w-2xl">Watching every new coin, every second. It catches the traps, follows the WHALES and finds what&apos;s trending.</p>
          <Link href="/scan/" className="mt-3 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl border border-line bg-surface font-semibold text-[0.8125rem] hover:border-emerald/50">
            🛡️ Check any coin: is it safe? →
          </Link>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <Tile label="Coins scanned today" value={data?.scanned ?? 0} />
          <Tile label="Traps caught" value={data?.traps ?? 0} tone="text-danger" />
          <Tile label="Wallets followed" value={data?.smart ?? 0} tone="text-emerald" />
        </div>
      </header>

      <div className="relative mt-5 sm:mt-6 grid gap-4 lg:grid-cols-2 xl:grid-cols-12">
        <Card className="xl:col-span-5 lg:min-h-[600px] min-w-0">
          <div className="flex items-center justify-between gap-2 px-4 sm:px-5 pt-4 pb-3">
            <div className="flex p-1 rounded-xl bg-night gap-1" role="tablist">
              {(
                [
                  ["meme", "🐸 Meme whales"],
                  ["futures", "🐋 Futures whales"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  onClick={() => setTab(k)}
                  className={"h-9 px-3 sm:px-3.5 rounded-lg whitespace-nowrap text-[0.8125rem] sm:text-[0.875rem] font-bold transition-colors " + (tab === k ? "bg-emerald text-on-accent shadow-sm" : "text-ink-3 hover:text-ink")}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="text-[0.75rem] text-ink-3 font-medium text-right hidden sm:block lg:hidden xl:block">{tab === "meme" ? "big buys + early wallets" : "top 100 traders, $25K+ moves"}</span>
          </div>
          {!data ? <Rows /> : tab === "meme" ? <MemeWhales buys={data.buys} /> : <FuturesWhales moves={data.futures} />}
        </Card>

        <Card className="xl:col-span-4 lg:min-h-[600px] min-w-0">
          <CardHead icon="🛡️" title="Safety scanner" note={data?.scans.length ? "latest new coins, replayed" : undefined} />
          {!data ? <Rows /> : <Scanner scans={data.scans} />}
        </Card>

        <Card className="lg:col-span-2 xl:col-span-3 xl:min-h-[600px] min-w-0">
          <CardHead icon="📡" title="Trend Radar" note="last hour vs before" />
          {!data ? <Rows /> : <Trends trends={data.trends} />}
        </Card>
      </div>

      {tape.length > 0 && (
        <div className="relative mt-4 rounded-2xl border border-line bg-surface overflow-hidden flex items-center h-11">
          <span className="relative z-10 shrink-0 h-full flex items-center gap-2 pl-4 pr-4 text-[0.6875rem] font-extrabold tracking-[0.12em] text-emerald bg-surface shadow-[12px_0_16px_var(--color-surface)]">
            <span className="bot-dot" style={{ background: "var(--color-emerald)" }} aria-hidden="true" />
            JUST SCANNED
          </span>
          <div className="bot-tape flex gap-7 whitespace-nowrap text-[0.8125rem] font-medium text-ink-3">
            {[...tape, ...tape].map((x, k) => (
              <span key={k}>
                <b className="text-ink">${(x.symbol || "").slice(0, 10)}</b>{" "}
                <span className={x.verdict === "clean" ? "text-up" : x.verdict === "careful" ? "text-mint" : "text-danger"}>
                  {x.verdict === "clean" ? "✓ clean" : x.verdict === "careful" ? "! careful" : "✕ trap"}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      <p className="relative mt-4 text-[0.75rem] text-ink-3 max-w-3xl">
        Information, not advice. A wallet that won before can lose next time, and a clean scan doesn&apos;t mean a coin will go up. Meme coins can lose all their value.
      </p>
    </main>
  );
}

function Tile({ label, value, tone = "" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface px-3 sm:px-4 py-2.5 sm:py-3 min-w-0 xl:min-w-[170px]">
      <div className="text-[0.625rem] sm:text-[0.6875rem] font-bold tracking-[0.06em] uppercase text-ink-3 leading-tight min-h-[2em] sm:min-h-0">{label}</div>
      <div className={"mt-0.5 font-display font-extrabold text-[1.25rem] sm:text-[1.625rem] tabular-nums " + tone}>
        <Counter value={value} />
      </div>
    </div>
  );
}

function Rows() {
  return (
    <div className="grid gap-1.5 px-3 pb-3">
      {Array.from({ length: 6 }, (_, k) => (
        <div key={k} className="h-14 rounded-xl bg-night/60 animate-pulse" />
      ))}
    </div>
  );
}

const CSS = `
.bot-glow{position:absolute;left:50%;top:-140px;width:1100px;height:520px;transform:translateX(-50%);pointer-events:none;
  background:radial-gradient(closest-side,color-mix(in srgb,var(--color-emerald) 22%,transparent),transparent);opacity:.8}
.bot-dot{width:8px;height:8px;border-radius:50%;background:var(--color-up);animation:botPulse 1.4s infinite}
@keyframes botPulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,currentColor 60%,transparent)}70%{box-shadow:0 0 0 9px transparent}100%{box-shadow:0 0 0 0 transparent}}
.bot-row{animation:botIn .5s cubic-bezier(.2,.9,.3,1.2)}
@keyframes botIn{from{transform:translateY(-14px) scale(.98);opacity:0}to{transform:none;opacity:1}}
.bot-fresh{background:color-mix(in srgb,var(--color-emerald) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--color-emerald) 50%,transparent),0 0 24px -6px var(--color-emerald)}
.bot-scanimg:after{content:"";position:absolute;left:0;right:0;height:35%;top:0;background:linear-gradient(180deg,transparent,color-mix(in srgb,var(--color-emerald) 55%,transparent),transparent);animation:botSweep 1.2s linear infinite}
@keyframes botSweep{from{transform:translateY(-100%)}to{transform:translateY(300%)}}
.bot-tape{animation:botTape 45s linear infinite}
@keyframes botTape{from{transform:translateX(0)}to{transform:translateX(-50%)}}
.bot-float{animation:botFloat 2.4s ease-in-out infinite}
@keyframes botFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@media (prefers-reduced-motion:reduce){.bot-row,.bot-tape,.bot-float,.bot-scanimg:after,.bot-dot{animation:none}}
`;
