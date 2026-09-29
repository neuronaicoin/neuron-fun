"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { encodeAbiParameters, formatEther, keccak256, maxUint256, numberToHex, type Address, type Hex } from "viem";
import { useWallet } from "./wallet";
import { ConnectButton } from "./chrome";
import { curveAbi, routerAbi, tokenAbi } from "@/lib/abis";
import { SLIPPAGE_BPS, explorerTx } from "@/lib/config";
import { call, type Call } from "@/lib/tx";
import { signalTrade } from "@/lib/live";
import { fetchTrades } from "@/lib/data";
import { IS_TESTNET } from "@/lib/config";
import type { ProfitInfo } from "@/lib/pnlcard";
import { ProfitCard } from "./profitcard";
import { coinShareUrl } from "./share";
import { clientFor, nativePerToken, type Coin, type CurveInfo } from "@/lib/data";
import { fmtEth, fmtTokens, friendlyError } from "@/lib/format";
import { usd } from "./coins";
import { openMoney, refreshPortfolio } from "@/lib/portfolio";
import { routerOf, setOf } from "@/lib/contracts";
import { AutoOrders } from "./autoorders";
import { overCap, refreshSafety, useSafety } from "@/lib/safety";

const PRESETS = [10, 25, 50, 100];
const GAS_RESERVE = 50_000_000_000_000n; // 0.00005 ETH kept for network fees (L2 fees are far below this)

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
export function QuickTrade({
  coin,
  ethUsd,
  onTraded,
  initialSide,
  bare = false,
  initialSellPct,
  initialUsd,
  initialChainId,
  onDone,
}: {
  coin: Coin;
  ethUsd: number | null;
  onTraded: () => void;
  /** Which tab to open on (the phone Buy / Sell buttons pass this). */
  initialSide?: "buy" | "sell";
  /** Without its own card frame, for use inside a sheet. */
  bare?: boolean;
  /** Share to sell when opening on the Sell tab (portfolio quick sell). */
  initialSellPct?: number;
  /** Dollar amount to start with (copy signals). */
  initialUsd?: string;
  /** Chain to start on (copy signals: where the trader traded). */
  initialChainId?: number;
  /** Called once a trade is confirmed. */
  onDone?: (r: { hash: string; side: "buy" | "sell"; chainKey: string }) => void;
}) {
  const { address, embedded, send } = useWallet();
  // Email users pay no network fees, so nothing needs to be kept back.
  const reserve = embedded ? 0n : GAS_RESERVE;
  const open = coin.curves.filter((c) => c.state === "trading" || inPool(c));
  const sellable = coin.curves;
  const [side, setSide] = useState<"buy" | "sell">(initialSide ?? (open.length ? "buy" : "sell"));
  // Auto orders (take profit, stop loss, buy the dip) live in their own tab.
  const [auto, setAuto] = useState(false);
  const autoReady = coin.curves.some((c) => !!c.chain.orders);
  const [usdIn, setUsdIn] = useState(initialUsd ?? "25");
  const [sellPct, setSellPct] = useState(initialSellPct ?? 100);
  const [picked, setPicked] = useState<string | null>(
    () => coin.curves.find((c) => c.chain.chain.id === initialChainId)?.chain.key ?? null
  );
  const [bals, setBals] = useState<Record<string, Bal>>({});
  const [quote, setQuote] = useState<bigint | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ chainKey: string; hash: string } | null>(null);
  const [profit, setProfit] = useState<ProfitInfo | null>(null);
  const safety = useSafety();
  // Curves from an earlier contract set have no beta locks; only the live set does.
  const [legacy, setLegacy] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    Promise.all(coin.curves.map(async (c) => ((await setOf(c)).live ? null : c.curve.toLowerCase())))
      .then((r) => live && setLegacy(new Set(r.filter((x): x is string => !!x))))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coin.id]);

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

  const walletEmpty = !!address && Object.keys(bals).length > 0 && Object.values(bals).every((b) => b.eth === 0n && b.tok === 0n);
  useEffect(() => {
    if (!walletEmpty) return;
    const t = setInterval(() => loadBalances().catch(() => {}), 8_000);
    return () => clearInterval(t);
  }, [walletEmpty, loadBalances]);

  const buyWei = ethUsd ? ethFromUsd(Number(usdIn.replace(",", ".")) || 0, ethUsd) : 0n;
  // What a buy adds to the curve (the 1% fee is on top).
  const buyNet = (buyWei * 100n) / 101n;

  /** Why a buy can't go through on this curve right now (beta locks), or null. */
  const lockOf = (c: CurveInfo | undefined): "paused" | "full" | null => {
    if (!c || inPool(c) || c.state !== "trading" || legacy.has(c.curve.toLowerCase())) return null;
    const s = safety[c.chain.key];
    if (s?.paused) return "paused";
    if (buyNet > 0n && overCap(s, buyNet)) return "full";
    return null;
  };

  // Cheapest chain where the wallet can pay; otherwise just the cheapest.
  const best = useMemo(() => {
    if (side === "sell") {
      return [...sellable].sort((a, b) => Number((bals[b.chain.key]?.tok ?? 0n) - (bals[a.chain.key]?.tok ?? 0n)))[0];
    }
    const sorted = [...open].sort((a, b) => nativePerToken(a) - nativePerToken(b));
    // Chains that are paused or full go last.
    const byPrice = [...sorted.filter((c) => !lockOf(c)), ...sorted.filter((c) => lockOf(c))];
    const affordable = byPrice.find((c) => !lockOf(c) && (bals[c.chain.key]?.eth ?? 0n) >= buyWei + reserve);
    return affordable ?? byPrice[0];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, bals, buyWei, coin.id, safety, legacy]);

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
          const router = await routerOf(chosen);
          if (side === "buy") {
            const sim = await pub.simulateContract({
              account: QUOTE_ACCOUNT,
              address: router,
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
              address: router,
              abi: routerAbi,
              functionName: "sell",
              args: [chosen.token, amount, 0n, address, deadline()],
              stateOverride: [
                { address: chosen.token, stateDiff: [{ slot: allowanceSlot(address, router), value: numberToHex(maxUint256, { size: 32 }) }] },
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
      <div className="rounded-3xl border border-line bg-surface p-5 text-[0.9375rem] text-ink-2">
        ${coin.symbol} graduated on {coin.graduatedOn?.chain.short}. It now trades in its locked pool there.
      </div>
    );
  }

  const notEnough = side === "buy" ? !!bal && bal.eth < buyWei + reserve : sellWei === 0n;
  const closedHere = chosen?.state === "closed";
  const lock = side === "buy" ? lockOf(chosen) : null;
  // Another chain of this coin where the buy would go through.
  const elsewhere = lock ? open.find((c) => c.chain.key !== chosen?.chain.key && !lockOf(c)) : undefined;

  /** Compares a sale with the average price this wallet paid for the coin. */
  async function checkProfit(soldTokens: bigint, got: bigint, chainName: string) {
    if (!address) return;
    const buys = (await fetchTrades({ coinId: coin.id, trader: address, limit: 500 })).filter((t) => t.isBuy);
    const spent = buys.reduce((a, t) => a + t.nativeAmount, 0);
    const bought = buys.reduce((a, t) => a + t.tokenAmount, 0);
    if (spent <= 0 || bought <= 0) return;
    const cost = (spent / bought) * Number(soldTokens);
    const gotNum = Number(got);
    const pct = (gotNum - cost) / cost;
    if (!Number.isFinite(pct) || pct < 0.05) return;
    const fmt = (wei: number) => (ethUsd ? usd((wei / 1e18) * ethUsd, 2) : `${(wei / 1e18).toFixed(5)} ETH`);
    setProfit({
      name: coin.name,
      symbol: coin.symbol,
      logo: coin.logo,
      pct,
      profit: `+${fmt(gotNum - cost)}`,
      cost: fmt(cost),
      proceeds: fmt(gotNum),
      chain: chainName,
      testnet: IS_TESTNET,
    });
  }

  async function submit() {
    if (!address || !chosen || amount === 0n) return;
    setError("");
    setDone(null);
    try {
      // Curve before graduation, locked pool (through the router) after.
      const pool = inPool(chosen);
      const spender = pool ? await routerOf(chosen) : chosen.curve;
      const pub = clientFor(chosen.chain);
      setBusy("Preparing…");
      const calls: Call[] = [];
      let proceeds: bigint | null = null;
      if (side === "buy") {
        // The quote on screen is fresh (it follows every change); only fetch if it isn't there yet.
        const out =
          quote ??
          (pool
            ? ((await pub.simulateContract({ account: address, address: spender, abi: routerAbi, functionName: "buy", args: [chosen.token, 0n, address, deadline()], value: amount })).result as bigint)
            : ((await pub.readContract({ address: spender, abi: curveAbi, functionName: "quoteBuy", args: [amount] })) as bigint));
        const minOut = (out * (10_000n - SLIPPAGE_BPS)) / 10_000n;
        calls.push(
          pool
            ? call(spender, routerAbi, "buy", [chosen.token, minOut, address, deadline()], amount)
            : call(spender, curveAbi, "buy", [minOut, address], amount)
        );
      } else {
        const [out, allowance] = await Promise.all([
          quote !== null
            ? Promise.resolve(quote)
            : pool
          ? pub.simulateContract({
                account: address,
                address: spender,
                abi: routerAbi,
                functionName: "sell",
                args: [chosen.token, amount, 0n, address, deadline()],
                stateOverride: [
                  { address: chosen.token, stateDiff: [{ slot: allowanceSlot(address, spender), value: numberToHex(maxUint256, { size: 32 }) }] },
                ],
              }).then((r) => r.result as bigint)
          : (pub.readContract({ address: spender, abi: curveAbi, functionName: "quoteSell", args: [amount] }) as Promise<bigint>),
          pub.readContract({ address: chosen.token, abi: tokenAbi, functionName: "allowance", args: [address, spender] }) as Promise<bigint>,
        ]);
        const minOut = (out * (10_000n - SLIPPAGE_BPS)) / 10_000n;
        proceeds = out;
        // Email users get approve + sell as one gasless bundle; wallets confirm each.
        if (allowance < amount) calls.push(call(chosen.token, tokenAbi, "approve", [spender, amount]));
        calls.push(
          pool
            ? call(spender, routerAbi, "sell", [chosen.token, amount, minOut, address, deadline()])
            : call(spender, curveAbi, "sell", [amount, minOut, address])
        );
      }
      const hash = await send(chosen.chain.chain, calls, setBusy);
      setDone({ chainKey: chosen.chain.key, hash });
      onDone?.({ hash, side, chainKey: chosen.chain.key });
      // Tell the chart and trade list right away; read the new curve price for an instant update.
      const signal = (nativePerToken: number | null) =>
        signalTrade({ chainId: chosen.chain.chain.id, curve: chosen.curve, coinId: coin.id, nativePerToken });
      if (pool) signal(null);
      else
        Promise.all([
          pub.readContract({ address: chosen.curve, abi: curveAbi, functionName: "virtualNative" }) as Promise<bigint>,
          pub.readContract({ address: chosen.curve, abi: curveAbi, functionName: "virtualToken" }) as Promise<bigint>,
        ])
          .then(([vn, vt]) => signal(Number(vn) / Number(vt)))
          .catch(() => signal(null));
      // Refresh in the background; the trade is already confirmed.
      loadBalances().catch(() => {});
      void refreshPortfolio();
      onTraded();
      // A sell that made 5% or more gets a card to share.
      if (side === "sell" && proceeds !== null) {
        const soldTokens = amount;
        const got = proceeds;
        checkProfit(soldTokens, got, chosen.chain.short).catch(() => {});
      }
    } catch (e) {
      setError(friendlyError(e));
      // A pause or a full chain may be why: show it on the button right away.
      void refreshSafety().catch(() => {});
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

  const tabs = (
    <div className={"grid gap-1 p-1 rounded-2xl bg-paper " + (autoReady ? "grid-cols-3" : "grid-cols-2")} role="tablist" aria-label="Buy, sell or auto">
      {(["buy", "sell"] as const).map((s) => (
        <button
          key={s}
          type="button"
          role="tab"
          aria-selected={!auto && side === s}
          disabled={s === "buy" && !open.length}
          onClick={() => { setAuto(false); setSide(s); setPicked(null); setError(""); setDone(null); }}
          className={"h-11 rounded-xl text-[0.9375rem] font-bold disabled:opacity-30 " + (!auto && side === s ? (s === "buy" ? "bg-up text-on-accent" : "bg-danger text-white") : "text-ink-2")}
        >
          {s === "buy" ? "Buy" : "Sell"}
        </button>
      ))}
      {autoReady && (
        <button
          type="button"
          role="tab"
          aria-selected={auto}
          onClick={() => { setAuto(true); setError(""); setDone(null); }}
          className={"h-11 rounded-xl text-[0.9375rem] font-bold flex items-center justify-center gap-1 " + (auto ? "bg-surface text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-2")}
        >
          Auto
          <span className="text-[0.5625rem] font-bold uppercase tracking-wide px-1 py-px rounded bg-emerald text-on-accent">new</span>
        </button>
      )}
    </div>
  );

  if (auto) {
    return (
      <div className={bare ? "" : "rounded-3xl border border-line bg-surface p-4 sm:p-5"}>
        {tabs}
        <AutoOrders coin={coin} ethUsd={ethUsd} />
      </div>
    );
  }

  return (
    <div className={bare ? "" : "rounded-3xl border border-line bg-surface p-4 sm:p-5"}>
      {tabs}

      {side === "buy" ? (
        <>
          <label className="block mt-5">
            <span className="flex items-center justify-between gap-2 text-[0.8125rem] font-semibold text-ink-3">
              <span>You pay</span>
              {address && bal && ethUsd !== null && (
                <span className="font-normal">
                  Cash {usd((Number(bal.eth) / 1e18) * ethUsd, 2)} ·{" "}
                  <button type="button" onClick={(e) => { e.preventDefault(); openMoney({ kind: "deposit" }); }} className="font-bold text-emerald">
                    ＋ Deposit
                  </button>
                </span>
              )}
            </span>
            <div className="mt-2 flex items-center h-16 px-4 rounded-2xl border border-line bg-paper focus-within:border-emerald">
              <span className="font-display text-[1.625rem] text-ink-3 mr-1">$</span>
              <input
                value={usdIn}
                onChange={(e) => setUsdIn(e.target.value.replace(/[^0-9.,]/g, ""))}
                inputMode="decimal"
                aria-label="Amount in dollars"
                className="w-full bg-transparent font-display text-[1.75rem] outline-none"
              />
            </div>
          </label>
          <div className="grid grid-cols-4 gap-2 mt-2">
            {PRESETS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setUsdIn(String(v))}
                className={"h-10 rounded-xl text-[0.875rem] font-semibold border " + (Number(usdIn) === v ? "border-emerald text-ink" : "border-line text-ink-2")}
              >
                ${v}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="mt-5 text-[0.8125rem] font-semibold text-ink-3">You sell</div>
          <div className="grid grid-cols-4 gap-2 mt-2">
            {[25, 50, 75, 100].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setSellPct(v)}
                className={"h-12 rounded-xl text-[0.9375rem] font-bold border " + (sellPct === v ? "border-danger text-ink" : "border-line text-ink-2")}
              >
                {v === 100 ? "All" : `${v}%`}
              </button>
            ))}
          </div>
          {address && bal && (
            <p className="text-[0.75rem] text-ink-3 mt-2">
              You hold {fmtTokens(bal.tok)} ${coin.symbol} on {chosen?.chain.short}
              {ethUsd !== null && chosen && bal.tok > 0n ? ` (≈ ${usd(Number(formatEther(bal.tok)) * nativePerToken(chosen) * ethUsd, 2)})` : ""}
            </p>
          )}
        </>
      )}

      {(side === "buy" ? open : sellable).length > 1 && chosen && (
        <div className="mt-4">
          <div className="flex items-center justify-between text-[0.75rem] text-ink-3">
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
                className={"h-8 px-3 rounded-full text-[0.75rem] font-semibold border " + (c.chain.key === chosen.chain.key ? "text-white border-transparent" : "border-line text-ink-2")}
                style={c.chain.key === chosen.chain.key ? { background: c.chain.color } : undefined}
              >
                {c.chain.short}
                {c.state === "closed"
                  ? " · closed"
                  : inPool(c)
                    ? " · pool"
                    : side === "buy" && lockOf(c) === "paused"
                      ? " · paused"
                      : side === "buy" && lockOf(c) === "full"
                        ? " · full"
                        : ""}
              </button>
            ))}
          </div>
        </div>
      )}

      {lock && chosen && (
        <p className="mt-3 text-[0.8125rem] text-warn-ink bg-warn-bg rounded-xl p-3" role="status">
          {lock === "paused"
            ? `Buying on ${chosen.chain.short} is paused for a moment. Selling works as usual.`
            : `${chosen.chain.short} is at its beta capacity right now, so this buy can't go through. Try a smaller amount${elsewhere ? "" : " or come back soon"}.`}
          {elsewhere && (
            <>
              {" "}
              <button type="button" onClick={() => setPicked(elsewhere.chain.key)} className="font-bold text-emerald">
                Buy on {elsewhere.chain.short} instead
              </button>
            </>
          )}
        </p>
      )}

      {closedHere && (
        <p className="mt-3 text-[0.8125rem] text-warn-ink bg-warn-bg rounded-xl p-3">
          Buying stopped on {chosen?.chain.short}. You can always sell here and get your money back.
        </p>
      )}

      <div className="mt-4 flex items-center justify-between rounded-2xl bg-paper px-4 py-3 text-[0.875rem]">
        <span className="text-ink-3">You get</span>
        <span className="font-mono">{amount === 0n ? "—" : receive}</span>
      </div>

      {walletEmpty && IS_TESTNET && <FundingGuide address={address!} chains={sellable.map((c) => c.chain)} gasless={embedded} />}

      <div className="mt-4">
        {!address ? (
          <ConnectButton full />
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!!busy || amount === 0n || notEnough || !!lock || (!ethUsd && side === "buy")}
            className={"w-full h-14 rounded-2xl text-[1rem] font-bold disabled:opacity-40 " + (side === "buy" ? "bg-up text-on-accent" : "bg-danger text-white")}
          >
            {busy ||
              (lock === "paused"
                ? "Buying paused"
                : lock === "full"
                  ? "Chain full"
                  : notEnough
                ? side === "buy"
                  ? "Not enough cash"
                  : `No $${coin.symbol} to sell here`
                : side === "buy"
                  ? `Buy $${coin.symbol}`
                  : `Sell $${coin.symbol}`)}
          </button>
        )}
      </div>

      {address && side === "buy" && notEnough && (
        <p className="mt-2 text-center text-[0.875rem] text-ink-2">
          <button type="button" onClick={() => openMoney({ kind: "deposit" })} className="font-bold text-emerald">
            Deposit
          </button>{" "}
          from any chain or exchange.
        </p>
      )}
      {error && <p className="mt-3 text-[0.8125rem] text-danger" role="alert">{error}</p>}
      {done && doneChain && (
        <p className="mt-3 text-[0.8125rem] text-up">
          Done.{" "}
          <a className="underline" href={explorerTx(doneChain, done.hash)} target="_blank" rel="noreferrer">
            View transaction
          </a>
        </p>
      )}
      <p className="mt-4 text-[0.6875rem] leading-relaxed text-ink-3">
        1% fee. If the price moves more than 5% before it lands, the trade is cancelled and nothing is spent.
      </p>
    {profit && <ProfitCard info={profit} link={coinShareUrl(coin.id)} onClose={() => setProfit(null)} />}
    </div>
  );
}

