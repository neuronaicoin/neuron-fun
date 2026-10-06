"use client";

/**
 * Safety controls for the beta locks on every chain's live factory:
 * pause / resume buys and launches, and the total capacity cap.
 * The guardian wallet can only pause; the owner (a Safe on mainnet) does
 * the rest. When the owner is a Safe, the page prepares the transaction
 * for the Safe instead of sending it.
 */
import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { ChainChip, usd } from "@/components/coins";
import { safetyAbi } from "@/lib/abis";
import { CHAINS, USD_MODE, explorerAddress, type NeuronChain } from "@/lib/config";
import { clientFor } from "@/lib/data";
import { friendlyError, shortAddr } from "@/lib/format";
import { fetchPrices } from "@/lib/price";
import { readSafety, refreshSafety, type Safety } from "@/lib/safety";
import { call } from "@/lib/tx";
import { HelpInbox } from "@/components/helpinbox";

const ZERO = "0x0000000000000000000000000000000000000000";
const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

type Info = Safety & { ownerIsContract: boolean; pendingIsContract: boolean };
type SafeTx = { chain: NeuronChain; title: string; to: Address; data: Hex; safe: Address };

export default function AdminPage() {
  const { address, send } = useWallet();
  const [info, setInfo] = useState<Record<string, Info>>({});
  const [loaded, setLoaded] = useState(false);
  const [prices, setPrices] = useState<Record<string, number> | null>(null);
  const [capInput, setCapInput] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [safeTx, setSafeTx] = useState<SafeTx | null>(null);

  const load = useCallback(async () => {
    const got = await Promise.all(
      CHAINS.map(async (c) => {
        try {
          const s = await readSafety(c);
          const pub = clientFor(c);
          const [oc, pc] = await Promise.all([
            pub.getCode({ address: s.owner }).then((x) => !!x && x !== "0x"),
            s.pendingOwner === ZERO ? Promise.resolve(false) : pub.getCode({ address: s.pendingOwner }).then((x) => !!x && x !== "0x"),
          ]);
          return [c.key, { ...s, ownerIsContract: oc, pendingIsContract: pc }] as const;
        } catch {
          return null;
        }
      })
    );
    setInfo(Object.fromEntries(got.filter((x): x is NonNullable<typeof x> => !!x)));
    setLoaded(true);
  }, []);

  useEffect(() => {
    load().catch(() => setLoaded(true));
    fetchPrices().then(setPrices).catch(() => {});
    const t = setInterval(() => load().catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const role = (s?: Info): "owner" | "guardian" | "safe-signer" | null => {
    if (!address || !s) return null;
    if (eq(address, s.owner)) return "owner";
    if (eq(address, s.guardian)) return "guardian";
    return null;
  };
  const anyAccess = CHAINS.some((c) => {
    const s = info[c.key];
    return s && (eq(address ?? "", s.owner) || eq(address ?? "", s.guardian) || s.ownerIsContract);
  });

  const priceOf = (c: NeuronChain) => prices?.[c.priceSymbol] ?? null;
  const toUsd = (c: NeuronChain, wei: bigint) => {
    const p = priceOf(c);
    return p === null ? null : (Number(wei) / 1e18) * p;
  };
  const native = (c: NeuronChain) => c.chain.nativeCurrency.symbol;

  /** Sends from this wallet if it may; otherwise prepares it for the Safe. */
  async function act(c: NeuronChain, key: string, fn: "pauseBuys" | "unpauseBuys" | "setNativeCap" | "acceptOwnership", args: readonly unknown[], title: string, done: string) {
    const s = info[c.key];
    if (!s) return;
    setMsg(null);
    const ownerOnly = fn !== "pauseBuys";
    const safe = fn === "acceptOwnership" ? s.pendingOwner : s.owner;
    const viaSafe = fn === "acceptOwnership" ? s.pendingIsContract : ownerOnly && s.ownerIsContract && !eq(address, s.owner);
    if (viaSafe) {
      setSafeTx({ chain: c, title, to: c.factory, data: encodeFunctionData({ abi: safetyAbi, functionName: fn, args: args as never }), safe });
      return;
    }
    try {
      setBusy(key);
      await send(c.chain, [call(c.factory, safetyAbi, fn, args)], () => {});
      setMsg({ ok: true, text: done });
      await load();
      void refreshSafety().catch(() => {});
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e) });
    } finally {
      setBusy("");
    }
  }

  async function pauseAll() {
    for (const c of CHAINS) {
      const s = info[c.key];
      if (s && !s.paused && (role(s) === "owner" || role(s) === "guardian")) {
        await act(c, `pause-${c.key}`, "pauseBuys", [], `Pause buys on ${c.name}`, "Paused.");
      }
    }
    setMsg({ ok: true, text: "Buys paused on every chain your wallet can pause." });
  }

  function capWei(c: NeuronChain): bigint | null {
    const raw = (capInput[c.key] ?? "").replace(/[$,\s]/g, "");
    if (raw === "") return null;
    const v = Number(raw);
    const p = priceOf(c);
    if (!Number.isFinite(v) || v < 0 || p === null) return null;
    // Dollar edition: the cap is in USDC units (6 decimals).
    if (USD_MODE) return BigInt(Math.floor(v)) * 1_000_000n;
    return BigInt(Math.floor((v / p) * 1e9)) * 1_000_000_000n;
  }

  if (!address) {
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-bold text-[1.625rem]">Safety controls</h1>
        <p className="text-ink-2 mt-2">Connect the guardian or owner wallet.</p>
        <div className="mt-6">
          <ConnectButton full />
        </div>
      </div>
    );
  }

  if (loaded && !anyAccess) {
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-bold text-[1.625rem]">This page is for sasa admins</h1>
        <p className="text-ink-2 mt-2">
          {shortAddr(address)} isn&apos;t the owner or guardian of any sasa contract. Connect the admin wallet to continue.
        </p>
      </div>
    );
  }

  const anyPausable = CHAINS.some((c) => info[c.key] && !info[c.key].paused && role(info[c.key]) !== null);
  const allPaused = CHAINS.every((c) => info[c.key]?.paused);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:py-10">
      <h1 className="font-display font-bold text-[1.625rem] sm:text-[2rem]">Safety controls</h1>
      <p className="text-ink-3 mt-1 max-w-[60ch]">Pausing stops new launches and buys. Selling, fee claims and graduation always stay open.</p>

      <div className="mt-6 flex flex-wrap items-center gap-4 rounded-3xl border border-line border-l-4 border-l-danger bg-surface p-4 sm:p-5">
        <div className="flex-1 min-w-[14rem]">
          <h2 className="font-display font-semibold text-[1.0625rem]">{allPaused ? "Everything is paused" : "Emergency stop"}</h2>
          <p className="text-[0.875rem] text-ink-2 mt-0.5">
            {allPaused ? "Resume each chain below when it's safe." : "Stops buys and launches on every chain at once. Takes effect in the next block."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void pauseAll()}
          disabled={!anyPausable || !!busy}
          className="h-13 px-6 rounded-2xl bg-danger text-white font-bold text-[1rem] disabled:opacity-40"
        >
          {allPaused ? "All chains paused" : "Pause all chains"}
        </button>
      </div>

      {msg && (
        <p role="status" className={"mt-4 text-[0.875rem] " + (msg.ok ? "text-up" : "text-danger")}>
          {msg.text}
        </p>
      )}

      {!loaded && <div className="mt-6 h-64 rounded-3xl bg-surface animate-pulse" />}

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {CHAINS.map((c) => {
          const s = info[c.key];
          if (!s) {
            return loaded ? (
              <div key={c.key} className="rounded-3xl border border-line bg-surface p-5 text-[0.875rem] text-ink-3">
                <ChainChip chain={c} /> <span className="ml-2">Couldn&apos;t read this chain&apos;s factory. It may be an older contract without safety controls.</span>
              </div>
            ) : null;
          }
          const r = role(s);
          const canOwner = r === "owner" || s.ownerIsContract;
          const pct = s.cap > 0n ? Number((s.total * 1000n) / s.cap) / 10 : 0;
          const level = s.cap === 0n ? "" : pct >= 100 ? "full" : pct >= 80 ? "warn" : "";
          const room = s.room ?? 0n;
          const totalUsd = toUsd(c, s.total);
          const capUsd = toUsd(c, s.cap);
          const newCap = capWei(c);
          return (
            <article key={c.key} className={"rounded-3xl border bg-surface p-4 sm:p-5 flex flex-col gap-4 " + (s.paused ? "border-danger" : "border-line")}>
              <div className="flex items-center gap-2">
                <ChainChip chain={c} />
                <span className={"ml-auto flex items-center gap-1.5 text-[0.8125rem] font-semibold " + (s.paused ? "text-danger" : "text-up")}>
                  <span className={"w-2 h-2 rounded-full " + (s.paused ? "bg-danger" : "bg-up")} aria-hidden="true" />
                  {s.paused ? "Buys paused" : "Open"}
                </span>
              </div>

              <div>
                <div className="flex justify-between text-[0.8125rem] text-ink-3">
                  <span>In bonding curves</span>
                  <span>{s.cap > 0n ? `${Math.round(pct)}% of cap` : "No cap"}</span>
                </div>
                <div className="font-display font-semibold text-[1.375rem] mt-0.5">
                  {totalUsd !== null ? usd(totalUsd, 0) : `${(Number(s.total) / 1e18).toFixed(4)} ${native(c)}`}
                  <span className="text-[0.875rem] text-ink-3 font-normal">
                    {" "}
                    / {s.cap > 0n ? (capUsd !== null ? usd(capUsd, 0) : `${(Number(s.cap) / 1e18).toFixed(4)} ${native(c)}`) : "∞"}
                  </span>
                </div>
                <div className="text-[0.75rem] text-ink-3 font-mono">
                  {(Number(s.total) / 1e18).toFixed(4)} / {s.cap > 0n ? (Number(s.cap) / 1e18).toFixed(4) : "∞"} {native(c)}
                </div>
                <div className="relative mt-2 h-3 rounded-full bg-paper border border-line overflow-hidden" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                  <div
                    className={"h-full rounded-full " + (level === "full" ? "bg-danger" : level === "warn" ? "bg-warn-ink" : "bg-up")}
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                  <span className="absolute top-0 bottom-0 left-[80%] w-0.5 bg-ink-3/60" aria-hidden="true" />
                </div>
              </div>

              {level === "warn" && (
                <p className="text-[0.8125rem] rounded-xl bg-warn-bg text-warn-ink px-3 py-2">
                  Over 80% full. {(Number(room) / 1e18).toFixed(4)} {native(c)} left
                  {toUsd(c, room) !== null ? ` (about ${usd(toUsd(c, room)!, 0)})` : ""}. Raise the cap before it fills.
                </p>
              )}
              {level === "full" && (
                <p className="text-[0.8125rem] rounded-xl bg-danger/15 text-danger px-3 py-2">
                  Full. New buys and launches here are refused until someone sells, a coin graduates, or you raise the cap.
                </p>
              )}

              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.8125rem]">
                <dt className="text-ink-3">Coins launched</dt>
                <dd className="text-right">{String(s.coins)}</dd>
                <dt className="text-ink-3">Factory</dt>
                <dd className="text-right font-mono">
                  <a href={explorerAddress(c, c.factory)} target="_blank" rel="noreferrer" className="underline decoration-line">
                    {shortAddr(c.factory)}
                  </a>
                </dd>
                <dt className="text-ink-3">Owner</dt>
                <dd className="text-right font-mono">
                  {shortAddr(s.owner)} {s.ownerIsContract ? "(Safe)" : eq(address, s.owner) ? "(you)" : ""}
                </dd>
                {s.pendingOwner !== ZERO && (
                  <>
                    <dt className="text-ink-3">Waiting to accept</dt>
                    <dd className="text-right font-mono text-warn-ink">{shortAddr(s.pendingOwner)}</dd>
                  </>
                )}
                <dt className="text-ink-3">Guardian</dt>
                <dd className="text-right font-mono">
                  {s.guardian === ZERO ? "none" : shortAddr(s.guardian)} {eq(address, s.guardian) ? "(you)" : ""}
                </dd>
              </dl>

              {s.pendingOwner !== ZERO && (
                <button
                  type="button"
                  onClick={() => void act(c, `accept-${c.key}`, "acceptOwnership", [], `Accept ownership on ${c.name}`, "Ownership accepted.")}
                  className="h-11 rounded-xl border border-warn-ink text-warn-ink font-semibold text-[0.875rem]"
                >
                  Accept ownership with the Safe
                </button>
              )}

              <div className="flex gap-2">
                {s.paused ? (
                  <button
                    type="button"
                    disabled={!canOwner || !!busy}
                    onClick={() => void act(c, `resume-${c.key}`, "unpauseBuys", [], `Resume buys on ${c.name}`, `Buys resumed on ${c.short}.`)}
                    className="flex-1 h-11 rounded-xl bg-emerald text-on-accent font-bold text-[0.9375rem] disabled:opacity-40"
                  >
                    {busy === `resume-${c.key}` ? "…" : s.ownerIsContract && r !== "owner" ? "Resume buys (Safe)" : "Resume buys"}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!r || !!busy}
                    onClick={() => void act(c, `pause-${c.key}`, "pauseBuys", [], `Pause buys on ${c.name}`, `Buys paused on ${c.short}.`)}
                    className="flex-1 h-11 rounded-xl border border-danger text-danger font-bold text-[0.9375rem] disabled:opacity-40"
                  >
                    {busy === `pause-${c.key}` ? "…" : "Pause buys"}
                  </button>
                )}
              </div>

              {canOwner ? (
                <div>
                  <div className="flex gap-2">
                    <label className="flex-1 min-w-0 flex items-center h-11 px-3 rounded-xl border border-line bg-paper focus-within:border-emerald">
                      <span className="text-ink-3 mr-1">$</span>
                      <input
                        inputMode="decimal"
                        aria-label={`New cap for ${c.name}, in dollars`}
                        placeholder={capUsd !== null && s.cap > 0n ? String(Math.round(capUsd)) : "0"}
                        value={capInput[c.key] ?? ""}
                        onChange={(e) => setCapInput((p) => ({ ...p, [c.key]: e.target.value.replace(/[^0-9.,]/g, "") }))}
                        className="w-full bg-transparent outline-none"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={newCap === null || !!busy}
                      onClick={() =>
                        newCap !== null &&
                        void act(
                          c,
                          `cap-${c.key}`,
                          "setNativeCap",
                          [newCap],
                          `Change the cap on ${c.name}`,
                          newCap === 0n ? `Cap removed on ${c.short}.` : `Cap on ${c.short} set.`
                        )
                      }
                      className="h-11 px-4 rounded-xl border border-line font-semibold text-[0.875rem] disabled:opacity-40"
                    >
                      {busy === `cap-${c.key}` ? "…" : "Change cap"}
                    </button>
                  </div>
                  <p className="text-[0.75rem] text-ink-3 mt-1.5">
                    {newCap !== null
                      ? newCap === 0n
                        ? "0 removes the cap."
                        : USD_MODE
                          ? `= $${(Number(newCap) / 1e6).toLocaleString("en-US")} of USDC.`
                          : `= ${(Number(newCap) / 1e18).toFixed(4)} ${native(c)} at today's price.`
                      : "In dollars, turned into " + native(c) + " at today's price. 0 removes the cap."}
                  </p>
                </div>
              ) : (
                <p className="text-[0.8125rem] text-ink-3">Only the owner can resume or change the cap.</p>
              )}
            </article>
          );
        })}
      </div>

      <p className="text-[0.8125rem] text-ink-3 mt-6 max-w-[65ch]">
        You get a notification when a chain is paused or resumed, passes 80% of its cap, or fills up.
      </p>

      {safeTx && <SafeSheet tx={safeTx} onClose={() => setSafeTx(null)} />}
      {address && <HelpInbox />}
    </div>
  );
}

