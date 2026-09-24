// Neuron.fun keeper: collects trading fees for every Neuron.fun launch,
// splits them, and buys back and burns each launch's Parent.
//
// One pass per run; schedule it (GitHub Actions cron, Railway cron, ...).
//
// Env:
//   RPC_URL          JSON-RPC endpoint
//   PRIVATE_KEY      operator key (must be the registry's operator)
//   LAUNCHER         NeuronLauncher address
//   LOCKER           PairPadLaunchLocker address
//   REGISTRY         NeuronParentRegistry address
//   START_BLOCK      optional; first block to scan (default: found on-chain)
//   MIN_BUYBACK_WEI  optional; skip buybacks below this (default 1e12 wei)
//   MIN_PAYOUT_WEI   optional; pay creators owed at least this (default 1e13 wei)
//   SLIPPAGE_BPS     optional; tolerated drop from the simulated output (default 300 = 3%)
//   DRY_RUN          "true" to simulate everything and send nothing

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseAbiItem,
  formatEther,
  getAddress,
  defineChain,
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

const RPC_URL = env("RPC_URL");
const LAUNCHER = getAddress(env("LAUNCHER"));
const LOCKER = getAddress(env("LOCKER"));
const REGISTRY = getAddress(env("REGISTRY"));
const MIN_BUYBACK_WEI = BigInt(env("MIN_BUYBACK_WEI", "1000000000000"));
const MIN_PAYOUT_WEI = BigInt(env("MIN_PAYOUT_WEI", "10000000000000"));
const SLIPPAGE_BPS = BigInt(env("SLIPPAGE_BPS", "300"));
const DRY_RUN = env("DRY_RUN", "false") === "true";

if (SLIPPAGE_BPS < 0n || SLIPPAGE_BPS >= 10_000n) throw new Error("SLIPPAGE_BPS out of range");

let rawKey = env("PRIVATE_KEY").trim();
if (!rawKey.startsWith("0x")) rawKey = `0x${rawKey}`;
const account = privateKeyToAccount(rawKey);

const launcherAbi = parseAbi(["function launchCount() view returns (uint256)"]);
const launchEvent = parseAbiItem(
  "event NeuronLaunch(address indexed token, address indexed parent, address indexed creator, address splitter, uint16 parentShareBps, uint256 devBuyEth, uint256 devBuyTokens)"
);
const lockerAbi = parseAbi(["function collectFees(address token) returns (uint256 amount0, uint256 amount1)"]);
const registryAbi = parseAbi(["function operator() view returns (address)"]);
const splitterAbi = parseAbi([
  "function sync()",
  "function payCreator() returns (uint256)",
  "function buybackParent(uint256 amountIn, uint256 minParentOut) returns (uint256)",
  "function parentEth() view returns (uint256)",
  "function creatorEth() view returns (uint256)",
  "function pendingInEscrow() view returns (uint256 eth, uint256 childTokens)",
]);

// ------------------------------------------------------------------ helpers

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** The slippage floor for a buyback whose simulated output is `expected`. */
export function minOutFor(expected, slippageBps) {
  const floor = (expected * (10_000n - slippageBps)) / 10_000n;
  return floor > 0n ? floor : 1n;
}

