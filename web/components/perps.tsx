"use client";

/**
 * Futures (perps): leverage trading on Hyperliquid in sasa's own screen. Market list, live chart, order
 * panel (long / short, leverage, amount, TP/SL), the perps balance with Add / Move to main, and
 * the user's positions, orders and history. Trading itself is in lib/perpstrade.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PerpsChart, type ChartLine } from "./perpschart";
import { OrderBook } from "./perpsbook";
import { ConnectButton, Sheet } from "./chrome";
import { useWallet } from "./wallet";
import { compactUsd } from "@/lib/format";
import { friendlyError } from "@/lib/format";
import {
  BUILDER_FEE,
  DEFAULT_LEV,
  HL_TAKER_FEE,
  PERPS_TRADING,
  fetchPerpAccount,
  fetchPerpFills,
  fetchPerpMarkets,
  fetchPerpOrders,
  perpsAllowedHere,
  planOrder,
  chartDecimals,
  priceDecimals,
  sizeString,
  type PerpAccount,
  type PerpFill,
  type PerpMarket,
  type PerpOrder,
  type PerpPosition,
} from "@/lib/perps";
import { usePerpsTrade, type PerpsTrade } from "@/lib/perpstrade";
import { hlSubscribe } from "@/lib/hlws";
import { haptic } from "@/lib/haptics";
import { authedGet, authedPost, checkPush, enablePush, sessionToken, useAlerts } from "@/lib/alerts";
import { MarketSwitch } from "./marketswitch";

const usd = (v: number, d = 2) => `$${v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const signedUsd = (v: number) => `${v >= 0 ? "+" : "−"}${usd(Math.abs(v))}`;
const pct = (v: number | null, d = 2) => (v === null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`);
const tone = (v: number | null) => (v === null || v === 0 ? "text-ink-3" : v > 0 ? "text-up" : "text-danger");
/** Prices: 5 significant digits like Hyperliquid, thousands separated. */
function px(v: number | null | undefined): string {
  if (!v || !Number.isFinite(v)) return "—";
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return Number(v.toPrecision(5)).toLocaleString("en-US", { maximumSignificantDigits: 5 });
}

