/**
 * The money view: total balance (header), cash, coin positions with profit
 * and loss, and which money sheet is open (portfolio, deposit, withdraw, sell).
 *
 * Everything is shown in dollars. Cash is the chain's gas coin today (ETH);
 * the USDC cash mode comes with mainnet.
 */
import { useSyncExternalStore } from "react";
import type { Address } from "viem";
import { CHAINS, USD_MODE, type NeuronChain } from "./config";
import { usdcAbi } from "./abis";
import { clientFor, fetchPortfolio, fetchTrades, nativePerToken, type Coin } from "./data";

/** What cash is held in: dollars (USDC; USDG on Robinhood mainnet) in the dollar edition. */
export const CASH_SYMBOL = USD_MODE ? "USDC" : "ETH";

export type Position = {
  coin: Coin;
  /** Tokens held, summed over chains. */
  tokens: number;
  valueUsd: number;
  /** What the tokens still held cost (average cost), in dollars at today's ETH price. */
  costUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  /** Market cap at the average buy price, in dollars (null if no buys found). */
  avgMcapUsd: number | null;
  /** 24h change of this position's value, in dollars. */
  dayUsd: number;
};

export type Portfolio = {
  totalUsd: number;
  cashUsd: number;
  cashByChain: { chain: NeuronChain; wei: bigint; usd: number }[];
  coinsUsd: number;
  openPnlUsd: number;
  realizedUsd: number;
  dayUsd: number;
  dayPct: number;
  positions: Position[];
  ethUsd: number | null;
};

export type MoneySheet = null | { kind: "portfolio" } | { kind: "deposit" } | { kind: "withdraw" } | { kind: "sell"; coin: Coin; pct: number };

type State = { address: string | null; portfolio: Portfolio | null; loading: boolean; sheet: MoneySheet; version: number };

let state: State = { address: null, portfolio: null, loading: false, sheet: null, version: 0 };
const SERVER = state;
const listeners = new Set<() => void>();
function set(p: Partial<State>) {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
export function useMoney(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => SERVER
  );
}

export function openMoney(sheet: MoneySheet) {
  set({ sheet });
  if (sheet && (sheet.kind === "portfolio" || sheet.kind === "deposit")) void refreshPortfolio();
}
export const closeMoney = () => {
  set({ sheet: null });
  void refreshPortfolio();
};

// ------------------------------------------------------------------ loading

let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

/** Called by <MoneyHost/> whenever the logged-in wallet changes. */
export function setMoneyAddress(address: string | null) {
  const a = address ? address.toLowerCase() : null;
  if (a === state.address) return;
  set({ address: a, portfolio: null, sheet: null });
  if (timer) clearInterval(timer);
  timer = null;
  if (a) {
    void refreshPortfolio();
    timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshPortfolio();
    }, 30_000);
  }
}

/**
 * Reloads cash and holdings. `fresh`: the caller just changed them (a trade), so
 * a load that started before must not count; run another one after it.
 */
export function refreshPortfolio(fresh = false): Promise<void> {
  const address = state.address;
  if (!address) return Promise.resolve();
  if (inflight) return fresh ? inflight.then(() => refreshPortfolio()) : inflight;
  set({ loading: true });
  inflight = loadPortfolio(address)
    .then((p) => {
      if (state.address === address) set({ portfolio: p, version: state.version + 1 });
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
      set({ loading: false });
    });
  return inflight;
}

/**
 * Reads only the cash balances (a couple of quick chain reads, no database) and
 * updates the shown cash and total. Used right after a trade, before the full
 * reload (holdings, P&L) arrives.
 */
export async function refreshCash(): Promise<void> {
  const address = state.address;
  const p = state.portfolio;
  if (!address || !p) return;
  try {
    const cash = await Promise.all(uniqueChains().map(async (c) => ({ chain: c, wei: await cashOf(c, address as Address) })));
    const cur = state.portfolio;
    if (!cur || state.address !== address) return;
    const cashByChain = cash.map(({ chain, wei }) => {
      const old = cur.cashByChain.find((x) => x.chain.chain.id === chain.chain.id);
      const perWei = old && old.wei > 0n ? old.usd / Number(old.wei) : USD_PER_WEI(chain, cur);
      return { chain, wei, usd: Number(wei) * perWei };
    });
    const cashUsd = cashByChain.reduce((a, c) => a + c.usd, 0);
    set({ portfolio: { ...cur, cashByChain, cashUsd, totalUsd: cur.coinsUsd + cashUsd }, version: state.version + 1 });
  } catch {
    /* the full reload will fix it */
  }
}

// USD value of one unit of a chain's cash (USDC has 6 decimals, ETH 18).
function USD_PER_WEI(_chain: NeuronChain, p: Portfolio): number {
  if (USD_MODE) return 1e-6;
  return (p.ethUsd ?? 0) / 1e18;
}

/**
 * Moves the shown cash (and total) by `deltaUsd` right away, before the chain
 * confirms. Returns an undo for when the trade fails. The next real load
 * replaces it either way.
 */
export function optimisticCash(deltaUsd: number): () => void {
  return optimisticTrade(deltaUsd, 0);
}

/**
 * Moves the header numbers the moment a trade is sent: cash by `cashUsd`, the coins'
 * value by `coinsUsd` (so a buy doesn't look like money vanished from the total).
 * Returns an undo for when the trade fails; a later refresh replaces both with chain data.
 */
