/**
 * Cloudflare Pages Function: /gt/*  — GeckoTerminal, through Cloudflare's cache.
 *
 * Coin charts and trade lists of other DEXs' coins (web/lib/extchart.ts) read GeckoTerminal.
 * Every visitor asking it separately is slow (and its free limit is ~30 calls a minute per IP),
 * so the same answer is shared for a short while: candles 30 s, trades 10 s, a coin's pools
 * 10 min. Only GET, only GeckoTerminal's /networks/... paths. When GeckoTerminal says
 * "too many" or fails, that answer is passed on uncached and the site asks GeckoTerminal itself.
 */
const UP = "https://api.geckoterminal.com/api/v2";

function ttlFor(path) {
  if (/\/ohlcv\//.test(path)) return 30;
  if (/\/trades$/.test(path)) return 10;
  if (/\/tokens\/[^/]+\/pools$/.test(path)) return 600;
  return 30;
}

export async function onRequestGet({ request, params, waitUntil }) {
  const parts = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const path = "/" + parts.map(encodeURIComponent).join("/");
  if (!/^\/networks\/[a-z0-9_-]+\/(pools|tokens)\//i.test(path)) return new Response("Bad path", { status: 400 });
  const url = new URL(request.url);
  const target = UP + path + url.search;
  const cache = caches.default;
  const key = new Request(target, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  let r;
  try {
    r = await fetch(target, { headers: { accept: "application/json" }, cf: { cacheTtl: 0 } });
  } catch {
    return new Response(JSON.stringify({ error: "unreachable" }), { status: 502, headers: { "content-type": "application/json" } });
  }
  const body = await r.arrayBuffer();
  const headers = { "content-type": "application/json", "access-control-allow-origin": "*" };
  if (!r.ok) return new Response(body, { status: r.status, headers });
  const res = new Response(body, { status: 200, headers: { ...headers, "cache-control": `public, max-age=${ttlFor(path)}` } });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
