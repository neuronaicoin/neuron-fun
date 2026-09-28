/**
 * Deposits and withdrawals across chains, powered by Relay (relay.link).
 *
 * The list of chains and tokens comes live from Relay, so the menus only
 * show routes that really work: on testnet that is Sepolia <-> Base Sepolia;
 * on mainnet Solana, Ethereum, Base, Arbitrum, BNB, Robinhood and more
 * appear on their own. sasa adds no fee of its own.
 */
import { IS_TESTNET } from "./config";

export const RELAY_API = IS_TESTNET ? "https://api.testnets.relay.link" : "https://api.relay.link";
export const NATIVE = "0x0000000000000000000000000000000000000000";
export const SOLANA_ID = 792703809;
const SOLANA_NATIVE = "11111111111111111111111111111111";

/** Chains we show, in this order, with our own names and colors. */
const KNOWN: Record<number, { name: string; color: string }> = {
  [SOLANA_ID]: { name: "Solana", color: "#8a5cf6" },
  1: { name: "Ethereum", color: "#627eea" },
  8453: { name: "Base", color: "#2563eb" },
  42161: { name: "Arbitrum", color: "#28a0f0" },
  56: { name: "BNB Chain", color: "#f0b90b" },
  10: { name: "Optimism", color: "#ff0420" },
  137: { name: "Polygon", color: "#8247e5" },
  4663: { name: "Robinhood Chain", color: "#12b886" },
  11155111: { name: "Sepolia", color: "#627eea" },
  84532: { name: "Base Sepolia", color: "#2563eb" },
};
const ORDER = Object.keys(KNOWN).map(Number);
/** Tokens people actually move, in this order. Others are left out to keep the menus short. */
const TOKENS = ["USDC", "USDT", "USDG", "ETH", "SOL", "BNB", "POL"];

export type RelayToken = { symbol: string; address: string; decimals: number };
export type RelayChain = { id: number; name: string; color: string; evm: boolean; tokens: RelayToken[]; native: RelayToken };

type RawCurrency = { symbol: string; address: string; decimals: number };
type RawChain = {
  id: number;
  vmType: string;
  disabled?: boolean;
  depositEnabled?: boolean;
  currency: RawCurrency;
  solverCurrencies?: RawCurrency[];
};

let chainsCache: Promise<RelayChain[]> | null = null;

/** Chains Relay supports right now, limited to the ones we know how to show. */
export function relayChains(): Promise<RelayChain[]> {
  if (!chainsCache) {
    chainsCache = fetch(`${RELAY_API}/chains`)
      .then((r) => {
        if (!r.ok) throw new Error("Couldn't load the list of chains. Try again in a moment.");
        return r.json() as Promise<{ chains: RawChain[] }>;
      })
      .then(({ chains }) =>
        chains
          .filter((c) => KNOWN[c.id] && !c.disabled && c.depositEnabled !== false && (c.vmType === "evm" || c.vmType === "svm"))
          .map((c) => {
            const native = { symbol: c.currency.symbol, address: c.currency.address, decimals: c.currency.decimals };
            const all = [native, ...(c.solverCurrencies ?? []).map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals }))];
            const seen = new Set<string>();
            const tokens = all
              .filter((t) => TOKENS.includes(t.symbol) && !seen.has(t.symbol) && seen.add(t.symbol))
              .sort((a, b) => TOKENS.indexOf(a.symbol) - TOKENS.indexOf(b.symbol));
            return { id: c.id, name: KNOWN[c.id].name, color: KNOWN[c.id].color, evm: c.vmType === "evm", tokens, native };
          })
          .filter((c) => c.tokens.length > 0)
          .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
      )
      .catch((e) => {
        chainsCache = null; // try again next time
        throw e;
      });
  }
  return chainsCache;
}

// ------------------------------------------------------------------ quotes

export type QuoteInput = {
  user: string;
  recipient: string;
  originChainId: number;
  originCurrency: string;
  destinationChainId: number;
  destinationCurrency: string;
  /** In the origin token's smallest unit. */
  amount: string;
  useDepositAddress?: boolean;
  refundTo?: string;
};

export type StepItem = {
  status: string;
  data: { from?: string; to: string; data: string; value?: string; chainId: number } & Record<string, unknown>;
  check?: { endpoint: string; method: string };
};
export type Step = { id: string; kind: "transaction" | "signature"; items: StepItem[]; requestId?: string; depositAddress?: string };

export type Quote = {
  steps: Step[];
  requestId: string | null;
  depositAddress: string | null;
  inUsd: number;
  outAmount: string;
  outUsd: number;
  outSymbol: string;
  /** Network, bridge and swap costs together, in dollars. */
  costUsd: number;
  seconds: number;
};

type RawQuote = {
  steps?: Step[];
  message?: string;
  details?: {
    currencyIn?: { amountUsd?: string };
    currencyOut?: { amountFormatted?: string; amountUsd?: string; currency?: { symbol?: string } };
    totalImpact?: { usd?: string };
    timeEstimate?: number;
  };
};

