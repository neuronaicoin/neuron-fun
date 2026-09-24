"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatEther, formatUnits, isAddress, parseEther, parseUnits, getAddress, type Address } from "viem";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { CoinAvatar, Stat, Skeleton } from "@/components/coins";
import { routerAbi, tokenAbi, splitterAbi } from "@/lib/abis";
import { ADDR, SLIPPAGE_BPS, chain, explorerAddress, explorerTx } from "@/lib/config";
import { fetchLaunches, fetchCoin, poolKeyFor, publicClient, sqrtPriceOf, type Coin, type PoolKey } from "@/lib/data";
import { fmtEth, fmtTokens, friendlyError, shortAddr } from "@/lib/format";

export default function CoinPageWrapper() {
  return (
    <Suspense fallback={<div className="max-w-5xl mx-auto px-4 py-10"><Skeleton className="h-64" /></div>}>
      <CoinPage />
    </Suspense>
  );
}

function CoinPage() {
  const params = useSearchParams();
  const raw = params.get("a") ?? "";
  const valid = isAddress(raw);
  const [coin, setCoin] = useState<Coin | null>(null);
  const [key, setKey] = useState<PoolKey | null>(null);
  const [parentBurned, setParentBurned] = useState<bigint | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!valid) return;
    const token = getAddress(raw);
    try {
      const launches = await fetchLaunches();
      const launch = launches.find((l) => l.token.toLowerCase() === token.toLowerCase());
      if (!launch) return setNotFound(true);
      const [c, k, pb] = await Promise.all([
        fetchCoin(launch),
        poolKeyFor(token),
        publicClient.readContract({ address: launch.splitter, abi: splitterAbi, functionName: "totalParentBurned" }),
      ]);
      setCoin(c);
      setKey(k);
      setParentBurned(pb);
    } catch {
      setNotFound(true);
    }
  }, [raw, valid]);

  useEffect(() => {
    load();
  }, [load]);

  if (!valid || notFound) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-semibold text-[28px]">Coin not found</h1>
        <p className="text-ink-2 mt-3">This link doesn&apos;t point to a Neuron.fun coin.</p>
        <Link href="/" className="inline-flex mt-6 h-12 px-6 rounded-xl bg-emerald text-white font-semibold items-center">
          Explore coins
        </Link>
      </div>
    );
  }

  if (!coin || !key) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 grid gap-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
      <Link href="/" className="text-[14px] font-semibold text-emerald">← All coins</Link>

      <div className="mt-5 flex items-start gap-4">
        <CoinAvatar logo={coin.logo} symbol={coin.symbol} size={68} />
        <div className="min-w-0">
          <h1 className="font-display font-semibold text-[28px] sm:text-[36px] leading-tight tracking-tight break-words">{coin.name}</h1>
          <p className="text-ink-2 text-[15px] mt-1">
            ${coin.symbol} · family of <span className="font-semibold text-emerald">${coin.parentSymbol}</span>
          </p>
        </div>
      </div>
      {coin.description && <p className="text-[16px] text-ink-2 mt-4 leading-relaxed max-w-2xl">{coin.description}</p>}

      <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 gap-4 bg-white border border-line rounded-2xl p-5">
        <Stat label="Market value" value={fmtEth(coin.marketCapWei, 4)} />
        <Stat label={`$${coin.parentSymbol} burned`} value={fmtTokens(parentBurned)} />
        <Stat label="Spent on burns" value={fmtEth(coin.burnedForParentWei, 6)} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px] lg:items-start">
        <div className="order-2 lg:order-1 grid gap-6">
          <div className="bg-night text-mist rounded-2xl p-6">
            <h2 className="font-display font-semibold text-[20px]">How this coin feeds its family</h2>
            <p className="text-[#a9bab3] text-[15px] mt-2 leading-relaxed">
              Every buy and sell pays a 1% fee. Part of it buys ${coin.parentSymbol} and burns it forever, part goes to
              the coin&apos;s creator, and part keeps Neuron.fun running.
            </p>
            <div className="mt-5 grid gap-3">
              {[
                ["Burns the family coin", "0.3%", "30%"],
                ["Goes to the creator", "0.3%", "30%"],
                ["Runs the platform", "0.4%", "40%"],
              ].map(([l, p, w]) => (
                <div key={l}>
                  <div className="flex justify-between text-[14px]"><span>{l}</span><span className="font-mono">{p}</span></div>
                  <div className="h-1.5 rounded-full bg-night-line mt-1.5"><div className="h-1.5 rounded-full bg-mint" style={{ width: w }} /></div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white border border-line rounded-2xl p-6">
            <h2 className="font-display font-semibold text-[20px]">Safety</h2>
            <ul className="mt-4 grid gap-3 text-[15px]">
              {[
                ["Money pool locked forever", "Nobody can pull the money out, including the creator."],
                ["Fixed supply", "No one can make more of this coin."],
                ["Traded with ETH", "The family coin's price never pulls this one down."],
              ].map(([t, d]) => (
                <li key={t} className="flex gap-3">
                  <svg width="20" height="20" viewBox="0 0 20 20" className="shrink-0 mt-0.5" aria-hidden="true">
                    <circle cx="10" cy="10" r="9" fill="none" stroke="#0F6B52" strokeWidth="1.6" />
                    <path d="M6 10.3 L8.8 13 L14 7.3" fill="none" stroke="#0F6B52" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span><strong className="block">{t}</strong><span className="text-ink-2">{d}</span></span>
                </li>
              ))}
            </ul>
            <div className="mt-5 pt-4 border-t border-mist grid gap-2 text-[14px] text-ink-2">
              <div className="flex justify-between gap-4"><span>Coin address</span><a className="font-mono text-emerald" href={explorerAddress(coin.token)} target="_blank" rel="noreferrer">{shortAddr(coin.token)}</a></div>
              <div className="flex justify-between gap-4"><span>Created by</span><a className="font-mono text-emerald" href={explorerAddress(coin.creator)} target="_blank" rel="noreferrer">{shortAddr(coin.creator)}</a></div>
            </div>
          </div>
        </div>

        <div className="order-1 lg:order-2 lg:sticky lg:top-20">
          <TradePanel coin={coin} poolKey={key} onTraded={load} />
        </div>
      </div>
    </div>
  );
}

function TradePanel({ coin, poolKey, onTraded }: { coin: Coin; poolKey: PoolKey; onTraded: () => void }) {
  const { address, onRightNetwork, switchNetwork, walletClient } = useWallet();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [ethBal, setEthBal] = useState<bigint | null>(null);
  const [tokBal, setTokBal] = useState<bigint | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [lastTx, setLastTx] = useState("");

  const refreshBalances = useCallback(async () => {
    if (!address) return;
    const [e, t] = await Promise.all([
      publicClient.getBalance({ address }),
      publicClient.readContract({ address: coin.token, abi: tokenAbi, functionName: "balanceOf", args: [address] }),
    ]);
    setEthBal(e);
    setTokBal(t);
  }, [address, coin.token]);

  useEffect(() => {
    refreshBalances().catch(() => {});
  }, [refreshBalances]);

  let amountIn = 0n;
  let bad = false;
  try {
    const clean = amount.trim().replace(",", ".");
    amountIn = clean === "" ? 0n : side === "buy" ? parseEther(clean as `${number}`) : parseUnits(clean as `${number}`, 18);
  } catch {
    bad = true;
  }
  const tooMuch = side === "buy" ? ethBal !== null && amountIn > ethBal : tokBal !== null && amountIn > tokBal;

  // Estimate from the pool's current price (1% fee, before price impact).
  // The real trade is simulated again right before it is sent.
  const [sqrtP, setSqrtP] = useState<bigint | null>(null);
  useEffect(() => {
    sqrtPriceOf(poolKey).then(setSqrtP).catch(() => setSqrtP(null));
  }, [poolKey, lastTx]);
  const quote: bigint | null =
    amountIn === 0n || bad || !sqrtP
      ? null
      : side === "buy"
        ? (((amountIn * 99n) / 100n) * sqrtP * sqrtP) >> 192n
        : (((amountIn * 99n) / 100n) << 192n) / (sqrtP * sqrtP);

  async function trade() {
    if (!address || amountIn === 0n) return;
    setError("");
    setLastTx("");
    try {
      if (!onRightNetwork) await switchNetwork();
      const wc = walletClient();
      if (side === "sell") {
        const allowance = await publicClient.readContract({ address: coin.token, abi: tokenAbi, functionName: "allowance", args: [address, ADDR.router] });
        if (allowance < amountIn) {
          setBusy("Step 1 of 2: allow selling in your wallet…");
          const h = await wc.writeContract({ chain, account: address, address: coin.token, abi: tokenAbi, functionName: "approve", args: [ADDR.router, amountIn] });
          await publicClient.waitForTransactionReceipt({ hash: h });
        }
      }
      setBusy(side === "sell" ? "Step 2 of 2: confirm the sale…" : "Confirm in your wallet…");
      const sim = await publicClient.simulateContract({
        account: address,
        address: ADDR.router,
        abi: routerAbi,
        functionName: "swapExactIn",
        args: [poolKey, side === "buy", amountIn, 0n, address],
        value: side === "buy" ? amountIn : 0n,
      });
      const minOut = (sim.result * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      const hash = await wc.writeContract({
        chain,
        account: address,
        address: ADDR.router,
        abi: routerAbi,
        functionName: "swapExactIn",
        args: [poolKey, side === "buy", amountIn, minOut, address],
        value: side === "buy" ? amountIn : 0n,
      });
      setBusy("Waiting for the network…");
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("The network rejected the transaction.");
      setLastTx(hash);
      setAmount("");
      await refreshBalances();
      onTraded();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  const fill = (fraction: bigint) => {
    const bal = side === "buy" ? ethBal : tokBal;
    if (bal === null) return;
    // Leave a little ETH for the network fee when buying with everything.
    let v = (bal * fraction) / 100n;
    if (side === "buy" && fraction === 100n) v = v > parseEther("0.0005") ? v - parseEther("0.0005") : 0n;
    setAmount(side === "buy" ? formatEther(v) : formatUnits(v, 18));
  };

  return (
    <div className="bg-white border border-line rounded-3xl p-5 sm:p-6">
      <div className="grid grid-cols-2 gap-1 p-1 bg-mist rounded-xl" role="tablist" aria-label="Buy or sell">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={side === s}
            type="button"
            onClick={() => { setSide(s); setAmount(""); setError(""); }}
            className={"h-11 rounded-lg font-semibold text-[15px] " + (side === s ? "bg-white shadow-sm" : "text-ink-2")}
          >
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      <label className="block mt-5">
        <span className="flex justify-between text-[14px]">
          <span className="font-semibold">{side === "buy" ? "You pay (ETH)" : `You sell ($${coin.symbol})`}</span>
          {address && (
            <span className="text-ink-3">
              You have {side === "buy" ? fmtEth(ethBal, 4) : fmtTokens(tokBal)}
            </span>
          )}
        </span>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="0.0"
          className="mt-2 w-full h-14 px-4 rounded-xl border border-line bg-paper font-mono text-[22px] focus:border-emerald focus:bg-white"
        />
      </label>
      {address && (
        <div className="grid grid-cols-4 gap-2 mt-2">
          {[25n, 50n, 75n, 100n].map((f) => (
            <button key={String(f)} type="button" onClick={() => fill(f)} className="h-9 rounded-lg bg-mist text-[13px] font-semibold text-ink-2">
              {f === 100n ? "Max" : `${f}%`}
            </button>
          ))}
        </div>
      )}

      <div className="mt-4 p-4 rounded-xl bg-mist text-[15px] flex justify-between gap-3">
        <span className="text-ink-2">You get about</span>
        <span className="font-mono font-medium text-right">
          {amountIn === 0n ? "—" : quote === null ? "…" : side === "buy" ? `${fmtTokens(quote)} $${coin.symbol}` : fmtEth(quote, 6)}
        </span>
      </div>

      <div className="mt-4">
        {!address ? (
          <ConnectButton full />
        ) : (
          <button
            type="button"
            onClick={trade}
            disabled={!!busy || bad || amountIn === 0n || tooMuch}
            className={"w-full h-13 rounded-xl text-white font-semibold text-[16px] disabled:opacity-40 " + (side === "buy" ? "bg-emerald hover:bg-emerald-dark" : "bg-danger")}
          >
            {busy || (tooMuch ? "Not enough balance" : side === "buy" ? `Buy $${coin.symbol}` : `Sell $${coin.symbol}`)}
          </button>
        )}
      </div>

      {error && <p className="mt-3 text-[14px] text-danger" role="alert">{error}</p>}
      {lastTx && (
        <p className="mt-3 text-[14px] text-emerald">
          Done. <a className="underline" href={explorerTx(lastTx)} target="_blank" rel="noreferrer">View transaction</a>
        </p>
      )}
      <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
        Prices can move while you confirm. If the price moves more than 5% the trade is cancelled and you keep your money.
      </p>
    </div>
  );
}
