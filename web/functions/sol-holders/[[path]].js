/**
 * Cloudflare Pages Function: /sol-holders/<mint>  → { mint, holders }
 *
 * How many wallets hold a Solana coin launched on sasa (token accounts of the mint with a
 * balance, counted by owner, on both token programs). Read from sasa's own Solana node
 * (SOLANA_RPC_URL, the same secret /sol-rpc uses), shared through Cloudflare's cache for a
 * minute. Only coins in sol_sasa_coins are answered, so the node can't be used for anything else.
 * Used by indexer/holders.mjs for the holder counts and their 15-minute change.
 */
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBdf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
const json = (o, status = 200, maxAge = 0) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store" },
  });

function b64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function isSasaCoin(mint) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/sol_sasa_coins?address=eq.${mint}&select=address`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    cf: { cacheTtl: 300, cacheEverything: true },
  }).catch(() => null);
  if (!r || !r.ok) return false;
  const j = await r.json().catch(() => []);
  return Array.isArray(j) && j.length > 0;
}

async function count(node, mint) {
  const owners = new Set();
  for (const program of PROGRAMS) {
    const r = await fetch(node, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getProgramAccounts",
        params: [
          program,
          {
            encoding: "base64",
            dataSlice: { offset: 32, length: 40 },
            filters: program === PROGRAMS[0] ? [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }] : [{ memcmp: { offset: 0, bytes: mint } }],
          },
        ],
      }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.error || !Array.isArray(j.result)) {
      count.why = `${r.status} ${String(j?.error?.message ?? "").slice(0, 120)}`;
      return null;
    }
    for (const a of j.result) {
      const b = b64(a?.account?.data?.[0] ?? "");
      if (b.length < 40) continue;
      let amt = 0n;
      for (let i = 7; i >= 0; i--) amt = (amt << 8n) | BigInt(b[32 + i]);
      if (amt > 0n) owners.add(Array.from(b.subarray(0, 32), (x) => x.toString(16).padStart(2, "0")).join(""));
    }
  }
  return owners.size;
}

export async function onRequestGet({ request, params, env, waitUntil }) {
  const mint = Array.isArray(params.path) ? params.path[0] : params.path;
  if (!mint || !B58.test(mint)) return json({ error: "bad mint" }, 400);
  const cache = caches.default;
  const key = new Request(new URL(`/sol-holders/${mint}`, request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const nodes = [env.SOLANA_RPC_URL, env.SOLANA_RPC_URL_2].filter(Boolean);
  if (!nodes.length) return json({ error: "no node" }, 503);
  if (!(await isSasaCoin(mint))) return json({ error: "not a sasa coin" }, 404, 300);
  for (const node of nodes) {
    const n = await count(node, mint).catch(() => null);
    if (n !== null) {
      const res = json({ mint, holders: n }, 200, 60);
      waitUntil(cache.put(key, res.clone()));
      return res;
    }
  }
  return json({ error: "node busy", why: count.why ?? "" }, 503);
}
