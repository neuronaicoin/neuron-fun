"use client";

/**
 * Auto orders on a coin: take profit, stop loss and buy the dip, set with a
 * few taps. They run on-chain (SasaOrders) and the rewards service fills
 * them; the contract never fills outside the window set here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { maxUint256, parseEther, type Address } from "viem";
import { useWallet } from "./wallet";
import { ConnectButton } from "./chrome";
import { toast } from "./alerts";
import { usd } from "./coins";
import { curveAbi, ordersAbi, tokenAbi, usdcAbi } from "@/lib/abis";
import { USD_MODE } from "@/lib/config";
import { cashOf } from "@/lib/portfolio";
import { routerOf } from "@/lib/contracts";
import { clientFor, db, type Coin, type CurveInfo } from "@/lib/data";
import { fmtTokens, friendlyError } from "@/lib/format";
import { call } from "@/lib/tx";
import { autoPanelOpen, ordersChanged } from "@/lib/myorders";

const TP = [25, 50, 100, 200, 500] as const;
const SL = [10, 20, 30, 50] as const;
const DIP = [10, 20, 30, 50] as const;
const DIP_USD = [10, 25, 50, 100] as const;
const SHARES = [
  [100, "All"],
  [50, "Half"],
  [25, "Quarter"],
] as const;
/** How far below the stop a stop loss may still sell (fast drops). */
const STOP_SLIPPAGE = 5;
const MAX = maxUint256;

type Order = {
  id: bigint;
  curve: Address;
  isBuy: boolean;
  amount: bigint;
  minOut: bigint;
  maxOut: bigint;
  chainKey: string;
  /** What the order would get right now (wei for sells, tokens for buys). */
  now: bigint | null;
  /** A sell with no coins left in the wallet (e.g. the other order already sold them). */
  empty: boolean;
};

const mul = (x: bigint, pct: number) => (x * BigInt(Math.round(pct * 100))) / 10_000n;

/** Native value of `amt` tokens right now: exact on the curve, from the last trade in a pool. */
async function valueOf(c: CurveInfo, amt: bigint): Promise<bigint | null> {
  if (amt === 0n) return 0n;
  if (c.state !== "graduated") {
    return (await clientFor(c.chain).readContract({ address: c.curve, abi: curveAbi, functionName: "quoteSell", args: [amt] })) as bigint;
  }
  const px = await lastPrice(c);
  return px === null ? null : (BigInt(Math.floor(Number(amt) * px)) * 99n) / 100n;
}

/** Tokens `wei` buys right now. */
async function tokensFor(c: CurveInfo, wei: bigint): Promise<bigint | null> {
  if (wei === 0n) return 0n;
  if (c.state !== "graduated") {
    return (await clientFor(c.chain).readContract({ address: c.curve, abi: curveAbi, functionName: "quoteBuy", args: [wei] })) as bigint;
  }
  const px = await lastPrice(c);
  return px === null || px <= 0 ? null : (BigInt(Math.floor(Number(wei) / px)) * 99n) / 100n;
}

async function lastPrice(c: CurveInfo): Promise<number | null> {
  const { data } = await db
    .from("trades")
    .select("price")
    .eq("chain_id", c.chain.chain.id)
    .eq("curve", c.curve.toLowerCase())
    .order("ts", { ascending: false })
    .limit(1);
  const p = Number((data ?? [])[0]?.price);
  return p > 0 ? p : null;
}

