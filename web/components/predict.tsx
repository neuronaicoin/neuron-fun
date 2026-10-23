"use client";

/**
 * Predict: yes / no on prices, matches and rate decisions (Hyperliquid's outcome markets).
 * A share pays $1 if its side comes true, $0 if not; the price (0–1) is the market's chance.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConnectButton, Sheet } from "./chrome";
import { MarketSwitch } from "./marketswitch";
import { useWallet } from "./wallet";
import { afterTrade } from "@/lib/portfolio";
import { friendlyError } from "@/lib/format";
import { showToast } from "@/lib/toast";
import { postOnX } from "./share";
import { PERPS_TRADING, geoExempt, perpsAllowedHere } from "@/lib/perps";
import { usePerpsTrade } from "@/lib/perpstrade";
import {
  PREDICT_MIN,
  fetchPredict,
  fetchPredictWallet,
  type PredictBoard,
  type PredictGroup,
  type PredictHolding,
  type PredictOutcome,
  type PredictTab,
  type PredictWallet,
} from "@/lib/predict";

const TABS: [PredictTab, string][] = [
  ["price", "Price"],
  ["sports", "Sports"],
  ["rates", "Rates"],
  ["other", "Other"],
];
/** A side's price in dollars ($0.62 = 62% chance; it pays $1 if right). */
const cents = (p: number | null) => (p === null ? "—" : `$${Math.max(0.01, Math.min(0.99, p)).toFixed(2)}`);
/** "#BTC" from "BTC", "#Fed" from "Fed": letters and digits only. */
const hashtag = (s: string) => {
  const t = String(s || "").replace(/[^A-Za-z0-9_]/g, "");
  return /^[A-Za-z][A-Za-z0-9_]{0,29}$/.test(t) ? `#${t}` : "";
};
const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function left(ms: number | null, now: number): string | null {
  if (!ms) return null;
  const s = Math.floor((ms - now) / 1000);
  if (s <= 0) return "Ending…";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `Ends in ${d}d ${h}h` : h > 0 ? `Ends in ${h}h ${m}m` : `Ends in ${m}m ${s % 60}s`;
}

