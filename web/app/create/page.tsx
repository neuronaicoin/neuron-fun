"use client";

import { CurveSim } from "@/components/curvesim";
import { coinShareUrl, postOnX } from "@/components/share";
import { toast } from "@/components/alerts";
import { EMPTY_DRAFT, LinkFields, draftProblems, draftToLinks, type LinkDraft } from "@/components/coinlinks";
import { saveLinks } from "@/lib/coinlinks";
import { AiLaunch } from "@/components/ailaunch";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { encodeAbiParameters, keccak256, maxUint256, numberToHex, toHex, type Address, type Hex } from "viem";
import { useWallet } from "@/components/wallet";
import { useMoney } from "@/lib/portfolio";
import { ConnectButton } from "@/components/chrome";
import { ChainChip, usd } from "@/components/coins";
import { factoryAbi, usdcAbi } from "@/lib/abis";
import { overCap, useSafety } from "@/lib/safety";
import { CHAINS, SLIPPAGE_BPS, TARGET_USD, explorerTx, type NeuronChain } from "@/lib/config";
import { clientFor, coinHref, isImageUrl } from "@/lib/data";
import { friendlyError } from "@/lib/format";
import { fileToLogo } from "@/lib/image";
import { call } from "@/lib/tx";
import { fetchPrices } from "@/lib/price";

type Terms = { v0: bigint; t0: bigint; feeBps: bigint };
type Run = { status: "working" | "done" | "failed"; note?: string; hash?: string };
const SUPPLY = 1_000_000_000n * 10n ** 18n;
const DEV_OPTIONS = [0, 1, 2, 5, 10];

/** Storage slot of `owner`'s allowance for `spender` in TestUSDC (OpenZeppelin ERC20 layout). */
function usdcAllowanceSlot(owner: Address, spender: Address) {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, 1n]));
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, inner]));
}

/** Where the creator's 0.3% of every trade goes. Fixed at launch. */
const FEE_MODES = [
  { id: 0, key: "creator", title: "To you", text: "Your 0.3% of every trade builds up for you to collect." },
  { id: 1, key: "buyback", title: "Buyback & burn", text: "Your share buys the coin back and burns it, so the supply keeps shrinking." },
  { id: 2, key: "holders", title: "To holders", text: "Your share is paid out to everyone holding the coin, in USDC." },
] as const;

/** Native coin needed to buy `tokens` from a fresh curve, fee included. */
function costFor(terms: Terms, tokens: bigint): bigint {
  if (tokens === 0n) return 0n;
  const k = terms.v0 * terms.t0;
  const after = terms.t0 - tokens;
  const net = (k + after - 1n) / after - terms.v0;
  return net + (net * terms.feeBps + 9_999n) / 10_000n + 1n;
}

