import { formatEther, formatUnits } from "viem";
import { USD_MODE } from "./config";

/**
 * Money amount for people. Dollar edition: USDC (6 decimals) shown as dollars.
 * Otherwise ETH with a few significant digits, never scientific.
 */
export function fmtEth(wei: bigint | null | undefined, digits = 4): string {
  if (wei === null || wei === undefined) return "—";
  if (USD_MODE) {
    const d = Number(wei) / 1e6;
    if (d > 0 && d < 0.01) return "<$0.01";
    return `$${d.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
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
  if (msg.includes("SENT_UNCONFIRMED")) return "Sent. The network is slow to confirm it; your balance will update in a moment.";
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

/**
 * Short money amounts: $950, $155.5K, $1.65M, $1.1B, $2.4T. Trailing zeros are
 * dropped ($12M, not $12.00M), so a market cap never runs long.
 */
export function compactUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n);
  const trim = (x: string) => x.replace(/\.?0+$/, "");
  if (v >= 1e12) return `${sign}$${trim((v / 1e12).toFixed(2))}T`;
  if (v >= 1e9) return `${sign}$${trim((v / 1e9).toFixed(2))}B`;
  // 999,950 would round to "1000.0K": show it as $1M instead.
  if (v >= 999_950) return `${sign}$${trim((v / 1e6).toFixed(2))}M`;
  if (v >= 1e3) return `${sign}$${trim((v / 1e3).toFixed(1))}K`;
  return `${sign}$${v < 10 ? v.toFixed(2) : Math.round(v).toString()}`;
}
