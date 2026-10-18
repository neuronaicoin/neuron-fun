"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { formatUnits, maxUint256, parseUnits, type Address } from "viem";
import { usdcGasChain } from "@/lib/usdcgas";
import { IS_TESTNET } from "@/lib/config";
import { crossReady, homeChain, onPending, pendingList, removePending, watchPending, type Pending } from "@/lib/racecross";
import { crossBuy, crossSell, crossSendHome, spareThere, type Senders } from "@/lib/racecrossflow";
import { readLegs, sellEverywhere, share, type SellLeg } from "@/lib/racesell";
import { AutoPanel } from "@/components/autopanel";
import { autoAnywhere } from "@/lib/auto";
import { RACE_SUPPLY } from "@/lib/race";
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
  withGas,
  type RaceCoin,
  type RaceLane,
} from "@/lib/race";

const QUICK_BUY = [5, 10, 25, 50];
const EMPTY_PENDING: Pending[] = [];
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
  const [side, setSide] = useState<"buy" | "sell" | "auto">("buy");
  const sides = (autoAnywhere() ? ["buy", "sell", "auto"] : ["buy", "sell"]) as ("buy" | "sell" | "auto")[];
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
  // sasa accounts (email login) on mainnet: dollars stay on Base; other chains go through Across
  const home = homeChain();
  const emailMain = w.embedded && !IS_TESTNET;
  const viaBase = emailMain && crossReady(chain);
  const atHome = emailMain && !!home && home.chainId === chain.chainId;
  const [homeBal, setHomeBal] = useState<bigint | null>(null);
  const [homeDec, setHomeDec] = useState<number>(6);
  const [spare, setSpare] = useState<bigint>(0n);
  const pending = useSyncExternalStore(onPending, pendingList, () => EMPTY_PENDING);
  const mine = pending.filter((p) => (p.kind === "buy" && p.chainId === chain.chainId && p.coin?.toLowerCase() === coin.coin.toLowerCase()) || p.kind === "home");
  useEffect(() => {
    if (emailMain) watchPending();
  }, [emailMain]);

  const refresh = useCallback(async (): Promise<{ usd: bigint; coin: bigint } | null> => {
    if (!w.address) {
      setUsdBal(null);
      setCoinBal(null);
      return null;
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
      if (viaBase && home) {
        const hp = raceClient(home);
        const [hd, hb, sp] = await Promise.all([
          hp.readContract({ address: home.usd, abi: raceErc20Abi, functionName: "decimals" }),
          hp.readContract({ address: home.usd, abi: raceErc20Abi, functionName: "balanceOf", args: [w.address] }),
          spareThere(chain, w.address).catch(() => 0n),
        ]);
        setHomeDec(Number(hd));
        setHomeBal(hb as bigint);
        setSpare(sp);
        return { usd: hb as bigint, coin: c as bigint };
      }
      return { usd: u as bigint, coin: c as bigint };
    } catch {
      // the chain's node is busy: keep what we had
      return null;
    }
  }, [w.address, chain, coin.coin, viaBase, home]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    setMsg(null);
    setAmount(side === "buy" ? "10" : "");
  }, [side, chain.chainId]);

  // a buy on its way through Across: done once the coins show up here
  const waitingBuys = mine.filter((p) => p.kind === "buy");
  useEffect(() => {
    if (!waitingBuys.length || !w.address) return;
    const start = coinBal;
    const t = setInterval(async () => {
      const fresh = await refresh();
      if (fresh && start !== null && fresh.coin > start) {
        // one delivery landed (the others are cleared by Across's status, see watchPending)
        removePending(waitingBuys[0].id);
        setMsg({ ok: true, text: `Your ${coin.symbol} arrived on ${chain.short}.` });
      }
    }, 3_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingBuys.length, w.address, chain.chainId]);

  const senders = (): Senders => ({ user: w.address as Address, sendHome: w.send, sendThere: w.sendOwnGas });

  /** Buy / sell for a sasa account on a chain other than Base: dollars from and back to Base. */
  const submitViaBase = async () => {
    if (!w.address || !home || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      if (side === "buy") {
        const r = await crossBuy({
          s: senders(),
          home,
          dest: chain,
          coin: coin.coin,
          priceUsd: lane.priceUsd,
          amountHome: parseUnits(amount, homeDec),
          slipBps: slip,
          onStep: setStep,
        });
        setMsg({
          ok: true,
          text: `Sent. About ${fmtAmount(Number(formatUnits(r.coinsExpected, 18)))} ${coin.symbol} arrive on ${chain.short} in about a minute (Across fee $${r.feeUsd.toFixed(2)}${r.gasUsd > 0 ? `, $${r.gasUsd.toFixed(2)} kept as ${chain.chain.nativeCurrency.symbol} for your network fees there` : ""}).`,
        });
      } else {
        const r = await crossSell({ s: senders(), home, dest: chain, coin: coin.coin, coinsIn: parseUnits(amount, 18), slipBps: slip, onStep: setStep });
        setMsg({ ok: true, text: `Sold. About $${fmtAmount(r.usdOut)} is on its way back to your balance on Base (Across fee $${r.feeUsd.toFixed(2)}).`, tx: r.tx });
        setAmount("");
      }
      signalTrade({ chainId: chain.chainId, curve: chain.router, coinId: coin.id, nativePerToken: null });
      for (const ms of [0, 1_500, 4_000, 8_000]) setTimeout(() => void refresh(), ms);
    } catch (e) {
      const t = String((e as Error)?.message ?? "") + JSON.stringify(e ?? {}, (_k, v) => (typeof v === "bigint" ? String(v) : v));
      setMsg({ ok: false, text: /RaceLostPoolShut/.test(t) ? "This chain lost the race and its pool is closed." : friendlyError(e) });
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  const bringHome = async () => {
    if (!w.address || !home || busy || spare === 0n) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await crossSendHome({ s: senders(), home, dest: chain, amount: spare, onStep: setStep });
      setMsg({ ok: true, text: `About $${fmtAmount(r.usdOut)} is on its way to your balance on Base.`, tx: r.tx });
      for (const ms of [0, 2_000, 6_000]) setTimeout(() => void refresh(), ms);
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e) });
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  // ------------------------------------------------------------ one Sell, every chain
  const [legs, setLegs] = useState<SellLeg[] | null>(null);
  const [sellPct, setSellPct] = useState(100);
  const [selling, setSelling] = useState(false);
  const sellingRef = useRef(false);
  const canSellOn = useCallback(
    (c: RaceLane["chain"]) => (!emailMain ? true : (!!home && home.chainId === c.chainId) || crossReady(c)),
    [emailMain, home]
  );
  const loadLegs = useCallback(async () => {
    if (!w.address) return setLegs(null);
    const fresh = await readLegs(coin, w.address as Address, canSellOn, emailMain && home ? home.chainId : null).catch(() => null);
    if (fresh && !sellingRef.current) setLegs(fresh);
  }, [w.address, coin, canSellOn, emailMain, home]);
  useEffect(() => {
    if (side !== "sell") return;
    void loadLegs();
    const t = setInterval(() => void loadLegs(), 15_000);
    return () => clearInterval(t);
  }, [side, loadLegs]);

  const sellAll = async () => {
    if (!w.address || !legs || selling) return;
    const ready = legs.filter((l) => l.state === "ready" || l.state === "failed").map((l) => ({ ...l, state: "ready" as const }));
    if (!ready.length) return;
    sellingRef.current = true;
    setSelling(true);
    setMsg(null);
    setLegs((old) => (old ?? []).map((l) => ready.find((r) => r.chain.chainId === l.chain.chainId) ?? l));
    try {
      const done = await sellEverywhere({
        legs: ready,
        coin: coin.coin,
        bps: BigInt(sellPct * 100),
        slipBps: slip,
        s: emailMain && home ? senders() : null,
        home: emailMain ? home : null,
        send: (c, calls, st) => w.send(c.chain, calls, st),
        user: w.address as Address,
        onLeg: (chainId, p) => setLegs((old) => (old ?? []).map((l) => (l.chain.chainId === chainId ? { ...l, ...p } : l))),
      });
      const ok = done.filter((l) => l.state === "done");
      for (const l of ok) signalTrade({ chainId: l.chain.chainId, curve: l.chain.router, coinId: coin.id, nativePerToken: null });
      const now = ok.filter((l) => !emailMain || l.chain.chainId === home?.chainId).reduce((a, l) => a + (l.usd ?? 0), 0);
      const later = ok.filter((l) => emailMain && l.chain.chainId !== home?.chainId);
      const laterUsd = later.reduce((a, l) => a + (l.usd ?? 0), 0);
      if (ok.length) {
        const parts = [];
        if (now > 0) parts.push(emailMain ? `$${fmtAmount(now)} is in your balance` : `Sold for about $${fmtAmount(now)}`);
        if (later.length) parts.push(`$${fmtAmount(laterUsd)} from ${later.map((l) => l.chain.short).join(", ")} lands in your balance in about a minute`);
        setMsg({ ok: true, text: `Sold. ${parts.join("; ")}.` });
      }
    } finally {
      sellingRef.current = false;
      setSelling(false);
      for (const ms of [1_500, 5_000, 12_000]) setTimeout(() => { void loadLegs(); void refresh(); }, ms);
    }
  };

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
      let have = side === "buy" ? usdBal : coinBal;
      // the balance shown may be from before a trade that just landed (public nodes lag): read it again
      if (have !== null && amountIn > have) {
        setStep("Checking your balance…");
        for (let i = 0; i < 4 && have !== null && amountIn > have; i++) {
          if (i) await new Promise((r) => setTimeout(r, 1500));
          const fresh = await refresh();
          if (fresh) have = side === "buy" ? fresh.usd : fresh.coin;
        }
      }
      if (have !== null && amountIn > have) throw new Error(side === "buy" ? "Not enough USDC on this chain." : `You don't have that many ${coin.symbol}.`);

      // 1. approval (once per token: the router is a fixed contract with no owner)
      setStep("Checking approval…");
      const allowance = (await pub.readContract({ address: token, abi: raceErc20Abi, functionName: "allowance", args: [me, chain.router] })) as bigint;
      if (allowance < amountIn) {
        await w.send(chain.chain, [call(token, raceErc20Abi, "approve", [chain.router, maxUint256])], (s) => setStep(`Approve: ${s}`));
        // the node answering next may be a block behind the approval: wait until it sees it
        for (let i = 0; i < 8; i++) {
          const a = (await pub.readContract({ address: token, abi: raceErc20Abi, functionName: "allowance", args: [me, chain.router] }).catch(() => 0n)) as bigint;
          if (a >= amountIn) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
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
      const trade = await withGas(pub, me, call(chain.router, raceRouterAbi, fn, [coin.coin, amountIn, minOut, me, deadline()]));
      const tx = await w.send(chain.chain, [trade], (s) => setStep(s));
      const got = side === "buy" ? `${fmtAmount(Number(formatUnits(out, 18)))} ${coin.symbol}` : `$${fmtAmount(Number(formatUnits(out, usdDec)))}`;
      setMsg({ ok: true, text: side === "buy" ? `Bought about ${got}.` : `Sold for about ${got}.`, tx });
      signalTrade({ chainId: chain.chainId, curve: chain.router, coinId: coin.id, nativePerToken: null });
      if (side === "sell") setAmount("");
      // public nodes can be a block behind: read the balances again over the next seconds
      for (const ms of [0, 1_500, 4_000, 8_000]) setTimeout(() => void refresh(), ms);
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
      for (const ms of [0, 1_500, 4_000]) setTimeout(() => void refresh(), ms);
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
      {open.length > 1 && side !== "sell" && (
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

      <div className={"grid bg-night rounded-full p-1 " + (sides.length === 3 ? "grid-cols-3" : "grid-cols-2")} role="group" aria-label="Buy or sell">
        {sides.map((s) => (
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

      {side === "sell" ? (
        <SellPanel
          coin={coin}
          legs={legs}
          pct={sellPct}
          onPct={setSellPct}
          selling={selling}
          onSell={sellAll}
          connected={!!w.address}
          testnetEmail={w.embedded && IS_TESTNET}
          emailMain={emailMain}
          homeShort={home?.short ?? "Base"}
          returning={mine.filter((p) => p.kind === "home")}
        />
      ) : side === "auto" && tradable ? (
        <AutoPanel
          coin={{ address: coin.coin, symbol: coin.symbol, decimals: 18, kind: "race", raceId: coin.id }}
          coinChain={chain}
          priceUsd={lane.priceUsd}
          holdings={coinBal}
          mcFactor={RACE_SUPPLY}
        />
      ) : !tradable ? (
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
                    ? viaBase
                      ? homeBal === null
                        ? "…"
                        : `Balance $${fmtAmount(Number(formatUnits(homeBal, homeDec)))}`
                      : usdBal === null
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
          ) : w.embedded && IS_TESTNET ? (
            <p className="text-[0.875rem] text-ink-2">Races on testnet need a browser wallet (MetaMask, Rabby, Coinbase Wallet…). Email accounts join with the USDC deposit at mainnet.</p>
          ) : emailMain && !viaBase && !atHome ? (
            <p className="text-[0.875rem] text-ink-2">{chain.short} isn&apos;t open to email accounts yet. Trade this coin on another chain.</p>
          ) : (
            <button
              type="button"
              onClick={viaBase ? submitViaBase : submit}
              disabled={busy || !valid}
              className={
                "h-13 min-h-[3.25rem] rounded-full text-[1.0625rem] font-bold text-white disabled:opacity-50 " + (side === "buy" ? "bg-up" : "bg-danger")
              }
            >
              {busy ? (step ?? "Working…") : side === "buy" ? `Buy ${coin.symbol}` : `Sell ${coin.symbol}`}
            </button>
          )}

          {viaBase && (mine.length > 0 || spare >= parseUnits("0.5", usdDec)) && (
            <div className="flex flex-col gap-1.5 text-[0.8125rem]">
              {mine.map((p: Pending) => (
                <div key={p.id} className="flex items-center gap-2 text-ink-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald animate-pulse shrink-0" aria-hidden="true" />
                  {p.kind === "buy" ? `${coin.symbol} on the way to ${chain.short}…` : `Returning to Base: $${fmtAmount(p.usd)}`}
                </div>
              ))}
              {spare >= parseUnits("0.5", usdDec) && (
                <button type="button" onClick={bringHome} disabled={busy} className="self-start text-emerald-dark font-semibold underline underline-offset-2 disabled:opacity-50">
                  You have ${fmtAmount(Number(formatUnits(spare, usdDec)))} on {chain.short}. Send it to Base
                </button>
              )}
            </div>
          )}

          {w.address && !w.embedded && chain.faucet && side === "buy" && (
            <button type="button" onClick={faucet} disabled={busy} className="text-[0.8125rem] text-ink-3 underline underline-offset-2 self-center disabled:opacity-50">
              Get $100 test USDC on {chain.short}
            </button>
          )}
          <p className="text-[0.75rem] text-ink-3 text-center">
            {viaBase
              ? side === "buy"
                ? `Paid from your balance on Base: the coins arrive on ${chain.short} in about a minute. You pay Across's small fee and the network fees.`
                : `The dollars go back to your balance on Base in about a minute. You pay Across's small fee and the ${chain.short} network fee.`
              : `You pay the ${chain.short} network fee${w.embedded && usdcGasChain(chain.chainId) ? " in USDC" : ` in ${chain.chain.nativeCurrency.symbol}`}.`}{" "}
            Right after launch the pool fee is higher and falls to 2% within the first few minutes.
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

/** The sell side: one button for every chain the account holds the coin on. */
function SellPanel(p: {
  coin: RaceCoin;
  legs: SellLeg[] | null;
  pct: number;
  onPct: (v: number) => void;
  selling: boolean;
  onSell: () => void;
  connected: boolean;
  testnetEmail: boolean;
  emailMain: boolean;
  homeShort: string;
  returning: Pending[];
}) {
  const { coin, legs, pct } = p;
  const bps = BigInt(pct * 100);
  const sellable = (legs ?? []).filter((l) => l.state === "ready" || l.state === "failed" || l.state === "selling");
  const moving = (legs ?? []).filter((l) => l.state === "moving");
  const coinsOf = (ls: SellLeg[]) => ls.reduce((a, l) => a + Number(formatUnits(share(l.coins, bps), 18)), 0);
  const total = coinsOf(sellable);
  const usd = sellable.reduce((a, l) => a + Number(formatUnits(share(l.coins, bps), 18)) * (l.lane.priceUsd ?? 0), 0);
  const allCoins = (legs ?? []).filter((l) => l.state !== "closed").reduce((a, l) => a + Number(formatUnits(l.coins, 18)), 0);
  const shown = (legs ?? []).filter((l) => l.state !== "ready" || p.selling || sellable.length > 1);
  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-baseline gap-2 text-[0.8125rem] text-ink-3">
          <span>Sell {coin.symbol}</span>
          {p.connected && <span className="truncate tabular-nums">{legs === null ? "…" : `You have ${fmtAmount(allCoins)}`}</span>}
        </div>
        <div className="text-[2rem] font-bold leading-none tabular-nums text-ink truncate">{legs === null ? "—" : fmtAmount(total)}</div>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {QUICK_SELL.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => p.onPct(v)}
            disabled={p.selling}
            className={"h-10 rounded-xl border text-[0.875rem] disabled:opacity-40 " + (pct === v ? "border-ink font-semibold" : "border-line text-ink-2")}
          >
            {v === 100 ? "All" : `${v}%`}
          </button>
        ))}
      </div>

      <div className="flex justify-between gap-3 text-[0.875rem] text-ink-2">
        <span>You get about</span>
        <span className="font-semibold text-ink tabular-nums truncate">{legs === null || usd === 0 ? "—" : `$${fmtAmount(usd)}`}</span>
      </div>

      {shown.length > 0 && (
        <ul className="flex flex-col gap-1.5 text-[0.8125rem]">
          {shown.map((l) => (
            <li key={l.chain.chainId} className="flex items-start gap-2 min-w-0">
              <span className="w-2 h-2 rounded-full shrink-0 mt-[0.4rem]" style={{ background: l.chain.color }} aria-hidden="true" />
              <span className="font-semibold shrink-0">{l.chain.short}</span>
              <span className={"min-w-0 break-words " + (l.state === "failed" ? "text-danger" : "text-ink-2")}>
                {l.state === "selling"
                  ? (l.step ?? "Selling…")
                  : l.state === "done"
                    ? `Sold for about $${fmtAmount(l.usd ?? 0)}${p.emailMain && l.chain.short !== p.homeShort ? `, on its way to ${p.homeShort}` : ""}`
                    : l.state === "failed"
                      ? l.error
                      : l.state === "moving"
                        ? `${fmtAmount(Number(formatUnits(l.coins, 18)))} moving to ${coin.winner?.short ?? "the winner"}; sell them here once they arrive`
                        : l.state === "closed"
                          ? (l.note ?? "not open here")
                          : `${fmtAmount(Number(formatUnits(share(l.coins, bps), 18)))} ${coin.symbol}`}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!p.connected ? (
        <ConnectButton />
      ) : p.testnetEmail ? (
        <p className="text-[0.875rem] text-ink-2">Races on testnet need a browser wallet (MetaMask, Rabby, Coinbase Wallet…). Email accounts join with the USDC deposit at mainnet.</p>
      ) : (
        <button
          type="button"
          onClick={p.onSell}
          disabled={p.selling || legs === null || !sellable.some((l) => share(l.coins, bps) > 0n)}
          className="h-13 min-h-[3.25rem] rounded-full text-[1.0625rem] font-bold text-white bg-danger disabled:opacity-50"
        >
          {p.selling ? "Selling…" : legs !== null && !sellable.length ? (moving.length ? "On the way to the winner" : `No ${coin.symbol} to sell`) : `Sell ${pct === 100 ? "all" : `${pct}%`}`}
        </button>
      )}

      {p.returning.length > 0 && (
        <div className="flex flex-col gap-1.5 text-[0.8125rem]">
          {p.returning.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-ink-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald animate-pulse shrink-0" aria-hidden="true" />
              Returning to {p.homeShort}: ${fmtAmount(r.usd)}
            </div>
          ))}
        </div>
      )}

      <p className="text-[0.75rem] text-ink-3 text-center">
        {p.emailMain
          ? `One tap sells on every chain you hold ${coin.symbol} on. The dollars go to your balance on ${p.homeShort}: right away from ${p.homeShort}, in about a minute from the other chains.`
          : `One tap sells on every chain you hold ${coin.symbol} on, one wallet confirmation per chain. You pay each chain's network fee.`}
      </p>
    </>
  );
}
