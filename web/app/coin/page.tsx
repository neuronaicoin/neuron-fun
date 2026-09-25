"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatEther, formatUnits, isAddress, isHex, parseEther, parseUnits, type Address, type Hex } from "viem";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { CoinAvatar, ChainChip, ChainRace, ProgressBar, Skeleton } from "@/components/coins";
import { curveAbi, tokenAbi } from "@/lib/abis";
import { SLIPPAGE_BPS, explorerAddress, explorerTx } from "@/lib/config";
import { clientFor, fetchCoin, type Coin, type CurveInfo } from "@/lib/data";
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
  const creator = params.get("c") ?? "";
  const key = params.get("k") ?? "";
  const valid = isAddress(creator) && isHex(key) && key.length === 66;
  const [coin, setCoin] = useState<Coin | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!valid) return;
    try {
      const { coin } = await fetchCoin(creator as Address, key as Hex);
      if (!coin) setNotFound(true);
      else setCoin(coin);
    } catch {
      /* keep what we have; the next refresh may work */
    }
  }, [creator, key, valid]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  if (!valid || notFound) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <h1 className="font-display font-semibold text-[28px]">Coin not found</h1>
        <p className="text-ink-2 mt-3">This link doesn&apos;t point to a Neuron.fun coin.</p>
        <Link href="/" className="inline-flex mt-6 h-12 px-6 rounded-xl bg-emerald text-white font-semibold items-center">Explore coins</Link>
      </div>
    );
  }
  if (!coin) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 grid gap-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  const winner = coin.graduatedOn;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
      <Link href="/" className="text-[14px] font-semibold text-emerald">← All coins</Link>

      <div className="mt-5 flex items-start gap-4">
        <CoinAvatar logo={coin.logo} symbol={coin.symbol} size={68} />
        <div className="min-w-0">
          <h1 className="font-display font-semibold text-[28px] sm:text-[36px] leading-tight tracking-tight break-words">{coin.name}</h1>
          <p className="text-ink-2 text-[15px] mt-1">${coin.symbol}</p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {coin.curves.map((c) => (
              <ChainChip key={c.chain.key} chain={c.chain} muted={c.state === "closed"} />
            ))}
          </div>
        </div>
      </div>
      {coin.description && <p className="text-[16px] text-ink-2 mt-4 leading-relaxed max-w-2xl">{coin.description}</p>}

      {winner && (
        <div className="mt-6 rounded-2xl bg-night text-mist p-5 sm:p-6">
          <p className="font-mono text-[12px] tracking-[0.14em] text-mint">GRADUATED</p>
          <h2 className="font-display font-semibold text-[22px] sm:text-[26px] mt-2">Winning chain: {winner.chain.name}</h2>
          <p className="text-[#a9bab3] mt-2 text-[15px] leading-relaxed">
            ${coin.symbol} now trades in a locked pool on {winner.chain.short}. That is where the coin lives from here on.
            On the other chains buying has stopped; holders there can take their money back at any time.
          </p>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px] lg:items-start">
        <div className="order-2 lg:order-1 grid gap-6">
          <div className="bg-white border border-line rounded-2xl p-5 sm:p-6">
            <ProgressBar coin={coin} big />
            <div className="mt-6">
              <h2 className="font-display font-semibold text-[18px] mb-3">The race</h2>
              <ChainRace coin={coin} />
            </div>
            {!winner && (
              <p className="mt-5 text-[14px] text-ink-3 leading-relaxed">
                Buys on every chain add up to one total. When it reaches the target, the chain holding the most money wins
                and the coin carries on there.
              </p>
            )}
          </div>
          <CreatorBox coin={coin} onChange={load} />
          <div className="bg-white border border-line rounded-2xl p-5 sm:p-6 text-[14px] text-ink-2 grid gap-2">
            <h2 className="font-display font-semibold text-[18px] text-ink mb-1">Details</h2>
            {coin.curves.map((c) => (
              <div key={c.chain.key} className="flex justify-between gap-4">
                <span>{c.chain.short} coin</span>
                <a className="font-mono text-emerald" href={explorerAddress(c.chain, c.token)} target="_blank" rel="noreferrer">{shortAddr(c.token)}</a>
              </div>
            ))}
            <div className="flex justify-between gap-4">
              <span>Created by</span>
              <span className="font-mono">{shortAddr(coin.creator)}</span>
            </div>
          </div>
        </div>
        <div className="order-1 lg:order-2 lg:sticky lg:top-20">
          <TradePanel coin={coin} onTraded={load} />
        </div>
      </div>
    </div>
  );
}

