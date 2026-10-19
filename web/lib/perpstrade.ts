"use client";

/**
 * Perps trading on Hyperliquid (orders, money in and out). Read-only data is in lib/perps.ts.
 *
 * Signing: Hyperliquid's trading messages are signed for its own chain (1337), which browser
 * wallets refuse while on another chain, so wallet users approve a trading key once (an
 * "agent", kept in this browser; it can trade but never move money out). Email accounts sign
 * with their own key directly. Two approvals happen once, on the first trade: sasa's 0.07%
 * builder fee, and (wallets) the trading key.
 *
 * Money in: Base USDC → the user's Hyperliquid perps balance, through Relay (one Base step).
 * Money out: Hyperliquid sends it (minus its ~$1 fee) to a Relay deposit address on Arbitrum,
 * which delivers USDC to the user's address on Base.
 */
import { useMemo } from "react";
import type { Address, Chain, Hex, LocalAccount, WalletClient } from "viem";
import type { IRequestTransport } from "@nktkas/hyperliquid";
import type { Call } from "./tx";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { useWallet } from "@/components/wallet";
import { CHAINS, HL_BUILDER } from "./config";
import { getQuote } from "./relay";
import { quoteCallsOn } from "./extcross";
import { BUILDER_FEE, BUILDER_FEE_TENTHS_BP, HL_API, HL_TAKER_FEE, MIN_NOTIONAL, PERPS_TRADING, priceString, sizeString, type PerpMarket, type PerpOrder, type PerpPosition } from "./perps";
import { cashOf } from "./portfolio";

/** Hyperliquid's perps USDC, as Relay names it. */
const HL_PERPS_USDC = "0x00000000000000000000000000000000";
const HL_CHAIN_ID = 1337;
const ARBITRUM = 42161;
const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
/** Hyperliquid's withdrawal fee (dollars), taken from what is moved out. */
export const HL_WITHDRAW_FEE = 1;
export const MIN_MOVE = 5;
/** How far a market order may fill from the mark price (open) and when closing. */
const SLIP_OPEN = 0.01;
const SLIP_CLOSE = 0.02;
const AGENT_NAME = "sasa";

/** `limitPx`: a limit order that waits at that price; none: a market order. */
export type OpenOrder = { market: PerpMarket; side: "long" | "short"; margin: number; lev: number; coins: string; tp: number | null; sl: number | null; limitPx?: number | null };
export type PerpsTrade = {
  deposit: (amount: number, onStep: (m: string | null) => void) => Promise<void>;
  withdraw: (amount: number, onStep: (m: string | null) => void) => Promise<void>;
  open: (o: OpenOrder, onStep: (m: string | null) => void) => Promise<{ avgPx: number | null; resting?: boolean }>;
  /** Closes all of a position, or a part (fraction 0.25 = a quarter). */
  close: (p: PerpPosition, m: PerpMarket | null, fraction?: number) => Promise<void>;
  /** Sets (or removes, with null) the take profit and stop loss of an open position. */
  setTpsl: (p: PerpPosition, m: PerpMarket | null, t: { tp: number | null; sl: number | null }, current: PerpOrder[]) => Promise<void>;
  cancel: (o: PerpOrder, m: PerpMarket | null) => Promise<void>;
};

const defaultTransport = new HttpTransport({ apiUrl: HL_API });
const defaultInfo = new InfoClient({ transport: defaultTransport });
const agentKey = (user: string) => `sasa.hl.agent.${user.toLowerCase()}`;

function readAgent(store: Pick<Storage, "getItem"> | null, user: string): `0x${string}` | null {
  try {
    const k = store?.getItem(agentKey(user));
    return k && /^0x[0-9a-f]{64}$/i.test(k) ? (k as `0x${string}`) : null;
  } catch {
    return null;
  }
}

/** Hyperliquid's error text, in plain words where we know it. */
export function hlError(e: unknown): Error {
  const m = String((e as { message?: string })?.message ?? e);
  if (/insufficient margin|not enough/i.test(m)) return new Error("Not enough in your futures balance for that.");
  if (/could not immediately match|no resting orders/i.test(m)) return new Error("The price moved too fast. Try again.");
  if (/minimum value|min.*\$10/i.test(m)) return new Error("The smallest position is $10 (amount × leverage).");
  if (/builder fee has not been approved|builder/i.test(m) && /approv/i.test(m)) return new Error("Trading isn't approved yet. Try again to approve it.");
  if (/does not exist|user or api wallet/i.test(m)) return new Error("Your futures account isn't set up yet. Add money first.");
  if (/rejected|denied|user rejected/i.test(m)) return new Error("You cancelled it in your wallet.");
  return new Error(m.length > 160 ? `${m.slice(0, 160)}…` : m);
}