function useNow(every = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

type Pick = { o: PredictOutcome; side: 0 | 1 };

const SITE = "https://sasapad.fun";
function shareOutcome(o: PredictOutcome, title: string) {
  const p = o.sides[0].price;
  const odds = p !== null ? `market says ${o.sides[0].name} ${cents(p)} vs ${o.sides[1].name} ${cents(o.sides[1].price)}` : "";
  // the product's hashtag leads the post ("#BTC above $82,000…"), then at least four in all
  const lead = hashtag(o.tag);
  const head = lead && title.toLowerCase().startsWith(o.tag.toLowerCase()) ? `${lead}${title.slice(o.tag.length)}` : lead ? `${lead} ${title}` : title;
  const more = o.tab === "sports" ? ["#Sports", "#Predictions", "#Betting", "#Crypto"] : o.tab === "rates" ? ["#Fed", "#Rates", "#Predictions", "#Macro", "#Crypto"] : ["#Predictions", "#PredictionMarket", "#Crypto", "#Trading"];
  const sideTag = o.tab === "sports" ? hashtag(o.sides[1].name) : "";
  const tags = [...new Set([sideTag, ...more].filter((t) => t && t.toLowerCase() !== lead.toLowerCase()))].slice(0, 5).join(" ");
  postOnX(`${head}\n\n${odds} 👀 what's your call?\n\n${tags}`, `${SITE}/predict/?m=${o.outcome}`);
}
function ShareBtn({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Share on X" title="Share on X" className="shrink-0 w-8 h-8 -mr-1 -mt-1 rounded-full text-ink-3 hover:text-ink hover:bg-paper flex items-center justify-center">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M18.9 2H22l-7.6 8.7L23 22h-6.8l-5.3-6.9L4.8 22H1.7l8.1-9.3L1 2h6.9l4.8 6.3L18.9 2zm-1.2 18h1.9L6.4 3.9H4.4L17.7 20z" />
      </svg>
    </button>
  );
}
const showRaw = () => {
  try {
    return new URLSearchParams(window.location.search).get("raw") === "1";
  } catch {
    return false;
  }
};

export function PredictScreen() {
  const w = useWallet();
  const user = w.address ?? null;
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [board, setBoard] = useState<PredictBoard | null>(null);
  const [error, setError] = useState(false);
  const [mine, setMine] = useState<PredictWallet | null>(null);
  const [tab, setTab] = useState<PredictTab>("price");
  const [pick, setPick] = useState<Pick | null>(null);
  const now = useNow();

  useEffect(() => {
    let alive = true;
    void perpsAllowedHere().then((ok) => alive && setAllowed(ok));
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const b = await fetchPredict();
      setBoard(b);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  const loadMine = useCallback(async () => {
    if (!user) return setMine(null);
    const m = await fetchPredictWallet(user).catch(() => null);
    if (m) setMine(m);
  }, [user]);
  useEffect(() => {
    void load();
    void loadMine();
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load();
      void loadMine();
    }, 10_000);
    return () => clearInterval(t);
  }, [load, loadMine]);

  const after = useCallback(async () => {
    await Promise.all([load(), loadMine()]);
    afterTrade();
  }, [load, loadMine]);
  const trade = usePerpsTrade(after);

  const byOutcome = useMemo(() => {
    const m = new Map<number, PredictOutcome>();
    for (const o of board?.singles ?? []) m.set(o.outcome, o);
    for (const g of board?.groups ?? []) for (const o of g.answers) m.set(o.outcome, o);
    return m;
  }, [board]);
  const tabs = useMemo(() => {
    const has = new Set([...(board?.singles ?? []).map((o) => o.tab), ...(board?.groups ?? []).map((g) => g.tab)]);
    return TABS.filter(([t]) => t !== "other" || has.has("other"));
  }, [board]);
  // a shared link (?m=<outcome>) opens its tab and lights up its card
  const [hot, setHot] = useState<number | null>(null);
  useEffect(() => {
    if (!board || hot !== null) return;
    const m = Number(new URLSearchParams(window.location.search).get("m"));
    if (!Number.isInteger(m) || m <= 0) return setHot(-1);
    const single = board.singles.find((o) => o.outcome === m);
    const group = board.groups.find((g) => g.answers.some((a) => a.outcome === m));
    setHot(m);
    const t = single?.tab ?? group?.tab;
    if (t) setTab(t);
    setTimeout(() => document.getElementById(single ? `m${m}` : `q${group?.question}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
  }, [board, hot]);
  const singles = (board?.singles ?? []).filter((o) => o.tab === tab);
  const groups = (board?.groups ?? []).filter((g) => g.tab === tab);

  const exempt = geoExempt(user);
  if (allowed === null && !exempt) return <div className="max-w-6xl mx-auto px-4 py-10"><div className="shimmer h-40 rounded-3xl" /></div>;
  if (!allowed && !exempt)
    return (
      <div className="max-w-xl mx-auto px-4 py-10">
        <MarketSwitch at="predict" />
        <div className="text-center mt-8">
          <h1 className="font-display font-bold text-[1.5rem]">Predict isn&apos;t available where you are</h1>
          <p className="text-ink-2 mt-2">Predictions aren&apos;t offered in your country or region. Everything else on sasa works as usual.</p>
        </div>
      </div>
    );

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 flex flex-col gap-5">
      <div>
        <MarketSwitch at="predict" />
      </div>
      <div className="flex flex-col gap-1">
        <h1 className="font-display font-bold text-[1.75rem] leading-tight">Predict</h1>
        <p className="text-ink-2 text-[0.9375rem]">Yes or no on prices, matches and rate decisions. Right answer pays $1 a share.</p>
      </div>

      <div className="flex gap-1.5 overflow-x-auto no-scrollbar" role="tablist" aria-label="Kind of prediction">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={"h-10 px-4 rounded-xl text-[0.9375rem] font-semibold shrink-0 " + (tab === t ? "bg-ink text-mist" : "text-ink-2 bg-surface border border-line hover:border-ink-3")}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_340px] gap-5 items-start">
        <div className="grid sm:grid-cols-2 gap-3 min-w-0">
          {board === null ? (
            error ? (
              <p className="sm:col-span-2 text-ink-3 text-center py-10">Predictions can&apos;t be loaded right now. Trying again…</p>
            ) : (
              Array.from({ length: 4 }, (_, i) => <div key={i} className="shimmer h-40 rounded-2xl" />)
            )
          ) : singles.length + groups.length === 0 ? (
            <p className="sm:col-span-2 text-ink-3 text-center py-10">
              {tab === "price" ? "No price predictions open right now." : tab === "sports" ? "No matches open right now. New ones show up here by themselves." : tab === "rates" ? "No rate decisions open right now." : "Nothing open here right now."}
            </p>
          ) : (
            <>
              {singles.map((o) => (
                <SingleCard key={o.outcome} o={o} now={now} hot={hot === o.outcome} onPick={(side) => setPick({ o, side })} />
              ))}
              {groups.map((g) => (
                <GroupCard key={g.question} g={g} now={now} hot={g.answers.some((a) => a.outcome === hot)} onPick={(o, side) => setPick({ o, side })} />
              ))}
            </>
          )}
        </div>

        <aside className="flex flex-col gap-3 lg:sticky lg:top-20">
          <Mine user={user} mine={mine} byOutcome={byOutcome} trade={trade} />
        </aside>
      </div>

      <p className="text-[0.75rem] text-ink-3">
        Prices are the market&apos;s chance ($0.62 = 62%). A share pays $1 if it comes true and $0 if not; you can sell before it ends. Powered by Hyperliquid. Predictions can lose all you put in.
      </p>

      {pick && <BuySheet pick={pick} onSide={(side) => setPick({ ...pick, side })} onClose={() => setPick(null)} trade={trade} />}
    </div>
  );
}

function Bar({ p }: { p: number | null }) {
  return (
    <div className="h-1.5 rounded-full bg-danger/25 overflow-hidden" aria-hidden="true">
      <div className="h-full bg-up" style={{ width: `${Math.round((p ?? 0.5) * 100)}%` }} />
    </div>
  );
}

function SideButtons({ o, onPick, small = false }: { o: PredictOutcome; onPick: (side: 0 | 1) => void; small?: boolean }) {
  const cls = small ? "h-9 px-3 text-[0.8125rem]" : "h-11 text-[0.9375rem]";
  return (
    <div className={small ? "flex gap-1.5 shrink-0" : "grid grid-cols-2 gap-2"}>
      {([0, 1] as const).map((i) => (
        <button
          key={i}
          type="button"
          onClick={() => onPick(i)}
          className={
            cls +
            " rounded-xl font-bold truncate " +
            (i === 0 ? "bg-up/15 text-up hover:bg-up/25" : "bg-danger/15 text-danger hover:bg-danger/25")
          }
        >
          {!small || o.sides[i].name.length <= 4 ? `${o.sides[i].name} ` : ""}
          {cents(o.sides[i].price)}
        </button>
      ))}
    </div>
  );
}

function SingleCard({ o, now, onPick, hot }: { o: PredictOutcome; now: number; onPick: (side: 0 | 1) => void; hot?: boolean }) {
  const ends = left(o.expiry, now);
  return (
    <article id={`m${o.outcome}`} className={"rounded-2xl border bg-surface p-4 flex flex-col gap-3 min-w-0 " + (hot ? "border-emerald ring-1 ring-emerald" : "border-line")}>
      <div className="flex items-start gap-2">
        <h2 className="flex-1 font-semibold text-[1rem] leading-snug">{o.title}</h2>
        <ShareBtn onClick={() => shareOutcome(o, o.title)} />
      </div>
      {showRaw() && <p className="text-[0.6875rem] font-mono text-ink-3 break-all">{o.raw}</p>}
      <Bar p={o.sides[0].price} />
      <SideButtons o={o} onPick={onPick} />
      {ends && <div className="text-[0.75rem] text-ink-3">{ends}</div>}
    </article>
  );
}

function GroupCard({ g, now, onPick, hot }: { g: PredictGroup; now: number; onPick: (o: PredictOutcome, side: 0 | 1) => void; hot?: boolean }) {
  const ends = left(g.expiry, now);
  return (
    <article id={`q${g.question}`} className={"rounded-2xl border bg-surface p-4 flex flex-col gap-2 min-w-0 sm:col-span-2 " + (hot ? "border-emerald ring-1 ring-emerald" : "border-line")}>
      <div className="flex items-start gap-2">
        <h2 className="flex-1 font-semibold text-[1rem] leading-snug">{g.title}</h2>
        <ShareBtn onClick={() => shareOutcome(g.answers[0], `${g.title}: ${g.answers[0].label}?`)} />
      </div>
      {showRaw() && <p className="text-[0.6875rem] font-mono text-ink-3 break-all">{g.answers.map((a) => a.raw).join(" ;; ")}</p>}
      <ul className="divide-y divide-line">
        {g.answers.map((o) => (
          <li key={o.outcome} className="py-2 flex items-center gap-3">
            <span className="flex-1 min-w-0 truncate text-[0.9375rem]">{o.label}</span>
            <SideButtons o={o} small onPick={(side) => onPick(o, side)} />
          </li>
        ))}
      </ul>
      {ends && <div className="text-[0.75rem] text-ink-3">{ends}</div>}
    </article>
  );
}

function BuySheet({ pick, onSide, onClose, trade }: { pick: Pick; onSide: (s: 0 | 1) => void; onClose: () => void; trade: ReturnType<typeof usePerpsTrade> }) {
  const w = useWallet();
  const { o, side } = pick;
  const [amount, setAmount] = useState("25");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const p = o.sides[side].price;
  const n = Number(amount);
  const shares = p && n > 0 ? Math.floor(n / p) : 0;
  const title = o.label && o.label !== o.title && !o.title.includes(o.label) ? `${o.title} · ${o.label}` : o.title;
  const buy = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await trade.predictBuy(o, side, n, setStep);
      showToast({ kind: "buy", title: `Bought ${r.shares} ${o.sides[side].name}`, body: `${title} · pays $${r.shares.toLocaleString("en-US")} if it comes true` });
      onClose();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
      setStep(null);
    }
  };
  return (
    <Sheet title="Predict" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="font-semibold text-[1.0625rem] leading-snug">{title}</div>
        <div className="grid grid-cols-2 gap-2">
          {([0, 1] as const).map((i) => (
            <button
              key={i}
              type="button"
              aria-pressed={side === i}
              onClick={() => onSide(i)}
              className={
                "h-12 rounded-xl font-bold text-[0.9375rem] truncate px-2 " +
                (i === 0 ? "bg-up/15 text-up " : "bg-danger/15 text-danger ") +
                (side === i ? (i === 0 ? "ring-2 ring-up" : "ring-2 ring-danger") : "")
              }
            >
              {o.sides[i].name} {cents(o.sides[i].price)}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] text-ink-3">Amount (USDC)</span>
          <div className="grid grid-cols-4 gap-2">
            {["10", "25", "50", "100"].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setAmount(v)}
                aria-pressed={amount === v}
                className={"h-11 rounded-xl border font-semibold text-[0.9375rem] " + (amount === v ? "border-ink ring-1 ring-ink" : "border-line text-ink-2")}
              >
                ${v}
              </button>
            ))}
          </div>
          <label className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-3">$</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))}
              aria-label="Amount in dollars"
              className="w-full h-12 rounded-xl border border-line bg-paper pl-8 pr-4 text-[1rem] outline-none focus:border-ink-3"
            />
          </label>
        </div>
        {shares > 0 && (
          <div>
            <div className="text-[0.8125rem] text-ink-3">If {o.sides[side].name} comes true, you get about</div>
            <div className="font-display font-bold text-[1.5rem]">
              {usd(shares)} <span className="text-up text-[1rem]">+{usd(Math.max(0, shares - n))}</span>
            </div>
            <div className="text-[0.75rem] text-ink-3">You can sell anytime before it ends.</div>
          </div>
        )}
        {n > 0 && n < PREDICT_MIN && <p className="text-[0.8125rem] text-warn-ink">The smallest prediction is ${PREDICT_MIN}.</p>}
        {!o.tradable && <p className="text-[0.8125rem] text-warn-ink">This one can&apos;t be bought on sasa yet.</p>}
        {err && <p className="text-[0.8125rem] text-danger">{err}</p>}
        {!w.address ? (
          <ConnectButton full />
        ) : (
          <button
            type="button"
            disabled={busy || !PERPS_TRADING || !o.tradable || !(n >= PREDICT_MIN)}
            onClick={() => void buy()}
            className="h-13 min-h-[3.25rem] rounded-full bg-emerald text-on-accent font-bold text-[1.0625rem] disabled:opacity-50"
          >
            {busy ? (step ?? "Working…") : `Buy ${o.sides[side].name} for $${n > 0 ? n : 0}`}
          </button>
        )}
        <p className="text-[0.75rem] text-ink-3 text-center">Paid from your balance. Predictions can lose all you put in.</p>
      </div>
    </Sheet>
  );
}

function Mine({ user, mine, byOutcome, trade }: { user: string | null; mine: PredictWallet | null; byOutcome: Map<number, PredictOutcome>; trade: ReturnType<typeof usePerpsTrade> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!user)
    return (
      <div className="rounded-2xl border border-line bg-surface p-4 flex flex-col gap-3">
        <div className="font-semibold">Your predictions</div>
        <p className="text-[0.875rem] text-ink-3">Log in to predict. It uses the same balance as the rest of sasa.</p>
        <ConnectButton full />
      </div>
    );
  const holdings = mine?.holdings ?? [];
  const sell = async (h: PredictHolding) => {
    setBusy(h.token);
    setErr(null);
    try {
      const r = await trade.predictSell(h, () => {});
      showToast({ kind: "sell", title: "Sold", body: r.usd ? `For about ${usd(r.usd)}` : undefined });
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };
  const back = async () => {
    if (!mine) return;
    setBusy("cash");
    setErr(null);
    try {
      await trade.predictToFutures(mine.cash, () => {});
      showToast({ kind: "ok", title: "Moved to futures", body: usd(mine.cash) });
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 flex flex-col gap-3">
      <div className="font-semibold">Your predictions</div>
      {holdings.length === 0 ? (
        <p className="text-[0.875rem] text-ink-3">None yet. Tap Yes or No on any card.</p>
      ) : (
        <ul className="divide-y divide-line">
          {holdings.map((h) => {
            const o = byOutcome.get(h.outcome);
            const p = o?.sides[h.side].price ?? null;
            const value = p !== null ? h.shares * p : null;
            const pnl = value !== null && h.cost > 0 ? value - h.cost : null;
            return (
              <li key={h.token} className="py-2.5 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-[0.875rem] font-semibold truncate">{o ? (o.label && !o.title.includes(o.label) ? `${o.title} · ${o.label}` : o.title) : `Prediction ${h.outcome}`}</div>
                  <div className="text-[0.75rem] text-ink-3">
                    {h.shares.toLocaleString("en-US")} {o?.sides[h.side].name ?? (h.side === 0 ? "Yes" : "No")}
                    {h.cost > 0 ? ` · paid ${usd(h.cost)}` : ""}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-mono text-[0.875rem] tabular-nums">{value !== null ? usd(value) : "—"}</div>
                  {pnl !== null && <div className={"font-mono text-[0.75rem] tabular-nums " + (pnl >= 0 ? "text-up" : "text-danger")}>{pnl >= 0 ? "+" : "−"}{usd(Math.abs(pnl))}</div>}
                </div>
                <button type="button" disabled={!!busy} onClick={() => void sell(h)} className="h-9 px-3 rounded-xl border border-line text-[0.8125rem] font-semibold disabled:opacity-50">
                  {busy === h.token ? "…" : "Sell"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {mine && mine.cash >= 0.01 && (
        <div className="flex items-center justify-between gap-2 rounded-xl bg-paper px-3 py-2.5 text-[0.8125rem]">
          <span>
            Predict cash <b className="font-mono">{usd(mine.cash)}</b>
          </span>
          <button type="button" disabled={!!busy || mine.cash < 0.01} onClick={() => void back()} className="font-semibold text-emerald disabled:opacity-50">
            {busy === "cash" ? "Moving…" : "Move to futures"}
          </button>
        </div>
      )}
      {err && <p className="text-[0.8125rem] text-danger">{err}</p>}
    </div>
  );
}
