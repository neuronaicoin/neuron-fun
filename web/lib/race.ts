import { createPublicClient, defineChain, fallback, http, parseAbi, type Address, type Chain, type PublicClient } from "viem";
import { IS_TESTNET } from "./config";
import { db } from "./data";

/**
 * sasa v7: the five-minute race. A coin starts on every chain at once; after five minutes the
 * chain with the most money wins, the others close and their holders move to the winner.
 * Data comes from the race indexer (indexer/race.sql); trades go through each chain's
 * RaceTrade router, always in dollars (USDC in, USDC out).
 */

export type RaceChain = {
  chainId: number;
  eid: number;
  key: string;
  name: string;
  short: string;
  color: string;
  chain: Chain;
  /** RaceFactory: launches the coin on this chain (same address on every chain). */
  factory: Address;
  /** Where to get this chain's gas coin on testnet. */
  gasFaucet?: string;
  /** RaceTradeEth / RaceTradePcs / UsdPoolRouter: buy(coin, usdIn, minOut, to, deadline) */
  router: Address;
  /** The dollar the coin trades in on this chain (USDC; a test dollar on testnets). */
  usd: Address;
  /** Addresses that hold coins for the pool, not for a person (left out of "holders"). */
  system: Address[];
  /** Testnets: the dollar has a faucet ($100 a day). */
  faucet: boolean;
};

const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com/rpc"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});
const baseSepolia = defineChain({
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.base.org"] } },
  blockExplorers: { default: { name: "Basescan", url: "https://sepolia.basescan.org" } },
  testnet: true,
});
const bscTestnet = defineChain({
  id: 97,
  name: "BNB Chain Testnet",
  nativeCurrency: { name: "BNB", symbol: "tBNB", decimals: 18 },
  rpcUrls: { default: { http: ["https://bsc-testnet-rpc.publicnode.com"] } },
  blockExplorers: { default: { name: "BscScan", url: "https://testnet.bscscan.com" } },
  testnet: true,
});
const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

// Addresses from contracts-v7/deployments/race/*.json (testnet, Oct 2026).
const TESTNET: RaceChain[] = [
  {
    chainId: 84532,
    eid: 40245,
    key: "base",
    name: "Base",
    short: "Base",
    color: "#2f6bff",
    chain: baseSepolia,
    factory: "0x12D1f65b5d4c11d8059Cc6739aC3cC321Eb42a9D",
    gasFaucet: "https://www.alchemy.com/faucets/base-sepolia",
    router: "0x940a770eb4e1B8BE83749695666B8c635A37D89C",
    usd: "0xc3C80f46cD6911A2082B8744E92a69664f4F3560",
    system: [
      "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408", // PoolManager
      "0x2D1C8FEF53a6B11db0abcCcE41BD5e61168E0418", // builder
      "0xF73975138a88aFB342aa64c91838143d66c5A080", // hook
      "0x678834e649CfBaEf8FE45ED5EAaDDCB4f0071e7E", // consolidator
      "0x2F461B25c64077d9B355d2A738008B6cAEd04535", // bridge
    ],
    faucet: true,
  },
  {
    chainId: 97,
    eid: 40102,
    key: "bnb",
    name: "BNB Chain",
    short: "BNB",
    color: "#f0b90b",
    chain: bscTestnet,
    factory: "0x12D1f65b5d4c11d8059Cc6739aC3cC321Eb42a9D",
    gasFaucet: "https://www.bnbchain.org/en/testnet-faucet",
    router: "0xfF8f34C09cd042A52275BE1B30Eb377b5370cAB6",
    usd: "0x00cB1E0bC065C821481411a95c0A2e1afA432919",
    system: [
      "0x2CdB3EC82EE13d341Dc6E73637BE0Eab79cb79dD", // Vault
      "0x36A12c70c9Cf64f24E89ee132BF93Df2DCD199d4", // CLPoolManager
      "0x58068303Ca51EbB8FC25B594361186a52D6071E5", // builder
      "0x987B5B7997A379384b15c1C41a39f5b627Ad39a4", // hook
      "0x35e9d234A721Ea33ea36dB51d4E54d9171d9c499", // consolidator
      "0x44dd76F2eAfd6708c63DB93c03804F4f15017dFd", // bridge
    ],
    faucet: true,
  },
  {
    chainId: 46630,
    eid: 40451,
    key: "robinhood",
    name: "Robinhood Chain",
    short: "Robinhood",
    color: "#1fd15a",
    chain: robinhoodTestnet,
    factory: "0x12D1f65b5d4c11d8059Cc6739aC3cC321Eb42a9D",
    gasFaucet: "https://faucet.testnet.chain.robinhood.com",
    router: "0x1360d3E3e71C65ff9185afebBFe7c7e83D06c8B0",
    usd: "0x6B0d23F84666EA6C8b16789879CE1B6e090E66Da",
    system: [
      "0x8366a39CC670B4001A1121B8F6A443A643e40951", // PoolManager
      "0xEb9b5443c94BAEe122CA80CE439027FeB6b7F660", // builder
      "0x33014273d3aa66eF9255CEa5790d649B10096080", // hook
      "0x7FF10AD03daAD2262c55eB672B597F9666e5d6c5", // consolidator
      "0xeeB5d34936FD2FDd617D87b9Ddd50C93e0BAAa37", // bridge
    ],
    faucet: true,
  },
  {
    chainId: 5042002,
    eid: 40434,
    key: "arc",
    name: "Arc",
    short: "Arc",
    color: "#19b3e6",
    chain: arcTestnet,
    factory: "0x12D1f65b5d4c11d8059Cc6739aC3cC321Eb42a9D",
    gasFaucet: "https://faucet.circle.com",
    router: "0x1044fe554262C92F06D0838b5dE320e12e54ea5D",
    usd: "0x6c1d150124777243ce9A6eF5b4740a2E0aaF41E9",
    system: [
      "0x8366a39CC670B4001A1121B8F6A443A643e40951", // PoolManager
      "0x74aE321cD971f92E07CD734E4C9fA3643F60c28c", // builder
      "0xbbb9aa2d629fd3CE3faCeFeA2BD01A054d7ca080", // hook
      "0xfbc644749a2216248E64249420c71B32039ae469", // consolidator
      "0x2fBf535502Eaa2f39502a04ea26BfBfA7F7b9789", // bridge
    ],
    faucet: true,
  },
];

