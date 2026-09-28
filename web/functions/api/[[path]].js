/**
 * Cloudflare Pages Function: /api/*  (price alerts, 🔔 notifications, web push)
 *
 * Who is who: the site asks the wallet to sign a short message once (free,
 * no transaction). We check the signature and hand back a session token
 * (HMAC, 30 days). Every other call carries that token.
 *
 * Env (Cloudflare Pages → Settings → Variables and secrets, Production):
 *   SUPABASE_SERVICE_KEY  Supabase secret key (the same one Railway uses)   [secret]
 *   SESSION_SECRET        long random string that signs session tokens      [secret]
 *   SUPABASE_URL          optional, defaults to the project below
 *
 * Routes
 *   POST   /api/session            { address, message, signature } → { token, address, expires }
 *   GET    /api/alerts             → { alerts }
 *   POST   /api/alerts             { coinId, kind, dir, target, repeat, push } → { alert }
 *   PATCH  /api/alerts/:id         { active?, repeat?, push? } → { alert }
 *   DELETE /api/alerts/:id
 *   GET    /api/notes              → { notes, unread }
 *   POST   /api/notes/read         { ids?: number[], all?: true }
 *   POST   /api/push               { endpoint, keys: { p256dh, auth } }
 *   DELETE /api/push               { endpoint }
 *   /api/forum/*                   see edge/forum-api.js
 *
 * Optional env: FORUM_ADMINS  comma-separated wallet addresses that can moderate every forum board
 */
import { createPublicClient, defineChain, getAddress, http, isAddress, recoverMessageAddress } from "viem";
import { forumRoute } from "../../edge/forum-api.js";
import { socialRoute } from "../../edge/social-api.js";
import { aiRoute } from "../../edge/ai-api.js";

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SESSION_DAYS = 30;
const MAX_ALERTS = 50;
const COIN_ID = /^0x[0-9a-f]{40}:0x[0-9a-f]{64}$/;
const KINDS = new Set(["mc", "price", "move", "bond", "grad"]);
const ALLOWED_HOSTS = /^(sasapad\.(fun|com)|www\.sasapad\.(fun|com)|([a-z0-9-]+\.)?neuron-fun\.pages\.dev|localhost(:\d+)?)$/;

// Smart-contract wallets (e.g. Coinbase Smart Wallet) are checked on chain.
const VERIFY_CHAINS = [
  defineChain({ id: 84532, name: "Base Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://sepolia.base.org"] } } }),
  defineChain({ id: 46630, name: "Robinhood Chain Testnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com/rpc"] } } }),
];

// ------------------------------------------------------------------ helpers

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (status, error) => json({ error }, status);

const enc = new TextEncoder();
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(t + "===".slice((t.length + 3) % 4)), (c) => c.charCodeAt(0));
};

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function makeToken(secret, address) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const body = b64url(enc.encode(JSON.stringify({ a: address, exp })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return { token: `${body}.${b64url(sig)}`, exp };
}

async function readToken(secret, header) {
  const m = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header || "");
  if (!m) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(m[2]), enc.encode(m[1]));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(m[1])));
    if (!p || typeof p.a !== "string" || !(p.exp > Date.now() / 1000)) return null;
    return p.a;
  } catch {
    return null;
  }
}

