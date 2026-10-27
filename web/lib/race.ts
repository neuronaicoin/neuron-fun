import { createPublicClient, defineChain, fallback, http, parseAbi, type Address, type Chain, type PublicClient } from "viem";
import { ALCHEMY_KEY, CHAINS, IS_TESTNET } from "./config";
import { db } from "./data";
import V8 from "./race-v8.json";

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
  /** Across's SpokePool here (mainnet): sasa accounts move dollars between Base and the other chains. */
  spoke?: Address;
  /** RaceCross here (mainnet, not on Base): sasa accounts buy, sell and launch with their Base dollars. */
  cross?: Address;
  /** AutoOrders here (mainnet): take profit, stop loss and buy the dip, run by sasa's keeper. */
  auto?: Address;
  /**
   * The contract set the coin belongs to: 7 (the first mainnet contracts) or 8 (v8: the money
   * from the losing chains buys the coin on the winner and lands as full-range liquidity).
   * Every coin keeps trading through its own set; new launches use the newest.
   */
  stack: number;
  /** sasa's RaceBuilder and fee vault here (mainnet; the admin panel collects fees with them). */
  builder?: Address;
  feeVault?: Address;
};

/** One chain's v8 contracts (from contracts-v7/deployments/race-mainnet-v8/<chainId>.json). */
type V8Entry = {
  chainId: number;
  factory: string;
  router: string;
  builder: string;
  hook: string;
  consolidator: string;
  bridge: string;
  feeVault: string;
  cross?: string;
  autoOrders?: string;
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
    stack: 7,
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
    stack: 7,
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
    stack: 7,
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
    stack: 7,
  },
];

const baseMain = defineChain({
  id: 8453,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"] } },
  blockExplorers: { default: { name: "Basescan", url: "https://basescan.org" } },
});
const bscMain = defineChain({
  id: 56,
  name: "BNB Chain",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: { default: { http: ["https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.bnbchain.org", "https://bsc-rpc.publicnode.com", "https://bsc.drpc.org"] } },
  blockExplorers: { default: { name: "BscScan", url: "https://bscscan.com" } },
});
const robinhoodMain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});
const arcMain = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io", "https://rpc.drpc.mainnet.arc.io", "https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.quicknode.mainnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
});

