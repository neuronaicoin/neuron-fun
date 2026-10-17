// sasa's own Across relayer: makes a launch from a sasa account live on every chain in seconds.
//
// An email account launches from its dollars on Base: one Base transaction opens the coin on Base
// and sends the launch for every other chain through Across (to RaceCross there, signed by the
// user). Any Across relayer may deliver such a deposit; this one watches Base and delivers sasa's
// own deposits (RaceCross launches and buys) on BNB Chain, Robinhood Chain and Arc the moment they
// appear, from its own dollars there. Across pays it back a few hours later (the deposit's amount
// less Across's small LP fee; the relayer fee in it covers the gas).
//
// It only ever pays the exact amount the user's deposit asks for, to RaceCross, as Across's own
// SpokePool checks: it can't send money anywhere else, and a delivery RaceCross refuses (a bad
// signature, a launch that already happened) is dry-run first and never sent.
//
// Its dollars come back on the chain it asks for (RELAY_REPAY: the chain it delivered on, by
// default; Across uses Base when it can't). Dollars that come back on Base are sent on to the
// chains that run low (an ordinary Across deposit to itself), so each chain keeps about
// RELAY_TARGET_USD ready.
//
// Env:
//   RELAYER_KEY            its own wallet's key (keep it separate from the keeper's); unset = off
//   RPC_<chainId>          RPCs (as the race keeper); RELAY_RPC_<chainId> overrides them for the relayer
//   RELAY_POLL_MS          how often Base is looked at (default 1000)
//   RELAY_MAX_USD          the largest single delivery (default 100)
//   RELAY_TARGET_USD       dollars kept ready on each chain (default 50); RELAY_TARGET_USD_<chainId>
//   RELAY_REPAY            "dest" (default) or "origin": where Across pays it back
//   RELAY_REBALANCE=false  never moves its Base dollars on to the other chains
//   RELAY_DRY_RUN=true     decide and log, send nothing

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, decodeAbiParameters, defineChain, fallback, http, maxUint256, pad, parseAbi, parseAbiItem, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { alert as sendAlert, heartbeat } from "./alert.mjs";
import { refillGas } from "./refill.mjs";

/** Across's SpokePools (from @across-protocol/contracts' deployed-addresses.json). */
export const SPOKES = {
  8453: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  56: "0x4e8E101924eDE233C13e2D8622DC8aED2872d505",
  4663: "0xD29C85F15DF544bA632C9E25829fd29d767d7978",
  5042: "0x9b4A302A548c7e313c2b74C461db7b84d3074A84",
};
const ACROSS_API = ["https://across.to/api", "https://app.across.to/api"];
const KIND_BUY = 0;
const KIND_LAUNCH = 1;

// copied from Across's V3SpokePoolInterface.sol
export const fundsDeposited = parseAbiItem(
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)"
);
export const spokeAbi = parseAbi([
  "struct V3RelayData { bytes32 depositor; bytes32 recipient; bytes32 exclusiveRelayer; bytes32 inputToken; bytes32 outputToken; uint256 inputAmount; uint256 outputAmount; uint256 originChainId; uint256 depositId; uint32 fillDeadline; uint32 exclusivityDeadline; bytes message; }",
  "function fillRelay(V3RelayData relayData, uint256 repaymentChainId, bytes32 repaymentAddress)",
  "function depositV3Now(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 fillDeadlineOffset, uint32 exclusivityParameter, bytes message) payable",
  "error RelayFilled()",
  "error ExpiredFillDeadline()",
  "error NotExclusiveRelayer()",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
]);

const b32 = (a) => pad(String(a).toLowerCase(), { size: 32 }).toLowerCase();
const same32 = (x, addr) => String(x).toLowerCase() === b32(addr);
const usdUnits = (usd, dec) => (BigInt(Math.round(Number(usd) * 100)) * 10n ** BigInt(dec)) / 100n;
const toUsd = (v, dec) => Number(v) / 10 ** dec;
/** `amount` in `from` decimals, in `to` decimals (rounded down). */
export const convertDecimals = (amount, from, to) => (from === to ? amount : from < to ? amount * 10n ** BigInt(to - from) : amount / 10n ** BigInt(from - to));

