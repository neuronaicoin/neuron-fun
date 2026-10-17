import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, pad, parseAbi, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { RACE_CHAINS, raceClient, raceErc20Abi, raceRouterAbi, type RaceChain } from "./race";
import { usdcGasChain } from "./usdcgas";
import { call, type Call } from "./tx";

/**
 * sasa accounts (email / Google login) keep their dollars on Base. On the other race chains
 * they trade through each chain's RaceCross contract (contracts-v7/src/race/RaceCross.sol):
 *  - buy / launch: one Base transaction (network fee in USDC) deposits the dollars into Across
 *    with the order in the message; Across's relayer delivers them to RaceCross, which buys or
 *    launches for the user (and, if the user has almost no gas there, keeps up to 50 cents of it
 *    as gas so they can sell later). The user pays everything; sasa pays nothing.
 *  - sell: on that chain, from the user's own address (gas from the top-up), `sellAndSendHome`
 *    sells and sends the dollars back to the same address on Base through Across.
 * A launch can only be done by the user: it carries their signature (EIP-712, no popup).
 */

/** Across's API (the documented host first, the app's host as a fallback). */
const ACROSS_API = ["https://across.to/api", "https://app.across.to/api"];

export const spokeAbi = parseAbi([
  "function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable",
  "function depositV3Now(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 fillDeadlineOffset, uint32 exclusivityParameter, bytes message) payable",
]);

export const raceCrossAbi = parseAbi([
  "function sellAndSendHome(address coin, uint256 coinsIn, uint256 minUsdcOut, uint256 relayFee, uint256 deadline) returns (uint256 usdcOut)",
  "function sendHome(uint256 amount, uint256 relayFee)",
  "function gasFor(address user, uint256 asked, uint256 amount) view returns (uint256)",
  "function maxGasUsd() view returns (uint256)",
  "function usdcDecimals() view returns (uint8)",
  "function homeDecimals() view returns (uint8)",
  "error FeeTooHigh()",
  "error NotSpokePool()",
  "error BadSignature()",
  "error TooLate()",
  "error AlreadyLaunched()",
  "error NotEnough()",
]);

/** Base: where sasa accounts keep their dollars (the race chain whose network fee is paid in USDC). */
export function homeChain(): RaceChain | null {
  return RACE_CHAINS.find((c) => !!usdcGasChain(c.chainId) && !!c.spoke) ?? null;
}

/** True when a sasa account can trade on `c` with its Base dollars. */
export function crossReady(c: RaceChain): boolean {
  const home = homeChain();
  return !!home && c.chainId !== home.chainId && !!c.cross;
}

/** `amount` with `from` decimals expressed with `to` decimals (rounded down), as the contracts do. */
export function convertDecimals(amount: bigint, from: number, to: number): bigint {
  if (from === to) return amount;
  if (from > to) return amount / 10n ** BigInt(from - to);
  return amount * 10n ** BigInt(to - from);
}

const decimalsCache = new Map<string, number>();
export async function usdDecimals(c: RaceChain): Promise<number> {
  const k = `${c.chainId}`;
  const hit = decimalsCache.get(k);
  if (hit !== undefined) return hit;
  const d = Number(await raceClient(c).readContract({ address: c.usd, abi: raceErc20Abi, functionName: "decimals" }));
  decimalsCache.set(k, d);
  return d;
}

// ------------------------------------------------------------------ Across quote

export type AcrossQuote = {
  /** What the relayer keeps, in the INPUT token's units. */
  fee: bigint;
  timestamp: number;
  fillDeadline: number;
  exclusiveRelayer: Address;
  exclusivityDeadline: number;
  spoke: Address;
  tooLow: boolean;
  /** Most that can be sent in one deposit right now (input units), if Across says. */
  maxDeposit: bigint | null;
  expectedSeconds: number | null;
  /** What Across says arrives (OUTPUT token units), when it says; a deposit never asks for more. */
  outputAmount: bigint | null;
};

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

