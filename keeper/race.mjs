// sasa v7 (five-minute race) keeper. One pass per run; loop it on Railway (LOOP_SECONDS).
//
// Every pass looks at every v7 coin and does the next step that is due. Each step is
// safe to repeat and the contracts check everything again, so a pass that stops
// half-way, or two passes at once, can do no harm:
//
//   1. the five minutes are over on every chain                -> freeze (report) each chain
//   2. the coordinator has every chain's report                -> finalize (the verdict)
//   3. a losing chain still holds BNB/ETH waiting for a fair
//      price (convertLost), or dollars waiting to cross        -> convert, forward
//   4. the winner has dollars that arrived but could not be
//      swapped into its pool yet (convertPending)              -> convert
//   5. holders on losing chains                                -> move their coins
//   6. after the race, on the winner: collect fees (every 30 min if it traded), buybacks;
//      only when there is at least MIN_COLLECT_USD (default $1) to collect or buy back, so
//      the gas stays a small slice of the money moved (catch-all once a day)
//   7. Across two-step routes (BNB Chain <-> Robinhood Chain go through Base): money waiting
//      on the middle chain's bridge                            -> forwardHop
//      The bridge pays whoever forwards a small tip out of the money (at most 5 cents, at most
//      1%); a hop is forwarded only when that tip covers the gas with room to spare, so the
//      keeper never pays for it. Hops too small for that wait (anyone may still forward them).
//
// The keeper cannot pick a winner or move money anywhere else: the coordinator decides
// on-chain, and money/coins can only go to the places fixed in the contracts.
//
// Env:
//   PRIVATE_KEY    the hubs' keeper key
//   DEPLOYMENTS    folder with <chainId>.json from DeployRace (default ../contracts-v7/deployments/race)
//   RPC_<chainId>  RPC URL(s) per chain, comma-separated for fallback (e.g. RPC_84532)
//   STATE_FILE     where scan progress is kept between runs (default ./race-state.json)
//                  (on Railway put it on a volume, e.g. /data/race-state.json, so a restart keeps it)
//   RACE_FROM_<chainId>  first block to look for launches on that chain, when it is later than the
//                  deployment's start block (blocks before it are skipped even with no state file;
//                  set it only to a block before that chain's first launch)
//   DRY_RUN        "true": decide and log, send nothing
//   LZ_FEE_WEI     native sent per LayerZero message; the unused part is refunded (default 0.0003);
//                  LZ_FEE_WEI_<chainId> overrides it for one chain
//   LOOP_SECONDS   run forever, one pass every N seconds (default: one pass, then exit)
//   COLLECT_MINUTES / IDLE_COLLECT_HOURS   fee collection pace on the winner (default 30 / 24)
//   VAULT_MINUTES / VAULT_MIN_USD   how often / from how much the fee vault is split (60 / $5)
//   MIN_GAS_WEI(_<chainId>), REFILL_USD, REFILL_EVERY_MIN, RELAY_API_KEY, GAS_REFILL
//                  gas top-up from the keeper's own USDC (the race fees), see refill.mjs

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readState, writeState } from "./statefile.mjs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, fallback, http, parseAbi, parseAbiItem, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { alert, heartbeat, staleServices } from "./alert.mjs";
import { refillGas } from "./refill.mjs";

const env = (n, d) => {
  const v = process.env[n];
  if (v === undefined || v === "") {
    if (d === undefined) throw new Error(`missing env ${n}`);
    return d;
  }
  return v;
};
const log = (...a) => console.log(new Date().toISOString(), ...a);
const DRY = env("DRY_RUN", "false") === "true";
const DEPLOYMENTS = env("DEPLOYMENTS", "../contracts-v7/deployments/race");
const STATE_FILE = env("STATE_FILE", "./race-state.json");
const LZ_FEE_DEFAULT = BigInt(env("LZ_FEE_WEI", "300000000000000"));
// per chain: LZ_FEE_WEI_<chainId> (Arc pays gas in USDC, 18 decimals natively: its fee differs)
const lzFee = (c) => BigInt(process.env[`LZ_FEE_WEI_${c.chainId}`] || LZ_FEE_DEFAULT);
// Pool fees are collected every COLLECT_MINUTES (default 30) for coins that traded since the
// last collection; a coin with no trades is skipped (no new fees, no gas spent), with one
// catch-all collection every IDLE_COLLECT_HOURS (default 24) in case trading happened outside
// the launch position's range.
const COLLECT_MS = Number(env("COLLECT_MINUTES", "30")) * 60_000;
const IDLE_COLLECT_MS = Number(env("IDLE_COLLECT_HOURS", "24")) * 3_600_000;
const MIN_COLLECT_USD = Number(env("MIN_COLLECT_USD", "1"));
const BUDGET_MS = Number(env("BUDGET_MS", String(9 * 60_000)));
const RACE_SECONDS = 300;
let STARTED = Date.now();
const timeLeft = () => Date.now() - STARTED < BUDGET_MS;
let key = env("PRIVATE_KEY").trim();
if (!key.startsWith("0x")) key = `0x${key}`;
const account = privateKeyToAccount(key);

