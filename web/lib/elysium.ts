/**
 * sasa on Elysium (Kinetiq's Hyperliquid L2, an Arbitrum Orbit chain; gas in HYPE).
 *
 * Coins launch through sasa's launcher contract (contracts-elysium/src/SasaV3Launcher.sol): one
 * transaction makes the coin, puts the whole supply into a locked coin/WHYPE Uniswap-v3-style pool
 * and makes the creator's first buy. Trades go through the DEX's swap router (wrap HYPE → WHYPE →
 * coin, and back). The pool fee (1%) is the trading fee: 70% sasa, 30% the creator.
 *
 * Mainnet switches on by itself: the "Deploy sasa launcher on Elysium" workflow (network: elysium)
 * writes lib/elysium-mainnet.json (chain, RPC, launcher, router, WHYPE, Day-1 Pass). Once it's
 * filled, the whole site uses Elysium mainnet and every TESTNET label goes away; until then it's
 * the public testnet.
 */
import { createPublicClient, defineChain, encodeFunctionData, getAddress, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import type { Call } from "./tx";
import { SOLANA_TEAM } from "./solana";
import MAINNET_FILL from "./elysium-mainnet.json";
/** The testnet is open to everyone (free practice with test HYPE) while mainnet waits. */
export const ELYSIUM_PUBLIC_TESTNET = true;

type ElysiumNet = {
  chain: ReturnType<typeof defineChain>;
  launcher: Address;
  router: Address;
  whype: Address;
  fee: number;
  explorer: string;
  testnet: boolean;
};

const testnetChain = defineChain({
  id: 99801,
  name: "Elysium Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.elysium.kinetiq.xyz"] } },
  blockExplorers: { default: { name: "Elysium explorer", url: "https://testnet.elysium.kinetiq.xyz" } },
  testnet: true,
});

export const ELYSIUM_TESTNET: ElysiumNet = {
  chain: testnetChain,
  launcher: "0x6c1d150124777243ce9A6eF5b4740a2E0aaF41E9",
  router: "0x64Dd48EbFc8D65F648C9780F2a396bBe9A2a77B1",
  whype: "0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234",
  fee: 10_000,
  explorer: "https://testnet.elysium.kinetiq.xyz",
  testnet: true,
};

type Fill = { chainId: number | null; rpc: string | null; explorer: string | null; launcher: string | null; router: string | null; whype: string | null; pass: string | null; start?: number | null; smoke?: string | null };
const fill = MAINNET_FILL as Fill;
const isAddr = (a: string | null): a is Address => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);

/** Elysium mainnet, from lib/elysium-mainnet.json (written by the deploy workflow on mainnet day). */
export const ELYSIUM_MAINNET: ElysiumNet | null =
  fill.chainId && fill.rpc && isAddr(fill.launcher) && isAddr(fill.router) && isAddr(fill.whype)
    ? {
        chain: defineChain({
          id: fill.chainId,
          name: "Elysium",
          nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
          rpcUrls: { default: { http: [fill.rpc] } },
          ...(fill.explorer ? { blockExplorers: { default: { name: "Elysium explorer", url: fill.explorer } } } : {}),
        }),
        launcher: getAddress(fill.launcher),
        router: getAddress(fill.router),
        whype: getAddress(fill.whype),
        fee: 10_000,
        explorer: fill.explorer ?? "",
        testnet: false,
      }
    : null;

/** Everyone sees Elysium: on by itself once mainnet is filled in. */
export const ELYSIUM_OPEN = !!ELYSIUM_MAINNET;

export const ELYSIUM: ElysiumNet = ELYSIUM_MAINNET ?? ELYSIUM_TESTNET;
/** Who can use sasa on Elysium: everyone on the public testnet or once mainnet opens, else sasa's team. */
export const elysiumFor = (address?: string | null) =>
  ELYSIUM_OPEN || (ELYSIUM.testnet && ELYSIUM_PUBLIC_TESTNET) || (!!address && SOLANA_TEAM.has(address.toLowerCase()));
/** Shown to everyone (menus, the chain list on Create a coin). */
export const ELYSIUM_LISTED = ELYSIUM_OPEN || (ELYSIUM.testnet && ELYSIUM_PUBLIC_TESTNET);
export const FAUCET_URL = "https://testnet.elysium.kinetiq.xyz/faucet";
/**
 * The sasa Day-1 Pass (contracts-elysium/src/SasaDayPass.sol): free NFT, one per wallet, 2x points
 * on Elysium. Filled in from contracts-elysium/deployments/pass-<chain>.json after the
 * "Deploy sasa Day-1 Pass" workflow; null = the page says it's coming.
 */
