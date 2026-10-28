// Keeps the rewards wallet funded by itself, and sends what it doesn't need to sasa's treasury.
//
// Money reaches this wallet in three ways, all automatic:
//   1. sasa's fee vault on each chain sends it 10% of the race fees (ETH / BNB / USDC there)
//   2. Relay's app fees (sasa's 0.70% swap and 0.25% deposit fee) collect in an app balance that
//      only this wallet can claim: claimRelayFees() claims it whenever it holds $5 or more
//   3. nothing else: no one sends it money by hand
// convertToBase() turns what it holds on each chain into USDC on Base (where invite rewards are
// paid), through Relay, keeping a little of each chain's coin for gas. Every route is checked
// (plain transactions on the right chain, the dollars approved only for the contract that takes
// them) and its quote must give at least 97% of the market price, or it waits.
// sweepSurplus() then sends sasa's treasury the USDC on Base above what's owed plus a reserve.

import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, zeroAddress } from "viem";

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
]);
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** The mainnet chains sasa runs on: the coin kept for gas, and the chain's dollar. */
export const FUND_DEFAULTS = [
  { chainId: 8453, native: "ETH", reserve: "0.001", usdc: BASE_USDC, usdcDecimals: 6 },
  { chainId: 56, native: "BNB", reserve: "0.005", usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", usdcDecimals: 18 },
  { chainId: 4663, native: "ETH", reserve: "0.001", usdc: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", usdcDecimals: 6 },
  // Arc: its coin IS the dollar (USDC); 1 of it is kept for gas
  { chainId: 5042, native: null, usdc: "0x3600000000000000000000000000000000000000", usdcDecimals: 6, usdcReserve: "1" },
];

const toUnits = (x, dec) => {
  const [i, f = ""] = String(x).split(".");
  return BigInt(i || "0") * 10n ** BigInt(dec) + BigInt((f + "0".repeat(dec)).slice(0, dec) || "0");
};

// ------------------------------------------------------------------ Relay app fees

/** Claims every Relay app balance of this wallet worth `minUsd` or more, to this wallet. */
export async function claimRelayFees({ api = "https://api.relay.link", account, minUsd = 5, apiKey, fetchFn = fetch, log = () => {} }) {
  const me = account.address;
  const headers = { "content-type": "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) };
  const r = await fetchFn(`${api}/app-fees/${me}/balances`, { headers });
  if (!r.ok) throw new Error(`relay balances: ${r.status}`);
  const j = await r.json().catch(() => ({}));
  const list = Array.isArray(j) ? j : Array.isArray(j?.balances) ? j.balances : [];
  const claimed = [];
  const errors = [];
  for (const b of list) {
   try {
    const usd = Number(b?.amountUsd);
    const chainId = Number(b?.currency?.chainId);
    const currency = b?.currency?.address;
    if (!(usd >= minUsd) || !chainId || !currency) continue;
    if (b.minimumAmount !== undefined && BigInt(b.amount ?? 0) < BigInt(b.minimumAmount)) continue;
    const c = await fetchFn(`${api}/app-fees/${me}/claim`, { method: "POST", headers, body: JSON.stringify({ chainId, currency, recipient: me }) });
    const cj = await c.json().catch(() => ({}));
    if (!c.ok || !Array.isArray(cj.steps)) throw new Error(`relay claim: ${cj.message || c.status}`);
    for (const step of cj.steps) {
      if (step.kind !== "signature") throw new Error("relay claim: unexpected step");
      for (const it of step.items || []) {
        const sign = it?.data?.sign;
        const post = it?.data?.post;
        if (!sign || !post || sign.signatureKind !== "eip191") throw new Error("relay claim: unexpected signature");
        if (!/^\/execute\/[a-z0-9/_-]+$/i.test(String(post.endpoint)) || String(post.method || "POST").toUpperCase() !== "POST") {
          throw new Error("relay claim: unexpected endpoint");
        }
        const msg = String(sign.message);
        const signature = await account.signMessage({ message: /^0x[0-9a-fA-F]*$/.test(msg) ? { raw: msg } : msg });
        const p = await fetchFn(`${api}${post.endpoint}?signature=${signature}`, { method: "POST", headers, body: JSON.stringify(post.body ?? {}) });
        if (!p.ok) throw new Error(`relay claim submit: ${p.status}`);
      }
    }
    claimed.push({ chainId, currency, usd });
    log(`relay: claimed $${usd.toFixed(2)} of app fees on chain ${chainId}`);
   } catch (e) {
    // one balance failing never stops the others
    errors.push(e.message);
   }
  }
  if (errors.length && !claimed.length) throw new Error(errors.join("; "));
  return claimed;
}

// ------------------------------------------------------------------ to USDC on Base

/**
 * Relay's route for `amount` of `token` (zeroAddress = the chain's coin) on `chainId`, to USDC on
 * Base, for `who` (sender and receiver). Returns { txs, out } or throws when the route isn't one
 * this wallet will run.
 */
export async function routeToBase({ relayApi, apiKey, chainId, who, token, amount, fetchFn = fetch }) {
  const r = await fetchFn(`${relayApi}/quote/v2`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) },
    body: JSON.stringify({
      user: who,
      recipient: who,
      originChainId: chainId,
      destinationChainId: 8453,
      originCurrency: token,
      destinationCurrency: BASE_USDC,
      amount: amount.toString(),
      tradeType: "EXACT_INPUT",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !Array.isArray(j.steps)) throw new Error(`relay: ${j.message || r.status}`);
  const native = token === zeroAddress;
  const txs = [];
  let spender = null;
  for (const step of j.steps) {
    if (step.kind !== "transaction") throw new Error("relay: route needs a signature step");
    for (const it of step.items || []) {
      const d = it.data || {};
      if (Number(d.chainId) !== chainId) throw new Error("relay: a step on another chain");
      if (!d.to || !d.data) throw new Error("relay: empty step");
      const to = String(d.to).toLowerCase();
      const value = d.value ? BigInt(d.value) : 0n;
      const isApprove = !native && to === String(token).toLowerCase() && String(d.data).startsWith("0x095ea7b3");
      if (isApprove) {
        const [s, v] = decodeFunctionData({ abi: erc20Abi, data: d.data }).args;
        if (v > amount || spender) throw new Error("relay: bad approval");
        spender = String(s).toLowerCase();
        txs.push({ to: d.to, data: d.data, value: 0n, approve: true });
      } else {
        if (to === String(token).toLowerCase() || to === PERMIT2) throw new Error("relay: step calls a contract it must not");
        if (native ? value > amount : value !== 0n) throw new Error("relay: unexpected value");
        txs.push({ to: d.to, data: d.data, value, approve: false });
      }
    }
  }
  const moves = txs.filter((t) => !t.approve);
  if (moves.length !== 1) throw new Error("relay: expected one transfer step");
  // Relay leaves the approval out when the contract may already spend enough (a leftover allowance):
  // add our own for exactly this amount, so only ever the exact amount is approved
  if (!native && !spender) {
    spender = String(moves[0].to).toLowerCase();
    txs.unshift({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [moves[0].to, amount] }), value: 0n, approve: true });
  }
  if (spender && spender !== String(moves[0].to).toLowerCase()) throw new Error("relay: the transfer isn't sent to the approved contract");
  txs.sort((a, b) => Number(b.approve) - Number(a.approve));
  // what the quote says arrives must be USDC on Base, for this wallet
  const cur = j?.details?.currencyOut?.currency;
  if (!cur || Number(cur.chainId) !== 8453 || String(cur.address).toLowerCase() !== BASE_USDC.toLowerCase()) {
    throw new Error("relay: the route doesn't end in USDC on Base");
  }
  if (j?.details?.recipient && String(j.details.recipient).toLowerCase() !== String(who).toLowerCase()) {
    throw new Error("relay: the route pays someone else");
  }
  let out = 0n;
  try {
    out = BigInt(j?.details?.currencyOut?.amount ?? 0);
  } catch {}
  return { txs, out };
}

/**
 * Moves what the wallet holds above its reserves, on every chain, to USDC on Base. Returns the
 * dollars sent on their way. `chains`: [{ chainId, pub, wallet, native, reserve, usdc, usdcDecimals, usdcReserve }]
 */
export async function convertToBase({ chains, account, relayApi = "https://api.relay.link", apiKey, price, minUsd = 5, maxUsd = 500, fetchFn = fetch, log = () => {}, waitFor }) {
  // at most maxUsd per move (more goes on the next run): whatever went wrong, one run risks little
  let moved = 0;
  const run = async (c, token, amount, expectedUsd, what) => {
    const { txs, out } = await routeToBase({ relayApi, apiKey, chainId: c.chainId, who: account.address, token, amount, fetchFn });
    if (out < BigInt(Math.floor(expectedUsd * 0.97 * 1e6))) {
      throw new Error(`${what} on chain ${c.chainId}: the quote gives $${(Number(out) / 1e6).toFixed(2)} for about $${expectedUsd.toFixed(2)}; waiting`);
    }
    for (const t of txs) {
      const hash = await c.wallet.sendTransaction({ account, to: t.to, data: t.data, value: t.value });
      const r = await (waitFor ? waitFor(c, hash) : c.pub.waitForTransactionReceipt({ hash, timeout: 180_000 }));
      if (r.status !== "success") throw new Error(`${what} on chain ${c.chainId}: reverted ${hash}`);
    }
    moved += expectedUsd;
    log(`fund: ${what} on chain ${c.chainId} -> about $${expectedUsd.toFixed(2)} USDC on Base`);
  };
  const errors = [];
  for (const c of chains) {
    try {
      if (c.native) {
        const p = await price(c.native);
        const bal = await c.pub.getBalance({ address: account.address });
        let spare = bal - toUnits(c.reserve ?? "0", 18);
        let usd = p ? (Number(spare) / 1e18) * p : 0;
        if (usd > maxUsd) {
          spare = (spare * BigInt(Math.floor((maxUsd / usd) * 1e6))) / 1_000_000n;
          usd = (Number(spare) / 1e18) * p;
        }
        if (spare > 0n && usd >= minUsd) await run(c, zeroAddress, spare, usd, `${c.native}`);
      }
      if (c.usdc && !(c.chainId === 8453 && getAddress(c.usdc) === getAddress(BASE_USDC))) {
        const dec = Number(c.usdcDecimals ?? 6);
        const bal = await c.pub.readContract({ address: c.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
        let spare = bal - toUnits(c.usdcReserve ?? "0", dec);
        if (spare > toUnits(String(maxUsd), dec)) spare = toUnits(String(maxUsd), dec);
        const usd = Number(spare) / 10 ** dec;
        if (spare > 0n && usd >= minUsd) await run(c, getAddress(c.usdc), spare, usd, "USDC");
      }
    } catch (e) {
      errors.push(e.shortMessage || e.message);
    }
  }
  return { moved, errors };
}

// ------------------------------------------------------------------ the rest to the treasury

/**
 * Sends sasa's treasury the USDC on Base above what invite rewards owe plus `keepUsd`, when that's
 * at least `minUsd`. Returns the units sent.
 */
export async function sweepSurplus(pool, base, account, { treasury, keepUsd = 100, minUsd = 20, bucket = 845300, log = () => {}, dry = false }) {
  if (!treasury) return 0n;
  const { rows } = await pool.query("select coalesce(sum(amount), 0)::text as owed from reward_ledger where chain_id = $1 and paid_at is null", [bucket]);
  const owed = BigInt(String(rows[0]?.owed ?? "0").split(".")[0]);
  const bal = await base.pub.readContract({ address: base.token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  const keep = owed + BigInt(Math.round(keepUsd * 1e6));
  const surplus = bal > keep ? bal - keep : 0n;
  if (surplus < BigInt(Math.round(minUsd * 1e6))) return 0n;
  if (dry) {
    log(`[dry] fund: would send ${Number(surplus) / 1e6} USDC to the treasury`);
    return surplus;
  }
  const hash = await base.wallet.sendTransaction({
    account,
    to: base.token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(treasury), surplus] }),
  });
  const r = await base.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`sweep to the treasury reverted ${hash}`);
  log(`fund: sent ${Number(surplus) / 1e6} USDC to the treasury (${hash})`);
  return surplus;
}