async function acrossGet(path: string, signal?: AbortSignal): Promise<unknown> {
  let last: unknown = null;
  for (const host of ACROSS_API) {
    try {
      const r = await fetch(`${host}${path}`, { signal });
      const body = await r.json().catch(() => null);
      if (r.ok && body) return body;
      last = new Error((body as { message?: string } | null)?.message ?? `Across answered ${r.status}`);
      // a clear "no" (bad amount, route closed) won't change on the other host
      if (r.status === 400) break;
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      last = e;
    }
  }
  throw last ?? new Error("Couldn't reach Across. Try again in a moment.");
}

/** Across's fee for moving `amount` (`from`'s dollar units) to `recipient` on `to` with `message`. */
export async function acrossQuote(
  q: { from: RaceChain; to: RaceChain; amount: bigint; recipient: Address; message?: Hex; inputToken?: Address; outputToken?: Address },
  signal?: AbortSignal
): Promise<AcrossQuote> {
  const p = new URLSearchParams({
    inputToken: q.inputToken ?? q.from.usd,
    outputToken: q.outputToken ?? q.to.usd,
    originChainId: String(q.from.chainId),
    destinationChainId: String(q.to.chainId),
    amount: q.amount.toString(),
    recipient: q.recipient,
    // USDC has 18 decimals on BNB Chain and 6 elsewhere: Across refuses such a route unless told it's meant
    allowUnmatchedDecimals: "true",
  });
  if (q.message && q.message !== "0x") p.set("message", q.message);
  const r = (await acrossGet(`/suggested-fees?${p.toString()}`, signal)) as Record<string, unknown>;
  const total = (r.totalRelayFee as { total?: string } | undefined)?.total;
  if (total === undefined) throw new Error("Across didn't give a price. Try again in a moment.");
  const limits = (r.limits ?? {}) as { maxDeposit?: string };
  // money is only ever approved to the SpokePool configured here, never to one named by the answer
  const known = q.from.spoke;
  const named = (r.spokePoolAddress as string | undefined) ?? known;
  if (!known || !named || named.toLowerCase() !== known.toLowerCase()) throw new Error("Across's answer didn't match. Try again in a moment.");
  return {
    fee: BigInt(total),
    timestamp: Number(r.timestamp),
    fillDeadline: Number(r.fillDeadline ?? 0),
    exclusiveRelayer: ((r.exclusiveRelayer as string) || ZERO) as Address,
    exclusivityDeadline: Number(r.exclusivityDeadline ?? 0),
    spoke: known,
    tooLow: !!r.isAmountTooLow,
    maxDeposit: limits.maxDeposit ? BigInt(limits.maxDeposit) : null,
    expectedSeconds: r.expectedFillTimeSec === undefined ? null : Number(r.expectedFillTimeSec),
    outputAmount: typeof r.outputAmount === "string" && /^\d+$/.test(r.outputAmount) ? BigInt(r.outputAmount) : null,
  };
}

export type DepositState = "pending" | "filled" | "refunded" | "unknown";

/** Where a deposit stands, by its transaction on the origin chain. */
export async function depositState(originChainId: number, txHash: Hex, signal?: AbortSignal): Promise<DepositState> {
  try {
    const r = (await acrossGet(`/deposit/status?originChainId=${originChainId}&depositTxnRef=${txHash}`, signal)) as { status?: string };
    const s = String(r.status ?? "").toLowerCase();
    if (s === "filled") return "filled";
    // "expired": not delivered, the refund hasn't been paid yet; it still counts as on its way
    if (s === "refunded") return "refunded";
    if (s) return "pending";
    return "unknown";
  } catch {
    return "unknown";
  }
}

// ------------------------------------------------------------------ messages (RaceCross)