function SafeSheet({ tx, onClose }: { tx: SafeTx; onClose: () => void }) {
  const [copied, setCopied] = useState("");
  const copy = (k: string, v: string) =>
    navigator.clipboard.writeText(v).then(() => {
      setCopied(k);
      setTimeout(() => setCopied(""), 1500);
    });
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="safe-title" onClick={onClose}>
      <div className="w-full max-w-lg rounded-3xl border border-line bg-surface p-5 grid gap-3 safe-bottom" onClick={(e) => e.stopPropagation()}>
        <h3 id="safe-title" className="font-display font-semibold text-[1.125rem]">{tx.title}</h3>
        <ol className="list-decimal pl-5 text-[0.875rem] text-ink-2 grid gap-1">
          <li>Open the Safe {shortAddr(tx.safe)} on {tx.chain.name}.</li>
          <li>New transaction → Transaction Builder → enter the contract and the data below (value 0).</li>
          <li>Sign, then confirm with a second key.</li>
        </ol>
        {(
          [
            ["Contract", tx.to],
            ["Data", tx.data],
          ] as const
        ).map(([k, v]) => (
          <button key={k} type="button" onClick={() => void copy(k, v)} className="text-left rounded-xl border border-line bg-paper p-3">
            <span className="flex justify-between text-[0.75rem] text-ink-3">
              <span>{k}</span>
              <span className="text-emerald font-semibold">{copied === k ? "Copied ✓" : "Tap to copy"}</span>
            </span>
            <span className="block font-mono text-[0.75rem] break-all mt-1">{v}</span>
          </button>
        ))}
        <div className="flex gap-2">
          <a href="https://app.safe.global/" target="_blank" rel="noreferrer" className="flex-1 h-11 rounded-xl bg-emerald text-on-accent font-bold flex items-center justify-center">
            Open Safe
          </a>
          <button type="button" onClick={onClose} className="h-11 px-5 rounded-xl border border-line font-semibold">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