// LayerZero executor option (type 3): gas for the receiving side.
export const lzOptions = (gas) => `0x000301001101${BigInt(gas).toString(16).padStart(32, "0")}`;

const launched = parseAbiItem(
  "event Launched(bytes32 indexed coinId, address indexed coin, address indexed seat, address creator, uint32[] eids, string name, string symbol, string logo, string description, uint8 feeMode)"
);
const transferEvt = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const hubAbi = parseAbi([
  "error LZ_InsufficientFee(uint256 requiredNative, uint256 suppliedNative, uint256 requiredLzToken, uint256 suppliedLzToken)",
  "function freeze(bytes32 coin, bytes options) payable",
  "function finalize(bytes32 coin, uint256 feePerChain, bytes options) payable",
  "function preview(bytes32 coin) view returns (bool ready, bool graduate, uint32 winner, uint256 total, uint256 poolTokens)",
  "function coordEid() view returns (uint32)",
]);
const seatAbi = parseAbi(["function reported() view returns (bool)", "function winnerEid() view returns (uint32)"]);
// the three builders share these (RaceBuilder has no pending/lost functions: its pools are in dollars already)
const builderAbi = parseAbi([
  "function raceOver(address coin) view returns (bool)",
  "function races(address coin) view returns (uint256 positionId, address seat, address creator, uint8 feeMode, uint64 launchedAt, uint8 state, uint32 winnerEid)",
  "function buybackFunds(address coin) view returns (uint256)",
  "function collectFees(address coin) returns (uint256, uint256)",
  "function poolAmounts(address coin) view returns (uint256, uint256)",
  "function buyback(address coin, uint256 minCoinsOut) returns (uint256 spent, uint256 burned)",
  "function pendingDollars(address coin) view returns (uint256)",
  "function convertPending(address coin)",
  "function lostPending(address coin) view returns (uint256)",
  "function convertLost(address coin, uint256 amount) returns (uint256)",
]);
const oldBuybackAbi = parseAbi(["function buyback(address coin) returns (uint256 spent, uint256 burned)"]);
// RaceBuilderPcs keeps no positionId: its races() has a different shape
const builderPcsAbi = parseAbi([
  "function races(address coin) view returns (address seat, address creator, uint8 feeMode, uint64 launchedAt, uint8 state, uint32 winnerEid, int24 launchLower, int24 launchUpper)",
]);
const consAbi = parseAbi([
  "error LZ_InsufficientFee(uint256 requiredNative, uint256 suppliedNative, uint256 requiredLzToken, uint256 suppliedLzToken)",
  "function pendingPool(bytes32) view returns (uint256)",
  "function pendingBuyback(bytes32) view returns (uint256)",
  "function forward(bytes32 coin) payable",
]);
const coinAbi = parseAbi([
  "error LZ_InsufficientFee(uint256 requiredNative, uint256 suppliedNative, uint256 requiredLzToken, uint256 suppliedLzToken)",
  "function bridgeOpen() view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function isPlainAccount(address) view returns (bool)",
  "function moveBatch(address[] holders, bytes options) payable",
]);
const testFeedAbi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function touch()",
]);
const bridgeAbi = parseAbi([
  "function hopsCount() view returns (uint256)",
  "function hops(uint256) view returns (bytes32 coin, uint32 finalEid, bool buyback, bool forwarded, uint256 amount)",
  "function tipFor(uint256 amount) view returns (uint256)",
  "function tokenDecimals() view returns (uint8)",
  "function forwardHop(uint256 hopId)",
]);
const priceFeedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);
const vaultAbi = parseAbi(["function distribute()"]);
const balAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const NONE = 0, RACING = 1, WON = 2, LOST = 3;

// ------------------------------------------------------------------ chains

