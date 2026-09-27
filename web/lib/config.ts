import { defineChain, type Address, type Chain } from "viem";

export const IS_TESTNET = true;

/** Public, read-only database (Supabase). The key is the public "publishable" key. */
export const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
export const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";

/** WalletConnect (Reown) project id: public by design. */
export const WALLETCONNECT_PROJECT_ID = "d5a8ab4f1bb470db701a5396d283b28a";

/** Dollar total, across all chains, at which a coin graduates. Must match the keeper. */
export const TARGET_USD = 5;

/** Slippage tolerated on buys and sells, in basis points. */
export const SLIPPAGE_BPS = 500n;

export type NeuronChain = {
  key: string;
  name: string;
  short: string;
  color: string;
  chain: Chain;
  factory: Address;
  startBlock: bigint;
  /** Price symbol of the gas coin (for dollar totals). */
  priceSymbol: "ETH" | "BNB" | "USD";
  /** Uniswap v4 PoolManager: holds graduated liquidity, so it is not a "holder". */
  poolManager: Address;
  /** Router for trading graduated coins in their locked pools. */
  router: Address;
  /** Holds graduated liquidity; collects pool fees and runs pool buybacks. */
  migrator: Address;
  /** Alchemy gas policy that pays network fees for email-login users. */
  gasPolicy: string;
  /** Alchemy network slug for fast reads (e.g. "robinhood-testnet"). */
  alchemyNetwork: string;
  /** Where to get free test coins (testnets only). */
  faucet?: string;
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

export const CHAINS: NeuronChain[] = [
  {
    key: "robinhood",
    name: "Robinhood Chain",
    short: "Robinhood",
    color: "#12B886",
    chain: robinhoodTestnet,
    factory: "0x4c4C12f8f4151c18AAcE0208D4F60AF813266991",
    startBlock: 123588465n,
    priceSymbol: "ETH",
    poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    router: "0x324F309542bfDF1058a0B4880Cb9C0FD932020CD",
    migrator: "0x2da5FC41bb0b0a2fbfB2F43073394cD66DB6e29D",
    gasPolicy: "6d52f227-a36c-4671-bca1-3b088153a180",
    alchemyNetwork: "robinhood-testnet",
    faucet: "https://faucet.testnet.chain.robinhood.com",
  },
  {
    key: "base",
    name: "Base",
    short: "Base",
    color: "#3B6FF5",
    chain: baseSepolia,
    factory: "0x9C93b18cA739844B53AF59E0d2E9E4B6CF84D165",
    startBlock: 47265800n,
    priceSymbol: "ETH",
    poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
    router: "0x46947120FCc8D804C1188814A1BE9178A06DA6b9",
    migrator: "0xFeFC59c4CE3Df167bb1CEa6739501d7240FF5383",
    gasPolicy: "4832ceec-26ce-4fc0-bd12-76f8b9bb99fe",
    alchemyNetwork: "base-sepolia",
    faucet: "https://www.alchemy.com/faucets/base-sepolia",
  },
];

export const chainById = (id: number) => CHAINS.find((c) => c.chain.id === id);
export const explorerAddress = (c: NeuronChain, a: string) => `${c.chain.blockExplorers!.default.url}/address/${a}`;
export const explorerTx = (c: NeuronChain, h: string) => `${c.chain.blockExplorers!.default.url}/tx/${h}`;

/** Email / Google login (Privy). Public id; safe in the page. */
export const PRIVY_APP_ID = "cmujtak3700dc0ejx5f6jbnca";
/** Alchemy key for gasless transactions. Public by design; locked to our domains in the Alchemy dashboard. */
export const ALCHEMY_KEY = "alch_8v9VILwONIJvenP--84Pt";
