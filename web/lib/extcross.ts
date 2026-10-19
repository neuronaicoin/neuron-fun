import { createPublicClient, fallback, http, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { getQuote, NATIVE, type Quote } from "./relay";
import { raceChain, raceClient, raceErc20Abi, type RaceChain } from "./race";
import { homeChain } from "./racecross";
import { IS_TESTNET } from "./config";
import type { Call } from "./tx";

/**
 * Other DEXs' coins on chains where the user's dollars aren't: Relay moves the dollars and
 * swaps in one go. Buying: the user's USDC on Base → the coin on its chain (one Base step; for
 * email accounts the network fee is paid in USDC). If the user has almost no gas there, a few
 * cents of the same USDC also become that chain's gas coin, so they can sell later. Selling:
 * the coin on its chain → USDC on Base, sent from the user's own address there (gas from that
 * top-up). sasa pays no one's gas; its 0.7% fee is in Relay's quote.
 */

/** Other DEXs' networks → chain ids. */
const NETWORK_CHAIN: Record<string, number> = { base: 8453, bsc: 56, robinhood: 4663, arc: 5042, eth: 1 };

/** A chain coins are traded on: a race chain, or Ethereum (no sasa contracts there, only Relay). */
export type XChain = { chainId: number; short: string; chain: Chain; usd: Address };

/** Ethereum: coins from the Market list are bought there from Base USDC through Relay. */
export const ETHEREUM: XChain = {
  chainId: 1,
  short: "Ethereum",
  chain: mainnet,
  usd: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};
let ethClient: PublicClient | null = null;
/** A reader for `c` (race chains share the race clients). */
export function xClient(c: XChain): PublicClient {
  if (c.chainId !== 1) return raceClient(c as RaceChain);
  ethClient ??= createPublicClient({
    chain: mainnet,
    transport: fallback([http("https://ethereum-rpc.publicnode.com"), http("https://eth.llamarpc.com"), http()]),
  }) as PublicClient;
  return ethClient;
}
export const xChain = (chainId: number): XChain | null => (chainId === 1 ? ETHEREUM : (raceChain(chainId) ?? null));

/** Below this much gas coin on a chain, a buy brings a little with it. */
const GAS_FLOOR: Record<number, bigint> = { 4663: 50_000_000_000_000n, 56: 200_000_000_000_000n, 5042: 100_000_000_000_000_000n, 1: 600_000_000_000_000n };
/** The gas top-up, in USDC (6 decimals on Base): 30 cents; $3 on Ethereum, where a sale costs more. */
export const GAS_TOPUP_USDC = 300_000n;
export const gasTopup = (chainId: number) => (chainId === 1 ? 3_000_000n : GAS_TOPUP_USDC);
/** Left on Base for the network fee of the Base step itself (email accounts pay it in USDC). */
const BASE_FEE_ROOM = 50_000n;

export type ExtRoute =
  | { kind: "same" } // the coin is where the dollars are: the existing same-chain swap
  | { kind: "cross"; home: RaceChain; there: XChain }
  | { kind: "none"; why: string };

/**
 * How a coin on `network` is traded. Base coins: on Base. Robinhood coins: wallets keep using
 * their Robinhood dollars; email accounts trade from Base. BNB Chain and Arc coins: from Base.
 */
export function extRoute(network: string, emailAccount: boolean): ExtRoute {
  if (IS_TESTNET) return { kind: "none", why: "Trading these coins opens at mainnet." };
  if (network === "base") return { kind: "same" };
  if (network === "robinhood" && !emailAccount) return { kind: "same" };
  const home = homeChain();
  const there = xChain(NETWORK_CHAIN[network] ?? -1);
  if (!home || !there) return { kind: "none", why: "Trading coins on this chain is coming soon." };
  return { kind: "cross", home, there };
}

/** The quote's transactions as calls on `chainId` (Relay's approve + deposit steps). */
export function quoteCallsOn(q: Quote, chainId: number): Call[] {
  const calls: Call[] = [];
  for (const step of q.steps) {
    if (step.kind !== "transaction") throw new Error("This trade needs a signature step we don't support yet.");
    for (const it of step.items) {
      if (Number(it.data.chainId) !== chainId) throw new Error("This route changed. Try again in a moment.");
      calls.push({ to: it.data.to as Address, data: it.data.data as Hex, value: it.data.value ? BigInt(it.data.value) : undefined });
    }
  }
  return calls;
}

/** True when the user has almost no gas coin on `c` (a buy then brings a little). */
export async function lowGas(c: XChain, user: Address): Promise<boolean> {
  const floor = GAS_FLOOR[c.chainId];
  if (floor === undefined) return false;
  const bal = await xClient(c).getBalance({ address: user });
  return bal < floor;
}

/** Price of a buy from Base (for "You get"). */
export function quoteCrossBuy(o: { user: Address; home: RaceChain; there: XChain; token: Address; amountHome: bigint; signal?: AbortSignal }) {
  return getQuote(
    {
      user: o.user,
      recipient: o.user,
      originChainId: o.home.chainId,
      destinationChainId: o.there.chainId,
      originCurrency: o.home.usd,
      destinationCurrency: o.token,
      amount: o.amountHome.toString(),
      fee: "swap",
    },
    o.signal
  );
}

/** Price of a sell back to Base. */
export function quoteCrossSell(o: { user: Address; home: RaceChain; there: XChain; token: Address; amount: bigint; signal?: AbortSignal }) {
  return getQuote(
    {
      user: o.user,
      recipient: o.user,
      originChainId: o.there.chainId,
      destinationChainId: o.home.chainId,
      originCurrency: o.token,
      destinationCurrency: o.home.usd,
      amount: o.amount.toString(),
      fee: "swap",
    },
    o.signal
  );
}

export type ExtSenders = {
  user: Address;
  sendHome: (chain: Chain, calls: Call[], onStep?: (m: string) => void) => Promise<Hex>;
  sendThere: (chain: Chain, calls: Call[], onStep?: (m: string) => void) => Promise<Hex>;
};

/** Buys `token` on `there` with `amountHome` of the user's USDC on Base (plus gas if they're low). */
export async function crossExtBuy(o: { s: ExtSenders; home: RaceChain; there: XChain; token: Address; amountHome: bigint; onStep?: (m: string) => void }) {
  const { s, home, there } = o;
  o.onStep?.("Getting the price…");
  const needGas = await lowGas(there, s.user).catch(() => false);
  const [q, gasQ] = await Promise.all([
    quoteCrossBuy({ user: s.user, home, there, token: o.token, amountHome: o.amountHome }),
    needGas
      ? getQuote({
          user: s.user,
          recipient: s.user,
          originChainId: home.chainId,
          destinationChainId: there.chainId,
          originCurrency: home.usd,
          destinationCurrency: NATIVE,
          amount: gasTopup(there.chainId).toString(),
        }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const total = o.amountHome + (gasQ ? gasTopup(there.chainId) : 0n);
  const bal = (await raceClient(home).readContract({ address: home.usd, abi: raceErc20Abi, functionName: "balanceOf", args: [s.user] })) as bigint;
  if (bal < total + BASE_FEE_ROOM) throw new Error(`Not enough USDC. You have $${(Number(bal) / 1e6).toFixed(2)}${gasQ ? ` (a buy here also brings $${(Number(gasTopup(there.chainId)) / 1e6).toFixed(2)} of gas)` : ""}.`);
  // the gas top-up first, so the last transaction (what a browser wallet reports) is the trade itself
  const calls = [...(gasQ ? quoteCallsOn(gasQ, home.chainId) : []), ...quoteCallsOn(q, home.chainId)];
  const tx = await s.sendHome(home.chain, calls, o.onStep);
  return { tx, quote: q, gas: !!gasQ };
}

/** Sells `amount` of `token` on `there`; the USDC goes to the user's address on Base. */
export async function crossExtSell(o: { s: ExtSenders; home: RaceChain; there: XChain; token: Address; amount: bigint; onStep?: (m: string) => void }) {
  const { s, home, there } = o;
  // a sale is two transactions there (approve, then swap): about 300k gas at today's price, with room
  const client = xClient(there);
  const [gas, gasPrice] = await Promise.all([client.getBalance({ address: s.user }), client.getGasPrice()]);
  const need = (300_000n * gasPrice * 12n) / 10n;
  const sym = there.chain.nativeCurrency.symbol;
  if (gas === 0n || gas < need) {
    const have = gas === 0n ? "no" : `only ${(Number(gas) / 1e18).toPrecision(2)}`;
    throw new Error(`You have ${have} ${sym} on ${there.short}; this sale needs about ${(Number(need) / 1e18).toPrecision(2)} ${sym} for the network fee. Any buy there from sasa brings a little.`);
  }
  o.onStep?.("Getting the price…");
  const q = await quoteCrossSell({ user: s.user, home, there, token: o.token, amount: o.amount });
  const tx = await s.sendThere(there.chain, quoteCallsOn(q, there.chainId), o.onStep);
  return { tx, quote: q };
}
