/**
 * /sol-rpc → a Solana RPC node, for sasa's own pages (Solana launches, lib/sollaunch.ts).
 *
 * The node's address (with its key) stays on the server: Cloudflare secret SOLANA_RPC_URL,
 * e.g. a Helius / QuickNode / Alchemy URL. Optional SOLANA_RPC_URL_2: a second node, used when
 * the first one fails or is over its quota. Without either, Solana's public node is used
 * (slow and rate-limited: fine for testing, not for everyone).
 *
 * Only the JSON-RPC methods the site needs are passed on (getSignaturesForAddress and
 * getTransaction: the first minutes of a new sasa coin's trades, before the market lists have them), one call per request (no batches),
 * only from sasa's own pages, at most DAILY_CALLS a day per network address (so nobody can use
 * up the node's quota; a launch takes about 30 calls).
 */
import { net64 } from "../../edge/ai-api.js";

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const DAILY_CALLS = 8000; // a launch or trade takes about 30–80 calls; a page open for an hour a few hundred

/** true while this network address is under today's limit (true too if the counter can't be reached). */
async function underLimit(env, request) {
  const key = env.SUPABASE_SERVICE_KEY;
  let ip = String(request.headers.get("cf-connecting-ip") || "").slice(0, 64);
  if (!key || !ip) return true;
  if (ip.includes(":")) ip = net64(ip);
  try {
    const headers = { apikey: key, "content-type": "application/json" };
    if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
    const r = await fetch(`${env.SUPABASE_URL || SUPABASE_URL}/rest/v1/rpc/ai_take`, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_address: `ip:${ip}`, p_kind: "solrpc", p_limit: DAILY_CALLS }),
    });
    if (!r.ok) return true;
    return (await r.json()) !== false;
  } catch {
    return true;
  }
}

const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const ALLOWED = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  // the current epoch: Meteora launches check token transfer fees with it (lib/soldbc.ts)
  "getEpochInfo",
  "getFeeForMessage",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getRecentPrioritizationFees",
  "getSignaturesForAddress",
  "getSignatureStatuses",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenSupply",
  "getTransaction",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
]);
const MAX_BODY = 32 * 1024;

const fail = (status, message, id = null) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const hostOf = (v) => {
  try {
    return v ? new URL(v).host : "";
  } catch {
    return "";
  }
};

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204 });
  if (method !== "POST") return fail(405, "POST only.");

  // only sasa's own pages (a call from another site, or one that says nothing, is refused)
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  if (site && site !== "same-origin") return fail(403, "Not allowed.");
  if (origin && hostOf(origin) !== url.host) return fail(403, "Not allowed.");
  if (!site && !origin && hostOf(referer) !== url.host) return fail(403, "Not allowed.");

  const text = await request.text();
  if (text.length > MAX_BODY) return fail(413, "Too big.");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "Bad request.");
  }
  if (!body || Array.isArray(body) || typeof body.method !== "string") return fail(400, "One call at a time.");
  if (!ALLOWED.has(body.method)) return fail(403, "Not allowed.", body.id ?? null);
  if (!(await underLimit(env, request))) return fail(429, "Too many requests today. Try again tomorrow.", body.id ?? null);

  const nodes = [env.SOLANA_RPC_URL, env.SOLANA_RPC_URL_2].filter(Boolean);
  if (!nodes.length) nodes.push(PUBLIC_RPC);
  let last = null;
  for (const node of nodes) {
    try {
      const r = await fetch(node, { method: "POST", headers: { "content-type": "application/json" }, body: text });
      // over quota / node trouble: try the next node
      if ((r.status === 429 || r.status >= 500) && node !== nodes[nodes.length - 1]) {
        last = r;
        continue;
      }
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (e) {
      last = e;
    }
  }
  console.error("sol-rpc: no node answered", last && (last.status || last.message));
  return fail(502, "Solana is busy. Try again in a moment.", body.id ?? null);
}
