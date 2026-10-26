"use client";

/**
 * sasa Bot, test mode (admins only): what the auto-trade bot would have bought on pump.fun and
 * how it ended, from indexer/sniper.mjs. Nothing is bought; this is for tuning the filters.
 */
import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { authedGet } from "@/lib/alerts";
import { compactUsd, friendlyError } from "@/lib/format";

type Strat = { n: number; wins: number; avg: number };
type Level = {
  level: string;
  min: number;
  picked: number;
  wins: number;
  losses: number;
  open: number;
  hit_25k: number;
  avg_peak_x: number | null;
  strategies: Record<string, Strat> | null;
};
type OptResult = {
  rule: Record<string, number>;
  entry: string;
  exit: string;
  train: { n: number; wins: number; avg: number; perDay: number };
  val: { n: number; wins: number; avg: number; perDay: number };
};
type Opt = { run_at: string; result: { coins: number; train: number; val: number; tried: number; top: OptResult[] } };

/** A rule's filters in words (only the ones that actually filter). */
function ruleWords(r: Record<string, number>): string {
  const w: string[] = [];
  if (r.minScore > 0) w.push(`score ${r.minScore}+`);
  if (r.needX === 2) w.push("own X account");
  else if (r.needX === 1) w.push("an X link");
  if (r.minXFollowers > 0) w.push(`X ${r.minXFollowers}+ followers`);
  if (r.minTg === 1) w.push("a Telegram");
  else if (r.minTg > 1) w.push(`Telegram ${r.minTg}+ members`);
  if (r.needSite) w.push("live website");
  if (r.minDomainDays > 0) w.push(`domain ${r.minDomainDays}+ days old`);
  if (!r.allowReused) w.push("no reused links");
  if (!r.allowSamePost) w.push("no copied X post");
  if (r.maxDevPct < 100) w.push(`creator ≤${r.maxDevPct}%`);
  if (!r.allowDevSold) w.push("creator not selling");
  if (r.maxDevLaunches < 99) w.push(`creator ≤${r.maxDevLaunches} coins/day`);
  if (!r.allowRugger) w.push("no past dumps");
  if (r.maxBundle < 100) w.push(`bundles ≤${r.maxBundle}%`);
  if (r.maxTop10 < 100) w.push(`top 10 ≤${r.maxTop10}%`);
  if (r.minBuyers > 0) w.push(`${r.minBuyers}+ buyers`);
  if (r.minNetSol > 0) w.push(`${r.minNetSol}+ SOL in`);
  if (r.minRatio > 0) w.push(`buys ${r.minRatio}× sells`);
  w.push(`bought at ${r.minMult}–${r.maxMult >= 99 ? "any" : r.maxMult}× launch price`);
  if (r.minNewBuyers60 > 0) w.push(`${r.minNewBuyers60}+ new buyers in the minute before`);
  if (r.minNetSol60 > -99) w.push(`${r.minNetSol60}+ SOL in during the minute before`);
  if (r.minRatio60 > 0) w.push(`buys ${r.minRatio60}× sells in the minute before`);
  return w.join(" · ");
}

const STRAT_NAMES: [string, string][] = [
  ["50/20", "Sell +50% · stop −20%"],
  ["50/30", "Sell +50% · stop −30%"],
  ["100/30", "Sell +100% · stop −30%"],
  ["200/40", "Sell +200% · stop −40%"],
  ["trail", "Half at 2×, rest trails 30% · stop −30%"],
  ["50/30 @45s", "Buy at 45 s · +50% / −30%"],
  ["100/30 @45s", "Buy at 45 s · +100% / −30%"],
  ["50/30 @90s", "Buy at 90 s · +50% / −30%"],
];
type Stats = { coins: number; decided: number; with_links: number; levels: Level[] | null; fails: Record<string, number> | null };
type Coin = {
  mint: string;
  created_at: string;
  name: string;
  symbol: string;
  x: string | null;
  telegram: string | null;
  website: string | null;
  score: number;
  checks: Record<string, unknown>;
  entry_mc: number | null;
  peak_mc: number | null;
  low_mc: number | null;
  peak_sec: number | null;
  result: string | null;
  done: boolean;
};