export function PerpsScreen({ initialCoin }: { initialCoin?: string }) {
  const w = useWallet();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  // an admin wallet (FORUM_ADMINS) may test from a blocked country: checked by the server
  // (kept as the address it was checked for, so a wallet switch never carries it over)
  const [adminFor, setAdminFor] = useState<string | null>(null);
  useEffect(() => {
    try {
      setAdminFor(sessionStorage.getItem("sasa-futures-admin"));
    } catch {}
  }, [w.address]);
  const adminTest = !!w.address && adminFor === w.address.toLowerCase();
  useEffect(() => {
    let alive = true;
    void perpsAllowedHere().then((ok) => alive && setAllowed(ok));
    return () => {
      alive = false;
    };
  }, []);
  const [markets, setMarkets] = useState<PerpMarket[] | null>(null);
  // case kept: Hyperliquid has markets like kPEPE (a thousand PEPE)
  const [coin, setCoin] = useState((initialCoin || "BTC").trim());
  const [account, setAccount] = useState<PerpAccount | null>(null);
  const [orders, setOrders] = useState<PerpOrder[]>([]);
  const [fills, setFills] = useState<PerpFill[]>([]);
  const [error, setError] = useState(false);
  const [picker, setPicker] = useState(false);
  const user = w.address ?? null;

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchPerpMarkets()
        .then((m) => alive && (setMarkets(m), setError(false)))
        .catch(() => alive && setError(true));
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 5_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // the wallet now in use: answers that come back for an earlier one are dropped
  const userRef = useRef(user);
  userRef.current = user;
  const loadMine = useCallback(async () => {
    if (!user) return;
    const [a, o, f] = await Promise.all([
      fetchPerpAccount(user).catch(() => null),
      fetchPerpOrders(user).catch(() => null),
      fetchPerpFills(user).catch(() => null),
    ]);
    if (userRef.current !== user) return;
    if (a) setAccount(a);
    if (o) setOrders(o);
    if (f) setFills(f);
  }, [user]);
  useEffect(() => {
    setAccount(null);
    setOrders([]);
    setFills([]);
    if (!user) return;
    void loadMine();
    const t = setInterval(() => document.visibilityState === "visible" && void loadMine(), 5_000);
    return () => clearInterval(t);
  }, [user, loadMine]);

  // the coin in the address bar, so a page can be shared
  useEffect(() => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    if (u.searchParams.get("c") !== coin) {
      u.searchParams.set("c", coin);
      window.history.replaceState(null, "", u.toString());
    }
  }, [coin]);

  // the open market's price, funding and volume, live (the list refreshes every 5 s)
  useEffect(() => {
    return hlSubscribe({ type: "activeAssetCtx", coin }, (d) => {
      const x = d as { coin?: string; ctx?: { markPx?: string; prevDayPx?: string; dayNtlVlm?: string; funding?: string; openInterest?: string } };
      const c = x?.ctx;
      const mark = Number(c?.markPx);
      if (x?.coin !== coin || !c || !(mark > 0)) return;
      setMarkets((ms) =>
        ms
          ? ms.map((mk) => {
              if (mk.coin !== coin) return mk;
              const prev = Number(c.prevDayPx) || mk.prevDay;
              const oi = Number(c.openInterest);
              const vol = Number(c.dayNtlVlm);
              const f = Number(c.funding);
              return {
                ...mk,
                mark,
                prevDay: prev,
                change24h: prev > 0 ? (mark / prev - 1) * 100 : mk.change24h,
                volume24h: Number.isFinite(vol) ? vol : mk.volume24h,
                openInterestUsd: Number.isFinite(oi) ? oi * mark : mk.openInterestUsd,
                funding: Number.isFinite(f) ? f : mk.funding,
              };
            })
          : ms
      );
    });
  }, [coin]);

  // a link typed in another case (?c=kpepe, ?c=btc) opens the market as Hyperliquid names it
  useEffect(() => {
    if (!markets || markets.some((x) => x.coin === coin)) return;
    const hit = markets.find((x) => x.coin.toLowerCase() === coin.toLowerCase());
    if (hit) setCoin(hit.coin);
  }, [markets, coin]);

  const trade = usePerpsTrade(loadMine);
  const m = markets?.find((x) => x.coin === coin) ?? null;
  const screen = useScreen();
  // the user's position and its TP / SL, drawn on the chart
  const lines = useMemo(() => {
    const out: ChartLine[] = [];
    const p = account?.positions.find((x) => x.coin === coin);
    if (p) {
      out.push({ price: p.entry, label: `${p.side === "long" ? "Long" : "Short"} entry`, kind: "entry" });
      if (p.liq) out.push({ price: p.liq, label: "Liquidation", kind: "liq" });
    }
    for (const o of orders) {
      if (o.coin !== coin || !o.triggerPx) continue;
      if (o.tpsl === "tp") out.push({ price: o.triggerPx, label: "TP", kind: "tp" });
      else if (o.tpsl === "sl") out.push({ price: o.triggerPx, label: "SL", kind: "sl" });
    }
    return out;
  }, [account, orders, coin]);

  if (allowed === null && !adminTest) return <div className="max-w-6xl mx-auto px-4 py-10"><div className="shimmer h-40 rounded-3xl" /></div>;
  if (!allowed && !adminTest) return <Blocked onAdmin={setAdminFor} />;

  return (
    <div className="max-w-[1800px] mx-auto px-3 sm:px-5 py-3 sm:py-5 pb-28 md:pb-10">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <MarketSwitch at="futures" />
        {!allowed && adminTest && (
          <span className="rounded-full bg-warn-bg text-warn-ink px-3 py-1.5 text-[0.75rem] font-semibold">Admin test: Futures stay closed here for everyone else</span>
        )}
      </div>
      <div className="grid gap-3 lg:grid-cols-[15rem_minmax(0,1fr)_21rem] items-start">
        {/* market list (computers) */}
        <aside className="hidden lg:block rounded-3xl border border-line bg-surface overflow-hidden lg:sticky lg:top-24">
          <MarketList markets={markets} coin={coin} onPick={setCoin} />
        </aside>

        <div className="flex flex-col gap-3 min-w-0">
          <MarketHeader m={m} onPick={() => setPicker(true)} />
          <div className="grid gap-3 2xl:grid-cols-[minmax(0,1fr)_17rem] items-start">
          <section className="rounded-3xl border border-line bg-surface p-3 sm:p-4 min-w-0">
            {m ? (
              <>
                <PerpsChart coin={coin} decimals={chartDecimals(m)} lines={lines} />
                <p className="mt-2 text-right text-[0.6875rem] text-ink-3">
                  Powered by{" "}
                  <a href="https://hyperliquid.xyz" target="_blank" rel="noopener noreferrer" className="font-semibold text-ink-2 hover:text-ink">
                    Hyperliquid
                  </a>
                </p>
              </>
            ) : (
              <div className="h-[440px] shimmer rounded-2xl" />
            )}
          </section>
          {/* big screens: the book beside the chart */}
          {m && screen === "huge" && <OrderBook coin={coin} decimals={chartDecimals(m)} rows={11} />}
          </div>
          {/* laptops: under the chart */}
          {m && screen === "wide" && <OrderBook coin={coin} decimals={chartDecimals(m)} rows={7} split />}
          <div className="hidden lg:block">
            <Positions account={account} orders={orders} fills={fills} markets={markets} trade={trade} signedIn={!!user} />
          </div>
        </div>

        <div className="flex flex-col gap-3 lg:sticky lg:top-24">
          <BalanceCard account={account} trade={trade} signedIn={!!user} />
          <OrderPanel m={m} account={account} trade={trade} signedIn={!!user} />
        </div>

        {/* phones: after the order box */}
        {m && screen === "phone" && (
          <div className="lg:hidden">
            <OrderBook coin={coin} decimals={chartDecimals(m)} rows={6} />
          </div>
        )}
        <div className="lg:hidden">
          <Positions account={account} orders={orders} fills={fills} markets={markets} trade={trade} signedIn={!!user} />
        </div>
      </div>

      {error && !markets && <p className="mt-4 text-danger text-[0.875rem]">Could not reach Hyperliquid. Try again in a moment.</p>}
      <p className="mt-4 text-[0.75rem] text-ink-3">Leverage can lose all the money in a position.</p>

      {picker && (
        <Sheet title="Markets" onClose={() => setPicker(false)}>
          <MarketList
            markets={markets}
            coin={coin}
            onPick={(c) => {
              setCoin(c);
              setPicker(false);
            }}
          />
        </Sheet>
      )}
    </div>
  );
}

/** Which layout the book uses (only one is ever live, so one feed, not three). */
function useScreen(): "phone" | "wide" | "huge" {
  const [s, setS] = useState<"phone" | "wide" | "huge">("phone");
  useEffect(() => {
    const huge = window.matchMedia("(min-width: 1536px)");
    const wide = window.matchMedia("(min-width: 1024px)");
    const set = () => setS(huge.matches ? "huge" : wide.matches ? "wide" : "phone");
    set();
    huge.addEventListener("change", set);
    wide.addEventListener("change", set);
    return () => {
      huge.removeEventListener("change", set);
      wide.removeEventListener("change", set);
    };
  }, []);
  return s;
}

