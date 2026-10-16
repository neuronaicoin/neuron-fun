"use client";

/**
 * The "Auto" tab next to Buy / Sell: take profit, stop loss and buy the dip on a race coin or
 * another DEX's coin. The order is signed (free) and runs on its own when the price is reached,
 * even with the site closed. 0.1% fee when it runs. Below it, the user's orders on this coin.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, type Address, type Chain, type Hex } from "viem";
import { useWallet } from "./wallet";
import { ConnectButton } from "./chrome";
import { friendlyError } from "@/lib/format";
import { fmtPrice, raceChain, raceExplorerTx, type RaceChain } from "@/lib/race";
import { homeChain } from "@/lib/racecross";
import {
  AUTO_CHANGED,
  AUTO_DAYS,
  AUTO_LABEL,
  AUTO_MIN_USD,
  cancelAuto,
  myAutoOrders,
  placeAuto,
  planAuto,
  type AutoCoin,
  type AutoKind,
  type PlaceDeps,
  type StoredOrder,
} from "@/lib/auto";

const KINDS: AutoKind[] = ["tp", "sl", "dip"];
const SELL_PCTS = [25, 50, 100];
const DIP_USD = [25, 50, 100];
const STEPS: Record<AutoKind, number[]> = { tp: [25, 50, 100], sl: [-10, -20, -30], dip: [-15, -30, -50] };

/** Price with a market cap next to it when the coin's supply is known (race coins: 1B). */
function priceLine(p: number, mcFactor?: number) {
  return mcFactor ? `${fmtPrice(p)} · MC $${(p * mcFactor).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : fmtPrice(p);
}

/** Sends an order's transactions: wallets pay their own gas; email accounts too, off the home chain. */
function autoSendOn(w: ReturnType<typeof useWallet>): PlaceDeps["sendOn"] {
  return (c, calls, onStep) => {
    const home = homeChain();
    return w.embedded && (!home || c.chainId !== home.chainId) ? w.sendOwnGas(c.chain, calls, onStep) : w.send(c.chain, calls, onStep);
  };
}

export function AutoPanel({
  coin,
  coinChain,
  priceUsd,
  holdings,
  mcFactor,
}: {
  coin: AutoCoin;
  coinChain: RaceChain;
  priceUsd: number | null;
  /** The user's coins on `coinChain` (raw units), null while loading. */
  holdings: bigint | null;
  mcFactor?: number;
}) {
  const w = useWallet();
  const [kind, setKind] = useState<AutoKind>("tp");
  const [pctMove, setPctMove] = useState<number>(STEPS.tp[0]);
  const [custom, setCustom] = useState("");
  const [sellPct, setSellPct] = useState(100);
  const [dipUsd, setDipUsd] = useState("25");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [orders, setOrders] = useState<StoredOrder[] | null>(null);
  const slipBps = kind === "sl" ? 500 : 200; // a stop must go through in a fast fall

  useEffect(() => {
    setPctMove(STEPS[kind][0]);
    setCustom("");
    setMsg(null);
  }, [kind]);

  const trigger = useMemo(() => {
    const c = Number(custom.replace(",", "."));
    if (custom && Number.isFinite(c) && c > 0) return c;
    return priceUsd ? priceUsd * (1 + pctMove / 100) : null;
  }, [custom, pctMove, priceUsd]);

  const plan = useMemo(() => planAuto(kind, coin, coinChain, w.embedded), [kind, coin, coinChain, w.embedded]);
  const sellAmount = holdings !== null ? (holdings * BigInt(sellPct)) / 100n : 0n;
  const amountUsd =
    kind === "dip" ? Number(dipUsd) || 0 : trigger ? (Number(formatUnits(sellAmount, coin.decimals)) * trigger) : 0;

  const problem = (() => {
    if ("error" in plan) return plan.error;
    if (!priceUsd || !trigger) return "Waiting for the price…";
    if (kind === "tp" && trigger <= priceUsd) return "Take profit needs a price above today's.";
    if (kind !== "tp" && trigger >= priceUsd) return `${AUTO_LABEL[kind]} needs a price below today's.`;
    if (kind !== "dip" && (holdings === null || holdings === 0n)) return `You don't hold any ${coin.symbol} on ${coinChain.short}.`;
    if (amountUsd < AUTO_MIN_USD) return `Auto orders start at $${AUTO_MIN_USD} (their 0.1% fee pays the network fee).`;
    return null;
  })();

  const load = useCallback(async () => {
    if (!w.address) return setOrders(null);
    try {
      const all = await myAutoOrders(w.signMessage);
      setOrders(all.filter((o) => o.coin.toLowerCase() === coin.address.toLowerCase()));
    } catch {
      setOrders([]);
    }
  }, [w.address, w.signMessage, coin.address]);
  useEffect(() => {
    const on = () => void load();
    window.addEventListener(AUTO_CHANGED, on);
    return () => window.removeEventListener(AUTO_CHANGED, on);
  }, [load]);

  const place = async () => {
    if (!w.address || busy || problem || "error" in plan || !trigger) return;
    setBusy(true);
    setMsg(null);
    try {
      const amountIn = kind === "dip" ? BigInt(Math.round((Number(dipUsd) || 0) * 10 ** (await usdDecimals(plan.runOn)))) : sellAmount;
      await placeAuto(
        {
          user: w.address as Address,
          sendOn: autoSendOn(w),
          signTyped: async (chain: Chain, typed) => {
            if (w.embeddedSigner) return w.embeddedSigner.signTypedData(typed as never);
            await w.switchTo(chain);
            return (await w.walletClient(chain).signTypedData({ account: w.address as Address, ...(typed as object) } as never)) as Hex;
          },
          sign: w.signMessage,
        },
        { kind, coin, coinChain, plan, amountIn, triggerUsd: trigger, slipBps, amountUsd, onStep: setStep }
      );
      setMsg({ ok: true, text: `${AUTO_LABEL[kind]} set at ${fmtPrice(trigger)}. It runs on its own when the price gets there.` });
      void load();
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e) });
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  const cancel = async (id: number) => {
    try {
      const onChain = await cancelAuto(w.signMessage, id, autoSendOn(w));
      setMsg({ ok: true, text: onChain ? "Cancelled, also on chain." : "Cancelled on sasa: it won't run. (The on-chain cancel didn't go through.)" });
      void load();
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e) });
    }
  };

  if (!w.address)
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[0.875rem] text-ink-2">
          Take profit, stop loss and buy the dip: set a price once and it runs on its own, even with sasa closed. Free to set; 0.1% when it runs.
        </p>
        <ConnectButton />
      </div>
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Order type">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            aria-pressed={kind === k}
            className={"h-10 rounded-xl border text-[0.8125rem] font-semibold " + (kind === k ? "border-ink text-ink" : "border-line text-ink-2")}
          >
            {AUTO_LABEL[k]}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] text-ink-3">{kind === "tp" ? "Sell when the price goes up" : kind === "sl" ? "Sell if the price falls" : "Buy if the price falls"}</span>
        <div className="grid grid-cols-3 gap-1.5">
          {STEPS[kind].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                setPctMove(p);
                setCustom("");
              }}
              aria-pressed={!custom && pctMove === p}
              className={"h-9 rounded-xl border text-[0.8125rem] font-semibold " + (!custom && pctMove === p ? "border-ink" : "border-line text-ink-2")}
            >
              {p > 0 ? `+${p}%` : `${p}%`}
            </button>
          ))}
        </div>
        <input
          inputMode="decimal"
          value={custom}
          onChange={(e) => setCustom(e.target.value.replace(/[^0-9.,]/g, ""))}
          placeholder="Or type a price in $"
          aria-label="Trigger price in dollars"
          className="h-10 rounded-xl border border-line bg-paper px-3 text-[0.875rem] outline-none focus:border-ink-3 min-w-0"
        />
        {trigger && <span className="text-[0.8125rem] text-ink-2 break-words">At {priceLine(trigger, mcFactor)}</span>}
      </div>

      {kind === "dip" ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] text-ink-3">Spend (USDC)</span>
          <div className="grid grid-cols-3 gap-1.5">
            {DIP_USD.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setDipUsd(String(v))}
                aria-pressed={dipUsd === String(v)}
                className={"h-9 rounded-xl border text-[0.8125rem] font-semibold " + (dipUsd === String(v) ? "border-ink" : "border-line text-ink-2")}
              >
                ${v}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] text-ink-3">How much to sell</span>
          <div className="grid grid-cols-3 gap-1.5">
            {SELL_PCTS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setSellPct(v)}
                aria-pressed={sellPct === v}
                className={"h-9 rounded-xl border text-[0.8125rem] font-semibold " + (sellPct === v ? "border-ink" : "border-line text-ink-2")}
              >
                {v === 100 ? "All" : `${v}%`}
              </button>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => void place()}
        disabled={busy || !!problem}
        className="h-12 rounded-full bg-ink text-paper font-bold text-[1rem] disabled:opacity-50"
      >
        {busy ? (step ?? "Working…") : `Set ${AUTO_LABEL[kind].toLowerCase()}`}
      </button>
      {problem && !busy && <p className="text-[0.8125rem] text-ink-2 text-center">{problem}</p>}
      {msg && (
        <p role="status" className={"rounded-xl px-3 py-2 text-[0.875rem] break-words " + (msg.ok ? "bg-emerald-soft text-ink" : "bg-warn-bg text-warn-ink")}>
          {msg.text}
        </p>
      )}
      <p className="text-[0.75rem] text-ink-3 text-center">
        Runs on its own when the price gets there, even with sasa closed (for {AUTO_DAYS} days). Free to set; 0.1% when it runs.
        {kind === "sl" ? " In a very fast fall it sells up to 5% under your price, or waits." : ""}
      </p>

      <OrderList orders={orders} onCancel={cancel} onShow={() => void load()} chain={coinChain} />
    </div>
  );
}