/** What trading needs from the wallet (lib/perpstrade tests pass their own). */
export type TradeDeps = {
  address: string | null;
  embeddedSigner: LocalAccount | null;
  walletClient: (chain: Chain) => WalletClient;
  send: (chain: Chain, calls: Call[], onStep?: (m: string) => void) => Promise<Hex>;
  transport?: IRequestTransport;
  storage?: Pick<Storage, "getItem" | "setItem">;
};

export function usePerpsTrade(after: () => Promise<void>): PerpsTrade {
  const w = useWallet();
  return useMemo(
    () => makePerpsTrade({ address: w.address ?? null, embeddedSigner: w.embeddedSigner, walletClient: w.walletClient, send: w.send }, after),
    [w.address, w.embeddedSigner, w.walletClient, w.send, after]
  );
}

export function makePerpsTrade(w: TradeDeps, after: () => Promise<void>): PerpsTrade {
  {
    const transport = w.transport ?? defaultTransport;
    const infoClient = w.transport ? new InfoClient({ transport }) : defaultInfo;
    const store = w.storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
    const base = CHAINS.find((c) => c.key === "base");
    const user = w.address as Address | null;

    /** The user's own key: signs approvals and moving money out. */
    function mainClient(): ExchangeClient {
      if (!user) throw new Error("Log in first.");
      if (w.embeddedSigner) return new ExchangeClient({ transport, wallet: w.embeddedSigner, signatureChainId: "0x2105" });
      if (!base) throw new Error("Base isn't set up on this site.");
      // the browser wallet, signing on Base (Hyperliquid accepts any chain for these approvals)
      const wc = w.walletClient(base.chain);
      const wallet = {
        signTypedData: (p: object) => wc.signTypedData({ account: user, ...(p as object) } as never) as Promise<`0x${string}`>,
        getAddresses: async () => [user] as `0x${string}`[],
        getChainId: () => wc.getChainId(),
      };
      return new ExchangeClient({ transport, wallet });
    }

    /** sasa's fee approved once; wallets: a trading key approved once. Returns the client that trades. */
    async function ready(onStep: (m: string | null) => void): Promise<ExchangeClient> {
      if (!PERPS_TRADING) throw new Error("Trading opens at mainnet.");
      if (!user) throw new Error("Log in first.");
      const max = await infoClient.maxBuilderFee({ user, builder: HL_BUILDER }).catch(() => 0);
      if (Number(max) < BUILDER_FEE_TENTHS_BP) {
        onStep("Approve trading (one time)…");
        await mainClient().approveBuilderFee({ maxFeeRate: `${BUILDER_FEE_TENTHS_BP / 1000}%`, builder: HL_BUILDER });
      }
      if (w.embeddedSigner) return new ExchangeClient({ transport, wallet: w.embeddedSigner, signatureChainId: "0x2105" });
      let key = readAgent(store, user);
      const agents = await infoClient.extraAgents({ user }).catch(() => [] as { address: string; validUntil: number | null }[]);
      const live = key && agents.some((a) => a.address.toLowerCase() === privateKeyToAccount(key!).address.toLowerCase() && (a.validUntil ?? Number.MAX_SAFE_INTEGER) > Date.now() + 60_000);
      if (!live) {
        key = generatePrivateKey();
        onStep("Approve trading in your wallet (once)…");
        await mainClient().approveAgent({ agentAddress: privateKeyToAccount(key).address, agentName: AGENT_NAME });
        try {
          store?.setItem(agentKey(user), key);
        } catch {
          /* private window: approved again next time */
        }
      }
      return new ExchangeClient({ transport, wallet: privateKeyToAccount(key!) });
    }

    const builder = { b: HL_BUILDER as `0x${string}`, f: BUILDER_FEE_TENTHS_BP };

    const futuresFree = async () => Number((await infoClient.clearinghouseState({ user: user! }).catch(() => null))?.withdrawable ?? 0);

    /**
     * Makes sure the futures balance can pay `need` dollars: the difference (at least $5, Relay's
     * smallest move) comes from the user's cash on Base, then the order waits for it to land.
     */
    async function fundFutures(need: number, onStep: (m: string | null) => void) {
      if (!user || !base) throw new Error("Log in first.");
      const have = await futuresFree();
      if (have + 1e-6 >= need) return;
      const top = Math.max(MIN_MOVE, Math.ceil(((need - have) * 1.02 + 0.25) * 100) / 100);
      const cash = Number(await cashOf(base, user)) / 1e6;
      if (cash + 1e-6 < top)
        throw new Error(
          have + cash + 1e-6 >= need
            ? `Futures takes at least $${MIN_MOVE} from your cash at a time, and you have $${cash.toFixed(2)}. Add a little money first.`
            : `Not enough money: $${have.toFixed(2)} in futures and $${cash.toFixed(2)} cash. Add money first.`
        );
      onStep(`Moving $${top.toFixed(2)} from your cash to futures…`);
      const q = await getQuote({
        user,
        recipient: user,
        originChainId: base.chain.id,
        originCurrency: base.usdc,
        destinationChainId: HL_CHAIN_ID,
        destinationCurrency: HL_PERPS_USDC,
        amount: String(Math.round(top * 1e6)),
      });
      await w.send(base.chain, quoteCallsOn(q, base.chain.id), (s) => onStep(s));
      void after();
      onStep("Waiting for the money to land in futures…");
      const until = Date.now() + 120_000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2_000));
        if ((await futuresFree()) + 1e-6 >= need) return;
      }
      throw new Error(`Your $${top.toFixed(2)} is on its way to futures (usually under a minute). Tap again in a moment.`);
    }

    return {
      async deposit(amount, onStep) {
        if (!PERPS_TRADING) throw new Error("Trading opens at mainnet.");
        if (!user || !base) throw new Error("Log in first.");
        if (!(amount >= MIN_MOVE)) throw new Error(`The smallest amount is $${MIN_MOVE}.`);
        onStep("Getting the route…");
        const q = await getQuote({
          user,
          recipient: user,
          originChainId: base.chain.id,
          originCurrency: base.usdc,
          destinationChainId: HL_CHAIN_ID,
          destinationCurrency: HL_PERPS_USDC,
          amount: String(Math.round(amount * 1e6)),
        });
        await w.send(base.chain, quoteCallsOn(q, base.chain.id), (m) => onStep(m));
        onStep(null);
        setTimeout(() => void after(), 8_000);
        setTimeout(() => void after(), 30_000);
      },

      async withdraw(amount, onStep) {
        if (!PERPS_TRADING) throw new Error("Trading opens at mainnet.");
        if (!user || !base) throw new Error("Log in first.");
        if (!(amount >= MIN_MOVE)) throw new Error(`The smallest amount is $${MIN_MOVE}.`);
        onStep("Getting the route…");
        // a one-time Relay address on Arbitrum that delivers to the user's address on Base
        const q = await getQuote({
          user,
          recipient: user,
          originChainId: ARBITRUM,
          originCurrency: ARBITRUM_USDC,
          destinationChainId: base.chain.id,
          destinationCurrency: base.usdc,
          amount: String(Math.round((amount - HL_WITHDRAW_FEE) * 1e6)),
          useDepositAddress: true,
          refundTo: user,
        });
        if (!q.depositAddress || !/^0x[0-9a-fA-F]{40}$/.test(q.depositAddress)) throw new Error("This route isn't available right now. Try again in a moment.");
        onStep("Confirm in your wallet…");
        try {
          await mainClient().withdraw3({ destination: q.depositAddress as `0x${string}`, amount: String(amount) });
        } catch (e) {
          throw hlError(e);
        }
        onStep(null);
        setTimeout(() => void after(), 5_000);
      },

      async open(o, onStep) {
        const ex = await ready(onStep);
        const m = o.market;
        const buy = o.side === "long";
        // the margin and the fee, brought over from the cash balance when futures holds less
        await fundFutures(o.margin + o.margin * o.lev * (HL_TAKER_FEE + BUILDER_FEE) + 0.05, onStep);
        try {
          onStep(`Setting ${o.lev}x…`);
          await ex.updateLeverage({ asset: m.index, isCross: false, leverage: o.lev });
          onStep("Opening…");
          const orders: Parameters<ExchangeClient["order"]>[0]["orders"] = [
            o.limitPx
              ? { a: m.index, b: buy, p: priceString(o.limitPx, m.szDecimals), s: o.coins, r: false, t: { limit: { tif: "Gtc" } } }
              : { a: m.index, b: buy, p: priceString(m.mark * (buy ? 1 + SLIP_OPEN : 1 - SLIP_OPEN), m.szDecimals), s: o.coins, r: false, t: { limit: { tif: "Ioc" } } },
          ];
          for (const [kind, at] of [["tp", o.tp], ["sl", o.sl]] as const) {
            if (!at) continue;
            // closing side; the limit is a 10% slippage bound behind the trigger
            orders.push({
              a: m.index,
              b: !buy,
              p: priceString(at * (buy ? 0.9 : 1.1), m.szDecimals),
              s: o.coins,
              r: true,
              t: { trigger: { isMarket: true, triggerPx: priceString(at, m.szDecimals), tpsl: kind } },
            });
          }
          const res = await ex.order({ orders, grouping: orders.length > 1 ? "normalTpsl" : "na", builder });
          const first = res.response.data.statuses[0];
          onStep(null);
          void after();
          if (first && typeof first === "object" && "filled" in first) return { avgPx: Number(first.filled.avgPx) };
          if (o.limitPx && first && typeof first === "object" && "resting" in first) return { avgPx: null, resting: true };
          throw new Error("The order didn't fill. Try again.");
        } catch (e) {
          throw hlError(e);
        }
      },

      async close(p, m, fraction = 1) {
        if (!m) throw new Error("This market isn't loaded yet.");
        const all = !(fraction > 0 && fraction < 1);
        const size = all ? sizeString(Math.abs(p.size), m.szDecimals) : sizeString(Math.abs(p.size) * fraction, m.szDecimals);
        // a part must still be a real order, and leave a real position behind
        // (with room: the order's limit sits a little under the price)
        if (!all && (Number(size) * m.mark < MIN_NOTIONAL * 1.05 || (Math.abs(p.size) - Number(size)) * m.mark < MIN_NOTIONAL * 1.05))
          throw new Error(`That part is too small (the smallest order is $${MIN_NOTIONAL}). Close all of it instead.`);
        if (!(Number(size) > 0)) throw new Error("Nothing to close.");
        const ex = await ready(() => {});
        const buy = p.side === "short";
        try {
          await ex.order({
            orders: [{ a: m.index, b: buy, p: priceString(m.mark * (buy ? 1 + SLIP_CLOSE : 1 - SLIP_CLOSE), m.szDecimals), s: size, r: true, t: { limit: { tif: "Ioc" } } }],
            grouping: "na",
            builder,
          });
        } catch (e) {
          throw hlError(e);
        }
        void after();
      },

      async setTpsl(p, m, t, current) {
        if (!m) throw new Error("This market isn't loaded yet.");
        const long = p.side === "long";
        const ref = m.mark;
        if (t.tp && (long ? t.tp <= ref : t.tp >= ref)) throw new Error(`Take profit must be ${long ? "above" : "below"} the price.`);
        if (t.sl && (long ? t.sl >= ref : t.sl <= ref)) throw new Error(`Stop loss must be ${long ? "below" : "above"} the price.`);
        if (t.sl && p.liq && (long ? t.sl <= p.liq : t.sl >= p.liq)) throw new Error("Stop loss is past the liquidation price.");
        const ex = await ready(() => {});
        const size = sizeString(Math.abs(p.size), m.szDecimals);
        const old = current.filter((o) => o.coin === p.coin && (o.tpsl === "tp" || o.tpsl === "sl"));
        try {
          // the new ones first, so the position is never left without them; then the old ones go
          const orders: Parameters<ExchangeClient["order"]>[0]["orders"] = [];
          for (const [kind, at] of [["tp", t.tp], ["sl", t.sl]] as const) {
            if (!at) continue;
            orders.push({
              a: m.index,
              b: !long,
              p: priceString(at * (long ? 0.9 : 1.1), m.szDecimals),
              s: size,
              r: true,
              t: { trigger: { isMarket: true, triggerPx: priceString(at, m.szDecimals), tpsl: kind } },
            });
          }
          if (orders.length) {
            try {
              await ex.order({ orders, grouping: "na", builder });
            } catch (e) {
              // part of it may have gone through (the SDK throws if any order fails): look at what is
              // open now, and drop only the old ones that a new one replaced, so nothing is doubled
              const oldIds = new Set(old.map((o) => o.oid));
              const now = (await infoClient.frontendOpenOrders({ user: user! }).catch(() => [])) as { coin: string; oid: number; orderType: string }[];
              const kinds = new Set(
                now
                  .filter((o) => o.coin === p.coin && !oldIds.has(o.oid))
                  .map((o) => (/take profit/i.test(o.orderType) ? "tp" : /stop/i.test(o.orderType) ? "sl" : ""))
              );
              const gone = old.filter((o) => o.tpsl && kinds.has(o.tpsl));
              if (gone.length) await ex.cancel({ cancels: gone.map((o) => ({ a: m.index, o: o.oid })) }).catch(() => {});
              throw e;
            }
          }
          // the old ones go: those replaced, and those removed (box left empty)
          if (old.length) {
            try {
              await ex.cancel({ cancels: old.map((o) => ({ a: m.index, o: o.oid })) });
            } catch {
              throw new Error("The new TP/SL is set, but an old one couldn't be removed. Cancel it in TP/SL & orders.");
            }
          }
        } catch (e) {
          throw hlError(e);
        }
        void after();
      },

      async cancel(o, m) {
        if (!m) throw new Error("This market isn't loaded yet.");
        const ex = await ready(() => {});
        try {
          await ex.cancel({ cancels: [{ a: m.index, o: o.oid }] });
        } catch (e) {
          throw hlError(e);
        }
        void after();
      },
    };
  }
}
