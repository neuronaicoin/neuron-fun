"use client";

/**
 * USDC in and out over Solana (step 1 of Solana on sasa, lib/solana.ts). The user never sees
 * two kinds of dollars: what comes in from Solana lands as Cash, what goes out to Solana comes
 * from Cash.
 *
 *   Deposit:  amount → a one-time Relay address on Solana → send USDC there from Phantom or an
 *             exchange → Relay turns it into the account's USDC (sasa's 0.25% deposit fee, as for
 *             every other network routed this way) → Cash goes up.
 *   Withdraw: a Solana address + amount → one Relay route from the account's USDC on Base to
 *             USDC on Solana at that address (sent in one batch, like a trade) → tracked to done.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { type Address } from "viem";
import { toast } from "./alerts";
import { useWallet } from "./wallet";
import { QrScanner } from "./money";
import { usdcAbi } from "@/lib/abis";
import { CHAINS } from "@/lib/config";
import { clientFor } from "@/lib/data";
import { quoteCalls } from "@/lib/extswap";
import { friendlyError } from "@/lib/format";
import { afterTrade } from "@/lib/portfolio";
import { addressFromQr, depositsTo, getQuote, isSolanaAddress, requestStatus, toUnits, type Quote } from "@/lib/relay";
import { SOLANA_ID, SOLANA_USDC } from "@/lib/solana";
import { gasUsdcOf, usdcGasChain } from "@/lib/usdcgas";

const BASE = CHAINS.find((c) => c.key === "base")!;
const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PRESETS = ["10", "25", "50", "100"];

/** "USDC", loud: the one thing people must not get wrong. */
export const Usdc = () => <b className="text-emerald font-extrabold">USDC</b>;

/** Solana's mark (three slanted bars). */
export function SolanaMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="20" fill="#000" />
      <g transform="translate(9 11)">
        <path d="M4 0h18l-4 4H0z" fill="#14F195" />
        <path d="M0 7h18l4 4H4z" fill="#9AA3FF" />
        <path d="M4 14h18l-4 4H0z" fill="#9945FF" />
      </g>
    </svg>
  );
}

/** Which network the money moves on: Base (direct, free) or Solana (through Relay). */
export function NetworkPicker({ value, onChange }: { value: "base" | "solana"; onChange: (v: "base" | "solana") => void }) {
  const opt = (k: "base" | "solana", name: string, note: string, mark: React.ReactNode) => (
    <button
      type="button"
      aria-pressed={value === k}
      onClick={() => onChange(k)}
      className={"flex items-center gap-2.5 p-3 rounded-2xl border-[1.5px] text-left min-w-0 " + (value === k ? "border-emerald bg-emerald/5" : "border-line")}
    >
      {mark}
      <span className="min-w-0">
        <b className="block text-[0.9375rem]">
          <Usdc /> on {name}
        </b>
        <span className="block text-[0.75rem] text-ink-3">{note}</span>
      </span>
    </button>
  );
  return (
    <div className="grid grid-cols-2 gap-2">
      {opt("solana", "Solana", "Phantom, exchanges", <SolanaMark size={28} />)}
      {opt(
        "base",
        "Base",
        "Coinbase, exchanges",
        <span className="w-7 h-7 shrink-0 rounded-full grid place-items-center text-white text-[0.75rem] font-bold" style={{ background: BASE.color }}>
          B
        </span>
      )}
    </div>
  );
}

