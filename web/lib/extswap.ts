"use client";

import type { Address, Hex } from "viem";
import { CHAINS, type NeuronChain } from "./config";
import { getQuote, type Quote } from "./relay";
import type { Call } from "./tx";

/**
 * Buying and selling other DEXs' coins (mainnet): Relay finds the best price on the chain
 * the coin lives on and returns the transactions (approve + swap). sasa's 0.7% fee is part
 * of the quote and goes to the treasury. Only coins on our own chains for now, where the
 * user's cash is and gas is paid for them.
 */

const NETWORK_TO_CHAIN: Record<string, string> = { robinhood: "robinhood", base: "base" };

export function chainForNetwork(network: string): NeuronChain | null {
  const key = NETWORK_TO_CHAIN[network];
  return key ? CHAINS.find((c) => c.key === key) ?? null : null;
}

export async function quoteSwap(opts: {
  chain: NeuronChain;
  account: Address;
  side: "buy" | "sell";
  token: Address;
  /** Dollars (6 decimals) for a buy, coin units for a sell. */
  amount: bigint;
  signal?: AbortSignal;
}): Promise<Quote> {
  const { chain, account, side, token, amount, signal } = opts;
  return getQuote(
    {
      user: account,
      recipient: account,
      originChainId: chain.chain.id,
      destinationChainId: chain.chain.id,
      originCurrency: side === "buy" ? chain.usdc : token,
      destinationCurrency: side === "buy" ? token : chain.usdc,
      amount: amount.toString(),
      fee: "swap",
    },
    signal
  );
}

/** The quote's transactions, in order, as calls for one batch on `chain`. */
export function quoteCalls(q: Quote, chain: NeuronChain): Call[] {
  const calls: Call[] = [];
  for (const step of q.steps) {
    if (step.kind !== "transaction") throw new Error("This trade needs a signature step we don't support yet.");
    for (const it of step.items) {
      if (it.data.chainId !== chain.chain.id) throw new Error("This trade would leave the chain. Try again in a moment.");
      calls.push({ to: it.data.to as Address, data: it.data.data as Hex, value: it.data.value ? BigInt(it.data.value) : undefined });
    }
  }
  return calls;
}
