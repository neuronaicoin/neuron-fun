import { maxUint256, parseAbi, type Address, type Chain, type Hex } from "viem";
import { RACE_SETS, raceChain, raceClient, raceErc20Abi, type RaceChain } from "./race";
import { homeChain } from "./racecross";
import { authedDelete, authedGet, authedPost, type SignFn } from "./alerts";
import { call, type Call } from "./tx";

/**
 * Auto orders (take profit, stop loss, buy the dip) on race coins and other DEXs' coins.
 * The user signs an order (EIP-712, free) for AutoOrders (contracts-v7/src/auto/AutoOrders.sol)
 * on the chain it runs on, approves the token it spends once, and the site stores it through
 * /api/auto. sasa's keeper (keeper/auto.mjs) runs it when the price is reached. The contract
 * makes sure the user gets at least the signed minimum; the fee is 0.1% when it runs.
 */

export type AutoKind = "tp" | "sl" | "dip";
export const AUTO_LABEL: Record<AutoKind, string> = { tp: "Take profit", sl: "Stop loss", dip: "Buy the dip" };
/** Smallest order: its 0.1% fee must pay the network fee of running it. */
export const AUTO_MIN_USD = 20;
export const AUTO_FEE = 0.001;
/** sasa's fee on other DEXs' coins (Relay app fee), taken inside the trade. */
export const EXT_FEE = 0.007;
/** How long an order stays open. */
export const AUTO_DAYS = 30;
/** Most an Across leg may cost (sending dollars home, or a dip buy on another chain), in dollars. */
export const AUTO_MAX_ROUTE_USD = 0.5;

export const MODE_SWAP = 0;
export const MODE_SELL_HOME = 1;
export const MODE_BUY_CROSS = 2;

