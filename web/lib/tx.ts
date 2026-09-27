import { encodeFunctionData, type Abi, type Address, type Hex } from "viem";

/** One contract call, ready to send from any kind of wallet. */
export type Call = { to: Address; data: Hex; value?: bigint };

export function call(to: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], value?: bigint): Call {
  return { to, data: encodeFunctionData({ abi, functionName, args } as never), value };
}
