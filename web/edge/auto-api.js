// Auto orders API (take profit, stop loss, buy the dip), called from functions/api/[[path]].js
// once the session is checked.
//
//   GET    /api/auto            the caller's orders (newest first)
//   POST   /api/auto            { chainId, contract, kind, coin, coinChain, coinKind, raceId?, network?,
//                                symbol, triggerUsd, amountUsd, order, signature } → { order }
//   DELETE /api/auto/:id        cancel one of the caller's open orders
//
// The order itself is signed by the user (EIP-712, AutoOrders on chain `chainId`): the API checks
// that signature before storing it, and the contract checks it again before running it.

import { createPublicClient, defineChain, getAddress, http, isAddress, recoverTypedDataAddress } from "viem";

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const MAX_OPEN = 50;
const KINDS = new Set(["tp", "sl", "dip"]);
const NETWORKS = new Set(["base", "bsc", "robinhood", "arc"]);
const RPC = {
  8453: "https://mainnet.base.org",
  56: "https://bsc-dataseed.bnbchain.org",
  4663: "https://rpc.mainnet.chain.robinhood.com",
  5042: "https://rpc.mainnet.arc.io",
  84532: "https://sepolia.base.org",
  97: "https://bsc-testnet-rpc.publicnode.com",
  46630: "https://rpc.testnet.chain.robinhood.com/rpc",
  5042002: "https://rpc.testnet.arc.network",
};

