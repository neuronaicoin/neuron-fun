import { encodeFunctionData, type Abi, type Address, type Hex } from "viem";

/**
 * One contract call, ready to send from any kind of wallet. `gas`: a gas limit worked out by
 * the page (browser wallets use it; without it the wallet estimates on its own).
 */
export type Call = { to: Address; data: Hex; value?: bigint; gas?: bigint };

export function call(to: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], value?: bigint): Call {
  return { to, data: encodeFunctionData({ abi, functionName, args } as never), value };
}
