// sasa v6 (omnichain coins) keeper. One pass per run; schedule it every few minutes.
//
// Every pass looks at every v6 coin and does the next step that is due. Each step
// is safe to repeat and the contracts check everything again, so a pass that stops
// half-way, or two passes at once, can do no harm:
//
//   1. total raised over all chains >= target, a curve still trading  -> freeze it
//   2. the coordinator has every chain's report                       -> finalize
//   3. a losing chain holds the coin's money (or buyback money)       -> forward it
//   4. the winning chain's migrator has the money                     -> open the pool
//   5. after graduation, holders on losing chains                     -> move their coins
//
// The keeper cannot pick a winner or move money anywhere else: the coordinator
// decides on-chain, and money/coins can only go to the places fixed in the contracts.
//
// Env:
//   PRIVATE_KEY   the hubs' keeper key
//   DEPLOYMENTS   folder with <chainId>.json from DeployOmni (default ../contracts/deployments/omni)
//   RPC_<chainId> RPC URL per chain (e.g. RPC_46630, RPC_84532)
//   STATE_FILE    where scan progress is kept between runs (default ./omni-state.json)
//   DRY_RUN       "true": decide and log, send nothing
//   LZ_FEE_WEI    native sent per LayerZero message; the unused part is refunded (default 0.0003 ETH)

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { alert } from "./alert.mjs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseAbiItem, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

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
const DEPLOYMENTS = env("DEPLOYMENTS", "../contracts/deployments/omni");
const STATE_FILE = env("STATE_FILE", "./omni-state.json");
const LZ_FEE = BigInt(env("LZ_FEE_WEI", "300000000000000"));
// Graduated pools earn trading fees in Uniswap: collect them into the fee split this often.
const COLLECT_MS = Number(env("COLLECT_HOURS", "6")) * 3_600_000;
// Stop starting new work after this long, save progress and let the next run continue.
const BUDGET_MS = Number(env("BUDGET_MS", String(9 * 60_000)));
let STARTED = Date.now();
const timeLeft = () => Date.now() - STARTED < BUDGET_MS;
let key = env("PRIVATE_KEY").trim();
if (!key.startsWith("0x")) key = `0x${key}`;
const account = privateKeyToAccount(key);

// LayerZero executor option (type 3): gas for the receiving side.
export const lzOptions = (gas) => `0x000301001101${BigInt(gas).toString(16).padStart(32, "0")}`;

const launched = parseAbiItem(
  "event Launched(bytes32 indexed coinId, address indexed coin, address indexed curve, address creator, uint32[] eids, string name, string symbol, string logo, string description, uint256 lockSeconds, uint8 feeMode)"
);
const transferEvt = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const hubAbi = parseAbi([
  "function freeze(bytes32 coin, bytes options) payable",
  "function finalize(bytes32 coin, uint256 feePerChain, bytes options) payable",
  "function preview(bytes32 coin) view returns (bool ready, bool graduate, uint32 winner, uint256 total, uint256 poolTokens)",
  "function localOf(bytes32 coin) view returns (address curve, uint256 target, uint64 round, uint32[] eids)",
  "function coordEid() view returns (uint32)",
  "function keeper() view returns (address)",
]);
const curveAbi = parseAbi([
  "function state() view returns (uint8)",
  "function realNative() view returns (uint256)",
  "function won() view returns (bool)",
  "function winnerEid() view returns (uint32)",
]);
const consAbi = parseAbi([
  "function pendingPool(bytes32) view returns (uint256)",
  "function pendingBuyback(bytes32) view returns (uint256)",
  "function forward(bytes32 coin) payable",
]);
const migAbi = parseAbi([
  "function ready(bytes32) view returns (bool)",
  "function open(bytes32 coin)",
  "function collectFees(address token) returns (uint256 usdcFees, uint256 tokenFees)",
  "function grads(bytes32) view returns (address token, bool known, bool opened, uint64 deadline, address creator, uint8 feeMode, uint256 expected, uint256 received, uint256 tokens)",
]);
const coinAbi = parseAbi([
  "function bridgeOpen() view returns (bool)",
  "function homeEid() view returns (uint32)",
  "function balanceOf(address) view returns (uint256)",
  "function isPlainAccount(address) view returns (bool)",
  "function moveBatch(address[] holders, bytes options) payable",
]);
const TRADING = 0;
const FROZEN = 1;
const SETTLED = 2;

// ------------------------------------------------------------------ chains

