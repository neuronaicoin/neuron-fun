"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { CoinAvatar } from "@/components/coins";
import { call } from "@/lib/tx";
import { fileToLogo } from "@/lib/image";
import { friendlyError } from "@/lib/format";
import { isImageUrl } from "@/lib/data";
import { IS_TESTNET } from "@/lib/config";
import { RACE_CHAINS, bestLinkedGroup, chainsLinked, fetchRaceLinks, raceClient, raceErc20Abi, raceExplorerTx, raceFactoryAbi, raceHref, withGas, type RaceChain } from "@/lib/race";

/**
 * sasa v7: launch a coin into the five-minute race. The coin is opened on each picked chain in
 * its own transaction (same launch key everywhere, so the same address and coin id). If the
 * user stops half-way, the page picks up with the chains that are still missing.
 */

const SAVE = "sasa-race-launch";
type Draft = { key: Hex; creator: string; name: string; symbol: string; logo: string; description: string; feeMode: 0 | 1; chains: number[]; firstBuy: string };
type ChainStatus = { state: "idle" | "working" | "done" | "error"; note?: string; tx?: string };
type Funds = { usd: bigint; usdDec: number; gas: bigint; min: bigint; open: boolean };

const loadDraft = (): Draft | null => {
  try {
    return JSON.parse(localStorage.getItem(SAVE) ?? "null") as Draft | null;
  } catch {
    return null;
  }
};
const saveDraft = (d: Draft | null) => {
  try {
    if (d) localStorage.setItem(SAVE, JSON.stringify(d));
    else localStorage.removeItem(SAVE);
  } catch {}
};
const newKey = (): Hex => keccak256(toHex(`${Date.now()}-${Math.random()}-${Math.random()}`));
/** "Robinhood and Arc can't race together yet." for the first pair that isn't linked. */
function unlinkedText(ids: number[], links: Map<number, Set<number> | null>): string {
  for (const a of ids)
    for (const b of ids) {
      if (a === b) continue;
      const s = links.get(a);
      if (!s || !s.has(b)) {
        const A = RACE_CHAINS.find((c) => c.chainId === a)!;
        const B = RACE_CHAINS.find((c) => c.chainId === b)!;
        return s === null ? `Couldn't reach ${A.short}. Try again in a moment.` : `${A.short} and ${B.short} can't race together yet. Untick one of them.`;
      }
    }
  return "";
}
const cleanSym = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);