function loadChains() {
  const out = [];
  for (const f of readdirSync(DEPLOYMENTS).filter((x) => /^\d+\.json$/.test(x))) {
    const d = JSON.parse(readFileSync(join(DEPLOYMENTS, f), "utf8"));
    const rpcs = (process.env[`RPC_${d.chainId}`] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (rpcs.length === 0) {
      log(`skip chain ${d.chainId}: no RPC_${d.chainId}`);
      continue;
    }
    const chain = defineChain({ id: Number(d.chainId), name: `c${d.chainId}`, nativeCurrency: { name: "native", symbol: "N", decimals: 18 }, rpcUrls: { default: { http: rpcs } } });
    const transport = fallback(rpcs.map((u) => http(u, { retryCount: 2, timeout: 20_000 })));
    out.push({
      ...d,
      eid: Number(d.eid),
      pub: createPublicClient({ chain, transport }),
      wallet: createWalletClient({ chain, account, transport }),
    });
  }
  return out;
}

// Reads logs in chunks (public RPCs limit the range); stops early when the time budget is spent.
async function scan(pub, args, from, to) {
  const out = [];
  let step = 2_000n;
  let start = from;
  while (start <= to) {
    if (!timeLeft()) break;
    const end = start + step - 1n > to ? to : start + step - 1n;
    try {
      out.push(...(await pub.getLogs({ ...args, fromBlock: start, toBlock: end })));
      start = end + 1n;
      if (step < 50_000n) step *= 2n;
    } catch (e) {
      // a rate limit is about requests per second, not the range: wait and try the same chunk again
      const msg = [e.shortMessage, e.details, e.message, e.cause?.details].filter(Boolean).join(" ");
      if (/rate limit|limit exceeded|exceeds defined limit|429|too many/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 3_000));
        if ((e._tries = (e._tries || 0) + 1) < 5 || step <= 100n) continue;
      }
      if (step <= 100n) throw e;
      step /= 4n;
    }
  }
  return { logs: out, next: start };
}

// LayerZero fees differ per chain and per day. When the endpoint says the native fee we sent
// is too low it tells us the required amount: `bump(required)` returns the params to retry
// with (default: the same call with 20% over the required fee).
async function send(c, what, params, bump) {
  log(`${DRY ? "[dry] " : ""}${c.chainId}: ${what}`);
  if (DRY) return true;
  try {
    let sim;
    // a message to several chains (finalize) can need a higher fee for each one in turn: ask
    // again until the fee covers them all (a few tries at most)
    for (let tries = 0; ; tries++) {
      try {
        sim = await c.pub.simulateContract({ account, ...params });
        break;
      } catch (e) {
        const d = e?.cause?.data ?? e?.data;
        if (d?.errorName !== "LZ_InsufficientFee" || params.value === undefined || tries >= 4) throw e;
        const required = BigInt(d.args[0]);
        const retry = bump ? bump(required) : { ...params, value: (required * 12n) / 10n };
        if (retry.value <= params.value) throw e; // never loops on the same fee
        log(`   LayerZero fee: sent ${params.value}, needs ${required}; retrying with ${retry.value}`);
        params = retry;
      }
    }
    const r = await sendAndWait(c, sim.request);
    if (r.status !== "success") throw new Error(`reverted ${r.transactionHash}`);
    log(`   ok ${r.transactionHash}`);
    return true;
  } catch (e) {
    log(`   failed: ${e.shortMessage || e.message}`);
    if (/still not mined/.test(e.message || "")) await alert("race keeper", `stuck-tx-${c.chainId}`, `A keeper transaction on chain ${c.chainId} is stuck: ${e.message}`);
    return false;
  }
}

/**
 * Sends a transaction and waits for it. One that isn't mined after 90 seconds (fees jumped)
 * is replaced: the same nonce again with 30% higher fees, up to three times, so it can never
 * hold up every transaction after it. Whichever of them is mined, its receipt is returned.
 */
export async function sendAndWait(c, request) {
  // a contract call (abi + functionName) or a plain transaction (to + data), e.g. a Relay swap
  const write = (req) => (!req.abi && req.data ? c.wallet.sendTransaction(req) : c.wallet.writeContract(req));
  const hashes = [await write(request)];
  for (let round = 0; ; round++) {
    try {
      return await c.pub.waitForTransactionReceipt({ hash: hashes[hashes.length - 1], timeout: 90_000 });
    } catch (e) {
      if (!/timed? ?out|Timeout/i.test(`${e?.name} ${e?.message}`)) throw e;
    }
    // an earlier one may have been mined meanwhile
    for (const h of hashes) {
      const done = await c.pub.getTransactionReceipt({ hash: h }).catch(() => null);
      if (done) return done;
    }
    if (round >= 3) throw new Error(`still not mined after ${hashes.length} tries (${hashes.join(", ")})`);
    const tx = await c.pub.getTransaction({ hash: hashes[hashes.length - 1] }).catch(() => null);
    if (!tx) continue; // not visible right now: wait once more
    const up = (v) => (v == null ? undefined : (v * 13n) / 10n + 1n); // a 0 tip goes up to 1 wei, never left to guess
    const fees = tx.maxFeePerGas ? { maxFeePerGas: up(tx.maxFeePerGas), maxPriorityFeePerGas: up(tx.maxPriorityFeePerGas) } : { gasPrice: up(tx.gasPrice) };
    try {
      hashes.push(await write({ ...request, nonce: tx.nonce, ...fees }));
      log(`   not mined after 90s: sent again with higher fees ${hashes[hashes.length - 1]}`);
    } catch (e) {
      // "nonce too low": one of them was mined just now (found on the next look)
      log(`   replacing the slow transaction failed (${e.shortMessage || e.message}); waiting on`);
    }
  }
}