const HOURS = [
  [24, "24h"],
  [72, "3 days"],
  [168, "7 days"],
] as const;
const LEVEL_NAMES: Record<string, string> = { safe: "Safe", balanced: "Balanced", aggressive: "Aggressive" };

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export default function BotTestPage() {
  const { address, signMessage } = useWallet();
  const [hours, setHours] = useState<number>(24);
  const [min, setMin] = useState<number>(65);
  const [data, setData] = useState<{ stats: Stats | null; coins: Coin[]; opt: Opt | null } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await authedGet<{ stats: Stats | null; coins: Coin[]; opt: Opt | null }>(signMessage, `bot/stats?hours=${hours}&min=${min}`));
      setError("");
    } catch (e) {
      setError(friendlyError(e));
    }
  }, [signMessage, hours, min]);

  useEffect(() => {
    if (!address) return;
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [address, load]);

  if (!address)
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-bold text-[1.625rem]">sasa Bot · test</h1>
        <p className="text-ink-2 mt-2">Sign in with an admin account.</p>
        <div className="mt-6">
          <ConnectButton full />
        </div>
      </div>
    );

  const s = data?.stats;
  return (
    <div className="max-w-4xl mx-auto px-4 py-6 pb-28">
      <h1 className="font-display font-bold text-[1.5rem]">sasa Bot · test mode</h1>
      <p className="text-ink-2 text-[0.875rem] mt-1">
        Watches every new pump.fun coin and writes down what the bot would have bought. Nothing is bought. A pick wins when it rises 50% before it falls 20%.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {HOURS.map(([h, label]) => (
          <button
            key={h}
            onClick={() => setHours(h)}
            className={"px-3 py-1.5 rounded-full border text-[0.8125rem] " + (hours === h ? "border-ink bg-ink text-paper" : "border-line")}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <p className="mt-4 text-danger text-[0.875rem]">{error}</p>}
      {!data && !error && <p className="mt-6 text-ink-3">Loading…</p>}
      {data && !s && <p className="mt-6 text-ink-2">No results yet. The indexer starts writing them a minute after it restarts.</p>}

      {s && (
        <>
          <p className="mt-4 text-[0.875rem] text-ink-2">
            {s.coins.toLocaleString()} new coins seen · {s.with_links.toLocaleString()} with links
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {(s.levels ?? []).map((l) => (
              <button
                key={l.level}
                onClick={() => setMin(l.min)}
                className={"text-left rounded-2xl border p-4 bg-surface " + (min === l.min ? "border-ink" : "border-line")}
              >
                <div className="text-[0.8125rem] text-ink-3">
                  {LEVEL_NAMES[l.level] ?? l.level} · score {l.min}+
                </div>
                <div className="font-display font-bold text-[1.75rem] mt-1">{pct(l.wins, l.wins + l.losses)}</div>
                <div className="text-[0.8125rem] text-ink-2">win rate</div>
                <div className="mt-2 text-[0.8125rem] text-ink-2 leading-relaxed">
                  {l.picked} picked · {l.wins} won · {l.losses} lost · {l.open} open
                  <br />
                  {l.hit_25k} reached $25K · avg peak {l.avg_peak_x ? `${l.avg_peak_x}×` : "—"}
                </div>
              </button>
            ))}
          </div>

          {(() => {
            const lv = (s.levels ?? []).find((l) => l.min === min);
            const st = lv?.strategies;
            if (!st) return null;
            const best = Math.max(...STRAT_NAMES.map(([k]) => st[k]?.avg ?? -Infinity));
            return (
              <div className="mt-5 rounded-2xl border border-line bg-surface p-4">
                <div className="font-semibold text-[0.9375rem]">
                  Ways to trade the {LEVEL_NAMES[lv!.level] ?? lv!.level} picks
                </div>
                <p className="text-[0.75rem] text-ink-3 mt-0.5">Same coins, different buy and sell rules. Average per trade is after fees; above 0% the rule makes money.</p>
                <div className="mt-3 grid gap-1.5">
                  {STRAT_NAMES.map(([k, label]) => {
                    const x = st[k];
                    if (!x) return null;
                    return (
                      <div key={k} className={"flex items-center gap-3 text-[0.8125rem] rounded-xl px-2.5 py-1.5 " + (x.avg === best ? "bg-paper border border-line" : "")}>
                        <div className="flex-1 min-w-0 truncate">{label}</div>
                        <div className="w-20 text-right text-ink-2">{x.n} trades</div>
                        <div className="w-16 text-right text-ink-2">{pct(x.wins, x.n)} won</div>
                        <div className={"w-20 text-right font-mono font-semibold " + (x.avg > 0 ? "text-up" : "text-danger")}>
                          {x.avg > 0 ? "+" : ""}
                          {(x.avg * 100).toFixed(1)}%
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          <div className="mt-5 rounded-2xl border border-line bg-surface p-4">
            <div className="font-semibold text-[0.9375rem]">Best rules found by the optimizer</div>
            {!data?.opt ? (
              <p className="text-[0.8125rem] text-ink-3 mt-1">
                Runs every 3 hours once 300 followed coins are in. It tries 300,000+ rule sets on the older 70% of coins and keeps only the ones that also make money on the newest 30%.
              </p>
            ) : (
              <>
                <p className="text-[0.75rem] text-ink-3 mt-0.5">
                  {ago(data.opt.run_at)} · {data.opt.result.tried.toLocaleString()} rule sets tried on {data.opt.result.coins.toLocaleString()} coins · checked on the newest{" "}
                  {data.opt.result.val.toLocaleString()} (not used to find them) · average per trade after fees
                </p>
                {data.opt.result.top.length === 0 && <p className="mt-2 text-[0.8125rem] text-ink-2">No rule made money on both parts yet.</p>}
                <div className="mt-3 grid gap-2">
                  {data.opt.result.top.slice(0, 5).map((t, i) => (
                    <div key={i} className="rounded-xl border border-line bg-paper p-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <div className="font-semibold text-[0.875rem]">
                          #{i + 1} · buy {t.entry} · {t.exit}
                        </div>
                        <div className={"font-mono font-semibold " + (t.val.avg > 0 ? "text-up" : "text-danger")}>
                          {t.val.avg > 0 ? "+" : ""}
                          {(t.val.avg * 100).toFixed(1)}%
                        </div>
                      </div>
                      <div className="text-[0.75rem] text-ink-2 mt-1">
                        Check: {t.val.n} trades, {pct(t.val.wins, t.val.n)} won, {t.val.perDay}/day · Search part: {t.train.n} trades, {pct(t.train.wins, t.train.n)} won,{" "}
                        {t.train.avg > 0 ? "+" : ""}
                        {(t.train.avg * 100).toFixed(1)}%
                      </div>
                      <div className="text-[0.75rem] text-ink-3 mt-1">{ruleWords(t.rule)}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {s.fails && (
            <div className="mt-5 rounded-2xl border border-line bg-surface p-4">
              <div className="font-semibold text-[0.9375rem]">Why coins were skipped</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.entries(s.fails).map(([k, n]) => (
                  <span key={k} className="px-2.5 py-1 rounded-full bg-paper border border-line text-[0.8125rem]">
                    {k} · {n.toLocaleString()}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {data && (
        <div className="mt-5">
          <div className="font-semibold text-[0.9375rem]">Picks with score {min}+</div>
          {data.coins.length === 0 && <p className="mt-2 text-ink-3 text-[0.875rem]">None in this period yet.</p>}
          <div className="mt-2 grid gap-2">
            {data.coins.map((c) => {
              const peakX = c.entry_mc && c.peak_mc ? c.peak_mc / c.entry_mc : null;
              return (
                <a
                  key={c.mint}
                  href={`https://dexscreener.com/solana/${c.mint}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-2xl border border-line bg-surface p-3 flex items-center gap-3 min-w-0"
                >
                  <div className="w-10 text-center font-mono font-semibold">{c.score}</div>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold truncate">
                      {c.name} <span className="text-ink-3">${c.symbol}</span>
                    </div>
                    <div className="text-[0.75rem] text-ink-3 truncate">
                      {ago(c.created_at)} · in at {compactUsd(c.entry_mc ?? 0)} · peak {compactUsd(c.peak_mc ?? 0)}
                      {peakX ? ` (${peakX.toFixed(1)}×)` : ""}
                      {c.x ? " · X" : ""}
                      {c.telegram ? " · TG" : ""}
                      {c.website ? " · web" : ""}
                    </div>
                  </div>
                  <span
                    className={
                      "px-2 py-0.5 rounded-full text-[0.75rem] font-semibold " +
                      (c.result === "win" ? "bg-up/15 text-up" : c.result === "loss" ? "bg-danger/15 text-danger" : "bg-paper text-ink-3 border border-line")
                    }
                  >
                    {c.result === "win" ? "+50%" : c.result === "loss" ? "−20%" : c.result === "restart" ? "restarted" : c.done ? "flat" : "watching"}
                  </span>
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