/** Turns Relay's error text into something a person can act on. */
function friendly(msg: string | undefined): string {
  const m = (msg || "").toLowerCase();
  if (m.includes("amount") && (m.includes("low") || m.includes("small") || m.includes("minimum"))) return "That amount is too small to move. Try a bit more.";
  if (m.includes("insufficient") || m.includes("balance")) return "You don't have enough for that.";
  if (m.includes("route") || m.includes("no quotes") || m.includes("unsupported")) return "This route isn't available right now. Try another token or chain.";
  if (m.includes("liquidity")) return "There isn't enough liquidity for that amount right now. Try a smaller amount.";
  return msg ? msg.replace(/\.$/, "") + "." : "Couldn't get a price. Try again in a moment.";
}

export async function getQuote(q: QuoteInput, signal?: AbortSignal): Promise<Quote> {
  const r = await fetch(`${RELAY_API}/quote/v2`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      ...q,
      tradeType: "EXACT_INPUT",
      referrer: "sasapad.fun",
    }),
  });
  const j = (await r.json().catch(() => ({}))) as RawQuote;
  if (!r.ok || !j.steps) throw new Error(friendly(j.message));
  const d = j.details ?? {};
  const first = j.steps.find((s) => s.requestId) ?? j.steps[0];
  const inUsd = Number(d.currencyIn?.amountUsd ?? 0);
  const outUsd = Number(d.currencyOut?.amountUsd ?? 0);
  const impact = Math.abs(Number(d.totalImpact?.usd ?? NaN));
  return {
    steps: j.steps,
    requestId: first?.requestId ?? null,
    depositAddress: j.steps.find((s) => s.depositAddress)?.depositAddress ?? null,
    inUsd,
    outAmount: d.currencyOut?.amountFormatted ?? "0",
    outUsd,
    outSymbol: d.currencyOut?.currency?.symbol ?? "",
    costUsd: Number.isFinite(impact) ? impact : Math.max(0, inUsd - outUsd),
    seconds: Number(d.timeEstimate ?? 0),
  };
}

/** Refund target for deposit addresses: the sender's own wallet. */
export function refundFor(origin: RelayChain, sasaAddress: string): string {
  // EVM: the sasa address is the same on every EVM chain, so refunds come home.
  // Solana: Relay's "send back to whoever deposited" setting.
  return origin.evm ? sasaAddress : SOLANA_NATIVE;
}

// ------------------------------------------------------------------ tracking

export type TrackState = "waiting" | "pending" | "success" | "failure" | "refund";

function normalise(s: string | undefined): TrackState {
  const v = (s || "").toLowerCase();
  if (v === "success") return "success";
  if (v === "failure" || v === "failed") return "failure";
  if (v === "refund" || v === "refunded") return "refund";
  if (v === "pending" || v === "submitted" || v === "delayed") return "pending";
  return "waiting";
}

export async function requestStatus(requestId: string): Promise<TrackState> {
  const r = await fetch(`${RELAY_API}/intents/status/v3?requestId=${encodeURIComponent(requestId)}`);
  const j = (await r.json().catch(() => ({}))) as { status?: string };
  return normalise(j.status);
}

/** Deposits made to a deposit address (newest first). */
export async function depositsTo(depositAddress: string): Promise<{ id: string; status: TrackState; outUsd: number; createdAt: string }[]> {
  const r = await fetch(`${RELAY_API}/requests/v3?depositAddress=${encodeURIComponent(depositAddress)}&sortBy=createdAt&sortDirection=desc&limit=5`);
  const j = (await r.json().catch(() => ({}))) as {
    requests?: { id: string; status: string; createdAt: string; data?: { route?: { actual?: { destination?: { outputCurrency?: { amountUsd?: string } } } } } }[];
  };
  return (j.requests ?? []).map((x) => ({
    id: x.id,
    status: normalise(x.status),
    outUsd: Number(x.data?.route?.actual?.destination?.outputCurrency?.amountUsd ?? 0),
    createdAt: x.createdAt,
  }));
}

// ------------------------------------------------------------------ addresses

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A real Solana address: base58 that decodes to exactly 32 bytes. */
export function isSolanaAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch));
  let bytes = 0;
  while (n > 0n) {
    n >>= 8n;
    bytes++;
  }
  let zeros = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    zeros++;
  }
  return bytes + zeros === 32;
}

export const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

/** Pulls an address out of a scanned QR code ("ethereum:0x…@8453?value=…", "solana:…", plain). */
export function addressFromQr(text: string): string {
  const t = text.trim();
  const m = /^(?:ethereum|solana|eth|sol):(?:pay-)?([^@?/]+)/i.exec(t);
  const core = (m ? m[1] : t).trim();
  if (isEvmAddress(core) || isSolanaAddress(core)) return core;
  const any = /(0x[0-9a-fA-F]{40})/.exec(t);
  return any ? any[1] : core;
}

// ------------------------------------------------------------------ amounts

/** "1.5" with 6 decimals -> "1500000". Returns null if not a positive number. */
export function toUnits(v: string, decimals: number): string | null {
  const s = v.trim().replace(/,/g, "");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  const units = BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return units > 0n ? units.toString() : null;
}

export function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `$${v < 1 ? v.toFixed(2) : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtAmount(v: string | number, symbol: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return `${v} ${symbol}`;
  const big = ["ETH", "SOL", "BNB", "WETH"].includes(symbol);
  return `${n.toLocaleString("en-US", { maximumFractionDigits: big ? 5 : 2 })} ${symbol}`;
}
