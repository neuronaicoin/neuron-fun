"use client";

/**
 * Money in and out of sasa: USDC on the Base network only (the network most exchanges
 * support). Deposit = your address + QR; Withdraw = an address (typed, pasted or scanned)
 * and an amount. Email accounts pay the network fee in USDC (lib/usdcgas.ts); browser
 * wallets pay it as usual in ETH.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isAddress, parseUnits, type Address } from "viem";
import { Sheet } from "./chrome";
import { toast } from "./alerts";
import { useWallet } from "./wallet";
import { QrScanner } from "./money";
import { usdcAbi } from "@/lib/abis";
import { CHAINS, IS_TESTNET } from "@/lib/config";
import { clientFor } from "@/lib/data";
import { friendlyError } from "@/lib/format";
import { openMoney, refreshPortfolio, afterTrade } from "@/lib/portfolio";
import { call } from "@/lib/tx";
import { gasUsdcOf, usdcGasChain } from "@/lib/usdcgas";
import { solanaFor } from "@/lib/solana";
import { NetworkPicker, SolanaDeposit, SolanaWithdraw } from "./solanamoney";

const BASE = CHAINS.find((c) => c.key === "base")!;
const NET = IS_TESTNET ? "Base Sepolia" : "Base";
const fmt = (units: bigint) => `$${(Number(units) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The account's USDC on Base, re-read every few seconds while the sheet is open. */
function useBaseUsdc(address: string | null, everyMs = 4000) {
  const [bal, setBal] = useState<bigint | null>(null);
  const load = useCallback(async () => {
    if (!address) return null;
    try {
      const b = (await clientFor(BASE).readContract({ address: BASE.usdc, abi: usdcAbi, functionName: "balanceOf", args: [address as Address] })) as bigint;
      setBal(b);
      return b;
    } catch {
      return null;
    }
  }, [address]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), everyMs);
    return () => clearInterval(t);
  }, [load, everyMs]);
  return { bal, reload: load };
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

function NetworkTag() {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-night font-semibold text-[0.875rem]">
        <span className="w-4 h-4 rounded-full bg-[#2775ca] text-white text-[0.5625rem] font-bold grid place-items-center" aria-hidden="true">
          $
        </span>
        USDC
      </span>
      <span className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-night font-semibold text-[0.875rem]">
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: BASE.color }} aria-hidden="true" />
        {NET} network
      </span>
    </div>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl bg-warn-bg text-warn-ink px-3 py-2.5 text-[0.8125rem] leading-snug">{children}</div>;
}

/** Deposit | Withdraw, side by side at the top of both sheets (the header's ＋ opens them). */
export function MoneyTabs({ active }: { active: "deposit" | "withdraw" }) {
  return (
    <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-night" role="tablist" aria-label="Deposit or withdraw">
      {(["deposit", "withdraw"] as const).map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={active === k}
          onClick={() => active !== k && openMoney({ kind: k })}
          className={"h-9 rounded-lg text-[0.875rem] font-semibold " + (active === k ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink-2")}
        >
          {k === "deposit" ? "Deposit" : "Withdraw"}
        </button>
      ))}
    </div>
  );
}