const usdDecCache = new Map<number, number>();
async function usdDecimals(c: RaceChain): Promise<number> {
  const hit = usdDecCache.get(c.chainId);
  if (hit !== undefined) return hit;
  const { raceClient, raceErc20Abi } = await import("@/lib/race");
  const d = Number(await raceClient(c).readContract({ address: c.usd, abi: raceErc20Abi, functionName: "decimals" }));
  usdDecCache.set(c.chainId, d);
  return d;
}

function OrderList({ orders, onCancel, onShow, chain }: { orders: StoredOrder[] | null; onCancel: (id: number) => void; onShow: () => void; chain: RaceChain }) {
  if (orders === null) {
    return (
      <button type="button" onClick={onShow} className="text-[0.8125rem] text-ink-3 underline underline-offset-2 self-center">
        Show my auto orders
      </button>
    );
  }
  const shown = orders.filter((o) => o.status === "open" || Date.now() - new Date(o.filledAt ?? o.createdAt).getTime() < 7 * 86400e3).slice(0, 10);
  if (!shown.length) return <p className="text-[0.8125rem] text-ink-3 text-center">No auto orders on this coin yet.</p>;
  return <AutoOrderRows orders={shown} onCancel={onCancel} chain={chain} />;
}

export function AutoOrderRows({ orders, onCancel }: { orders: StoredOrder[]; onCancel: (id: number) => void; chain?: RaceChain }) {
  return (
    <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
      {orders.map((o) => {
        const ranOn = raceChain(o.chainId);
        return (
        <li key={o.id} className="px-3 py-2 flex items-center gap-2 text-[0.8125rem] min-w-0">
          <span className="min-w-0 flex-1">
            <b className="font-semibold">{AUTO_LABEL[o.kind]}</b>
            {o.symbol ? ` $${o.symbol}` : ""} at {fmtPrice(o.triggerUsd)}
            <span className="block text-ink-3 truncate">
              {o.status === "open" ? (o.note ?? "Waiting for the price") : o.status === "filled" ? "Done ✓" : o.note ?? o.status}
            </span>
          </span>
          {o.status === "open" ? (
            <button type="button" onClick={() => onCancel(o.id)} className="shrink-0 h-8 px-3 rounded-lg border border-line text-ink-2 hover:border-danger hover:text-danger">
              Cancel
            </button>
          ) : o.filledTx && ranOn ? (
            <a href={raceExplorerTx(ranOn, o.filledTx)} target="_blank" rel="noreferrer" className="shrink-0 text-ink-3 underline">
              View
            </a>
          ) : null}
        </li>
        );
      })}
    </ul>
  );
}

