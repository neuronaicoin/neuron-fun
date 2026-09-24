"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { parseEther, toHex, zeroAddress, type Address } from "viem";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { CoinAvatar } from "@/components/coins";
import { launcherAbi, factoryAbi, tokenAbi } from "@/lib/abis";
import { ADDR, SLIPPAGE_BPS, chain, explorerTx } from "@/lib/config";
import { fetchParentAddresses, publicClient, isImageUrl } from "@/lib/data";
import { fmtEth, friendlyError } from "@/lib/format";
import { fileToLogo } from "@/lib/image";

type ParentOption = { token: Address; name: string; symbol: string; logo: string };
type Step = 1 | 2 | 3;

const STEPS = ["About your coin", "Pick a family", "Check and create"];

export default function CreatePage() {
  const { address, onRightNetwork, walletClient, switchNetwork } = useWallet();
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [logo, setLogo] = useState("");
  const [picBusy, setPicBusy] = useState(false);
  const [picError, setPicError] = useState("");
  const [description, setDescription] = useState("");
  const [xLink, setXLink] = useState("");
  const [parents, setParents] = useState<ParentOption[] | null>(null);
  const [parent, setParent] = useState<Address | null>(null);
  const [firstBuy, setFirstBuy] = useState("");
  const [fee, setFee] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ token: Address; hash: string } | null>(null);

  useEffect(() => {
    publicClient.readContract({ address: ADDR.factory, abi: factoryAbi, functionName: "launchFee" }).then(setFee).catch(() => {});
    fetchParentAddresses()
      .then(async (addrs) => {
        const list = await Promise.all(
          addrs.map(async (token) => {
            const [n, s, l] = await Promise.all([
              publicClient.readContract({ address: token, abi: tokenAbi, functionName: "name" }),
              publicClient.readContract({ address: token, abi: tokenAbi, functionName: "symbol" }),
              publicClient.readContract({ address: token, abi: tokenAbi, functionName: "logo" }).catch(() => ""),
            ]);
            return { token, name: n, symbol: s, logo: l };
          })
        );
        setParents(list);
        if (list.length === 1) setParent(list[0].token);
      })
      .catch(() => setParents([]));
  }, []);

  const cleanSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  const step1Problems = [
    name.trim().length === 0 && "Give your coin a name.",
    name.trim().length > 32 && "Keep the name under 32 characters.",
    cleanSymbol.length < 2 && "The ticker needs at least 2 letters or numbers.",
    logo !== "" && !isImageUrl(logo) && "That picture could not be used. Try another one.",
    xLink.trim() !== "" && !/^https:\/\/(x|twitter)\.com\//i.test(xLink.trim()) && "The X link must look like https://x.com/yourname",
  ].filter(Boolean) as string[];

  let firstBuyWei = 0n;
  let firstBuyBad = false;
  try {
    firstBuyWei = firstBuy.trim() === "" ? 0n : parseEther(firstBuy.trim() as `${number}`);
  } catch {
    firstBuyBad = true;
  }
  const chosen = parents?.find((p) => p.token === parent) ?? null;

  async function create() {
    if (!address || fee === null || !parent) return;
    setBusy(true);
    setError("");
    try {
      if (!onRightNetwork) await switchNetwork();
      const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const params = {
        name: name.trim(),
        symbol: cleanSymbol,
        logo,
        description: description.trim(),
        socials: { twitter: xLink.trim(), telegram: "", discord: "", website: "", farcaster: "" },
        creatorFeeRecipient: zeroAddress,
        creatorTaxBps: 0,
        expectedEconomics: `0x${"0".repeat(64)}` as `0x${string}`,
        salt,
      };
      const value = fee + firstBuyWei;
      // Dry run first: catches problems before the wallet pops up and tells
      // us how many tokens the first buy should get.
      const sim = await publicClient.simulateContract({
        account: address,
        address: ADDR.launcher,
        abi: launcherAbi,
        functionName: "launch",
        args: [params, parent, 0n],
        value,
      });
      const [token, , expectedTokens] = sim.result;
      const minOut = firstBuyWei > 0n ? (expectedTokens * (10_000n - SLIPPAGE_BPS)) / 10_000n : 0n;
      const hash = await walletClient().writeContract({
        chain,
        account: address,
        address: ADDR.launcher,
        abi: launcherAbi,
        functionName: "launch",
        args: [params, parent, minOut],
        value,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The network rejected the transaction.");
      setDone({ token, hash });
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="max-w-xl mx-auto px-4 sm:px-6 py-14 text-center">
        <div className="mx-auto w-16 h-16 rounded-full bg-emerald-soft flex items-center justify-center">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#0F6B52" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12.5 L10 17 L19 7.5" />
          </svg>
        </div>
        <h1 className="font-display font-semibold text-[32px] mt-6">Your coin is live</h1>
        <p className="text-ink-2 mt-3 text-[16px]">
          ${cleanSymbol} is now part of the ${chosen?.symbol} family. Share it so people can find it.
        </p>
        <div className="mt-8 grid gap-3">
          <Link href={`/coin/?a=${done.token}`} className="h-13 rounded-xl bg-emerald text-white font-semibold flex items-center justify-center">
            Go to your coin
          </Link>
          <a href={explorerTx(done.hash)} target="_blank" rel="noreferrer" className="h-12 rounded-xl border border-line bg-white font-semibold flex items-center justify-center">
            View the transaction
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <h1 className="font-display font-semibold text-[32px] sm:text-[42px] tracking-tight">Create a coin</h1>
      <p className="text-ink-2 mt-2 text-[16px]">Three quick steps. It takes about a minute.</p>

      <ol aria-label="Steps" className="grid grid-cols-3 gap-2 mt-7">
        {STEPS.map((label, i) => {
          const done_ = i + 1 <= step;
          return (
            <li key={label} className={"pt-3 border-t-[3px] " + (done_ ? "border-emerald" : "border-line")}>
              <span className={"font-mono text-[12px] " + (done_ ? "text-emerald" : "text-ink-3")}>0{i + 1}</span>
              <span className={"block text-[13px] sm:text-[15px] font-semibold leading-tight mt-0.5 " + (done_ ? "text-ink" : "text-ink-3")}>{label}</span>
            </li>
          );
        })}
      </ol>

      <div className="mt-7 bg-white border border-line rounded-3xl p-5 sm:p-8">
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
                  <label className="h-11 px-5 rounded-xl border border-ink bg-white font-semibold text-[15px] inline-flex items-center cursor-pointer">
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
              <span className="text-[13px] text-ink-3 leading-snug">
                A square picture works best. We shrink it so it is stored with your coin forever.
              </span>
              {picError && <span className="text-[14px] text-danger">{picError}</span>}
            </div>
            <Field label="What is it about? (optional)">
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={280} className={inputCls + " h-auto py-3 resize-none"} placeholder="A cat who guards the harbor." />
            </Field>
            <Field label="X link (optional)">
              <input value={xLink} onChange={(e) => setXLink(e.target.value)} className={inputCls} placeholder="https://x.com/yourcoin" inputMode="url" />
            </Field>
            {step1Problems.length > 0 && (name || symbol) && <p className="text-[14px] text-danger">{step1Problems[0]}</p>}
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="font-display font-semibold text-[22px]">Pick a family</h2>
            <p className="text-ink-2 mt-2 text-[15px] leading-relaxed">
              Part of every trade on your coin buys this coin and burns it. Your coin is traded with ETH, so the family
              coin&apos;s price never pulls yours down.
            </p>
            <div className="mt-5 grid gap-3" role="radiogroup" aria-label="Family coin">
              {parents === null && <div className="h-20 rounded-2xl bg-line/60 animate-pulse" />}
              {parents?.length === 0 && <p className="text-ink-2">No family coins are available right now.</p>}
              {parents?.map((p) => {
                const sel = parent === p.token;
                return (
                  <button
                    key={p.token}
                    type="button"
                    role="radio"
                    aria-checked={sel}
                    onClick={() => setParent(p.token)}
                    className={"flex items-center gap-4 p-4 rounded-2xl text-left border-2 " + (sel ? "border-emerald bg-[#eef7f3]" : "border-line bg-white")}
                  >
                    <CoinAvatar logo={p.logo} symbol={p.symbol} size={46} />
                    <span className="flex-1 min-w-0">
                      <span className="block font-semibold text-[16px] truncate">{p.name}</span>
                      <span className="block text-[13px] text-ink-3">${p.symbol}</span>
                    </span>
                    <span className={"w-6 h-6 rounded-full border-2 flex items-center justify-center " + (sel ? "border-emerald" : "border-line")} aria-hidden="true">
                      {sel && <span className="w-3 h-3 rounded-full bg-emerald" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="grid gap-5">
            <div className="flex items-center gap-4">
              <CoinAvatar logo={logo} symbol={cleanSymbol} size={60} />
              <div className="min-w-0">
                <div className="font-display font-semibold text-[22px] truncate">{name.trim()}</div>
                <div className="text-ink-2 text-[14px]">${cleanSymbol} · family of ${chosen?.symbol}</div>
              </div>
            </div>
            <Field label="Buy some of your own coin first? (optional)" hint="Enter an ETH amount, or leave empty. You get the same price as everyone else.">
              <input value={firstBuy} onChange={(e) => setFirstBuy(e.target.value.replace(",", "."))} className={inputCls + " font-mono"} placeholder="0.00" inputMode="decimal" />
            </Field>
            {firstBuyBad && <p className="text-[14px] text-danger">That amount doesn&apos;t look right.</p>}
            <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-[15px] bg-mist rounded-2xl p-4">
              <dt className="text-ink-2">Creation fee</dt>
              <dd className="font-mono">{fmtEth(fee, 5)}</dd>
              <dt className="text-ink-2">Your first buy</dt>
              <dd className="font-mono">{fmtEth(firstBuyWei, 5)}</dd>
              <dt className="font-semibold pt-2 border-t border-line">Total</dt>
              <dd className="font-mono font-semibold pt-2 border-t border-line">{fee === null ? "—" : fmtEth(fee + firstBuyWei, 5)}</dd>
            </dl>
            <ul className="text-[14px] text-ink-2 grid gap-1.5">
              <li>• You earn part of every trading fee on your coin.</li>
              <li>• The money pool is locked forever. Nobody can take it out, including you.</li>
              <li>• The name and ticker cannot be changed later.</li>
            </ul>
            {error && <p className="text-[14px] text-danger" role="alert">{error}</p>}
          </div>
        )}
      </div>

      <div className="mt-5 flex gap-3">
        {step > 1 && (
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
            <button type="button" disabled={!parent} onClick={() => setStep(3)} className={primaryCls}>
              Next
            </button>
          )}
          {step === 3 &&
            (address ? (
              <button type="button" disabled={busy || firstBuyBad || fee === null || !parent} onClick={create} className={primaryCls}>
                {busy ? "Confirm in your wallet…" : "Create my coin"}
              </button>
            ) : (
              <ConnectButton full />
            ))}
        </div>
      </div>
    </div>
  );
}

const inputCls = "w-full h-12 px-4 rounded-xl border border-line bg-paper text-ink placeholder:text-ink-3/70 focus:border-emerald focus:bg-white";
const primaryCls = "w-full h-13 rounded-xl bg-emerald text-white font-semibold text-[16px] hover:bg-emerald-dark disabled:opacity-40 disabled:hover:bg-emerald";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-2">
      <span className="text-[15px] font-semibold">{label}</span>
      {children}
      {hint && <span className="text-[13px] text-ink-3 leading-snug">{hint}</span>}
    </label>
  );
}