function Blocked({ onAdmin }: { onAdmin: (address: string) => void }) {
  const w = useWallet();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await authedGet<{ admin?: boolean }>(w.signMessage, "perps/admin");
      if (r.admin && w.address) {
        try {
          sessionStorage.setItem("sasa-futures-admin", w.address.toLowerCase());
        } catch {}
        onAdmin(w.address.toLowerCase());
      } else setMsg("This wallet isn't an admin.");
    } catch (e) {
      setMsg(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="max-w-xl mx-auto px-4 py-10">
      <MarketSwitch at="futures" />
      <div className="text-center mt-8">
        <h1 className="font-display font-bold text-[1.5rem]">Futures aren&apos;t available where you are</h1>
        <p className="text-ink-2 mt-2">
          Leverage trading isn&apos;t offered in your country or region. Everything else on sasa works as usual.
        </p>
        {w.address && (
          <div className="mt-8">
            <button type="button" disabled={busy} onClick={() => void check()} className="text-[0.75rem] text-ink-3 underline disabled:opacity-50">
              {busy ? "Checking…" : "Admin test"}
            </button>
            {msg && <p className="mt-1 text-[0.75rem] text-ink-3">{msg}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ markets

function MarketList({ markets, coin, onPick }: { markets: PerpMarket[] | null; coin: string; onPick: (c: string) => void }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.trim().toUpperCase();
    return (markets ?? []).filter((m) => !s || m.coin.toUpperCase().includes(s));
  }, [markets, q]);
  return (
    <div className="flex flex-col min-h-0">
      <div className="p-3 border-b border-line">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search markets" className="w-full h-10 rounded-xl border border-line bg-paper px-3 text-[0.875rem] outline-none focus:border-ink-3" />
      </div>
      <ul className="max-h-[70vh] overflow-y-auto divide-y divide-line" aria-label="Markets">
        {markets === null
          ? Array.from({ length: 10 }, (_, i) => (
              <li key={i} className="px-3 py-2.5">
                <div className="h-8 shimmer rounded-lg" />
              </li>
            ))
          : list.map((m) => (
              <li key={m.coin}>
                <button
                  type="button"
                  onClick={() => onPick(m.coin)}
                  aria-current={m.coin === coin}
                  className={"w-full px-3 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-paper " + (m.coin === coin ? "bg-paper" : "")}
                >
                  <span className="min-w-0">
                    <span className="block font-semibold text-[0.875rem] truncate">{m.coin}</span>
                    <span className="block text-[0.6875rem] text-ink-3">{m.maxLev}x</span>
                  </span>
                  <span className="text-right shrink-0">
                    <span className="block font-mono text-[0.8125rem] tabular-nums">{px(m.mark)}</span>
                    <span className={"block font-mono text-[0.6875rem] tabular-nums " + tone(m.change24h)}>{pct(m.change24h)}</span>
                  </span>
                </button>
              </li>
            ))}
      </ul>
    </div>
  );
}

function MarketHeader({ m, onPick }: { m: PerpMarket | null; onPick: () => void }) {
  return (
    <section className="rounded-3xl border border-line bg-surface p-3 sm:p-4 flex flex-wrap items-center gap-x-6 gap-y-2">
      <button type="button" onClick={onPick} className="flex items-center gap-2 lg:pointer-events-none" aria-label="Pick a market">
        <span className="font-display font-bold text-[1.375rem]">{m ? `${m.coin}-USD` : "—"}</span>
        <span className="h-6 px-2 rounded-full bg-paper border border-line text-[0.6875rem] font-bold flex items-center">{m ? `${m.maxLev}x` : ""}</span>
        <svg className="lg:hidden" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div className="font-mono text-[1.25rem] font-semibold tabular-nums">{m ? px(m.mark) : "—"}</div>
      {[
        ["24h", m ? pct(m.change24h) : "—", m ? tone(m.change24h) : ""],
        ["24h volume", m ? compactUsd(m.volume24h) : "—", ""],
        ["Open interest", m ? compactUsd(m.openInterestUsd) : "—", ""],
        ["Funding / 1h", m ? pct(m.funding * 100, 4) : "—", m ? tone(-m.funding) : ""],
      ].map(([k, v, c]) => (
        <div key={k} className="min-w-0">
          <div className="text-[0.6875rem] text-ink-3">{k}</div>
          <div className={"font-mono text-[0.875rem] tabular-nums " + c}>{v}</div>
        </div>
      ))}
    </section>
  );
}

// ------------------------------------------------------------------ balance

function BalanceCard({ account, trade, signedIn }: { account: PerpAccount | null; trade: PerpsTrade; signedIn: boolean }) {
  const [sheet, setSheet] = useState<"add" | "out" | null>(null);
  return (
    <section className="rounded-3xl border border-line bg-surface p-4" aria-label="Futures balance">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[0.8125rem] text-ink-3">Futures balance</span>
        <span className="font-mono font-semibold text-[1.125rem] tabular-nums">{account ? usd(account.accountValue) : signedIn ? "…" : "—"}</span>
      </div>
      {account && account.marginUsed > 0 && (
        <div className="mt-0.5 flex justify-between text-[0.75rem] text-ink-3">
          <span>Free to use</span>
          <span className="font-mono tabular-nums">{usd(account.withdrawable)}</span>
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" disabled={!signedIn || !PERPS_TRADING} onClick={() => setSheet("add")} className="h-10 rounded-xl bg-up text-on-accent font-semibold text-[0.875rem] disabled:opacity-50">
          Add money
        </button>
        <button
          type="button"
          disabled={!signedIn || !PERPS_TRADING || !account || account.withdrawable <= 0}
          onClick={() => setSheet("out")}
          className="h-10 rounded-xl border border-line font-semibold text-[0.875rem] disabled:opacity-50"
        >
          To main balance
        </button>
      </div>
      {sheet && <MoveSheet kind={sheet} account={account} trade={trade} onClose={() => setSheet(null)} />}
    </section>
  );
}

function MoveSheet({ kind, account, trade, onClose }: { kind: "add" | "out"; account: PerpAccount | null; trade: PerpsTrade; onClose: () => void }) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const n = Number(amount.replace(",", ".")) || 0;
  const max = kind === "out" ? (account?.withdrawable ?? 0) : null;
  const go = async () => {
    setMsg(null);
    try {
      if (kind === "add") await trade.deposit(n, setBusy);
      else await trade.withdraw(n, setBusy);
      setMsg({ ok: true, text: kind === "add" ? `$${n.toFixed(2)} is on its way to your futures balance (usually under a minute).` : `$${n.toFixed(2)} is on its way to your main balance (usually a few minutes).` });
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet title={kind === "add" ? "Add money to futures" : "Move to main balance"} onClose={onClose}>
      <div className="flex flex-col gap-3 p-1">
        <p className="text-[0.875rem] text-ink-2">
          {kind === "add"
            ? "USDC from your sasa balance goes to your futures balance on Hyperliquid, in your own name. Smallest: $5."
            : "USDC from your futures balance comes back to your sasa balance."}
        </p>
        <label className="flex items-center h-14 rounded-2xl border border-line bg-paper px-4 focus-within:border-emerald">
          <span className="text-ink-3 text-[1.375rem] mr-1">$</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ""))} inputMode="decimal" aria-label="Amount" className="flex-1 min-w-0 bg-transparent outline-none text-[1.25rem]" />
          {max !== null && (
            <button type="button" onClick={() => setAmount(String(Math.floor(max * 100) / 100))} className="text-[0.8125rem] font-semibold text-emerald">
              Max
            </button>
          )}
        </label>
        <button type="button" disabled={!!busy || n <= 0} onClick={() => void go()} className="h-12 rounded-full bg-ink text-paper font-bold disabled:opacity-50">
          {busy ?? (kind === "add" ? `Add $${n > 0 ? n.toFixed(2) : "0"}` : `Move $${n > 0 ? n.toFixed(2) : "0"}`)}
        </button>
        {msg && <p className={"rounded-xl px-3 py-2 text-[0.875rem] " + (msg.ok ? "bg-emerald-soft" : "bg-warn-bg text-warn-ink")}>{msg.text}</p>}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ order panel

const LEV_CHIPS = [2, 5, 10, 20];

function OrderPanel({ m, account, trade, signedIn }: { m: PerpMarket | null; account: PerpAccount | null; trade: PerpsTrade; signedIn: boolean }) {
  const [side, setSide] = useState<"long" | "short">("long");
  const [amount, setAmount] = useState("50");
  const [lev, setLev] = useState(DEFAULT_LEV);
  const [tpsl, setTpsl] = useState(false);
  const [tp, setTp] = useState<TpslInput>(EMPTY_TPSL);
  const [sl, setSl] = useState<TpslInput>(EMPTY_TPSL);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [alertsOffer, setAlertsOffer] = useState(false);
  const hideOffer = useCallback(() => setAlertsOffer(false), []);
  const w = useWallet();
  const maxLev = m?.maxLev ?? 20;
  // a new market: its own prices, so TP/SL start empty
  useEffect(() => {
    setTp(EMPTY_TPSL);
    setSl(EMPTY_TPSL);
    setMsg(null);
    setAlertsOffer(false);
  }, [m?.coin]);
  useEffect(() => {
    if (lev > maxLev) setLev(maxLev);
  }, [maxLev, lev]);
  const margin = Number(amount.replace(",", ".")) || 0;
  const available = account?.withdrawable ?? 0;
  const plan = m ? planOrder(m, side, margin, lev, available) : null;
  const tpN = m ? tpslPrice(tp, "tp", side, m.mark, lev) : 0;
  const slN = m ? tpslPrice(sl, "sl", side, m.mark, lev) : 0;
  const coinsN = plan ? Number(plan.coins) || 0 : 0;
  const tpslWhy =
    !tpsl || !m
      ? null
      : side === "long"
        ? (tpN && tpN <= m.mark ? "Take profit must be above the price." : slN && slN >= m.mark ? "Stop loss must be below the price." : slN && plan && slN <= plan.liq ? "Stop loss is past the liquidation price." : null)
        : (tpN && tpN >= m.mark ? "Take profit must be below the price." : slN && slN <= m.mark ? "Stop loss must be above the price." : slN && plan && slN >= plan.liq ? "Stop loss is past the liquidation price." : null);
  const why = !PERPS_TRADING ? "Trading opens at mainnet." : !signedIn ? null : (plan?.why ?? tpslWhy);

  const go = async () => {
    if (!m || !plan || why) return;
    setMsg(null);
    try {
      const withTpsl = tpsl && !!(tpN || slN);
      const r = await trade.open({ market: m, side, margin, lev, coins: plan.coins, tp: tpsl && tpN ? tpN : null, sl: tpsl && slN ? slN : null }, setBusy);
      setMsg({ ok: true, text: `${side === "long" ? "Long" : "Short"} ${m.coin} opened at ${px(r.avgPx)}.` });
      // TP / SL / liquidation alerts: signed-in users and email accounts are signed up without a prompt
      const silent = !!sessionToken() || w.embedded;
      if (silent) void authedPost(w.signMessage, "perps/watch", {}).catch(() => {});
      setAlertsOffer(withTpsl || !silent);
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-3xl border border-line bg-surface p-4" aria-label="Open a position">
      <div className="grid grid-cols-2 gap-1 p-1 rounded-2xl bg-paper" role="tablist" aria-label="Long or short">
        {(["long", "short"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={side === s}
            onClick={() => setSide(s)}
            className={"h-11 rounded-xl font-bold " + (side === s ? (s === "long" ? "bg-up text-on-accent" : "bg-danger text-white") : "text-ink-2")}
          >
            {s === "long" ? "Long" : "Short"}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between text-[0.8125rem]">
        <span className="text-ink-3">Amount (your money in)</span>
        {signedIn && account && <span className="text-ink-3">Free: <span className="font-mono">{usd(available)}</span></span>}
      </div>
      <label className="mt-1.5 flex items-center h-14 rounded-2xl border border-line bg-paper px-4 focus-within:border-emerald">
        <span className="text-ink-3 text-[1.375rem] mr-1">$</span>
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ""))} inputMode="decimal" aria-label="Amount in USDC" className="flex-1 min-w-0 bg-transparent outline-none text-[1.25rem]" />
      </label>
      <div className="grid grid-cols-4 gap-1.5 mt-2">
        {[25, 50, 75, 100].map((p) => (
          <button
            key={p}
            type="button"
            disabled={!account || available <= 0}
            onClick={() => setAmount(String(Math.floor(((available * p) / 100 / (1 + lev * (HL_TAKER_FEE + BUILDER_FEE))) * 100) / 100))}
            className="h-9 rounded-xl border border-line text-[0.8125rem] font-semibold disabled:opacity-40"
          >
            {p === 100 ? "Max" : `${p}%`}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-[0.8125rem] text-ink-3">Leverage</span>
        <span className="font-mono font-bold text-[1rem]">{lev}x</span>
      </div>
      <input
        type="range"
        min={1}
        max={maxLev}
        step={1}
        value={lev}
        onChange={(e) => {
          setLev(Number(e.target.value));
          haptic();
        }}
        aria-label="Leverage"
        className="w-full mt-2 accent-[var(--color-emerald)]"
      />
      <div className="grid grid-cols-4 gap-1.5 mt-1">
        {LEV_CHIPS.filter((c) => c <= maxLev).map((c) => (
          <button key={c} type="button" aria-pressed={lev === c} onClick={() => setLev(c)} className={"h-8 rounded-lg border text-[0.8125rem] font-semibold " + (lev === c ? "border-ink" : "border-line text-ink-2")}>
            {c}x
          </button>
        ))}
      </div>

      <label className="mt-4 flex items-center gap-2 text-[0.875rem] cursor-pointer select-none">
        <input type="checkbox" checked={tpsl} onChange={(e) => setTpsl(e.target.checked)} className="w-4 h-4 accent-[var(--color-emerald)]" />
        Take profit / stop loss
      </label>
      {tpsl && m && (
        <div className="mt-2 flex flex-col gap-2.5">
          <TpslRow kind="tp" v={tp} set={setTp} side={side} m={m} coins={coinsN} lev={lev} ref={m.mark} margin={margin} />
          <TpslRow kind="sl" v={sl} set={setSl} side={side} m={m} coins={coinsN} lev={lev} ref={m.mark} margin={margin} />
        </div>
      )}

      <dl className="mt-4 rounded-2xl bg-paper px-4 py-3 text-[0.8125rem] grid grid-cols-[1fr_auto] gap-y-1.5">
        <dt className="text-ink-3">Position size</dt>
        <dd className="font-mono text-right">{plan ? `${usd(plan.notional)}` : "—"}</dd>
        <dt className="text-ink-3">Entry (about)</dt>
        <dd className="font-mono text-right">{m ? px(m.mark) : "—"}</dd>
        <dt className="text-ink-3">Liquidation (about)</dt>
        <dd className="font-mono text-right text-danger">{plan && margin > 0 ? px(plan.liq) : "—"}</dd>
      </dl>

      {signedIn ? (
        <button
          type="button"
          disabled={!m || !!why || !!busy}
          onClick={() => void go()}
          className={"mt-3 w-full h-13 rounded-2xl font-bold text-[1rem] disabled:opacity-50 " + (side === "long" ? "bg-up text-on-accent" : "bg-danger text-white")}
        >
          {busy ?? `${side === "long" ? "Long" : "Short"} ${m?.coin ?? ""} ${lev}x`}
        </button>
      ) : (
        <div className="mt-3">
          <ConnectButton full />
        </div>
      )}
      {why && signedIn && <p className="mt-2 text-[0.8125rem] text-ink-2">{why}</p>}
      {!PERPS_TRADING && !signedIn && <p className="mt-2 text-[0.8125rem] text-ink-2">Trading opens at mainnet. Prices and charts are live.</p>}
      {msg && <p className={"mt-2 rounded-xl px-3 py-2 text-[0.875rem] " + (msg.ok ? "bg-emerald-soft" : "bg-warn-bg text-warn-ink")}>{msg.text}</p>}
      {msg?.ok && alertsOffer && <AlertsOffer onDone={hideOffer} />}
    </section>
  );
}

// ------------------------------------------------------------------ TP / SL

/** One TP or SL: a price, or a ROI % (the one typed last counts). */
type TpslInput = { px: string; pct: string; from: "px" | "pct" };
const EMPTY_TPSL: TpslInput = { px: "", pct: "", from: "px" };
/** +1 when this TP / SL sits above the price, −1 below. */
const tpslDir = (kind: "tp" | "sl", side: "long" | "short") => ((kind === "tp") === (side === "long") ? 1 : -1);
/**
 * The TP / SL price (0 when empty). The % is ROI: profit or loss on the money put in, like on
 * the big exchanges, so at 20x a 20% ROI is a 1% price move from `ref` (the entry).
 */
export function tpslPrice(v: TpslInput, kind: "tp" | "sl", side: "long" | "short", ref: number, lev: number): number {
  if (v.from === "pct") {
    const p = Number(v.pct);
    if (!v.pct || !Number.isFinite(p) || !(ref > 0) || !(lev > 0)) return 0;
    const x = ref * (1 + (tpslDir(kind, side) * p) / 100 / lev);
    return x > 0 ? Number(x.toPrecision(5)) : 0;
  }
  const x = Number(v.px);
  return Number.isFinite(x) && x > 0 ? x : 0;
}
/** Profit (or loss, negative) if the position closes at `exit`, after both trading fees. */
export function netAt(side: "long" | "short", coins: number, entry: number, exit: number): number {
  const rate = HL_TAKER_FEE + BUILDER_FEE;
  const gross = (side === "long" ? 1 : -1) * coins * (exit - entry);
  return gross - coins * entry * rate - coins * exit * rate;
}

/** One take profit or stop loss: price box, ROI % box, and what it would make or lose. */
function TpslRow({
  kind,
  v,
  set,
  side,
  m,
  coins,
  lev,
  ref,
  margin,
}: {
  kind: "tp" | "sl";
  v: TpslInput;
  set: (v: TpslInput) => void;
  side: "long" | "short";
  m: PerpMarket;
  coins: number;
  lev: number;
  /** the entry (or today's price for a new position) */
  ref: number;
  /** the money in the position, for ROI */
  margin: number;
}) {
  const price = tpslPrice(v, kind, side, ref, lev);
  const dec = priceDecimals(m);
  const shownPx = v.from === "px" ? v.px : price ? String(Number(price.toFixed(dec))) : "";
  // price move from the entry, in the position's favour (+) or against it (−)
  const move = price && ref > 0 ? tpslDir(kind, side) * (price / ref - 1) * 100 : null;
  const roiNow = move === null ? null : move * lev;
  // a price on the wrong side shows its real direction (the order button says what's wrong)
  const wrongSide = v.from === "px" && roiNow !== null && roiNow < 0;
  const shownPct = v.from === "pct" ? v.pct : roiNow === null ? "" : String(Math.round(Math.abs(roiNow) * 100) / 100);
  const sign = (kind === "tp") !== wrongSide ? "+" : "−";
  const net = price && coins > 0 ? netAt(side, coins, ref, price) : null;
  const priceMove = price && ref > 0 ? (price / ref - 1) * 100 : null;
  const name = kind === "tp" ? "Take profit" : "Stop loss";
  return (
    <div>
      <div className="flex items-center justify-between text-[0.75rem] mb-1">
        <span className="text-ink-3">{name}</span>
        {net !== null && (
          <span className="flex items-baseline gap-1" title="What you'd make or lose if it closes there, after fees">
            <span className="text-ink-3">PnL</span>
            <span className={"font-mono font-semibold " + (net >= 0 ? "text-up" : "text-danger")}>≈ {signedUsd(net)}</span>
          </span>
        )}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2">
        <input
          value={shownPx}
          onChange={(e) => set({ px: e.target.value.replace(/[^0-9.]/g, ""), pct: "", from: "px" })}
          inputMode="decimal"
          placeholder="Price"
          aria-label={`${name} price`}
          className="h-10 rounded-xl border border-line bg-paper px-3 text-[0.875rem] font-mono outline-none focus:border-ink-3 min-w-0"
        />
        <label className="h-10 rounded-xl border border-line bg-paper px-2.5 flex items-center focus-within:border-ink-3 min-w-0" title="ROI: profit or loss on the money you put in">
          <span className={"text-[0.875rem] " + (sign === "+" ? "text-up" : "text-danger")}>{sign}</span>
          <input
            value={shownPct}
            onChange={(e) => set({ px: "", pct: e.target.value.replace(/[^0-9.]/g, ""), from: "pct" })}
            inputMode="decimal"
            placeholder="0"
            aria-label={`${name} ROI percent`}
            className="flex-1 min-w-0 bg-transparent outline-none text-[0.875rem] font-mono text-right"
          />
          <span className="text-ink-3 text-[0.75rem] ml-1 whitespace-nowrap">% ROI</span>
        </label>
      </div>
      {priceMove !== null && (
        <div className="mt-1 text-[0.6875rem] text-ink-3 font-mono">
          Price {priceMove >= 0 ? "+" : "−"}
          {Math.abs(priceMove).toFixed(2)}% from {px(ref)}
        </div>
      )}
    </div>
  );
}

/** After a trade: one tap turns on a phone alert for TP / SL / liquidation. */
function AlertsOffer({ onDone }: { onDone: () => void }) {
  const w = useWallet();
  const { signedIn } = useAlerts();
  const [state, setState] = useState<"idle" | "busy" | "on" | "err">("idle");
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // already signed up and pushing to this phone: nothing to offer
    void checkPush().then((p) => alive && signedIn && p === "on" && onDone());
    return () => {
      alive = false;
    };
  }, [signedIn, onDone]);
  const go = async () => {
    setState("busy");
    setWhy(null);
    // asked right away, while the tap still counts (browsers only ask from a tap)
    const perm = typeof Notification !== "undefined" && Notification.permission === "default" ? Notification.requestPermission().catch(() => null) : null;
    try {
      await authedPost(w.signMessage, "perps/watch", {});
      await perm;
      const p = await enablePush();
      if (p === "ios-install") setWhy("On iPhone, add sasa to your Home Screen first (Share → Add to Home Screen) to get phone alerts. The 🔔 on the site works already.");
      else if (p === "denied" || p === "unsupported") setWhy("This browser blocks notifications, so alerts show under the 🔔 on the site.");
      setState("on");
    } catch (e) {
      setWhy(friendlyError(e));
      setState("err");
    }
  };
  if (state === "on")
    return <p className="mt-2 rounded-xl px-3 py-2 text-[0.8125rem] bg-paper text-ink-2">{why ?? "Alerts are on: you'll hear when a take profit, stop loss or liquidation closes a position."}</p>;
  return (
    <div className="mt-2 rounded-xl px-3 py-2 bg-paper flex items-center gap-3 text-[0.8125rem]">
      <span className="text-ink-2 min-w-0">{why ?? "Get a phone alert when TP, SL or liquidation closes this."}</span>
      <button type="button" disabled={state === "busy"} onClick={() => void go()} className="ml-auto shrink-0 h-8 px-3 rounded-lg bg-ink text-paper font-semibold disabled:opacity-50">
        {state === "busy" ? "…" : "Turn on"}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ positions

function Positions({
  account,
  orders,
  fills,
  markets,
  trade,
  signedIn,
}: {
  account: PerpAccount | null;
  orders: PerpOrder[];
  fills: PerpFill[];
  markets: PerpMarket[] | null;
  trade: PerpsTrade;
  signedIn: boolean;
}) {
  const [tab, setTab] = useState<"pos" | "orders" | "history">("pos");
  const [sheet, setSheet] = useState<{ kind: "tpsl" | "close"; coin: string } | null>(null);
  const sheetPos = sheet ? (account?.positions.find((x) => x.coin === sheet.coin) ?? null) : null;
  const sheetMarket = sheet ? (markets?.find((x) => x.coin === sheet.coin) ?? null) : null;
  // the position closed (TP, liquidation) or flipped while a sheet was open: the sheet goes
  const sheetSide = sheetPos?.side ?? null;
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  useEffect(() => {
    if (!sheet) return setSheetFor(null);
    if (account && !sheetPos) return setSheet(null);
    if (sheetSide && sheetFor && sheetFor !== sheetSide) return setSheet(null);
    if (sheetSide && !sheetFor) setSheetFor(sheetSide);
  }, [sheet, sheetPos, sheetSide, sheetFor, account]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const positions = account?.positions ?? [];
  const markOf = (c: string) => markets?.find((m) => m.coin === c)?.mark ?? null;
  const run = async (key: string, f: () => Promise<unknown>) => {
    setErr(null);
    setBusy(key);
    try {
      await f();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };
  const tabs: [typeof tab, string][] = [
    ["pos", `Positions${positions.length ? ` (${positions.length})` : ""}`],
    ["orders", `TP/SL & orders${orders.length ? ` (${orders.length})` : ""}`],
    ["history", "History"],
  ];
  return (
    <section className="rounded-3xl border border-line bg-surface p-3 sm:p-4 min-w-0" aria-label="Your positions">
      {sheet && sheetPos && sheetMarket && sheet.kind === "close" && (
        <CloseSheet p={sheetPos} m={sheetMarket} trade={trade} onClose={() => setSheet(null)} />
      )}
      {sheet && sheetPos && sheetMarket && sheet.kind === "tpsl" && (
        <TpslSheet p={sheetPos} m={sheetMarket} orders={orders} trade={trade} onClose={() => setSheet(null)} />
      )}
      <div className="flex gap-1 overflow-x-auto no-scrollbar" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={"h-8 px-3 rounded-lg text-[0.8125rem] font-semibold shrink-0 " + (tab === k ? "bg-ink text-mist" : "text-ink-2")}>
            {label}
          </button>
        ))}
      </div>
      {err && <p className="mt-2 rounded-xl px-3 py-2 text-[0.8125rem] bg-warn-bg text-warn-ink">{err}</p>}
      {!signedIn ? (
        <p className="mt-4 text-[0.875rem] text-ink-3 text-center py-4">Log in to see your positions.</p>
      ) : tab === "pos" ? (
        positions.length === 0 ? (
          <p className="mt-4 text-[0.875rem] text-ink-3 text-center py-4">No open positions.</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y divide-line">
            {positions.map((p) => (
              <li key={p.coin} className="py-3 grid grid-cols-2 sm:grid-cols-[minmax(0,1.2fr)_repeat(4,minmax(0,1fr))_auto] gap-x-3 gap-y-1.5 items-center text-[0.8125rem]">
                <div className="min-w-0">
                  <div className="font-semibold text-[0.9375rem]">
                    {p.coin} <span className={p.side === "long" ? "text-up" : "text-danger"}>{p.side === "long" ? "Long" : "Short"} {p.lev}x</span>
                  </div>
                  <div className="text-ink-3 font-mono">{Math.abs(p.size)} {p.coin}</div>
                </div>
                <Cell k="Value" v={usd(p.value)} />
                <Cell k="Entry / mark" v={`${px(p.entry)} / ${px(markOf(p.coin))}`} />
                <Cell k="Liquidation" v={px(p.liq)} cls="text-danger" />
                <Cell k="Profit" v={`${signedUsd(p.pnl)} (${pct(p.roe, 1)})`} cls={tone(p.pnl)} />
                <div className="col-span-2 sm:col-span-1 grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => setSheet({ kind: "tpsl", coin: p.coin })}
                    className="h-9 px-3 rounded-xl border border-line font-semibold hover:border-ink-3 disabled:opacity-50"
                  >
                    TP/SL
                  </button>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => setSheet({ kind: "close", coin: p.coin })}
                    className="h-9 px-3 rounded-xl border border-line font-semibold hover:border-danger hover:text-danger disabled:opacity-50"
                  >
                    Close
                  </button>
                </div>
                {(() => {
                  const own = orders.filter((o) => o.coin === p.coin && o.triggerPx);
                  const tp = own.find((o) => o.tpsl === "tp");
                  const sl = own.find((o) => o.tpsl === "sl");
                  if (!tp && !sl) return null;
                  return (
                    <div className="col-span-2 sm:col-span-6 text-[0.75rem] text-ink-3 flex gap-3">
                      {tp && <span>TP <b className="text-up font-mono">{px(tp.triggerPx)}</b></span>}
                      {sl && <span>SL <b className="text-[#f59e0b] font-mono">{px(sl.triggerPx)}</b></span>}
                    </div>
                  );
                })()}
              </li>
            ))}
          </ul>
        )
      ) : tab === "orders" ? (
        orders.length === 0 ? (
          <p className="mt-4 text-[0.875rem] text-ink-3 text-center py-4">No open orders.</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y divide-line">
            {orders.map((o) => (
              <li key={o.oid} className="py-2.5 flex items-center justify-between gap-3 text-[0.8125rem]">
                <span className="min-w-0">
                  <b className="font-semibold">{o.coin}</b> {o.tpsl === "tp" ? "Take profit" : o.tpsl === "sl" ? "Stop loss" : o.type}
                  {o.triggerPx ? ` at ${px(o.triggerPx)}` : ""}
                </span>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void run(`cancel:${o.oid}`, () => trade.cancel(o, markets?.find((m) => m.coin === o.coin) ?? null))}
                  className="shrink-0 h-8 px-3 rounded-lg border border-line text-ink-2 hover:border-danger hover:text-danger disabled:opacity-50"
                >
                  {busy === `cancel:${o.oid}` ? "…" : "Cancel"}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : fills.length === 0 ? (
        <p className="mt-4 text-[0.875rem] text-ink-3 text-center py-4">No trades yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-line">
          {fills.map((f) => (
            <li key={`${f.hash}:${f.tid}:${f.time}:${f.px}`} className="py-2 grid grid-cols-[minmax(0,1fr)_auto] gap-2 text-[0.8125rem]">
              <span className="min-w-0 truncate">
                <b className="font-semibold">{f.coin}</b> {f.dir} · {f.sz} at {px(f.px)}
                <span className="block text-ink-3 text-[0.75rem]">{new Date(f.time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              </span>
              <span className={"font-mono text-right " + tone(f.pnl)}>{f.pnl ? signedUsd(f.pnl) : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Close all of a position or a part of it. */
function CloseSheet({ p, m, trade, onClose }: { p: PerpPosition; m: PerpMarket; trade: PerpsTrade; onClose: () => void }) {
  const [part, setPart] = useState(100);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const f = part / 100;
  const value = Math.abs(p.size) * m.mark * f;
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await trade.close(p, m, f);
      onClose();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={`Close ${p.coin} ${p.side === "long" ? "long" : "short"}`} onClose={onClose}>
      <div className="flex flex-col gap-4 pb-2">
        <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="How much to close">
          {[25, 50, 75, 100].map((x) => (
            <button
              key={x}
              type="button"
              aria-pressed={part === x}
              onClick={() => setPart(x)}
              className={"h-11 rounded-xl border font-bold text-[0.9375rem] " + (part === x ? "border-ink bg-ink text-paper" : "border-line text-ink-2")}
            >
              {x === 100 ? "All" : `${x}%`}
            </button>
          ))}
        </div>
        <dl className="rounded-2xl bg-paper px-4 py-3 text-[0.875rem] grid grid-cols-[1fr_auto] gap-y-1.5">
          <dt className="text-ink-3">Closing</dt>
          <dd className="font-mono text-right">
            {sizeString(Math.abs(p.size) * f, m.szDecimals)} {p.coin} · {usd(value)}
          </dd>
          <dt className="text-ink-3">At about</dt>
          <dd className="font-mono text-right">{px(m.mark)}</dd>
          <dt className="text-ink-3">Profit on this part</dt>
          <dd className={"font-mono text-right font-semibold " + tone(p.pnl)}>≈ {signedUsd(p.pnl * f)}</dd>
          {part < 100 && (
            <>
              <dt className="text-ink-3">Left open</dt>
              <dd className="font-mono text-right">{usd(Math.abs(p.size) * m.mark * (1 - f))}</dd>
            </>
          )}
        </dl>
        <button type="button" disabled={busy} onClick={() => void go()} className="h-12 rounded-full bg-ink text-paper font-bold disabled:opacity-50">
          {busy ? "Closing…" : part === 100 ? `Close all ${p.coin}` : `Close ${part}%`}
        </button>
        {err && <p className="rounded-xl px-3 py-2 text-[0.875rem] bg-warn-bg text-warn-ink">{err}</p>}
      </div>
    </Sheet>
  );
}

/** Change, add or remove the take profit and stop loss of an open position. */
function TpslSheet({ p, m, orders, trade, onClose }: { p: PerpPosition; m: PerpMarket; orders: PerpOrder[]; trade: PerpsTrade; onClose: () => void }) {
  const own = orders.filter((o) => o.coin === p.coin);
  const tpNow = own.find((o) => o.tpsl === "tp")?.triggerPx ?? null;
  const slNow = own.find((o) => o.tpsl === "sl")?.triggerPx ?? null;
  const [tp, setTp] = useState<TpslInput>({ px: tpNow ? String(tpNow) : "", pct: "", from: "px" });
  const [sl, setSl] = useState<TpslInput>({ px: slNow ? String(slNow) : "", pct: "", from: "px" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const coins = Math.abs(p.size);
  const tpN = tpslPrice(tp, "tp", p.side, p.entry, p.lev);
  const slN = tpslPrice(sl, "sl", p.side, p.entry, p.lev);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await trade.setTpsl(p, m, { tp: tpN || null, sl: slN || null }, orders);
      onClose();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={`TP/SL · ${p.coin} ${p.side === "long" ? "long" : "short"} ${p.lev}x`} onClose={onClose}>
      <div className="flex flex-col gap-4 pb-2">
        <div className="grid grid-cols-3 gap-2 text-[0.75rem]">
          <Cell k="Entry" v={px(p.entry)} />
          <Cell k="Now" v={px(m.mark)} />
          <Cell k="Liquidation" v={px(p.liq)} cls="text-danger" />
        </div>
        <TpslRow kind="tp" v={tp} set={setTp} side={p.side} m={m} coins={coins} lev={p.lev} ref={p.entry} margin={p.margin} />
        <TpslRow kind="sl" v={sl} set={setSl} side={p.side} m={m} coins={coins} lev={p.lev} ref={p.entry} margin={p.margin} />
        <p className="text-[0.75rem] text-ink-3">ROI is counted from your entry. Leave a box empty to remove it.</p>
        <button type="button" disabled={busy} onClick={() => void go()} className="h-12 rounded-full bg-ink text-paper font-bold disabled:opacity-50">
          {busy ? "Saving…" : "Save"}
        </button>
        {err && <p className="rounded-xl px-3 py-2 text-[0.875rem] bg-warn-bg text-warn-ink">{err}</p>}
      </div>
    </Sheet>
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