async function raceState(c, coin) {
  if (c.builderKind === "pcs") {
    const r = await c.pub.readContract({ address: c.builder, abi: builderPcsAbi, functionName: "races", args: [coin] });
    return { state: Number(r[4]), feeMode: Number(r[2]), winnerEid: Number(r[5]) };
  }
  const r = await c.pub.readContract({ address: c.builder, abi: builderAbi, functionName: "races", args: [coin] });
  return { state: Number(r[5]), feeMode: Number(r[3]), winnerEid: Number(r[6]) };
}

const hasNativePair = (c) => c.builderKind === "eth" || c.builderKind === "pcs";

// ------------------------------------------------------------------ two-step routes

// Native gas in dollars with 18 decimals. Arc pays gas in USDC (18 decimals natively); the other
// chains in ETH / BNB, priced by the builder's Chainlink feed (8 decimals). null if unknown.
export async function gasUsd18(c, gasWei) {
  if (c.builderKind === "usdc") return gasWei;
  if (!c.feed || c.feed === zeroAddress) return null;
  const [, answer] = await c.pub.readContract({ address: c.feed, abi: priceFeedAbi, functionName: "latestRoundData" });
  if (answer <= 0n) return null;
  return (gasWei * answer) / 100_000_000n;
}

// An amount of the winner pool's money side in dollars: USDC on Arc-type builders, ETH / BNB
// (18 decimals) priced by the builder's Chainlink feed elsewhere. null when it can't be priced.
export async function moneyUsd(c, amount) {
  if (c.builderKind === "usdc") return Number(amount) / 10 ** Number(c.usdDecimals ?? 6);
  const p = await gasUsd18(c, amount); // same maths: native amount x feed price
  return p === null ? null : Number(p) / 1e18;
}

// Forward when the tip beats the gas by half again plus a tenth of a cent (L2 data fees, price moves).
export const tipCoversGas = (tipUsd18, gasUsd) => gasUsd !== null && tipUsd18 >= (gasUsd * 15n) / 10n + 1_000_000_000_000_000n;

// Sends on every hop waiting on this chain's Across bridge whose tip pays for its gas.
// state.hops[chainId] = first hop id not known to be forwarded (so finished ones are not read again).
export async function forwardHops(c, state, sendFn = send) {
  if (c.bridgeKind !== "across" || !c.bridge) return;
  state.hops ||= {};
  const count = Number(await c.pub.readContract({ address: c.bridge, abi: bridgeAbi, functionName: "hopsCount" }));
  let first = Number(state.hops[c.chainId] ?? 0);
  if (first >= count) return;
  const dec = Number(await c.pub.readContract({ address: c.bridge, abi: bridgeAbi, functionName: "tokenDecimals" }));
  let prefixDone = true; // every hop before i is forwarded: the cursor can move past i once it is too
  for (let i = first; i < count; i++) {
    if (!timeLeft()) break;
    const [coinId, finalEid, , forwarded, amount] = await c.pub.readContract({ address: c.bridge, abi: bridgeAbi, functionName: "hops", args: [BigInt(i)] });
    let done = forwarded;
    if (!done) done = await forwardOne(c, i, coinId, finalEid, amount, dec, sendFn);
    if (prefixDone && done) first = i + 1;
    else prefixDone = false;
  }
  state.hops[c.chainId] = String(first);
}

async function forwardOne(c, i, coinId, finalEid, amount, dec, sendFn) {
  const tip = await c.pub.readContract({ address: c.bridge, abi: bridgeAbi, functionName: "tipFor", args: [amount] });
  const params = { address: c.bridge, abi: bridgeAbi, functionName: "forwardHop", args: [BigInt(i)] };
  let gasUsd;
  try {
    const gas = await c.pub.estimateContractGas({ account, ...params });
    const price = await c.pub.getGasPrice();
    gasUsd = await gasUsd18(c, gas * price);
  } catch (e) {
    log(`${c.chainId}: hop ${i} gas estimate failed (${e.shortMessage || e.message}); next pass retries`);
    return false;
  }
  const tipUsd18 = tip * 10n ** BigInt(18 - dec);
  if (!tipCoversGas(tipUsd18, gasUsd)) {
    log(`${c.chainId}: hop ${i} (${amount} to eid ${finalEid}) waits: its tip ${tip} doesn't cover the gas`);
    return false;
  }
  return sendFn(c, `forward hop ${i} of ${String(coinId).slice(0, 10)}: ${amount} to eid ${finalEid} (tip ${tip})`, params);
}

// ------------------------------------------------------------------ fee vault

// sasa's fee vault on each chain (the race contracts' treasury) is split at least every
// VAULT_MINUTES (default 60) once it holds VAULT_MIN_USD (default $5): 10% to this keeper (its
// gas), 10% to the rewards wallet, 80% to the treasury. Race coins it receives stay in it until
// the treasury sweeps them (sending them costs more gas than most are worth).
const VAULT_MS = Number(env("VAULT_MINUTES", "60")) * 60_000;
const VAULT_MIN_USD = Number(env("VAULT_MIN_USD", "5"));