/** All of the user's auto orders (on /me): loaded when asked, since it needs a sign-in. */
export function MyAutoOrders() {
  const w = useWallet();
  const [orders, setOrders] = useState<StoredOrder[] | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    if (!w.address) return;
    try {
      setOrders(await myAutoOrders(w.signMessage));
      setErr("");
    } catch (e) {
      setErr(friendlyError(e));
    }
  }, [w.address, w.signMessage]);
  useEffect(() => {
    setOrders(null);
  }, [w.address]);
  useEffect(() => {
    if (orders === null) return;
    const on = () => void load();
    window.addEventListener(AUTO_CHANGED, on);
    return () => window.removeEventListener(AUTO_CHANGED, on);
  }, [orders, load]);
  if (!w.address) return null;
  const open = orders?.filter((o) => o.status === "open") ?? [];
  const recent = orders?.filter((o) => o.status !== "open").slice(0, 10) ?? [];
  return (
    <section className="rounded-3xl border border-line bg-surface p-4 sm:p-5" aria-label="Your auto orders">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display font-semibold text-[1.0625rem]">Auto orders</h2>
        {orders === null && (
          <button type="button" onClick={() => void load()} className="h-9 px-3 rounded-xl border border-line text-[0.8125rem] font-semibold text-ink-2 hover:border-emerald/60">
            Show
          </button>
        )}
      </div>
      {err && <p className="mt-2 text-[0.8125rem] text-danger">{err}</p>}
      {orders !== null && (
        <div className="mt-3 flex flex-col gap-3">
          {open.length ? (
            <AutoOrderRows
              orders={open}
              onCancel={(id) =>
                void cancelAuto(w.signMessage, id, autoSendOn(w))
                  .then((onChain) => {
                    if (!onChain) setErr("Cancelled on sasa: it won't run. (The on-chain cancel didn't go through.)");
                    return load();
                  })
                  .catch((e) => setErr(friendlyError(e)))
              }
            />
          ) : (
            <p className="text-[0.8125rem] text-ink-3">No open auto orders. Set one from the Auto tab on any coin.</p>
          )}
          {recent.length > 0 && (
            <>
              <h3 className="text-[0.8125rem] text-ink-3">Recently closed</h3>
              <AutoOrderRows orders={recent} onCancel={() => {}} />
            </>
          )}
        </div>
      )}
    </section>
  );
}