function loadChains() {
  const out = [];
  for (const f of readdirSync(DEPLOYMENTS).filter((x) => /^\d+\.json$/.test(x))) {
    const d = JSON.parse(readFileSync(join(DEPLOYMENTS, f), "utf8"));
    const rpc = process.env[`RPC_${d.chainId}`];
    if (!rpc) {
      log(`skip chain ${d.chainId}: no RPC_${d.chainId}`);
      continue;
    }
    const chain = defineChain({ id: Number(d.chainId), name: `c${d.chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    out.push({
      ...d,
      eid: Number(d.eid),
      pub: createPublicClient({ chain, transport: http(rpc, { retryCount: 2, timeout: 20_000 }) }),
      wallet: createWalletClient({ chain, account, transport: http(rpc, { retryCount: 1, timeout: 30_000 }) }),
    });
  }
  return out;
}

// Reads logs in chunks (public RPCs limit the range). onChunk(end) lets the caller save
// progress; stops early when the run's time budget is spent and returns where it stopped.
async function scan(pub, args, from, to, onChunk) {
  const out = [];
  let step = 2_000n;
  let start = from;
  while (start <= to) {
    if (!timeLeft()) break;
    const end = start + step - 1n > to ? to : start + step - 1n;
    try {
      out.push(...(await pub.getLogs({ ...args, fromBlock: start, toBlock: end })));
      if (onChunk) onChunk(end);
      start = end + 1n;
      if (step < 50_000n) step *= 2n;
    } catch (e) {
      if (step <= 100n) throw e;
      step /= 4n;
    }
  }
  return { logs: out, next: start };
}

async function send(c, what, params) {
  log(`${DRY ? "[dry] " : ""}${c.chainId}: ${what}`);
  if (DRY) return true;
  try {
    const sim = await c.pub.simulateContract({ account, ...params });
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

// ------------------------------------------------------------------ one pass

async function main() {
  const chains = loadChains();
  if (chains.length === 0) throw new Error("no chains configured");
  const byEid = new Map(chains.map((c) => [c.eid, c]));
  // Gas for the keeper itself: warn early, a stuck keeper stops graduations.
  for (const c of chains) {
    const bal = await c.pub.getBalance({ address: account.address }).catch(() => null);
    if (bal !== null && bal < BigInt(env("MIN_GAS_WEI", "2000000000000000"))) {
      await alert("keeper", `gas-${c.chainId}`, `keeper wallet ${account.address} is low on ETH on chain ${c.chainId} (${Number(bal) / 1e18} ETH). Top it up.`);
    }
  }
  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { cursor: {}, coins: {} };

  // Discover launches (each chain lists the coins launched there). Progress is kept per
  // chunk, so a long gap is caught up over a few runs.
  for (const c of chains) {
    const latest = await c.pub.getBlockNumber();
    const from = BigInt(state.cursor[c.chainId] ?? c.startBlock);
    if (from > latest) continue;
    log(`${c.chainId}: scanning launches ${from}..${latest} (${latest - from + 1n} blocks)`);
    const { logs, next } = await scan(c.pub, { address: c.factory, event: launched }, from, latest);
    for (const l of logs) {
      const id = l.args.coinId;
      const coin = (state.coins[id] ||= { coin: l.args.coin, eids: l.args.eids.map(Number), name: l.args.name, chains: {} });
      coin.chains[c.eid] = { curve: l.args.curve, block: Number(l.blockNumber), done: false };
    }
    state.cursor[c.chainId] = next.toString();
    log(`${c.chainId}: ${logs.length} launches found, next block ${next}`);
  }
  log(`${Object.keys(state.coins).length} v6 coins known`);

  for (const [id, coin] of Object.entries(state.coins)) {
    if (coin.finished) {
      // Pool fees: creator / buyback share and sasa's share (to the fee splitter).
      const win = coin.winner !== undefined ? byEid.get(coin.winner) : null;
      if (win && timeLeft() && Date.now() - (coin.lastCollect ?? 0) > COLLECT_MS) {
        const ok = await send(win, `collect pool fees of ${coin.name}`, {
          address: win.migrator, abi: migAbi, functionName: "collectFees", args: [coin.coin],
        });
        if (!DRY) coin.lastCollect = Date.now(); // success or not, try again in COLLECT_HOURS (ok: ${ok})
      }
      continue;
    }
    if (!timeLeft()) { log("time budget spent; the next run continues"); break; }
    log(`coin ${coin.name} ${id.slice(0, 10)}…`);
    const here = coin.eids.filter((e) => byEid.has(e) && coin.chains[e]);
    if (here.length !== coin.eids.length) continue; // not launched (or not configured) on every chain yet
    const reads = await Promise.all(
      here.map(async (e) => {
        const c = byEid.get(e);
        const curve = coin.chains[e].curve;
        const [st, money] = await Promise.all([
          c.pub.readContract({ address: curve, abi: curveAbi, functionName: "state" }),
          c.pub.readContract({ address: curve, abi: curveAbi, functionName: "realNative" }),
        ]);
        return { e, c, curve, st: Number(st), money };
      })
    );
    const coord = byEid.get(Number(await chains[0].pub.readContract({ address: chains[0].hub, abi: hubAbi, functionName: "coordEid" })));
    if (!coord) continue;
    // The target as registered with the coin (same on every chain it launched on).
    const [, target] = await reads[0].c.pub.readContract({ address: reads[0].c.hub, abi: hubAbi, functionName: "localOf", args: [id] });
    const total = reads.reduce((s, r) => s + r.money, 0n);
    const anySettled = reads.some((r) => r.st === SETTLED);

    // A graduation should finish in minutes; frozen for more than 30 minutes means trouble.
    if (reads.some((r) => r.st === FROZEN)) {
      coin.frozenSince ??= Date.now();
      if (Date.now() - coin.frozenSince > 30 * 60_000) await alert("keeper", `stuck-${id}`, `${coin.name} has been graduating for over 30 minutes. Check the keeper log.`);
    } else delete coin.frozenSince;

    // 1. freeze
    if (!anySettled && total >= target) {
      for (const r of reads.filter((x) => x.st === TRADING)) {
        // A coin on one chain only is decided right inside its freeze: no message, no fee.
        const remote = r.c.eid !== coord.eid && coin.eids.length > 1;
        await send(r.c, `freeze ${coin.name} (total ${total} >= ${target})`, {
          address: r.c.hub, abi: hubAbi, functionName: "freeze", args: [id, remote ? lzOptions(300_000) : "0x"], value: remote ? LZ_FEE : 0n,
        });
      }
    }

    // 2. finalize on the coordinator once every report is in
    if (!anySettled) {
      const [ready, graduate, winner] = await coord.pub.readContract({ address: coord.hub, abi: hubAbi, functionName: "preview", args: [id] });
      if (ready) {
        const remotes = coin.eids.filter((e) => e !== coord.eid).length;
        await send(coord, `finalize ${coin.name}: ${graduate ? `graduates, winner ${winner}` : "short of target, reopen"}`, {
          address: coord.hub, abi: hubAbi, functionName: "finalize", args: [id, LZ_FEE, lzOptions(900_000)], value: LZ_FEE * BigInt(remotes),
        });
      }
      continue;
    }

    // 3. losing chains forward their money
    const winnerEid = Number(await reads.find((r) => r.st === SETTLED).c.pub.readContract({ address: reads.find((r) => r.st === SETTLED).curve, abi: curveAbi, functionName: "winnerEid" }));
    const win = byEid.get(winnerEid);
    for (const r of reads.filter((x) => x.st === SETTLED && x.e !== winnerEid)) {
      const [pool, bb] = await Promise.all([
        r.c.pub.readContract({ address: r.c.consolidator, abi: consAbi, functionName: "pendingPool", args: [id] }),
        r.c.pub.readContract({ address: r.c.consolidator, abi: consAbi, functionName: "pendingBuyback", args: [id] }),
      ]);
      if (pool + bb > 0n) {
        const msgs = (pool > 0n ? 1n : 0n) + (bb > 0n ? 1n : 0n);
        await send(r.c, `forward ${coin.name}: ${pool} pool + ${bb} buyback to ${winnerEid}`, {
          address: r.c.consolidator, abi: consAbi, functionName: "forward", args: [id], value: LZ_FEE * msgs,
        });
      }
    }

    // 4. open the pool on the winner
    if (win) {
      const ready = await win.pub.readContract({ address: win.migrator, abi: migAbi, functionName: "ready", args: [id] });
      if (ready) await send(win, `open pool for ${coin.name}`, { address: win.migrator, abi: migAbi, functionName: "open", args: [id] });
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
        const ok = await send(r.c, `move ${batch.length} holders of ${coin.name} to ${winnerEid}`, {
          address: coin.coin, abi: coinAbi, functionName: "moveBatch", args: [batch, lzOptions(gas)], value: LZ_FEE * 2n,
        });
        if (!ok) allMoved = false;
      }
    }
    // A coin is finished once it graduated, its pool is open and nothing is left to move.
    // New holders on a losing chain are impossible after graduation (its curve is closed).
    if (allMoved && win) {
      const g = await win.pub.readContract({ address: win.migrator, abi: migAbi, functionName: "grads", args: [id] });
      if (g[2] && !DRY) {
        coin.finished = true; // pool opened
        coin.winner = winnerEid;
      }
    }
  }

  if (!DRY) writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  log("pass done");
}

// LOOP_SECONDS set (e.g. on Railway): run forever, one pass every LOOP_SECONDS; a failed
// pass is logged and retried next time. Unset (GitHub Actions): one pass, then exit.
const LOOP_SECONDS = Number(env("LOOP_SECONDS", "0"));

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (LOOP_SECONDS > 0) {
    (async () => {
      log(`omni keeper: looping every ${LOOP_SECONDS}s`);
      let failures = 0;
      for (;;) {
        STARTED = Date.now();
        await main()
          .then(() => (failures = 0))
          .catch(async (e) => {
            failures += 1;
            log(`pass failed: ${e?.shortMessage ?? e?.message ?? e}`);
            if (failures >= 3) await alert("keeper", "pass", `${failures} passes in a row failed: ${e?.shortMessage ?? e?.message ?? e}`);
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
