/**
 * /ely-rpc → an Elysium mainnet node, with fallbacks (lib/elysium.ts reads through it).
 *
 * Elysium's official public node (Conduit) answers "Rate Limit Exceeded" after a handful of calls
 * from one browser, which left launches and trades waiting for 30–90 s. Here every call goes to the
 * first node that answers properly: Cloudflare variable ELY_UPSTREAMS (comma-separated, optional,
 * tried first), then the public nodes below. Wallets that add Elysium can use it too (CORS open),
 * so only eth_* / net_* / web3_* methods pass, batches of at most 20, and every network address
 * gets DAILY_CALLS a day (a launch or a trade takes ~20–40 calls).
 */
import { net64 } from "../../edge/ai-api.js";

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const DAILY_CALLS = 20000;
const MAX_BODY = 64 * 1024;
const MAX_BATCH = 20;
const PUBLIC_NODES = [
  "https://rpc-elysium-mainnet.t.conduit.xyz",
  "https://rpc.elysium.kinetiq.xyz",
  "https://mainnet-rpc.elysium.kinetiq.xyz",
  "https://rpc-live.boxa.club",
];
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

const fail = (status, message, id = null) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  });

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
      body: JSON.stringify({ p_address: `ip:${ip}`, p_kind: "elyrpc", p_limit: DAILY_CALLS }),
    });
    if (!r.ok) return true;
    return (await r.json()) !== false;
  } catch {
    return true;
  }
}

const okMethod = (m) => typeof m === "string" && /^(eth|net|web3)_[A-Za-z]+$/.test(m) && !/^eth_(sign|signTransaction|sendTransaction|accounts|coinbase)$/.test(m);
// a node that is over its limit or broken answers with these: try the next one
const busy = (t) => /"error"/.test(t) && /rate limit|too many requests|unauthorized rpc key|api key/i.test(t.slice(0, 600));

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (method !== "POST") return fail(405, "POST only.");

  const text = await request.text();
  if (text.length > MAX_BODY) return fail(413, "Too big.");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "Bad request.");
  }
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > MAX_BATCH) return fail(400, "Too many calls in one request.");
  if (!calls.every((c) => c && okMethod(c.method))) return fail(403, "Not allowed.", Array.isArray(body) ? null : body?.id ?? null);
  if (!(await underLimit(env, request))) return fail(429, "Too many requests today. Try again tomorrow.", Array.isArray(body) ? null : body.id ?? null);

  const own = String(env.ELY_UPSTREAMS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^https:\/\//.test(s));
  const nodes = [...own, ...PUBLIC_NODES.filter((n) => !own.includes(n))];
  let last = null;
  for (const node of nodes) {
    try {
      const r = await fetch(node, { method: "POST", headers: { "content-type": "application/json" }, body: text, signal: AbortSignal.timeout(8000) });
      const out = await r.text();
      if (r.status === 429 || r.status >= 500 || r.status === 401 || r.status === 403 || busy(out)) {
        last = `${node} ${r.status}`;
        continue;
      }
      return new Response(out, { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
    } catch (e) {
      last = `${node} ${e && e.message}`;
    }
  }
  console.error("ely-rpc: no node answered", last);
  // 200 with a JSON-RPC error: Cloudflare swaps a 502 from a function for its own HTML page
  return fail(200, "Elysium is busy. Try again in a moment.", Array.isArray(body) ? null : body.id ?? null);
}
