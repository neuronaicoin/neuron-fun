"use client";

/**
 * Mainnet money: Deposit (send USDC / USDG straight to your address, free; or any other
 * coin from any chain through a one-time Relay address, turned into dollars, 0.25% fee)
 * and Withdraw (send USDC on Base or USDG on Robinhood to any address, no fee).
 */
import { useEffect, useMemo, useState } from "react";
import { isAddress, type Address } from "viem";
import { Sheet } from "./chrome";
import { toast } from "./alerts";
import { useWallet } from "./wallet";
import { usdcAbi } from "@/lib/abis";
import { CHAINS, type NeuronChain } from "@/lib/config";
import { clientFor } from "@/lib/data";
import { friendlyError } from "@/lib/format";
import { refreshPortfolio } from "@/lib/portfolio";
import { depositsTo, getQuote, refundFor, relayChains, type Quote, type RelayChain, type RelayToken } from "@/lib/relay";
import { call } from "@/lib/tx";

const DOLLAR: Record<string, string> = { base: "USDC", robinhood: "USDG" };
const dollarOf = (c: NeuronChain) => DOLLAR[c.key] ?? "USDC";

function useQr(text: string | null): string {
  const [qr, setQr] = useState("");
  useEffect(() => {
    setQr("");
    if (!text) return;
    let alive = true;
    import("qrcode")
      .then((m) => m.toDataURL(text, { margin: 1, width: 320, errorCorrectionLevel: "M" }))
      .then((u) => alive && setQr(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [text]);
  return qr;
}

function AddressBox({ value, warning }: { value: string; warning: React.ReactNode }) {
  const qr = useQr(value);
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4 rounded-2xl border border-dashed border-line p-4 text-center">
      <div className="mx-auto w-40 h-40 rounded-xl bg-white p-2 flex items-center justify-center">
        {qr ? <img src={qr} alt="QR code of the address" className="w-full h-full" /> : <span className="text-[0.75rem] text-ink-3">…</span>}
      </div>
      <p className="mt-3 font-mono text-[0.8125rem] break-all rounded-xl border border-line bg-paper px-3 py-2 select-all">{value}</p>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="mt-3 w-full h-12 rounded-2xl bg-ink text-paper font-bold"
      >
        {copied ? "Copied ✓" : "Copy address"}
      </button>
      <div className="mt-3 rounded-xl border border-danger/40 bg-danger/5 px-3 py-2.5 text-left text-[0.8125rem] leading-snug">{warning}</div>
    </div>
  );
}

const Red = ({ children }: { children: React.ReactNode }) => <b className="text-danger font-bold">{children}</b>;

// ------------------------------------------------------------------ deposit

export function MainnetDepositSheet({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"direct" | "other">("direct");
  return (
    <Sheet title="Deposit" onClose={onClose}>
      <div className="grid grid-cols-2 gap-1 p-1 rounded-2xl border border-line bg-paper" role="tablist">
        {(
          [
            ["direct", "Send USDC"],
            ["other", "From another coin or chain"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={"min-h-11 px-2 py-2 rounded-xl font-bold text-[0.875rem] leading-tight " + (tab === k ? "bg-ink text-paper" : "text-ink-2")}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "direct" ? <DirectDeposit /> : <OtherDeposit />}
    </Sheet>
  );
}

function DirectDeposit() {
  const { address } = useWallet();
  const [key, setKey] = useState(CHAINS.find((c) => c.key === "base")?.key ?? CHAINS[0].key);
  const c = CHAINS.find((x) => x.key === key) ?? CHAINS[0];
  if (!address) return <p className="mt-4 text-[0.875rem] text-ink-2">Log in first.</p>;
  return (
    <div>
      <div className="grid gap-2 mt-4">
        {CHAINS.map((x) => (
          <button
            key={x.key}
            type="button"
            onClick={() => setKey(x.key)}
            aria-pressed={x.key === key}
            className={"flex items-center gap-3 p-3 rounded-2xl border bg-paper text-left " + (x.key === key ? "border-up ring-2 ring-up/25" : "border-line")}
          >
            <span className="w-9 h-9 shrink-0 rounded-xl text-white font-bold flex items-center justify-center" style={{ background: x.color }}>
              {x.short[0]}
            </span>
            <span className="flex-1 min-w-0">
              <b className="block">
                {dollarOf(x)} on {x.name}
              </b>
              <span className="block text-[0.75rem] text-ink-3">{x.key === "base" ? "From Coinbase, Binance, OKX or any wallet" : "From Robinhood or any wallet"}</span>
            </span>
            <span className="shrink-0 text-[0.6875rem] font-bold px-2 py-0.5 rounded-full bg-up/15 text-up">No fee</span>
          </button>
        ))}
      </div>
      <AddressBox
        value={address}
        warning={
          <>
            Send only <Red>{dollarOf(c)}</Red> on the <Red>{c.name}</Red> network to this address. It shows up as cash in about a minute.
          </>
        }
      />
    </div>
  );
}

function OtherDeposit() {
  const { address } = useWallet();
  const [chains, setChains] = useState<RelayChain[] | null>(null);
  const [err, setErr] = useState("");
  const [fromId, setFromId] = useState<number | null>(null);
  const [sym, setSym] = useState("");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [shown, setShown] = useState<Quote | null>(null);
  const [arrived, setArrived] = useState<string | null>(null);
  const dest = CHAINS.find((c) => c.key === "base") ?? CHAINS[0];
  const ours = new Set(CHAINS.map((c) => c.chain.id));

  useEffect(() => {
    relayChains()
      .then((all) => {
        const list = all.filter((c) => !ours.has(c.id));
        setChains(list);
        if (list[0]) setFromId(list[0].id);
      })
      .catch((e) => setErr(friendlyError(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const from = chains?.find((c) => c.id === fromId) ?? null;
  const tokens: RelayToken[] = from?.tokens ?? [];
  const token = tokens.find((t) => t.symbol === sym) ?? tokens[0] ?? null;
  const units = useMemo(() => {
    const n = Number(amount.replace(",", "."));
    if (!token || !(n > 0)) return null;
    const [w, f = ""] = amount.replace(",", ".").split(".");
    try {
      return (BigInt(w || "0") * 10n ** BigInt(token.decimals) + BigInt((f + "0".repeat(token.decimals)).slice(0, token.decimals) || "0")).toString();
    } catch {
      return null;
    }
  }, [amount, token]);

  // A new choice always means a new address: drop the old one so it can't be reused by mistake.
  useEffect(() => {
    setShown(null);
    setArrived(null);
  }, [fromId, token?.symbol, units]);

  useEffect(() => {
    setQuote(null);
    if (!address || !from || !token || !units) return;
    const ctrl = new AbortController();
    setQuoting(true);
    const t = setTimeout(() => {
      getQuote(
        {
          user: address,
          recipient: address,
          originChainId: from.id,
          originCurrency: token.address,
          destinationChainId: dest.chain.id,
          destinationCurrency: dest.usdc,
          amount: units,
          useDepositAddress: true,
          refundTo: refundFor(from, address),
          fee: "deposit",
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
  }, [address, from, token, units, dest.chain.id, dest.usdc]);

  // Watch the one-time address until the deposit lands.
  useEffect(() => {
    const addr = shown?.depositAddress;
    if (!addr) return;
    const since = Date.now() - 60_000;
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const list = await depositsTo(addr);
        const mine = list.find((d) => Date.parse(d.createdAt) >= since);
        if (mine && alive) {
          if (mine.status === "success") {
            setArrived(`$${mine.outUsd.toFixed(2)} added to your cash ✓`);
            toast("Deposit arrived");
            void refreshPortfolio(true);
            return;
          }
          setArrived(mine.status === "failure" || mine.status === "refund" ? "This deposit was refunded to where it came from." : "Deposit seen, turning it into dollars…");
        }
      } catch {}
      if (alive) t = setTimeout(tick, 5_000);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [shown?.depositAddress]);

  if (!address) return <p className="mt-4 text-[0.875rem] text-ink-2">Log in first.</p>;
  if (!chains) return <p className="mt-4 text-[0.875rem] text-ink-3">{err || "Loading…"}</p>;

  return (
    <div>
      <h3 className="mt-4 font-display font-bold text-[1rem]">What do you have?</h3>
      <div className="flex flex-wrap gap-2 mt-2">
        {tokens.map((t) => (
          <button
            key={t.symbol}
            type="button"
            aria-pressed={token?.symbol === t.symbol}
            onClick={() => setSym(t.symbol)}
            className={"h-10 px-4 rounded-xl border-[1.5px] font-bold text-[0.875rem] " + (token?.symbol === t.symbol ? "border-up text-up" : "border-line")}
          >
            {t.symbol}
          </button>
        ))}
      </div>
      <h3 className="mt-4 font-display font-bold text-[1rem]">On which chain?</h3>
      <div className="flex flex-wrap gap-2 mt-2">
        {chains.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={c.id === fromId}
            onClick={() => {
              setFromId(c.id);
              if (!c.tokens.some((t) => t.symbol === sym)) setSym("");
            }}
            className={"h-10 px-4 rounded-xl border-[1.5px] font-bold text-[0.875rem] " + (c.id === fromId ? "border-up text-up" : "border-line")}
          >
            {c.name}
          </button>
        ))}
      </div>
      <label className="mt-4 flex items-center h-14 rounded-2xl border border-line bg-paper px-4 focus-within:border-emerald">
        <span className="text-[0.75rem] text-ink-3 mr-2 shrink-0">Amount</span>
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ""))} inputMode="decimal" placeholder="0" aria-label="Amount" className="flex-1 min-w-0 bg-transparent outline-none text-[1.125rem]" />
        <span className="font-bold text-[0.875rem] shrink-0">{token?.symbol}</span>
      </label>
      <div className="mt-3 rounded-2xl border border-line bg-paper px-4 py-3 text-[0.875rem] grid gap-1">
        <div className="flex justify-between gap-2">
          <span className="text-ink-3">You receive as cash</span>
          <b className="font-mono">{quote ? `≈ $${quote.outUsd.toFixed(2)}` : quoting ? "…" : "—"}</b>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink-3">Fees (network + 0.25%)</span>
          <b className="font-mono">{quote ? `≈ $${quote.costUsd.toFixed(2)}` : "—"}</b>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink-3">Arrives in</span>
          <b className="font-mono">{quote ? (quote.seconds > 90 ? `~${Math.round(quote.seconds / 60)} min` : `~${Math.max(5, quote.seconds)} s`) : "—"}</b>
        </div>
      </div>
      {err && !quote && <p className="mt-2 text-[0.8125rem] text-danger">{err}</p>}
      {!shown ? (
        <button
          type="button"
          disabled={!quote?.depositAddress}
          onClick={() => setShown(quote)}
          className="mt-3 w-full h-12 rounded-2xl bg-emerald text-on-accent font-bold disabled:opacity-50"
        >
          Get my deposit address
        </button>
      ) : (
        <>
          <AddressBox
            value={shown.depositAddress!}
            warning={
              <>
                This address is only for <Red>{token?.symbol}</Red> on <Red>{from?.name}</Red>, for this deposit. Send it on the <Red>{from?.name}</Red> network; it&apos;s turned into dollars and added to your cash by itself.
              </>
            }
          />
          {arrived && <p className="mt-3 text-center font-semibold text-[0.875rem]">{arrived}</p>}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ withdraw

export function MainnetWithdrawSheet({ onClose }: { onClose: () => void }) {
  const { address, send } = useWallet();
  const [key, setKey] = useState(CHAINS.find((c) => c.key === "base")?.key ?? CHAINS[0].key);
  const c = CHAINS.find((x) => x.key === key) ?? CHAINS[0];
  const [have, setHave] = useState<Record<string, bigint>>({});
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!address) return;
    const entries = await Promise.all(
      CHAINS.map(async (x) => [x.key, ((await clientFor(x).readContract({ address: x.usdc, abi: usdcAbi, functionName: "balanceOf", args: [address] }).catch(() => 0n)) as bigint)] as const)
    );
    setHave(Object.fromEntries(entries));
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const bal = have[key] ?? 0n;
  const units = (() => {
    const n = Number(amount.replace(",", "."));
    return n > 0 ? BigInt(Math.floor(n * 1e6)) : 0n;
  })();
  const dest = to.trim();
  const badTo = dest !== "" && !isAddress(dest);
  const ready = units > 0n && units <= bal && isAddress(dest) && dest.toLowerCase() !== address?.toLowerCase() && !busy;
  const total = Object.values(have).reduce((a, b) => a + b, 0n);

  async function go() {
    if (!ready) return;
    try {
      setBusy(true);
      await send(c.chain, [call(c.usdc, usdcAbi, "transfer", [dest as Address, units])], () => {});
      toast(`Sent $${(Number(units) / 1e6).toFixed(2)} ✓`);
      setAmount("");
      void refreshPortfolio(true);
      void load();
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Withdraw" onClose={onClose}>
      <p className="text-[0.75rem] text-ink-3">Cash available</p>
      <p className="font-mono font-bold text-[1.75rem] leading-tight">${(Number(total) / 1e6).toFixed(2)}</p>
      <h3 className="mt-4 font-display font-bold text-[1rem]">Send as</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
        {CHAINS.map((x) => (
          <button
            key={x.key}
            type="button"
            aria-pressed={x.key === key}
            onClick={() => setKey(x.key)}
            className={"min-h-12 px-3 py-2 rounded-2xl border-[1.5px] text-left " + (x.key === key ? "border-up" : "border-line")}
          >
            <b className="block text-[0.875rem]">
              {dollarOf(x)} on {x.short}
            </b>
            <span className="block text-[0.75rem] text-ink-3">${(Number(have[x.key] ?? 0n) / 1e6).toFixed(2)} here</span>
          </button>
        ))}
      </div>
      <label className="mt-4 flex items-center h-14 rounded-2xl border border-line bg-paper px-4 focus-within:border-emerald">
        <span className="text-ink-3 text-[1.25rem] mr-1">$</span>
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ""))} inputMode="decimal" placeholder="0" aria-label="Amount to withdraw" className="flex-1 min-w-0 bg-transparent outline-none text-[1.125rem]" />
        <button type="button" onClick={() => setAmount((Number(bal) / 1e6).toFixed(2))} className="shrink-0 h-8 px-3 rounded-lg border border-line font-bold text-[0.8125rem]">
          Max
        </button>
      </label>
      {units > bal && <p className="mt-1 text-[0.75rem] text-danger">More than you have on {c.name}.</p>}
      <h3 className="mt-4 font-display font-bold text-[1rem]">Send to</h3>
      <input
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="0x… wallet or exchange deposit address"
        aria-label="Destination address"
        className={"mt-2 w-full h-12 rounded-2xl border bg-paper px-4 font-mono text-[0.8125rem] outline-none " + (badTo ? "border-danger" : "border-line focus:border-emerald")}
      />
      {badTo && <p className="mt-1 text-[0.75rem] text-danger">That isn&apos;t a valid address.</p>}
      <div className="mt-3 rounded-2xl border border-line bg-paper px-4 py-3 text-[0.875rem] grid gap-1">
        <div className="flex justify-between">
          <span className="text-ink-3">They receive</span>
          <b className="font-mono">${(Number(units) / 1e6).toFixed(2)} {dollarOf(c)}</b>
        </div>
        <div className="flex justify-between">
          <span className="text-ink-3">Fee</span>
          <b className="font-mono">None</b>
        </div>
      </div>
      <button type="button" disabled={!ready} onClick={() => void go()} className="mt-3 w-full h-12 rounded-2xl bg-emerald text-on-accent font-bold disabled:opacity-50">
        {busy ? "Sending…" : `Withdraw $${(Number(units) / 1e6).toFixed(2)}`}
      </button>
      <div className="mt-3 rounded-xl border border-danger/40 bg-danger/5 px-3 py-2.5 text-[0.8125rem] leading-snug">
        Sending to an exchange? On the exchange pick <Red>{dollarOf(c)}</Red> on the <Red>{c.name}</Red> network. A wrong network can lose the money.
      </div>
    </Sheet>
  );
}