/** Dollars held by the vault: the chain's coin (priced by the feed; Arc's is USDC) + the dollar. */
export async function vaultUsd(c) {
  const [nat, dol] = await Promise.all([
    c.pub.getBalance({ address: c.feeVault }),
    c.pub.readContract({ address: c.usd, abi: balAbi, functionName: "balanceOf", args: [c.feeVault] }),
  ]);
  // on Arc the chain's coin and the dollar are the same money: count it once
  if (c.builderKind === "usdc") return Number(nat) / 1e18;
  const natUsd18 = nat > 0n ? await gasUsd18(c, nat) : 0n;
  if (natUsd18 === null) return null;
  return Number(natUsd18) / 1e18 + Number(dol) / 10 ** Number(c.usdDecimals ?? 6);
}

export async function vaultPass(c, state, sendFn = send, now = Date.now()) {
  if (!c.feeVault || c.feeVault === zeroAddress) return false;
  state.vault ||= {};
  if (now - Number(state.vault[c.chainId] ?? 0) < VAULT_MS) return false;
  const usd = await vaultUsd(c);
  state.vault[c.chainId] = now;
  if (usd === null || usd < VAULT_MIN_USD) return false;
  return sendFn(c, `split the fee vault ($${usd.toFixed(2)}: 10% keeper, 10% rewards, 80% treasury)`, { address: c.feeVault, abi: vaultAbi, functionName: "distribute" });
}

// ------------------------------------------------------------------ one pass