/** The message kind of a RaceCross delivery (null: not one). */
export function messageKind(message) {
  try {
    const [kind] = decodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], message);
    return Number(kind);
  } catch {
    return null;
  }
}

/** The relay data of a deposit log, exactly as the destination SpokePool hashes it. */
export function relayDataOf(log, originChainId) {
  const a = log.args;
  return {
    depositor: a.depositor,
    recipient: a.recipient,
    exclusiveRelayer: a.exclusiveRelayer,
    inputToken: a.inputToken,
    outputToken: a.outputToken,
    inputAmount: a.inputAmount,
    outputAmount: a.outputAmount,
    originChainId: BigInt(originChainId),
    depositId: a.depositId,
    fillDeadline: Number(a.fillDeadline),
    exclusivityDeadline: Number(a.exclusivityDeadline),
    message: a.message,
  };
}

/**
 * Whether to deliver `rd` (relay data) on `dest`: only sasa's own RaceCross deposits, in dollars,
 * no bigger than `maxUsd`, still in time, open to us, and never paying out more than comes in.
 * Returns null (go) or the reason not to.
 */
export function whyNot(rd, { origin, dest, me, nowS, maxUsd }) {
  if (!dest.cross || !same32(rd.recipient, dest.cross)) return "not to RaceCross";
  if (!same32(rd.inputToken, origin.usd) || !same32(rd.outputToken, dest.usd)) return "not dollars to dollars";
  const kind = messageKind(rd.message);
  if (kind !== KIND_LAUNCH && kind !== KIND_BUY) return "not a launch or a buy";
  if (rd.fillDeadline <= nowS + 15) return "too late";
  const ex = String(rd.exclusiveRelayer).toLowerCase();
  if (ex !== b32(zeroAddress) && ex !== b32(me) && rd.exclusivityDeadline >= nowS) return "another relayer's for now";
  if (rd.outputAmount > usdUnits(maxUsd, dest.usdDecimals)) return `over $${maxUsd}`;
  if (convertDecimals(rd.inputAmount, origin.usdDecimals, dest.usdDecimals) < rd.outputAmount) return "pays out more than comes in";
  return null;
}

/** The chains (deployment files + RPCs), each with a public client and the relayer's wallet. */
export function loadChains({ deployments, account, env = process.env }) {
  const out = [];
  for (const f of readdirSync(deployments).filter((x) => /^\d+\.json$/.test(x))) {
    const d = JSON.parse(readFileSync(join(deployments, f), "utf8"));
    const id = Number(d.chainId);
    const rpcs = (env[`RELAY_RPC_${id}`] || env[`RPC_${id}`] || "").split(",").map((s) => s.trim()).filter(Boolean);
    const spoke = env[`SPOKE_${id}`] || SPOKES[id];
    if (!rpcs.length || !spoke) continue;
    const chain = defineChain({ id, name: `c${id}`, nativeCurrency: { name: "native", symbol: "N", decimals: 18 }, rpcUrls: { default: { http: rpcs } } });
    const transport = fallback(rpcs.map((u) => http(u, { retryCount: 1, timeout: 15_000 })));
    out.push({
      ...d,
      chainId: id,
      spoke,
      usdDecimals: Number(d.usdDecimals ?? 6),
      pub: createPublicClient({ chain, transport }),
      wallet: createWalletClient({ chain, account, transport }),
    });
  }
  return out;
}

/**
 * The relayer for `chains` (one of them is `originId`, where the deposits are made). `tick()`
 * looks for new deposits once; `rebalance()` moves dollars that came back on the origin on to
 * the chains that run low. Deliveries run in the background, one at a time per chain.
 */