// Addresses from contracts-v7/deployments/race-mainnet/*.json (mainnet, deployed Oct 17 2026).
const MAINNET: RaceChain[] = [
  {
    chainId: 8453,
    eid: 30184,
    key: "base",
    name: "Base",
    short: "Base",
    color: "#2f6bff",
    chain: baseMain,
    factory: "0x88e21D24C35034f80E854efBD5ACD16507a9169B",
    router: "0xc8c1C173a1d3057619fCf45941c41f02B9E7E5dD",
    usd: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    system: [
      "0x498581fF718922c3f8e6A244956aF099B2652b2b", // PoolManager
      "0x05aFA6adFcd1c40CF82174025ecBC2E1ED603Ca4", // builder
      "0xFD619EeF0dB5E653c2a43C236032895633E4A080", // hook
      "0xd4D6F84658C98F6BAd57f9E46B3FB69717675FBA", // consolidator
      "0xf11CB4abe59DFEDF361D4a9927711718dd8DaaB1", // bridge
      "0x230f730aa453397530833d8101aD6f7a07e0950a", // fee vault
    ],
    faucet: false,
    stack: 7,
    builder: "0x05aFA6adFcd1c40CF82174025ecBC2E1ED603Ca4",
    feeVault: "0x230f730aa453397530833d8101aD6f7a07e0950a",
    spoke: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
    auto: "0x3126001B205427D9C0AF14086f8Ed8295f25f1fA",
  },
  {
    chainId: 56,
    eid: 30102,
    key: "bnb",
    name: "BNB Chain",
    short: "BNB",
    color: "#f0b90b",
    chain: bscMain,
    factory: "0x88e21D24C35034f80E854efBD5ACD16507a9169B",
    router: "0xc8c1C173a1d3057619fCf45941c41f02B9E7E5dD",
    usd: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    system: [
      "0x238a358808379702088667322f80aC48bAd5e6c4", // Vault
      "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b", // CLPoolManager
      "0x05aFA6adFcd1c40CF82174025ecBC2E1ED603Ca4", // builder
      "0x6e4Dd763fa80469a69CAd1D8427Dea958FF7b30A", // hook
      "0xd4D6F84658C98F6BAd57f9E46B3FB69717675FBA", // consolidator
      "0xf11CB4abe59DFEDF361D4a9927711718dd8DaaB1", // bridge
      "0x230f730aa453397530833d8101aD6f7a07e0950a", // fee vault
    ],
    faucet: false,
    stack: 7,
    builder: "0x05aFA6adFcd1c40CF82174025ecBC2E1ED603Ca4",
    feeVault: "0x230f730aa453397530833d8101aD6f7a07e0950a",
    spoke: "0x4e8E101924eDE233C13e2D8622DC8aED2872d505",
    cross: "0x3126001B205427D9C0AF14086f8Ed8295f25f1fA",
    auto: "0x3a4e70eAD25135a439cbefF3972AbEC9EA1Df1C6",
  },
  {
    chainId: 4663,
    eid: 30416,
    key: "robinhood",
    name: "Robinhood Chain",
    short: "Robinhood",
    color: "#1fd15a",
    chain: robinhoodMain,
    factory: "0x88e21D24C35034f80E854efBD5ACD16507a9169B",
    router: "0xc8c1C173a1d3057619fCf45941c41f02B9E7E5dD",
    usd: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    system: [
      "0x8366a39CC670B4001A1121B8F6A443A643e40951", // PoolManager
      "0x05aFA6adFcd1c40CF82174025ecBC2E1ED603Ca4", // builder
      "0x3B0A89f5d19189077a24320a3939bf3308bAE080", // hook
      "0xd4D6F84658C98F6BAd57f9E46B3FB69717675FBA", // consolidator
      "0xf11CB4abe59DFEDF361D4a9927711718dd8DaaB1", // bridge
      "0x230f730aa453397530833d8101aD6f7a07e0950a", // fee vault
    ],
    faucet: false,
    stack: 7,
    builder: "0x05aFA6adFcd1c40CF82174025ecBC2E1ED603Ca4",
    feeVault: "0x230f730aa453397530833d8101aD6f7a07e0950a",
    spoke: "0xD29C85F15DF544bA632C9E25829fd29d767d7978",
    cross: "0x3126001B205427D9C0AF14086f8Ed8295f25f1fA",
    auto: "0x3a4e70eAD25135a439cbefF3972AbEC9EA1Df1C6",
  },
  {
    chainId: 5042,
    eid: 30417,
    key: "arc",
    name: "Arc",
    short: "Arc",
    color: "#19b3e6",
    chain: arcMain,
    factory: "0x88e21D24C35034f80E854efBD5ACD16507a9169B",
    router: "0xc8c1C173a1d3057619fCf45941c41f02B9E7E5dD",
    usd: "0x3600000000000000000000000000000000000000",
    system: [
      "0x8366a39CC670B4001A1121B8F6A443A643e40951", // PoolManager
      "0x05aFA6adFcd1c40CF82174025ecBC2E1ED603Ca4", // builder
      "0x3B0A89f5d19189077a24320a3939bf3308bAE080", // hook
      "0xd4D6F84658C98F6BAd57f9E46B3FB69717675FBA", // consolidator
      "0xf11CB4abe59DFEDF361D4a9927711718dd8DaaB1", // bridge
      "0x230f730aa453397530833d8101aD6f7a07e0950a", // fee vault
    ],
    faucet: false,
    stack: 7,
    builder: "0x05aFA6adFcd1c40CF82174025ecBC2E1ED603Ca4",
    feeVault: "0x230f730aa453397530833d8101aD6f7a07e0950a",
    spoke: "0x9b4A302A548c7e313c2b74C461db7b84d3074A84",
    cross: "0x3126001B205427D9C0AF14086f8Ed8295f25f1fA",
    auto: "0x3a4e70eAD25135a439cbefF3972AbEC9EA1Df1C6",
  },
];

const ZERO = "0x0000000000000000000000000000000000000000";
const addr = (v?: string) => (v && v !== ZERO ? (v as Address) : undefined);