/** Mainnet: filled in from contracts-v7/deployments on deploy day. Empty = races hidden. */
const MAINNET: RaceChain[] = [];

export const RACE_CHAINS: RaceChain[] = IS_TESTNET ? TESTNET : MAINNET;
export const raceChain = (chainId: number) => RACE_CHAINS.find((c) => c.chainId === chainId);
export const raceChainByEid = (eid: number) => RACE_CHAINS.find((c) => c.eid === eid);
export const raceExplorerTx = (c: RaceChain, h: string) => `${c.chain.blockExplorers!.default.url}/tx/${h}`;
export const raceExplorerAddress = (c: RaceChain, a: string) => `${c.chain.blockExplorers!.default.url}/address/${a}`;

/** The race lasts five minutes on every chain. */
export const RACE_SECONDS = 300;

export const raceRouterAbi = parseAbi([
  "function buy(address coin, uint256 usdcIn, uint256 minCoinsOut, address to, uint256 deadline) returns (uint256 coinsOut)",
  "function sell(address coin, uint256 coinsIn, uint256 minUsdcOut, address to, uint256 deadline) returns (uint256 usdcOut)",
  "error Expired()",
  "error NothingToDo()",
  "error Busy()",
  "error Slippage(uint256 got, uint256 minimum)",
  "error RaceLostPoolShut()",
]);
export const raceFactoryAbi = parseAbi([
  "struct Launch { string name; string symbol; string logo; string description; bytes32 launchKey; uint32[] eids; uint8 feeMode; uint256 firstBuy; uint256 minCoinsOut; }",
  "function launch(Launch l) returns (address coin, address seat)",
  "function coinAddress(address creator, bytes32 launchKey) view returns (address)",
  "function coinIdOf(address creator, bytes32 launchKey) pure returns (bytes32)",
  "function minFirstBuy() view returns (uint256)",
  "function launchesOpen() view returns (bool)",
  "struct Route { address sendLib; address receiveLib; bytes executorConfig; bytes ulnConfig; }",
  "function routeOf(uint32 eid) view returns (Route)",
  "error LaunchesClosed()",
  "error BadChains()",
  "error NoRoute(uint32 eid)",
  "error FirstBuyTooSmall(uint256 minimum)",
  "error BadConfig()",
]);

export const raceErc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function faucet(address to)",
  "function lastFaucet(address) view returns (uint256)",
  "error TooSoon(uint256 next)",
]);

const clients = new Map<number, PublicClient>();
export function raceClient(c: RaceChain): PublicClient {
  let p = clients.get(c.chainId);
  if (!p) {
    p = createPublicClient({ chain: c.chain, transport: fallback([http()]), pollingInterval: 1_000 }) as PublicClient;
    clients.set(c.chainId, p);
  }
  return p;
}

/**
 * Which chains can race together. A coin can only race on chains whose factories are linked
 * by LayerZero both ways (on testnets some pairs have no LayerZero path, e.g. Robinhood ↔ Arc).
 * Returns, per chain id, the chain ids it is linked to (null = couldn't read that chain).
 */