export function createRelayer({ chains, originId = 8453, account, env = process.env, log = () => {}, alert = async () => {}, nowS = () => Math.floor(Date.now() / 1000), fetchFn = fetch }) {
  const origin = chains.find((c) => c.chainId === originId);
  if (!origin) throw new Error(`relayer: no RPC for the origin chain ${originId}`);
  const dests = chains.filter((c) => c.chainId !== originId && c.cross && c.cross !== zeroAddress);
  const DRY = env.RELAY_DRY_RUN === "true";
  const maxUsd = Number(env.RELAY_MAX_USD || "100");
  const repayDest = (env.RELAY_REPAY || "dest") !== "origin";
  const lookback = BigInt(env.RELAY_LOOKBACK_BLOCKS || "60");
  const me = account.address;

  let from = null;
  const seen = new Map(); // "<dest>-<depositId>" -> state
  const queues = new Map();
  const approved = new Set();
  const results = [];

  const enqueue = (chainId, job) => {
    const run = (queues.get(chainId) ?? Promise.resolve()).then(job);
    const q = run.catch((e) => log(`relay ${chainId}: ${e.shortMessage || e.message}`));
    queues.set(chainId, q);
    return q;
  };

  async function ensureApproval(c, token, spender, amount) {
    const k = `${c.chainId}-${token}-${spender}`.toLowerCase();
    if (approved.has(k)) return;
    const a = await c.pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [me, spender] });
    if (a < amount) {
      if (DRY) return;
      const hash = await c.wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] });
      const r = await c.pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (r.status !== "success") throw new Error(`approval reverted ${hash}`);
      log(`relay ${c.chainId}: approved the SpokePool`);
    }
    approved.add(k);
  }

  async function deliver(dest, rd, key) {
    const t0 = Date.now();
    const why = whyNot(rd, { origin, dest, me, nowS: nowS(), maxUsd });
    if (why) {
      seen.set(key, `skip: ${why}`);
      return;
    }
    const bal = await dest.pub.readContract({ address: dest.usd, abi: erc20Abi, functionName: "balanceOf", args: [me] });
    if (bal < rd.outputAmount) {
      seen.set(key, "skip: not enough dollars");
      log(`relay ${dest.chainId}: deposit ${rd.depositId} needs $${toUsd(rd.outputAmount, dest.usdDecimals)}, has $${toUsd(bal, dest.usdDecimals)}: left to other relayers`);
      await alert("relayer", `relay-low-${dest.chainId}`, `The relayer ${me} has only $${toUsd(bal, dest.usdDecimals).toFixed(2)} on chain ${dest.chainId}; launches there go through Across's own relayers (slower) until it gets more.`);
      return;
    }
    await ensureApproval(dest, dest.usd, dest.spoke, rd.outputAmount);
    const repay = repayDest ? BigInt(dest.chainId) : BigInt(origin.chainId);
    const args = [rd, repay, b32(me)];
    let sim;
    try {
      sim = await dest.pub.simulateContract({ account, address: dest.spoke, abi: spokeAbi, functionName: "fillRelay", args });
    } catch (e) {
      const data = e?.cause?.data ?? e?.data;
      // a plain revert string comes as Error("…")
      const name = data?.errorName === "Error" ? String(data.args?.[0] ?? "Error") : data?.errorName ?? e?.cause?.reason ?? "";
      seen.set(key, name === "RelayFilled" ? "filled by another relayer" : `skip: dry run failed ${name || e.shortMessage || e.message}`);
      log(`relay ${dest.chainId}: deposit ${rd.depositId} not delivered (${name || e.shortMessage || e.message})`);
      return;
    }
    if (DRY) {
      seen.set(key, "dry");
      log(`[dry] relay ${dest.chainId}: would deliver deposit ${rd.depositId}`);
      return;
    }
    // room above the estimate: RaceCross refuses a delivery that runs short of gas
    const gas = sim.request.gas ?? (await dest.pub.estimateContractGas({ account, address: dest.spoke, abi: spokeAbi, functionName: "fillRelay", args }));
    const hash = await dest.wallet.writeContract({ ...sim.request, gas: (gas * 13n) / 10n });
    seen.set(key, `sent ${hash}`);
    const r = await dest.pub.waitForTransactionReceipt({ hash, timeout: 90_000, pollingInterval: 500 });
    seen.set(key, r.status === "success" ? `delivered ${hash}` : `reverted ${hash}`);
    results.push({ chainId: dest.chainId, depositId: rd.depositId, hash, ok: r.status === "success" });
    log(`relay ${dest.chainId}: deposit ${rd.depositId} ${r.status === "success" ? "delivered" : "REVERTED"} in ${((Date.now() - t0) / 1000).toFixed(1)}s ${hash}`);
  }

  /** One look at the origin chain: new sasa deposits are delivered (in the background). */
  async function tick() {
    const head = await origin.pub.getBlockNumber();
    if (from === null) from = head > lookback ? head - lookback : 0n;
    if (head < from) return [];
    const to = head - from > 500n ? from + 500n : head;
    const logs = await origin.pub.getLogs({
      address: origin.spoke,
      event: fundsDeposited,
      args: { destinationChainId: dests.map((d) => BigInt(d.chainId)) },
      fromBlock: from,
      toBlock: to,
    });
    from = to + 1n;
    const jobs = [];
    for (const l of logs) {
      const dest = dests.find((d) => BigInt(d.chainId) === l.args.destinationChainId);
      if (!dest || !l.args.recipient || !same32(l.args.recipient, dest.cross)) continue;
      const key = `${dest.chainId}-${l.args.depositId}`;
      if (seen.has(key)) continue;
      seen.set(key, "queued");
      const rd = relayDataOf(l, origin.chainId);
      jobs.push(enqueue(dest.chainId, () => deliver(dest, rd, key)));
    }
    // forget old ones (a deposit is never seen again once the scan moved past it)
    if (seen.size > 5_000) for (const k of [...seen.keys()].slice(0, 1_000)) seen.delete(k);
    return jobs;
  }

  // ------------------------------------------------------------------ dollars back where needed

  const lastMove = new Map();
  async function acrossOut(dest, amount) {
    const p = new URLSearchParams({
      inputToken: origin.usd,
      outputToken: dest.usd,
      originChainId: String(origin.chainId),
      destinationChainId: String(dest.chainId),
      amount: amount.toString(),
      recipient: me,
      allowUnmatchedDecimals: "true",
    });
    let last = null;
    for (const host of ACROSS_API) {
      try {
        const r = await fetchFn(`${host}/suggested-fees?${p}`);
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.outputAmount) {
          if (j.isAmountTooLow) throw new Error("amount too low");
          if (j.spokePoolAddress && String(j.spokePoolAddress).toLowerCase() !== origin.spoke.toLowerCase()) throw new Error("unexpected SpokePool");
          return BigInt(j.outputAmount);
        }
        last = new Error(j.message || `Across ${r.status}`);
      } catch (e) {
        last = e;
      }
    }
    throw last ?? new Error("Across unreachable");
  }

  /** Dollars that came back on the origin go on to the chains below half their target. */
  async function rebalance() {
    if (env.RELAY_REBALANCE === "false") return [];
    const moved = [];
    let spare = await origin.pub.readContract({ address: origin.usd, abi: erc20Abi, functionName: "balanceOf", args: [me] });
    spare -= usdUnits(env.RELAY_BASE_KEEP_USD || "1", origin.usdDecimals);
    for (const dest of dests) {
      if (spare <= 0n) break;
      const target = usdUnits(env[`RELAY_TARGET_USD_${dest.chainId}`] || env.RELAY_TARGET_USD || "50", dest.usdDecimals);
      const bal = await dest.pub.readContract({ address: dest.usd, abi: erc20Abi, functionName: "balanceOf", args: [me] });
      if (bal * 2n >= target) continue;
      // one move per chain at a time: the last one may still be on its way
      if (Date.now() - (lastMove.get(dest.chainId) ?? 0) < 30 * 60_000) continue;
      let amount = convertDecimals(target - bal, dest.usdDecimals, origin.usdDecimals);
      if (amount > spare) amount = spare;
      if (amount < usdUnits(5, origin.usdDecimals)) continue;
      try {
        const out = await acrossOut(dest, amount);
        // at most 1.5% lost on the way, or it waits for a better price
        if (convertDecimals(out, dest.usdDecimals, origin.usdDecimals) * 1000n < amount * 985n) throw new Error(`fee too high (${out} for ${amount})`);
        lastMove.set(dest.chainId, Date.now());
        if (DRY) {
          log(`[dry] relay: would move $${toUsd(amount, origin.usdDecimals)} to ${dest.chainId}`);
          continue;
        }
        await ensureApproval(origin, origin.usd, origin.spoke, amount);
        const hash = await origin.wallet.writeContract({
          address: origin.spoke,
          abi: spokeAbi,
          functionName: "depositV3Now",
          args: [me, me, origin.usd, dest.usd, amount, out, BigInt(dest.chainId), zeroAddress, 4 * 3600, 0, "0x"],
        });
        const r = await origin.pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
        if (r.status !== "success") throw new Error(`reverted ${hash}`);
        spare -= amount;
        moved.push({ chainId: dest.chainId, amount, hash });
        log(`relay: moved $${toUsd(amount, origin.usdDecimals)} to chain ${dest.chainId} ${hash}`);
      } catch (e) {
        log(`relay: moving dollars to ${dest.chainId} failed (${e.shortMessage || e.message})`);
      }
    }
    return moved;
  }

  /** Gas on every chain, swapped from its own dollars when low (as the keeper does). */
  async function gasCheck() {
    for (const c of chains) {
      // through the chain's queue, so it never races a delivery for the same nonce
      const res = await enqueue(c.chainId, () => refillGas(c, account, {
        log,
        send: async (cc, tx) => {
          const hash = await cc.wallet.sendTransaction(tx);
          return cc.pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
        },
      }).catch((e) => `alert:${e.shortMessage || e.message}`));
      if (typeof res === "string" && res.startsWith("alert:")) await alert("relayer", `relay-gas-${c.chainId}`, res.slice(6).replace("keeper wallet", "relayer wallet"));
    }
  }

  /** Approves each chain's SpokePool up front, so the first delivery doesn't wait for it. */
  async function warmUp() {
    for (const d of dests) await enqueue(d.chainId, () => ensureApproval(d, d.usd, d.spoke, 1n));
  }

  return { tick, rebalance, gasCheck, warmUp, seen, results, queues, origin, dests };
}