/** v8 on mainnet once it is deployed on all four chains (race-v8.json filled), else nothing. */
function v8Chains(): RaceChain[] {
  const rows = V8 as V8Entry[];
  if (IS_TESTNET || rows.length < MAINNET.length) return [];
  return MAINNET.map((c) => {
    const d = rows.find((x) => Number(x.chainId) === c.chainId);
    if (!d) throw new Error(`race-v8.json: no chain ${c.chainId}`);
    const old = new Set([...MAINNET_SYSTEM_OLD].map((a) => a.toLowerCase()));
    return {
      ...c,
      stack: 8,
      factory: d.factory as Address,
      router: d.router as Address,
      // the chain's own pool contracts stay; sasa's v7 contracts are swapped for v8's
      system: [...c.system.filter((a) => !old.has(a.toLowerCase())), d.builder, d.hook, d.consolidator, d.bridge, d.feeVault].map((a) => a as Address),
      cross: c.cross ? addr(d.cross) : undefined,
      auto: c.auto ? addr(d.autoOrders) : undefined,
      builder: d.builder as Address,
      feeVault: d.feeVault as Address,
    };
  });
}
/** sasa's own v7 contracts in MAINNET's `system` lists (builder, hooks, consolidator, bridge, fee vault). */
const MAINNET_SYSTEM_OLD = [
  "0x05aFA6adFcd1c40CF82174025ecBC2E1ED603Ca4",
  "0xFD619EeF0dB5E653c2a43C236032895633E4A080",
  "0x6e4Dd763fa80469a69CAd1D8427Dea958FF7b30A",
  "0x3B0A89f5d19189077a24320a3939bf3308bAE080",
  "0xd4D6F84658C98F6BAd57f9E46B3FB69717675FBA",
  "0xf11CB4abe59DFEDF361D4a9927711718dd8DaaB1",
  "0x230f730aa453397530833d8101aD6f7a07e0950a",
];

const MAINNET_V8 = v8Chains();
/** Every contract set this site knows, newest first. */
export const RACE_SETS: RaceChain[][] = IS_TESTNET ? [TESTNET] : MAINNET_V8.length ? [MAINNET_V8, MAINNET] : [MAINNET];
/** The newest set: new launches, and everything that isn't about one coin (chains, gas, balances). */
export const RACE_CHAINS: RaceChain[] = RACE_SETS[0];
/** A chain in a coin's own contract set (`stack`); the newest set when none is given. */
export const raceChain = (chainId: number, stack?: number) =>
  (stack === undefined ? RACE_CHAINS : (RACE_SETS.find((s) => s[0]?.stack === stack) ?? RACE_CHAINS)).find((c) => c.chainId === chainId);
export const raceChainByEid = (eid: number) => RACE_CHAINS.find((c) => c.eid === eid);
/** The chains of a coin's contract set. */
export const raceChainsOf = (stack: number) => RACE_SETS.find((s) => s[0]?.stack === stack) ?? RACE_CHAINS;
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
  "function raceFee() view returns (uint256)",
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
  "function totalSupply() view returns (uint256)",
  "function faucet(address to)",
  "function lastFaucet(address) view returns (uint256)",
  "error TooSoon(uint256 next)",
]);

/** Every RPC the chain lists, the next one taking over when one fails or is slow (public nodes come and go). */
export function chainTransport(chain: Chain) {
  const urls = chain.rpcUrls.default.http;
  const pub = urls.length ? urls.map((u) => http(u, { timeout: 10_000, retryCount: 1 })) : [http()];
  // sasa's Alchemy node first where it runs (fast, never a block behind like public nodes),
  // the chain's public nodes only if it can't be reached
  const net = ALCHEMY_KEY ? CHAINS.find((c) => c.chain.id === chain.id)?.alchemyNetwork : undefined;
  return fallback(net ? [http(`https://${net}.g.alchemy.com/v2/${ALCHEMY_KEY}`, { timeout: 8_000, retryCount: 0 }), ...pub] : pub);
}

