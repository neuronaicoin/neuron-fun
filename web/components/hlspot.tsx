"use client";

/**
 * The Market page's "Hyperliquid" tab: every token on Hyperliquid's own spot market (HYPE, KNTQ,
 * PURR…), bought and sold with dollars through the user's Hyperliquid account (lib/hlspot.ts).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Skeleton } from "./coins";
import { ConnectButton, Sheet } from "./chrome";
import { useWallet } from "./wallet";
import { compactUsd, friendlyError } from "@/lib/format";
import { fmtPrice } from "@/lib/race";
import { showToast } from "@/lib/toast";
import { fetchHlSpot, hlSpotBalances, SPOT_MIN, type HlSpot } from "@/lib/hlspot";
import { PERPS_TRADING, geoExempt, perpsAllowedHere } from "@/lib/perps";
import { usePerpsTrade } from "@/lib/perpstrade";

const pct = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
const tone = (v: number | null) => (v === null ? "text-ink-3" : v >= 0 ? "text-up" : "text-danger");
type Sort = "volume" | "gainers" | "losers" | "mcap";

export function HlSpotList({ q }: { q: string }) {
  const w = useWallet();
  const [list, setList] = useState<HlSpot[] | null>(null);
  const [error, setError] = useState(false);
  const [sort, setSort] = useState<Sort>("volume");
  const [bal, setBal] = useState<Map<string, number>>(new Map());
  const [pick, setPick] = useState<HlSpot | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await fetchHlSpot());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  const loadBal = useCallback(async () => {
    if (!w.address) return setBal(new Map());
    setBal(await hlSpotBalances(w.address).catch(() => new Map()));
  }, [w.address]);
  useEffect(() => {
    void load();
    void loadBal();
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load();
      void loadBal();
    }, 20_000);
    return () => clearInterval(t);
  }, [load, loadBal]);
  useEffect(() => {
    void perpsAllowedHere().then(setAllowed);
  }, []);
  // a shared link (?src=hl&c=KNTQ) opens that token
  useEffect(() => {
    if (!list || pick) return;
    const c = new URLSearchParams(window.location.search).get("c")?.toUpperCase();
    if (c) setPick(list.find((m) => m.token.toUpperCase() === c) ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  const after = useCallback(async () => {
    await Promise.all([load(), loadBal()]);
  }, [load, loadBal]);
  const trade = usePerpsTrade(after);

  const rows = useMemo(() => {
    if (!list) return null;
    const s = q.trim().toLowerCase();
    const hit = s ? list.filter((m) => m.name.toLowerCase().includes(s) || m.token.toLowerCase().includes(s)) : list.slice();
    const num = (v: number | null, desc: boolean) => (v === null ? (desc ? -Infinity : Infinity) : v);
    if (sort === "gainers") return hit.sort((a, b) => num(b.change24h, true) - num(a.change24h, true));
    if (sort === "losers") return hit.sort((a, b) => num(a.change24h, false) - num(b.change24h, false));
    if (sort === "mcap") return hit.sort((a, b) => num(b.mcap, true) - num(a.mcap, true));
    return hit.sort((a, b) => b.vol24h - a.vol24h);
  }, [list, sort, q]);

  const held = rows?.filter((m) => (bal.get(m.token) ?? 0) * m.price >= 0.5) ?? [];
  const canTrade = PERPS_TRADING && (allowed || geoExempt(w.address));

  return (
    <>
      <div className="mt-3 flex gap-1 overflow-x-auto no-scrollbar" role="tablist" aria-label="Sort">
        {(
          [
            ["volume", "Volume"],
            ["gainers", "Gainers"],
            ["losers", "Losers"],
            ["mcap", "Market cap"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={sort === id}
            onClick={() => setSort(id)}
            className={"h-9 px-3.5 rounded-lg text-[0.875rem] font-semibold shrink-0 " + (sort === id ? "bg-ink text-mist" : "text-ink-2 hover:text-ink")}
          >
            {label}
          </button>
        ))}
      </div>

      {held.length > 0 && (
        <div className="mt-3 rounded-2xl border border-line bg-surface p-3">
          <div className="text-[0.8125rem] text-ink-3 mb-2">You hold</div>
          <div className="flex flex-wrap gap-2">
            {held.map((m) => (
              <button key={m.coin} type="button" onClick={() => setPick(m)} className="h-9 px-3 rounded-xl border border-line text-[0.875rem] font-semibold hover:border-emerald/60">
                {m.token} · {compactUsd((bal.get(m.token) ?? 0) * m.price)}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && !list && <p className="mt-6 text-danger">Couldn&apos;t load Hyperliquid. Try again in a moment.</p>}
      <div className="mt-3 rounded-3xl border border-line bg-surface overflow-hidden">
        <div className="hidden sm:grid grid-cols-[minmax(0,1fr)_7rem_5rem_7rem_7rem] gap-3 px-4 py-2.5 text-[0.75rem] text-ink-3 border-b border-line">
          <span>Token</span>
          <span className="text-right">Price</span>
          <span className="text-right">24h</span>
          <span className="text-right">Volume 24h</span>
          <span className="text-right">Market cap</span>
        </div>
        {rows === null ? (
          <div className="p-4 flex flex-col gap-2">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="p-6 text-center text-ink-3">{q ? "No token by that name on Hyperliquid." : "Nothing trading right now."}</p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((m) => (
              <li key={m.coin}>
                <button type="button" onClick={() => setPick(m)} className="w-full text-left grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_7rem_5rem_7rem_7rem] gap-3 items-center px-4 py-3 hover:bg-paper">
                  <span className="min-w-0">
                    <span className="block font-semibold text-[0.9375rem] truncate">{m.token}</span>
                    {m.name !== m.token && <span className="block text-[0.75rem] text-ink-3 truncate">{m.name}</span>}
                  </span>
                  <span className="text-right sm:contents">
                    <span className="block sm:text-right font-mono text-[0.875rem] tabular-nums">{fmtPrice(m.price)}</span>
                    <span className={"block sm:text-right font-mono text-[0.8125rem] tabular-nums " + tone(m.change24h)}>{pct(m.change24h)}</span>
                    <span className="hidden sm:block text-right font-mono text-[0.8125rem] tabular-nums">{compactUsd(m.vol24h)}</span>
                    <span className="hidden sm:block text-right font-mono text-[0.8125rem] tabular-nums">{m.mcap ? compactUsd(m.mcap) : "—"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-3 text-[0.75rem] text-ink-3">Hyperliquid&apos;s own spot market, live from Hyperliquid. Bought and sold with your dollars through your Hyperliquid balance, the same one as Futures.</p>

      {pick && <SpotSheet m={pick} have={bal.get(pick.token) ?? 0} canTrade={canTrade} blocked={allowed === false && !geoExempt(w.address)} trade={trade} onClose={() => setPick(null)} />}
    </>
  );
}

function SpotSheet({ m, have, canTrade, blocked, trade, onClose }: { m: HlSpot; have: number; canTrade: boolean; blocked: boolean; trade: ReturnType<typeof usePerpsTrade>; onClose: () => void }) {
  const w = useWallet();
  const [side, setSide] = useState<"buy" | "sell">(have * m.price >= SPOT_MIN ? "sell" : "buy");
  const [amount, setAmount] = useState("25");
  const [part, setPart] = useState(1);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const n = Number(amount);
  const sellAmt = have * part;

  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (side === "buy") {
        const r = await trade.spotBuy(m, n, setStep);
        showToast({ kind: "buy", title: `Bought ${r.amount.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${m.token}`, body: `For about $${n}. It's in your Hyperliquid balance.` });
      } else {
        const r = await trade.spotSell(m, sellAmt, setStep);
        showToast({ kind: "sell", title: `Sold ${m.token}${r.usd ? ` for about $${r.usd.toFixed(2)}` : ""}`, body: "The dollars are in your Hyperliquid balance." });
      }
      onClose();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  return (
    <Sheet title={m.token} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <div className="font-display font-bold text-[1.5rem]">{fmtPrice(m.price)}</div>
            <div className={"text-[0.875rem] font-semibold " + tone(m.change24h)}>{pct(m.change24h)} today</div>
          </div>
          <div className="text-right text-[0.8125rem] text-ink-3">
            <div>Volume {compactUsd(m.vol24h)}</div>
            {m.mcap && <div>Market cap {compactUsd(m.mcap)}</div>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(["buy", "sell"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={side === s}
              onClick={() => setSide(s)}
              className={"h-11 rounded-xl font-bold " + (side === s ? (s === "buy" ? "bg-up text-white" : "bg-danger text-white") : "border border-line text-ink-2")}
            >
              {s === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
        {side === "buy" ? (
          <div className="flex flex-col gap-1.5">
            <div className="grid grid-cols-4 gap-2">
              {["10", "25", "50", "100"].map((v) => (
                <button key={v} type="button" onClick={() => setAmount(v)} aria-pressed={amount === v} className={"h-11 rounded-xl border font-semibold " + (amount === v ? "border-ink ring-1 ring-ink" : "border-line text-ink-2")}>
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
                className="w-full h-12 rounded-xl border border-line bg-paper pl-8 pr-4 outline-none focus:border-ink-3"
              />
            </label>
            {n > 0 && <div className="text-[0.875rem] text-ink-2">You get about {(n / m.price).toLocaleString("en-US", { maximumFractionDigits: 4 })} {m.token}</div>}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="text-[0.875rem] text-ink-2">
              You have {have.toLocaleString("en-US", { maximumFractionDigits: 4 })} {m.token} (about {compactUsd(have * m.price)})
            </div>
            <div className="grid grid-cols-4 gap-2">
              {[0.25, 0.5, 0.75, 1].map((f) => (
                <button key={f} type="button" onClick={() => setPart(f)} aria-pressed={part === f} className={"h-11 rounded-xl border font-semibold " + (part === f ? "border-ink ring-1 ring-ink" : "border-line text-ink-2")}>
                  {f === 1 ? "All" : `${f * 100}%`}
                </button>
              ))}
            </div>
          </div>
        )}
        {side === "buy" && n > 0 && n < SPOT_MIN && <p className="text-[0.8125rem] text-warn-ink">The smallest buy is ${SPOT_MIN}.</p>}
        {side === "sell" && sellAmt * m.price < SPOT_MIN && <p className="text-[0.8125rem] text-warn-ink">Hyperliquid&apos;s smallest order is ${SPOT_MIN}.</p>}
        {blocked && <p className="text-[0.8125rem] text-warn-ink">Hyperliquid trading isn&apos;t available in your region.</p>}
        {err && <p className="text-[0.8125rem] text-danger">{err}</p>}
        {!w.address ? (
          <ConnectButton full />
        ) : (
          <button
            type="button"
            disabled={busy || !canTrade || (side === "buy" ? !(n >= SPOT_MIN) : sellAmt * m.price < SPOT_MIN)}
            onClick={() => void go()}
            className={"h-13 min-h-[3.25rem] rounded-full font-bold text-[1.0625rem] text-white disabled:opacity-50 " + (side === "buy" ? "bg-up" : "bg-danger")}
          >
            {busy ? (step ?? "Working…") : side === "buy" ? `Buy ${m.token} for $${n > 0 ? n : 0}` : `Sell ${part === 1 ? "all" : `${part * 100}%`} ${m.token}`}
          </button>
        )}
        <p className="text-[0.75rem] text-ink-3 text-center">Paid from your balance (moved to Hyperliquid if needed). Prices can move fast.</p>
      </div>
    </Sheet>
  );
}