export const ELYSIUM_PASS: Address | null = ELYSIUM_MAINNET ? (isAddr(fill.pass) ? getAddress(fill.pass) : null) : "0x2fBf535502Eaa2f39502a04ea26BfBfA7F7b9789";
/**
 * The deploy workflow's own smoke-test coin ("sasa smoke test"): a check that the launcher works,
 * not a real coin. Left out of the coin list and of the Day-1 count.
 */
const HIDDEN = new Set(
  [ELYSIUM_MAINNET ? fill.smoke : "0x105A898B23cab7220936dba426C175231C85Ddfa"].filter((a): a is string => isAddr(a ?? null)).map((a) => a.toLowerCase())
);
export const elysiumHidden = (coin: string) => HIDDEN.has(coin.toLowerCase());

/** Mainnet's first week: 3x points on every launch and trade (indexer/elysiummain.mjs). */
export const BOOST_X = 3;
export const BOOST_DAYS = 7;
/** When the 3x week ends (ms), or null before mainnet. */
export const ELYSIUM_BOOST_END: number | null = ELYSIUM_MAINNET ? ((fill.start ?? 0) > 0 ? (fill.start! + BOOST_DAYS * 86_400) * 1000 : null) : null;
export const boostLive = () => ELYSIUM_BOOST_END !== null && Date.now() < ELYSIUM_BOOST_END;
/** The first this-many coins launched through sasa on Elysium mainnet carry the Day-1 badge for good. */
export const DAY1_COINS = 100;

export const passAbi = parseAbi([
  "function mint() returns (uint256)",
  "function minted(address) view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function mintOpen() view returns (bool)",
]);
export const ELYSIUM_NETWORK = "elysium";
export const elysiumHref = (coin: string) => `/x/?n=${ELYSIUM_NETWORK}&a=${coin}`;

let client: PublicClient | null = null;
export function elysiumClient(): PublicClient {
  if (!client) client = createPublicClient({ chain: ELYSIUM.chain, transport: http(undefined, { retryCount: 3, timeout: 10_000, batch: true }), pollingInterval: 300 }) as PublicClient;
  return client;
}

// ------------------------------------------------------------------ abis

export const launcherAbi = parseAbi([
  "function launch(string name, string symbol, string uri, address creator, uint256 minOut) payable returns (address coin, uint256 bought)",
  "function coins(address coin) view returns (uint256 tokenId, address pool, address creator, uint16 creatorBps, bool coinIsToken0)",
  "function coinCount() view returns (uint256)",
  "function allCoins(uint256) view returns (address)",
  "function launchFee() view returns (uint256)",
  "function startMc() view returns (uint256)",
  "function collect(address coin) returns (uint256, uint256)",
  "event Launched(address indexed coin, address indexed creator, address pool, uint256 tokenId, string name, string symbol, string uri, uint256 startMc, uint256 firstBuyIn, uint256 firstBuyOut)",
]);
const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function tokenURI() view returns (string)",
]);
const wrappedAbi = parseAbi(["function deposit() payable", "function withdraw(uint256)"]);
const poolAbi = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)", "function liquidity() view returns (uint128)"]);
const routerAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);

export const SUPPLY = 1_000_000_000n * 10n ** 18n;
const Q96 = 1n << 96n;

// ------------------------------------------------------------------ reads

export type ElysiumCoin = {
  address: Address;
  name: string;
  symbol: string;
  uri: string;
  image: string | null;
  description: string | null;
  creator: Address;
  pool: Address;
  coinIsToken0: boolean;
  /** HYPE per coin (float, for display). */
  priceHype: number;
  /** Market cap of the whole supply, in HYPE. */
  mcHype: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
};

const metaCache = new Map<string, Promise<{ image: string | null; description: string | null }>>();
function meta(uri: string) {
  let m = metaCache.get(uri);
  if (!m) {
    m = (uri.startsWith("https://sasapad.fun/") || uri.startsWith("/")
      ? fetch(uri)
          .then((r) => r.json() as Promise<{ image?: string; description?: string }>)
          .then((j) => ({ image: typeof j.image === "string" ? j.image : null, description: typeof j.description === "string" ? j.description : null }))
      : Promise.resolve({ image: null, description: null })
    ).catch(() => ({ image: null, description: null }));
    metaCache.set(uri, m);
  }
  return m;
}

/** HYPE per coin from the pool's sqrt price. */
function priceOf(sqrtPriceX96: bigint, coinIsToken0: boolean): number {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const p = s * s; // token1 per token0
  return coinIsToken0 ? p : p > 0 ? 1 / p : 0;
}

