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
const NETWORK_RE = /RPC Request failed|HTTP request failed|request timed out|timed? ?out|Too Many Requests|\b429\b|rate limit|fetch failed|Failed to fetch|NetworkError|socket hang up|ECONNRESET/i;

/** True when a call failed because a node didn't answer, not because the chain said no. */
export function isNetworkError(e: unknown): boolean {
  const err = e as { shortMessage?: string; message?: string; details?: string };
  const m = `${err?.shortMessage ?? ""} ${err?.message ?? ""} ${err?.details ?? ""}`;
  if (/revert|reverted|execution reverted/i.test(m)) return false;
  return NETWORK_RE.test(m);
}

/**
 * Reads and simulations are safe to repeat: when a node doesn't answer, try again
 * (0.6 s, then 1.5 s) before showing anything to the user.
 */
export async function retryNetwork<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  const waits = [600, 1500, 3000];
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1 || !isNetworkError(e)) throw e;
      await new Promise((r) => setTimeout(r, waits[Math.min(i, waits.length - 1)]));
    }
  }
}

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
  if (isNetworkError(e))
    return "The network is busy right now. Please check your balance, then try again in a few seconds.";
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
  // Launch and token errors that used to arrive as bare signatures.
  if (/ERC20InsufficientBalance|0xe450d38c|transfer amount exceeds balance/i.test(raw)) return "Not enough USDC on this chain for that amount. Lower it or add USDC on this chain.";
  if (/ERC20InsufficientAllowance|0xfb8f41b2/i.test(raw)) return "The approval didn't go through. Please try again.";
  if (/LaunchesClosed/i.test(raw)) return "New launches are paused for a moment. Please try again shortly.";
  if (/NoRoute/i.test(raw)) return "This chain can't link to the others right now. Launch on one chain, or try again later.";
  if (/BadChains/i.test(raw)) return "That chain combination isn't available. Pick the chains again.";
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