async function main() {
  const chains = loadChains();
  if (chains.length === 0) throw new Error("no chains configured");
  await heartbeat("race-keeper", "pass started");
  const byEid = new Map(chains.map((c) => [c.eid, c]));
  // gas: the race fees arrive here as USDC; when ETH / BNB runs low a few are swapped into it
  for (const c of chains) {
    const res = await refillGas(c, account, {
      send: sendAndWait,
      log,
      env: DRY ? { ...process.env, GAS_REFILL: "false" } : process.env,
    }).catch((e) => `alert:keeper gas check on chain ${c.chainId} failed (${e.shortMessage || e.message})`);
    if (res.startsWith("alert:")) await alert("race keeper", `gas-${c.chainId}`, res.slice(6));
  }
  // Testnets with no Chainlink use our TestFeed: anyone may refresh its timestamp, and the
  // builders refuse a feed older than maxFeedAge, so keep it fresh (never runs on a mainnet).
  for (const c of chains) {
    if (!c.feedIsTest || !c.feed) continue;
    try {
      const [, , , updatedAt] = await c.pub.readContract({ address: c.feed, abi: testFeedAbi, functionName: "latestRoundData" });
      const age = BigInt(Math.floor(Date.now() / 1000)) - updatedAt;
      if (age > BigInt(c.maxFeedAge ?? 7200) / 2n) await send(c, "touch the test price feed", { address: c.feed, abi: testFeedAbi, functionName: "touch" });
    } catch (e) {
      log(`${c.chainId}: test feed check failed: ${e.shortMessage || e.message}`);
    }
  }
  const state = readState(STATE_FILE, log);

  // Discover launches (each chain lists the coins launched there).
  // One chain's RPC being down or rate-limited must not stop the others: skip it this pass.
  for (const c of chains) {
    try {
      const latest = await c.pub.getBlockNumber();
      const floor = BigInt(env(`RACE_FROM_${c.chainId}`, "0"));
      let from = BigInt(state.cursor[c.chainId] ?? c.startBlock);
      if (from < floor) from = floor;
      if (from > latest) continue;
      const { logs, next } = await scan(c.pub, { address: c.factory, event: launched }, from, latest);
      for (const l of logs) {
        const id = l.args.coinId;
        const coin = (state.coins[id] ||= { coin: l.args.coin, eids: l.args.eids.map(Number), name: l.args.name, creator: l.args.creator, feeMode: Number(l.args.feeMode), launchedAt: null, chains: {} });
        coin.chains[c.eid] = { seat: l.args.seat, block: Number(l.blockNumber) };
      }
      state.cursor[c.chainId] = next.toString();
      if (logs.length) log(`${c.chainId}: ${logs.length} launches found`);
    } catch (e) {
      log(`${c.chainId}: launch scan failed this pass (${e.shortMessage || e.message}); continuing with the other chains`);
    }
  }
  log(`${Object.keys(state.coins).length} v7 coins known`);

  let coordEid = null;
  for (const c of chains) {
    try { coordEid = Number(await c.pub.readContract({ address: c.hub, abi: hubAbi, functionName: "coordEid" })); break; } catch {}
  }
  const coord = coordEid === null ? null : byEid.get(coordEid);
  if (!coord) throw new Error("the coordinator chain is not configured (or no RPC answered)");

  // Money waiting halfway on a two-step route goes first: it is already late.
  for (const c of chains) {
    try {
      await forwardHops(c, state);
    } catch (e) {
      log(`${c.chainId}: hop check failed this pass (${e.shortMessage || e.message})`);
    }
  }

  for (const [id, coin] of Object.entries(state.coins)) {
    if (!timeLeft()) { log("time budget spent; the next run continues"); break; }
    try {
      await handleCoin(id, coin);
    } catch (e) {
      log(`${coin.name} (${id.slice(0, 10)}): skipped this pass: ${e.shortMessage || e.message}`);
    }
  }
  for (const c of chains) {
    if (!timeLeft()) break;
    try {
      await vaultPass(c, state);
    } catch (e) {
      log(`${c.chainId}: fee vault check failed this pass (${e.shortMessage || e.message})`);
      await alert("race keeper", `vault-${c.chainId}`, `splitting the fee vault on chain ${c.chainId} failed: ${e.shortMessage || e.message}`);
    }
  }
  if (!DRY) writeState(STATE_FILE, state);
  await heartbeat("race-keeper", `${Object.keys(state.coins).length} coins`);
  // the indexer feeds the site: tell the admin if it went quiet
  const quiet = await staleServices(["indexer"], 15).catch(() => []);
  if (quiet.length) await alert("race keeper", "indexer-quiet", `the indexer hasn't reported for 15+ minutes; check it on Railway.`);
  log("pass done");

  // Everything one coin needs in one pass. Throws only on RPC trouble; the next pass retries.
  async function handleCoin(id, coin) {
    const win = coin.winner !== undefined ? byEid.get(coin.winner) : null;

    // ---- after the race: fees and buybacks on the winner, every COLLECT_MINUTES if it traded
    if (coin.finished) {
      const since = Date.now() - (coin.lastCollect ?? 0);
      if (win && since > COLLECT_MS) {
        // Any trade moves the pool's price, so the launch position's amounts change.
        const [a, b] = await win.pub.readContract({ address: win.builder, abi: builderAbi, functionName: "poolAmounts", args: [coin.coin] });
        const snap = `${a}:${b}`;
        if (snap !== coin.lastPoolSnap || since > IDLE_COLLECT_MS) {
          const params = { address: win.builder, abi: builderAbi, functionName: "collectFees", args: [coin.coin] };
          // what collecting would bring in now (money side); small amounts wait, at most a day
          let usd = null;
          try {
            const { result } = await win.pub.simulateContract({ account, ...params });
            usd = await moneyUsd(win, result[0]);
          } catch {}
          const sinceAny = Date.now() - (coin.lastCollectDone ?? coin.lastCollect ?? 0);
          if ((usd !== null && usd >= MIN_COLLECT_USD) || sinceAny > IDLE_COLLECT_MS) {
            const ok = await send(win, `collect pool fees of ${coin.name}${usd !== null ? ` (~$${usd.toFixed(2)})` : ""}`, params);
            if (ok && !DRY) coin.lastCollectDone = Date.now();
          } else log(`${coin.name}: fees waiting (~$${usd === null ? "?" : usd.toFixed(2)}), below $${MIN_COLLECT_USD}`);
          if (!DRY) {
            coin.lastCollect = Date.now();
            coin.lastPoolSnap = snap;
          }
        }
      }
      if (win && coin.feeMode === 1) {
        const bb = await win.pub.readContract({ address: win.builder, abi: builderAbi, functionName: "buybackFunds", args: [coin.coin] });
        if (bb > 0n) {
          const usd = await moneyUsd(win, bb).catch(() => null);
          if (!DRY) coin.lastBuyback ??= Date.now() - IDLE_COLLECT_MS / 2; // a first small amount waits half a day at most
          const sinceBb = Date.now() - (coin.lastBuyback ?? 0);
          if ((usd !== null && usd >= MIN_COLLECT_USD) || sinceBb > IDLE_COLLECT_MS) {
            // the contract takes a minimum: what a dry run gives now, less 2% (nobody can push the
            // price up around the buyback and sell into it)
            let min = null;
            let old = false;
            try {
              const { result } = await win.pub.simulateContract({ account, address: win.builder, abi: builderAbi, functionName: "buyback", args: [coin.coin, 1n] });
              min = (result[1] * 98n) / 100n;
            } catch (e) {
              // builders deployed before the keeper-only buyback (the testnet's) have buyback(coin)
              old = await win.pub
                .simulateContract({ account, address: win.builder, abi: oldBuybackAbi, functionName: "buyback", args: [coin.coin] })
                .then(() => true)
                .catch(() => false);
              if (!old) log(`${win.chainId}: buyback dry run for ${coin.name} failed (${e.shortMessage || e.message})`);
            }
            if ((min !== null && min > 0n) || old) {
              const params = old
                ? { address: win.builder, abi: oldBuybackAbi, functionName: "buyback", args: [coin.coin] }
                : { address: win.builder, abi: builderAbi, functionName: "buyback", args: [coin.coin, min] };
              const ok = await send(win, `buyback ${coin.name} (${bb} waiting)`, params);
              if (ok && !DRY) coin.lastBuyback = Date.now();
            }
          }
        }
      }
      return;
    }

    const here = coin.eids.filter((e) => byEid.has(e) && coin.chains[e]);
    coin.seenAt ??= Date.now();
    if (here.length !== coin.eids.length) {
      // not launched (or not configured) on every chain yet. A creator who never sends the other
      // launches leaves the race unable to finish: say so once it's clearly not just slow.
      if (Date.now() - coin.seenAt > 30 * 60_000) {
        const missing = coin.eids.filter((e) => !coin.chains[e] || !byEid.has(e));
        await alert("race keeper", `partial-${id}`, `${coin.name} was launched on only some of its chains (missing ${missing.join(", ")}) for over 30 minutes: its race can't finish until the rest launch.`);
      }
      return;
    }
    const reads = await Promise.all(
      here.map(async (e) => {
        const c = byEid.get(e);
        const seat = coin.chains[e].seat;
        const [over, reported, rs] = await Promise.all([
          c.pub.readContract({ address: c.builder, abi: builderAbi, functionName: "raceOver", args: [coin.coin] }),
          c.pub.readContract({ address: seat, abi: seatAbi, functionName: "reported" }),
          raceState(c, coin.coin),
        ]);
        return { e, c, seat, over, reported, ...rs };
      })
    );
    const anySettled = reads.some((r) => r.state === WON || r.state === LOST);

    // A race takes five minutes; frozen (reported, no verdict) for more than 30 minutes means trouble.
    if (!anySettled && reads.some((r) => r.reported)) {
      coin.frozenSince ??= Date.now();
      if (Date.now() - coin.frozenSince > 30 * 60_000) await alert("race keeper", `stuck-${id}`, `${coin.name}'s race has been waiting for its verdict for over 30 minutes. Check the keeper log.`);
    } else delete coin.frozenSince;
    // over everywhere but nobody reported for 20 minutes: freezing keeps failing
    if (!anySettled && reads.every((r) => r.over) && !reads.some((r) => r.reported)) {
      coin.overSince ??= Date.now();
      if (Date.now() - coin.overSince > 20 * 60_000) await alert("race keeper", `nofreeze-${id}`, `${coin.name}'s race ended over 20 minutes ago but no chain has reported. Check the keeper's balance and log.`);
    } else delete coin.overSince;

    // 1. freeze: every chain reports once its five minutes are over
    if (!anySettled) {
      for (const r of reads.filter((x) => x.state === RACING && !x.reported && x.over)) {
        const remote = r.c.eid !== coord.eid && coin.eids.length > 1;
        await send(r.c, `freeze ${coin.name}: five minutes over, report`, {
          address: r.c.hub, abi: hubAbi, functionName: "freeze", args: [id, remote ? lzOptions(300_000) : "0x"], value: remote ? lzFee(r.c) : 0n,
        });
      }
      // 2. finalize on the coordinator once every report is in
      const [ready, graduate, winner] = await coord.pub.readContract({ address: coord.hub, abi: hubAbi, functionName: "preview", args: [id] });
      if (ready) {
        const remotes = coin.eids.filter((e) => e !== coord.eid).length;
        const fin = (perChain) => ({
          address: coord.hub, abi: hubAbi, functionName: "finalize", args: [id, perChain, lzOptions(900_000)], value: perChain * BigInt(remotes),
        });
        await send(coord, `finalize ${coin.name}: ${graduate ? `winner ${winner}` : "no winner (reopen)"}`, fin(lzFee(coord)), (req) => fin((req * 12n) / 10n));
      }
      return;
    }

    // the verdict: winner from any settled seat
    const settled = reads.find((r) => r.state === WON || r.state === LOST);
    const winnerEid = Number(await settled.c.pub.readContract({ address: settled.seat, abi: seatAbi, functionName: "winnerEid" }));
    const winner = byEid.get(winnerEid);
    coin.winner = winnerEid;

    // 3. losing chains: BNB/ETH still waiting for a fair price -> convert; dollars -> forward
    let allHandedOver = true;
    for (const r of reads.filter((x) => x.e !== winnerEid)) {
      if (r.state === RACING) {
        // its verdict message is still on the way; for over 30 minutes means it is stuck
        allHandedOver = false;
        coin.verdictLate ??= {};
        coin.verdictLate[r.e] ??= Date.now();
        if (Date.now() - coin.verdictLate[r.e] > 30 * 60_000) await alert("race keeper", `verdict-${id}-${r.e}`, `${coin.name}: chain ${r.e} still hasn't received the race verdict after 30 minutes (LayerZero message stuck?).`);
        continue;
      }
      if (hasNativePair(r.c)) {
        const lost = await r.c.pub.readContract({ address: r.c.builder, abi: builderAbi, functionName: "lostPending", args: [coin.coin] });
        if (lost > 0n) {
          const ok = await send(r.c, `convert ${coin.name}'s waiting ${lost} native to dollars`, { address: r.c.builder, abi: builderAbi, functionName: "convertLost", args: [coin.coin, 0n] });
          if (!ok) allHandedOver = false;
        }
      }
      const [pool, bb] = await Promise.all([
        r.c.pub.readContract({ address: r.c.consolidator, abi: consAbi, functionName: "pendingPool", args: [id] }),
        r.c.pub.readContract({ address: r.c.consolidator, abi: consAbi, functionName: "pendingBuyback", args: [id] }),
      ]);
      if (pool + bb > 0n) {
        const msgs = (pool > 0n ? 1n : 0n) + (bb > 0n ? 1n : 0n);
        const fwd = (per) => ({ address: r.c.consolidator, abi: consAbi, functionName: "forward", args: [id], value: per * msgs });
        const ok = await send(r.c, `forward ${coin.name}: ${pool} pool + ${bb} buyback to ${winnerEid}`, fwd(lzFee(r.c)), (req) => fwd((req * 12n) / 10n));
        if (!ok) allHandedOver = false;
      }
    }

    // 4. the winner: arrived dollars that could not be placed yet
    if (winner && hasNativePair(winner)) {
      const pend = await winner.pub.readContract({ address: winner.builder, abi: builderAbi, functionName: "pendingDollars", args: [coin.coin] });
      if (pend > 0n) await send(winner, `place ${coin.name}'s arrived ${pend} dollars into the pool`, { address: winner.builder, abi: builderAbi, functionName: "convertPending", args: [coin.coin] });
    }

    // 5. move holders on losing chains (each to the same address on the winner)
    let allMoved = true;
    for (const r of reads.filter((x) => x.e !== winnerEid)) {
      const open = await r.c.pub.readContract({ address: coin.coin, abi: coinAbi, functionName: "bridgeOpen" });
      if (!open) { allMoved = false; continue; }
      const latest = await r.c.pub.getBlockNumber();
      // from where the last complete pass got to (holders found before were moved then; a new
      // transfer to any of them shows up again in the new blocks)
      const from = BigInt(coin.chains[r.e].moveFrom ?? coin.chains[r.e].block);
      const { logs, next } = await scan(r.c.pub, { address: coin.coin, event: transferEvt }, from, latest);
      let passOk = true;
      if (next <= latest) allMoved = false; // the scan stopped early (time budget): not finished yet
      const seen = [...new Set(logs.map((l) => l.args.to).filter((a) => a && a !== zeroAddress))];
      const movable = [];
      for (const h of seen) {
        const [bal, plain] = await Promise.all([
          r.c.pub.readContract({ address: coin.coin, abi: coinAbi, functionName: "balanceOf", args: [h] }),
          r.c.pub.readContract({ address: coin.coin, abi: coinAbi, functionName: "isPlainAccount", args: [h] }),
        ]);
        if (bal >= 1_000_000_000_000n && plain) movable.push(h); // more than dust (1e-6 coin)
      }
      for (let i = 0; i < movable.length; i += 100) {
        const batch = movable.slice(i, i + 100);
        const gas = 120_000 + 45_000 * batch.length;
        const mv = (v) => ({ address: coin.coin, abi: coinAbi, functionName: "moveBatch", args: [batch, lzOptions(gas)], value: v });
        const ok = await send(r.c, `move ${batch.length} holders of ${coin.name} to ${winnerEid}`, mv(lzFee(r.c) * 2n), (req) => mv((req * 12n) / 10n));
        if (!ok) {
          allMoved = false;
          passOk = false;
        }
      }
      // every holder found so far was moved: the next pass starts where this scan ended
      if (passOk && !DRY) coin.chains[r.e].moveFrom = next.toString();
    }

    // A coin is finished once every losing chain handed over and nothing is left to move.
    // (Arrivals on the winner are placed by the bridge itself; step 4 only retries.)
    if (allHandedOver && allMoved && winner && !DRY) {
      coin.finished = true;
      log(`${coin.name}: race finished, winner ${winnerEid}`);
    }
  }

}

const LOOP_SECONDS = Number(env("LOOP_SECONDS", "0"));

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (LOOP_SECONDS > 0) {
    (async () => {
      log(`race keeper: looping every ${LOOP_SECONDS}s`);
      let failures = 0;
      for (;;) {
        STARTED = Date.now();
        await main()
          .then(() => (failures = 0))
          .catch(async (e) => {
            failures += 1;
            log(`pass failed: ${e?.shortMessage ?? e?.message ?? e}`);
            if (failures >= 3) await alert("race keeper", "pass", `${failures} passes in a row failed: ${e?.shortMessage ?? e?.message ?? e}`);
          });
        await new Promise((r) => setTimeout(r, LOOP_SECONDS * 1000));
      }
    })();
  } else {
    main().catch((e) => {
      console.error(e);
      process.exit(1);
    });
  }
}