export async function fetchElysiumCoin(address: string): Promise<ElysiumCoin | null> {
  const c = elysiumClient();
  // one spelling everywhere (links from a launch's log are lowercase)
  let coin: Address;
  try {
    coin = getAddress(address);
  } catch {
    return null;
  }
  const [info, name, symbol, uri] = await Promise.all([
    c.readContract({ address: ELYSIUM.launcher, abi: launcherAbi, functionName: "coins", args: [coin] }),
    c.readContract({ address: coin, abi: erc20Abi, functionName: "name" }).catch(() => ""),
    c.readContract({ address: coin, abi: erc20Abi, functionName: "symbol" }).catch(() => ""),
    c.readContract({ address: coin, abi: erc20Abi, functionName: "tokenURI" }).catch(() => ""),
  ]);
  const [, pool, creator, , coinIsToken0] = info;
  if (pool === "0x0000000000000000000000000000000000000000") return null;
  const [[sqrtPriceX96], liquidity, m] = await Promise.all([
    c.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
    c.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" }),
    meta(uri),
  ]);
  const priceHype = priceOf(sqrtPriceX96, coinIsToken0);
  return { address: coin, name, symbol, uri, image: m.image, description: m.description, creator, pool, coinIsToken0, priceHype, mcHype: priceHype * 1e9, sqrtPriceX96, liquidity };
}

/** The newest coins launched through sasa on Elysium. */
export async function fetchElysiumCoins(limit = 30): Promise<ElysiumCoin[]> {
  const c = elysiumClient();
  const n = Number(await c.readContract({ address: ELYSIUM.launcher, abi: launcherAbi, functionName: "coinCount" }));
  const ids = Array.from({ length: Math.min(n, limit) }, (_, i) => BigInt(n - 1 - i));
  const addrs = await Promise.all(ids.map((i) => c.readContract({ address: ELYSIUM.launcher, abi: launcherAbi, functionName: "allCoins", args: [i] })));
  const list = await Promise.all(addrs.filter((a) => !elysiumHidden(a)).map((a) => fetchElysiumCoin(a).catch(() => null)));
  return list.filter((x): x is ElysiumCoin => !!x);
}

let day1: { at: number; set: Promise<{ set: Set<string>; count: number }> } | null = null;
/**
 * The first DAY1_COINS coins launched on Elysium mainnet (lowercase addresses) and how many coins
 * there are. Empty on testnet: the badge is a mainnet thing. Read once a minute at most.
 */
export function elysiumDay1(): Promise<{ set: Set<string>; count: number }> {
  if (ELYSIUM.testnet) return Promise.resolve({ set: new Set(), count: 0 });
  if (day1 && Date.now() - day1.at < 60_000) return day1.set;
  const p = (async () => {
    const c = elysiumClient();
    const count = Number(await c.readContract({ address: ELYSIUM.launcher, abi: launcherAbi, functionName: "coinCount" }));
    // the first DAY1_COINS real coins (the smoke-test coin doesn't take a spot)
    const ids = Array.from({ length: Math.min(count, DAY1_COINS + HIDDEN.size) }, (_, i) => BigInt(i));
    const addrs = await Promise.all(ids.map((i) => c.readContract({ address: ELYSIUM.launcher, abi: launcherAbi, functionName: "allCoins", args: [i] })));
    const real = addrs.map((a) => a.toLowerCase()).filter((a) => !HIDDEN.has(a));
    return { set: new Set(real.slice(0, DAY1_COINS)), count: count - addrs.filter((a) => HIDDEN.has(a.toLowerCase())).length };
  })();
  day1 = { at: Date.now(), set: p };
  p.catch(() => {
    day1 = null;
  });
  return p;
}

export async function elysiumHypeBalance(user: Address): Promise<bigint> {
  return elysiumClient().getBalance({ address: user });
}

export async function elysiumBalances(user: Address, coin: Address): Promise<{ hype: bigint; coin: bigint }> {
  const c = elysiumClient();
  const [hype, held] = await Promise.all([c.getBalance({ address: user }), c.readContract({ address: coin, abi: erc20Abi, functionName: "balanceOf", args: [user] })]);
  return { hype, coin: held };
}

// ------------------------------------------------------------------ quotes (pool math)

/**
 * What a swap of `amountIn` gets, from the pool's current price and liquidity, as if the trade
 * stays in the current range (sasa's pools are one full range, so it does). More liquidity from
 * others only makes the real result better, never worse.
 */
