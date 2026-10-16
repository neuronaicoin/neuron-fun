// Records a trade of another DEX's coin made on sasa, for the Stats page. Called from
// functions/api/[[path]].js (no sign-in needed: nothing here is trusted from the caller).
//
//   POST /api/exttrade   { chainId, tx, side, coin, coinChain }  → { ok } | { pending }
//
// Only a trade that really went through sasa counts: Relay must know the transaction, it must be
// done, and sasa's fee must be on it. The dollars are read from the chain itself: the USDC the
// trader paid (buys) or got back (sells, on the coin's chain or on Base), never from the caller.

import { NETWORK } from "../lib/network.js";

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const RELAY = "https://api.relay.link";
const TREASURY = "0xe0ba5905940d748b23dc01266aa884e2391cca2f";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** Each chain's dollar (what Relay takes and pays out on sasa) and its decimals. */
export const DOLLARS = {
  8453: { rpc: "https://mainnet.base.org", usd: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", dec: 6 },
  56: { rpc: "https://bsc-dataseed.bnbchain.org", usd: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", dec: 18 },
  4663: { rpc: "https://rpc.mainnet.chain.robinhood.com", usd: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", dec: 6 },
  5042: { rpc: "https://rpc.mainnet.arc.io", usd: "0x3600000000000000000000000000000000000000", dec: 6 },
  1: { rpc: "https://ethereum-rpc.publicnode.com", usd: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", dec: 6 },
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const lower = (a) => String(a || "").toLowerCase();
const isHash = (h) => /^0x[0-9a-f]{64}$/.test(h);
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);

async function sb(env, path, { method = "GET", body, prefer } = {}) {
  const key = env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: key, "content-type": "application/json" };
  if (key && key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  if (prefer) headers.prefer = prefer;
  const r = await fetch(`${env.SUPABASE_URL || SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`db ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function receipt(chainId, hash) {
  const c = DOLLARS[chainId];
  if (!c) return null;
  const r = await fetch(c.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
  });
  const j = await r.json().catch(() => null);
  return j && j.result ? j.result : null;
}

/**
 * Token movements of `trader` in one receipt: the biggest single dollar transfer it sent (`out`) and
 * got (`in`), and whether `coin` left or reached it. The biggest single transfer is the trade
 * itself: a gas top-up or a network fee paid in USDC in the same transaction are smaller and apart.
 */
export function moves(chainId, rcpt, trader, coin = "") {
  const c = DOLLARS[chainId];
  const r = { out: 0, in: 0, coinOut: false, coinIn: false };
  if (!c || !rcpt || rcpt.status !== "0x1") return r;
  const me = "0x" + "0".repeat(24) + trader.slice(2);
  let out = 0n;
  let inn = 0n;
  for (const l of rcpt.logs || []) {
    if (!l.topics || l.topics[0] !== TRANSFER || l.topics.length < 3) continue;
    const from = lower(l.topics[1]);
    const to = lower(l.topics[2]);
    const token = lower(l.address);
    if (token === c.usd) {
      const v = BigInt(l.data && l.data !== "0x" ? l.data : "0x0");
      if (from === me && v > out) out = v;
      if (to === me && v > inn) inn = v;
    } else if (coin && token === coin) {
      if (from === me) r.coinOut = true;
      if (to === me) r.coinIn = true;
    }
  }
  r.out = Number(out) / 10 ** c.dec;
  r.in = Number(inn) / 10 ** c.dec;
  return r;
}

/** Relay's requests this transaction started (it can start two: a trade and a gas top-up). */
async function relayRequests(hash, key) {
  // v3 needs sasa's Relay API key; v2 (no key) works until Relay retires it
  for (const v of key ? ["v3", "v2"] : ["v2"]) {
    const r = await fetch(`${RELAY}/requests/${v}?hash=${hash}`, { headers: v === "v3" ? { "x-api-key": key } : {} }).catch(() => null);
    if (!r || !r.ok) continue;
    const j = await r.json().catch(() => null);
    if (j && Array.isArray(j.requests)) return j.requests;
  }
  return null;
}

const list = (x) => (Array.isArray(x) ? x : []);

/**
 * The request's app fees to sasa's treasury. Relay's requests v2 lists them in `appFees` (quoted)
 * and `paidAppFees` (paid); v3 in one `appFees` object { quoted, actual }.
 */
function treasuryFees(req) {
  const d = req.data || {};
  const v3 = d.appFees && !Array.isArray(d.appFees) ? d.appFees : null;
  const quoted = [...(v3 ? list(v3.quoted) : list(d.appFees)), ...list(req.appFees)].filter((f) => lower(f.recipient) === TREASURY);
  const paid = (v3 ? list(v3.actual) : list(d.paidAppFees)).filter((f) => lower(f.recipient) === TREASURY);
  return { quoted, paid };
}

/** sasa's fee is on the request (Relay pays it to the treasury). */
export function sasaFee(req) {
  const { quoted, paid } = treasuryFees(req);
  return quoted.length > 0 || paid.length > 0;
}

/**
 * sasa's fee on the trade in dollars: what Relay says it paid the treasury, else the fee rate on
 * the trade's dollars. 0 when unknown (the trade still counts for the Stats page, not for rewards).
 */
export function sasaFeeUsd(req, usd) {
  const { quoted, paid } = treasuryFees(req);
  const sum = (a) => a.reduce((s, f) => s + (Number(f.amountUsd) > 0 ? Number(f.amountUsd) : 0), 0);
  const paidUsd = sum(paid);
  if (paidUsd > 0) return Math.min(paidUsd, usd);
  const bps = Math.max(0, ...[...paid, ...quoted].map((f) => Number(f.bps ?? f.fee) || 0));
  return bps > 0 ? Math.min((usd * bps) / 10_000, usd) : 0;
}

// answers already settled in this worker (stops the same hash costing lookups again and again)
const settled = new Map();
const settle = (tx, res) => {
  if (settled.size > 5000) settled.clear();
  settled.set(tx, res);
  return json(res);
};

export async function extTradeRoute(env, body) {
  if (NETWORK !== "mainnet" && !env.EXTTRADE_ANY_NETWORK) return json({ ok: false });
  const b = body || {};
  const chainId = Number(b.chainId);
  const coinChain = Number(b.coinChain);
  const tx = lower(b.tx);
  const coin = lower(b.coin);
  if (!DOLLARS[chainId] || !DOLLARS[coinChain] || !isHash(tx) || !isAddr(coin) || (b.side !== "buy" && b.side !== "sell")) return json({ error: "Bad trade." }, 400);
  // a sell starts on the coin's own chain
  if (b.side === "sell" && chainId !== coinChain) return json({ error: "Bad trade." }, 400);
  if (settled.has(tx)) return json(settled.get(tx));

  const seen = await sb(env, `ext_trades?chain_id=eq.${chainId}&tx=eq.${tx}&select=id`);
  if (seen && seen.length) return settle(tx, { ok: true });

  // Relay's request that this transaction paid into (not one it paid out of), carrying sasa's fee
  const reqs = await relayRequests(tx, env.RELAY_API_KEY);
  if (!reqs) return json({ pending: true });
  const started = reqs.filter((q) =>
    ((q.data && q.data.inTxs) || []).some((t) => lower(t.hash) === tx && (t.chainId === undefined || Number(t.chainId) === chainId))
  );
  if (!started.length) return json({ pending: true });
  const req = started.find(sasaFee);
  if (!req) return started.some((q) => lower(q.status) !== "success") ? json({ pending: true }) : settle(tx, { ok: false });
  const status = lower(req.status);
  if (status === "failure" || status === "refund" || status === "refunded") return settle(tx, { ok: false });
  if (status !== "success") return json({ pending: true });
  const trader = lower(req.user);
  if (!isAddr(trader)) return settle(tx, { ok: false });
  const id = lower(req.id);
  if (id) {
    const dup = await sb(env, `ext_trades?request_id=eq.${encodeURIComponent(id)}&select=id`);
    if (dup && dup.length) return settle(tx, { ok: true });
  }

  // what moved, read from the chain: the dollars and the coin, where the trade sent and where Relay paid out
  const origin = moves(chainId, await receipt(chainId, tx), trader, coin);
  let got = origin.in;
  let coinIn = chainId === coinChain && origin.coinIn;
  for (const t of ((req.data && req.data.outTxs) || []).slice(0, 3)) {
    const cid = Number(t.chainId);
    const h = lower(t.hash);
    if (!DOLLARS[cid] || !isHash(h) || h === tx) continue;
    const m = moves(cid, await receipt(cid, h), trader, cid === coinChain ? coin : "");
    if (m.in > got) got = m.in;
    if (cid === coinChain && m.coinIn) coinIn = true;
  }
  const isTrade = b.side === "buy" ? coinIn : origin.coinOut;
  const usd = b.side === "buy" ? origin.out : got;
  if (!isTrade || !(usd > 0) || usd >= 1e8) return settle(tx, { ok: false });

  await sb(env, "ext_trades?on_conflict=chain_id,tx", {
    method: "POST",
    prefer: "resolution=ignore-duplicates",
    body: {
      chain_id: chainId,
      tx,
      request_id: id || null,
      trader,
      side: b.side,
      coin,
      coin_chain: coinChain,
      usd: Math.round(usd * 100) / 100,
      source: "trade",
      fee_usd: Math.round(sasaFeeUsd(req, usd) * 1e6) / 1e6,
      // when Relay saw the trade (a trade reported late still counts from when it was made)
      traded_at: Number.isFinite(Date.parse(req.createdAt)) ? new Date(req.createdAt).toISOString() : null,
    },
  });
  return settle(tx, { ok: true });
}
