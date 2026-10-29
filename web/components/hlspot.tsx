"use client";

/**
 * Coins from Hyperliquid's own spot market (HYPE, KNTQ, PURR…) that the Market list shows as ordinary
 * rows: bought and sold with dollars through the user's trading balance (lib/hlspot.ts).
 */
import { useCallback, useEffect, useState } from "react";
import { ConnectButton, Sheet } from "./chrome";
import { useWallet } from "./wallet";
import { compactUsd, friendlyError } from "@/lib/format";
import { fmtPrice } from "@/lib/race";
import { showToast } from "@/lib/toast";
import { hlSpotBalances, SPOT_MIN, type HlSpot } from "@/lib/hlspot";
import { PERPS_TRADING, geoExempt, perpsAllowedHere } from "@/lib/perps";
import { usePerpsTrade } from "@/lib/perpstrade";
import { PerpsChart } from "./perpschart";

const pct = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
const tone = (v: number | null) => (v === null ? "text-ink-3" : v >= 0 ? "text-up" : "text-danger");

/**
 * Trading Hyperliquid spot coins from the Market list: the user's holdings, whether trading is
 * allowed here, and the buy/sell actions. The page shows SpotSheet for the coin picked.
 */
export function useSpotDesk() {
  const w = useWallet();
  const [bal, setBal] = useState<Map<string, number>>(new Map());
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const loadBal = useCallback(async () => {
    if (!w.address) return setBal(new Map());
    setBal(await hlSpotBalances(w.address).catch(() => new Map()));
  }, [w.address]);
  useEffect(() => {
    void loadBal();
    const t = setInterval(() => document.visibilityState === "visible" && void loadBal(), 20_000);
    return () => clearInterval(t);
  }, [loadBal]);
  useEffect(() => {
    void perpsAllowedHere().then(setAllowed);
  }, []);
  const trade = usePerpsTrade(loadBal);
  return {
    bal,
    trade,
    canTrade: PERPS_TRADING && (allowed || geoExempt(w.address)),
    blocked: allowed === false && !geoExempt(w.address),
  };
}

type TradeProps = { m: HlSpot; have: number; canTrade: boolean; blocked: boolean; trade: ReturnType<typeof usePerpsTrade> };

/** Buy / sell box for one coin: in the sheet on the Market list and on the coin's own page. */
export function SpotTrade({ m, have, canTrade, blocked, trade, onDone }: TradeProps & { onDone?: () => void }) {
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
        showToast({ kind: "buy", title: `Bought ${r.amount.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${m.token}`, body: `For about $${n}. It's in your trading balance.` });
      } else {
        const r = await trade.spotSell(m, sellAmt, setStep);
        showToast({ kind: "sell", title: `Sold ${m.token}${r.usd ? ` for about $${r.usd.toFixed(2)}` : ""}`, body: "The dollars are in your trading balance." });
      }
      onDone?.();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  return (
      <div className="flex flex-col gap-4">
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
        {side === "sell" && sellAmt * m.price < SPOT_MIN && <p className="text-[0.8125rem] text-warn-ink">The smallest sell is ${SPOT_MIN}.</p>}
        {blocked && <p className="text-[0.8125rem] text-warn-ink">This coin can&apos;t be traded from your region.</p>}
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
        <p className="text-[0.75rem] text-ink-3 text-center">Paid with USDC from your balance. Prices can move fast.</p>
      </div>
  );
}

/** A chart's price decimals for a spot coin. */
export const spotDecimals = (m: HlSpot) => Math.min(Math.max(0, 8 - m.szDecimals), Math.max(2, 4 - Math.floor(Math.log10(m.price))));

export function SpotSheet({ onClose, ...p }: TradeProps & { onClose: () => void }) {
  const { m } = p;
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
        <PerpsChart coin={m.coin} decimals={spotDecimals(m)} height={260} />
        <SpotTrade {...p} onDone={onClose} />
      </div>
    </Sheet>
  );
}