export function BaseDepositSheet({ onClose }: { onClose: () => void }) {
  const { address, send } = useWallet();
  const { bal, reload } = useBaseUsdc(address);
  const qr = useQr(address);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const first = useRef<bigint | null>(null);

  // A deposit lands: say so once, and refresh the balance everywhere.
  useEffect(() => {
    if (bal === null) return;
    if (first.current === null) first.current = bal;
    else if (bal > first.current) {
      toast(`Deposit arrived: +${fmt(bal - first.current)}`);
      first.current = bal;
      afterTrade();
    }
  }, [bal]);

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  };

  const faucet = async () => {
    if (!address) return;
    setBusy(true);
    try {
      await send(BASE.chain, [call(BASE.usdc, usdcAbi, "faucet", [address])], () => {});
      toast("+$100 test USDC ✓");
      void reload();
    } catch (e) {
      const t = JSON.stringify(e ?? {}, (_k, v) => (typeof v === "bigint" ? String(v) : v));
      toast(/TooSoon/.test(t) ? "You already got test USDC today." : friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const sol = solanaFor(address);
  const [net, setNet] = useState<"base" | "solana">("solana");
  if (sol && net === "solana")
    return (
      <Sheet title="Deposit" onClose={onClose}>
        <div className="flex flex-col gap-4 min-w-0">
          <MoneyTabs active="deposit" />
          <NetworkPicker value={net} onChange={setNet} />
          <SolanaDeposit />
        </div>
      </Sheet>
    );

  return (
    <Sheet title="Deposit" onClose={onClose}>
      <div className="flex flex-col gap-4 min-w-0">
        <MoneyTabs active="deposit" />
        {sol ? <NetworkPicker value={net} onChange={setNet} /> : <NetworkTag />}
        <div className="flex flex-col items-center gap-3">
          <div className="w-[180px] h-[180px] rounded-2xl bg-white p-2 grid place-items-center border border-line">
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt={`QR code of your deposit address ${address}`} width={164} height={164} />
            ) : (
              <span className="text-black/40 text-[0.8125rem]">QR</span>
            )}
          </div>
          <button type="button" onClick={copy} className="w-full rounded-xl border border-line px-3 py-2.5 text-left min-w-0" aria-label="Copy your deposit address">
            <span className="block text-[0.75rem] text-ink-3">Your USDC address on {NET}</span>
            <span className="block font-mono text-[0.8125rem] break-all">{address}</span>
            <span className="block text-[0.75rem] font-semibold text-emerald-dark mt-1">{copied ? "Copied ✓" : "Tap to copy"}</span>
          </button>
        </div>
        <Warning>
          Send only <b>USDC</b> on the <b>{NET}</b> network. Other coins or networks can be lost. On an exchange, pick &ldquo;Base&rdquo; as the withdrawal network.
        </Warning>
        <div className="flex justify-between text-[0.875rem]">
          <span className="text-ink-2">Balance</span>
          <span className="font-semibold tabular-nums">{bal === null ? "…" : fmt(bal)}</span>
        </div>
        <p className="text-[0.75rem] text-ink-3 -mt-2">It updates by itself when your deposit arrives, usually within a minute.</p>
        {IS_TESTNET && (
          <button type="button" onClick={faucet} disabled={busy} className="h-11 rounded-full border border-line font-semibold text-[0.9375rem] disabled:opacity-50">
            {busy ? "Getting test USDC…" : "Get $100 free test USDC"}
          </button>
        )}
      </div>
    </Sheet>
  );
}

