import { defineChain, type Address, type Chain } from "viem";

export const IS_TESTNET = true;

/** Public, read-only database (Supabase). The key is the public "publishable" key. */
export const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
export const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";

/** WalletConnect (Reown) project id: public by design. */
export const WALLETCONNECT_PROJECT_ID = "d5a8ab4f1bb470db701a5396d283b28a";

/** Dollar total, across all chains, at which a coin graduates. Must match the keeper. */
// Dollar edition testnet: $20 across all chains (each chain needs at least $10 to be the winner).
export const TARGET_USD = 20;

/** Slippage tolerated on buys and sells, in basis points. */
export const SLIPPAGE_BPS = 500n;

export type NeuronChain = {
  key: string;
  name: string;
  short: string;
  color: string;
  chain: Chain;
  factory: Address;
  /** LayerZero endpoint id (v6 omnichain coins list the chains they launch on by eid). */
  eid: number;
  /**
   * Storage slots of the dollar token's balance and allowance mappings, used to simulate a
   * trade before the approve is sent. Testnet TestUsdOft (an OFT): 5 / 6. Mainnet must use
   * the real token's layout (Circle USDC: 9 / 10).
   */
  usdcSlots: { balance: number; allowance: number };
  startBlock: bigint;
  /** Price symbol of the gas coin (for dollar totals). */
  priceSymbol: "ETH" | "BNB" | "USD" | "USDC";
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
  /** Auto orders (take profit, stop loss, buy the dip) on this chain. */
  orders?: Address;
  /** The USDC every coin on this chain trades against (sasa v5; TestUSDC on testnets). */
  usdc: Address;
  /** Multisig that owns this chain's factory (mainnet). Empty on testnet. */
  safe?: Address;
  /**
   * Earlier contract sets on this chain. Their coins keep trading, so the
   * site finds each coin's own router and migrator (see lib/contracts.ts).
   * `factory`, `router` and `migrator` above are always the live set.
   */
  legacy?: ContractSet[];
};

export type ContractSet = { factory: Address; router: Address; migrator: Address };

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
    // v6, omnichain coins: one coin, the same address on every chain. Oct 1, 2026.
    // (v5 dollar edition was factory 0x443696e6…, router 0x0D60A942…, USDC 0x65DF225C….)
    factory: "0xE0cdEd0C777FA52Ffa1C2495d916DcdC9b2dbE1d",
    eid: 40451,
    startBlock: 127150000n,
    priceSymbol: "USDC",
    poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    router: "0x1bd54DB7E565DE3B76b4d74CdeF101d0D28e50C8",
    migrator: "0xC93e5764DE826fe3eA5B758342027fB309922B24",
    // Auto orders for v6 coins come in a later update.
    usdc: "0x3b4762Cd69CBC3e128781F44d6E6A1E882Dd5721",
    usdcSlots: { balance: 5, allowance: 6 },
    legacy: [],
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
    // v6, omnichain coins. Oct 1, 2026. (v5: factory 0x0e78b5a5…, router 0x5186Cd79…, USDC 0x679F33e6….)
    factory: "0xE0cdEd0C777FA52Ffa1C2495d916DcdC9b2dbE1d",
    eid: 40245,
    startBlock: 47550152n,
    priceSymbol: "USDC",
    poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
    router: "0x324F309542bfDF1058a0B4880Cb9C0FD932020CD",
    migrator: "0x1e98de896584aE8C7966314E6A82ec2c434BC18D",
    usdc: "0x57A149c274d5065279F7926EF3D6b00214A8A07F",
    usdcSlots: { balance: 5, allowance: 6 },
    legacy: [],
    gasPolicy: "4832ceec-26ce-4fc0-bd12-76f8b9bb99fe",
    alchemyNetwork: "base-sepolia",
    faucet: "https://www.alchemy.com/faucets/base-sepolia",
  },
];

/**
 * sasa v5: every chain's coins trade against USDC (6 decimals). Site-wide, the
 * "ethUsd" number that prices amounts means "dollars per 1e18 raw units of the
 * money coins trade against"; for USDC that is 1e12, so the existing
 * `amount / 1e18 * ethUsd` maths gives dollars unchanged.
 */
export const USD_MODE = true;

export const chainById = (id: number) => CHAINS.find((c) => c.chain.id === id);
export const explorerAddress = (c: NeuronChain, a: string) => `${c.chain.blockExplorers!.default.url}/address/${a}`;
export const explorerTx = (c: NeuronChain, h: string) => `${c.chain.blockExplorers!.default.url}/tx/${h}`;

/** Email / Google login (Privy). Public id; safe in the page. */
export const PRIVY_APP_ID = "cmujtak3700dc0ejx5f6jbnca";
/** Alchemy key for gasless transactions. Public by design; locked to our domains in the Alchemy dashboard. */
export const ALCHEMY_KEY = "alch_8v9VILwONIJvenP--84Pt";

/** Web push (price alerts). Public half of the VAPID key pair; the private half lives on Railway only. */
export const VAPID_PUBLIC_KEY = "BL0G7RxxAC6NJKoWlGEz2CpdhQYVlcqigiWxzu461f2ymQVeg0DRei5bkZwvMkAqZZYnvFKOIEcvRxe7A8QnDrg";

/** Storage slots of every v6 coin (LaunchCoin, an OFT): balances 5, allowances 6. */
export const COIN_SLOTS = { balance: 5, allowance: 6 } as const;
