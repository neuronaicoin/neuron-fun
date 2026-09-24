import { defineChain } from "viem";

// Robinhood Chain testnet deployment of 24 Sep 2026.
export const chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com/rpc"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

export const IS_TESTNET = true;

export const ADDR = {
  factory: "0x58068303Ca51EbB8FC25B594361186a52D6071E5",
  router: "0xFeFC59c4CE3Df167bb1CEa6739501d7240FF5383",
  launcher: "0x4c283e95627FA53beD6bA03dA2d1C6866e14c9f1",
  registry: "0x1bB313B48a3931eB2Ed03AC2aAd48557ab9805c1",
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  neuron: "0xC348b269920e0c1f0a0838837D2474984439A4D9",
  dead: "0x000000000000000000000000000000000000dEaD",
} as const;

/** First block that can hold a Neuron.fun launch (the launcher's deployment). */
export const START_BLOCK = 123588465n;

/** Slippage tolerated on buys and sells, in basis points. */
export const SLIPPAGE_BPS = 500n;

export const explorerAddress = (a: string) => `${chain.blockExplorers.default.url}/address/${a}`;
export const explorerTx = (h: string) => `${chain.blockExplorers.default.url}/tx/${h}`;
