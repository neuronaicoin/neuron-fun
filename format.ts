import { formatEther, formatUnits } from "viem";

/** ETH amount for people: a few significant digits, never scientific. */
export function fmtEth(wei: bigint | null | undefined, digits = 4): string {
  if (wei === null || wei === undefined) return "—";
  if (wei === 0n) return "0 ETH";
  const n = Number(formatEther(wei));
  if (n < 10 ** -digits) return `<${(10 ** -digits).toFixed(digits)} ETH`;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 2 : digits })} ETH`;
}

/** Token amount with thousands separators and a compact tail. */
export function fmtTokens(raw: bigint | null | undefined, decimals = 18): string {
  if (raw === null || raw === undefined) return "—";
  const n = Number(formatUnits(raw, decimals));
  if (n === 0) return "0";
  if (n >= 1_000_000) return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** A readable reason from a wallet or contract error. */
export function friendlyError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; code?: number; cause?: { code?: number } };
  if (err?.code === 4001 || err?.cause?.code === 4001) return "You cancelled it in your wallet.";
  const msg = err?.shortMessage || err?.message || "Something went wrong.";
  if (/insufficient funds/i.test(msg)) return "Not enough ETH in your wallet for this, including the network fee.";
  if (/SlippageExceeded|slippage/i.test(msg)) return "The price moved while you were confirming. Please try again.";
  if (/ParentNotListed/i.test(msg)) return "That family coin is not available right now. Pick another one.";
  if (/LaunchFeeNotCovered/i.test(msg)) return "The amount sent does not cover the creation fee.";
  return msg.split("\n")[0].slice(0, 180);
}
