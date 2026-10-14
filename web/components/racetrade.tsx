"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, maxUint256, parseUnits, type Address } from "viem";
import { useWallet } from "@/components/wallet";
import { ConnectButton } from "@/components/chrome";
import { call } from "@/lib/tx";
import { friendlyError } from "@/lib/format";
import { signalTrade } from "@/lib/live";
import { SLIPPAGE_CHOICES, slippagePct, useSlippage } from "@/lib/slippage";
import {
  fmtPrice,
  raceClient,
  raceErc20Abi,
  raceExplorerTx,
  raceRouterAbi,
  type RaceCoin,
  type RaceLane,
} from "@/lib/race";

const QUICK_BUY = [5, 10, 25, 50];
const QUICK_SELL = [25, 50, 75, 100];
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);

function fmtAmount(n: number, max = 2) {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? max : 6 });
}

/**
 * Buy or sell a race coin in dollars on one chain, through that chain's RaceTrade router.
 * The amount out shown before signing is an estimate from the last price; the exact amount
 * is read from the chain (a dry run of the real trade) right before the wallet asks, and the
 * user's slippage is applied to that.
 */
export function RaceTradeBox({ coin, lanes, lane, onLane }: { coin: RaceCoin; lanes: RaceLane[]; lane: RaceLane; onLane: (chainId: number) => void }) {
  const w = useWallet();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("10");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; tx?: string } | null>(null);
  const [usdDec, setUsdDec] = useState<number>(6);
  const [usdBal, setUsdBal] = useState<bigint | null>(null);
  const [coinBal, setCoinBal] = useState<bigint | null>(null);
  const [slip, setSlip] = useSlippage();
  const [showSlip, setShowSlip] = useState(false);
  const chain = lane.chain;
  const tradable = lane.state !== 3;

  const refresh = useCallback(async () => {
    if (!w.address) {
      setUsdBal(null);
      setCoinBal(null);
      return;
    }
    const pub = raceClient(chain);
    try {
      const [d, u, c] = await Promise.all([
        pub.readContract({ address: chain.usd, abi: raceErc20Abi, functionName: "decimals" }),
        pub.readContract({ address: chain.usd, abi: raceErc20Abi, functionName: "balanceOf", args: [w.address] }),
        pub.readContract({ address: coin.coin, abi: raceErc20Abi, functionName: "balanceOf", args: [w.address] }),
      ]);
      setUsdDec(Number(d));
      setUsdBal(u as bigint);
      setCoinBal(c as bigint);
    } catch {
      // the chain's node is busy: keep what we had
    }
  }, [w.address, chain, coin.coin]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    setMsg(null);
    setAmount(side === "buy" ? "10" : "");
  }, [side, chain.chainId]);

  const n = Number(amount);
  const valid = Number.isFinite(n) && n > 0;
  // Sell amounts are typed in coins.
  const estimate = useMemo(() => {
    if (!valid || !lane.priceUsd) return null;
    return side === "buy" ? n / lane.priceUsd : n * lane.priceUsd;
  }, [valid, n, side, lane.priceUsd]);

  const setPct = (pct: number) => {
    if (coinBal === null) return;
    const v = (coinBal * BigInt(pct)) / 100n;
    setAmount(formatUnits(v, 18));
  };

  const submit = async () => {
    if (!w.address || !valid || busy) return;
    setBusy(true);
    setMsg(null);
    const me = w.address as Address;
    const pub = raceClient(chain);
    try {
      const token = side === "buy" ? chain.usd : coin.coin;
      const amountIn = side === "buy" ? parseUnits(amount, usdDec) : parseUnits(amount, 18);
      const have = side === "buy" ? usdBal : coinBal;
      if (have !== null && amountIn > have) throw new Error(side === "buy" ? "Not enough USDC on this chain." : `You don't have that many ${coin.symbol}.`);

      // 1. approval (once per token: the router is a fixed contract with no owner)
      setStep("Checking approval…");
      const allowance = (await pub.readContract({ address: token, abi: raceErc20Abi, functionName: "allowance", args: [me, chain.router] })) as bigint;
      if (allowance < amountIn) {
        await w.send(chain.chain, [call(token, raceErc20Abi, "approve", [chain.router, maxUint256])], (s) => setStep(`Approve: ${s}`));
      }

      // 2. dry run of the real trade: the exact amount out at this moment
      setStep("Getting the price…");
      const fn = side === "buy" ? "buy" : "sell";
      const sim = await pub.simulateContract({
        account: me,
        address: chain.router,
        abi: raceRouterAbi,
        functionName: fn,
        args: [coin.coin, amountIn, 0n, me, deadline()],
      });
      const out = sim.result as bigint;
      if (out === 0n) throw new Error("This trade would give nothing back. Try a bigger amount.");
      const minOut = (out * (10_000n - slip)) / 10_000n;

      // 3. the trade
      const tx = await w.send(chain.chain, [call(chain.router, raceRouterAbi, fn, [coin.coin, amountIn, minOut, me, deadline()])], (s) => setStep(s));
      const got = side === "buy" ? `${fmtAmount(Number(formatUnits(out, 18)))} ${coin.symbol}` : `$${fmtAmount(Number(formatUnits(out, usdDec)))}`;
      setMsg({ ok: true, text: side === "buy" ? `Bought about ${got}.` : `Sold for about ${got}.`, tx });
      signalTrade({ chainId: chain.chainId, curve: chain.router, coinId: coin.id, nativePerToken: null });
      if (side === "sell") setAmount("");
      void refresh();
    } catch (e) {
      const text = /RaceLostPoolShut/.test(String((e as Error)?.message) + JSON.stringify(e ?? {}, (_k, v) => (typeof v === "bigint" ? String(v) : v)))
        ? "This chain lost the race and its pool is closed."
        : friendlyError(e).replace("Not enough ETH", `Not enough ${chain.chain.nativeCurrency.symbol}`);
      setMsg({ ok: false, text });
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  const faucet = async () => {
    if (!w.address || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await w.send(chain.chain, [call(chain.usd, raceErc20Abi, "faucet", [w.address])], (s) => setStep(s));
      setMsg({ ok: true, text: `$100 test USDC added on ${chain.short}.` });
      void refresh();
    } catch (e) {
      const t = JSON.stringify(e ?? {}, (_k, v) => (typeof v === "bigint" ? String(v) : v));
      setMsg({ ok: false, text: /TooSoon/.test(t) ? "You already got test USDC today. Come back tomorrow." : friendlyError(e) });
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  const open = lanes.filter((l) => l.state !== 3);

  return (
    <div className="rounded-3xl border border-line bg-surface p-4 sm:p-5 flex flex-col gap-4 min-w-0">
      {open.length > 1 && (
        <div className="flex flex-col gap-2">
          <span className="text-[0.8125rem] text-ink-3">Trade on</span>
          <div className="grid grid-cols-2 gap-2">
            {open.map((l) => (
              <button
                key={l.chain.chainId}
                type="button"
                onClick={() => onLane(l.chain.chainId)}
                className={
                  "h-10 rounded-xl border text-[0.875rem] font-semibold flex items-center justify-center gap-2 min-w-0 px-2 " +
                  (l.chain.chainId === chain.chainId ? "border-ink text-ink" : "border-line text-ink-2")
                }
                aria-pressed={l.chain.chainId === chain.chainId}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: l.chain.color }} />
                <span className="truncate">{l.chain.short}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 bg-night rounded-full p-1" role="group" aria-label="Buy or sell">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            className={"h-10 rounded-full text-[0.9375rem] capitalize " + (side === s ? "bg-paper text-ink font-semibold shadow-sm" : "text-ink-2 font-medium")}
            aria-pressed={side === s}
          >
            {s}
          </button>
        ))}
      </div>

      {!tradable ? (
        <p className="text-[0.9375rem] text-ink-2">
          {chain.short} lost this race. Its pool is closed and holders were moved to {coin.winner?.short ?? "the winner"}.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <div className="flex justify-between items-baseline gap-2 text-[0.8125rem] text-ink-3">
              <label htmlFor="race-amt">{side === "buy" ? "Pay (USDC)" : `Sell (${coin.symbol})`}</label>
              {w.address && (
                <span className="truncate tabular-nums">
                  {side === "buy"
                    ? usdBal === null
                      ? "…"
                      : `Balance $${fmtAmount(Number(formatUnits(usdBal, usdDec)))}`
                    : coinBal === null
                      ? "…"
                      : `Balance ${fmtAmount(Number(formatUnits(coinBal, 18)))}`}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 min-w-0">
              {side === "buy" && <span className="text-[2rem] font-bold text-ink-3 leading-none">$</span>}
              <input
                id="race-amt"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))}
                placeholder="0"
                className="w-full min-w-0 bg-transparent outline-none text-[2rem] font-bold leading-none tabular-nums text-ink"
              />
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2">
            {side === "buy"
              ? QUICK_BUY.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setAmount(String(v))}
                    className={"h-10 rounded-xl border text-[0.875rem] " + (amount === String(v) ? "border-ink font-semibold" : "border-line text-ink-2")}
                  >
                    ${v}
                  </button>
                ))
              : QUICK_SELL.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPct(p)}
                    disabled={!coinBal}
                    className="h-10 rounded-xl border border-line text-[0.875rem] text-ink-2 disabled:opacity-40"
                  >
                    {p === 100 ? "Max" : `${p}%`}
                  </button>
                ))}
          </div>

          <div className="flex justify-between gap-3 text-[0.875rem] text-ink-2">
            <span>You get about</span>
            <span className="font-semibold text-ink tabular-nums truncate">
              {estimate === null ? "—" : side === "buy" ? `${fmtAmount(estimate)} ${coin.symbol}` : `$${fmtAmount(estimate)}`}
            </span>
          </div>
          <div className="flex justify-between gap-3 text-[0.8125rem] text-ink-3">
            <span>Price {fmtPrice(lane.priceUsd)}</span>
            <button type="button" onClick={() => setShowSlip((v) => !v)} className="underline-offset-2 hover:underline">
              Slippage {slippagePct(slip)}
            </button>
          </div>
          {showSlip && (
            <div className="grid grid-cols-4 gap-2">
              {SLIPPAGE_CHOICES.map((b) => (
                <button
                  key={String(b)}
                  type="button"
                  onClick={() => setSlip(b)}
                  className={"h-9 rounded-xl border text-[0.8125rem] " + (slip === b ? "border-ink font-semibold" : "border-line text-ink-2")}
                >
                  {slippagePct(b)}
                </button>
              ))}
            </div>
          )}

          {!w.address ? (
            <ConnectButton />
          ) : w.embedded ? (
            <p className="text-[0.875rem] text-ink-2">Races on testnet need a browser wallet (MetaMask, Rabby, Coinbase Wallet…). Email accounts join with the USDC deposit at mainnet.</p>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={busy || !valid}
              className={
                "h-13 min-h-[3.25rem] rounded-full text-[1.0625rem] font-bold text-white disabled:opacity-50 " + (side === "buy" ? "bg-up" : "bg-danger")
              }
            >
              {busy ? (step ?? "Working…") : side === "buy" ? `Buy ${coin.symbol}` : `Sell ${coin.symbol}`}
            </button>
          )}

          {w.address && !w.embedded && chain.faucet && side === "buy" && (
            <button type="button" onClick={faucet} disabled={busy} className="text-[0.8125rem] text-ink-3 underline underline-offset-2 self-center disabled:opacity-50">
              Get $100 test USDC on {chain.short}
            </button>
          )}
          <p className="text-[0.75rem] text-ink-3 text-center">
            You pay the {chain.short} network fee in {chain.chain.nativeCurrency.symbol}. Early buys pay a higher pool fee: 30% at the start, falling to 2% after five minutes.
          </p>
        </>
      )}

      {msg && (
        <div role="status" className={"rounded-xl px-3 py-2 text-[0.875rem] break-words " + (msg.ok ? "bg-emerald-soft text-ink" : "bg-warn-bg text-warn-ink")}>
          {msg.text}{" "}
          {msg.tx && (
            <a href={raceExplorerTx(chain, msg.tx)} target="_blank" rel="noreferrer" className="underline">
              View
            </a>
          )}
        </div>
      )}
    </div>
  );
}
