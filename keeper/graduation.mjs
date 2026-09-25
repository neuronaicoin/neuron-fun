// Neuron.fun graduation keeper.
//
// A coin launched on several chains has one bonding curve per chain, all
// created by the same creator with the same launchKey. This keeper adds up
// what every curve of a coin holds, in US dollars, and when the total reaches
// the graduation target it graduates the curve on the chain holding the most
// and closes the rest. Every decision carries the hash of a published tally
// so anyone can check it against the chains.
//
// The keeper can only graduate or close. The contracts do not let it move
// anyone's money: graduation can only send a curve's funds into its locked
// DEX pool, and closed curves keep selling back to holders.
//
// One pass per run; schedule it.
//
// Env:
//   PRIVATE_KEY       operator key (the curve factories' operator on every chain)
//   CHAINS            JSON array: [{ "name", "chainId", "rpc", "factory", "startBlock", "native" }]
//                     native is the price symbol of the chain's gas coin: ETH, BNB or USD
//   TARGET_USD        graduation target, in dollars, across all chains (default 20000)
//   REPORT_DIR        where tallies are written as JSON (default ./reports)
//   PRICE_OVERRIDES   optional JSON, e.g. {"ETH":2500} (tests only)
//   DRY_RUN           "true" to decide and report without sending anything

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ------------------------------------------------------------------ config

const env = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback === undefined) throw new Error(`missing env ${name}`);
    return fallback;
  }
  return v;
};

const TARGET_USD = Number(env("TARGET_USD", "20000"));
const REPORT_DIR = env("REPORT_DIR", "./reports");
const DRY_RUN = env("DRY_RUN", "false") === "true";
const PRICE_OVERRIDES = JSON.parse(env("PRICE_OVERRIDES", "{}"));
if (!(TARGET_USD > 0)) throw new Error("TARGET_USD must be positive");

let rawKey = env("PRIVATE_KEY").trim();
if (!rawKey.startsWith("0x")) rawKey = `0x${rawKey}`;
const account = privateKeyToAccount(rawKey);

const CHAINS = JSON.parse(env("CHAINS")).map((c) => ({
  ...c,
  factory: getAddress(c.factory),
  startBlock: BigInt(c.startBlock ?? 0),
}));
if (CHAINS.length === 0) throw new Error("CHAINS is empty");

const launchedEvent = parseAbiItem(
  "event Launched(address indexed curve, address indexed token, address indexed creator, bytes32 launchKey, string name, string symbol)"
);
const factoryAbi = parseAbi(["function operator() view returns (address)"]);
const curveAbi = parseAbi([
  "function state() view returns (uint8)",
  "function realNative() view returns (uint256)",
  "function tokensForSale() view returns (uint256)",
  "function minGraduationNative() view returns (uint256)",
  "function graduate(bytes32 report)",
  "function close(bytes32 report)",
]);

const STATE = { 0: "trading", 1: "closed", 2: "graduated" };
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ------------------------------------------------------------------ prices

/**
 * Dollar price of each gas coin. Two independent sources must agree within
 * 2%, or the pass makes no decisions: a wrong price must never pick a winner.
 */
async function fetchPrices(symbols) {
  const out = { USD: 1 };
  for (const s of symbols) {
    if (s === "USD") continue;
    if (PRICE_OVERRIDES[s]) {
      out[s] = Number(PRICE_OVERRIDES[s]);
      continue;
    }
    const [a, b] = await Promise.all([coinbasePrice(s), krakenPrice(s)]);
    const got = [a, b].filter((x) => Number.isFinite(x) && x > 0);
    if (got.length === 0) throw new Error(`no price for ${s}`);
    if (got.length === 2 && Math.abs(got[0] - got[1]) / Math.min(got[0], got[1]) > 0.02) {
      throw new Error(`price sources disagree for ${s}: ${got.join(" vs ")}`);
    }
    out[s] = Math.min(...got); // the lower one: never overstate a total
  }
  return out;
}