export default function CreatePage() {
  const { address, send, signMessage } = useWallet();
  // Optional X / Telegram / website, saved once the coin is live.
  const [links, setLinks] = useState<LinkDraft>(EMPTY_DRAFT);
  const linkBad = draftProblems(links);
  const linksSaved = useRef(false);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [logo, setLogo] = useState("");
  const [picBusy, setPicBusy] = useState(false);
  const [picError, setPicError] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<string[]>(CHAINS.map((c) => c.key));
  const [devPct, setDevPct] = useState(0);
  // Or a dollar amount (typed, or 10% of your cash), split evenly across the chosen chains.
  const [devUsd, setDevUsd] = useState("");
  const { portfolio } = useMoney();
  const [feeMode, setFeeMode] = useState<0 | 1 | 2>(0);
  // Optional creator lock (seconds): your coins can't be sold or moved until it ends.
  const [lock, setLock] = useState<0 | 3600 | 86400>(0);
  // "Create your coin with AI": the same page with the AI helper on top (?ai=1).
  const [aiMode, setAiMode] = useState(false);
  useEffect(() => {
    setAiMode(new URLSearchParams(window.location.search).get("ai") === "1");
  }, []);
  const setMode = (on: boolean) => {
    setAiMode(on);
    const q = new URLSearchParams(window.location.search);
    if (on) q.set("ai", "1");
    else q.delete("ai");
    const rest = q.toString();
    window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const [terms, setTerms] = useState<Record<string, Terms>>({});
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [launchKey, setLaunchKey] = useState<Hex | null>(null);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [busy, setBusy] = useState(false);
  const safety = useSafety();

  useEffect(() => {
    fetchPrices().then((p) => setEthUsd(p?.ETH ?? null));
    Promise.all(
      CHAINS.map(async (c) => {
        const r = (await clientFor(c).readContract({ address: c.factory, abi: factoryAbi, functionName: "config" })) as readonly [bigint, bigint, bigint, bigint, number, number, bigint];
        return [c.key, { v0: r[0], t0: r[1], feeBps: BigInt(r[4]) }] as const;
      })
    )
      .then((e) => setTerms(Object.fromEntries(e)))
      .catch(() => {});
  }, []);

  const cleanSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  const chosen = CHAINS.filter((c) => picked.includes(c.key));
  const devTokens = (SUPPLY * BigInt(devPct)) / 100n;
  const customUsd = Number(devUsd.replace(/[$,\s]/g, ""));
  const custom = devUsd.trim() !== "" && Number.isFinite(customUsd) && customUsd > 0 && ethUsd !== null;
  const devCost = (c: NeuronChain) => {
    if (custom && chosen.length) return BigInt(Math.floor((customUsd / chosen.length / (ethUsd as number)) * 1e18));
    return terms[c.key] ? costFor(terms[c.key], devTokens) : 0n;
  };
  const totalDevEth = chosen.reduce((s, c) => s + Number(devCost(c)) / 1e18, 0);
  const startMc = useMemo(() => {
    const t = terms[CHAINS[0].key];
    if (!t || !ethUsd) return null;
    return (Number(t.v0) / Number(t.t0)) * 1e9 * ethUsd;
  }, [terms, ethUsd]);

  // Beta locks on the live contracts: a paused chain takes no launches; a full one no first buy.
  const pausedChain = chosen.find((c) => safety[c.key]?.paused);
  const fullChain = chosen.find((c) => overCap(safety[c.key], (devCost(c) * 100n) / 101n));
  const problem =
    name.trim().length === 0
      ? "Give your coin a name."
      : cleanSymbol.length < 2
        ? "The ticker needs at least 2 letters or numbers."
        : logo !== "" && !isImageUrl(logo)
          ? "That picture could not be used."
          : linkBad.x || linkBad.telegram || linkBad.website
            ? "One of your links doesn't look right. Fix it or leave it empty."
          : chosen.length === 0
            ? "Pick at least one chain."
            : pausedChain
              ? `Launching on ${pausedChain.short} is paused for a moment. Untick it to launch on the others.`
              : fullChain
                ? `${fullChain.short} is at its beta capacity, so your first buy there can't go through. Lower it, or untick ${fullChain.short}.`
                : "";
  const allDone = chosen.length > 0 && chosen.every((c) => runs[c.key]?.status === "done");
  const anyDone = chosen.some((c) => runs[c.key]?.status === "done");

  // Save the links as soon as the coin exists (its id is known before launch).
  useEffect(() => {
    if (!anyDone || !launchKey || !address || linksSaved.current) return;
    const l = draftToLinks(links);
    if (!l.x && !l.telegram && !l.website) return;
    linksSaved.current = true;
    saveLinks(signMessage, `${address.toLowerCase()}:${launchKey}`, l).catch(() => {
      linksSaved.current = false;
      toast("Your coin is live, but its links didn't save. Add them from the coin page.");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyDone, launchKey, address]);

  async function launch() {
    if (!address || problem) return;
    const key = launchKey ?? (toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex);
    setLaunchKey(key);
    setBusy(true);
    for (const c of chosen) {
      if (runs[c.key]?.status === "done") continue;
      const set = (r: Run) => setRuns((p) => ({ ...p, [c.key]: r }));
      try {
        // The creator's first buy, in USDC (0 = none). Paid by approving the factory.
        const value = devCost(c);
        const args = [name.trim(), cleanSymbol, logo, description.trim(), key, value, 0n, feeMode] as const;
        const pub = clientFor(c);
        set({ status: "working", note: "Checking…" });
        // Simulate as if the factory were already approved (the approve goes in the same bundle).
        const override = [
          {
            address: c.usdc,
            stateDiff: [{ slot: usdcAllowanceSlot(address, c.factory), value: numberToHex(maxUint256, { size: 32 }) }],
          },
        ];
        const sim =
          lock > 0
            ? await pub.simulateContract({ account: address, address: c.factory, abi: factoryAbi, functionName: "launchLocked", args: [...args, BigInt(lock)], stateOverride: override })
            : await pub.simulateContract({ account: address, address: c.factory, abi: factoryAbi, functionName: "launch", args, stateOverride: override });
        const minOut = value > 0n ? (sim.result[2] * (10_000n - SLIPPAGE_BPS)) / 10_000n : 0n;
        const calls = [];
        if (value > 0n) {
          const allowance = (await pub.readContract({ address: c.usdc, abi: usdcAbi, functionName: "allowance", args: [address, c.factory] })) as bigint;
          if (allowance < value) calls.push(call(c.usdc, usdcAbi, "approve", [c.factory, value]));
        }
        calls.push(
          lock > 0
            ? call(c.factory, factoryAbi, "launchLocked", [args[0], args[1], args[2], args[3], args[4], value, minOut, feeMode, BigInt(lock)])
            : call(c.factory, factoryAbi, "launch", [args[0], args[1], args[2], args[3], args[4], value, minOut, feeMode])
        );
        const hash = await send(c.chain, calls, (note) => set({ status: "working", note }));
        set({ status: "done", hash });
      } catch (e) {
        set({ status: "failed", note: friendlyError(e) });
        break;
      }
    }
    setBusy(false);
  }

  if (allDone && launchKey && address) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <div className="mx-auto w-16 h-16 rounded-full bg-emerald-soft flex items-center justify-center text-[1.875rem]">🎉</div>
        <h1 className="font-display font-bold text-[1.875rem] mt-6">${cleanSymbol} is live on {chosen.length} chain{chosen.length > 1 ? "s" : ""}</h1>
        <p className="text-ink-2 mt-3">Every buy, on every chain, now counts toward one {usd(TARGET_USD)} target. Share it so people can find it.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {chosen.map((c) => <ChainChip key={c.key} chain={c} />)}
        </div>
        <button
          type="button"
          onClick={() =>
            postOnX(
              `I just launched $${cleanSymbol} on @sasapadfun 🚀 Live on ${chosen.map((c) => c.short).join(" + ")} at once. Be early 👇`,
              coinShareUrl(`${address.toLowerCase()}:${launchKey}`)
            )
          }
          className="mt-8 w-full h-13 rounded-2xl bg-ink text-mist font-bold flex items-center justify-center gap-2"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          Share your coin on X
        </button>
        <p className="text-[0.75rem] text-ink-3 mt-2">First share earns you 100 points. Coins that get shared get buyers.</p>
        <Link href={coinHref({ creator: address, launchKey })} className="mt-4 h-13 rounded-2xl bg-emerald text-on-accent font-bold flex items-center justify-center">
          Go to your coin
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 sm:py-12">
      <p className="hidden sm:block font-mono text-[0.75rem] tracking-[0.16em] text-emerald">ONE COIN · EVERY CHAIN</p>
      <h1 className="font-display font-bold text-[1.625rem] sm:text-[2.875rem] tracking-tight sm:mt-2">
        {aiMode ? (
          <>
            Create your coin <span className="bg-gradient-to-r from-emerald to-[#f472b6] bg-clip-text text-transparent">with AI</span>
          </>
        ) : (
          "Launch a coin"
        )}
      </h1>
      <p className="text-ink-2 mt-1 sm:mt-2 text-[0.875rem] sm:text-[1rem] max-w-2xl">
        {aiMode
          ? "Describe your idea, pick the design you love, then launch it on every chain you choose. Everything stays editable."
          : "A name, a ticker and a picture. It goes live on every chain you pick, in one go. Everything else is optional."}
      </p>
      {aiMode && (
        <button type="button" onClick={() => setMode(false)} className="mt-2 text-[0.875rem] font-semibold text-ink-3 hover:text-ink">
          ← Create without AI
        </button>
      )}

      {!aiMode ? (
        <button
          type="button"
          onClick={() => setMode(true)}
          className="group mt-4 sm:mt-6 w-full sm:w-auto inline-flex items-center gap-3 rounded-2xl pl-3 pr-5 py-3 text-left text-white bg-gradient-to-r from-emerald via-[#ff7a2e] to-[#f472b6] shadow-[0_10px_30px_rgba(242,96,12,0.3)] hover:brightness-105"
        >
          <span className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center text-[1.25rem] shrink-0" aria-hidden="true">
            ✨
          </span>
          <span className="min-w-0">
            <span className="block font-bold text-[1rem] sm:text-[1.0625rem] leading-tight">Create your coin with AI</span>
            <span className="block text-[0.8125rem] text-white/85 leading-snug mt-0.5">One sentence in. Name, ticker, story and logo out.</span>
          </span>
          <span className="ml-auto pl-2 text-[1.25rem] transition-transform group-hover:translate-x-0.5" aria-hidden="true">
            →
          </span>
        </button>
      ) : (
        <>
          <div className="mt-4 sm:mt-6 lg:max-w-[calc(100%-404px)]">
            <AiLaunch
              onPick={(p) => {
                setName(p.name);
                setSymbol(p.symbol);
                setDescription(p.description);
                if (p.logo) {
                  setLogo(p.logo);
                  setPicError("");
                }
              }}
              onLogo={(l) => {
                setLogo(l);
                setPicError("");
              }}
            />
          </div>
          <div className="flex items-center gap-3 text-[0.8125rem] text-ink-3 mt-6 lg:max-w-[calc(100%-404px)]" aria-hidden="true">
            <span className="h-px flex-1 bg-line" />
            your coin, ready to edit
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}

      <div className="mt-4 sm:mt-6 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[1fr_380px] lg:items-start">
        <div className="rounded-3xl border border-line bg-surface p-4 sm:p-7 grid gap-5 sm:gap-6">
          <div className="grid gap-4 sm:gap-5 grid-cols-[96px_1fr] sm:grid-cols-[180px_1fr] items-start">
            <label className="relative aspect-square rounded-2xl border-2 border-dashed border-line hover:border-emerald bg-paper flex flex-col items-center justify-center text-center cursor-pointer overflow-hidden">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logo} alt="" className="absolute inset-0 w-full h-full object-cover" />
              ) : (
                <>
                  <span className="text-[1.5rem] sm:text-[1.75rem]" aria-hidden="true">＋</span>
                  <span className="text-[0.8125rem] sm:text-[0.9375rem] font-bold text-ink mt-1">{picBusy ? "Preparing…" : "Picture"}</span>
                  <span className="hidden sm:block text-[0.75rem] text-ink-3 mt-1 px-3">Square works best</span>
                </>
              )}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                disabled={picBusy}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  setPicError("");
                  setPicBusy(true);
                  try {
                    setLogo(await fileToLogo(f));
                  } catch (err) {
                    setPicError((err as Error).message);
                  } finally {
                    setPicBusy(false);
                  }
                }}
              />
            </label>
            <div className="grid gap-4 content-start">
              <Field label="Name">
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="Harbor Cat" className={input} />
              </Field>
              <Field label="Ticker" right={`${cleanSymbol.length}/10`}>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-3">$</span>
                  <input value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={12} placeholder="HCAT" autoCapitalize="characters" className={input + " pl-8 uppercase"} />
                </div>
              </Field>
              {logo && (
                <button type="button" onClick={() => setLogo("")} className="justify-self-start text-[0.8125rem] text-ink-3 underline">
                  Remove picture
                </button>
              )}
              {picError && <p className="text-[0.8125rem] text-danger">{picError}</p>}
            </div>
          </div>

          <Field label="Description" hint="optional">
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={280} placeholder="What's the idea? Tell your future holders a little about it." className={input + " h-auto py-3 resize-none"} />
          </Field>

          <div className="grid gap-2">
            <span className="flex items-baseline justify-between text-[0.9375rem] font-bold text-ink">
              <span>
                Links <span className="text-ink-3 font-normal">optional</span>
              </span>
              <span className="text-[0.75rem] text-ink-3 font-normal">you can add them later too</span>
            </span>
            <LinkFields value={links} onChange={setLinks} />
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-[0.9375rem] font-bold text-ink">Chains</span>
              <span className="text-[0.875rem] sm:text-[0.9375rem] font-bold text-emerald">More chains, more buyers ↗</span>
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
              {CHAINS.map((c) => {
                const on = picked.includes(c.key);
                return (
                  <button
                    key={c.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setPicked((p) => (on ? p.filter((k) => k !== c.key) : [...p, c.key]))}
                    className={"h-11 px-4 rounded-2xl border-2 flex items-center gap-2 font-semibold text-[0.875rem] " + (on ? "text-ink" : "border-line text-ink-3")}
                    style={on ? { borderColor: c.color } : undefined}
                  >
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: c.color, opacity: on ? 1 : 0.35 }} aria-hidden="true" />
                    {c.name}
                    <span aria-hidden="true">{on ? "✓" : ""}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-[0.9375rem] font-bold text-ink">Where your fees go</span>
              <span className="text-[0.75rem] text-ink-3">can&apos;t be changed later</span>
            </div>
            <div className="grid gap-2 mt-2 sm:grid-cols-3" role="radiogroup" aria-label="Where your fees go">
              {FEE_MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  role="radio"
                  aria-checked={feeMode === m.id}
                  onClick={() => setFeeMode(m.id)}
                  className={"text-left rounded-2xl border-2 p-3.5 " + (feeMode === m.id ? "border-emerald bg-emerald-soft" : "border-line")}
                >
                  <span className="block font-semibold text-[0.875rem]">{m.title}</span>
                  <span className="block text-[0.75rem] text-ink-3 mt-1 leading-snug">{m.text}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[0.9375rem] font-bold text-ink">Lock your coins</span>
              <span className="text-[0.75rem] text-ink-3 text-right">optional · shows buyers you won&apos;t dump</span>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2" role="radiogroup" aria-label="Lock your coins">
              {(
                [
                  [0, "No lock", "Sell any time"],
                  [3600, "1 hour", "🔒 badge on your coin"],
                  [86400, "24 hours", "🔒 strongest signal"],
                ] as const
              ).map(([s, title, text]) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={lock === s}
                  onClick={() => setLock(s)}
                  className={"text-left rounded-2xl border-2 p-3 sm:p-3.5 " + (lock === s ? "border-emerald bg-emerald-soft" : "border-line")}
                >
                  <span className="block font-semibold text-[0.875rem]">{title}</span>
                  <span className="block text-[0.6875rem] sm:text-[0.75rem] text-ink-3 mt-1 leading-snug">{text}</span>
                </button>
              ))}
            </div>
            {lock > 0 && (
              <p className="text-[0.75rem] text-ink-3 mt-2 leading-snug">
                For {lock === 3600 ? "1 hour" : "24 hours"} after launch, the coins in your wallet can&apos;t be sold or sent anywhere, on every chain
                you pick. You can still buy more. Nobody, not even you, can end it early.
              </p>
            )}
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-[0.9375rem] font-bold text-ink">Buy some yourself</span>
              <span className="text-[0.75rem] text-ink-3">optional · lands first, so nobody gets in before you</span>
            </div>
            <div className="grid grid-cols-5 gap-2 mt-2">
              {DEV_OPTIONS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setDevPct(p);
                    setDevUsd("");
                  }}
                  aria-pressed={!custom && devPct === p}
                  className={"h-11 rounded-2xl border-2 text-[0.875rem] font-semibold " + (!custom && devPct === p ? "border-emerald text-ink bg-emerald-soft" : "border-line text-ink-2")}
                >
                  {p === 0 ? "None" : `${p}%`}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2 mt-2">
              <label className={"flex items-center gap-2 h-11 rounded-2xl border-2 px-3 bg-paper " + (custom ? "border-emerald" : "border-line") + " focus-within:border-emerald"}>
                <span className="text-ink-3 font-mono">$</span>
                <input
                  value={devUsd}
                  onChange={(e) => setDevUsd(e.target.value.replace(/[^0-9.,]/g, ""))}
                  inputMode="decimal"
                  placeholder="Or type an amount"
                  aria-label="Amount to buy yourself, in dollars"
                  style={{ outline: "none" }}
                  className="flex-1 min-w-0 bg-transparent font-mono text-[0.9375rem]"
                />
              </label>
              <button
                type="button"
                disabled={!portfolio || portfolio.cashUsd <= 0}
                onClick={() => portfolio && setDevUsd((Math.floor(portfolio.cashUsd * 10) / 100).toFixed(2))}
                className="h-11 px-3 rounded-2xl border-2 border-line text-[0.8125rem] font-semibold text-ink-2 whitespace-nowrap hover:border-emerald disabled:opacity-40"
              >
                10% cash
              </button>
            </div>
            {(custom || devPct > 0) && (
              <p className="text-[0.8125rem] text-ink-2 mt-2">
                {custom ? `${usd(customUsd / Math.max(1, chosen.length), 2)} on each chain` : `${devPct}% of the supply on each chain`} · about{" "}
                <span className="font-mono text-ink">{ethUsd ? usd(totalDevEth * ethUsd, 2) : `${totalDevEth.toFixed(5)} ETH`}</span> in total
                {portfolio && ethUsd && totalDevEth * ethUsd > portfolio.cashUsd && <span className="text-danger"> · more than your cash</span>}
              </p>
            )}
          </div>

          {launchKey && (
            <ul className="grid gap-2">
              {chosen.map((c) => {
                const r = runs[c.key];
                return (
                  <li key={c.key} className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-paper text-[0.875rem]">
                    <span className="flex items-center gap-2">
                      <ChainChip chain={c} />
                      <span className="text-ink-2">{r?.note ?? (r?.status === "done" ? "Live" : "Waiting")}</span>
                    </span>
                    {r?.status === "done" && r.hash && (
                      <a href={explorerTx(c, r.hash)} target="_blank" rel="noreferrer" className="text-up font-semibold">Live ✓</a>
                    )}
                    {r?.status === "failed" && <span className="text-danger font-semibold">Stopped</span>}
                  </li>
                );
              })}
            </ul>
          )}

          <div>
            {address ? (
              <button
                type="button"
                onClick={launch}
                disabled={!!problem || busy}
                className="w-full h-14 rounded-2xl bg-emerald text-on-accent text-[1.0625rem] font-bold hover:bg-emerald-dark disabled:opacity-40"
              >
                {busy ? "Launching…" : anyDone ? "Continue on the remaining chains" : `Launch on ${chosen.length} chain${chosen.length === 1 ? "" : "s"}`}
              </button>
            ) : (
              <ConnectButton full />
            )}
            <p className="text-[0.75rem] text-ink-3 mt-2 text-center">
              {problem && (name || symbol) ? problem : "No launch fee. You only pay network gas. Your wallet confirms once per chain."}
            </p>
          </div>
        </div>

        <aside className="lg:sticky lg:top-24 grid gap-4">
          <p className="hidden lg:flex items-center gap-2 text-[0.75rem] font-mono tracking-[0.14em] text-ink-3">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald" aria-hidden="true" /> LIVE PREVIEW
          </p>
          <div className="hidden lg:block rounded-3xl border border-line bg-surface p-3">
            <div className="relative aspect-square rounded-2xl overflow-hidden bg-paper flex items-center justify-center">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logo} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="font-display font-bold text-[4rem] text-ink-3">{cleanSymbol.slice(0, 2) || "?"}</span>
              )}
              <div className="absolute top-2 left-2 flex gap-1">
                {chosen.map((c) => (
                  <span key={c.key} className="h-6 px-2 rounded-full text-[0.6875rem] font-semibold text-white flex items-center" style={{ background: c.color }}>
                    {c.short}
                  </span>
                ))}
              </div>
            </div>
            <div className="px-2 pt-3 pb-1">
              <div className="font-display font-bold text-[1.25rem] truncate">{name.trim() || "Your coin"}</div>
              <div className="text-[0.8125rem] text-ink-3">${cleanSymbol || "TICKER"}</div>
              <div className="flex justify-between text-[0.75rem] text-ink-3 mt-3 mb-1.5">
                <span>Graduation</span>
                <span className="font-mono">0%</span>
              </div>
              <div className="h-2 rounded-full bg-line" />
            </div>
          </div>

          <dl className="rounded-3xl border border-line bg-surface p-4 grid gap-2.5 text-[0.8125rem]">
            {[
              ["Chains", chosen.map((c) => c.short).join(" · ") || "—"],
              ["Starting market cap", startMc ? usd(startMc, 0) : "—"],
              ["Graduates at", `${usd(TARGET_USD)} across all chains`],
              ["Trade fee", `1% · 0.3% ${feeMode === 0 ? "goes to you" : feeMode === 1 ? "buys back & burns" : "goes to holders"}`],
              ["Supply", "1,000,000,000"],
              ["Liquidity", "Locked forever at graduation"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4">
                <dt className="text-ink-3">{k}</dt>
                <dd className="font-mono text-right">{v}</dd>
              </div>
            ))}
          </dl>

          <CurveSim title="What early buyers get" collapsible />

          <div className="rounded-3xl border border-line bg-surface p-4">
            <p className="font-semibold text-[0.875rem]">Nothing to rug.</p>
            <p className="text-[0.8125rem] text-ink-2 mt-1.5 leading-relaxed">
              Fixed supply, no owner, no minting. Before graduation anyone can sell back at any time; after it, the pool
              is locked forever. Nobody, including you and us, can pull the money.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

const input = "w-full h-12 px-4 rounded-2xl border border-line bg-paper text-ink placeholder:text-ink-3/70 focus:border-emerald";

function Field({ label, hint, right, children }: { label: string; hint?: string; right?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-2">
      <span className="flex items-baseline justify-between text-[0.9375rem] font-bold text-ink">
        <span>
          {label} {hint && <span className="text-ink-3 font-normal">{hint}</span>}
        </span>
        {right && <span className="text-[0.75rem] text-ink-3 font-mono">{right}</span>}
      </span>
      {children}
    </label>
  );
}