/** First block at which `address` has code, by binary search. */
async function deploymentBlock(pub, address) {
  let hi = await pub.getBlockNumber();
  if ((await pub.getCode({ address, blockNumber: hi })) === undefined) {
    throw new Error(`no contract at ${address}`);
  }
  let lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    // A node without state that old errors; the contract is newer than that.
    const code = await pub.getCode({ address, blockNumber: mid }).catch(() => undefined);
    if (code && code !== "0x") hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/** All NeuronLaunch events, fetched in ranges that shrink if the RPC objects. */
async function allLaunches(pub, fromBlock) {
  const latest = await pub.getBlockNumber();
  const launches = [];
  let step = 500_000n;
  let start = fromBlock;
  while (start <= latest) {
    const end = start + step - 1n > latest ? latest : start + step - 1n;
    try {
      const logs = await pub.getLogs({ address: LAUNCHER, event: launchEvent, fromBlock: start, toBlock: end });
      for (const l of logs) launches.push(l.args);
      start = end + 1n;
    } catch (e) {
      if (step <= 1_000n) throw e;
      step /= 4n;
    }
  }
  return launches;
}

// ------------------------------------------------------------------ main

async function main() {
  const pub = createPublicClient({ transport: http(RPC_URL) });
  const chainId = await pub.getChainId();
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });

  log(`chain ${chainId}, operator ${account.address}${DRY_RUN ? " (DRY RUN)" : ""}`);
  log(`operator balance ${formatEther(await pub.getBalance({ address: account.address }))} ETH`);

  const onChainOperator = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "operator" });
  const isOperator = getAddress(onChainOperator) === account.address;
  if (!isOperator) log(`WARNING: registry operator is ${onChainOperator}; buybacks will be skipped`);

  const fromBlock =
    process.env.START_BLOCK ? BigInt(process.env.START_BLOCK) : await deploymentBlock(pub, LAUNCHER);
  const launches = await allLaunches(pub, fromBlock);
  const count = await pub.readContract({ address: LAUNCHER, abi: launcherAbi, functionName: "launchCount" });
  log(`found ${launches.length} launches from block ${fromBlock} (launcher reports ${count})`);
  if (BigInt(launches.length) !== count) log("WARNING: event count differs from launchCount");

  // Sends one call, or only simulates it in a dry run. Returns the simulated result.
  const act = async (label, address, abi, functionName, args = []) => {
    const { result, request } = await pub.simulateContract({ account, address, abi, functionName, args });
    if (DRY_RUN) {
      log(`  [dry] ${label}`);
      return result;
    }
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    log(`  ${label}: ${hash}`);
    return result;
  };

  let failures = 0;
  let totalBuyback = 0n;

  for (const { token, parent, splitter, creator, parentShareBps } of launches) {
    log(`launch ${token} (parent ${parent})`);
    try {
      // 1. Pool fees -> escrow. Skip the transaction when nothing accrued.
      const { result: collected } = await pub.simulateContract({
        account, address: LOCKER, abi: lockerAbi, functionName: "collectFees", args: [token],
      });
      if (collected[0] > 0n || collected[1] > 0n) {
        await act("collectFees", LOCKER, lockerAbi, "collectFees", [token]);
      }

      // 2. Escrow -> splitter, split between Parent and creator.
      const [pendingEth, pendingTokens] = await pub.readContract({
        address: splitter, abi: splitterAbi, functionName: "pendingInEscrow",
      });
      const hadPending = pendingEth > 0n || pendingTokens > 0n || collected[0] > 0n || collected[1] > 0n;
      if (hadPending && !DRY_RUN) await act("sync", splitter, splitterAbi, "sync");

      // 3. Buy back and burn the Parent. buybackParent syncs first, so in a
      //    dry run it can be simulated on what the sync would add.
      const parentEth = await pub.readContract({ address: splitter, abi: splitterAbi, functionName: "parentEth" });
      const amountIn = DRY_RUN ? parentEth + (pendingEth * BigInt(parentShareBps)) / 10_000n : parentEth;
      log(`  parent ETH ready: ${formatEther(amountIn)}`);
      if (isOperator && amountIn >= MIN_BUYBACK_WEI) {
        const { result: expectedOut } = await pub.simulateContract({
          account, address: splitter, abi: splitterAbi, functionName: "buybackParent", args: [amountIn, 1n],
        });
        const floor = minOutFor(expectedOut, SLIPPAGE_BPS);
        await act(
          `buybackParent ${formatEther(amountIn)} ETH -> >= ${floor} parent units`,
          splitter, splitterAbi, "buybackParent", [amountIn, floor]
        );
        totalBuyback += amountIn;
      }

      // 4. Pay the creator once enough is owed.
      const creatorEth = await pub.readContract({ address: splitter, abi: splitterAbi, functionName: "creatorEth" });
      if (creatorEth >= MIN_PAYOUT_WEI) {
        await act(`payCreator ${formatEther(creatorEth)} ETH to ${creator}`, splitter, splitterAbi, "payCreator");
      }
    } catch (e) {
      failures++;
      log(`  FAILED: ${e.shortMessage ?? e.message}`);
    }
  }

  log(`done: ${launches.length} launches, ${formatEther(totalBuyback)} ETH of buybacks, ${failures} failures`);
  if (failures > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
