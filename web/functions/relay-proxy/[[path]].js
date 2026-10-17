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
// the only app fees a quote through sasa's key may carry: sasa's own (lib/config.ts RELAY_FEE_TO,
// the rewards wallet; and sasa admin, the earlier recipient)
const FEE_TO = new Set(["0x4670db0a98ac28d4093969e3dfbf16045e321073", "0xe0ba5905940d748b23dc01266aa884e2391cca2f"]);

const fail = (status, message) =>
  new Response(JSON.stringify({ message }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  // only sasa's own pages. A browser says where a call comes from (Sec-Fetch-Site, Origin or
  // Referer); a call that says nothing (a script, curl) or comes from another site is refused.
  const hostOf = (v) => {
    try {
      return v ? new URL(v).host : "";
    } catch {
      return "";
    }
  };
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  if (site && site !== "same-origin") return fail(403, "Not allowed.");
  if (origin && hostOf(origin) !== url.host) return fail(403, "Not allowed.");
  if (!site && !origin && hostOf(referer) !== url.host) return fail(403, "Not allowed.");
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
        // sasa's key carries sasa's fee only: no one else's fee can ride on it
        if (j.appFees !== undefined) {
          const ok = Array.isArray(j.appFees) && j.appFees.every((f) => FEE_TO.has(String(f?.recipient ?? "").toLowerCase()));
          if (!ok) return fail(400, "Bad request.");
        }
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
