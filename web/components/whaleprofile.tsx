"use client";

/**
 * One trader's page: who they are on the top list, what they hold right now on Hyperliquid
 * (live), how much long versus short, and their latest trades. Follow for phone alerts.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { MarketSwitch } from "./marketswitch";
import { FollowButton } from "./whalefollow";
import { Avatar } from "./datapage";
import { compactUsd } from "@/lib/format";
import { fetchPerpAccount, fetchPerpFills, type PerpAccount, type PerpFill } from "@/lib/perps";
import { fetchWhale, fetchWhaleMoves, isAddress, moveVerb, whaleName, type Whale, type WhaleMove } from "@/lib/hldata";

const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`);
const tone = (v: number | null | undefined) => (!v ? "text-ink-3" : v > 0 ? "text-up" : "text-danger");
const signedUsd = (v: number) => `${v >= 0 ? "+" : "−"}${compactUsd(Math.abs(v))}`;
function px(v: number | null) {
  if (!v || !Number.isFinite(v)) return "—";
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return Number(v.toPrecision(5)).toLocaleString("en-US", { maximumSignificantDigits: 5 });
}

export function WhaleProfile({ address }: { address: string }) {
  const a = address.toLowerCase();
  const ok = isAddress(a);
  const [whale, setWhale] = useState<Whale | null | undefined>(undefined);
  const [acct, setAcct] = useState<PerpAccount | null>(null);
  const [fills, setFills] = useState<PerpFill[] | null>(null);
  const [moves, setMoves] = useState<WhaleMove[] | null>(null);
  const [err, setErr] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!ok) return;
    let alive = true;
    void fetchWhale(a)
      .then((w) => alive && setWhale(w))
      .catch(() => alive && setWhale(null));
    void fetchWhaleMoves({ address: a, limit: 30 })
      .then((m) => alive && setMoves(m))
      .catch(() => alive && setMoves([]));
    const load = () =>
      Promise.all([fetchPerpAccount(a), fetchPerpFills(a)])
        .then(([x, f]) => {
          if (!alive) return;
          setAcct(x);
          setFills(f);
          setErr(false);
        })
        .catch(() => alive && setErr(true));
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [a, ok]);

  if (!ok)
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-bold text-[1.5rem]">That isn&apos;t a trader&apos;s address</h1>
        <Link href="/data/" className="mt-4 inline-block font-semibold text-emerald">
          Back to market data
        </Link>
      </div>
    );

  const pos = acct?.positions ?? [];
  const longUsd = pos.filter((p) => p.side === "long").reduce((s, p) => s + Math.abs(p.value), 0);
  const shortUsd = pos.filter((p) => p.side === "short").reduce((s, p) => s + Math.abs(p.value), 0);
  const exposure = longUsd + shortUsd;
  const name = whaleName(whale ?? null, a);
  const stats: { k: string; v: string; cls?: string }[] = [
    { k: "Account", v: acct ? compactUsd(acct.accountValue) : whale ? compactUsd(whale.accountValue) : "—" },
    { k: "Profit today", v: whale ? signedUsd(whale.pnlDay) : "—", cls: tone(whale?.pnlDay) },
    { k: "7 days", v: whale ? signedUsd(whale.pnlWeek) : "—", cls: tone(whale?.pnlWeek) },
    { k: "30 days", v: whale ? signedUsd(whale.pnlMonth) : "—", cls: tone(whale?.pnlMonth) },
    { k: "All time", v: whale ? signedUsd(whale.pnlAll) : "—", cls: tone(whale?.pnlAll) },
    { k: "Traded, 30 days", v: whale ? compactUsd(whale.volMonth) : "—" },
  ];

  return (
    <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-5 sm:py-8 pb-28 md:pb-12">
      <MarketSwitch at="data" />
      <div className="mt-4">
        <Link href="/data/" className="text-[0.875rem] text-ink-3 hover:text-ink">
          ‹ Market data
        </Link>
      </div>

      <header className="mt-2 flex flex-wrap items-center gap-4">
        <Avatar address={a} size={56} />
        <div className="min-w-0 flex-1">
          <h1 className="font-display font-bold text-[1.625rem] sm:text-[2rem] leading-tight truncate">{name}</h1>
          <div className="flex items-center gap-2 text-[0.8125rem] text-ink-3">
            <span className="font-mono">
              {a.slice(0, 8)}…{a.slice(-6)}
            </span>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard?.writeText(a).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
              className="font-semibold text-emerald"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            {whale && <span>· #{whale.rank} on the 30-day list</span>}
          </div>
        </div>
        <FollowButton whale={a} />
      </header>

      <dl className="mt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {stats.map((s) => (
          <div key={s.k} className="rounded-2xl border border-line bg-surface px-4 py-3">
            <dt className="text-[0.75rem] text-ink-3">{s.k}</dt>
            <dd className={"m-0 font-display font-bold text-[1.25rem] tabular-nums " + (s.cls ?? "")}>{s.v}</dd>
          </div>
        ))}
      </dl>

      <section className="mt-5 rounded-3xl border border-line bg-surface p-5 sm:p-6" aria-labelledby="pos-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="pos-title" className="font-display font-bold text-[1.125rem]">
            Holding now
          </h2>
          <span className="text-[0.75rem] text-ink-3">Live from Hyperliquid, every 10 s</span>
        </div>
        {exposure > 0 && (
          <div className="mt-3" aria-label="Long versus short">
            <div className="flex justify-between text-[0.8125rem] mb-1">
              <span className="text-up font-semibold">Long {compactUsd(longUsd)}</span>
              <span className="text-danger font-semibold">{compactUsd(shortUsd)} Short</span>
            </div>
            <div className="h-2.5 rounded-full overflow-hidden flex bg-paper">
              <div className="h-full bg-up" style={{ width: `${(longUsd / exposure) * 100}%` }} />
              <div className="h-full bg-danger flex-1" />
            </div>
          </div>
        )}
        {!acct ? (
          err ? (
            <p className="mt-6 text-[0.875rem] text-ink-3">Hyperliquid can&apos;t be reached right now. Trying again…</p>
          ) : (
            <div className="mt-4 flex flex-col gap-2">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="h-14 shimmer rounded-xl" />
              ))}
            </div>
          )
        ) : pos.length === 0 ? (
          <p className="mt-6 py-6 text-center text-[0.875rem] text-ink-3">No open positions right now. Get alerts to hear when the next one opens.</p>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-line">
            {[...pos]
              .sort((x, y) => Math.abs(y.value) - Math.abs(x.value))
              .map((p) => (
                <li key={p.coin} className="py-3 grid grid-cols-2 sm:grid-cols-[minmax(0,1.3fr)_repeat(4,minmax(0,1fr))_auto] gap-x-4 gap-y-1.5 items-center text-[0.875rem]">
                  <div className="min-w-0">
                    <div className="font-semibold text-[1rem]">
                      {p.coin}{" "}
                      <span className={p.side === "long" ? "text-up" : "text-danger"}>
                        {p.side === "long" ? "Long" : "Short"} {p.lev}x
                      </span>
                    </div>
                    <div className="text-[0.75rem] text-ink-3">{compactUsd(Math.abs(p.value))} position</div>
                  </div>
                  <Cell k="Entry" v={px(p.entry)} />
                  <Cell k="Profit" v={`${signedUsd(p.pnl)} (${pct(p.roe, 0)})`} cls={tone(p.pnl)} />
                  <Cell k="Liquidation" v={px(p.liq)} cls="text-danger" />
                  <Cell k="Funding so far" v={signedUsd(p.funding)} cls={tone(p.funding)} />
                  <Link href={`/futures/?c=${encodeURIComponent(p.coin)}`} className="col-span-2 sm:col-span-1 h-9 px-3 rounded-xl border border-line font-semibold text-[0.8125rem] grid place-items-center hover:border-ink-3">
                    Trade {p.coin}
                  </Link>
                </li>
              ))}
          </ul>
        )}
      </section>

      {moves && moves.length > 0 && (
        <section className="mt-4 rounded-3xl border border-line bg-surface p-5 sm:p-6" aria-labelledby="moves-title">
          <h2 id="moves-title" className="font-display font-bold text-[1.125rem]">
            Moves this week
          </h2>
          <ul className="mt-2 flex flex-col divide-y divide-line">
            {moves.map((m) => (
              <li key={m.id} className="py-2.5 grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-[0.875rem]">
                <span className="min-w-0">
                  <span className="text-ink-2">{moveVerb(m)}</span> <b className="font-semibold">{m.coin}</b>{" "}
                  <span className={"font-semibold " + (m.side === "long" ? "text-up" : "text-danger")}>{m.side}</span>
                  <span className="block text-[0.75rem] text-ink-3">
                    {new Date(m.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    {m.px > 0 ? ` · at ${px(m.px)}` : ""}
                    {m.lev ? ` · ${m.lev}x` : ""}
                  </span>
                </span>
                <span className="font-display font-bold tabular-nums">{compactUsd(m.usd)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-4 rounded-3xl border border-line bg-surface p-5 sm:p-6" aria-labelledby="fills-title">
        <h2 id="fills-title" className="font-display font-bold text-[1.125rem]">
          Latest trades
        </h2>
        {fills === null ? (
          <div className="mt-4 h-40 shimmer rounded-xl" />
        ) : fills.length === 0 ? (
          <p className="mt-6 text-center text-[0.875rem] text-ink-3">No trades yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y divide-line">
            {fills.slice(0, 25).map((f) => (
              <li key={`${f.hash}:${f.tid}:${f.time}`} className="py-2.5 grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-[0.875rem]">
                <span className="min-w-0 truncate">
                  <b className="font-semibold">{f.coin}</b> <span className="text-ink-2">{f.dir}</span> <span className="text-ink-3">· {compactUsd(f.sz * f.px)} at {px(f.px)}</span>
                  <span className="block text-[0.75rem] text-ink-3">{new Date(f.time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                </span>
                <span className={"font-mono text-right " + tone(f.pnl)}>{f.pnl ? signedUsd(f.pnl) : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="mt-6 text-[0.75rem] text-ink-3">Public data from Hyperliquid. Following a trader isn&apos;t advice to copy them.</p>
    </div>
  );
}

function Cell({ k, v, cls = "" }: { k: string; v: string; cls?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[0.6875rem] text-ink-3">{k}</div>
      <div className={"font-mono truncate " + cls}>{v}</div>
    </div>
  );
}