function TradePanel({ coin, onTraded }: { coin: Coin; onTraded: () => void }) {
  const { address, switchTo, walletClient } = useWallet();
  const tradable = coin.curves.filter((c) => c.state !== "graduated");
  const leader = useMemo(
    () => [...tradable].filter((c) => c.state === "trading").sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0] ?? tradable[0],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [coin.id]
  );
  const [chainKey, setChainKey] = useState(leader?.chain.key ?? "");
  const cur = tradable.find((c) => c.chain.key === chainKey) ?? tradable[0];
  const closed = cur?.state === "closed";
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const effSide = closed ? "sell" : side;
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<bigint | null>(null);
  const [ethBal, setEthBal] = useState<bigint | null>(null);
  const [tokBal, setTokBal] = useState<bigint | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [lastTx, setLastTx] = useState("");

  const refresh = useCallback(async () => {
    if (!address || !cur) return;
    const pub = clientFor(cur.chain);
    const [e, t] = await Promise.all([
      pub.getBalance({ address }),
      pub.readContract({ address: cur.token, abi: tokenAbi, functionName: "balanceOf", args: [address] }),
    ]);
    setEthBal(e);
    setTokBal(t as bigint);
  }, [address, cur]);

  useEffect(() => {
    setEthBal(null);
    setTokBal(null);
    refresh().catch(() => {});
  }, [refresh]);

  let amountIn = 0n;
  let bad = false;
  try {
    const clean = amount.trim().replace(",", ".");
    amountIn = clean === "" ? 0n : effSide === "buy" ? parseEther(clean as `${number}`) : parseUnits(clean as `${number}`, 18);
  } catch {
    bad = true;
  }
  const tooMuch = effSide === "buy" ? ethBal !== null && amountIn > ethBal : tokBal !== null && amountIn > tokBal;

  useEffect(() => {
    setQuote(null);
    if (!cur || amountIn === 0n || bad) return;
    const t = setTimeout(async () => {
      try {
        const q = await clientFor(cur.chain).readContract({
          address: cur.curve,
          abi: curveAbi,
          functionName: effSide === "buy" ? "quoteBuy" : "quoteSell",
          args: [amountIn],
        });
        setQuote(q as bigint);
      } catch {
        setQuote(null);
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, effSide, chainKey]);

  if (!cur) {
    return (
      <div className="bg-white border border-line rounded-3xl p-6 text-[15px] text-ink-2">
        This coin trades only in its locked pool on {coin.graduatedOn?.chain.short} now.
      </div>
    );
  }

  async function trade(sellAll = false) {
    if (!address || !cur) return;
    setError("");
    setLastTx("");
    const amt = sellAll ? tokBal ?? 0n : amountIn;
    if (amt === 0n) return;
    try {
      setBusy(`Switching your wallet to ${cur.chain.short}…`);
      await switchTo(cur.chain.chain);
      const pub = clientFor(cur.chain);
      const wc = walletClient(cur.chain.chain);
      let hash: Hex;
      if (effSide === "buy" && !sellAll) {
        const sim = await pub.simulateContract({ account: address, address: cur.curve, abi: curveAbi, functionName: "buy", args: [0n, address], value: amt });
        const minOut = ((sim.result as bigint) * (10_000n - SLIPPAGE_BPS)) / 10_000n;
        setBusy("Confirm in your wallet…");
        hash = await wc.writeContract({ chain: cur.chain.chain, account: address, address: cur.curve, abi: curveAbi, functionName: "buy", args: [minOut, address], value: amt });
      } else {
        const allowance = (await pub.readContract({ address: cur.token, abi: tokenAbi, functionName: "allowance", args: [address, cur.curve] })) as bigint;
        if (allowance < amt) {
          setBusy("Step 1 of 2: allow selling in your wallet…");
          const h = await wc.writeContract({ chain: cur.chain.chain, account: address, address: cur.token, abi: tokenAbi, functionName: "approve", args: [cur.curve, amt] });
          await pub.waitForTransactionReceipt({ hash: h });
        }
        const sim = await pub.simulateContract({ account: address, address: cur.curve, abi: curveAbi, functionName: "sell", args: [amt, 0n, address] });
        const minOut = ((sim.result as bigint) * (10_000n - SLIPPAGE_BPS)) / 10_000n;
        setBusy(allowance < amt ? "Step 2 of 2: confirm the sale…" : "Confirm in your wallet…");
        hash = await wc.writeContract({ chain: cur.chain.chain, account: address, address: cur.curve, abi: curveAbi, functionName: "sell", args: [amt, minOut, address] });
      }
      setBusy("Waiting for the network…");
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("The network rejected the transaction.");
      setLastTx(hash);
      setAmount("");
      await refresh();
      onTraded();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  const fill = (pct: bigint) => {
    const bal = effSide === "buy" ? ethBal : tokBal;
    if (bal === null) return;
    let v = (bal * pct) / 100n;
    if (effSide === "buy" && pct === 100n) v = v > parseEther("0.0003") ? v - parseEther("0.0003") : 0n;
    setAmount(effSide === "buy" ? formatEther(v) : formatUnits(v, 18));
  };

  const winner = coin.graduatedOn;

  return (
    <div className="bg-white border border-line rounded-3xl p-5 sm:p-6">
      {tradable.length > 1 && (
        <div className="mb-4">
          <span className="text-[13px] font-semibold text-ink-2">Trade on</span>
          <div className="flex flex-wrap gap-2 mt-2">
            {tradable.map((c) => (
              <button
                key={c.chain.key}
                type="button"
                onClick={() => { setChainKey(c.chain.key); setAmount(""); setError(""); }}
                className={"h-10 px-3 rounded-xl border-2 text-[14px] font-semibold " + (c.chain.key === cur.chain.key ? "border-emerald" : "border-line")}
              >
                {c.chain.short}{c.state === "closed" ? " (closed)" : ""}
              </button>
            ))}
          </div>
        </div>
      )}

      {closed ? (
        <div className="p-4 rounded-2xl bg-warn-bg text-warn-ink text-[14px] leading-relaxed">
          {winner ? (
            <>This coin graduated on <strong>{winner.chain.short}</strong>. Buying on {cur.chain.short} has stopped, but you can sell back here any time.</>
          ) : (
            <>Buying on {cur.chain.short} has stopped. You can sell back here any time.</>
          )}
        </div>
      ) : (
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
      )}

      {closed && address && (
        <div className="mt-4 grid gap-2">
          <button type="button" onClick={() => trade(true)} disabled={!!busy || !tokBal} className="h-13 rounded-xl bg-emerald text-white font-semibold disabled:opacity-40">
            {busy || `Get my money back${tokBal ? ` (${fmtTokens(tokBal)} $${coin.symbol})` : ""}`}
          </button>
          {winner && (
            <a
              href="https://relay.link/bridge"
              target="_blank"
              rel="noreferrer"
              className="h-12 rounded-xl border border-ink font-semibold flex items-center justify-center text-center px-3"
            >
              Then move your ETH to {winner.chain.short}
            </a>
          )}
          <p className="text-[12px] text-ink-3 leading-relaxed">
            Moving over: first get your money back here, then send the ETH to {winner?.chain.short ?? "the winning chain"} with
            Relay, a bridge that takes a few seconds, and buy ${coin.symbol} there.
          </p>
        </div>
      )}

      <label className="block mt-5">
        <span className="flex justify-between text-[14px]">
          <span className="font-semibold">{effSide === "buy" ? `You pay (ETH on ${cur.chain.short})` : `You sell ($${coin.symbol})`}</span>
          {address && <span className="text-ink-3">You have {effSide === "buy" ? fmtEth(ethBal, 4) : fmtTokens(tokBal)}</span>}
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
          {amountIn === 0n ? "—" : quote === null ? "…" : effSide === "buy" ? `${fmtTokens(quote)} $${coin.symbol}` : fmtEth(quote, 6)}
        </span>
      </div>

      <div className="mt-4">
        {!address ? (
          <ConnectButton full />
        ) : (
          <button
            type="button"
            onClick={() => trade(false)}
            disabled={!!busy || bad || amountIn === 0n || tooMuch}
            className={"w-full h-13 rounded-xl text-white font-semibold text-[16px] disabled:opacity-40 " + (effSide === "buy" ? "bg-emerald hover:bg-emerald-dark" : "bg-danger")}
          >
            {busy || (tooMuch ? "Not enough balance" : effSide === "buy" ? `Buy on ${cur.chain.short}` : `Sell on ${cur.chain.short}`)}
          </button>
        )}
      </div>

      {error && <p className="mt-3 text-[14px] text-danger" role="alert">{error}</p>}
      {lastTx && (
        <p className="mt-3 text-[14px] text-emerald">
          Done. <a className="underline" href={explorerTx(cur.chain, lastTx)} target="_blank" rel="noreferrer">View transaction</a>
        </p>
      )}
      <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
        1% fee on every trade. If the price moves more than 5% while you confirm, the trade is cancelled and you keep your money.
      </p>
    </div>
  );
}

function CreatorBox({ coin, onChange }: { coin: Coin; onChange: () => void }) {
  const { address, switchTo, walletClient } = useWallet();
  const [fees, setFees] = useState<Record<string, bigint>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const isCreator = !!address && address.toLowerCase() === coin.creator.toLowerCase();

  const load = useCallback(async () => {
    if (!isCreator) return;
    const entries = await Promise.all(
      coin.curves.map(async (c: CurveInfo) => {
        const f = (await clientFor(c.chain).readContract({ address: c.curve, abi: curveAbi, functionName: "creatorFees" })) as bigint;
        return [c.chain.key, f] as const;
      })
    );
    setFees(Object.fromEntries(entries));
  }, [coin.curves, isCreator]);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  if (!isCreator) return null;

  async function claim(c: CurveInfo) {
    if (!address) return;
    setError("");
    try {
      setBusy(c.chain.key);
      await switchTo(c.chain.chain);
      const hash = await walletClient(c.chain.chain).writeContract({ chain: c.chain.chain, account: address, address: c.curve, abi: curveAbi, functionName: "claimCreatorFees" });
      await clientFor(c.chain).waitForTransactionReceipt({ hash });
      await load();
      onChange();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="bg-white border border-emerald rounded-2xl p-5 sm:p-6">
      <h2 className="font-display font-semibold text-[18px]">Your earnings as the creator</h2>
      <p className="text-[14px] text-ink-2 mt-1">0.3% of every trade on every chain.</p>
      <ul className="mt-4 grid gap-2">
        {coin.curves.map((c) => (
          <li key={c.chain.key} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <ChainChip chain={c.chain} />
              <span className="font-mono text-[14px]">{fmtEth(fees[c.chain.key] ?? null, 6)}</span>
            </span>
            <button
              type="button"
              disabled={!fees[c.chain.key] || !!busy}
              onClick={() => claim(c)}
              className="h-9 px-4 rounded-lg bg-emerald text-white text-[14px] font-semibold disabled:opacity-40"
            >
              {busy === c.chain.key ? "…" : "Collect"}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="mt-3 text-[14px] text-danger">{error}</p>}
    </div>
  );
}
