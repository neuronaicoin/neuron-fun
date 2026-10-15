/**
 * /relay-proxy/* → Relay's API (api.relay.link, or its testnet API on the test site), with sasa's
 * Relay API key added here on the server (Cloudflare secret RELAY_API_KEY), so the key never
 * reaches a browser. Since 2026 Relay wants a key for quotes that carry a referrer and for
 * /requests/v3; with the key our quotes are tied to sasa (and its app fee).
 *
 * Only the calls the site makes are passed on, only from sasa's own pages.
 */
import { NETWORK } from "../../lib/network.js";

const UPSTREAM = NETWORK === "mainnet" ? "https://api.relay.link" : "https://api.testnets.relay.link";
const ALLOWED = [
  ["GET", /^\/chains$/],
  ["POST", /^\/quote(\/v2)?$/],
  ["GET", /^\/intents\/status(\/v[1-9])?$/],
  ["GET", /^\/requests\/v3$/],
  // signature steps of some routes (the quote names the endpoint)
  ["POST", /^\/authorize$/],
  ["POST", /^\/execute\/[a-z0-9/_-]{1,60}$/i],
];
const MAX_BODY = 64 * 1024;

const fail = (status, message) =>
  new Response(JSON.stringify({ message }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  // only sasa's own pages (a browser always sends Origin on POST; other sites' pages are refused)
  const origin = request.headers.get("origin");
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {}
    if (host !== url.host) return fail(403, "Not allowed.");
  }
  const path = url.pathname.replace(/^\/relay-proxy/, "") || "/";
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204 });
  if (!ALLOWED.some(([m, re]) => m === method && re.test(path))) return fail(404, "Not found.");

  const headers = { accept: "application/json" };
  if (env.RELAY_API_KEY) headers["x-api-key"] = env.RELAY_API_KEY;
  let body;
  if (method === "POST") {
    const text = await request.text();
    if (text.length > MAX_BODY) return fail(413, "Too big.");
    headers["content-type"] = "application/json";
    body = text;
    // a quote names sasa through the key; a referrer without a key is refused by Relay
    if (/^\/quote/.test(path)) {
      try {
        const j = JSON.parse(text);
        delete j.referrer;
        body = JSON.stringify(j);
      } catch {
        return fail(400, "Bad request.");
      }
    }
  }
  const r = await fetch(`${UPSTREAM}${path}${url.search}`, {
    method,
    headers,
    body,
    ...(path === "/chains" ? { cf: { cacheTtl: 3600, cacheEverything: true } } : {}),
  });
  const out = new Headers({ "content-type": r.headers.get("content-type") || "application/json" });
  out.set("cache-control", path === "/chains" ? "public, max-age=3600" : "no-store");
  return new Response(r.body, { status: r.status, headers: out });
}
