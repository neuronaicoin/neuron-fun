"use client";

/**
 * Buying and selling a Solana coin with USDC (only for people who see Solana: lib/solana.ts).
 *
 *   Buy   the user's USDC on Base → the coin, delivered to their Solana wallet (one Base step
 *         through Relay; email accounts pay its network fee in USDC). A wallet with almost no
 *         SOL gets a little with it, so it can pay the network fee of a later sale.
 *   Sell  the coin → USDC in Cash (the Solana wallet signs; Relay delivers the USDC on Base).
 *
 * The user only sees dollars and the coin.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { useWallet } from "./wallet";
import { useSolSigner } from "./usesolsigner";
import { toast } from "./alerts";
import { usdcAbi } from "@/lib/abis";
import { CHAINS } from "@/lib/config";
import { clientFor } from "@/lib/data";
import { quoteCalls } from "@/lib/extswap";
import { friendlyError } from "@/lib/format";
import { afterTrade } from "@/lib/portfolio";
import { getQuote, requestStatus, type Quote } from "@/lib/relay";
import { SOLANA_ID, SOL_NATIVE } from "@/lib/solana";
import type { ExtCoin } from "@/lib/extcoins";
import { IS_TESTNET } from "@/lib/config";
import { solanaFor } from "@/lib/solana";
import { solInflight, solIsInflight } from "@/lib/solheld";

const BASE = CHAINS.find((c) => c.key === "base")!;
const FEE = 0.01;
/**
 * A sale needs a little SOL in the Solana wallet for its network fee: very little on a coin's
 * launch curve, more through a route (it opens token accounts, about 0.002 SOL each). A sale
 * tops the wallet up from Cash by itself when it's short (nothing for the user to do); a buy
 * never adds any (the user pays only what they asked to spend).
 */
const SOL_FOR_CURVE_SALE = 2_000_000n; // 0.002 SOL
const SOL_FOR_ROUTE_SALE = 6_000_000n; // 0.006 SOL
/** Dollars shown in messages. */
const usdText = (raw: bigint) => `$${(Number(raw) / 1e6).toFixed(2)}`;
const fmt = (t: number) =>
  t >= 1e9 ? `${(t / 1e9).toFixed(2)}B` : t >= 1e6 ? `${(t / 1e6).toFixed(2)}M` : t >= 1e3 ? `${(t / 1e3).toFixed(1)}K` : t >= 1 || t <= 0 ? t.toFixed(2) : String(Number(t.toPrecision(3)));

