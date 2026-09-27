"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toHex, type Address, type Hex } from "viem";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { ChainChip, usd } from "@/components/coins";
import { factoryAbi } from "@/lib/abis";
import { CHAINS, SLIPPAGE_BPS, TARGET_USD, explorerTx, type NeuronChain } from "@/lib/config";
import { clientFor, coinHref, isImageUrl } from "@/lib/data";
import { friendlyError } from "@/lib/format";
import { fileToLogo } from "@/lib/image";
import { call } from "@/lib/tx";
import { fetchPrices } from "@/lib/price";

type Terms = { v0: bigint; t0: bigint; feeBps: bigint };
type Run = { status: "working" | "done" | "failed"; note?: string; hash?: string };
const SUPPLY = 1_000_000_000n * 10n ** 18n;
const DEV_OPTIONS = [0, 1, 2, 5];

/** Where the creator's 0.3% of every trade goes. Fixed at launch. */
const FEE_MODES = [
  { id: 0, key: "creator", title: "To you", text: "Your 0.3% of every trade builds up for you to collect." },
  { id: 1, key: "buyback", title: "Buyback & burn", text: "Your share buys the coin back and burns it, so the supply keeps shrinking." },
  { id: 2, key: "holders", title: "To holders", text: "Your share is paid out to everyone holding the coin, in ETH." },
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
  const { address, send } = useWallet();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [logo, setLogo] = useState("");
  const [picBusy, setPicBusy] = useState(false);
  const [picError, setPicError] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<string[]>(CHAINS.map((c) => c.key));
  const [devPct, setDevPct] = useState(0);
  const [feeMode, setFeeMode] = useState<0 | 1 | 2>(0);
  const [terms, setTerms] = useState<Record<string, Terms>>({});
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [launchKey, setLaunchKey] = useState<Hex | null>(null);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [busy, setBusy] = useState(false);

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
  const devCost = (c: NeuronChain) => (terms[c.key] ? costFor(terms[c.key], devTokens) : 0n);
  const totalDevEth = chosen.reduce((s, c) => s + Number(devCost(c)) / 1e18, 0);
  const startMc = useMemo(() => {
    const t = terms[CHAINS[0].key];
    if (!t || !ethUsd) return null;
    return (Number(t.v0) / Number(t.t0)) * 1e9 * ethUsd;
  }, [terms, ethUsd]);

  const problem =
    name.trim().length === 0
      ? "Give your coin a name."
      : cleanSymbol.length < 2
        ? "The ticker needs at least 2 letters or numbers."
        : logo !== "" && !isImageUrl(logo)
          ? "That picture could not be used."
          : chosen.length === 0
            ? "Pick at least one chain."
            : "";
  const allDone = chosen.length > 0 && chosen.every((c) => runs[c.key]?.status === "done");
  const anyDone = chosen.some((c) => runs[c.key]?.status === "done");

  async function launch() {
    if (!address || problem) return;
    const key = launchKey ?? (toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex);
    setLaunchKey(key);
    setBusy(true);
    for (const c of chosen) {
      if (runs[c.key]?.status === "done") continue;
      const set = (r: Run) => setRuns((p) => ({ ...p, [c.key]: r }));
      try {
        const value = devCost(c);
        const args = [name.trim(), cleanSymbol, logo, description.trim(), key, 0n, feeMode] as const;
        const pub = clientFor(c);
        set({ status: "working", note: "Checking…" });
        const sim = await pub.simulateContract({ account: address, address: c.factory, abi: factoryAbi, functionName: "launch", args, value });
        const minOut = value > 0n ? (sim.result[2] * (10_000n - SLIPPAGE_BPS)) / 10_000n : 0n;
        const hash = await send(
          c.chain,
          [call(c.factory, factoryAbi, "launch", [args[0], args[1], args[2], args[3], args[4], minOut, feeMode], value)],
          (note) => set({ status: "working", note })
        );
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
        <div className="mx-auto w-16 h-16 rounded-full bg-emerald-soft flex items-center justify-center text-[30px]">🎉</div>
        <h1 className="font-display font-bold text-[30px] mt-6">${cleanSymbol} is live on {chosen.length} chain{chosen.length > 1 ? "s" : ""}</h1>
        <p className="text-ink-2 mt-3">Every buy, on every chain, now counts toward one {usd(TARGET_USD)} target. Share it so people can find it.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {chosen.map((c) => <ChainChip key={c.key} chain={c} />)}
        </div>
        <Link href={coinHref({ creator: address, launchKey })} className="mt-8 h-13 rounded-2xl bg-emerald text-on-accent font-bold flex items-center justify-center">
          Go to your coin
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <p className="font-mono text-[12px] tracking-[0.16em] text-emerald">ONE COIN · EVERY CHAIN</p>
      <h1 className="font-display font-bold text-[34px] sm:text-[46px] tracking-tight mt-2">Launch a coin</h1>
      <p className="text-ink-2 mt-2 text-[16px] max-w-2xl">
        A name, a ticker and a picture. It goes live on every chain you pick, in one go. Everything else is optional.
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_380px] lg:items-start">
        <div className="rounded-3xl border border-line bg-surface p-5 sm:p-7 grid gap-6">
          <div className="grid gap-5 sm:grid-cols-[180px_1fr]">
            <label className="relative aspect-square rounded-2xl border-2 border-dashed border-line hover:border-emerald bg-paper flex flex-col items-center justify-center text-center cursor-pointer overflow-hidden">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logo} alt="" className="absolute inset-0 w-full h-full object-cover" />
              ) : (
                <>
                  <span className="text-[28px]" aria-hidden="true">＋</span>
                  <span className="text-[14px] font-semibold mt-1">{picBusy ? "Preparing…" : "Add picture"}</span>
                  <span className="text-[12px] text-ink-3 mt-1 px-3">Square works best</span>
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
                <button type="button" onClick={() => setLogo("")} className="justify-self-start text-[13px] text-ink-3 underline">
                  Remove picture
                </button>
              )}
              {picError && <p className="text-[13px] text-danger">{picError}</p>}
            </div>
          </div>

          <Field label="Description" hint="optional">
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={280} placeholder="What's the idea? Tell your future holders a little about it." className={input + " h-auto py-3 resize-none"} />
          </Field>

          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-[14px] font-semibold">Chains</span>
              <span className="text-[12px] text-ink-3">More chains, more buyers</span>
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
                    className={"h-11 px-4 rounded-2xl border-2 flex items-center gap-2 font-semibold text-[14px] " + (on ? "text-ink" : "border-line text-ink-3")}
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
              <span className="text-[14px] font-semibold">Where your fees go</span>
              <span className="text-[12px] text-ink-3">can&apos;t be changed later</span>
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
                  <span className="block font-semibold text-[14px]">{m.title}</span>
                  <span className="block text-[12px] text-ink-3 mt-1 leading-snug">{m.text}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-[14px] font-semibold">Buy some yourself</span>
              <span className="text-[12px] text-ink-3">optional · lands first, so nobody gets in before you</span>
            </div>
            <div className="grid grid-cols-4 gap-2 mt-2">
              {DEV_OPTIONS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setDevPct(p)}
                  className={"h-11 rounded-2xl border text-[14px] font-semibold " + (devPct === p ? "border-emerald text-ink" : "border-line text-ink-2")}
                >
                  {p === 0 ? "None" : `${p}%`}
                </button>
              ))}
            </div>
            {devPct > 0 && (
              <p className="text-[13px] text-ink-2 mt-2">
                {devPct}% of the supply on each chain · about{" "}
                <span className="font-mono text-ink">{ethUsd ? usd(totalDevEth * ethUsd, 2) : `${totalDevEth.toFixed(5)} ETH`}</span> in total
              </p>
            )}
          </div>

          {launchKey && (
            <ul className="grid gap-2">
              {chosen.map((c) => {
                const r = runs[c.key];
                return (
                  <li key={c.key} className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-paper text-[14px]">
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
                className="w-full h-14 rounded-2xl bg-emerald text-on-accent text-[17px] font-bold hover:bg-emerald-dark disabled:opacity-40"
              >
                {busy ? "Launching…" : anyDone ? "Continue on the remaining chains" : `Launch on ${chosen.length} chain${chosen.length === 1 ? "" : "s"}`}
              </button>
            ) : (
              <ConnectButton full />
            )}
            <p className="text-[12px] text-ink-3 mt-2 text-center">
              {problem && (name || symbol) ? problem : "No launch fee. You only pay network gas. Your wallet confirms once per chain."}
            </p>
          </div>
        </div>

        <aside className="lg:sticky lg:top-24 grid gap-4">
          <p className="flex items-center gap-2 text-[12px] font-mono tracking-[0.14em] text-ink-3">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald" aria-hidden="true" /> LIVE PREVIEW
          </p>
          <div className="rounded-3xl border border-line bg-surface p-3">
            <div className="relative aspect-square rounded-2xl overflow-hidden bg-paper flex items-center justify-center">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logo} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="font-display font-bold text-[64px] text-ink-3">{cleanSymbol.slice(0, 2) || "?"}</span>
              )}
              <div className="absolute top-2 left-2 flex gap-1">
                {chosen.map((c) => (
                  <span key={c.key} className="h-6 px-2 rounded-full text-[11px] font-semibold text-white flex items-center" style={{ background: c.color }}>
                    {c.short}
                  </span>
                ))}
              </div>
            </div>
            <div className="px-2 pt-3 pb-1">
              <div className="font-display font-bold text-[20px] truncate">{name.trim() || "Your coin"}</div>
              <div className="text-[13px] text-ink-3">${cleanSymbol || "TICKER"}</div>
              <div className="flex justify-between text-[12px] text-ink-3 mt-3 mb-1.5">
                <span>Graduation</span>
                <span className="font-mono">0%</span>
              </div>
              <div className="h-2 rounded-full bg-line" />
            </div>
          </div>

          <dl className="rounded-3xl border border-line bg-surface p-4 grid gap-2.5 text-[13px]">
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

          <div className="rounded-3xl border border-line bg-surface p-4">
            <p className="font-semibold text-[14px]">Nothing to rug.</p>
            <p className="text-[13px] text-ink-2 mt-1.5 leading-relaxed">
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
      <span className="flex items-baseline justify-between text-[14px] font-semibold">
        <span>
          {label} {hint && <span className="text-ink-3 font-normal">{hint}</span>}
        </span>
        {right && <span className="text-[12px] text-ink-3 font-mono">{right}</span>}
      </span>
      {children}
    </label>
  );
}