const ORDER = {
  type: "tuple",
  components: [
    { name: "user", type: "address" },
    { name: "coin", type: "address" },
    { name: "minCoinsOut", type: "uint256" },
    { name: "gasUsd", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const LAUNCH = {
  type: "tuple",
  components: [
    { name: "name", type: "string" },
    { name: "symbol", type: "string" },
    { name: "logo", type: "string" },
    { name: "description", type: "string" },
    { name: "launchKey", type: "bytes32" },
    { name: "eids", type: "uint32[]" },
    { name: "feeMode", type: "uint8" },
    { name: "firstBuy", type: "uint256" },
    { name: "minCoinsOut", type: "uint256" },
  ],
} as const;

const LAUNCH_ORDER = {
  type: "tuple",
  components: [
    { name: "user", type: "address" },
    { name: "launch", ...LAUNCH },
    { name: "gasUsd", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "signature", type: "bytes" },
  ],
} as const;

export type LaunchParams = {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  launchKey: Hex;
  eids: number[];
  feeMode: number;
  firstBuy: bigint;
  minCoinsOut: bigint;
};

/** The Across message for a buy: `abi.encode(uint8(0), abi.encode(Order))`. */
export function buyMessage(o: { user: Address; coin: Address; minCoinsOut: bigint; gasUsd: bigint; deadline: bigint }): Hex {
  const body = encodeAbiParameters([ORDER], [o]);
  return encodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], [0, body]);
}

/** keccak256(abi.encode(launch)): what the user's signature covers. */
export function launchHash(l: LaunchParams): Hex {
  return keccak256(encodeAbiParameters([LAUNCH], [l]));
}

/** The EIP-712 request the user signs so `cross` (on `chainId`) may launch for them. */
export function launchTypedData(chainId: number, cross: Address, user: Address, l: LaunchParams, gasUsd: bigint, deadline: bigint) {
  return {
    domain: { name: "sasa RaceCross", version: "1", chainId, verifyingContract: cross },
    types: {
      LaunchAuth: [
        { name: "user", type: "address" },
        { name: "launch", type: "bytes32" },
        { name: "gasUsd", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "LaunchAuth" as const,
    message: { user, launch: launchHash(l), gasUsd, deadline },
  };
}

/** The Across message for a launch: `abi.encode(uint8(1), abi.encode(LaunchOrder))`. */
export function launchMessage(o: { user: Address; launch: LaunchParams; gasUsd: bigint; deadline: bigint; signature: Hex }): Hex {
  const body = encodeAbiParameters([LAUNCH_ORDER], [o]);
  return encodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], [1, body]);
}

export async function signLaunch(signer: LocalAccount, c: RaceChain, l: LaunchParams, gasUsd: bigint, deadline: bigint): Promise<Hex> {
  if (!c.cross) throw new Error(`${c.short} isn't open to sasa accounts yet.`);
  return signer.signTypedData(launchTypedData(c.chainId, c.cross, signer.address, l, gasUsd, deadline));
}

// ------------------------------------------------------------------ exact buy estimate

/**
 * Where the dollar token keeps balances and allowances (storage slots of its mappings), found
 * once per chain by asking the node with a made-up value in each candidate slot. Lets the site
 * dry-run a buy for a user who has no dollars on that chain yet. null: not a plain layout.
 */
/** `bal` "native": the token's balance IS the account's native balance (Arc's USDC, 18 decimals there). */
type Slots = { bal: number | "native"; allow: number; nativeScale: bigint };
const slotCache = new Map<number, Promise<Slots | null>>();
const PROBE_SLOTS = 60;
const PROBE = "0x00000000000000000000000000000000005a5a5a" as Address;
const PROBE_SPENDER = "0x00000000000000000000000000000000005b5b5b" as Address;
const MAGIC = 123_456_789n;
const mapKey = (key: Address, slot: bigint | Hex) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: typeof slot === "bigint" ? "uint256" : "bytes32" }], [key, slot as never]));

