"use client";

import { encodeFunctionData, parseAbi, type Address } from "viem";
import { usdcAbi } from "./abis";
import type { NeuronChain } from "./config";
import { clientFor } from "./data";
import type { Call } from "./tx";

/**
 * Moving the user's own cash between chains with Across, in the background (mainnet only:
 * a chain takes part once its config has `acrossSpoke`). The user's account deposits its
 * dollars into Across on one chain; a relayer pays the same account on the other chain,
 * usually within seconds. Across's fee comes out of the money (no ETH needed).
 */

const spokeAbi = parseAbi([
  "function depositV3Now(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 fillDeadlineOffset, uint32 exclusivityDeadline, bytes message) payable",
]);

/** Fallback fee when Across's quote service can't be reached: 0.3%, at least $0.10. */
function fallbackOut(amount: bigint): bigint {
  const fee = (amount * 30n) / 10_000n;
  return amount - (fee < 100_000n ? 100_000n : fee);
}

/** What arrives on `to` for `amount` sent from `from` (Across's live quote when possible). */
export async function quoteMove(from: NeuronChain, to: NeuronChain, amount: bigint): Promise<bigint> {
  try {
    const q = new URLSearchParams({
      inputToken: from.usdc,
      outputToken: to.usdc,
      originChainId: String(from.chain.id),
      destinationChainId: String(to.chain.id),
      amount: amount.toString(),
    });
    const r = await fetch(`https://app.across.to/api/suggested-fees?${q}`);
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as { outputAmount?: string; totalRelayFee?: { total?: string } };
    const out = j.outputAmount ? BigInt(j.outputAmount) : amount - BigInt(j.totalRelayFee?.total ?? "0");
    // Never accept a quote that eats more than 2% (or looks broken).
    if (out <= 0n || out > amount || out < (amount * 98n) / 100n) return fallbackOut(amount);
    return out;
  } catch {
    return fallbackOut(amount);
  }
}

export function canMove(from: NeuronChain, to: NeuronChain): boolean {
  return !!from.acrossSpoke && !!to.acrossSpoke && from.key !== to.key;
}

/** The calls (on `from`) that move `amount` dollars to the same account on `to`. */
export function moveCalls(from: NeuronChain, to: NeuronChain, account: Address, amount: bigint, out: bigint): Call[] {
  const spoke = from.acrossSpoke!;
  return [
    { to: from.usdc, data: encodeFunctionData({ abi: usdcAbi, functionName: "approve", args: [spoke, amount] }) },
    {
      to: spoke,
      data: encodeFunctionData({
        abi: spokeAbi,
        functionName: "depositV3Now",
        args: [account, account, from.usdc, to.usdc, amount, out, BigInt(to.chain.id), "0x0000000000000000000000000000000000000000", 3600, 0, "0x"],
      }),
    },
  ];
}

/** Waits until the account's dollars on `to` grew by `out` (or gives up after `ms`). */
export async function waitArrival(to: NeuronChain, account: Address, before: bigint, out: bigint, ms = 90_000): Promise<boolean> {
  const pub = clientFor(to);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const bal = (await pub.readContract({ address: to.usdc, abi: usdcAbi, functionName: "balanceOf", args: [account] }).catch(() => 0n)) as bigint;
    if (bal >= before + out) return true;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}