export function BaseWithdrawSheet({ onClose }: { onClose: () => void }) {
  const { address, send, embedded } = useWallet();
  const sol = solanaFor(address);
  const [net, setNet] = useState<"base" | "solana">("solana");
  const { bal, reload } = useBaseUsdc(address, 8000);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState("");
  // email accounts pay the fee in USDC; keep a few cents back when the fee comes from the same USDC
  const feeFromSameUsdc = embedded && !!usdcGasChain(BASE.chain.id) && gasUsdcOf(BASE.chain.id)?.toLowerCase() === BASE.usdc.toLowerCase();
  const reserve = feeFromSameUsdc ? 50_000n : 0n; // $0.05

  const toOk = isAddress(to.trim()) && to.trim().toLowerCase() !== (address ?? "").toLowerCase();
  let units = 0n;
  try {
    units = amount ? parseUnits(amount, 6) : 0n;
  } catch {
    units = -1n;
  }
  const max = bal === null ? 0n : bal > reserve ? bal - reserve : 0n;
  const problem = !to
    ? ""
    : !toOk
      ? to.trim().toLowerCase() === (address ?? "").toLowerCase()
        ? "That's your own address."
        : "That doesn't look like an address."
      : units < 0n
        ? "Check the amount."
        : units > max
          ? "More than you can send."
          : "";

  const submit = async () => {
    if (!toOk || units <= 0n || units > max || busy) return;
    setBusy(true);
    setError("");
    try {
      const tx = await send(BASE.chain, [call(BASE.usdc, usdcAbi, "transfer", [to.trim() as Address, units])], (m) => setStep(m));
      setDone(tx);
      toast(`Sent ${fmt(units)} ✓`);
      void reload();
      afterTrade();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
      setStep("");
    }
  };

  if (sol && net === "solana")
    return (
      <Sheet title="Withdraw" onClose={onClose}>
        <div className="flex flex-col gap-4 min-w-0">
          <MoneyTabs active="withdraw" />
          <NetworkPicker value={net} onChange={setNet} />
          <SolanaWithdraw onDone={onClose} />
        </div>
      </Sheet>
    );

  if (scan)
    return (
      <QrScanner
        onClose={() => setScan(false)}
        onResult={(text) => {
          // "ethereum:0xabc…@8453" or a plain address
          const m = text.match(/0x[0-9a-fA-F]{40}/);
          if (m) setTo(m[0]);
          setScan(false);
        }}
      />
    );

  return (
    <Sheet title="Withdraw" onClose={onClose}>
      <div className="mb-4">
        <MoneyTabs active="withdraw" />
      </div>
      {done ? (
        <div className="flex flex-col gap-3 items-center text-center py-4">
          <div className="text-[2rem]" aria-hidden="true">
            ✓
          </div>
          <p className="font-semibold">Sent</p>
          <a href={`${BASE.chain.blockExplorers!.default.url}/tx/${done}`} target="_blank" rel="noreferrer" className="text-[0.875rem] underline text-ink-2">
            View the transaction
          </a>
          <button type="button" onClick={onClose} className="h-11 px-6 rounded-full bg-ink text-paper font-semibold mt-2">
            Done
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4 min-w-0">
          {sol ? <NetworkPicker value={net} onChange={setNet} /> : <NetworkTag />}
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] text-ink-3">To ({NET} address)</span>
            <div className="flex gap-2 min-w-0">
              <input
                value={to}
                onChange={(e) => setTo(e.target.value.trim())}
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
                className="flex-1 min-w-0 h-12 rounded-xl border border-line bg-paper px-3 font-mono text-[0.875rem] outline-none focus:border-ink-3"
              />
              <button type="button" onClick={() => setScan(true)} className="h-12 px-3 rounded-xl border border-line text-[0.8125rem] font-semibold shrink-0" aria-label="Scan a QR code">
                Scan
              </button>
            </div>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] text-ink-3 flex justify-between">
              Amount (USDC)
              <span className="tabular-nums">Balance {bal === null ? "…" : fmt(bal)}</span>
            </span>
            <div className="flex gap-2 min-w-0">
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))}
                placeholder="0.00"
                className="flex-1 min-w-0 h-12 rounded-xl border border-line bg-paper px-3 text-[1rem] tabular-nums outline-none focus:border-ink-3"
              />
              <button
                type="button"
                onClick={() => setAmount((Number(max) / 1e6).toFixed(2))}
                disabled={max <= 0n}
                className="h-12 px-4 rounded-xl border border-line text-[0.8125rem] font-semibold shrink-0 disabled:opacity-40"
              >
                Max
              </button>
            </div>
          </label>
          <div className="flex justify-between text-[0.8125rem] text-ink-2">
            <span>Network fee</span>
            <span>{embedded && usdcGasChain(BASE.chain.id) ? "about $0.01, paid in USDC" : "paid in ETH by your wallet"}</span>
          </div>
          {IS_TESTNET && embedded && (
            <p className="text-[0.75rem] text-ink-3 -mt-2">
              Testnet: the network fee is paid in Circle&apos;s test USDC. Get some at{" "}
              <a href="https://faucet.circle.com" target="_blank" rel="noreferrer" className="underline">
                faucet.circle.com
              </a>{" "}
              (Base Sepolia).
            </p>
          )}
          <Warning>
            Double-check the address. It must be able to receive <b>USDC on {NET}</b>. Transfers can&apos;t be undone.
          </Warning>
          {(problem || error) && <p className="text-[0.875rem] text-danger break-words">{problem || error}</p>}
          <button
            type="button"
            onClick={submit}
            disabled={busy || !toOk || units <= 0n || units > max}
            className="h-12 rounded-full bg-ink text-paper font-bold text-[1rem] disabled:opacity-40"
          >
            {busy ? step || "Sending…" : units > 0n ? `Withdraw ${fmt(units)}` : "Withdraw"}
          </button>
        </div>
      )}
    </Sheet>
  );
}