function tokenSlots(c: RaceChain) {
  let p = slotCache.get(c.chainId);
  if (!p) {
    p = (async () => {
      const pub = raceClient(c);
      const read = async (data: Hex, slot: Hex) => {
        const r = await pub.call({ to: c.usd, data, stateOverride: [{ address: c.usd, stateDiff: [{ slot, value: pad(toHex(MAGIC)) }] }] }).catch(() => ({ data: undefined }));
        return r.data ? BigInt(r.data) : 0n;
      };
      const balData = encodeFunctionData({ abi: raceErc20Abi, functionName: "balanceOf", args: [PROBE] });
      const allowData = encodeFunctionData({ abi: raceErc20Abi, functionName: "allowance", args: [PROBE, PROBE_SPENDER] });
      const first = async (probe: (i: number) => Promise<boolean>) => {
        for (let i = 0; i < PROBE_SLOTS; i += 10) {
          const hits = await Promise.all(Array.from({ length: 10 }, (_, k) => probe(i + k)));
          const at = hits.indexOf(true);
          if (at >= 0) return i + at;
        }
        return -1;
      };
      let bal: number | "native" = await first(async (i) => (await read(balData, mapKey(PROBE, BigInt(i)))) === MAGIC);
      let nativeScale = 1n;
      if (bal < 0) {
        // a token backed by the native balance: give the account native money instead
        const dec = Number(await pub.readContract({ address: c.usd, abi: raceErc20Abi, functionName: "decimals" }));
        nativeScale = 10n ** BigInt(Math.max(0, c.chain.nativeCurrency.decimals - dec));
        const r = await pub.call({ to: c.usd, data: balData, stateOverride: [{ address: PROBE, balance: MAGIC * nativeScale }] }).catch(() => ({ data: undefined }));
        if (r.data && BigInt(r.data) === MAGIC) bal = "native";
      }
      const allow = await first(async (i) => (await read(allowData, mapKey(PROBE_SPENDER, mapKey(PROBE, BigInt(i))))) === MAGIC);
      return bal !== -1 && allow >= 0 ? { bal, allow, nativeScale } : null;
    })().catch(() => null);
    slotCache.set(c.chainId, p);
  }
  return p;
}

/**
 * Coins a buy of `usdIn` (this chain's dollar units) would give right now: a dry run of the
 * real router buy, as if `user` already had the dollars. null if the node can't do that.
 */