export const ORDER_TYPES = {
  Order: [
    { name: "user", type: "address" },
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minOut", type: "uint256" },
    { name: "mode", type: "uint8" },
    { name: "destChainId", type: "uint256" },
    { name: "maxRouteFee", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status, error) => json({ error }, status);
const uint = (v) => typeof v === "string" && /^\d{1,78}$/.test(v);
const lower = (a) => String(a).toLowerCase();

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

const COLS = "id,chain_id,contract,kind,coin,coin_chain,coin_kind,race_id,network,symbol,trigger_usd,amount_usd,status,note,created_at,filled_tx,filled_at,out_amount,order_json";
const out = (r) => ({
  id: Number(r.id),
  chainId: r.chain_id,
  contract: r.contract,
  kind: r.kind,
  coin: r.coin,
  coinChain: r.coin_chain,
  coinKind: r.coin_kind,
  raceId: r.race_id,
  network: r.network,
  symbol: r.symbol,
  triggerUsd: Number(r.trigger_usd),
  amountUsd: Number(r.amount_usd),
  status: r.status,
  note: r.note,
  createdAt: r.created_at,
  filledTx: r.filled_tx,
  filledAt: r.filled_at,
  outAmount: r.out_amount,
  nonce: r.order_json && r.order_json.nonce,
});

/** The user's own key signed it, or (a smart wallet) the wallet says yes on chain. */
async function signedBy(user, chainId, contract, order, signature) {
  const message = { ...order, mode: Number(order.mode) };
  for (const k of ["amountIn", "minOut", "destChainId", "maxRouteFee", "deadline", "nonce"]) message[k] = BigInt(order[k]);
  const domain = { name: "sasa AutoOrders", version: "1", chainId, verifyingContract: contract };
  try {
    const who = await recoverTypedDataAddress({ domain, types: ORDER_TYPES, primaryType: "Order", message, signature });
    if (lower(who) === lower(user)) return true;
  } catch {}
  const rpc = RPC[chainId];
  if (!rpc) return false;
  try {
    const chain = defineChain({ id: chainId, name: `c${chainId}`, nativeCurrency: { name: "N", symbol: "N", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 8000 }) });
    return await pub.verifyTypedData({ address: user, domain, types: ORDER_TYPES, primaryType: "Order", message, signature });
  } catch {
    return false;
  }
}

async function place(env, me, b) {
  const o = b && b.order;
  if (!o || typeof o !== "object") return fail(400, "Bad order.");
  const chainId = Number(b.chainId);
  const coinChain = Number(b.coinChain);
  if (!RPC[chainId] || !RPC[coinChain]) return fail(400, "Unknown chain.");
  if (!isAddress(b.contract || "") || !isAddress(b.coin || "")) return fail(400, "Bad address.");
  if (!KINDS.has(b.kind)) return fail(400, "Unknown order type.");
  if (b.coinKind !== "race" && b.coinKind !== "ext") return fail(400, "Unknown coin.");
  if (b.coinKind === "race" && !/^0x[0-9a-f]{64}$/.test(String(b.raceId || ""))) return fail(400, "Unknown race.");
  if (b.coinKind === "ext" && !NETWORKS.has(String(b.network))) return fail(400, "Unknown network.");
  const trigger = Number(b.triggerUsd);
  const amountUsd = Number(b.amountUsd);
  if (!Number.isFinite(trigger) || trigger <= 0 || trigger > 1e9) return fail(400, "Bad price.");
  if (!Number.isFinite(amountUsd) || amountUsd < 0 || amountUsd > 1e9) return fail(400, "Bad amount.");
  for (const k of ["user", "tokenIn", "tokenOut"]) if (!isAddress(o[k] || "")) return fail(400, "Bad order.");
  for (const k of ["amountIn", "minOut", "destChainId", "maxRouteFee", "deadline", "nonce"]) if (!uint(o[k])) return fail(400, "Bad order.");
  if (![0, 1, 2].includes(Number(o.mode))) return fail(400, "Bad order.");
  if (lower(o.user) !== lower(me)) return fail(403, "That order is for another wallet.");
  if (BigInt(o.amountIn) === 0n || BigInt(o.minOut) === 0n) return fail(400, "Bad order.");
  const now = Math.floor(Date.now() / 1000);
  if (Number(o.deadline) < now + 300 || Number(o.deadline) > now + 400 * 86400) return fail(400, "Bad expiry.");
  // a sell order sells the coin, a dip order buys it
  const coin = lower(b.coin);
  if (b.kind === "dip" ? lower(o.tokenOut) !== coin : lower(o.tokenIn) !== coin) return fail(400, "The order doesn't match the coin.");
  if (typeof b.signature !== "string" || !/^0x[0-9a-fA-F]{130,}$/.test(b.signature) || b.signature.length > 20000) return fail(400, "Bad signature.");

  const open = await sb(env, `auto_orders?owner=eq.${lower(me)}&status=eq.open&select=id&limit=${MAX_OPEN}`);
  if ((open || []).length >= MAX_OPEN) return fail(429, `You have ${MAX_OPEN} open auto orders. Cancel one first.`);
  if (!(await signedBy(getAddress(o.user), chainId, getAddress(b.contract), o, b.signature))) return fail(400, "The signature doesn't match. Try again.");

  const rows = await sb(env, "auto_orders", {
    method: "POST",
    prefer: "return=representation",
    body: {
      owner: lower(me),
      chain_id: chainId,
      contract: lower(b.contract),
      kind: b.kind,
      coin,
      coin_chain: coinChain,
      coin_kind: b.coinKind,
      race_id: b.coinKind === "race" ? lower(b.raceId) : null,
      network: b.coinKind === "ext" ? b.network : null,
      symbol: String(b.symbol || "").slice(0, 20),
      trigger_usd: trigger,
      amount_usd: amountUsd,
      nonce: String(o.nonce),
      order_json: {
        user: getAddress(o.user),
        tokenIn: getAddress(o.tokenIn),
        tokenOut: getAddress(o.tokenOut),
        amountIn: o.amountIn,
        minOut: o.minOut,
        mode: Number(o.mode),
        destChainId: o.destChainId,
        maxRouteFee: o.maxRouteFee,
        deadline: o.deadline,
        nonce: o.nonce,
      },
      signature: b.signature,
    },
  });
  return json({ order: out(rows[0]) });
}

export async function autoRoute(env, me, parts, method, body) {
  if (parts.length === 1 && method === "GET") {
    const rows = await sb(env, `auto_orders?owner=eq.${lower(me)}&select=${COLS}&order=id.desc&limit=100`);
    return json({ orders: (rows || []).map(out) });
  }
  if (parts.length === 1 && method === "POST") return place(env, me, body);
  if (parts.length === 2 && /^\d{1,15}$/.test(parts[1]) && method === "DELETE") {
    const rows = await sb(env, `auto_orders?id=eq.${parts[1]}&owner=eq.${lower(me)}&status=eq.open`, {
      method: "PATCH",
      prefer: "return=representation",
      body: { status: "cancelled", updated_at: new Date().toISOString() },
    });
    if (!rows || !rows.length) return fail(404, "That order isn't open.");
    return json({ order: out(rows[0]) });
  }
  return fail(404, "Not found.");
}
