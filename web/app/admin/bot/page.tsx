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
  val: { n: number; wins: number; avg: number; robust?: number; perDay: number };
};
type LateResult = Omit<OptResult, "entry">;
type LateOpt = { signals: number; train: number; val: number; tried: number; top: LateResult[]; steady: LateResult[] };
type Opt = { run_at: string; result: { coins: number; train: number; val: number; tried: number; smartWallets?: number; top: OptResult[]; steady?: OptResult[]; late?: LateOpt } };

const k$ = (v: number) => (v >= 1000 ? `$${v / 1000}K` : `$${v}`);
/** A proven-coin rule in words. */
function lateWords(r: Record<string, number>): string {
  const w: string[] = [];
  w.push(r.stage === 1 ? "still on its launch curve" : r.stage === 2 ? "graduated to its pool" : "curve or pool");
  w.push(r.minLevel === r.maxLevel ? `crossing ${k$(r.minLevel)}` : `crossing ${k$(r.minLevel)}–${k$(r.maxLevel)}`);
  if (r.minAge > 0) w.push(`${r.minAge}+ min old`);
  if (r.maxAge < 99999) w.push(`under ${r.maxAge} min old`);
  if (r.minBuyers > 0) w.push(`${r.minBuyers}+ buyers in all`);
  if (r.minBuys5 > 0) w.push(`${r.minBuys5}+ buys in 5 min`);
  if (r.minNewBuyers5 > 0) w.push(`${r.minNewBuyers5}+ new buyers in 5 min`);
  if (r.minNetSol5 > -99) w.push(`${r.minNetSol5}+ SOL in over 5 min`);
  if (r.minRatio5 > 0) w.push(`buys ${r.minRatio5}× sells`);
  if (r.minMove5 > 0) w.push(`up ${Math.round((r.minMove5 - 1) * 100)}%+ in 5 min`);
  if (r.maxMove5 < 99) w.push(`not up more than ${Math.round((r.maxMove5 - 1) * 100)}% in 5 min`);
  if (r.needX === 2) w.push("own X account");
  else if (r.needX === 1) w.push("an X link");
  if (r.minTg === 1) w.push("a Telegram");
  else if (r.minTg > 1) w.push(`Telegram ${r.minTg}+`);
  if (r.devNotSold) w.push("creator never sold");
  return w.join(" · ");
}

function LateRuleList({ list, empty }: { list: LateResult[]; empty: string }) {
  if (!list.length) return <p className="mt-2 text-[0.8125rem] text-ink-2">{empty}</p>;
  return (
    <div className="mt-2 grid gap-2">
      {list.slice(0, 5).map((t, i) => (
        <div key={i} className="rounded-xl border border-line bg-paper p-3">
          <div className="flex items-baseline justify-between gap-3">
            <div className="font-semibold text-[0.875rem]">
              #{i + 1} · {t.exit}
            </div>
            <div className={"font-mono font-semibold whitespace-nowrap " + (t.val.avg > 0 ? "text-up" : "text-danger")}>
              {t.val.avg > 0 ? "+" : ""}
              {(t.val.avg * 100).toFixed(1)}% · {pct(t.val.wins, t.val.n)} won
            </div>
          </div>
          <div className="text-[0.75rem] text-ink-2 mt-1">
            Check: {t.val.n} trades, {pct(t.val.wins, t.val.n)} won, {t.val.perDay}/day{t.val.robust != null ? ` · without its best trade ${t.val.robust > 0 ? "+" : ""}${(t.val.robust * 100).toFixed(1)}%` : ""} · Search part: {t.train.n} trades, {pct(t.train.wins, t.train.n)} won,{" "}
            {t.train.avg > 0 ? "+" : ""}
            {(t.train.avg * 100).toFixed(1)}%
          </div>
          <div className="text-[0.75rem] text-ink-3 mt-1">{lateWords(t.rule)}</div>
        </div>
      ))}
    </div>
  );
}