/** Starts the relayer loop (inside the race keeper, or on its own: `node relay.mjs`). */
export function startRelayer({ env = process.env, log = (...a) => console.log(new Date().toISOString(), ...a) } = {}) {
  let key = (env.RELAYER_KEY || "").trim();
  if (!key) {
    log("relayer: off (no RELAYER_KEY)");
    return null;
  }
  if (!key.startsWith("0x")) key = `0x${key}`;
  const account = privateKeyToAccount(key);
  const deployments = env.DEPLOYMENTS || "../contracts-v7/deployments/race";
  if (!existsSync(deployments)) throw new Error(`relayer: no ${deployments}`);
  const chains = loadChains({ deployments, account, env });
  const r = createRelayer({ chains, account, env, log, alert: sendAlert });
  const poll = Number(env.RELAY_POLL_MS || "1000");
  log(`relayer ${account.address}: watching Base for ${r.dests.map((d) => d.chainId).join(", ")} every ${poll}ms`);
  void r.warmUp().catch((e) => log(`relayer: approvals failed (${e.shortMessage || e.message})`));
  let fails = 0;
  (async () => {
    for (;;) {
      try {
        await r.tick();
        fails = 0;
      } catch (e) {
        fails += 1;
        if (fails % 30 === 1) log(`relayer: look failed (${e.shortMessage || e.message})`);
        if (fails >= 120) await sendAlert("relayer", "relay-look", `The relayer can't read Base: ${e.shortMessage || e.message}`);
      }
      await new Promise((res) => setTimeout(res, fails ? Math.min(10_000, poll * 2 ** Math.min(fails, 4)) : poll));
    }
  })();
  // dollars and gas every 10 minutes (first after a minute)
  const slow = async () => {
    await r.rebalance().catch((e) => log(`relayer: rebalance failed (${e.shortMessage || e.message})`));
    await r.gasCheck().catch((e) => log(`relayer: gas check failed (${e.shortMessage || e.message})`));
    await heartbeat("relayer").catch(() => {});
  };
  setTimeout(() => {
    void slow();
    setInterval(() => void slow(), Number(env.RELAY_SLOW_MIN || "10") * 60_000);
  }, 60_000);
  return r;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) startRelayer();
