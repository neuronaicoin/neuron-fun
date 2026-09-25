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
    factory: "0xd72eF7A8134407b4ebC8d764f431457439bC901a",
    startBlock: 123588465n,
    priceSymbol: "ETH",
  },
  {
    key: "base",
    name: "Base",
    short: "Base",
    color: "#3B6FF5",
    chain: baseSepolia,
    factory: "0x00cB1E0bC065C821481411a95c0A2e1afA432919",
    startBlock: 47265800n,
    priceSymbol: "ETH",
  },
];

export const chainById = (id: number) => CHAINS.find((c) => c.chain.id === id);
export const explorerAddress = (c: NeuronChain, a: string) => `${c.chain.blockExplorers!.default.url}/address/${a}`;
export const explorerTx = (c: NeuronChain, h: string) => `${c.chain.blockExplorers!.default.url}/tx/${h}`;
