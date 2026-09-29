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
  // The chain's node didn't answer (busy, rate-limited, or a flaky connection).
  if (/RPC Request failed|HTTP request failed|request timed out|Too Many Requests|\b429\b|rate limit/i.test(msg))
    return "The network didn't answer in time. Check your balance first (it may have gone through), then try again in a few seconds.";
  // Beta safety locks (v3). Selectors too, for errors that arrive undecoded.
  let raw = msg;
  try {
    raw += " " + JSON.stringify(err ?? {}, (_k, v) => (typeof v === "bigint" ? String(v) : v)).slice(0, 4000);
  } catch {
    // circular error objects: the message alone will do
  }
  if (/BuysPaused|0xf7cdbb58/i.test(raw)) return "Buying on this chain is paused for a moment. Selling works as usual.";
  if (/CreatorLocked|0xdd5074de/i.test(raw)) return "Your coins are locked until the time you set at launch. You can sell once the lock ends.";
  if (/CapReached|0x55f8a908/i.test(raw)) return "This chain is at its beta capacity right now. Try a smaller amount or another chain. Selling is open.";
  return msg.split("\n")[0].slice(0, 180);
}
