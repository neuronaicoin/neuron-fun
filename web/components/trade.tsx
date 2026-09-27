"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { encodeAbiParameters, formatEther, keccak256, maxUint256, numberToHex, type Address, type Hex } from "viem";
import { useWallet } from "./wallet";
import { ConnectButton } from "./chrome";
import { curveAbi, routerAbi, tokenAbi } from "@/lib/abis";
import { SLIPPAGE_BPS, explorerTx } from "@/lib/config";
import { clientFor, nativePerToken, type Coin, type CurveInfo } from "@/lib/data";
import { fmtEth, fmtTokens, friendlyError } from "@/lib/format";
import { usd } from "./coins";

const PRESETS = [10, 25, 50, 100];
const GAS_RESERVE = 300_000_000_000_000n; // 0.0003 ETH kept for fees

type Bal = { eth: bigint; tok: bigint };

/** Graduated coins trade in their locked pool through the router. */
const inPool = (c: CurveInfo) => c.state === "graduated";
const QUOTE_ACCOUNT: Address = "0x000000000000000000000000000000000000c0de";
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 300);

/** Storage slot of allowance(owner, spender) in the coin token (OpenZeppelin ERC20, slot 1). */
function allowanceSlot(owner: Address, spender: Address): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, 1n]));
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, inner]));
}

function ethFromUsd(usdAmount: number, ethUsd: number): bigint {
  const eth = usdAmount / ethUsd;
  return BigInt(Math.floor(eth * 1e9)) * 1_000_000_000n;
}

/**
 * The one trade box used everywhere. Buys are in dollars; the chain is picked
 * for you (cheapest chain where your wallet has enough), and you can change it.
 */