export async function quoteBuyCoins(c: RaceChain, user: Address, coin: Address, usdIn: bigint): Promise<bigint | null> {
  try {
    const slots = await tokenSlots(c);
    if (!slots) return null;
    const v = pad(toHex(usdIn));
    const r = await raceClient(c).call({
      account: user,
      to: c.router,
      data: encodeFunctionData({ abi: raceRouterAbi, functionName: "buy", args: [coin, usdIn, 0n, user, BigInt(Math.floor(Date.now() / 1000) + 600)] }),
      stateOverride: [
        {
          address: c.usd,
          stateDiff: [
            ...(slots.bal === "native" ? [] : [{ slot: mapKey(user, BigInt(slots.bal)), value: v }]),
            { slot: mapKey(c.router, mapKey(user, BigInt(slots.allow))), value: v },
          ],
        },
        ...(slots.bal === "native" ? [{ address: user, balance: usdIn * slots.nativeScale + 10n ** 18n }] : []),
      ],
    });
    if (!r.data) return null;
    return decodeFunctionResult({ abi: raceRouterAbi, functionName: "buy", data: r.data }) as bigint;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ building the Base transaction

/** Gas top-up we ask for with a buy or launch (the contract gives it only if the user is low). */
export const GAS_ASK_CENTS = 30;

/** How much of `amountDest` (destination units) RaceCross would turn into gas for `user` now. */
export async function gasTopUp(c: RaceChain, user: Address, amountDest: bigint): Promise<bigint> {
  if (!c.cross) return 0n;
  const dec = await usdDecimals(c);
  const ask = (BigInt(GAS_ASK_CENTS) * 10n ** BigInt(dec)) / 100n;
  return (await raceClient(c).readContract({ address: c.cross, abi: raceCrossAbi, functionName: "gasFor", args: [user, ask, amountDest] })) as bigint;
}

export type CrossDeposit = {
  calls: Call[];
  /** What reaches RaceCross on the destination chain (its units). */
  outputAmount: bigint;
  /** Across's fee, in Base dollars. */
  feeHome: bigint;
  /** Latest time the delivery can land if the deposit is mined right now (it counts from the block). */
  fillDeadline: number;
};

/** How long a delivery may take, counted from the block the deposit lands in. */
export const FILL_WINDOW_S = 15 * 60;

/**
 * The Base calls that send `inputAmount` (Base units) from `user` to RaceCross on `to` with
 * `message`: approve Across's SpokePool, then deposit. `user` is the depositor, so anything
 * Across can't deliver comes back to the user on Base.
 *
 * The deposit's fill deadline counts from the block it lands in (depositV3Now), so a bundle
 * that waits a while before it's mined still gets its full window. No exclusive relayer: the
 * first relayer there (sasa's own included) delivers it at once.
 */
export function depositCalls(
  home: RaceChain,
  to: RaceChain,
  user: Address,
  inputAmount: bigint,
  homeDec: number,
  toDec: number,
  quote: AcrossQuote,
  message: Hex,
  windowS: number = FILL_WINDOW_S
): CrossDeposit {
  if (!to.cross) throw new Error(`${to.short} isn't open to sasa accounts yet.`);
  if (quote.fee >= inputAmount) throw new Error("That amount is too small to send across. Try a bigger one.");
  let outputAmount = convertDecimals(inputAmount - quote.fee, homeDec, toDec);
  // never ask the relayers for more than Across itself says arrives (it can differ across decimals)
  if (quote.outputAmount !== null && outputAmount > quote.outputAmount) outputAmount = quote.outputAmount;
  // never longer than the window Across itself suggests (the SpokePool caps it)
  const suggested = quote.fillDeadline > quote.timestamp && quote.timestamp > 0 ? quote.fillDeadline - quote.timestamp : 0;
  const offset = Math.max(60, suggested > 0 ? Math.min(windowS, suggested) : windowS);
  return {
    calls: [
      call(home.usd, raceErc20Abi, "approve", [quote.spoke, inputAmount]),
      call(quote.spoke, spokeAbi, "depositV3Now", [
        user,
        to.cross,
        home.usd,
        to.usd,
        inputAmount,
        outputAmount,
        BigInt(to.chainId),
        ZERO,
        offset,
        0,
        message,
      ]),
    ],
    outputAmount,
    feeHome: quote.fee,
    fillDeadline: Math.floor(Date.now() / 1000) + offset,
  };
}

// ------------------------------------------------------------------ money on its way (this browser)

/** Dollars or coins on their way through Across: shown until they land (or come back). */
export type Pending = {
  id: string;
  kind: "buy" | "home" | "launch";
  /** The deposit's origin chain and transaction. */
  originChainId: number;
  tx: Hex;
  /** Dollars (shown to the user). */
  usd: number;
  chainId: number; // the chain it's going to
  coin?: Address;
  symbol?: string;
  at: number;
};

const PENDING_KEY = "sasa-cross-pending";
const PENDING_MAX_MS = 6 * 3600e3; // Across returns an undelivered deposit within hours
type Listener = () => void;
const listeners = new Set<Listener>();
let pendingCache: Pending[] | null = null;

function readPending(): Pending[] {
  if (pendingCache) return pendingCache;
  try {
    const all = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "[]") as Pending[];
    pendingCache = Array.isArray(all) ? all.filter((p) => Date.now() - p.at < PENDING_MAX_MS) : [];
  } catch {
    pendingCache = [];
  }
  return pendingCache;
}
function writePending(list: Pending[]) {
  pendingCache = list;
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {}
  listeners.forEach((l) => l());
}

export const pendingList = (): Pending[] => readPending();
export function addPending(p: Omit<Pending, "id" | "at">) {
  writePending([...readPending(), { ...p, id: `${p.originChainId}:${p.tx}:${p.chainId}`, at: Date.now() }]);
}
export function removePending(id: string) {
  writePending(readPending().filter((p) => p.id !== id));
}
export function onPending(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Dollars on their way back to Base (sells and sends home). */
export const returningUsd = (list: Pending[] = readPending()) => list.filter((p) => p.kind === "home").reduce((s, p) => s + p.usd, 0);

let watching = false;
/** Asks Across now and then where each pending deposit is, and drops the ones that landed. */
export function watchPending() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  const tick = async () => {
    const list = readPending();
    for (const p of list) {
      const s = await depositState(p.originChainId, p.tx);
      if (s === "filled" || s === "refunded") removePending(p.id);
    }
    // the list may have expired entries from an old visit
    if (list.length !== readPending().length || list.some((p) => Date.now() - p.at >= PENDING_MAX_MS)) {
      writePending(readPending().filter((p) => Date.now() - p.at < PENDING_MAX_MS));
    }
    setTimeout(() => void tick(), readPending().length ? 5_000 : 30_000);
  };
  void tick();
}

/** Every chain other than Base where a sasa account can trade with its Base dollars. */
export const crossChains = () => RACE_CHAINS.filter(crossReady);