export default function RaceLaunchPage() {
  const w = useWallet();
  const router = useRouter();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [logo, setLogo] = useState("");
  const [description, setDescription] = useState("");
  const [feeMode, setFeeMode] = useState<0 | 1>(0);
  const [chains, setChains] = useState<number[]>(RACE_CHAINS.map((c) => c.chainId));
  const [firstBuy, setFirstBuy] = useState("5");
  const [picBusy, setPicBusy] = useState(false);
  const [picError, setPicError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<Record<number, ChainStatus>>({});
  const [funds, setFunds] = useState<Record<number, Funds | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [links, setLinks] = useState<Map<number, Set<number> | null> | null>(null);

  // Which chains can race together; start with the biggest group that can.
  useEffect(() => {
    let alive = true;
    fetchRaceLinks().then((l) => {
      if (!alive) return;
      setLinks(l);
      const best = bestLinkedGroup(l);
      if (best.length >= 2) setChains(best);
    });
    return () => {
      alive = false;
    };
  }, []);

  // A launch left half-way by this wallet: offer to finish it.
  useEffect(() => {
    const d = loadDraft();
    if (d && w.address && d.creator.toLowerCase() === w.address.toLowerCase()) setDraft(d);
    else setDraft(null);
  }, [w.address]);

  const picked = useMemo(() => RACE_CHAINS.filter((c) => chains.includes(c.chainId)), [chains]);

  // What the wallet has on each picked chain, and each factory's minimum first buy.
  const readFunds = useCallback(async () => {
    const out: Record<number, Funds | null> = {};
    await Promise.all(
      RACE_CHAINS.map(async (c) => {
        try {
          const pub = raceClient(c);
          const [usdDec, min, open, usd, gas] = await Promise.all([
            pub.readContract({ address: c.usd, abi: raceErc20Abi, functionName: "decimals" }),
            pub.readContract({ address: c.factory, abi: raceFactoryAbi, functionName: "minFirstBuy" }),
            pub.readContract({ address: c.factory, abi: raceFactoryAbi, functionName: "launchesOpen" }),
            w.address ? pub.readContract({ address: c.usd, abi: raceErc20Abi, functionName: "balanceOf", args: [w.address] }) : Promise.resolve(0n),
            w.address ? pub.getBalance({ address: w.address }) : Promise.resolve(0n),
          ]);
          out[c.chainId] = { usdDec: Number(usdDec), min: min as bigint, open: open as boolean, usd: usd as bigint, gas };
        } catch {
          out[c.chainId] = null;
        }
      })
    );
    setFunds(out);
  }, [w.address]);
  useEffect(() => {
    void readFunds();
  }, [readFunds]);

  const minUsd = useMemo(() => {
    const mins = picked.map((c) => funds[c.chainId]).filter((f): f is Funds => !!f).map((f) => Number(formatUnits(f.min, f.usdDec)));
    return mins.length ? Math.max(...mins) : 5;
  }, [picked, funds]);

  const sym = cleanSym(symbol);
  const buyN = Number(firstBuy);
  const problem = !name.trim()
    ? "Give your coin a name."
    : sym.length < 2
      ? "The ticker needs at least 2 letters or numbers."
      : logo !== "" && !isImageUrl(logo)
        ? "That picture could not be used."
        : picked.length < 2
          ? "Pick at least two chains: it's a race."
          : links && !chainsLinked(chains, links)
            ? unlinkedText(chains, links)
          : !Number.isFinite(buyN) || buyN < minUsd
            ? `The first buy is at least $${minUsd} on each chain.`
            : "";

  // Per chain: is something missing before the launch can go through?
  const shortOf = (c: RaceChain): string | null => {
    const f = funds[c.chainId];
    if (!w.address || f === undefined) return null;
    if (f === null) return "Couldn't reach this chain. Try again in a moment.";
    if (!f.open) return "Launches are paused on this chain.";
    if (f.gas === 0n) return `No ${c.chain.nativeCurrency.symbol} for the network fee.`;
    const need = (() => {
      try {
        return parseUnits(firstBuy || "0", f.usdDec);
      } catch {
        return 0n;
      }
    })();
    if (f.usd < need) return `Needs $${firstBuy} ${IS_TESTNET ? "test " : ""}USDC, you have $${Number(formatUnits(f.usd, f.usdDec)).toFixed(2)}.`;
    return null;
  };

  const faucet = async (c: RaceChain) => {
    if (!w.address) return;
    setStatus((s) => ({ ...s, [c.chainId]: { state: "working", note: "Getting test USDC…" } }));
    try {
      await w.send(c.chain, [call(c.usd, raceErc20Abi, "faucet", [w.address])]);
      setStatus((s) => ({ ...s, [c.chainId]: { state: "idle" } }));
    } catch (e) {
      const t = JSON.stringify(e ?? {}, (_k, v) => (typeof v === "bigint" ? String(v) : v));
      setStatus((s) => ({ ...s, [c.chainId]: { state: "error", note: /TooSoon/.test(t) ? "Test USDC already taken today." : friendlyError(e) } }));
    }
    void readFunds();
  };

  /** Opens the coin on every chain of `d` that doesn't have it yet, one after the other. */
  const run = async (d: Draft) => {
    if (!w.address || busy) return;
    setBusy(true);
    setError("");
    saveDraft(d);
    setDraft(d);
    const me = w.address as Address;
    const order = RACE_CHAINS.filter((c) => d.chains.includes(c.chainId));
    const eids = order.map((c) => c.eid).sort((a, b) => a - b);
    let failed = false;
    let coinId: Hex | null = null;
    for (const c of order) {
      const pub = raceClient(c);
      const set = (st: ChainStatus) => setStatus((s) => ({ ...s, [c.chainId]: st }));
      try {
        set({ state: "working", note: "Checking…" });
        const coin = (await pub.readContract({ address: c.factory, abi: raceFactoryAbi, functionName: "coinAddress", args: [me, d.key] })) as Address;
        coinId = (await pub.readContract({ address: c.factory, abi: raceFactoryAbi, functionName: "coinIdOf", args: [me, d.key] })) as Hex;
        const code = await pub.getCode({ address: coin });
        if (code && code.length > 2) {
          set({ state: "done", note: "Live" });
          continue;
        }
        const dec = Number(await pub.readContract({ address: c.usd, abi: raceErc20Abi, functionName: "decimals" }));
        const amount = parseUnits(d.firstBuy, dec);
        const allowance = (await pub.readContract({ address: c.usd, abi: raceErc20Abi, functionName: "allowance", args: [me, c.factory] })) as bigint;
        if (allowance < amount) {
          await w.send(c.chain, [call(c.usd, raceErc20Abi, "approve", [c.factory, amount])], (m) => set({ state: "working", note: `Approve: ${m}` }));
          // the node answering next may be a block behind the approval: wait until it sees it
          for (let i = 0; i < 8; i++) {
            const a = (await pub.readContract({ address: c.usd, abi: raceErc20Abi, functionName: "allowance", args: [me, c.factory] }).catch(() => 0n)) as bigint;
            if (a >= amount) break;
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        const launchCall = await withGas(
          pub,
          me,
          call(c.factory, raceFactoryAbi as never, "launch", [
            {
              name: d.name,
              symbol: d.symbol,
              logo: d.logo,
              description: d.description,
              launchKey: d.key,
              eids,
              feeMode: d.feeMode,
              firstBuy: amount,
              // the pool opens inside this same transaction: nobody can trade before the first buy
              minCoinsOut: 0n,
            },
          ])
        );
        const tx = await w.send(c.chain, [launchCall], (m) => set({ state: "working", note: m }));
        set({ state: "done", note: "Live", tx });
      } catch (e) {
        failed = true;
        set({ state: "error", note: friendlyError(e) });
        break;
      }
    }
    setBusy(false);
    void readFunds();
    if (!failed && coinId) {
      saveDraft(null);
      router.push(raceHref(coinId.toLowerCase()));
    } else {
      setError("Stopped. Fix what's shown and press Continue: chains that are already live are skipped.");
    }
  };

  const start = () => {
    if (problem || !w.address) return;
    void run({ key: newKey(), creator: w.address, name: name.trim(), symbol: sym, logo, description: description.trim(), feeMode, chains, firstBuy });
  };

  const toggle = (id: number) => setChains((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const input = "w-full h-12 rounded-xl border border-line bg-paper px-4 text-[1rem] outline-none focus:border-ink-3 min-w-0";

  if (!RACE_CHAINS.length) {
    return <div className="max-w-xl mx-auto px-4 py-16 text-center text-ink-2">Races open soon.</div>;
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-4 pb-24 lg:pb-12 flex flex-col gap-5 min-w-0">
      <div className="flex flex-col gap-1">
        <h1 className="text-[1.75rem] sm:text-[2.25rem] font-extrabold tracking-tight">Launch a race</h1>
        <p className="text-ink-2 text-[0.9375rem]">Your coin opens on every chain you pick. After five minutes the chain with the most money wins and gets the whole coin.</p>
      </div>

      {draft && !busy && (
        <div className="rounded-2xl border border-line bg-night p-4 flex flex-col sm:flex-row gap-3 sm:items-center">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <CoinAvatar logo={draft.logo} symbol={draft.symbol} size={40} />
            <div className="min-w-0">
              <div className="font-semibold truncate">
                {draft.name} <span className="text-ink-3">{draft.symbol}</span>
              </div>
              <div className="text-[0.8125rem] text-ink-2">Not live on every chain yet.</div>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => void run(draft)} className="h-11 px-5 rounded-full bg-ink text-paper font-semibold">
              Continue
            </button>
            <button
              type="button"
              onClick={() => {
                saveDraft(null);
                setDraft(null);
                setStatus({});
              }}
              className="h-11 px-4 rounded-full border border-line text-ink-2"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_360px] gap-5 lg:gap-8 items-start">
        <div className="rounded-3xl border border-line bg-surface p-4 sm:p-6 flex flex-col gap-5 min-w-0">
          <div className="grid grid-cols-[88px_minmax(0,1fr)] sm:grid-cols-[120px_minmax(0,1fr)] gap-4 items-start">
            <label className="relative aspect-square rounded-2xl border-2 border-dashed border-line hover:border-ink-3 bg-paper flex flex-col items-center justify-center text-center cursor-pointer overflow-hidden">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logo} alt="" className="absolute inset-0 w-full h-full object-cover" />
              ) : (
                <>
                  <span className="text-[1.5rem]" aria-hidden="true">
                    ＋
                  </span>
                  <span className="text-[0.8125rem] font-semibold">{picBusy ? "…" : "Picture"}</span>
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
            <div className="flex flex-col gap-3 min-w-0">
              <label className="flex flex-col gap-1">
                <span className="text-[0.8125rem] text-ink-3">Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="Harbor Cat" className={input} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[0.8125rem] text-ink-3 flex justify-between">
                  Ticker <span>{sym.length}/10</span>
                </span>
                <input value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={12} placeholder="HCAT" autoCapitalize="characters" className={input + " uppercase"} />
              </label>
            </div>
          </div>
          {logo && (
            <button type="button" onClick={() => setLogo("")} className="self-start text-[0.8125rem] text-ink-3 underline">
              Remove picture
            </button>
          )}
          {picError && <p className="text-[0.8125rem] text-danger">{picError}</p>}

          <label className="flex flex-col gap-1">
            <span className="text-[0.8125rem] text-ink-3">Description (optional)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={280}
              rows={2}
              placeholder="What's the story?"
              className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-[1rem] outline-none focus:border-ink-3 resize-none min-w-0"
            />
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-[0.8125rem] text-ink-3">Chains in the race</span>
            <div className="grid grid-cols-2 gap-2">
              {RACE_CHAINS.map((c) => {
                const on = chains.includes(c.chainId);
                return (
                  <button
                    key={c.chainId}
                    type="button"
                    onClick={() => toggle(c.chainId)}
                    className={"h-11 rounded-xl border px-3 flex items-center gap-2 text-[0.9375rem] min-w-0 " + (on ? "border-ink font-semibold" : "border-line text-ink-3")}
                    aria-pressed={on}
                  >
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: on ? c.color : "var(--color-line)" }} />
                    <span className="truncate">{c.short}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[0.8125rem] text-ink-3">Trading fees</span>
            <div className="grid grid-cols-2 gap-2">
              {[
                { v: 0 as const, t: "To me", d: "Your share of the fees goes to your wallet" },
                { v: 1 as const, t: "Buyback & burn", d: "Your share buys the coin back and burns it" },
              ].map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => setFeeMode(o.v)}
                  className={"rounded-xl border p-3 text-left " + (feeMode === o.v ? "border-ink" : "border-line")}
                  aria-pressed={feeMode === o.v}
                >
                  <div className="font-semibold text-[0.9375rem]">{o.t}</div>
                  <div className="hidden sm:block text-[0.8125rem] text-ink-3">{o.d}</div>
                </button>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[0.8125rem] text-ink-3">Your first buy on each chain (USDC, at least ${minUsd})</span>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-3">$</span>
              <input
                inputMode="decimal"
                value={firstBuy}
                onChange={(e) => setFirstBuy(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))}
                className={input + " pl-8"}
              />
            </div>
            <span className="text-[0.8125rem] text-ink-3">
              Total ${Number.isFinite(buyN) ? (buyN * picked.length).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"} across {picked.length} chains. Your first buy pays the 2% floor fee.
            </span>
          </label>
        </div>

        <aside className="rounded-3xl border border-line bg-surface p-4 sm:p-5 flex flex-col gap-4 min-w-0 lg:sticky lg:top-20">
          <h2 className="font-bold text-[1.0625rem]">Before you launch</h2>
          {!w.address ? (
            <ConnectButton />
          ) : w.embedded ? (
            <p className="text-[0.875rem] text-ink-2">Races on testnet need a browser wallet (MetaMask, Rabby, Coinbase Wallet…). Email accounts join with the USDC deposit at mainnet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {picked.map((c) => {
                const st = status[c.chainId];
                const short = st?.state === "done" ? null : shortOf(c);
                return (
                  <li key={c.chainId} className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: c.color }} />
                      <span className="font-semibold text-[0.9375rem] truncate flex-1">{c.name}</span>
                      <span
                        className={
                          "text-[0.8125rem] shrink-0 " +
                          (st?.state === "done" ? "text-up font-semibold" : st?.state === "error" ? "text-danger" : short ? "text-warn-ink" : "text-ink-3")
                        }
                      >
                        {st?.state === "done" ? "✓ Live" : st?.state === "working" ? "…" : st?.state === "error" ? "Failed" : short ? "Missing" : "Ready"}
                      </span>
                    </div>
                    {(st?.note && st.state !== "done") || short ? (
                      <p className="text-[0.8125rem] text-ink-2 break-words pl-[1.125rem]">{st?.note && st.state !== "done" ? st.note : short}</p>
                    ) : null}
                    {st?.tx && (
                      <a href={raceExplorerTx(c, st.tx)} target="_blank" rel="noreferrer" className="text-[0.8125rem] text-ink-3 underline pl-[1.125rem]">
                        View transaction
                      </a>
                    )}
                    {short && st?.state !== "working" && (
                      <div className="flex gap-3 pl-[1.125rem] text-[0.8125rem]">
                        {c.faucet && /USDC/.test(short) && (
                          <button type="button" onClick={() => void faucet(c)} className="text-emerald-dark font-semibold underline">
                            Get $100 test USDC
                          </button>
                        )}
                        {c.gasFaucet && /network fee/.test(short) && (
                          <a href={c.gasFaucet} target="_blank" rel="noreferrer" className="text-emerald-dark font-semibold underline">
                            Get {c.chain.nativeCurrency.symbol}
                          </a>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {w.address && !w.embedded && (
            <>
              <button
                type="button"
                onClick={start}
                disabled={busy || !!problem || picked.some((c) => !!shortOf(c))}
                className="h-13 min-h-[3.25rem] rounded-full bg-emerald text-on-accent font-bold text-[1.0625rem] disabled:opacity-50"
              >
                {busy ? "Launching…" : `Launch on ${picked.length} chains`}
              </button>
              {problem && <p className="text-[0.8125rem] text-ink-2 text-center">{problem}</p>}
              {error && <p className="text-[0.8125rem] text-danger text-center">{error}</p>}
              <p className="text-[0.75rem] text-ink-3 text-center">
                Your wallet asks once or twice per chain (approve, launch). Each chain&apos;s five minutes start when it goes live.
              </p>
            </>
          )}
          <Link href="/race/" className="text-[0.8125rem] text-ink-3 underline self-center">
            How the race works
          </Link>
        </aside>
      </div>
    </div>
  );
}