export const ORDER_TYPES = {
  Order: [
    { name: "user", type: "address" },
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minOut", type: "uint256" },
    { name: "mode", type: "uint8" },
    { name: "destChainId", type: "uint256" },
    { name: "maxRouteFee", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const autoAbi = parseAbi(["function cancel(uint256 nonce)", "function used(address, uint256) view returns (bool)"]);

export type AutoCoin = {
  address: Address;
  symbol: string;
  decimals: number;
  kind: "race" | "ext";
  raceId?: string;
  network?: string;
};

/** Other DEXs' networks → the race chain with the same chain id (where AutoOrders runs). */
const NETWORK_CHAIN: Record<string, number> = { base: 8453, bsc: 56, robinhood: 4663, arc: 5042 };
export const chainForNetwork = (network: string): RaceChain | null => raceChain(NETWORK_CHAIN[network] ?? -1) ?? null;

export const autoReady = (c: RaceChain | null | undefined): c is RaceChain & { auto: Address } => !!c && !!c.auto;

export type AutoPlan = {
  /** Where the order is signed and run. */
  runOn: RaceChain & { auto: Address };
  mode: number;
  destChainId: number;
  /** Token spent (the coin for sells, the dollar for dips) and token received. */
  tokenIn: Address;
  tokenOut: Address;
  maxRouteFee: bigint;
};

/**
 * Where an order runs. Sells run where the coins are (email accounts send the dollars home to
 * Base). Dip buys spend dollars: email accounts' dollars are on Base, so a dip on another chain
 * goes through Across to that chain's RaceCross (race coins only); wallets buy where they are.
 */
export function planAuto(kind: AutoKind, coin: AutoCoin, coinChain: RaceChain, emailAccount: boolean): AutoPlan | { error: string } {
  // the home chain of the coin's own contract set (its AutoOrders routes dips to that set's RaceCross)
  const base = homeChain();
  const home = base ? (raceChain(base.chainId, coinChain.stack) ?? base) : null;
  const onHome = !!home && home.chainId === coinChain.chainId;
  if (kind !== "dip") {
    if (!autoReady(coinChain)) return { error: `Auto orders aren't open on ${coinChain.short} yet.` };
    const sellHome = emailAccount && !onHome && !!home;
    return {
      runOn: coinChain,
      mode: sellHome ? MODE_SELL_HOME : MODE_SWAP,
      destChainId: 0,
      tokenIn: coin.address,
      tokenOut: coinChain.usd,
      maxRouteFee: 0n, // set in placeAuto from the chain dollar's decimals
    };
  }
  if (!emailAccount || onHome) {
    if (!autoReady(coinChain)) return { error: `Auto orders aren't open on ${coinChain.short} yet.` };
    return { runOn: coinChain, mode: MODE_SWAP, destChainId: 0, tokenIn: coinChain.usd, tokenOut: coin.address, maxRouteFee: 0n };
  }
  if (coin.kind !== "race") return { error: `Buy the dip works on Base coins for now. This coin is on ${coinChain.short}.` };
  if (!home || !autoReady(home) || !coinChain.cross) return { error: "Buy the dip isn't open for this chain yet." };
  return { runOn: home, mode: MODE_BUY_CROSS, destChainId: coinChain.chainId, tokenIn: home.usd, tokenOut: coin.address, maxRouteFee: 0n };
}

const decCache = new Map<string, number>();
async function decimalsOf(c: RaceChain, token: Address): Promise<number> {
  const k = `${c.chainId}:${token.toLowerCase()}`;
  const hit = decCache.get(k);
  if (hit !== undefined) return hit;
  const d = Number(await raceClient(c).readContract({ address: token, abi: raceErc20Abi, functionName: "decimals" }));
  decCache.set(k, d);
  return d;
}

/** The order's minimum: what it gives at the trigger price, less fees and the user's slippage. */
export function minOutFor(o: { kind: AutoKind; coin: AutoCoin; amountIn: bigint; inDec: number; outDec: number; triggerUsd: number; slipBps: number }): bigint {
  const fees = AUTO_FEE + (o.coin.kind === "ext" ? EXT_FEE : 0);
  const keep = (1 - fees) * (1 - o.slipBps / 10_000);
  const amount = Number(o.amountIn) / 10 ** o.inDec;
  const out = o.kind === "dip" ? (amount / o.triggerUsd) * keep : amount * o.triggerUsd * keep;
  if (!Number.isFinite(out) || out <= 0) return 0n;
  // to the token's smallest unit, through a string so big coin amounts keep their digits
  const [whole, frac = ""] = out.toFixed(Math.min(o.outDec, 12)).split(".");
  return BigInt(whole + frac.padEnd(o.outDec, "0").slice(0, o.outDec)) || 1n;
}

export type StoredOrder = {
  id: number;
  chainId: number;
  /** The AutoOrders contract it was signed for (v7 and v8 each have their own). */
  contract?: string;
  kind: AutoKind;
  coin: string;
  coinChain: number;
  coinKind: "race" | "ext";
  raceId: string | null;
  network: string | null;
  symbol: string;
  triggerUsd: number;
  amountUsd: number;
  status: "open" | "filled" | "cancelled" | "expired" | "failed";
  note: string | null;
  createdAt: string;
  filledTx: string | null;
  filledAt: string | null;
  /** The signed order's number (cancelled on chain with it). */
  nonce?: string | null;
};

export type PlaceDeps = {
  user: Address;
  /** Sends approvals: wallet.send for wallets and for email accounts on Base; sendOwnGas elsewhere. */
  sendOn: (c: RaceChain, calls: Call[], onStep?: (m: string) => void) => Promise<Hex>;
  /** Signs the order on `chain` (email: the embedded signer; wallets: after switching to it). */
  signTyped: (chain: Chain, typed: { domain: Record<string, unknown>; types: typeof ORDER_TYPES; primaryType: "Order"; message: Record<string, unknown> }) => Promise<Hex>;
  sign: SignFn;
};

/** Approves (if needed), signs and stores an order. */
export async function placeAuto(
  d: PlaceDeps,
  o: { kind: AutoKind; coin: AutoCoin; coinChain: RaceChain; plan: AutoPlan; amountIn: bigint; triggerUsd: number; slipBps: number; amountUsd: number; onStep?: (m: string) => void }
): Promise<StoredOrder> {
  const { plan } = o;
  const c = plan.runOn;
  const inDec = await decimalsOf(c, plan.tokenIn);
  const outDec = plan.mode === MODE_BUY_CROSS ? o.coin.decimals : await decimalsOf(c, plan.tokenOut);
  const minOut = minOutFor({ kind: o.kind, coin: o.coin, amountIn: o.amountIn, inDec, outDec, triggerUsd: o.triggerUsd, slipBps: o.slipBps });
  if (minOut === 0n) throw new Error("That price doesn't work. Check the numbers.");
  const usdDec = await decimalsOf(c, c.usd);
  const maxRouteFee = plan.mode === MODE_SWAP ? 0n : BigInt(Math.round(AUTO_MAX_ROUTE_USD * 10 ** usdDec));

  // 1. the token it spends, approved once for AutoOrders on that chain
  o.onStep?.("Checking approval…");
  const allowance = (await raceClient(c).readContract({ address: plan.tokenIn, abi: raceErc20Abi, functionName: "allowance", args: [d.user, c.auto!] })) as bigint;
  if (allowance < o.amountIn) {
    await d.sendOn(c, [call(plan.tokenIn, raceErc20Abi, "approve", [c.auto!, maxUint256])], (m) => o.onStep?.(`Approve: ${m}`));
  }

  // 2. the order, signed (free)
  o.onStep?.("Signing the order…");
  const nonce = BigInt("0x" + Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + AUTO_DAYS * 86400);
  const message = {
    user: d.user,
    tokenIn: plan.tokenIn,
    tokenOut: plan.tokenOut,
    amountIn: o.amountIn,
    minOut,
    mode: plan.mode,
    destChainId: BigInt(plan.destChainId),
    maxRouteFee,
    deadline,
    nonce,
  };
  const signature = await d.signTyped(c.chain, {
    domain: { name: "sasa AutoOrders", version: "1", chainId: c.chainId, verifyingContract: c.auto! },
    types: ORDER_TYPES,
    primaryType: "Order",
    message,
  });

  // 3. stored for the keeper
  o.onStep?.("Saving…");
  const str = Object.fromEntries(Object.entries(message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  const r = await authedPost<{ order: StoredOrder }>(d.sign, "auto", {
    chainId: c.chainId,
    contract: c.auto,
    kind: o.kind,
    coin: o.coin.address,
    coinChain: o.coinChain.chainId,
    coinKind: o.coin.kind,
    raceId: o.coin.raceId,
    network: o.coin.network,
    symbol: o.coin.symbol,
    triggerUsd: o.triggerUsd,
    amountUsd: o.amountUsd,
    order: str,
    signature,
  });
  ordersChangedAuto();
  return r.order;
}

export async function myAutoOrders(sign: SignFn): Promise<StoredOrder[]> {
  return (await authedGet<{ orders: StoredOrder[] }>(sign, "auto")).orders;
}

/**
 * Cancels an order: at once on sasa (the keeper drops it), then on its chain too, so the signed
 * order can never run whatever happens later. The chain step is a small transaction the user
 * approves; if it doesn't go through (refused, no gas), the order is still cancelled on sasa.
 * Returns whether the chain step went through.
 */
export async function cancelAuto(sign: SignFn, id: number, sendOn?: PlaceDeps["sendOn"]): Promise<boolean> {
  const mine = sendOn ? await myAutoOrders(sign).catch(() => [] as StoredOrder[]) : [];
  await authedDelete(sign, `auto/${id}`);
  ordersChangedAuto();
  const o = mine.find((x) => x.id === id);
  const sets = RACE_SETS.flat().filter((x) => x.chainId === o?.chainId && x.auto);
  const c = o ? (sets.find((x) => x.auto!.toLowerCase() === (o.contract ?? "").toLowerCase()) ?? (o.contract ? undefined : sets[0])) : undefined;
  if (!sendOn || !o?.nonce || !c) return false;
  try {
    await sendOn(c, [call(c.auto!, autoAbi, "cancel", [BigInt(o.nonce)])]);
    return true;
  } catch {
    return false;
  }
}

export const AUTO_CHANGED = "sasa-auto-orders";
export function ordersChangedAuto() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTO_CHANGED));
}

/** Any chain with auto orders on this site (the Auto tab shows only then). */
export const autoAnywhere = () => RACE_SETS.flat().some((c) => !!c.auto);
