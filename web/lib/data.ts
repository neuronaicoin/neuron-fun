import { createPublicClient, formatEther, http, type Address, type Hex, type PublicClient } from "viem";
import { CHAINS, TARGET_USD, type NeuronChain } from "./config";
import { launchedEvent, curveAbi, tokenAbi } from "./abis";
import { fetchPrices } from "./price";

const clients = new Map<number, PublicClient>();
export function clientFor(c: NeuronChain): PublicClient {
  let p = clients.get(c.chain.id);
  if (!p) {
    p = createPublicClient({ chain: c.chain, transport: http() }) as PublicClient;
    clients.set(c.chain.id, p);
  }
  return p;
}

export type CurveState = "trading" | "closed" | "graduated";
const STATES: CurveState[] = ["trading", "closed", "graduated"];

export type CurveInfo = {
  chain: NeuronChain;
  curve: Address;
  token: Address;
  state: CurveState;
  realNative: bigint;
  virtualNative: bigint;
  virtualToken: bigint;
  minGraduationNative: bigint;
  usd: number | null;
  blockNumber: bigint;
};

export type Coin = {
  id: string; // creator:launchKey
  creator: Address;
  launchKey: Hex;
  name: string;
  symbol: string;
  logo: string;
  description: string;
  curves: CurveInfo[];
  totalUsd: number | null;
  progress: number; // 0..1
  graduatedOn: CurveInfo | null;
  newest: bigint;
};

type RawLaunch = {
  chain: NeuronChain;
  curve: Address;
  token: Address;
  creator: Address;
  launchKey: Hex;
  name: string;
  symbol: string;
  blockNumber: bigint;
};

async function launchesOn(c: NeuronChain): Promise<RawLaunch[]> {
  const pub = clientFor(c);
  const latest = await pub.getBlockNumber();
  const out: RawLaunch[] = [];
  let step = 100_000n;
  let start = c.startBlock;
  while (start <= latest) {
    const end = start + step - 1n > latest ? latest : start + step - 1n;
    try {
      const logs = await pub.getLogs({ address: c.factory, event: launchedEvent, fromBlock: start, toBlock: end });
      for (const l of logs) {
        const a = l.args;
        if (!a.curve || !a.token || !a.creator || !a.launchKey) continue;
        out.push({
          chain: c,
          curve: a.curve,
          token: a.token,
          creator: a.creator,
          launchKey: a.launchKey,
          name: a.name ?? "",
          symbol: a.symbol ?? "",
          blockNumber: l.blockNumber ?? 0n,
        });
      }
      start = end + 1n;
    } catch (e) {
      if (step <= 1_000n) throw e;
      step /= 4n;
    }
  }
  return out;
}

async function readCurve(l: RawLaunch, prices: Record<string, number> | null): Promise<CurveInfo> {
  const pub = clientFor(l.chain);
  const r = (fn: "state" | "realNative" | "virtualNative" | "virtualToken" | "minGraduationNative") =>
    pub.readContract({ address: l.curve, abi: curveAbi, functionName: fn });
  const [state, realNative, virtualNative, virtualToken, minGraduationNative] = await Promise.all([
    r("state"),
    r("realNative"),
    r("virtualNative"),
    r("virtualToken"),
    r("minGraduationNative"),
  ]);
  const price = prices?.[l.chain.priceSymbol];
  return {
    chain: l.chain,
    curve: l.curve,
    token: l.token,
    state: STATES[Number(state)] ?? "trading",
    realNative: realNative as bigint,
    virtualNative: virtualNative as bigint,
    virtualToken: virtualToken as bigint,
    minGraduationNative: minGraduationNative as bigint,
    usd: price ? Number(formatEther(realNative as bigint)) * price : null,
    blockNumber: l.blockNumber,
  };
}

/** Every coin across every chain, newest first. */
export async function fetchCoins(): Promise<{ coins: Coin[]; prices: Record<string, number> | null }> {
  const [prices, ...perChain] = await Promise.all([fetchPrices(), ...CHAINS.map((c) => launchesOn(c).catch(() => []))]);
  const groups = new Map<string, RawLaunch[]>();
  for (const l of perChain.flat()) {
    const id = `${l.creator.toLowerCase()}:${l.launchKey}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(l);
  }
  const coins = await Promise.all(
    [...groups.entries()].map(async ([id, ls]) => {
      const first = ls[0];
      const [curves, meta] = await Promise.all([
        Promise.all(ls.map((l) => readCurve(l, prices))),
        tokenMeta(first.chain, first.token),
      ]);
      return assemble(id, first, curves, meta);
    })
  );
  coins.sort((a, b) => (b.newest > a.newest ? 1 : b.newest < a.newest ? -1 : 0));
  return { coins, prices };
}

export async function fetchCoin(creator: Address, launchKey: Hex) {
  const { coins, prices } = await fetchCoins();
  const coin = coins.find((c) => c.creator.toLowerCase() === creator.toLowerCase() && c.launchKey === launchKey);
  return { coin: coin ?? null, prices };
}

function assemble(id: string, first: RawLaunch, curves: CurveInfo[], meta: { logo: string; description: string }): Coin {
  const graduatedOn = curves.find((c) => c.state === "graduated") ?? null;
  const open = curves.filter((c) => c.state === "trading");
  const priced = open.every((c) => c.usd !== null);
  const totalUsd = priced ? open.reduce((s, c) => s + (c.usd ?? 0), 0) : null;
  const progress = graduatedOn ? 1 : totalUsd === null ? 0 : Math.min(1, totalUsd / TARGET_USD);
  return {
    id,
    creator: first.creator,
    launchKey: first.launchKey,
    name: first.name,
    symbol: first.symbol,
    logo: meta.logo,
    description: meta.description,
    curves: curves.sort((a, b) => a.chain.short.localeCompare(b.chain.short)),
    totalUsd,
    progress,
    graduatedOn,
    newest: curves.reduce((m, c) => (c.blockNumber > m ? c.blockNumber : m), 0n),
  };
}

async function tokenMeta(c: NeuronChain, token: Address) {
  const pub = clientFor(c);
  const [logo, description] = await Promise.all([
    pub.readContract({ address: token, abi: tokenAbi, functionName: "logo" }).catch(() => ""),
    pub.readContract({ address: token, abi: tokenAbi, functionName: "description" }).catch(() => ""),
  ]);
  return { logo: logo as string, description: description as string };
}

/** Curve price in native coin per whole token, as a float (display only). */
export function nativePerToken(c: CurveInfo): number {
  return Number(c.virtualNative) / Number(c.virtualToken);
}

/** A picture we are willing to show: an https link or a small embedded image. */
export function isImageUrl(s: string): boolean {
  return /^https:\/\/\S+$/i.test(s) || /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
}

export function coinHref(c: { creator: string; launchKey: string }) {
  return `/coin/?c=${c.creator}&k=${c.launchKey}`;
}