export function quoteOut(coin: ElysiumCoin, side: "buy" | "sell", amountIn: bigint): bigint {
  const L = coin.liquidity;
  const S = coin.sqrtPriceX96;
  if (L === 0n || S === 0n || amountIn <= 0n) return 0n;
  const inAfterFee = (amountIn * BigInt(1_000_000 - ELYSIUM.fee)) / 1_000_000n;
  // buying pays WHYPE: token1 when the coin is token0, else token0
  const zeroForOne = side === "buy" ? !coin.coinIsToken0 : coin.coinIsToken0;
  if (zeroForOne) {
    const newS = (L * Q96 * S) / (L * Q96 + inAfterFee * S);
    return (L * (S - newS)) / Q96;
  }
  const newS = S + (inAfterFee * Q96) / L;
  return (L * Q96 * (newS - S)) / (S * newS);
}

// ------------------------------------------------------------------ calls (sent with the wallet's send())

const call = (to: Address, data: Hex, value?: bigint): Call => ({ to, data, value });
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);

/** Uploads the picture + info (same store as Solana launches) and returns its address. */
export async function uploadElysiumInfo(info: { name: string; symbol: string; description: string; image: string; twitter?: string; telegram?: string; website?: string }) {
  const r = await fetch("/api/sol/meta", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(info) });
  const j = (await r.json().catch(() => ({}))) as { uri?: string; image?: string; error?: string };
  if (!r.ok || !j.uri) throw new Error(j.error ?? "Couldn't save the coin's picture. Try again.");
  return { uri: j.uri, image: j.image ?? null };
}

export function launchCall(p: { name: string; symbol: string; uri: string; firstBuyWei: bigint; launchFeeWei: bigint }): Call {
  return call(
    ELYSIUM.launcher,
    encodeFunctionData({ abi: launcherAbi, functionName: "launch", args: [p.name, p.symbol, p.uri, "0x0000000000000000000000000000000000000000", 0n] }),
    p.firstBuyWei + p.launchFeeWei
  );
}

/** Buy: wrap HYPE, approve the router, swap. `slippageBps` protects the result. */
export function buyCalls(coin: ElysiumCoin, user: Address, hypeIn: bigint, slippageBps: number): Call[] {
  const minOut = (quoteOut(coin, "buy", hypeIn) * BigInt(10_000 - slippageBps)) / 10_000n;
  return [
    call(ELYSIUM.whype, encodeFunctionData({ abi: wrappedAbi, functionName: "deposit" }), hypeIn),
    call(ELYSIUM.whype, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ELYSIUM.router, hypeIn] })),
    call(
      ELYSIUM.router,
      encodeFunctionData({
        abi: routerAbi,
        functionName: "exactInputSingle",
        args: [{ tokenIn: ELYSIUM.whype, tokenOut: coin.address, fee: ELYSIUM.fee, recipient: user, deadline: deadline(), amountIn: hypeIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
      })
    ),
  ];
}

/** Sell: approve, swap to WHYPE, unwrap the guaranteed part back to HYPE (any extra stays as WHYPE). */
export function sellCalls(coin: ElysiumCoin, user: Address, coinIn: bigint, slippageBps: number): Call[] {
  const minOut = (quoteOut(coin, "sell", coinIn) * BigInt(10_000 - slippageBps)) / 10_000n;
  return [
    call(coin.address, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ELYSIUM.router, coinIn] })),
    call(
      ELYSIUM.router,
      encodeFunctionData({
        abi: routerAbi,
        functionName: "exactInputSingle",
        args: [{ tokenIn: coin.address, tokenOut: ELYSIUM.whype, fee: ELYSIUM.fee, recipient: user, deadline: deadline(), amountIn: coinIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
      })
    ),
    ...(minOut > 0n ? [call(ELYSIUM.whype, encodeFunctionData({ abi: wrappedAbi, functionName: "withdraw", args: [minOut] }))] : []),
  ];
}

export async function elysiumLaunchFee(): Promise<bigint> {
  return elysiumClient().readContract({ address: ELYSIUM.launcher, abi: launcherAbi, functionName: "launchFee" });
}

/** The coin a launch transaction made (from its Launched event). */
export async function launchedCoin(tx: Hex): Promise<Address | null> {
  const r = await elysiumClient().getTransactionReceipt({ hash: tx });
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== ELYSIUM.launcher.toLowerCase() || !log.topics[1]) continue;
    return getAddress("0x" + log.topics[1].slice(26));
  }
  return null;
}

export const fmtHype = (wei: bigint, digits = 4) => {
  const n = Number(wei) / 1e18;
  return n === 0 ? "0" : n < 10 ** -digits ? `<${10 ** -digits}` : n.toLocaleString("en-US", { maximumFractionDigits: digits });
};