export function AutoOrders({ coin, ethUsd }: { coin: Coin; ethUsd: number | null }) {
  // While this panel is open it lists the orders itself: the card under the trade box steps aside.
  useEffect(() => {
    autoPanelOpen(+1);
    return () => autoPanelOpen(-1);
  }, []);
  const { address, send } = useWallet();
  // The coin object is replaced every few seconds by the page's refresh; key
  // everything on what actually matters so nothing reloads (or flickers) for it.
  const curvesKey = coin.curves
    .filter((c) => c.chain.orders && c.state !== "closed" && c.state !== "moved")
    .map((c) => `${c.chain.key}:${c.curve}:${c.state}`)
    .join("|");
  const coinRef = useRef(coin);
  coinRef.current = coin;
  const curves = useMemo(
    () => coinRef.current.curves.filter((c) => c.chain.orders && c.state !== "closed" && c.state !== "moved"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [curvesKey]
  );
  const [chainKey, setChainKey] = useState<string>(curves[0]?.chain.key ?? "");
  const cur = curves.find((c) => c.chain.key === chainKey) ?? curves[0];
  const curKey = cur ? `${cur.chain.key}:${cur.curve}:${cur.state}` : "";

  const [held, setHeld] = useState<bigint | null>(null);
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [cash, setCash] = useState<bigint | null>(null);
  const [value, setValue] = useState<bigint | null>(null); // value of all held, wei
  const [tp, setTp] = useState({ on: false, pct: 100 as number, share: 100 as number });
  const [sl, setSl] = useState({ on: false, pct: 20 as number });
  const [dip, setDip] = useState({ on: false, pct: 20 as number, usd: 25 as number });
  const [tpValue, setTpValue] = useState<bigint | null>(null);
  const [dipTokens, setDipTokens] = useState<bigint | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  // Dollar edition: USDC has 6 decimals.
  const dipWei = USD_MODE ? BigInt(dip.usd) * 1_000_000n : ethUsd ? parseEther(String((dip.usd / ethUsd).toFixed(12))) : 0n;
  const tpAmount = held !== null ? (held * BigInt(tp.share)) / 100n : 0n;
  const eth = (w: bigint | null) => (w === null ? "…" : ethUsd ? usd((Number(w) / 1e18) * ethUsd, 2) : `${(Number(w) / 1e18).toFixed(6)} ETH`);

  // Holdings, cash and today's value on the chosen chain.
  const load = useCallback(async () => {
    if (!cur || !address || !cur.chain.orders) return;
    const pub = clientFor(cur.chain);
    const [bal, allow, native] = await Promise.all([
      pub.readContract({ address: cur.token, abi: tokenAbi, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
      pub.readContract({ address: cur.token, abi: tokenAbi, functionName: "allowance", args: [address, cur.chain.orders] }) as Promise<bigint>,
      cashOf(cur.chain, address),
    ]);
    setHeld(bal);
    setAllowance(allow);
    setCash(native);
    setValue(await valueOf(cur, bal).catch(() => null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curKey, address]);

  // Fresh numbers when the chain or wallet changes, then every 30 seconds.
  useEffect(() => {
    setHeld(null);
    setValue(null);
    void load().catch(() => {});
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load().catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!cur) return;
    let alive = true;
    valueOf(cur, tpAmount)
      .then((v) => alive && setTpValue(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curKey, tpAmount]);

  useEffect(() => {
    if (!cur || dipWei === 0n) return;
    let alive = true;
    tokensFor(cur, dipWei)
      .then((t) => alive && setDipTokens(t))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curKey, dipWei.toString()]);

  // Open orders on this coin, on every chain that has them.
  const loadOrders = useCallback(async () => {
    if (!address) return;
    const list: Order[] = [];
    for (const c of curves) {
      const pub = clientFor(c.chain);
      const [ids, bal] = await Promise.all([
        pub.readContract({ address: c.chain.orders!, abi: ordersAbi, functionName: "ordersOf", args: [address] }) as Promise<bigint[]>,
        pub.readContract({ address: c.token, abi: tokenAbi, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
      ]);
      const rows = await Promise.all(
        ids.slice(-60).map(async (id) => {
          const r = (await pub.readContract({ address: c.chain.orders!, abi: ordersAbi, functionName: "orders", args: [id] })) as readonly [
            Address, Address, Address, Address, boolean, boolean, bigint, bigint, bigint, bigint,
          ];
          return { id, curve: r[1], isBuy: r[4], open: r[5], amount: r[7], minOut: r[8], maxOut: r[9] };
        })
      );
      for (const r of rows) {
        if (!r.open || r.curve.toLowerCase() !== c.curve.toLowerCase()) continue;
        const sellable = r.amount < bal ? r.amount : bal;
        const now = r.isBuy ? await tokensFor(c, r.amount).catch(() => null) : await valueOf(c, sellable).catch(() => null);
        list.push({
          id: r.id,
          curve: r.curve,
          isBuy: r.isBuy,
          amount: r.amount,
          minOut: r.minOut,
          maxOut: r.maxOut,
          chainKey: c.chain.key,
          now,
          empty: !r.isBuy && bal === 0n,
        });
      }
    }
    setOrders(list.sort((a, b) => Number(b.id - a.id)));
  }, [address, curves]);

  useEffect(() => {
    void loadOrders().catch(() => setOrders((o) => o ?? []));
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void loadOrders().catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
  }, [loadOrders]);

  if (!curves.length) return <p className="text-[0.875rem] text-ink-3 mt-4">Auto orders aren&apos;t available for this coin yet.</p>;
  if (!address)
    return (
      <div className="mt-4">
        <p className="text-[0.875rem] text-ink-2 mb-3">Log in to set take profit, stop loss or buy the dip.</p>
        <ConnectButton full />
      </div>
    );

  const hasCoins = (held ?? 0n) > 0n;
  const count = (tp.on && hasCoins ? 1 : 0) + (sl.on && hasCoins ? 1 : 0) + (dip.on ? 1 : 0);
  const slValue = value !== null ? mul(value, 100 - sl.pct) : null;
  const slFloor = slValue !== null ? mul(slValue, 100 - STOP_SLIPPAGE) : null;
  const dipShort = dip.on && cash !== null && cash < dipWei;

  async function turnOn() {
    if (!cur || !cur.chain.orders) return;
    setError("");
    try {
      const router = cur.state === "graduated" ? await routerOf(cur) : cur.chain.router;
      const calls = [];
      const sells: { amount: bigint; minOut: bigint; maxOut: bigint }[] = [];
      if (tp.on && hasCoins) {
        const v = await valueOf(cur, tpAmount);
        if (!v) throw new Error("Couldn't price this coin right now. Try again in a moment.");
        sells.push({ amount: tpAmount, minOut: mul(v, 100 + tp.pct), maxOut: MAX });
      }
      if (sl.on && hasCoins && held) {
        const v = await valueOf(cur, held);
        if (!v) throw new Error("Couldn't price this coin right now. Try again in a moment.");
        const stop = mul(v, 100 - sl.pct);
        sells.push({ amount: held, minOut: mul(stop, 100 - STOP_SLIPPAGE), maxOut: stop });
      }
      // One allowance covers the pair: whichever fills first uses it, so the
      // same coins can never be sold twice.
      const need = sells.reduce((m, s) => (s.amount > m ? s.amount : m), 0n);
      if (need > 0n && allowance < need) calls.push(call(cur.token, tokenAbi, "approve", [cur.chain.orders, need]));
      for (const s of sells) calls.push(call(cur.chain.orders, ordersAbi, "placeSell", [cur.curve, router, s.amount, s.minOut, s.maxOut, 0n]));
      if (dip.on) {
        if (dipWei === 0n) throw new Error("Price not loaded yet. Try again in a moment.");
        const t = await tokensFor(cur, dipWei);
        if (!t) throw new Error("Couldn't price this coin right now. Try again in a moment.");
        const want = (t * 10_000n) / BigInt(Math.round((100 - dip.pct) * 100));
        // The dip money is set aside in USDC: approve the orders contract for it.
        const allow = (await clientFor(cur.chain).readContract({ address: cur.chain.usdc, abi: usdcAbi, functionName: "allowance", args: [address!, cur.chain.orders] })) as bigint;
        if (allow < dipWei) calls.push(call(cur.chain.usdc, usdcAbi, "approve", [cur.chain.orders, dipWei]));
        calls.push(call(cur.chain.orders, ordersAbi, "placeBuy", [cur.curve, router, dipWei, want, MAX, 0n]));
      }
      if (!calls.length) return;
      await send(cur.chain.chain, calls, setBusy);
      toast(count > 1 ? `${count} auto orders on ✓` : "Auto order on ✓");
      setTp((x) => ({ ...x, on: false }));
      setSl((x) => ({ ...x, on: false }));
      setDip((x) => ({ ...x, on: false }));
      void load();
      void loadOrders();
      ordersChanged();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  async function cancel(o: Order) {
    const c = curves.find((k) => k.chain.key === o.chainKey);
    if (!c?.chain.orders) return;
    try {
      setBusy(`cancel-${o.id}`);
      await send(c.chain.chain, [call(c.chain.orders, ordersAbi, "cancel", [o.id])], () => {});
      toast(o.isBuy ? "Cancelled. Your money is back in your cash." : "Cancelled");
      void loadOrders();
      ordersChanged();
      void load();
    } catch (e) {
      toast(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="mt-4">
      {curves.length > 1 && (
        <div className="flex gap-1.5 mb-3" role="group" aria-label="Chain">
          {curves.map((c) => (
            <button
              key={c.chain.key}
              type="button"
              aria-pressed={c.chain.key === cur.chain.key}
              onClick={() => setChainKey(c.chain.key)}
              className={"h-8 px-3 rounded-full border text-[0.75rem] font-semibold " + (c.chain.key === cur.chain.key ? "border-emerald text-ink" : "border-line text-ink-2")}
            >
              {c.chain.short}
            </button>
          ))}
        </div>
      )}

      <div className="flex justify-between items-baseline text-[0.8125rem] text-ink-3">
        <span>You hold</span>
        <span className="font-mono text-ink font-semibold text-right">
          {held === null ? "…" : `${fmtTokens(held)} $${coin.symbol}`}
          {hasCoins && <span className="text-ink-3 font-normal"> · {eth(value)}</span>}
        </span>
      </div>
      {!hasCoins && held !== null && (
        <p className="text-[0.75rem] text-ink-3 mt-1">Buy some first to set a take profit or stop loss. Buy the dip works without coins.</p>
      )}

      <Rule
        icon="🎯"
        title="Take profit"
        sub="Sell when your coins are worth more"
        tone="up"
        on={tp.on && hasCoins}
        disabled={!hasCoins}
        onToggle={() => setTp((x) => ({ ...x, on: !x.on }))}
      >
        <Chips values={TP} value={tp.pct} fmt={(v) => `+${v}%`} tone="up" onPick={(v) => setTp((x) => ({ ...x, pct: v }))} />
        <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-paper mt-2" role="group" aria-label="How much to sell">
          {SHARES.map(([v, l]) => (
            <button
              key={v}
              type="button"
              aria-pressed={tp.share === v}
              onClick={() => setTp((x) => ({ ...x, share: v }))}
              className={"h-8 rounded-lg text-[0.75rem] font-bold " + (tp.share === v ? "bg-surface text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-3")}
            >
              Sell {l.toLowerCase()}
            </button>
          ))}
        </div>
        <Line label="Sells when they're worth" value={tpValue !== null ? eth(mul(tpValue, 100 + tp.pct)) : "…"} />
        <Line label="Worth now" value={eth(tpValue)} muted />
      </Rule>

      <Rule
        icon="🛡"
        title="Stop loss"
        sub="Sell everything if the price falls"
        tone="danger"
        on={sl.on && hasCoins}
        disabled={!hasCoins}
        onToggle={() => setSl((x) => ({ ...x, on: !x.on }))}
      >
        <Chips values={SL} value={sl.pct} fmt={(v) => `−${v}%`} tone="danger" onPick={(v) => setSl((x) => ({ ...x, pct: v }))} />
        <Line label="Sells if they drop to" value={eth(slValue)} />
        <Line label="Lowest it will sell for" value={eth(slFloor)} muted />
        <p className="text-[0.6875rem] text-ink-3 mt-1.5 leading-snug">
          If the price crashes straight past that in one go, it waits instead of selling cheaper.
        </p>
      </Rule>

      <Rule
        icon="🪝"
        title="Buy the dip"
        sub="Buy automatically if the price drops"
        tone="accent"
        on={dip.on}
        disabled={cur.state === "closed"}
        onToggle={() => setDip((x) => ({ ...x, on: !x.on }))}
      >
        <Chips values={DIP} value={dip.pct} fmt={(v) => `−${v}%`} tone="accent" onPick={(v) => setDip((x) => ({ ...x, pct: v }))} />
        <Chips values={DIP_USD} value={dip.usd} fmt={(v) => `$${v}`} tone="accent" onPick={(v) => setDip((x) => ({ ...x, usd: v }))} small />
        <Line label={`Buys $${dip.usd} worth at`} value={`−${dip.pct}% from now`} />
        <Line label="You'd get at least" value={dipTokens !== null ? `${fmtTokens((dipTokens * 10_000n) / BigInt((100 - dip.pct) * 100))} $${coin.symbol}` : "…"} muted />
        <p className="text-[0.6875rem] text-ink-3 mt-1.5 leading-snug">The money is set aside now and comes back to your cash if you cancel.</p>
        {dipShort && <p className="text-[0.75rem] text-danger mt-1">Not enough cash for ${dip.usd}.</p>}
      </Rule>

      {error && (
        <p role="alert" className="text-danger text-[0.8125rem] mt-3">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={!count || !!busy || dipShort}
        onClick={() => void turnOn()}
        className="mt-4 w-full h-13 rounded-2xl bg-emerald text-on-accent font-bold text-[1rem] disabled:opacity-40"
      >
        {busy && !busy.startsWith("cancel") ? busy : count ? `Turn on ${count} auto order${count > 1 ? "s" : ""}` : "Pick an auto order"}
      </button>
      <p className="text-[0.6875rem] text-ink-3 mt-2 text-center">Runs while you&apos;re away. Cancel any time. 1% trade fee when it fills, nothing else.</p>

      <div className="mt-5">
        <div className="flex items-baseline justify-between">
          <h3 className="font-display font-semibold text-[1rem]">Your auto orders</h3>
          <span className="text-[0.6875rem] text-ink-3">on ${coin.symbol}</span>
        </div>
        {orders === null ? (
          <div className="shimmer h-14 rounded-xl mt-2" />
        ) : !orders.length ? (
          <p className="text-[0.8125rem] text-ink-3 mt-2">None yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {orders.map((o) => {
              const kind = o.isBuy ? "dip" : o.maxOut === MAX ? "tp" : "sl";
              const meta = {
                tp: { icon: "🎯", label: "Take profit", bar: "bg-up", bg: "bg-up/15" },
                sl: { icon: "🛡", label: "Stop loss", bar: "bg-danger", bg: "bg-danger/15" },
                dip: { icon: "🪝", label: "Buy the dip", bar: "bg-emerald", bg: "bg-emerald-soft" },
              }[kind];
              const target = kind === "sl" ? o.maxOut : o.minOut;
              const pct =
                o.now === null || target === 0n
                  ? 0
                  : kind === "sl"
                    ? Math.min(100, (Number(target) / Math.max(1, Number(o.now))) * 100)
                    : Math.min(100, (Number(o.now) / Number(target)) * 100);
              const detail = o.empty
                ? "Nothing left to sell here. You can cancel it."
                : kind === "dip"
                  ? `Buys ${eth(o.amount)} of $${coin.symbol} when the price is low enough`
                  : kind === "tp"
                    ? `Sells when worth ${eth(o.minOut)} (now ${eth(o.now)})`
                    : `Sells if worth drops to ${eth(o.maxOut)} (now ${eth(o.now)})`;
              return (
                <li key={`${o.chainKey}-${o.id}`} className="flex items-center gap-3 py-2.5">
                  <span className={"w-9 h-9 rounded-xl flex items-center justify-center shrink-0 " + meta.bg} aria-hidden="true">
                    {meta.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-[0.875rem]">
                      {meta.label}
                      {curves.length > 1 && <span className="text-ink-3 font-normal"> · {curves.find((c) => c.chain.key === o.chainKey)?.chain.short}</span>}
                    </span>
                    <span className="block text-[0.6875rem] text-ink-3 truncate">{detail}</span>
                    <span className="block h-1.5 rounded-full bg-line mt-1 overflow-hidden" aria-label={`${Math.round(pct)}% of the way`}>
                      <span className={"block h-full rounded-full " + meta.bar} style={{ width: `${pct}%` }} />
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => void cancel(o)}
                    className="h-8 px-3 rounded-lg border border-line text-[0.75rem] font-bold shrink-0 disabled:opacity-40"
                  >
                    {busy === `cancel-${o.id}` ? "…" : "Cancel"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Rule({
  icon,
  title,
  sub,
  tone,
  on,
  disabled,
  onToggle,
  children,
}: {
  icon: string;
  title: string;
  sub: string;
  tone: "up" | "danger" | "accent";
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const ring = { up: "border-up bg-up/5", danger: "border-danger bg-danger/5", accent: "border-emerald bg-emerald-soft/60" }[tone];
  const sw = { up: "bg-up", danger: "bg-danger", accent: "bg-emerald" }[tone];
  const id = `rule-${title.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div className={"mt-3 rounded-2xl border p-3 " + (on ? ring : "border-line") + (disabled ? " opacity-50" : "")}>
      <div className="flex items-center gap-3">
        <span className="w-9 h-9 rounded-xl bg-paper flex items-center justify-center text-[1.0625rem] shrink-0" aria-hidden="true">
          {icon}
        </span>
        <span className="min-w-0 flex-1" id={id}>
          <span className="block font-semibold text-[0.9375rem]">{title}</span>
          <span className="block text-[0.75rem] text-ink-3">{sub}</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={id}
          disabled={disabled}
          onClick={onToggle}
          className={"relative w-12 h-7 rounded-full shrink-0 transition-colors " + (on ? sw : "bg-line")}
        >
          <span className={"absolute top-[3px] left-[3px] w-[22px] h-[22px] rounded-full bg-white shadow transition-transform " + (on ? "translate-x-5" : "")} />
        </button>
      </div>
      {on && <div className="mt-3">{children}</div>}
    </div>
  );
}

function Chips({
  values,
  value,
  fmt,
  tone,
  onPick,
  small = false,
}: {
  values: readonly number[];
  value: number;
  fmt: (v: number) => string;
  tone: "up" | "danger" | "accent";
  onPick: (v: number) => void;
  small?: boolean;
}) {
  const active = { up: "border-up text-up", danger: "border-danger text-danger", accent: "border-emerald text-emerald" }[tone];
  return (
    <div className={"grid gap-1.5 " + (values.length === 5 ? "grid-cols-5 " : "grid-cols-4 ") + (small ? "mt-2" : "")} role="group">
      {values.map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onPick(v)}
          className={
            (small ? "h-8 text-[0.75rem] " : values.length === 5 ? "h-9 text-[0.75rem] sm:text-[0.8125rem] " : "h-9 text-[0.8125rem] ") +
            "rounded-xl border-[1.5px] bg-surface font-mono font-bold " +
            (value === v ? active : "border-line text-ink-2")
          }
        >
          {fmt(v)}
        </button>
      ))}
    </div>
  );
}

function Line({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between items-baseline gap-3 mt-2 text-[0.8125rem]">
      <span className="text-ink-3">{label}</span>
      <span className={"font-mono font-semibold text-right " + (muted ? "text-ink-3" : "text-ink")}>{value}</span>
    </div>
  );
}