function RuleList({ list, empty }: { list: OptResult[]; empty: string }) {
  if (!list.length) return <p className="mt-2 text-[0.8125rem] text-ink-2">{empty}</p>;
  return (
    <div className="mt-2 grid gap-2">
      {list.slice(0, 5).map((t, i) => (
        <div key={i} className="rounded-xl border border-line bg-paper p-3">
          <div className="flex items-baseline justify-between gap-3">
            <div className="font-semibold text-[0.875rem]">
              #{i + 1} · buy {t.entry} · {t.exit}
            </div>
            <div className={"font-mono font-semibold whitespace-nowrap " + (t.val.avg > 0 ? "text-up" : "text-danger")}>
              {t.val.avg > 0 ? "+" : ""}
              {(t.val.avg * 100).toFixed(1)}% · {pct(t.val.wins, t.val.n)} won
            </div>
          </div>
          <div className="text-[0.75rem] text-ink-2 mt-1">
            Check: {t.val.n} trades, {pct(t.val.wins, t.val.n)} won, {t.val.perDay}/day{t.val.robust != null ? ` · without its best trade ${t.val.robust > 0 ? "+" : ""}${(t.val.robust * 100).toFixed(1)}%` : ""} · Search part: {t.train.n} trades, {pct(t.train.wins, t.train.n)} won,{" "}
            {t.train.avg > 0 ? "+" : ""}
            {(t.train.avg * 100).toFixed(1)}%
          </div>
          <div className="text-[0.75rem] text-ink-3 mt-1">{ruleWords(t.rule)}</div>
        </div>
      ))}
    </div>
  );
}

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
  if (r.minNetSol > -99) w.push(`${r.minNetSol}+ SOL in`);
  if (r.minRatio > 0) w.push(`buys ${r.minRatio}× sells`);
  if (r.minMult > 0 || r.maxMult < 99) w.push(`bought at ${r.minMult}–${r.maxMult >= 99 ? "any" : r.maxMult}× launch price`);
  if (r.minNewBuyers60 > 0) w.push(`${r.minNewBuyers60}+ new buyers in the minute before`);
  if (r.minNetSol60 > -99) w.push(`${r.minNetSol60}+ SOL in during the minute before`);
  if (r.minRatio60 > 0) w.push(`buys ${r.minRatio60}× sells in the minute before`);
  if (r.minSmart > 0) w.push(`${r.minSmart}+ smart wallets bought before`);
  if (!w.length) w.push("no filter: every coin");
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
  const [launchErrors, setLaunchErrors] = useState<LaunchError[] | null>(null);
  const [trends, setTrends] = useState<Trend[] | null>(null);
  const [trendsError, setTrendsError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await authedGet<{ stats: Stats | null; coins: Coin[]; opt: Opt | null }>(signMessage, `bot/stats?hours=${hours}&min=${min}`));
      setError("");
      authedGet<{ themes: Trend[]; error?: string }>(signMessage, "bot/trends")
        .then((r) => {
          setTrends(r.themes ?? []);
          setTrendsError(r.error ?? "");
        })
        .catch(() => {});
      authedGet<{ errors: LaunchError[] }>(signMessage, "bot/launchlog")
        .then((r) => setLaunchErrors(r.errors ?? []))
        .catch(() => {});
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

      {trends && <TrendRadarBox list={trends} />}
      {trendsError && <p className="mt-1 text-[0.75rem] text-danger font-mono break-words">Trend Radar: {trendsError}</p>}

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
                Runs every 3 hours once 300 followed coins are in. It tries 600,000+ rule sets on the older 70% of coins and keeps only the ones that also make money on the newest 30%.
              </p>
            ) : (
              <>
                <p className="text-[0.75rem] text-ink-3 mt-0.5">
                  {ago(data.opt.run_at)} · {data.opt.result.tried.toLocaleString()} rule sets tried on {data.opt.result.coins.toLocaleString()} coins · checked on the newest{" "}
                  {data.opt.result.val.toLocaleString()} (not used to find them) · average per trade after fees
                  {data.opt.result.smartWallets != null ? ` · ${data.opt.result.smartWallets.toLocaleString()} smart wallets found` : ""}
                </p>
                <div className="mt-3 text-[0.8125rem] font-semibold">Most profit per trade</div>
                <RuleList list={data.opt.result.top} empty="No rule made money on both parts yet." />
                <div className="mt-4 text-[0.8125rem] font-semibold">Steady: wins 60%+ of trades and still makes money</div>
                <RuleList list={data.opt.result.steady ?? []} empty="No rule won 60%+ and made money on both parts yet." />
                {data.opt.result.late && (
                  <>
                    <div className="mt-5 pt-4 border-t border-line font-semibold text-[0.9375rem]">Proven coins</div>
                    <p className="text-[0.75rem] text-ink-3 mt-0.5">
                      Coins of any age, bought the first time they cross $15K, $25K or $40K on their curve, or $100K, $250K or $500K after they graduate. Followed 6 hours.{" "}
                      {data.opt.result.late.signals.toLocaleString()} signals · {data.opt.result.late.tried.toLocaleString()} rule sets tried
                      {data.opt.result.late.signals < 150 ? " · search starts at 150 signals" : ""}
                    </p>
                    <div className="mt-3 text-[0.8125rem] font-semibold">Most profit per trade</div>
                    <LateRuleList list={data.opt.result.late.top} empty="No rule made money on both parts yet." />
                    <div className="mt-4 text-[0.8125rem] font-semibold">Steady: wins 60%+ and still makes money</div>
                    <LateRuleList list={data.opt.result.late.steady} empty="No rule won 60%+ and made money on both parts yet." />
                  </>
                )}
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

      {launchErrors && (
        <div className="mt-8">
          <div className="font-semibold text-[0.9375rem]">Solana launches that failed</div>
          <p className="text-[0.75rem] text-ink-3">The last 50, with the step they were on and Solana&apos;s own words.</p>
          {launchErrors.length === 0 && <p className="mt-2 text-ink-3 text-[0.875rem]">None yet.</p>}
          <div className="mt-2 grid gap-2">
            {launchErrors.map((e, i) => (
              <div key={i} className="rounded-2xl border border-line bg-surface p-3 min-w-0 text-[0.8125rem]">
                <div className="text-[0.75rem] text-ink-3">
                  {ago(e.at)} · {e.kind ?? "pump"} · {e.step || "?"}
                  {e.ua ? ` · ${/iPhone|Android|Mobile/i.test(e.ua) ? "phone" : "computer"}` : ""}
                  {e.mint ? (
                    <>
                      {" · "}
                      <a href={`https://solscan.io/token/${e.mint}`} target="_blank" rel="noreferrer" className="text-emerald">
                        coin
                      </a>
                    </>
                  ) : null}
                </div>
                <div className="mt-1 font-mono text-[0.75rem] break-words">{e.error}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type LaunchError = { at: string; owner: string | null; creator: string | null; mint: string | null; kind: string | null; step: string | null; error: string | null; ua: string | null };

type Trend = { theme: string; n1: number; prev: number; hot1: number; tracked: number; x2: number; buyers1: number | null; score: number; best: { name: string; symbol: string; mint: string; x: number | null }[] | null };

/** Which themes new pump.fun coins launch on in the last hour, and how they do (indexer sniper_trends). */
function TrendRadarBox({ list }: { list: Trend[] }) {
  const title = (t: string) => (/[A-Z]/.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1));
  return (
    <div className="mt-4 rounded-2xl border border-line bg-surface p-3 sm:p-4">
      <div className="flex items-center gap-2">
        <span className="relative flex w-2 h-2" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full rounded-full bg-[#ff6b1a] opacity-60 animate-ping" />
          <span className="relative inline-flex rounded-full w-2 h-2 bg-[#ff6b1a]" />
        </span>
        <span className="font-semibold text-[0.9375rem]">Trend Radar</span>
        <span className="ml-auto text-[0.75rem] text-ink-3">new pump.fun coins · last hour</span>
      </div>
      {list.length === 0 && <p className="mt-2 text-ink-3 text-[0.875rem]">Not enough new coins yet. Check back in a few minutes.</p>}
      <div className="mt-2 grid gap-2">
        {list.map((t) => {
          const up = t.n1 > t.prev * 1.3 ? "up" : t.n1 < t.prev * 0.7 ? "down" : "flat";
          return (
            <div key={t.theme} className="rounded-xl border border-line p-2.5 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-semibold truncate">{title(t.theme)}</span>
                <span className={"text-[0.75rem] font-semibold shrink-0 " + (up === "up" ? "text-up" : up === "down" ? "text-danger" : "text-ink-3")}>
                  {up === "up" ? "↑ rising" : up === "down" ? "↓ cooling" : "→ steady"}
                </span>
                <a href={`/race/launch/?theme=${encodeURIComponent(title(t.theme))}`} className="ml-auto shrink-0 h-7 px-2.5 rounded-lg bg-ink text-paper text-[0.75rem] font-semibold flex items-center">
                  Create on this
                </a>
              </div>
              <div className="text-[0.75rem] text-ink-3 mt-0.5">
                {t.n1} coins/h (was {t.prev}) · {t.hot1} hot starts · {t.x2}/{t.tracked} hit 2x · avg {t.buyers1 ?? 0} buyers
              </div>
              {t.best && t.best.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {t.best.map((c) => (
                    <a key={c.mint} href={`https://dexscreener.com/solana/${c.mint}`} target="_blank" rel="noreferrer" className="text-[0.75rem] px-2 py-0.5 rounded-full border border-line truncate max-w-[12rem]">
                      ${c.symbol} {c.x ? `${c.x}×` : ""}
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
