"use client";

import Link from "next/link";
import { useState } from "react";
import { parseEther, toHex, type Address, type Hex } from "viem";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { CoinAvatar, ChainChip } from "@/components/coins";
import { factoryAbi } from "@/lib/abis";
import { CHAINS, SLIPPAGE_BPS, TARGET_USD, explorerTx, type NeuronChain } from "@/lib/config";
import { clientFor, isImageUrl, coinHref } from "@/lib/data";
import { friendlyError } from "@/lib/format";
import { fileToLogo } from "@/lib/image";

type Step = 1 | 2 | 3;
type ChainRun = { status: "waiting" | "working" | "done" | "failed"; note?: string; hash?: string };

const STEPS = ["About your coin", "Pick your chains", "Launch"];

export default function CreatePage() {
  const { address, switchTo, walletClient } = useWallet();
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [logo, setLogo] = useState("");
  const [picBusy, setPicBusy] = useState(false);
  const [picError, setPicError] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<string[]>(CHAINS.map((c) => c.key));
  const [firstBuy, setFirstBuy] = useState<Record<string, string>>({});
  const [launchKey, setLaunchKey] = useState<Hex | null>(null);
  const [runs, setRuns] = useState<Record<string, ChainRun>>({});
  const [busy, setBusy] = useState(false);

  const cleanSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  const step1Problems = [
    name.trim().length === 0 && "Give your coin a name.",
    cleanSymbol.length < 2 && "The ticker needs at least 2 letters or numbers.",
    logo !== "" && !isImageUrl(logo) && "That picture could not be used. Try another one.",
  ].filter(Boolean) as string[];

  const chosen = CHAINS.filter((c) => picked.includes(c.key));
  const buyWei = (c: NeuronChain): bigint | null => {
    const v = (firstBuy[c.key] ?? "").trim().replace(",", ".");
    if (v === "") return 0n;
    try {
      return parseEther(v as `${number}`);
    } catch {
      return null;
    }
  };
  const badBuy = chosen.some((c) => buyWei(c) === null);
  const allDone = chosen.length > 0 && chosen.every((c) => runs[c.key]?.status === "done");
  const anyDone = chosen.some((c) => runs[c.key]?.status === "done");

  function setRun(key: string, r: ChainRun) {
    setRuns((prev) => ({ ...prev, [key]: r }));
  }

  async function launchAll() {
    if (!address) return;
    // One key for this coin on every chain; kept so a retry joins the same coin.
    const key = launchKey ?? (toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex);
    setLaunchKey(key);
    setBusy(true);
    for (const c of chosen) {
      if (runs[c.key]?.status === "done") continue;
      try {
        setRun(c.key, { status: "working", note: `Switching your wallet to ${c.short}…` });
        await switchTo(c.chain);
        const value = buyWei(c) ?? 0n;
        const args = [name.trim(), cleanSymbol, logo, description.trim(), key, 0n] as const;
        const pub = clientFor(c);
        const sim = await pub.simulateContract({ account: address, address: c.factory, abi: factoryAbi, functionName: "launch", args, value });
        const expected = sim.result[2];
        const minOut = value > 0n ? (expected * (10_000n - SLIPPAGE_BPS)) / 10_000n : 0n;
        setRun(c.key, { status: "working", note: "Confirm in your wallet…" });
        const hash = await walletClient(c.chain).writeContract({
          chain: c.chain,
          account: address as Address,
          address: c.factory,
          abi: factoryAbi,
          functionName: "launch",
          args: [args[0], args[1], args[2], args[3], args[4], minOut],
          value,
        });
        setRun(c.key, { status: "working", note: "Waiting for the network…", hash });
        const r = await pub.waitForTransactionReceipt({ hash });
        if (r.status !== "success") throw new Error("The network rejected the transaction.");
        setRun(c.key, { status: "done", hash });
      } catch (e) {
        setRun(c.key, { status: "failed", note: friendlyError(e) });
        break; // stop here; the user can retry the rest
      }
    }
    setBusy(false);
  }

  if (allDone && launchKey && address) {
    return (
      <div className="max-w-xl mx-auto px-4 sm:px-6 py-14 text-center">
        <div className="mx-auto w-16 h-16 rounded-full bg-emerald-soft flex items-center justify-center">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#2FD39B" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12.5 L10 17 L19 7.5" />
          </svg>
        </div>
        <h1 className="font-display font-semibold text-[32px] mt-6">${cleanSymbol} is live on {chosen.length} chains</h1>
        <p className="text-ink-2 mt-3 text-[16px]">
          Buys on every chain now count toward one target of ${TARGET_USD}. Share it so people can find it.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {chosen.map((c) => (
            <ChainChip key={c.key} chain={c} />
          ))}
        </div>
        <Link href={coinHref({ creator: address, launchKey })} className="mt-8 h-13 rounded-xl bg-emerald text-on-accent font-semibold flex items-center justify-center">
          Go to your coin
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <h1 className="font-display font-semibold text-[32px] sm:text-[42px] tracking-tight">Create a coin</h1>
      <p className="text-ink-2 mt-2 text-[16px]">One form. Live on every chain you pick.</p>

      <ol aria-label="Steps" className="grid grid-cols-3 gap-2 mt-7">
        {STEPS.map((label, i) => {
          const on = i + 1 <= step;
          return (
            <li key={label} className={"pt-3 border-t-[3px] " + (on ? "border-emerald" : "border-line")}>
              <span className={"font-mono text-[12px] " + (on ? "text-emerald" : "text-ink-3")}>0{i + 1}</span>
              <span className={"block text-[13px] sm:text-[15px] font-semibold leading-tight mt-0.5 " + (on ? "text-ink" : "text-ink-3")}>{label}</span>
            </li>
          );
        })}
      </ol>

      <div className="mt-7 bg-surface border border-line rounded-3xl p-5 sm:p-8">
        {step === 1 && (
          <div className="grid gap-5">
            <Field label="Coin name" hint="For example: Harbor Cat">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} className={inputCls} placeholder="Harbor Cat" />
            </Field>
            <Field label="Ticker" hint="The short name people trade it by, like HCAT. Letters and numbers only.">
              <input value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={12} className={inputCls + " uppercase"} placeholder="HCAT" autoCapitalize="characters" />
            </Field>
            <div className="grid gap-2">
              <span className="text-[15px] font-semibold">Picture (optional)</span>
              <div className="flex items-center gap-4">
                <CoinAvatar logo={logo} symbol={cleanSymbol || name || "?"} size={64} />
                <div className="flex flex-col items-start gap-1.5">
                  <label className="h-11 px-5 rounded-xl border border-ink bg-surface font-semibold text-[15px] inline-flex items-center cursor-pointer">
                    {picBusy ? "Preparing…" : logo ? "Change picture" : "Upload picture"}
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      disabled={picBusy}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        setPicError("");
                        setPicBusy(true);
                        try {
                          setLogo(await fileToLogo(file));
                        } catch (err) {
                          setPicError((err as Error).message);
                        } finally {
                          setPicBusy(false);
                        }
                      }}
                    />
                  </label>
                  {logo && (
                    <button type="button" onClick={() => setLogo("")} className="text-[14px] text-ink-3 font-medium px-1">
                      Remove
                    </button>
                  )}
                </div>
              </div>
              <span className="text-[13px] text-ink-3 leading-snug">A square picture works best. It is stored with your coin on every chain.</span>
              {picError && <span className="text-[14px] text-danger">{picError}</span>}
            </div>
            <Field label="What is it about? (optional)">
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={280} className={inputCls + " h-auto py-3 resize-none"} placeholder="A cat who guards the harbor." />
            </Field>
            {step1Problems.length > 0 && (name || symbol) && <p className="text-[14px] text-danger">{step1Problems[0]}</p>}
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="font-display font-semibold text-[22px]">Where should it launch?</h2>
            <p className="text-ink-2 mt-2 text-[15px] leading-relaxed">
              More chains means more people can buy it, so it reaches the ${TARGET_USD} target faster. When it does, the
              chain with the most money wins and the coin carries on there.
            </p>
            <div className="mt-5 grid gap-3">
              {CHAINS.map((c) => {
                const on = picked.includes(c.key);
                return (
                  <div key={c.key} className={"rounded-2xl border-2 p-4 " + (on ? "border-emerald bg-emerald-soft" : "border-line bg-surface")}>
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => setPicked((p) => (on ? p.filter((k) => k !== c.key) : [...p, c.key]))}
                        className="w-5 h-5 accent-emerald"
                      />
                      <ChainChip chain={c} />
                      <span className="font-semibold">{c.name}</span>
                    </label>
                    {on && (
                      <label className="mt-3 grid gap-1.5">
                        <span className="text-[13px] text-ink-2">Buy some yourself on {c.short}? (optional, in ETH)</span>
                        <input
                          value={firstBuy[c.key] ?? ""}
                          onChange={(e) => setFirstBuy((f) => ({ ...f, [c.key]: e.target.value }))}
                          className={inputCls + " font-mono"}
                          placeholder="0.00"
                          inputMode="decimal"
                        />
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
            {badBuy && <p className="text-[14px] text-danger mt-3">One of the amounts doesn&apos;t look right.</p>}
          </div>
        )}

        {step === 3 && (
          <div className="grid gap-5">
            <div className="flex items-center gap-4">
              <CoinAvatar logo={logo} symbol={cleanSymbol} size={60} />
              <div className="min-w-0">
                <div className="font-display font-semibold text-[22px] truncate">{name.trim()}</div>
                <div className="text-ink-2 text-[14px]">${cleanSymbol}</div>
              </div>
            </div>
            <p className="text-[15px] text-ink-2 leading-relaxed">
              Your wallet will ask you to confirm once per chain. It switches networks for you along the way.
            </p>
            <ul className="grid gap-2">
              {chosen.map((c) => {
                const r = runs[c.key];
                return (
                  <li key={c.key} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-mist">
                    <span className="flex items-center gap-2">
                      <ChainChip chain={c} />
                      <span className="text-[14px] text-ink-2">{r?.note ?? (r?.status === "done" ? "Live" : "Waiting")}</span>
                    </span>
                    <span className="text-[14px] font-semibold">
                      {r?.status === "done" && r.hash ? (
                        <a href={explorerTx(c, r.hash)} target="_blank" rel="noreferrer" className="text-emerald">Live ✓</a>
                      ) : r?.status === "failed" ? (
                        <span className="text-danger">Stopped</span>
                      ) : r?.status === "working" ? (
                        <span className="text-ink-3">…</span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            <ul className="text-[14px] text-ink-2 grid gap-1.5">
              <li>• You earn 0.3% of every trade on your coin, on every chain, and after graduation too.</li>
              <li>• Buyers can always sell back before graduation. After it, the money is locked in a pool forever.</li>
              <li>• The name and ticker can&apos;t be changed later.</li>
            </ul>
          </div>
        )}
      </div>

      <div className="mt-5 flex gap-3">
        {step > 1 && !anyDone && (
          <button type="button" onClick={() => setStep((s) => (s - 1) as Step)} className="h-13 px-6 rounded-xl border border-ink font-semibold" disabled={busy}>
            Back
          </button>
        )}
        <div className="flex-1">
          {step === 1 && (
            <button type="button" disabled={step1Problems.length > 0} onClick={() => setStep(2)} className={primaryCls}>
              Next
            </button>
          )}
          {step === 2 && (
            <button type="button" disabled={chosen.length === 0 || badBuy} onClick={() => setStep(3)} className={primaryCls}>
              Next
            </button>
          )}
          {step === 3 &&
            (address ? (
              <button type="button" disabled={busy} onClick={launchAll} className={primaryCls}>
                {busy ? "Launching…" : anyDone ? "Continue on the remaining chains" : `Launch on ${chosen.length} chain${chosen.length > 1 ? "s" : ""}`}
              </button>
            ) : (
              <ConnectButton full />
            ))}
        </div>
      </div>
    </div>
  );
}

const inputCls = "w-full h-12 px-4 rounded-xl border border-line bg-paper text-ink placeholder:text-ink-3/70 focus:border-emerald focus:bg-surface";
const primaryCls = "w-full h-13 rounded-xl bg-emerald text-on-accent font-semibold text-[16px] hover:bg-emerald-dark disabled:opacity-40 disabled:hover:bg-emerald";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-2">
      <span className="text-[15px] font-semibold">{label}</span>
      {children}
      {hint && <span className="text-[13px] text-ink-3 leading-snug">{hint}</span>}
    </label>
  );
}
