"use client";

/**
 * Dollar edition money sheets (testnet): add money = free test USDC from the
 * faucet (or send USDC to your address); send out = USDC to any address, on
 * the chain you pick. On mainnet, "Add money" gains deposits from any chain
 * and token (converted to USDC), and "Send out" gains other networks.
 */
import { useEffect, useState } from "react";
import { isAddress, type Address } from "viem";
import { Sheet } from "./chrome";
import { useWallet } from "./wallet";
import { toast } from "./alerts";
import { usdcAbi } from "@/lib/abis";
import { CHAINS, type NeuronChain } from "@/lib/config";
import { clientFor } from "@/lib/data";
import { friendlyError } from "@/lib/format";
import { cashOf, refreshPortfolio } from "@/lib/portfolio";
import { call } from "@/lib/tx";

const usd = (units: bigint) => `$${(Number(units) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const uniq = () => CHAINS.filter((c, i) => CHAINS.findIndex((x) => x.chain.id === c.chain.id) === i);

function useCash(address: string | null | undefined) {
  const [cash, setCash] = useState<Record<string, bigint> | null>(null);
  const load = async () => {
    if (!address) return;
    const rows = await Promise.all(uniq().map(async (c) => [c.key, await cashOf(c, address as Address)] as const));
    setCash(Object.fromEntries(rows));
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);
  return { cash, reload: load };
}

export function UsdDepositSheet({ onClose }: { onClose: () => void }) {
  const { address, send } = useWallet();
  const { cash, reload } = useCash(address);
  const [busy, setBusy] = useState<string>("");
  const [next, setNext] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!address) return;
    Promise.all(
      uniq().map(async (c) => {
        const last = (await clientFor(c).readContract({ address: c.usdc, abi: usdcAbi, functionName: "lastFaucet", args: [address] }).catch(() => 0n)) as bigint;
        return [c.key, last > 0n ? Number(last) * 1000 + 86400e3 : 0] as const;
      })
    ).then((r) => setNext(Object.fromEntries(r)));
  }, [address]);

  async function faucet(c: NeuronChain) {
    if (!address) return;
    setBusy(c.key);
    try {
      await send(c.chain, [call(c.usdc, usdcAbi, "faucet", [address])], () => {});
      toast(`+$100 test USDC on ${c.short} ✓`);
      setNext((n) => ({ ...n, [c.key]: Date.now() + 86400e3 }));
      await reload();
      void refreshPortfolio();
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <Sheet title="Deposit" onClose={onClose}>
      <p className="text-[0.875rem] text-ink-2">
        Everything on sasa is in dollars (USDC). This is the test version: get <b className="text-ink">$100 of free test USDC</b> a day on each chain.
      </p>
      <div className="grid gap-2 mt-4">
        {uniq().map((c) => {
          const wait = next[c.key] && next[c.key] > Date.now() ? next[c.key] : 0;
          return (
            <div key={c.key} className="flex items-center gap-3 rounded-2xl border border-line bg-paper p-3">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: c.color }} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-[0.9375rem]">{c.name}</span>
                <span className="block text-[0.75rem] text-ink-3 font-mono">{cash ? usd(cash[c.key] ?? 0n) : "…"}</span>
              </span>
              <button
                type="button"
                disabled={!!busy || !!wait}
                onClick={() => void faucet(c)}
                className="h-10 px-4 rounded-xl bg-emerald text-on-accent font-bold text-[0.875rem] shrink-0 disabled:opacity-40"
              >
                {busy === c.key ? "Sending…" : wait ? `Again in ${Math.ceil((wait - Date.now()) / 3600e3)}h` : "Get $100"}
              </button>
            </div>
          );
        })}
      </div>
      {address && (
        <div className="mt-4 rounded-2xl border border-line p-3">
          <div className="text-[0.75rem] text-ink-3">Or send test USDC to your address (same on every chain)</div>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(address).then(() => toast("Address copied"), () => {});
            }}
            className="mt-1 w-full text-left font-mono text-[0.8125rem] break-all"
          >
            {address}
          </button>
        </div>
      )}
      <p className="text-[0.6875rem] text-ink-3 mt-3">Test USDC has no value. Signed in with email, you never pay network fees.</p>
    </Sheet>
  );
}

export function UsdWithdrawSheet({ onClose }: { onClose: () => void }) {
  const { address, send } = useWallet();
  const { cash, reload } = useCash(address);
  const chains = uniq();
  const [chainKey, setChainKey] = useState(chains[0].key);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const c = chains.find((x) => x.key === chainKey) ?? chains[0];
  const have = cash?.[c.key] ?? 0n;
  const units = BigInt(Math.floor((Number(amount.replace(",", ".")) || 0) * 1e6 + 1e-6));
  const badTo = to.trim() !== "" && !isAddress(to.trim());
  const ready = units > 0n && units <= have && isAddress(to.trim()) && to.trim().toLowerCase() !== address?.toLowerCase();

  async function go() {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      await send(c.chain, [call(c.usdc, usdcAbi, "transfer", [to.trim() as Address, units])], () => {});
      toast(`Sent ${usd(units)} USDC ✓`);
      setAmount("");
      await reload();
      void refreshPortfolio();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Withdraw" onClose={onClose}>
      <p className="text-[0.875rem] text-ink-2">Send your dollars as USDC to any wallet.</p>
      {chains.length > 1 && (
        <div className="grid grid-cols-2 gap-2 mt-3" role="group" aria-label="From">
          {chains.map((x) => (
            <button
              key={x.key}
              type="button"
              aria-pressed={x.key === c.key}
              onClick={() => setChainKey(x.key)}
              className={"rounded-xl border p-2.5 text-left " + (x.key === c.key ? "border-emerald bg-emerald-soft" : "border-line")}
            >
              <span className="block font-semibold text-[0.875rem]">{x.short}</span>
              <span className="block font-mono text-[0.75rem] text-ink-3">{cash ? usd(cash[x.key] ?? 0n) : "…"}</span>
            </button>
          ))}
        </div>
      )}
      <label className="block mt-3">
        <span className="flex justify-between text-[0.75rem] text-ink-3">
          <span>Amount</span>
          <button type="button" onClick={() => setAmount((Number(have) / 1e6).toFixed(2))} className="font-bold text-emerald">
            Max {usd(have)}
          </button>
        </span>
        <span className="mt-1 flex items-center h-13 rounded-2xl border border-line bg-paper px-3 focus-within:border-emerald">
          <span className="text-ink-3 text-[1.25rem] mr-1">$</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ""))}
            inputMode="decimal"
            placeholder="0.00"
            className="flex-1 min-w-0 bg-transparent outline-none text-[1.125rem]"
          />
        </span>
      </label>
      <label className="block mt-3">
        <span className="text-[0.75rem] text-ink-3">To address</span>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="0x…"
          autoCapitalize="off"
          spellCheck={false}
          className={"mt-1 w-full h-12 rounded-2xl border bg-paper px-3 font-mono text-[0.875rem] outline-none " + (badTo ? "border-danger" : "border-line focus:border-emerald")}
        />
      </label>
      <p className="text-[0.75rem] text-ink-3 mt-2">Arrives as USDC on {c.name}. Double-check the address; transfers can&apos;t be undone.</p>
      {error && <p className="text-danger text-[0.8125rem] mt-2">{error}</p>}
      <button type="button" disabled={!ready || busy} onClick={() => void go()} className="mt-3 w-full h-13 rounded-2xl bg-ink text-mist font-bold disabled:opacity-40">
        {busy ? "Sending…" : units > have ? "Not enough cash" : `Send ${units > 0n ? usd(units) : ""} USDC`}
      </button>
    </Sheet>
  );
}
