/**
 * HYPE on Elysium straight from the user's cash (USDC on Base; money added from Solana or any
 * other chain lands there as USDC too): Relay swaps and bridges it to HYPE in the user's own
 * address on Elysium, usually in seconds. A buy without enough HYPE does this by itself, in the
 * same tap. The user pays everything (Relay's cost and sasa's swap fee are in the quote; email
 * accounts pay the Base network fee in USDC). sasa pays nobody's gas. Mainnet only.
 */
import type { Address, Chain, Hex } from "viem";
import { getQuote, NATIVE, type Quote } from "./relay";
import { homeChain } from "./racecross";
import { raceClient, raceErc20Abi } from "./race";
import { quoteCallsOn } from "./extcross";
import { ELYSIUM, elysiumHypeBalance } from "./elysium";
import type { Call } from "./tx";

/** Amounts offered, in dollars. */
export const HYPE_TOPUPS = [2, 5, 20] as const;
/** Kept for network fees (≈ a few trades); below it an account counts as having no gas. */
export const HYPE_GAS_FLOOR = 2_000_000_000_000_000n; // 0.002 HYPE
/** Left on Base for the Base step's own network fee. */
const BASE_FEE_ROOM = 50_000n;

export const elysiumTopupReady = () => !ELYSIUM.testnet && !!homeChain();

/** A price for `usd` of cash → HYPE, or for exactly `hypeOut` wei of HYPE arriving. */
export async function quoteHype(user: Address, want: { usd: number } | { hypeOut: bigint }): Promise<Quote> {
  const home = homeChain();
  if (!home || ELYSIUM.testnet) throw new Error("Adding HYPE from cash opens with Elysium mainnet.");
  const exact = "hypeOut" in want;
  try {
    return await getQuote({
      user,
      recipient: user,
      originChainId: home.chainId,
      originCurrency: home.usd,
      destinationChainId: ELYSIUM.chain.id,
      destinationCurrency: NATIVE,
      amount: exact ? want.hypeOut.toString() : String(Math.round(want.usd * 1e6)),
      ...(exact ? { tradeType: "EXACT_OUTPUT" as const } : {}),
      fee: "swap",
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (/chain|unsupported|not supported|route/i.test(m)) throw new Error("Cash → HYPE on Elysium isn't open yet. Send HYPE to your address for now.");
    throw e;
  }
}

/**
 * Turns the user's cash into HYPE on Elysium (`usd` of it, or exactly `hypeOut` arriving) and
 * waits until it lands. Returns the new HYPE balance, or null when it's still on its way.
 */
export async function addHype(o: {
  user: Address;
  usd?: number;
  hypeOut?: bigint;
  send: (chain: Chain, calls: Call[], onStep?: (m: string) => void) => Promise<Hex>;
  onStep?: (m: string) => void;
}): Promise<bigint | null> {
  const home = homeChain();
  if (!home) throw new Error("Adding HYPE from cash isn't available here.");
  o.onStep?.("Getting the price…");
  const [q, cash, before] = await Promise.all([
    quoteHype(o.user, o.hypeOut !== undefined ? { hypeOut: o.hypeOut } : { usd: o.usd ?? 0 }),
    raceClient(home).readContract({ address: home.usd, abi: raceErc20Abi, functionName: "balanceOf", args: [o.user] }) as Promise<bigint>,
    elysiumHypeBalance(o.user).catch(() => 0n),
  ]);
  const amount = BigInt(q.inRaw || "0");
  if (cash < amount + BASE_FEE_ROOM)
    throw new Error(`Not enough cash: this needs $${(Number(amount) / 1e6).toFixed(2)} and you have $${(Number(cash) / 1e6).toFixed(2)}. Add money first.`);
  await o.send(home.chain, quoteCallsOn(q, home.chainId), o.onStep);
  o.onStep?.("Turning cash into HYPE…");
  // Relay pays out on Elysium as soon as the Base transaction is in: check often
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 700));
    const now = await elysiumHypeBalance(o.user).catch(() => before);
    if (now > before) return now;
  }
  return null;
}