function useQr(text: string | null): string {
  const [qr, setQr] = useState("");
  useEffect(() => {
    setQr("");
    if (!text) return;
    let alive = true;
    import("qrcode")
      .then((m) => m.toDataURL(text, { margin: 1, width: 360, color: { dark: "#16120f", light: "#ffffff" } }))
      .then((u) => alive && setQr(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [text]);
  return qr;
}

// ------------------------------------------------------------------ deposit

export function SolanaDeposit() {
  const { address } = useWallet();
  const [amount, setAmount] = useState("25");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [err, setErr] = useState("");
  const [shown, setShown] = useState<Quote | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const units = useMemo(() => toUnits(amount, 6), [amount]);
  const qr = useQr(shown?.depositAddress ?? null);

  // a new amount means a new address: never leave an old one on screen
  useEffect(() => {
    setShown(null);
    setStatus(null);
  }, [units]);

  useEffect(() => {
    setQuote(null);
    setErr("");
    if (!address || !units) return;
    const ctrl = new AbortController();
    setQuoting(true);
    const t = setTimeout(() => {
      getQuote(
        {
          // the sender is whoever pays into the one-time address: Relay wants a Solana address
          // here (an EVM one is refused for a Solana origin), so the "anyone" address
          user: "11111111111111111111111111111111",
          recipient: address,
          originChainId: SOLANA_ID,
          originCurrency: SOLANA_USDC,
          destinationChainId: BASE.chain.id,
          destinationCurrency: BASE.usdc,
          amount: units,
          useDepositAddress: true,
          // a deposit that can't go through goes back to whoever sent it
          refundTo: "11111111111111111111111111111111",
          fee: "deposit",
        },
        ctrl.signal
      )
        .then((q) => {
          if (!q.depositAddress) throw new Error("Couldn't make a deposit address right now. Try again in a moment.");
          setQuote(q);
        })
        .catch((e) => !ctrl.signal.aborted && setErr(friendlyError(e)))
        .finally(() => !ctrl.signal.aborted && setQuoting(false));
    }, 400);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [address, units]);

  // watch the one-time address until the money lands as Cash
  useEffect(() => {
    const addr = shown?.depositAddress;
    if (!addr) return;
    const since = Date.now() - 60_000;
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const mine = (await depositsTo(addr)).find((d) => Date.parse(d.createdAt) >= since);
        if (mine && alive) {
          if (mine.status === "success") {
            setStatus(`${usd(mine.outUsd)} added to your Cash ✓`);
            toast("Deposit arrived");
            afterTrade();
            return;
          }
          setStatus(mine.status === "failure" || mine.status === "refund" ? "This deposit couldn't go through and was sent back." : "Deposit seen, adding it to your Cash…");
        }
      } catch {}
      if (alive) t = setTimeout(tick, 4_000);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [shown?.depositAddress]);

  if (!address) return <p className="text-[0.875rem] text-ink-2">Log in first.</p>;

  if (shown?.depositAddress) {
    const a = shown.depositAddress;
    return (
      <div className="flex flex-col gap-3 items-center min-w-0">
        <p className="text-center text-[0.9375rem]">
          Send <b>{usd(Number(amount))}</b> <Usdc /> on <b>Solana</b> to:
        </p>
        <div className="w-[180px] h-[180px] rounded-2xl bg-white p-2 grid place-items-center border border-line">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {qr ? <img src={qr} alt="QR code of the Solana deposit address" width={164} height={164} /> : <span className="text-black/40 text-[0.8125rem]">QR</span>}
        </div>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(a);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
          className="w-full rounded-xl border border-line px-3 py-2.5 text-left min-w-0"
        >
          <span className="block text-[0.75rem] text-ink-3">Solana address, for this deposit only</span>
          <span className="block font-mono text-[0.8125rem] break-all">{a}</span>
          <span className="block text-[0.75rem] font-semibold text-emerald-dark mt-1">{copied ? "Copied ✓" : "Tap to copy"}</span>
        </button>
        <div className="w-full rounded-xl bg-warn-bg text-warn-ink px-3 py-2.5 text-[0.8125rem] leading-snug">
          Send only <Usdc /> on the <b>Solana</b> network, about the amount above. Other coins can be lost. It shows in your Cash by itself
          {shown.seconds ? `, usually in ~${Math.max(10, shown.seconds)} seconds` : ""}.
        </div>
        <p className="text-center font-semibold text-[0.875rem] min-h-[1.25rem]">{status ?? "Waiting for your USDC…"}</p>
        <button type="button" onClick={() => setShown(null)} className="text-[0.8125rem] text-ink-3 underline">
          Change the amount
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <label className="flex items-center h-14 rounded-2xl border border-line bg-paper px-4 focus-within:border-emerald">
        <span className="text-ink-3 text-[1.25rem] mr-1">$</span>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))}
          inputMode="decimal"
          placeholder="0"
          aria-label="How much USDC you'll send"
          className="flex-1 min-w-0 bg-transparent outline-none text-[1.125rem] tabular-nums"
        />
        <Usdc />
      </label>
      <div className="grid grid-cols-4 gap-2">
        {PRESETS.map((v) => (
          <button key={v} type="button" onClick={() => setAmount(v)} className={"h-10 rounded-xl border font-semibold " + (amount === v ? "border-emerald text-emerald" : "border-line")}>
            ${v}
          </button>
        ))}
      </div>
      <div className="rounded-2xl border border-line bg-paper px-4 py-3 text-[0.875rem] grid gap-1">
        <div className="flex justify-between gap-2">
          <span className="text-ink-3">Added to your Cash</span>
          <b className="tabular-nums">{quote ? `≈ ${usd(quote.outUsd)}` : quoting ? "…" : "—"}</b>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink-3">Arrives in</span>
          <b className="tabular-nums">{quote ? `~${Math.max(10, quote.seconds)} s` : "—"}</b>
        </div>
      </div>
      {err && <p className="text-[0.8125rem] text-danger">{err}</p>}
      <button type="button" disabled={!quote?.depositAddress} onClick={() => setShown(quote)} className="h-12 rounded-full bg-emerald text-on-accent font-bold disabled:opacity-50">
        Show my Solana address
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ withdraw

export function SolanaWithdraw({ onDone }: { onDone: () => void }) {
  const { address, send, embedded } = useWallet();
  const [bal, setBal] = useState<bigint | null>(null);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [scan, setScan] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  useEffect(() => {
    if (!address) return;
    let on = true;
    const load = () =>
      clientFor(BASE)
        .readContract({ address: BASE.usdc, abi: usdcAbi, functionName: "balanceOf", args: [address as Address] })
        .then((b) => on && setBal(b as bigint))
        .catch(() => {});
    void load();
    const t = setInterval(load, 8000);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [address]);

  // email accounts pay Base's network fee in USDC: keep a few cents back
  const feeFromSameUsdc = embedded && !!usdcGasChain(BASE.chain.id) && gasUsdcOf(BASE.chain.id)?.toLowerCase() === BASE.usdc.toLowerCase();
  const reserve = feeFromSameUsdc ? 50_000n : 0n;
  const max = bal === null ? 0n : bal > reserve ? bal - reserve : 0n;
  const units = toUnits(amount, 6);
  const dest = to.trim();
  const toOk = isSolanaAddress(dest);
  const tooMuch = units !== null && BigInt(units) > max;

  useEffect(() => {
    setQuote(null);
    setErr("");
    if (!address || !toOk || !units || tooMuch) return;
    const ctrl = new AbortController();
    setQuoting(true);
    const t = setTimeout(() => {
      getQuote(
        {
          user: address,
          recipient: dest,
          originChainId: BASE.chain.id,
          originCurrency: BASE.usdc,
          destinationChainId: SOLANA_ID,
          destinationCurrency: SOLANA_USDC,
          amount: units,
        },
        ctrl.signal
      )
        .then(setQuote)
        .catch((e) => !ctrl.signal.aborted && setErr(friendlyError(e)))
        .finally(() => !ctrl.signal.aborted && setQuoting(false));
    }, 450);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [address, dest, toOk, units, tooMuch]);

  const submit = async () => {
    if (!address || !toOk || !units || tooMuch || busy) return;
    setBusy(true);
    setErr("");
    try {
      setStep("Getting the best route…");
      // a fresh route right before sending (they're only good for a short while)
      const q = await getQuote({
        user: address,
        recipient: dest,
        originChainId: BASE.chain.id,
        originCurrency: BASE.usdc,
        destinationChainId: SOLANA_ID,
        destinationCurrency: SOLANA_USDC,
        amount: units,
      });
      await send(BASE.chain, quoteCalls(q, BASE), (m) => setStep(m));
      setStep("On its way to Solana…");
      afterTrade();
      if (q.requestId) {
        for (let i = 0; i < 90 && alive.current; i++) {
          const s = await requestStatus(q.requestId).catch(() => "waiting" as const);
          if (s === "success") break;
          if (s === "failure" || s === "refund") throw new Error("The transfer couldn't finish and your USDC was returned to your Cash.");
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      setDone(`${usd(q.outUsd)} USDC sent to ${dest.slice(0, 4)}…${dest.slice(-4)} on Solana`);
      toast("Withdrawal sent ✓");
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
      setStep("");
    }
  };

  if (scan)
    return (
      <QrScanner
        onClose={() => setScan(false)}
        onResult={(text) => {
          setTo(addressFromQr(text));
          setScan(false);
        }}
      />
    );

  if (done)
    return (
      <div className="flex flex-col gap-3 items-center text-center py-4">
        <div className="text-[2rem]" aria-hidden="true">
          ✓
        </div>
        <p className="font-semibold">{done}</p>
        <button type="button" onClick={onDone} className="h-11 px-6 rounded-full bg-ink text-paper font-semibold mt-2">
          Done
        </button>
      </div>
    );

  return (
    <div className="flex flex-col gap-4 min-w-0">
      <label className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] text-ink-3">
          To (Solana address that receives <Usdc />)
        </span>
        <div className="flex gap-2 min-w-0">
          <input
            value={to}
            onChange={(e) => setTo(e.target.value.trim())}
            placeholder="Solana address"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 min-w-0 h-12 rounded-xl border border-line bg-paper px-3 font-mono text-[0.875rem] outline-none focus:border-ink-3"
          />
          <button type="button" onClick={() => setScan(true)} className="h-12 px-3 rounded-xl border border-line text-[0.8125rem] font-semibold shrink-0" aria-label="Scan a QR code">
            Scan
          </button>
        </div>
        {dest && !toOk && <span className="text-[0.75rem] text-danger">That isn&apos;t a Solana address.</span>}
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] text-ink-3 flex justify-between">
          Amount
          <span className="tabular-nums">Cash {bal === null ? "…" : usd(Number(bal) / 1e6)}</span>
        </span>
        <div className="flex gap-2 min-w-0">
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))}
            placeholder="0.00"
            className="flex-1 min-w-0 h-12 rounded-xl border border-line bg-paper px-3 text-[1rem] tabular-nums outline-none focus:border-ink-3"
          />
          <button type="button" onClick={() => setAmount((Number(max) / 1e6).toFixed(2))} disabled={max <= 0n} className="h-12 px-4 rounded-xl border border-line text-[0.8125rem] font-semibold shrink-0 disabled:opacity-40">
            Max
          </button>
        </div>
        {tooMuch && <span className="text-[0.75rem] text-danger">More than you can send.</span>}
      </label>
      <div className="rounded-2xl border border-line bg-paper px-4 py-3 text-[0.875rem] grid gap-1">
        <div className="flex justify-between gap-2">
          <span className="text-ink-3">They receive</span>
          <b className="tabular-nums">{quote ? `≈ ${usd(quote.outUsd)} USDC` : quoting ? "…" : "—"}</b>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink-3">Arrives in</span>
          <b className="tabular-nums">{quote ? `~${Math.max(10, quote.seconds)} s` : "—"}</b>
        </div>
      </div>
      <div className="rounded-xl bg-warn-bg text-warn-ink px-3 py-2.5 text-[0.8125rem] leading-snug">
        Sending to an exchange? Pick <Usdc /> on the <b>Solana</b> network there. Transfers can&apos;t be undone.
      </div>
      {err && <p className="text-[0.875rem] text-danger break-words">{err}</p>}
      <button type="button" onClick={submit} disabled={busy || !quote} className="h-12 rounded-full bg-ink text-paper font-bold text-[1rem] disabled:opacity-40">
        {busy ? step || "Sending…" : units ? `Withdraw ${usd(Number(units) / 1e6)}` : "Withdraw"}
      </button>
    </div>
  );
}