export async function fetchRaceLinks(): Promise<Map<number, Set<number> | null>> {
  const out = new Map<number, Set<number> | null>();
  await Promise.all(
    RACE_CHAINS.map(async (c) => {
      try {
        const others = RACE_CHAINS.filter((o) => o.chainId !== c.chainId);
        const routes = await Promise.all(
          others.map((o) => raceClient(c).readContract({ address: c.factory, abi: raceFactoryAbi, functionName: "routeOf", args: [o.eid] }))
        );
        const set = new Set<number>();
        others.forEach((o, i) => {
          const r = routes[i] as { sendLib: string };
          if (r.sendLib && !/^0x0+$/.test(r.sendLib)) set.add(o.chainId);
        });
        out.set(c.chainId, set);
      } catch {
        out.set(c.chainId, null);
      }
    })
  );
  return out;
}

/** True when every pair of `ids` is linked both ways. */
export function chainsLinked(ids: number[], links: Map<number, Set<number> | null>): boolean {
  for (const a of ids)
    for (const b of ids) {
      if (a === b) continue;
      const s = links.get(a);
      if (!s || !s.has(b)) return false;
    }
  return true;
}

/** The biggest group of chains (in RACE_CHAINS order) that can all race together. */
export function bestLinkedGroup(links: Map<number, Set<number> | null>): number[] {
  const ids = RACE_CHAINS.map((c) => c.chainId);
  let best: number[] = [];
  for (let mask = 1; mask < 1 << ids.length; mask++) {
    const g = ids.filter((_, i) => mask & (1 << i));
    if (g.length > best.length && chainsLinked(g, links)) best = g;
  }
  return best;
}

// ------------------------------------------------------------------ data

/** 1 racing, 2 won, 3 lost (race_chains.state). */
export type RaceChainState = 1 | 2 | 3;

export type RaceLane = {
  chain: RaceChain;
  state: RaceChainState;
  launchedAt: number | null; // ms
  endsAt: number | null; // ms
  poolUsd: number;
  reportedUsd: number | null;
  priceUsd: number | null;
  buys: number;
  sells: number;
  volumeUsd: number;
  handedOver: boolean;
};

export type RaceCoin = {
  id: string;
  coin: Address;
  creator: Address;
  name: string;
  symbol: string;
  logo: string;
  description: string;
  feeMode: number;
  launchedAt: number; // ms
  endsAt: number; // ms
  winner: RaceChain | null;
  totalUsd: number | null;
  decidedAt: number | null;
  lanes: RaceLane[];
};

/** Total supply of every race coin (1 billion, 18 decimals). */
export const RACE_SUPPLY = 1_000_000_000;

