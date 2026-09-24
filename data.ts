import {
  createPublicClient,
  http,
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { chain, ADDR, START_BLOCK } from "./config";
import {
  launchEvent,
  factoryAbi,
  tokenAbi,
  splitterAbi,
  poolManagerAbi,
  poolKeyComponents,
  registryEvent,
  registryAbi,
} from "./abis";

export const publicClient = createPublicClient({ chain, transport: http() });

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export type Launch = {
  token: Address;
  parent: Address;
  creator: Address;
  splitter: Address;
  blockNumber: bigint;
};

export type Coin = Launch & {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  marketCapWei: bigint | null;
  burnedForParentWei: bigint;
  parentSymbol: string;
};

export type Parent = {
  token: Address;
  name: string;
  symbol: string;
  logo: string;
  children: number;
  burnedForItWei: bigint;
};

/** Every Neuron.fun launch, newest first. Ranges shrink if the RPC objects. */
export async function fetchLaunches(): Promise<Launch[]> {
  const latest = await publicClient.getBlockNumber();
  const out: Launch[] = [];
  let step = 500_000n;
  let start = START_BLOCK;
  while (start <= latest) {
    const end = start + step - 1n > latest ? latest : start + step - 1n;
    try {
      const logs = await publicClient.getLogs({ address: ADDR.launcher, event: launchEvent, fromBlock: start, toBlock: end });
      for (const l of logs) {
        const a = l.args;
        if (a.token && a.parent && a.creator && a.splitter) {
          out.push({ token: a.token, parent: a.parent, creator: a.creator, splitter: a.splitter, blockNumber: l.blockNumber ?? 0n });
        }
      }
      start = end + 1n;
    } catch (e) {
      if (step <= 1_000n) throw e;
      step /= 4n;
    }
  }
  return out.sort((x, y) => (y.blockNumber > x.blockNumber ? 1 : y.blockNumber < x.blockNumber ? -1 : 0));
}

/** Tokens currently allowed as parents. */
export async function fetchParentAddresses(): Promise<Address[]> {
  const logs = await publicClient.getLogs({ address: ADDR.registry, event: registryEvent, fromBlock: START_BLOCK - 10_000n });
  const unique = [...new Set(logs.map((l) => l.args.parent).filter((a): a is Address => !!a))];
  const listed = await Promise.all(
    unique.map((p) => publicClient.readContract({ address: ADDR.registry, abi: registryAbi, functionName: "isListed", args: [p] }))
  );
  return unique.filter((_, i) => listed[i]);
}

export async function poolKeyFor(token: Address): Promise<PoolKey> {
  const k = await publicClient.readContract({ address: ADDR.factory, abi: factoryAbi, functionName: "poolKeyFor", args: [token] });
  return { currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks };
}

const POOLS_SLOT = 6n;
const Q160 = (1n << 160n) - 1n;

/** The pool's sqrtPriceX96, read straight from the PoolManager's storage. */
export async function sqrtPriceOf(key: PoolKey): Promise<bigint> {
  const poolId = keccak256(encodeAbiParameters([{ type: "tuple", components: poolKeyComponents }], [key]));
  const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, POOLS_SLOT]));
  const word = (await publicClient.readContract({
    address: ADDR.poolManager,
    abi: poolManagerAbi,
    functionName: "extsload",
    args: [slot],
  })) as Hex;
  return BigInt(word) & Q160;
}

/** Market cap in wei, for a token quoted against ETH (currency0). */
export function marketCapWei(totalSupply: bigint, sqrtPriceX96: bigint): bigint | null {
  if (sqrtPriceX96 === 0n) return null;
  return (totalSupply << 192n) / (sqrtPriceX96 * sqrtPriceX96);
}

async function tokenMeta(token: Address) {
  const [name, symbol, totalSupply, logo, description] = await Promise.all([
    publicClient.readContract({ address: token, abi: tokenAbi, functionName: "name" }),
    publicClient.readContract({ address: token, abi: tokenAbi, functionName: "symbol" }),
    publicClient.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply" }),
    publicClient.readContract({ address: token, abi: tokenAbi, functionName: "logo" }).catch(() => ""),
    publicClient.readContract({ address: token, abi: tokenAbi, functionName: "description" }).catch(() => ""),
  ]);
  return { name, symbol, totalSupply, logo, description };
}

const symbolCache = new Map<string, string>();
async function symbolOf(token: Address): Promise<string> {
  const hit = symbolCache.get(token);
  if (hit) return hit;
  const s = await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "symbol" }).catch(() => "?");
  symbolCache.set(token, s);
  return s;
}

export async function fetchCoin(l: Launch): Promise<Coin> {
  const [meta, key, burned, parentSymbol] = await Promise.all([
    tokenMeta(l.token),
    poolKeyFor(l.token),
    publicClient.readContract({ address: l.splitter, abi: splitterAbi, functionName: "totalParentEthSpent" }),
    symbolOf(l.parent),
  ]);
  const sqrtP = await sqrtPriceOf(key).catch(() => 0n);
  return {
    ...l,
    name: meta.name,
    symbol: meta.symbol,
    logo: meta.logo,
    description: meta.description,
    marketCapWei: marketCapWei(meta.totalSupply, sqrtP),
    burnedForParentWei: burned,
    parentSymbol,
  };
}

export async function fetchCoins(): Promise<Coin[]> {
  const launches = await fetchLaunches();
  return Promise.all(launches.map(fetchCoin));
}

export async function fetchParents(coins: Coin[]): Promise<Parent[]> {
  const addrs = await fetchParentAddresses();
  return Promise.all(
    addrs.map(async (token) => {
      const meta = await tokenMeta(token);
      const kids = coins.filter((c) => c.parent.toLowerCase() === token.toLowerCase());
      return {
        token,
        name: meta.name,
        symbol: meta.symbol,
        logo: meta.logo,
        children: kids.length,
        burnedForItWei: kids.reduce((s, c) => s + c.burnedForParentWei, 0n),
      };
    })
  );
}

/** $NEURON sitting at the dead address. */
export async function neuronBurned(): Promise<bigint> {
  return publicClient.readContract({ address: ADDR.neuron, abi: tokenAbi, functionName: "balanceOf", args: [ADDR.dead] });
}

export function isImageUrl(s: string): boolean {
  return /^https:\/\/\S+$/i.test(s);
}