export function optimisticTrade(cashUsd: number, coinsUsd: number): () => void {
  const p = state.portfolio;
  if (!p || !Number.isFinite(cashUsd) || !Number.isFinite(coinsUsd) || (cashUsd === 0 && coinsUsd === 0)) return () => {};
  const bump = (dc: number, dv: number) => {
    const cur = state.portfolio;
    if (!cur) return;
    const cash = Math.max(0, cur.cashUsd + dc);
    set({ portfolio: { ...cur, cashUsd: cash, totalUsd: Math.max(0, cur.totalUsd + (cash - cur.cashUsd) + dv) }, version: state.version + 1 });
  };
  bump(cashUsd, coinsUsd);
  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    bump(-cashUsd, -coinsUsd);
  };
}

function uniqueChains(): NeuronChain[] {
  const seen = new Set<number>();
  return CHAINS.filter((c) => !seen.has(c.chain.id) && seen.add(c.chain.id));
}

async function loadPortfolio(address: string): Promise<Portfolio> {
  const chains = uniqueChains();
  const [pf, cash, trades] = await Promise.all([
    fetchPortfolio(address),
    // Cash: USDC in the dollar edition (the chain's coin otherwise).
    Promise.all(chains.map(async (c) => ({ chain: c, wei: await cashOf(c, address as Address) }))),
    fetchTrades({ trader: address, limit: 1000 }).catch(() => []),
  ]);
  const prices = pf.prices ?? {};
  const ethUsd = prices.ETH ?? null;
  const px = (c: NeuronChain) => (c.priceSymbol === "USD" ? 1 : prices[c.priceSymbol] ?? 0);

  const cashByChain = cash.map(({ chain, wei }) => ({ chain, wei, usd: (Number(wei) / 1e18) * px(chain) }));
  const cashUsd = cashByChain.reduce((a, c) => a + c.usd, 0);

  // Buys and sells per coin, in native units (wei floats), for average cost.
  const flows = new Map<string, { spent: number; bought: number; got: number; sold: number }>();
  for (const t of trades) {
    const f = flows.get(t.coinId) ?? { spent: 0, bought: 0, got: 0, sold: 0 };
    if (t.isBuy) {
      f.spent += t.nativeAmount;
      f.bought += t.tokenAmount;
    } else {
      f.got += t.nativeAmount;
      f.sold += t.tokenAmount;
    }
    flows.set(t.coinId, f);
  }

  // Positions, summed over chains.
  const byCoin = new Map<string, { coin: Coin; tokens: number; valueUsd: number }>();
  for (const h of pf.holdings) {
    const p = px(h.curve.chain);
    const value = h.amount * nativePerToken(h.curve) * p;
    const cur = byCoin.get(h.coin.id) ?? { coin: h.coin, tokens: 0, valueUsd: 0 };
    cur.tokens += h.amount;
    cur.valueUsd += value;
    byCoin.set(h.coin.id, cur);
  }
  const unit = ethUsd ?? 0; // native amounts are ETH on our chains

  let realizedUsd = 0;
  for (const [, f] of flows) {
    if (f.bought > 0 && f.sold > 0) {
      const avg = f.spent / f.bought;
      realizedUsd += ((f.got - avg * f.sold) / 1e18) * unit;
    }
  }

  const positions: Position[] = [...byCoin.values()]
    .filter((p) => p.valueUsd >= 0.01 || p.tokens >= 1)
    .map(({ coin, tokens, valueUsd }) => {
      const f = flows.get(coin.id);
      const avgWeiPerToken = f && f.bought > 0 ? f.spent / f.bought : null; // wei per token-wei = ETH per token
      const costUsd = avgWeiPerToken !== null && unit ? avgWeiPerToken * tokens * unit : null;
      const pnlUsd = costUsd !== null ? valueUsd - costUsd : null;
      const ch = coin.change24h;
      return {
        coin,
        tokens,
        valueUsd,
        costUsd,
        pnlUsd,
        pnlPct: costUsd && costUsd > 0 && pnlUsd !== null ? pnlUsd / costUsd : null,
        avgMcapUsd: avgWeiPerToken !== null && unit ? avgWeiPerToken * 1e9 * unit : null,
        dayUsd: ch !== null && ch > -1 ? valueUsd - valueUsd / (1 + ch) : 0,
      };
    })
    .sort((a, b) => b.valueUsd - a.valueUsd);

  const coinsUsd = positions.reduce((a, p) => a + p.valueUsd, 0);
  const openPnlUsd = positions.reduce((a, p) => a + (p.pnlUsd ?? 0), 0);
  const dayUsd = positions.reduce((a, p) => a + p.dayUsd, 0);
  const totalUsd = cashUsd + coinsUsd;
  const start = totalUsd - dayUsd;
  return {
    totalUsd,
    cashUsd,
    cashByChain,
    coinsUsd,
    openPnlUsd,
    realizedUsd,
    dayUsd,
    dayPct: start > 0 ? dayUsd / start : 0,
    positions,
    ethUsd,
  };
}

// ------------------------------------------------------------------ formatting

export function money(v: number): string {
  const neg = v < 0;
  const a = Math.abs(v);
  const s =
    a >= 1e6
      ? `$${(a / 1e6).toFixed(2)}M`
      : `$${a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return neg ? `−${s}` : s;
}
export const signed = (v: number) => `${v >= 0 ? "+" : "−"}${money(Math.abs(v))}`;
export const pctText = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}%`;
export function tokensText(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(n < 10 ? 2 : 0);
}
export function capText(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(v < 10 ? 2 : 0)}`;
}

/** Spendable cash on one chain: its USDC (dollar edition), else its native coin. Raw units. */
export async function cashOf(c: NeuronChain, address: Address): Promise<bigint> {
  const pub = clientFor(c);
  if (USD_MODE) return (pub.readContract({ address: c.usdc, abi: usdcAbi, functionName: "balanceOf", args: [address] }) as Promise<bigint>).catch(() => 0n);
  return pub.getBalance({ address }).catch(() => 0n);
}