const ms = (v: unknown) => (v ? new Date(v as string).getTime() : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toCoin(r: Record<string, unknown>): RaceCoin {
  const lanes = ((r.race_chains as Record<string, unknown>[]) ?? [])
    .map((l): RaceLane | null => {
      const chain = raceChain(Number(l.chain_id));
      if (!chain) return null;
      return {
        chain,
        state: Number(l.state) as RaceChainState,
        launchedAt: ms(l.launched_at),
        endsAt: ms(l.ends_at),
        poolUsd: Number(l.pool_usd ?? 0),
        reportedUsd: num(l.reported_usd),
        priceUsd: num(l.price_usd),
        buys: Number(l.buys ?? 0),
        sells: Number(l.sells ?? 0),
        volumeUsd: Number(l.volume_usd ?? 0),
        handedOver: !!l.handed_over,
      };
    })
    .filter((l): l is RaceLane => l !== null)
    .sort((a, b) => RACE_CHAINS.indexOf(a.chain) - RACE_CHAINS.indexOf(b.chain));
  return {
    id: r.id as string,
    coin: r.coin as Address,
    creator: r.creator as Address,
    name: (r.name as string) ?? "",
    symbol: (r.symbol as string) ?? "",
    logo: (r.logo as string) ?? "",
    description: (r.description as string) ?? "",
    feeMode: Number(r.fee_mode ?? 0),
    launchedAt: ms(r.launched_at) ?? 0,
    endsAt: ms(r.ends_at) ?? 0,
    winner: r.winner_chain ? (raceChain(Number(r.winner_chain)) ?? null) : null,
    totalUsd: num(r.total_usd),
    decidedAt: ms(r.decided_at),
    lanes,
  };
}

const COIN_COLS =
  "id,coin,creator,name,symbol,logo,description,fee_mode,launched_at,ends_at,winner_chain,total_usd,decided_at," +
  "race_chains(chain_id,state,launched_at,ends_at,pool_usd,reported_usd,price_usd,buys,sells,volume_usd,handed_over)";

export async function fetchRaceCoin(id: string): Promise<RaceCoin | null> {
  const { data, error } = await db.from("race_coins").select(COIN_COLS).eq("id", id.toLowerCase()).maybeSingle();
  if (error) throw error;
  return data ? toCoin(data as unknown as Record<string, unknown>) : null;
}

/** Races still running or decided in the last `recentMinutes`, newest first. */
export async function fetchRaceCoins(limit = 12): Promise<RaceCoin[]> {
  const { data, error } = await db.from("race_coins").select(COIN_COLS).order("launched_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toCoin);
}

export type RaceTrade = {
  chain: RaceChain;
  txHash: string;
  logIndex: number;
  ts: number;
  trader: string;
  isBuy: boolean;
  usd: number;
  tokens: number;
  priceUsd: number;
  via: string;
};

export async function fetchRaceTrades(coinId: string, limit = 40): Promise<RaceTrade[]> {
  const { data, error } = await db
    .from("race_trades")
    .select("chain_id,tx_hash,log_index,ts,trader,is_buy,usd_amount,token_amount,price_usd,via")
    .eq("coin_id", coinId.toLowerCase())
    .order("ts", { ascending: false })
    .order("log_index", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[])
    .map((r): RaceTrade | null => {
      const chain = raceChain(Number(r.chain_id));
      if (!chain) return null;
      return {
        chain,
        txHash: r.tx_hash as string,
        logIndex: Number(r.log_index),
        ts: new Date(r.ts as string).getTime(),
        trader: r.trader as string,
        isBuy: !!r.is_buy,
        usd: Number(r.usd_amount),
        tokens: Number(r.token_amount),
        priceUsd: Number(r.price_usd),
        via: r.via as string,
      };
    })
    .filter((t): t is RaceTrade => t !== null);
}

export type RaceCandle = { t: number; open: number; high: number; low: number; close: number; volume: number };

export async function fetchRaceCandles(coinId: string, chainId: number | null, bucketSeconds: number): Promise<RaceCandle[]> {
  const { data, error } = await db.rpc("race_candles", { p_coin_id: coinId.toLowerCase(), p_chain_id: chainId, p_bucket: bucketSeconds, p_limit: 500 });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[])
    .map((r) => ({
      t: Math.floor(new Date(r.t as string).getTime() / 1000),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }))
    .sort((a, b) => a.t - b.t);
}

export type RaceHolder = { holder: string; amount: number; share: number };

/** Biggest holders of the coin on one chain (pool and sasa contracts left out). */
export async function fetchRaceHolders(chain: RaceChain, coin: string, limit = 20): Promise<RaceHolder[]> {
  const skip = new Set(chain.system.map((a) => a.toLowerCase()));
  const { data, error } = await db
    .from("balances")
    .select("holder,amount")
    .eq("chain_id", chain.chainId)
    .eq("token", coin.toLowerCase())
    .gt("amount", 0)
    .order("amount", { ascending: false })
    .limit(limit + skip.size);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[])
    .filter((r) => !skip.has((r.holder as string).toLowerCase()))
    .slice(0, limit)
    .map((r) => {
      const amount = Number(r.amount) / 1e18;
      return { holder: r.holder as string, amount, share: amount / RACE_SUPPLY };
    });
}

// ------------------------------------------------------------------ helpers

/** Where the race stands right now. */
export type RacePhase = "racing" | "deciding" | "decided";
export function racePhase(c: RaceCoin, now: number): RacePhase {
  if (c.winner || c.decidedAt) return "decided";
  return now < c.endsAt ? "racing" : "deciding";
}

/** Lane money: the official report once it's in, the live pool before. */
export const laneUsd = (l: RaceLane) => l.reportedUsd ?? l.poolUsd;

/** The lane to show and trade by default: the winner, else the one with the most money. */
export function leadLane(c: RaceCoin): RaceLane | null {
  if (c.winner) return c.lanes.find((l) => l.chain.chainId === c.winner!.chainId) ?? null;
  const open = c.lanes.filter((l) => l.state !== 3);
  if (!open.length) return c.lanes[0] ?? null;
  return open.reduce((a, b) => (laneUsd(b) > laneUsd(a) ? b : a));
}

export const raceHref = (id: string) => `/r/?id=${id}`;

/** Price with enough digits for tiny meme prices: $0.00004213, $0.0123, $1.24. */
export function fmtPrice(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p) || p <= 0) return "—";
  if (p >= 1) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const digits = Math.min(12, Math.max(2, -Math.floor(Math.log10(p)) + 3));
  return `$${p.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/** mm:ss for the race clock. */
export function clock(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