export function QuickTrade({ coin, ethUsd, onTraded }: { coin: Coin; ethUsd: number | null; onTraded: () => void }) {
  const { address, switchTo, walletClient } = useWallet();
  const open = coin.curves.filter((c) => c.state === "trading" || inPool(c));
  const sellable = coin.curves;
  const [side, setSide] = useState<"buy" | "sell">(open.length ? "buy" : "sell");
  const [usdIn, setUsdIn] = useState("25");
  const [sellPct, setSellPct] = useState(100);
  const [picked, setPicked] = useState<string | null>(null);
  const [bals, setBals] = useState<Record<string, Bal>>({});
  const [quote, setQuote] = useState<bigint | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ chainKey: string; hash: string } | null>(null);

  const loadBalances = useCallback(async () => {
    if (!address) return;
    const entries = await Promise.all(
      sellable.map(async (c) => {
        const pub = clientFor(c.chain);
        const [eth, tok] = await Promise.all([
          pub.getBalance({ address }).catch(() => 0n),
          pub.readContract({ address: c.token, abi: tokenAbi, functionName: "balanceOf", args: [address] }).catch(() => 0n),
        ]);
        return [c.chain.key, { eth, tok: tok as bigint }] as const;
      })
    );
    setBals(Object.fromEntries(entries));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, coin.id]);

  useEffect(() => {
    setBals({});
    loadBalances().catch(() => {});
  }, [loadBalances]);

  const buyWei = ethUsd ? ethFromUsd(Number(usdIn.replace(",", ".")) || 0, ethUsd) : 0n;

  // Cheapest chain where the wallet can pay; otherwise just the cheapest.
  const best = useMemo(() => {
    if (side === "sell") {
      return [...sellable].sort((a, b) => Number((bals[b.chain.key]?.tok ?? 0n) - (bals[a.chain.key]?.tok ?? 0n)))[0];
    }
    const byPrice = [...open].sort((a, b) => nativePerToken(a) - nativePerToken(b));
    const affordable = byPrice.find((c) => (bals[c.chain.key]?.eth ?? 0n) >= buyWei + GAS_RESERVE);
    return affordable ?? byPrice[0];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, bals, buyWei, coin.id]);

  const chosen: CurveInfo | undefined =
    (side === "buy" ? open : sellable).find((c) => c.chain.key === picked) ?? best;
  const bal = chosen ? bals[chosen.chain.key] : undefined;
  const sellWei = bal ? (bal.tok * BigInt(sellPct)) / 100n : 0n;
  const amount = side === "buy" ? buyWei : sellWei;

  // Price gap between the cheapest and dearest open chain, for the hint.
  const gap = useMemo(() => {
    if (open.length < 2) return null;
    const p = open.map((c) => nativePerToken(c)).sort((a, b) => a - b);
    return p[0] > 0 ? Math.round(((p[p.length - 1] - p[0]) / p[p.length - 1]) * 100) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coin.id, coin.curves.map((c) => String(c.virtualNative)).join()]);

  useEffect(() => {
    setQuote(null);
    if (!chosen || amount === 0n) return;
    const t = setTimeout(async () => {
      try {
        const pub = clientFor(chosen.chain);
        if (inPool(chosen)) {
          // Quote by simulating the router trade, with enough balance or allowance pretended.
          if (side === "buy") {
            const sim = await pub.simulateContract({
              account: QUOTE_ACCOUNT,
              address: chosen.chain.router,
              abi: routerAbi,
              functionName: "buy",
              args: [chosen.token, 0n, QUOTE_ACCOUNT, deadline()],
              value: amount,
              stateOverride: [{ address: QUOTE_ACCOUNT, balance: amount + 10n ** 18n }],
            });
            setQuote(sim.result as bigint);
          } else if (address) {
            const sim = await pub.simulateContract({
              account: address,
              address: chosen.chain.router,
              abi: routerAbi,
              functionName: "sell",
              args: [chosen.token, amount, 0n, address, deadline()],
              stateOverride: [
                { address: chosen.token, stateDiff: [{ slot: allowanceSlot(address, chosen.chain.router), value: numberToHex(maxUint256, { size: 32 }) }] },
              ],
            });
            setQuote(sim.result as bigint);
          }
          return;
        }
        const q = await pub.readContract({
          address: chosen.curve,
          abi: curveAbi,
          functionName: side === "buy" ? "quoteBuy" : "quoteSell",
          args: [amount],
        });
        setQuote(q as bigint);
      } catch {
        setQuote(null);
      }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, amount, chosen?.curve, chosen?.state, address]);

  if (!open.length && !sellable.length) {
    return (
      <div className="rounded-3xl border border-line bg-surface p-5 text-[15px] text-ink-2">
        ${coin.symbol} graduated on {coin.graduatedOn?.chain.short}. It now trades in its locked pool there.
      </div>
    );
  }

  const notEnough = side === "buy" ? !!bal && bal.eth < buyWei + GAS_RESERVE : sellWei === 0n;
  const closedHere = chosen?.state === "closed";

  async function submit() {
    if (!address || !chosen || amount === 0n) return;
    setError("");
    setDone(null);
    try {
      setBusy(`Switching to ${chosen.chain.short}…`);
      await switchTo(chosen.chain.chain);
      const pub = clientFor(chosen.chain);
      const wc = walletClient(chosen.chain.chain);
      let hash: Hex;
      // Curve before graduation, locked pool (through the router) after.
      const pool = inPool(chosen);
      const spender = pool ? chosen.chain.router : chosen.curve;
      if (side === "buy") {
        const sim = pool
          ? await pub.simulateContract({ account: address, address: spender, abi: routerAbi, functionName: "buy", args: [chosen.token, 0n, address, deadline()], value: amount })
          : await pub.simulateContract({ account: address, address: spender, abi: curveAbi, functionName: "buy", args: [0n, address], value: amount });
        const minOut = ((sim.result as bigint) * (10_000n - SLIPPAGE_BPS)) / 10_000n;
        setBusy("Confirm in your wallet…");
        hash = pool
          ? await wc.writeContract({ chain: chosen.chain.chain, account: address, address: spender, abi: routerAbi, functionName: "buy", args: [chosen.token, minOut, address, deadline()], value: amount })
          : await wc.writeContract({ chain: chosen.chain.chain, account: address, address: spender, abi: curveAbi, functionName: "buy", args: [minOut, address], value: amount });
      } else {
        const allowance = (await pub.readContract({ address: chosen.token, abi: tokenAbi, functionName: "allowance", args: [address, spender] })) as bigint;
        if (allowance < amount) {
          setBusy("Step 1 of 2: allow selling…");
          const h = await wc.writeContract({ chain: chosen.chain.chain, account: address, address: chosen.token, abi: tokenAbi, functionName: "approve", args: [spender, amount] });
          await pub.waitForTransactionReceipt({ hash: h });
        }
        const sim = pool
          ? await pub.simulateContract({ account: address, address: spender, abi: routerAbi, functionName: "sell", args: [chosen.token, amount, 0n, address, deadline()] })
          : await pub.simulateContract({ account: address, address: spender, abi: curveAbi, functionName: "sell", args: [amount, 0n, address] });
        const minOut = ((sim.result as bigint) * (10_000n - SLIPPAGE_BPS)) / 10_000n;
        setBusy(allowance < amount ? "Step 2 of 2: confirm the sale…" : "Confirm in your wallet…");
        hash = pool
          ? await wc.writeContract({ chain: chosen.chain.chain, account: address, address: spender, abi: routerAbi, functionName: "sell", args: [chosen.token, amount, minOut, address, deadline()] })
          : await wc.writeContract({ chain: chosen.chain.chain, account: address, address: spender, abi: curveAbi, functionName: "sell", args: [amount, minOut, address] });
      }
      setBusy("Almost done…");
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("The network rejected the transaction.");
      setDone({ chainKey: chosen.chain.key, hash });
      await loadBalances();
      onTraded();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  const doneChain = done ? coin.curves.find((c) => c.chain.key === done.chainKey)?.chain : null;
  const receive =
    quote === null
      ? "…"
      : side === "buy"
        ? `${fmtTokens(quote)} $${coin.symbol}`
        : ethUsd
          ? usd(Number(formatEther(quote)) * ethUsd, 2)
          : fmtEth(quote, 6);

  return (
    <div className="rounded-3xl border border-line bg-surface p-4 sm:p-5">
      <div className="grid grid-cols-2 gap-1 p-1 rounded-2xl bg-paper" role="tablist" aria-label="Buy or sell">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={side === s}
            disabled={s === "buy" && !open.length}
            onClick={() => { setSide(s); setPicked(null); setError(""); setDone(null); }}
            className={"h-11 rounded-xl text-[15px] font-bold disabled:opacity-30 " + (side === s ? (s === "buy" ? "bg-up text-on-accent" : "bg-danger text-white") : "text-ink-2")}
          >
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      {side === "buy" ? (
        <>
          <label className="block mt-5">
            <span className="text-[13px] font-semibold text-ink-3">You pay</span>
            <div className="mt-2 flex items-center h-16 px-4 rounded-2xl border border-line bg-paper focus-within:border-emerald">
              <span className="font-display text-[26px] text-ink-3 mr-1">$</span>
              <input
                value={usdIn}
                onChange={(e) => setUsdIn(e.target.value.replace(/[^0-9.,]/g, ""))}
                inputMode="decimal"
                aria-label="Amount in dollars"
                className="w-full bg-transparent font-display text-[28px] outline-none"
              />
            </div>
          </label>
          <div className="grid grid-cols-4 gap-2 mt-2">
            {PRESETS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setUsdIn(String(v))}
                className={"h-10 rounded-xl text-[14px] font-semibold border " + (Number(usdIn) === v ? "border-emerald text-ink" : "border-line text-ink-2")}
              >
                ${v}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="mt-5 text-[13px] font-semibold text-ink-3">You sell</div>
          <div className="grid grid-cols-4 gap-2 mt-2">
            {[25, 50, 75, 100].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setSellPct(v)}
                className={"h-12 rounded-xl text-[15px] font-bold border " + (sellPct === v ? "border-danger text-ink" : "border-line text-ink-2")}
              >
                {v === 100 ? "All" : `${v}%`}
              </button>
            ))}
          </div>
          {address && bal && (
            <p className="text-[12px] text-ink-3 mt-2">
              You hold {fmtTokens(bal.tok)} ${coin.symbol} on {chosen?.chain.short}
            </p>
          )}
        </>
      )}

      {(side === "buy" ? open : sellable).length > 1 && chosen && (
        <div className="mt-4">
          <div className="flex items-center justify-between text-[12px] text-ink-3">
            <span>{side === "buy" ? "Buying on" : "Selling on"}</span>
            {side === "buy" && gap !== null && gap > 0 && picked === null && (
              <span className="text-up font-semibold">Best price picked · up to {gap}% cheaper</span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {(side === "buy" ? open : sellable).map((c) => (
              <button
                key={c.chain.key}
                type="button"
                onClick={() => setPicked(c.chain.key)}
                className={"h-8 px-3 rounded-full text-[12px] font-semibold border " + (c.chain.key === chosen.chain.key ? "text-white border-transparent" : "border-line text-ink-2")}
                style={c.chain.key === chosen.chain.key ? { background: c.chain.color } : undefined}
              >
                {c.chain.short}
                {c.state === "closed" ? " · closed" : inPool(c) ? " · pool" : ""}
              </button>
            ))}
          </div>
        </div>
      )}

      {closedHere && (
        <p className="mt-3 text-[13px] text-warn-ink bg-warn-bg rounded-xl p-3">
          Buying stopped on {chosen?.chain.short}. You can always sell here and get your money back.
        </p>
      )}

      <div className="mt-4 flex items-center justify-between rounded-2xl bg-paper px-4 py-3 text-[14px]">
        <span className="text-ink-3">You get</span>
        <span className="font-mono">{amount === 0n ? "—" : receive}</span>
      </div>

      <div className="mt-4">
        {!address ? (
          <ConnectButton full />
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!!busy || amount === 0n || notEnough || !ethUsd && side === "buy"}
            className={"w-full h-14 rounded-2xl text-[16px] font-bold disabled:opacity-40 " + (side === "buy" ? "bg-up text-on-accent" : "bg-danger text-white")}
          >
            {busy ||
              (notEnough
                ? side === "buy"
                  ? `Not enough ETH on ${chosen?.chain.short}`
                  : `No $${coin.symbol} to sell here`
                : side === "buy"
                  ? `Buy $${coin.symbol}`
                  : `Sell $${coin.symbol}`)}
          </button>
        )}
      </div>

      {error && <p className="mt-3 text-[13px] text-danger" role="alert">{error}</p>}
      {done && doneChain && (
        <p className="mt-3 text-[13px] text-up">
          Done.{" "}
          <a className="underline" href={explorerTx(doneChain, done.hash)} target="_blank" rel="noreferrer">
            View transaction
          </a>
        </p>
      )}
      <p className="mt-4 text-[11px] leading-relaxed text-ink-3">
        1% fee. If the price moves more than 5% before it lands, the trade is cancelled and nothing is spent.
      </p>
    </div>
  );
}
