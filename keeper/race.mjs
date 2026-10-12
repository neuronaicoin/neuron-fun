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
//   6. after the race, on the winner: collect fees, buybacks
//
// The keeper cannot pick a winner or move money anywhere else: the coordinator decides
// on-chain, and money/coins can only go to the places fixed in the contracts.
//
// Env:
//   PRIVATE_KEY    the hubs' keeper key
//   DEPLOYMENTS    folder with <chainId>.json from DeployRace (default ../contracts-v7/deployments/race)
//   RPC_<chainId>  RPC URL(s) per chain, comma-separated for fallback (e.g. RPC_84532)
//   STATE_FILE     where scan progress is kept between runs (default ./race-state.json)
//   DRY_RUN        "true": decide and log, send nothing
//   LZ_FEE_WEI     native sent per LayerZero message; the unused part is refunded (default 0.0003);
//                  LZ_FEE_WEI_<chainId> overrides it for one chain
//   LOOP_SECONDS   run forever, one pass every N seconds (default: one pass, then exit)

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, fallback, http, parseAbi, parseAbiItem, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { alert } from "./alert.mjs";

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
const COLLECT_MS = Number(env("COLLECT_HOURS", "6")) * 3_600_000;
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
  "function buyback(address coin) returns (uint256 spent, uint256 burned)",
  "function pendingDollars(address coin) view returns (uint256)",
  "function convertPending(address coin)",
  "function lostPending(address coin) view returns (uint256)",
  "function convertLost(address coin, uint256 amount) returns (uint256)",
]);
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
    try {
      sim = await c.pub.simulateContract({ account, ...params });
    } catch (e) {
      const d = e?.cause?.data ?? e?.data;
      if (d?.errorName !== "LZ_InsufficientFee" || params.value === undefined) throw e;
      const required = BigInt(d.args[0]);
      const retry = bump ? bump(required) : { ...params, value: (required * 12n) / 10n };
      log(`   LayerZero fee: sent ${params.value}, needs ${required}; retrying with ${retry.value}`);
      params = retry;
      sim = await c.pub.simulateContract({ account, ...params });
    }
    const hash = await c.wallet.writeContract(sim.request);
    const r = await c.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`reverted ${hash}`);
    log(`   ok ${hash}`);
    return true;
  } catch (e) {
    log(`   failed: ${e.shortMessage || e.message}`);
    return false;
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

// ------------------------------------------------------------------ one pass

async function main() {
  const chains = loadChains();
  if (chains.length === 0) throw new Error("no chains configured");
  const byEid = new Map(chains.map((c) => [c.eid, c]));
  for (const c of chains) {
    const bal = await c.pub.getBalance({ address: account.address }).catch(() => null);
    if (bal !== null && bal < BigInt(env("MIN_GAS_WEI", "2000000000000000"))) {
      await alert("race keeper", `gas-${c.chainId}`, `keeper wallet ${account.address} is low on gas on chain ${c.chainId} (${Number(bal) / 1e18}). Top it up.`);
    }
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
  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { cursor: {}, coins: {} };

  // Discover launches (each chain lists the coins launched there).
  for (const c of chains) {
    const latest = await c.pub.getBlockNumber();
    const from = BigInt(state.cursor[c.chainId] ?? c.startBlock);
    if (from > latest) continue;
    const { logs, next } = await scan(c.pub, { address: c.factory, event: launched }, from, latest);
    for (const l of logs) {
      const id = l.args.coinId;
      const coin = (state.coins[id] ||= { coin: l.args.coin, eids: l.args.eids.map(Number), name: l.args.name, creator: l.args.creator, feeMode: Number(l.args.feeMode), launchedAt: null, chains: {} });
      coin.chains[c.eid] = { seat: l.args.seat, block: Number(l.blockNumber) };
    }
    state.cursor[c.chainId] = next.toString();
    if (logs.length) log(`${c.chainId}: ${logs.length} launches found`);
  }
  log(`${Object.keys(state.coins).length} v7 coins known`);

  const coord = byEid.get(Number(await chains[0].pub.readContract({ address: chains[0].hub, abi: hubAbi, functionName: "coordEid" })));
  if (!coord) throw new Error("the coordinator chain is not configured");

  for (const [id, coin] of Object.entries(state.coins)) {
    if (!timeLeft()) { log("time budget spent; the next run continues"); break; }
    const win = coin.winner !== undefined ? byEid.get(coin.winner) : null;

    // ---- after the race: fees and buybacks on the winner, every COLLECT_HOURS
    if (coin.finished) {
      if (win && Date.now() - (coin.lastCollect ?? 0) > COLLECT_MS) {
        await send(win, `collect pool fees of ${coin.name}`, { address: win.builder, abi: builderAbi, functionName: "collectFees", args: [coin.coin] });
        if (!DRY) coin.lastCollect = Date.now();
      }
      if (win && coin.feeMode === 1) {
        const bb = await win.pub.readContract({ address: win.builder, abi: builderAbi, functionName: "buybackFunds", args: [coin.coin] });
        if (bb > 0n) await send(win, `buyback ${coin.name} (${bb} waiting)`, { address: win.builder, abi: builderAbi, functionName: "buyback", args: [coin.coin] });
      }
      continue;
    }

    const here = coin.eids.filter((e) => byEid.has(e) && coin.chains[e]);
    if (here.length !== coin.eids.length) continue; // not launched (or not configured) on every chain yet
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
      continue;
    }

    // the verdict: winner from any settled seat
    const settled = reads.find((r) => r.state === WON || r.state === LOST);
    const winnerEid = Number(await settled.c.pub.readContract({ address: settled.seat, abi: seatAbi, functionName: "winnerEid" }));
    const winner = byEid.get(winnerEid);
    coin.winner = winnerEid;

    // 3. losing chains: BNB/ETH still waiting for a fair price -> convert; dollars -> forward
    let allHandedOver = true;
    for (const r of reads.filter((x) => x.e !== winnerEid)) {
      if (r.state === RACING) { allHandedOver = false; continue; } // its verdict message is still on the way
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
      const { logs } = await scan(r.c.pub, { address: coin.coin, event: transferEvt }, BigInt(coin.chains[r.e].block), latest);
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
        if (!ok) allMoved = false;
      }
    }

    // A coin is finished once every losing chain handed over and nothing is left to move.
    // (Arrivals on the winner are placed by the bridge itself; step 4 only retries.)
    if (allHandedOver && allMoved && winner && !DRY) {
      coin.finished = true;
      log(`${coin.name}: race finished, winner ${winnerEid}`);
    }
  }

  if (!DRY) writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  log("pass done");
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