const clients = new Map<number, PublicClient>();
export function raceClient(c: RaceChain): PublicClient {
  let p = clients.get(c.chainId);
  if (!p) {
    p = createPublicClient({ chain: c.chain, transport: chainTransport(c.chain), pollingInterval: 1_000 }) as PublicClient;
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

/**
 * The call with a gas limit 30% above the node's estimate. A bare estimate is the exact
 * minimum; Uniswap's nested calls can then run out of gas on the way back (seen on BNB:
 * "not enough gas for reentrancy sentry"), so the trade would fail and still cost the fee.
 */
export async function withGas<T extends { to: Address; data: `0x${string}`; value?: bigint }>(pub: PublicClient, from: Address, c: T): Promise<T & { gas: bigint }> {
  // right after an approve, a public node can lag a block behind: ask again before giving up
  for (let i = 0; ; i++) {
    try {
      const est = await pub.estimateGas({ account: from, to: c.to, data: c.data, value: c.value ?? 0n });
      return { ...c, gas: (est * 13n) / 10n + 20_000n };
    } catch (e) {
      if (i >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
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
  /** Money from the losing chains added to this (the winner's) pool after the race. */
  mergedUsd: number;
};

export type RaceCoin = {
  id: string;
  /** The coin's contract set (7 or 8): its trades go through that set's routers. */
  stack: number;
  coin: Address;
  creator: Address;
  name: string;
  symbol: string;
  logo: string;
  description: string;
  feeMode: number;
  launchedAt: number; // ms
  endsAt: number; // ms
  /**
   * The winning chain. Known the moment every chain has reported its money at the end of the
   * five minutes (the same numbers and rule the hub on Base decides with), before LayerZero
   * has carried the official verdict; `confirmed` once that verdict is in.
   */
  winner: RaceChain | null;
  confirmed: boolean;
  totalUsd: number | null;
  decidedAt: number | null;
  lanes: RaceLane[];
};

/** Total supply of every race coin (1 billion, 18 decimals). */
export const RACE_SUPPLY = 1_000_000_000;

const ms = (v: unknown) => (v ? new Date(v as string).getTime() : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * The winner from the chains' own reports, as the hub works it out: the most money wins, a tie
 * goes to the lower LayerZero endpoint id. Null until every chain has reported.
 */
export function reportedWinner(lanes: RaceLane[]): RaceChain | null {
  if (!lanes.length || lanes.some((l) => l.reportedUsd === null)) return null;
  const best = lanes.reduce((a, b) => {
    const x = a.reportedUsd ?? 0;
    const y = b.reportedUsd ?? 0;
    return y > x || (y === x && b.chain.eid < a.chain.eid) ? b : a;
  });
  return (best.reportedUsd ?? 0) > 0 ? best.chain : null;
}

function toCoin(r: Record<string, unknown>): RaceCoin {
  const stack = Number(r.stack ?? 7);
  const set = raceChainsOf(stack);
  const lanes = ((r.race_chains as Record<string, unknown>[]) ?? [])
    .map((l): RaceLane | null => {
      const chain = raceChain(Number(l.chain_id), stack);
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
        mergedUsd: Number(l.merged_usd ?? 0),
      };
    })
    .filter((l): l is RaceLane => l !== null)
    .sort((a, b) => set.indexOf(a.chain) - set.indexOf(b.chain));
  return {
    id: r.id as string,
    stack,
    coin: r.coin as Address,
    creator: r.creator as Address,
    name: (r.name as string) ?? "",
    symbol: (r.symbol as string) ?? "",
    logo: (r.logo as string) ?? "",
    description: (r.description as string) ?? "",
    feeMode: Number(r.fee_mode ?? 0),
    launchedAt: ms(r.launched_at) ?? 0,
    endsAt: ms(r.ends_at) ?? 0,
    winner: (r.winner_chain ? raceChain(Number(r.winner_chain), stack) : null) ?? reportedWinner(lanes),
    confirmed: !!r.winner_chain && !!raceChain(Number(r.winner_chain), stack),
    totalUsd: num(r.total_usd),
    decidedAt: ms(r.decided_at),
    lanes,
  };
}

const COIN_COLS =
  "id,coin,creator,name,symbol,logo,description,fee_mode,launched_at,ends_at,winner_chain,total_usd,decided_at,stack," +
  "race_chains(chain_id,state,launched_at,ends_at,pool_usd,reported_usd,price_usd,buys,sells,volume_usd,handed_over,merged_usd)";

export async function fetchRaceCoin(id: string): Promise<RaceCoin | null> {
  const { data, error } = await db.from("race_coins").select(COIN_COLS).eq("id", id.toLowerCase()).maybeSingle();
  if (error) throw error;
  return data ? toCoin(data as unknown as Record<string, unknown>) : null;
}

/** Races still running or decided in the last `recentMinutes`, newest first. */
export async function fetchRaceCoins(limit = 12, opts: { only?: "racing" | "winners"; search?: string; creator?: string } = {}): Promise<RaceCoin[]> {
  // only coins raced on this site's chains (testnet and mainnet races share the database)
  const cols = COIN_COLS.replace("race_chains(", "race_chains!inner(");
  let q = db.from("race_coins").select(cols).in("race_chains.chain_id", RACE_CHAINS.map((c) => c.chainId));
  // racing now: not decided, and not stuck (a race whose result never came in an hour after its end)
  if (opts.only === "racing") q = q.is("decided_at", null).is("winner_chain", null).gt("ends_at", new Date(Date.now() - STUCK_MS).toISOString());
  if (opts.only === "winners") q = q.not("winner_chain", "is", null);
  if (opts.creator) q = q.eq("creator", opts.creator.toLowerCase());
  const term = (opts.search ?? "").trim().replace(/[%_,()*]/g, "");
  if (term) q = q.or(`name.ilike.%${term}%,symbol.ilike.%${term}%`);
  const { data, error } = await q.order(opts.only === "winners" ? "decided_at" : "launched_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toCoin).filter((c) => c.lanes.length > 0);
}

/** A race coin someone holds: coins per chain, valued at each chain's last price. */
export type RacePosition = { coin: RaceCoin; tokens: number; valueUsd: number; chains: { chain: RaceChain; tokens: number }[] };

/** Every race coin `address` holds on this site's chains (from the indexer's balances). */
export async function fetchRacePositions(address: string): Promise<RacePosition[]> {
  if (!RACE_CHAINS.length) return [];
  const { data: bals, error } = await db
    .from("balances")
    .select("chain_id,token,amount")
    .eq("holder", address.toLowerCase())
    .in("chain_id", RACE_CHAINS.map((c) => c.chainId))
    .gt("amount", 0);
  if (error) throw error;
  const rows = (bals ?? []) as { chain_id: number; token: string; amount: string | number }[];
  if (!rows.length) return [];
  const tokens = [...new Set(rows.map((r) => r.token.toLowerCase()))];
  const { data, error: e2 } = await db.from("race_coins").select(COIN_COLS).in("coin", tokens);
  if (e2) throw e2;
  const coins = ((data ?? []) as unknown as Record<string, unknown>[]).map(toCoin);
  return coins
    .map((coin): RacePosition => {
      const chains = rows
        .filter((r) => r.token.toLowerCase() === coin.coin.toLowerCase())
        .map((r) => ({ chain: raceChain(Number(r.chain_id), coin.stack), tokens: Number(r.amount) / 1e18 }))
        .filter((x): x is { chain: RaceChain; tokens: number } => !!x.chain && x.tokens > 0);
      const valueUsd = chains.reduce((sum, x) => {
        const lane = coin.lanes.find((l) => l.chain.chainId === x.chain.chainId);
        // a lost chain's coins move to the winner: value them at the winner's price
        const price = lane && lane.state !== 3 ? lane.priceUsd : leadLane(coin)?.priceUsd;
        return sum + x.tokens * (price ?? 0);
      }, 0);
      return { coin, tokens: chains.reduce((a, x) => a + x.tokens, 0), valueUsd, chains };
    })
    .filter((p) => p.tokens > 0)
    .sort((a, b) => b.valueUsd - a.valueUsd);
}

/**
 * The same positions, with the coins' balances read straight from the chains instead of the
 * indexer. Used for a couple of minutes after a trade, when the indexer can be seconds behind:
 * a sold coin drops out of the total at once and a bought one shows up at once. `extra`: coins
 * just traded that may not be in the list yet. A chain that can't be read keeps its old number.
 */
export async function verifyRacePositions(address: string, positions: RacePosition[], extra: RaceCoin[] = []): Promise<RacePosition[]> {
  const me = address as Address;
  const byCoin = new Map<string, RaceCoin>();
  for (const p of positions) byCoin.set(p.coin.coin.toLowerCase(), p.coin);
  for (const c of extra) if (!byCoin.has(c.coin.toLowerCase())) byCoin.set(c.coin.toLowerCase(), c);
  const out = await Promise.all(
    [...byCoin.values()].map(async (coin): Promise<RacePosition> => {
      const old = positions.find((p) => p.coin.coin.toLowerCase() === coin.coin.toLowerCase());
      const chains = (
        await Promise.all(
          coin.lanes.map(async (lane) => {
            const before = old?.chains.find((x) => x.chain.chainId === lane.chain.chainId)?.tokens ?? 0;
            try {
              const wei = (await raceClient(lane.chain).readContract({ address: coin.coin, abi: raceErc20Abi, functionName: "balanceOf", args: [me] })) as bigint;
              return { chain: lane.chain, tokens: Number(wei) / 1e18 };
            } catch {
              return { chain: lane.chain, tokens: before };
            }
          })
        )
      ).filter((x) => x.tokens > 0);
      const valueUsd = chains.reduce((sum, x) => {
        const lane = coin.lanes.find((l) => l.chain.chainId === x.chain.chainId);
        const price = lane && lane.state !== 3 ? lane.priceUsd : leadLane(coin)?.priceUsd;
        return sum + x.tokens * (price ?? 0);
      }, 0);
      return { coin, tokens: chains.reduce((a, x) => a + x.tokens, 0), valueUsd, chains };
    })
  );
  return out.filter((p) => p.tokens > 0).sort((a, b) => b.valueUsd - a.valueUsd);
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

/**
 * Coins that exist on one chain now. Each chain's market cap is its price times this (what
 * DexScreener shows too): a race coin is not 1B everywhere, and after the race the losing
 * chains' coins are burned, so the winner holds less than 1B. Cached a minute; 1B if unreadable.
 */
const SUPPLY = new Map<string, { at: number; v: number }>();
export async function chainSupply(chain: RaceChain, coin: string): Promise<number> {
  const k = `${chain.chainId}:${coin.toLowerCase()}`;
  const hit = SUPPLY.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  try {
    const raw = (await raceClient(chain).readContract({ address: coin as Address, abi: raceErc20Abi, functionName: "totalSupply" })) as bigint;
    const v = Number(raw) / 1e18;
    if (v > 0 && v <= RACE_SUPPLY * 1.001) {
      SUPPLY.set(k, { at: Date.now(), v });
      return v;
    }
  } catch {}
  return hit?.v ?? RACE_SUPPLY;
}

/** The chain a race coin's price (and market cap) comes from: the winner, or the leading chain. */
export function priceChain(c: RaceCoin): RaceChain | null {
  return c.winner ?? leadLane(c)?.chain ?? null;
}

/** Market-cap supply of a race coin: the coins on its price chain. */
export function coinSupply(c: RaceCoin): Promise<number> {
  const ch = priceChain(c);
  return ch ? chainSupply(ch, c.coin) : Promise.resolve(RACE_SUPPLY);
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
  const supply = await chainSupply(chain, coin);
  return ((data ?? []) as Record<string, unknown>[])
    .filter((r) => !skip.has((r.holder as string).toLowerCase()))
    .slice(0, limit)
    .map((r) => {
      const amount = Number(r.amount) / 1e18;
      return { holder: r.holder as string, amount, share: amount / supply };
    });
}

// ------------------------------------------------------------------ helpers

/** Where the race stands right now. */
export type RacePhase = "racing" | "deciding" | "decided" | "open";
/** No chain reported this long after the end: a race from the old settings, which keeps trading on every chain. */
export const DECIDE_MS = 10 * 60_000;
/** An hour after its end with no result: the race is stuck, so lists stop showing it as live. */
export const STUCK_MS = 3600_000;
export const raceStuck = (c: RaceCoin, now: number) => !c.winner && !c.decidedAt && c.endsAt > 0 && now > c.endsAt + STUCK_MS;

export function racePhase(c: RaceCoin, now: number): RacePhase {
  if (c.winner || c.decidedAt) return "decided";
  if (now < c.endsAt) return "racing";
  // the chains report within seconds of the end; races launched before Oct 18 2026 never do (old
  // LayerZero settings) and trade on every chain
  const anyReport = c.lanes.some((l) => l.reportedUsd !== null);
  return !anyReport && now > c.endsAt + DECIDE_MS ? "open" : "deciding";
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

// ------------------------------------------------------------------ stats (race.sql: race_stats)

export type RaceStatCoin = { id: string; name: string; symbol: string; logo: string; usd?: number; traders?: number; chain: RaceChain | null };
export type RaceStats = {
  league: { chain: RaceChain; races: number; wins: number; volume: number; traders: number }[];
  recent: { races: number; volume: number; trades: number; traders: number; newTraders: number };
  all: { races: number; decided: number; volume: number; trades: number; traders: number };
  biggestRace: RaceStatCoin | null;
  biggestBuy: RaceStatCoin | null;
  mostTraders: RaceStatCoin | null;
};

function statCoin(r: Record<string, unknown> | null | undefined): RaceStatCoin | null {
  if (!r) return null;
  return {
    id: r.id as string,
    name: (r.name as string) ?? "",
    symbol: (r.symbol as string) ?? "",
    logo: (r.logo as string) ?? "",
    usd: r.usd === undefined || r.usd === null ? undefined : Number(r.usd),
    traders: r.traders === undefined ? undefined : Number(r.traders),
    chain: r.chain_id ? (raceChain(Number(r.chain_id)) ?? null) : null,
  };
}

/** Everything the Stats page shows about races; "recent" is the last 24 hours. */
export async function fetchRaceStats(): Promise<RaceStats> {
  const { data, error } = await db.rpc("race_stats", { p_since: new Date(Date.now() - 24 * 3600e3).toISOString() });
  if (error) throw error;
  const d = (data ?? {}) as Record<string, Record<string, unknown> | Record<string, unknown>[] | null>;
  const rec = (d.recent ?? {}) as Record<string, unknown>;
  const all = (d.all ?? {}) as Record<string, unknown>;
  const league = ((d.league ?? []) as Record<string, unknown>[])
    .map((l) => {
      const chain = raceChain(Number(l.chain_id));
      return chain ? { chain, races: Number(l.races), wins: Number(l.wins), volume: Number(l.volume), traders: Number(l.traders) } : null;
    })
    .filter((l): l is RaceStats["league"][number] => l !== null);
  // chains with no race yet still get a row, so the league always shows every chain
  for (const c of RACE_CHAINS) if (!league.some((l) => l.chain.chainId === c.chainId)) league.push({ chain: c, races: 0, wins: 0, volume: 0, traders: 0 });
  return {
    league,
    recent: { races: Number(rec.races ?? 0), volume: Number(rec.volume ?? 0), trades: Number(rec.trades ?? 0), traders: Number(rec.traders ?? 0), newTraders: Number(rec.new_traders ?? 0) },
    all: { races: Number(all.races ?? 0), decided: Number(all.decided ?? 0), volume: Number(all.volume ?? 0), trades: Number(all.trades ?? 0), traders: Number(all.traders ?? 0) },
    biggestRace: statCoin(d.biggest_race as Record<string, unknown> | null),
    biggestBuy: statCoin(d.biggest_buy as Record<string, unknown> | null),
    mostTraders: statCoin(d.most_traders as Record<string, unknown> | null),
  };
}

/** Every buy and sell of a race coin in order (for the race replay); hand-over moves left out. */
export async function fetchRaceFlow(coinId: string, limit = 5000): Promise<{ chainId: number; ts: number; usd: number }[]> {
  const { data, error } = await db
    .from("race_trades")
    .select("chain_id,ts,is_buy,usd_amount,via")
    .eq("coin_id", coinId.toLowerCase())
    .neq("via", "system")
    .order("ts", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    chainId: Number(r.chain_id),
    ts: new Date(r.ts as string).getTime(),
    usd: (r.is_buy ? 1 : -1) * Number(r.usd_amount || 0),
  }));
}