/** Supabase REST call with the secret key. */
async function sb(env, path, { method = "GET", body, prefer } = {}) {
  const key = env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: key, "content-type": "application/json" };
  // Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys must not.
  if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  if (prefer) headers.prefer = prefer;
  const r = await fetch(`${env.SUPABASE_URL || SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!r.ok) {
    const msg = (data && (data.message || data.hint)) || text || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return { data, range: r.headers.get("content-range") };
}

const enc64 = (s) => encodeURIComponent(s);

function alertOut(r) {
  return {
    id: Number(r.id),
    coinId: r.coin_id,
    kind: r.kind,
    dir: r.dir,
    target: Number(r.target),
    repeat: r.repeat,
    push: r.push,
    active: r.active,
    firedAt: r.fired_at,
    createdAt: r.created_at,
    coin: r.coins ? { name: r.coins.name, symbol: r.coins.symbol, logo: r.coins.logo } : null,
  };
}
const ALERT_COLS = "id,coin_id,kind,dir,target,repeat,push,active,fired_at,created_at,coins(name,symbol,logo)";

async function readBody(request, limit = 8192) {
  try {
    const t = await request.text();
    if (t.length > limit) return null;
    return t ? JSON.parse(t) : {};
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ routes

async function session(env, request, body) {
  const { address, message, signature } = body || {};
  if (typeof address !== "string" || !isAddress(address)) return fail(400, "Bad address.");
  if (typeof message !== "string" || message.length > 600) return fail(400, "Bad message.");
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature) || signature.length > 20000) return fail(400, "Bad signature.");

  // The message must be ours, for this address, for this site, and fresh.
  const addr = getAddress(address);
  const host = new URL(request.url).host;
  const lines = message.split("\n");
  const field = (name) => (lines.find((l) => l.startsWith(`${name}: `)) || "").slice(name.length + 2).trim();
  if (!lines[0].startsWith("Sign in to sasa")) return fail(400, "Bad message.");
  if (field("Address").toLowerCase() !== addr.toLowerCase()) return fail(400, "The message is for another wallet.");
  const site = field("Site");
  if (site !== host || !ALLOWED_HOSTS.test(site)) return fail(400, "The message is for another site.");
  const issued = Date.parse(field("Issued"));
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > 10 * 60_000) return fail(400, "The message expired. Try again.");

  let ok = false;
  try {
    ok = (await recoverMessageAddress({ message, signature })).toLowerCase() === addr.toLowerCase();
  } catch {}
  if (!ok) {
    for (const chain of VERIFY_CHAINS) {
      try {
        const pub = createPublicClient({ chain, transport: http(undefined, { timeout: 8000 }) });
        if (await pub.verifyMessage({ address: addr, message, signature })) {
          ok = true;
          break;
        }
      } catch {}
    }
  }
  if (!ok) return fail(401, "The signature doesn't match this wallet.");
  const t = await makeToken(env.SESSION_SECRET, addr.toLowerCase());
  return json({ token: t.token, address: addr.toLowerCase(), expires: t.exp });
}

async function listAlerts(env, me) {
  const { data } = await sb(env, `alerts?owner=eq.${enc64(me)}&select=${ALERT_COLS}&order=created_at.desc&limit=200`);
  return json({ alerts: (data || []).map(alertOut) });
}

function checkAlertInput(b) {
  const kind = b.kind;
  if (!KINDS.has(kind)) return "Pick an alert type.";
  const target = Number(b.target);
  if (kind === "mc" || kind === "price") {
    if (b.dir !== "above" && b.dir !== "below") return "Pick above or below.";
    if (!(target > 0) || !Number.isFinite(target)) return "Type a number above zero.";
    if (kind === "mc" && target > 1e12) return "That's more than $1T. Pick a smaller number.";
    if (kind === "price" && target > 1e6) return "That price is too high.";
  } else if (kind === "move") {
    if (!["up", "down", "any"].includes(b.dir)) return "Pick up, down or either way.";
    if (!(target >= 2 && target <= 1000)) return "Pick a move between 2% and 1000%.";
  }
  return null;
}

async function createAlert(env, me, b) {
  if (!b || typeof b.coinId !== "string" || !COIN_ID.test(b.coinId)) return fail(400, "Unknown coin.");
  const bad = checkAlertInput(b);
  if (bad) return fail(400, bad);
  const kind = b.kind;
  const once = kind === "bond" || kind === "grad";
  const row = {
    owner: me,
    coin_id: b.coinId,
    kind,
    dir: once ? "" : b.dir,
    target: once ? 0 : kind === "move" ? Math.round(Number(b.target) * 10) / 10 : Number(b.target),
    repeat: once ? false : !!b.repeat,
    push: b.push !== false,
    active: true,
    armed: true,
  };

  const [coin, mine] = await Promise.all([
    sb(env, `coins?id=eq.${enc64(row.coin_id)}&select=id,graduated_chain`),
    sb(env, `alerts?owner=eq.${enc64(me)}&active=is.true&select=id,coin_id,kind,dir,target`),
  ]);
  if (!coin.data || !coin.data.length) return fail(404, "Unknown coin.");
  if (kind === "grad" && coin.data[0].graduated_chain !== null) return fail(400, "This coin has already graduated.");
  const active = mine.data || [];
  if (active.length >= MAX_ALERTS) return fail(400, `You have ${MAX_ALERTS} alerts on. Turn one off to add another.`);
  const dup = active.some(
    (a) => a.coin_id === row.coin_id && a.kind === row.kind && a.dir === row.dir && Math.abs(Number(a.target) - row.target) <= Math.abs(row.target) * 1e-9
  );
  if (dup) return fail(400, "You already have this alert.");

  try {
    const { data } = await sb(env, `alerts?select=${ALERT_COLS}`, { method: "POST", body: row, prefer: "return=representation" });
    return json({ alert: alertOut(data[0]) }, 201);
  } catch (e) {
    if (/alert_limit/.test(e.message)) return fail(400, `You have ${MAX_ALERTS} alerts on. Turn one off to add another.`);
    throw e;
  }
}

async function updateAlert(env, me, id, b) {
  if (!b) return fail(400, "Bad request.");
  const patch = {};
  if (typeof b.active === "boolean") patch.active = b.active;
  if (typeof b.repeat === "boolean") patch.repeat = b.repeat;
  if (typeof b.push === "boolean") patch.push = b.push;
  if (!Object.keys(patch).length) return fail(400, "Nothing to change.");
  if (patch.active === true) {
    // Switched back on: start fresh, and wait for the line to be crossed again.
    patch.armed = false;
    patch.fired_at = null;
    const cur = await sb(env, `alerts?id=eq.${id}&owner=eq.${enc64(me)}&select=kind,coin_id,coins(graduated_chain)`);
    const a = cur.data && cur.data[0];
    if (!a) return fail(404, "Alert not found.");
    if (a.kind === "grad" && a.coins && a.coins.graduated_chain !== null) return fail(400, "This coin has already graduated.");
    if (a.kind === "move" || a.kind === "bond" || a.kind === "grad") patch.armed = true;
  }
  try {
    const { data } = await sb(env, `alerts?id=eq.${id}&owner=eq.${enc64(me)}&select=${ALERT_COLS}`, {
      method: "PATCH",
      body: patch,
      prefer: "return=representation",
    });
    if (!data || !data.length) return fail(404, "Alert not found.");
    return json({ alert: alertOut(data[0]) });
  } catch (e) {
    if (/alert_limit/.test(e.message)) return fail(400, `You have ${MAX_ALERTS} alerts on. Turn one off first.`);
    throw e;
  }
}

async function deleteAlert(env, me, id) {
  await sb(env, `alerts?id=eq.${id}&owner=eq.${enc64(me)}`, { method: "DELETE" });
  return json({ ok: true });
}

async function listNotes(env, me) {
  const [list, unread] = await Promise.all([
    sb(env, `notifications?owner=eq.${enc64(me)}&select=id,coin_id,kind,title,body,url,read,created_at&order=id.desc&limit=30`),
    sb(env, `notifications?owner=eq.${enc64(me)}&read=is.false&select=id&limit=1`, { prefer: "count=exact" }),
  ]);
  const total = Number(((unread.range || "").split("/")[1] || "0").replace("*", "0"));
  return json({
    notes: (list.data || []).map((n) => ({
      id: Number(n.id),
      coinId: n.coin_id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      url: n.url,
      read: n.read,
      createdAt: n.created_at,
    })),
    unread: Number.isFinite(total) ? total : 0,
  });
}

async function readNotes(env, me, b) {
  if (!b) return fail(400, "Bad request.");
  if (b.all === true) {
    await sb(env, `notifications?owner=eq.${enc64(me)}&read=is.false`, { method: "PATCH", body: { read: true } });
  } else if (Array.isArray(b.ids) && b.ids.length && b.ids.length <= 100 && b.ids.every((x) => Number.isInteger(x) && x > 0)) {
    await sb(env, `notifications?owner=eq.${enc64(me)}&id=in.(${b.ids.join(",")})`, { method: "PATCH", body: { read: true } });
  } else return fail(400, "Bad request.");
  return json({ ok: true });
}

function validEndpoint(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && u.length <= 1000;
  } catch {
    return false;
  }
}

async function savePush(env, me, b) {
  const endpoint = b && b.endpoint;
  const p256dh = b && b.keys && b.keys.p256dh;
  const auth = b && b.keys && b.keys.auth;
  if (!validEndpoint(endpoint) || typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100) {
    return fail(400, "Bad subscription.");
  }
  await sb(env, "push_subs?on_conflict=endpoint", {
    method: "POST",
    body: { endpoint, owner: me, p256dh, auth, failures: 0 },
    prefer: "resolution=merge-duplicates",
  });
  return json({ ok: true });
}

async function deletePush(env, me, b) {
  const endpoint = b && b.endpoint;
  if (!validEndpoint(endpoint)) return fail(400, "Bad subscription.");
  await sb(env, `push_subs?endpoint=eq.${enc64(endpoint)}&owner=eq.${enc64(me)}`, { method: "DELETE" });
  return json({ ok: true });
}

// ------------------------------------------------------------------ entry

export async function onRequest(ctx) {
  const { request, env } = ctx;
  if (!env.SUPABASE_SERVICE_KEY || !env.SESSION_SECRET) return fail(503, "Alerts are not set up yet.");
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "").split("/").filter(Boolean);
  const method = request.method;

  // Only our own pages may call this (stops other sites using a visitor's session).
  const origin = request.headers.get("origin");
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {}
    if (host !== url.host) return fail(403, "Not allowed.");
  }
  if (method === "OPTIONS") return new Response(null, { status: 204 });

  try {
    // Profile pictures travel as a data URL (a 256px WebP is ~10-40 KB); everything else stays small.
    const limit = parts[0] === "social" && parts[1] === "avatar" ? 400_000 : 8192;
    const body = method === "GET" || method === "HEAD" ? {} : await readBody(request, limit);
    if (body === null) return fail(400, "Bad request.");

    if (parts[0] === "session" && parts.length === 1 && method === "POST") return await session(env, request, body);

    const me = await readToken(env.SESSION_SECRET, request.headers.get("authorization"));
    if (!me) return fail(401, "Please sign in again.");

    if (parts[0] === "alerts") {
      if (parts.length === 1 && method === "GET") return await listAlerts(env, me);
      if (parts.length === 1 && method === "POST") return await createAlert(env, me, body);
      if (parts.length === 2 && /^\d{1,15}$/.test(parts[1])) {
        if (method === "PATCH") return await updateAlert(env, me, parts[1], body);
        if (method === "DELETE") return await deleteAlert(env, me, parts[1]);
      }
    }
    if (parts[0] === "notes") {
      if (parts.length === 1 && method === "GET") return await listNotes(env, me);
      if (parts.length === 2 && parts[1] === "read" && method === "POST") return await readNotes(env, me, body);
    }
    if (parts[0] === "forum") return await forumRoute(ctx, me, parts, method, body, url);
    if (parts[0] === "social") return await socialRoute(ctx, me, parts, method, body);
    if (parts[0] === "ai") return await aiRoute(ctx, me, parts, method, body);
    if (parts[0] === "push" && parts.length === 1) {
      if (method === "POST") return await savePush(env, me, body);
      if (method === "DELETE") return await deletePush(env, me, body);
    }
    return fail(404, "Not found.");
  } catch (e) {
    console.error("api error", e && e.message);
    return fail(500, "Something went wrong. Try again in a moment.");
  }
}