export function SolanaTradeBox({ coin }: { coin: ExtCoin }) {
  const w = useWallet();
  const sol = useSolSigner();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [usd, setUsd] = useState("25");
  const [pct, setPct] = useState(100);
  const [held, setHeld] = useState<bigint | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // one trade at a time: locked before anything is awaited (a double tap can't send two)
  const lock = useRef(false);
  const amount = Number(usd.replace(",", ".")) || 0;
  const mint = coin.address;
  // sasa's own-fee coins (lib/soldbc.ts): the trading fee right now, shown before anyone trades
  // (it's read from the coin's own on-chain settings; counted down here every second)
  const [ownPool, setOwnPool] = useState<import("@/lib/soldbc").DbcPool | null>(null);
  const [ownFee, setOwnFee] = useState<{ bps: number; nextBps: number | null; inSec: number | null } | null>(null);
  useEffect(() => {
    let alive = true;
    setOwnPool(null);
    // only Meteora coins can be one (sasa's own-fee coins are listed as "meteora"): every other
    // coin page skips the extra libraries and lookups
    if (coin.dex && !/meteora/i.test(coin.dex)) return;
    void import("@/lib/soldbc").then(async (D) => {
      const pool = await D.dbcActive(mint);
      if (alive) setOwnPool(pool);
    });
    return () => {
      alive = false;
    };
  }, [mint, coin.dex]);
  useEffect(() => {
    if (!ownPool) return setOwnFee(null);
    let alive = true;
    const tick = () =>
      void import("@/lib/soldbc").then((D) => {
        if (alive) setOwnFee(D.dbcFeeAt(ownPool, Math.floor(Date.now() / 1000)));
      });
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [ownPool]);
  const feeShare = ownFee ? ownFee.bps / 10_000 : FEE;
  const estimate = coin.priceUsd ? (amount * (1 - feeShare)) / coin.priceUsd : null;

  const loadHeld = useCallback(async () => {
    if (!sol.address) return setHeld(null);
    const { solTokenBalance } = await import("@/lib/solrelay");
    setHeld(await solTokenBalance(sol.address, mint).catch(() => 0n));
  }, [sol.address, mint]);
  useEffect(() => {
    void loadHeld();
  }, [loadHeld]);

  const raw = side === "buy" ? BigInt(Math.floor(amount * 1e6)) : held !== null ? (held * BigInt(pct)) / 100n : 0n;
  // the price shown (a buy is priced once the Solana wallet's address is known)
  useEffect(() => {
    setQuote(null);
    setError("");
    if (!w.address || !sol.address || raw <= 0n) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      const q =
        side === "buy"
          ? getQuote(
              { user: w.address!, recipient: sol.address!, originChainId: BASE.chain.id, originCurrency: BASE.usdc, destinationChainId: SOLANA_ID, destinationCurrency: mint, amount: raw.toString(), fee: "swap" },
              ctrl.signal
            )
          : getQuote(
              { user: sol.address!, recipient: w.address!, originChainId: SOLANA_ID, originCurrency: mint, destinationChainId: BASE.chain.id, destinationCurrency: BASE.usdc, amount: raw.toString(), fee: "swap" },
              ctrl.signal
            );
      // only a preview: when it can't be priced the estimate shows instead (a coin on its launch
      // curve is traded on the curve itself, which a route can't always price)
      q.then(setQuote).catch(() => {});
    }, 400);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.address, sol.address, side, raw.toString(), mint]);

  async function buy() {
    if (!w.address || raw <= 0n) return;
    const s = await sol.get();
    setBusy("Getting the price…");
    const L = await import("@/lib/sollaunch");
    // still on its launch curve (every coin launched on sasa at first): the dollars arrive as
    // SOL, then the coin is bought on the curve itself (no route in between that could refuse it)
    const D = await import("@/lib/soldbc");
    // the standard launch curve, or one of sasa's own-fee coins: both bought straight with SOL
    const pump = await L.onCurve(mint);
    const own = !pump && !!(await D.dbcActive(mint));
    const curve = pump || own;
    const q = await getQuote({
      user: w.address,
      recipient: s.address,
      originChainId: BASE.chain.id,
      originCurrency: BASE.usdc,
      destinationChainId: SOLANA_ID,
      destinationCurrency: curve ? SOL_NATIVE : mint,
      amount: raw.toString(),
      fee: "swap",
    });
    const solBefore = curve ? await L.solBalance(s.address).catch(() => 0n) : 0n;
    // SOL is about to arrive for this buy: the "back to Cash" helper leaves it alone meanwhile
    if (curve) solInflight(true);
    const calls = quoteCalls(q, BASE);
    const need = BigInt(q.inRaw || "0") > raw ? BigInt(q.inRaw || "0") : raw;
    const cash = (await clientFor(BASE).readContract({ address: BASE.usdc, abi: usdcAbi, functionName: "balanceOf", args: [w.address as Address] })) as bigint;
    const room = w.embedded ? 50_000n : 0n; // email accounts pay Base's network fee from the same dollars
    if (cash < need + room) throw new Error(`This buy needs ${usdText(need + room)} in your Cash, fees included. Lower the amount or add money.`);
    setBusy("Buying…");
    await w.send(BASE.chain, calls, (m) => setBusy(m));
    if (curve) {
      // wait for the SOL, then buy on the curve with it (a little stays for network fees)
      const want = BigInt(q.outRaw || "0");
      let bal = solBefore;
      for (let i = 0; i < 60 && alive.current; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        bal = await L.solBalance(s.address).catch(() => bal);
        if (bal >= solBefore + (want * 95n) / 100n) break;
      }
      // only the SOL that arrived for this buy is spent (never the wallet's own), and a little
      // stays for the network fee and the coin's account
      const arrived = bal - solBefore;
      if (arrived < (want * 95n) / 100n)
        throw new Error("Your dollars are still on their way. They'll show in your Solana wallet in a moment; try the buy again then.");
      const room = bal - 3_000_000n;
      const spend = [arrived, want, room].reduce((a, b) => (b < a ? b : a));
      if (spend <= 0n) throw new Error("That amount is too small to buy.");
      if (own) await D.dbcBuy(s, mint, spend, (m) => setBusy(m));
      else await L.curveBuy(s, mint, spend, (m) => setBusy(m));
      afterTrade();
      toast(`Bought $${coin.symbol} ✓`);
      return;
    }
    afterTrade();
    toast(`Buying $${coin.symbol}: arriving in a few seconds ✓`);
    // watch it arrive
    if (q.requestId)
      for (let i = 0; i < 30 && alive.current; i++) {
        const st = await requestStatus(q.requestId).catch(() => "waiting" as const);
        if (st === "success") break;
        if (st === "failure" || st === "refund") throw new Error("The buy didn't go through. Your USDC went back to your Cash.");
        await new Promise((r) => setTimeout(r, 2000));
      }
    // the coin has landed (or is about to): the balance and "Your coins" pick it up now
    afterTrade();
  }

  /** Tops the Solana wallet up from Cash when it has less than `floor` SOL, and waits for it. */
  async function ensureSol(solAddress: string, floor: bigint) {
    const { solBalance } = await import("@/lib/sollaunch");
    const bal = await solBalance(solAddress).catch(() => 0n);
    if (bal >= floor) return;
    setBusy("Getting the network fee ready…");
    const gas = await getQuote({
      user: w.address!,
      recipient: solAddress,
      originChainId: BASE.chain.id,
      originCurrency: BASE.usdc,
      destinationChainId: SOLANA_ID,
      destinationCurrency: SOL_NATIVE,
      // never a tiny amount (routes have a minimum)
      amount: (floor + 2_000_000n - bal > 4_000_000n ? floor + 2_000_000n - bal : 4_000_000n).toString(),
      tradeType: "EXACT_OUTPUT",
      fee: "deposit",
    });
    const cash = (await clientFor(BASE).readContract({ address: BASE.usdc, abi: usdcAbi, functionName: "balanceOf", args: [w.address as Address] })) as bigint;
    const fee = BigInt(gas.inRaw || "0") + (w.embedded ? 50_000n : 0n);
    if (cash < fee) throw new Error(`This sale needs ${usdText(fee)} in your Cash for Solana's network fee. Add a little and try again.`);
    await w.send(BASE.chain, quoteCalls(gas, BASE), (m) => setBusy(m));
    setBusy("Getting the network fee ready…");
    for (let i = 0; i < 45 && alive.current; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if ((await solBalance(solAddress).catch(() => 0n)) >= floor) return;
    }
    throw new Error("The network fee is still on its way. Try the sale again in a minute.");
  }

  async function sell() {
    if (!w.address || raw <= 0n) return;
    const s = await sol.get();
    const L = await import("@/lib/sollaunch");
    const D = await import("@/lib/soldbc");
    const pump = await L.onCurve(mint);
    const own = !pump && !!(await D.dbcActive(mint));
    const curve = pump || own;
    // an own-fee sale opens a SOL account for the proceeds: a little more room than the standard curve
    await ensureSol(s.address, own ? SOL_FOR_ROUTE_SALE : curve ? SOL_FOR_CURVE_SALE : SOL_FOR_ROUTE_SALE);
    setBusy("Getting the price…");
    if (curve) {
      // on its launch curve: sold on the curve for SOL, then the SOL goes to Cash as USDC
      const proceeds = own ? await D.dbcSell(s, mint, raw, (m) => setBusy(m)) : await L.curveSell(s, mint, raw, (m) => setBusy(m));
      // sold: done for the user now; the dollars move to Cash in the background
      toast(`Sold $${coin.symbol} ✓ Your dollars arrive in Cash in a few seconds.`);
      const evm = w.address;
      void import("@/lib/solrelay")
        .then(({ solToCash }) => solToCash(s, evm, undefined, w.embedded ? undefined : proceeds))
        .catch(() => null) // left in the Solana wallet: the Cash-back helper moves it later
        .finally(() => [1000, 6000, 15000, 30000].forEach((ms) => setTimeout(() => afterTrade(), ms)));
      return;
    }
    const q = await getQuote({ user: s.address, recipient: w.address, originChainId: SOLANA_ID, originCurrency: mint, destinationChainId: BASE.chain.id, destinationCurrency: BASE.usdc, amount: raw.toString(), fee: "swap" });
    const { sendSolanaQuote } = await import("@/lib/solrelay");
    setBusy("Selling…");
    await sendSolanaQuote(q, s, (m) => setBusy(m));
    toast(`Sold $${coin.symbol}: USDC arriving in your Cash in a few seconds ✓`);
    for (const ms of [4000, 10000, 20000]) setTimeout(() => afterTrade(), ms);
  }

  async function go() {
    if (lock.current) return;
    lock.current = true;
    setBusy(side === "buy" ? "Buying…" : "Selling…");
    setError("");
    try {
      if (side === "buy") await buy();
      else await sell();
      for (const ms of [1500, 6000, 15000, 30000]) setTimeout(() => void loadHeld(), ms);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      solInflight(false);
      lock.current = false;
      setBusy("");
    }
  }

  // hidden until Solana opens (lib/solana.ts), and mainnet only
  if (IS_TESTNET || !solanaFor(w.address))
    return (
      <aside className="rounded-3xl border border-line bg-surface p-4 sm:p-5 lg:sticky lg:top-24 text-center text-[0.875rem] text-ink-2">
        Trading Solana coins on sasa opens soon.
      </aside>
    );

  return (
    <aside className="rounded-3xl border border-line bg-surface p-4 sm:p-5 lg:sticky lg:top-24">
      <div className="grid grid-cols-2 gap-1 p-1 rounded-2xl bg-paper" role="tablist" aria-label="Buy or sell">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={side === s}
            onClick={() => setSide(s)}
            className={"h-11 rounded-xl font-bold " + (side === s ? (s === "buy" ? "bg-up text-on-accent" : "bg-danger text-white") : "text-ink-2")}
          >
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>
      {side === "buy" ? (
        <>
          <label className="mt-4 flex items-center h-14 rounded-2xl border border-line bg-paper px-4 focus-within:border-emerald">
            <span className="text-ink-3 text-[1.375rem] mr-1">$</span>
            <input value={usd} onChange={(e) => setUsd(e.target.value.replace(/[^0-9.,]/g, ""))} inputMode="decimal" aria-label="Amount in USDC" className="flex-1 min-w-0 bg-transparent outline-none text-[1.25rem]" />
          </label>
          <div className="grid grid-cols-4 gap-1.5 mt-2">
            {[10, 25, 50, 100].map((v) => (
              <button key={v} type="button" aria-pressed={amount === v} onClick={() => setUsd(String(v))} className={"h-10 rounded-xl border-[1.5px] font-bold text-[0.875rem] " + (amount === v ? "border-emerald text-emerald" : "border-line")}>
                ${v}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="grid grid-cols-4 gap-1.5 mt-4">
          {[25, 50, 75, 100].map((v) => (
            <button key={v} type="button" aria-pressed={pct === v} onClick={() => setPct(v)} className={"h-10 rounded-xl border-[1.5px] font-bold text-[0.875rem] " + (pct === v ? "border-danger text-danger" : "border-line")}>
              {v === 100 ? "All" : `${v}%`}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 flex justify-between rounded-2xl bg-paper px-4 py-3 text-[0.875rem]">
        <span className="text-ink-3">{side === "buy" ? "You get about" : "You get"}</span>
        <b className="font-mono">
          {quote
            ? side === "buy"
              ? `${fmt(Number(quote.outAmount))} $${coin.symbol}`
              : `$${Number(quote.outAmount).toFixed(2)}`
            : side === "buy" && estimate !== null
              ? `${fmt(estimate)} $${coin.symbol}`
              : side === "sell" && coin.priceUsd && raw > 0n
                ? `about $${((Number(raw) / 1e6) * coin.priceUsd * (1 - feeShare)).toFixed(2)}`
                : "—"}
        </b>
      </div>
      {ownFee && (
        <p className={"mt-2 text-[0.75rem] " + (ownFee.bps > 100 ? "text-warn-ink font-semibold" : "text-ink-3")}>
          Trading fee now: {ownFee.bps / 100}%
          {ownFee.nextBps !== null && ownFee.inSec !== null ? ` · ${ownFee.nextBps / 100}% in ${ownFee.inSec}s` : ""}
        </p>
      )}
      {side === "sell" && held !== null && <p className="text-[0.75rem] text-ink-3 mt-2">You hold {held > 0n ? "some" : "no"} ${coin.symbol}</p>}
      <button
        type="button"
        disabled={!w.address || !!busy || raw <= 0n || (side === "sell" && (held ?? 0n) === 0n)}
        onClick={() => void go()}
        className={"mt-3 w-full h-13 rounded-2xl font-bold text-[1rem] disabled:opacity-50 " + (side === "buy" ? "bg-up text-on-accent" : "bg-danger text-white")}
      >
        {busy || (side === "buy" ? `Buy $${coin.symbol}` : `Sell $${coin.symbol}`)}
      </button>
      {error && <p className="mt-2 text-[0.8125rem] text-danger break-words">{error}</p>}
      <p className="text-[0.6875rem] text-ink-3 mt-2">
        {side === "buy"
          ? "Paid with your USDC. The coin goes to your Solana wallet."
          : "Your USDC arrives in your Cash."}
        {sol.walletName && sol.address ? ` · ${sol.walletName} ${sol.address.slice(0, 4)}…${sol.address.slice(-4)}` : ""}
      </p>
      <SolCashBack />
    </aside>
  );
}

/**
 * SOL sitting in the Solana wallet (launch leftovers) goes back to Cash on its own: email
 * accounts sign without a popup, so it just happens. A browser wallet (Phantom…) must approve
 * anything that leaves it, so those get one button.
 */
export function SolCashBack() {
  const w = useWallet();
  const sol = useSolSigner();
  const [q, setQ] = useState<Quote | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const lock = useRef(false);
  const tried = useRef(false);
  const load = useCallback(async () => {
    // email accounts only (an outside wallet's SOL is the user's own), and never while a buy
    // or launch is bringing SOL in for itself
    if (!sol.address || !w.address || !w.embedded || solIsInflight()) return setQ(null);
    const { quoteSolToCash } = await import("@/lib/solrelay");
    setQ(await quoteSolToCash(sol.address, w.address).catch(() => null));
  }, [sol.address, w.address, w.embedded]);
  useEffect(() => {
    void load();
  }, [load]);
  const move = useCallback(async () => {
    if (lock.current || !w.address) return;
    lock.current = true;
    setBusy("Moving to your Cash…");
    setErr("");
    try {
      const s = await sol.get();
      const { solToCash } = await import("@/lib/solrelay");
      const done = await solToCash(s, w.address, () => {});
      if (done) toast(`$${done.outUsd.toFixed(2)} moved to your Cash ✓`);
      for (const ms of [4000, 10000, 20000]) setTimeout(() => afterTrade(), ms);
      setQ(null);
      setTimeout(() => void load(), 8000);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      lock.current = false;
      setBusy("");
    }
  }, [w.address, sol, load]);
  // email accounts: automatic, once per visit
  const auto = w.embedded && !!q && q.outUsd >= 0.3;
  useEffect(() => {
    if (!auto || tried.current) return;
    tried.current = true;
    void move();
  }, [auto, move]);

  if (!q || q.outUsd < 0.3) return null;
  if (w.embedded && !err)
    return busy ? <p className="mt-3 text-[0.75rem] text-ink-3 text-center">Moving ${q.outUsd.toFixed(2)} back to your Cash…</p> : null;
  return (
    <div className="mt-3 rounded-2xl border border-line bg-paper p-3 flex items-center gap-3 text-[0.8125rem]">
      <span className="flex-1 min-w-0">
        <b>${q.outUsd.toFixed(2)}</b> <span className="text-ink-2">{w.embedded ? "couldn't move to your Cash yet" : "waiting in your Solana wallet"}</span>
        {err && <span className="block text-danger break-words">{err}</span>}
      </span>
      <button type="button" onClick={() => void move()} disabled={!!busy} className="h-9 px-3 rounded-full bg-ink text-paper font-semibold shrink-0 disabled:opacity-50">
        {busy ? "…" : w.embedded ? "Try again" : "Move to Cash"}
      </button>
    </div>
  );
}