async function coinbasePrice(s) {
  try {
    const r = await fetch(`https://api.coinbase.com/v2/prices/${s}-USD/spot`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return Number(j?.data?.amount);
  } catch {
    return NaN;
  }
}

async function krakenPrice(s) {
  const pair = { ETH: "ETHUSD", BNB: "BNBUSD" }[s];
  if (!pair) return NaN;
  try {
    const r = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const first = j?.result && Object.values(j.result)[0];
    return Number(first?.c?.[0]);
  } catch {
    return NaN;
  }
}

// ------------------------------------------------------------------ chain reads

async function allLaunches(pub, factory, fromBlock) {
  const latest = await pub.getBlockNumber();
  const out = [];
  let step = 500_000n;
  let start = fromBlock;
  while (start <= latest) {
    const end = start + step - 1n > latest ? latest : start + step - 1n;
    try {
      const logs = await pub.getLogs({ address: factory, event: launchedEvent, fromBlock: start, toBlock: end });
      for (const l of logs) out.push(l.args);
      start = end + 1n;
    } catch (e) {
      if (step <= 1_000n) throw e;
      step /= 4n;
    }
  }
  return out;
}

async function readCurve(pub, curve) {
  const [state, realNative, tokensForSale, minGrad] = await Promise.all([
    pub.readContract({ address: curve, abi: curveAbi, functionName: "state" }),
    pub.readContract({ address: curve, abi: curveAbi, functionName: "realNative" }),
    pub.readContract({ address: curve, abi: curveAbi, functionName: "tokensForSale" }),
    pub.readContract({ address: curve, abi: curveAbi, functionName: "minGraduationNative" }),
  ]);
  return { state: STATE[Number(state)], realNative, soldOut: tokensForSale === 0n, minGrad };
}

// ------------------------------------------------------------------ decision (pure)

/**
 * Decides what to do with one coin. Pure, so it can be tested on its own.
 * @returns {{ action: "none" | "graduate" | "repair", reason: string, winner?: object, toClose: object[] }}
 */
export function decide(curves, targetUsd) {
  const open = curves.filter((c) => c.state === "trading");
  const graduated = curves.find((c) => c.state === "graduated");
  if (graduated) {
    // Already decided earlier; make sure the losers are closed.
    return open.length
      ? { action: "repair", reason: "already graduated; closing leftover curves", winner: graduated, toClose: open }
      : { action: "none", reason: "done", toClose: [] };
  }
  if (open.length === 0) return { action: "none", reason: "no open curves", toClose: [] };

  const totalUsd = open.reduce((s, c) => s + c.usd, 0);
  const soldOut = open.some((c) => c.soldOut);
  if (totalUsd < targetUsd && !soldOut) {
    return { action: "none", reason: `total $${totalUsd.toFixed(2)} below $${targetUsd}`, toClose: [] };
  }
  // The winner holds the most dollars and meets its chain's minimum.
  const eligible = open.filter((c) => c.realNative >= c.minGrad).sort((a, b) => b.usd - a.usd);
  if (eligible.length === 0) {
    return { action: "none", reason: "target reached but no chain meets its graduation minimum", toClose: [] };
  }
  const winner = eligible[0];
  return {
    action: "graduate",
    reason: soldOut && totalUsd < targetUsd ? "a chain sold out" : "target reached",
    winner,
    toClose: open.filter((c) => c !== winner),
  };
}

/** Canonical JSON of a tally, and its hash (what goes on-chain). */
export function tallyHash(tally) {
  const json = JSON.stringify(tally, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  return { json, hash: keccak256(stringToHex(json)) };
}

// ------------------------------------------------------------------ main

async function main() {
  log(`operator ${account.address}${DRY_RUN ? " (DRY RUN)" : ""}, target $${TARGET_USD}`);
  const prices = await fetchPrices([...new Set(CHAINS.map((c) => c.native))]);
  log("prices", JSON.stringify(prices));

  // Connect to every chain and check we are its operator.
  const ctx = [];
  for (const c of CHAINS) {
    const chain = defineChain({
      id: c.chainId,
      name: c.name,
      nativeCurrency: { name: c.native, symbol: c.native, decimals: 18 },
      rpcUrls: { default: { http: [c.rpc] } },
    });
    const pub = createPublicClient({ chain, transport: http(c.rpc) });
    const wallet = createWalletClient({ account, chain, transport: http(c.rpc) });
    const actual = await pub.getChainId();
    if (actual !== c.chainId) throw new Error(`${c.name}: RPC is chain ${actual}, expected ${c.chainId}`);
    const op = await pub.readContract({ address: c.factory, abi: factoryAbi, functionName: "operator" });
    const isOperator = getAddress(op) === account.address;
    if (!isOperator) log(`WARNING ${c.name}: operator is ${op}; this pass will only report`);
    ctx.push({ ...c, pub, wallet, isOperator });
  }

  // Group every curve by coin: same creator, same launchKey.
  const coins = new Map();
  for (const c of ctx) {
    for (const l of await allLaunches(c.pub, c.factory, c.startBlock)) {
      const id = `${l.creator.toLowerCase()}:${l.launchKey}`;
      if (!coins.has(id)) coins.set(id, { creator: l.creator, launchKey: l.launchKey, symbol: l.symbol, curves: [] });
      coins.get(id).curves.push({ chain: c, curve: l.curve, token: l.token });
    }
  }
  log(`found ${coins.size} coins`);

  let failures = 0;
  for (const coin of coins.values()) {
    try {
      const curves = [];
      for (const k of coin.curves) {
        const s = await readCurve(k.chain.pub, k.curve);
        const usd = Number(formatEther(s.realNative)) * prices[k.chain.native];
        curves.push({ ...k, ...s, usd });
      }
      const d = decide(curves, TARGET_USD);
      const label = `${coin.symbol} (${coin.creator.slice(0, 8)}…)`;
      if (d.action === "none") {
        if (d.reason !== "done") log(`${label}: ${d.reason}`);
        continue;
      }

      const tally = {
        kind: "neuron.fun graduation tally",
        version: 1,
        decidedAt: new Date().toISOString(),
        creator: coin.creator,
        launchKey: coin.launchKey,
        targetUsd: TARGET_USD,
        prices,
        reason: d.reason,
        winner: { chainId: d.winner.chain.chainId, curve: d.winner.curve },
        curves: curves.map((c) => ({
          chainId: c.chain.chainId,
          chain: c.chain.name,
          curve: c.curve,
          state: c.state,
          realNative: c.realNative,
          usd: Number(c.usd.toFixed(2)),
        })),
      };
      const { json, hash } = tallyHash(tally);
      mkdirSync(REPORT_DIR, { recursive: true });
      writeFileSync(join(REPORT_DIR, `${hash}.json`), json);
      log(`${label}: ${d.action} — ${d.reason}; winner ${d.winner.chain.name}; report ${hash}`);

      if (DRY_RUN) continue;
      const send = async (k, fn) => {
        if (!k.chain.isOperator) throw new Error(`not operator on ${k.chain.name}`);
        const { request } = await k.chain.pub.simulateContract({
          account, address: k.curve, abi: curveAbi, functionName: fn, args: [hash],
        });
        const tx = await k.chain.wallet.writeContract(request);
        const r = await k.chain.pub.waitForTransactionReceipt({ hash: tx });
        if (r.status !== "success") throw new Error(`${fn} reverted on ${k.chain.name}: ${tx}`);
        log(`  ${fn} on ${k.chain.name}: ${tx}`);
      };
      // Graduate first; close the others only once the winner is settled.
      if (d.action === "graduate") await send(d.winner, "graduate");
      for (const loser of d.toClose) await send(loser, "close");
    } catch (e) {
      failures++;
      log(`FAILED: ${e.shortMessage ?? e.message}`);
    }
  }
  log(`done, ${failures} failures`);
  if (failures > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