/** First visit with an empty wallet: how to get free test ETH. Disappears once ETH arrives. */
export function FundingGuide({ address, chains, gasless }: { address: string; chains: CurveInfo["chain"][]; gasless: boolean }) {
  const [copied, setCopied] = useState(false);
  const withFaucet = chains.filter((c, i, a) => c.faucet && a.findIndex((x) => x.key === c.key) === i);
  return (
    <div className="mt-4 rounded-2xl border border-emerald/40 bg-emerald-soft p-4">
      <p className="font-semibold text-[0.9375rem]">Your wallet is ready. Add free test ETH to start.</p>
      <ol className="mt-3 grid gap-3 text-[0.8125rem]">
        <li className="flex gap-2">
          <span className="w-5 h-5 rounded-full bg-emerald text-on-accent text-[0.6875rem] font-bold flex items-center justify-center shrink-0">1</span>
          <span className="min-w-0 flex-1">
            Copy your address.{gasless ? " It\u2019s the same on every chain." : ""}
            <button
              type="button"
              onClick={() =>
                navigator.clipboard.writeText(address).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
              className="mt-1.5 w-full text-left font-mono text-[0.75rem] break-all rounded-xl bg-surface border border-line px-3 py-2"
            >
              {address}
              <span className="block font-sans text-emerald mt-0.5">{copied ? "Copied ✓" : "Tap to copy"}</span>
            </button>
          </span>
        </li>
        <li className="flex gap-2">
          <span className="w-5 h-5 rounded-full bg-emerald text-on-accent text-[0.6875rem] font-bold flex items-center justify-center shrink-0">2</span>
          <span className="min-w-0 flex-1">
            Paste it into a free faucet:
            <span className="flex flex-wrap gap-1.5 mt-1.5">
              {withFaucet.map((c) => (
                <a key={c.key} href={c.faucet} target="_blank" rel="noreferrer" className="h-8 px-3 rounded-full text-[0.75rem] font-semibold text-white flex items-center" style={{ background: c.color }}>
                  {c.short} faucet ↗
                </a>
              ))}
            </span>
          </span>
        </li>
        <li className="flex gap-2">
          <span className="w-5 h-5 rounded-full bg-emerald text-on-accent text-[0.6875rem] font-bold flex items-center justify-center shrink-0">3</span>
          <span className="min-w-0 flex-1 flex items-center gap-2">
            Come back here. We&apos;ll spot it automatically.
            <span className="w-2 h-2 rounded-full bg-emerald animate-pulse shrink-0" aria-hidden="true" />
          </span>
        </li>
      </ol>
      <p className="text-[0.6875rem] text-ink-3 mt-3">
        Test ETH is free and has no value.{" "}
        {gasless ? "Signed in with email, you never pay network fees." : "Keep a little extra for network fees, or log in with email to trade without them."}
      </p>
    </div>
  );
}
