// Copying whales on Futures. Called from functions/api/[[path]].js with the signed-in address:
//
//   GET    /api/copy             → { copies: [{ whale, per_trade, max_lev, copy_closes, stop_loss, active, paused_why }], agent }
//   POST   /api/copy/agent       → { agent }   the follower's trading key address (made once); they approve it on Hyperliquid
//   POST   /api/copy             { whale, per_trade, max_lev, copy_closes, stop_loss } → { ok }
//   DELETE /api/copy/0x…         → { ok }      stop copying that trader
//
// The trading key is made here and stored encrypted with COPY_KEY_SECRET; the indexer
// (copytrade.mjs, same secret) places the copied orders with it. A Hyperliquid trading key can
// trade the account it was approved for, but can never withdraw from it.

import { privateKeyToAccount } from "viem/accounts";
import { encryptKey } from "../lib/copykey.js";

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const MAX_COPIES = 10;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);

async function sb(env, path, { method = "GET", body, prefer } = {}) {
  const key = env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: key, "content-type": "application/json" };
  if (key && key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  if (prefer) headers.prefer = prefer;
  const r = await fetch(`${env.SUPABASE_URL || SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`db ${r.status}: ${text.slice(0, 200)}`);
    err.missing = /copy_(agents|follows|positions)/.test(text) && /does not exist|schema cache/.test(text);
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/** A new secp256k1 private key (32 random bytes below the curve order, which any random 32 bytes almost surely are). */
function newKey() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

export async function copyRoute(env, me, parts, method, body) {
  const owner = String(me || "").toLowerCase();
  if (!isAddr(owner)) return json({ error: "Please sign in again." }, 401);
  try {
    if (parts.length === 1 && method === "GET") {
      const [copies, agent] = await Promise.all([
        sb(env, `copy_follows?follower=eq.${owner}&select=whale,per_trade,max_lev,copy_closes,stop_loss,active,paused_why&order=created_at.desc`),
        sb(env, `copy_agents?follower=eq.${owner}&select=agent_address`),
      ]);
      return json({ copies: copies || [], agent: agent?.[0]?.agent_address ?? null });
    }
    if (parts.length === 2 && parts[1] === "agent" && method === "POST") {
      const have = await sb(env, `copy_agents?follower=eq.${owner}&select=agent_address`);
      if (have?.[0]) return json({ agent: have[0].agent_address });
      if (!env.COPY_KEY_SECRET) return json({ error: "Copy trading opens soon." }, 503);
      const key = newKey();
      const agent = privateKeyToAccount(key).address.toLowerCase();
      await sb(env, "copy_agents?on_conflict=follower", {
        method: "POST",
        prefer: "resolution=ignore-duplicates",
        body: { follower: owner, agent_address: agent, key_enc: await encryptKey(key, env.COPY_KEY_SECRET) },
      });
      // two taps at once: the first key stored wins
      const now = await sb(env, `copy_agents?follower=eq.${owner}&select=agent_address`);
      return json({ agent: now?.[0]?.agent_address ?? agent });
    }
    if (parts.length === 1 && method === "POST") {
      const whale = String(body?.whale || "").toLowerCase();
      if (!isAddr(whale) || whale === owner) return json({ error: "That isn't a trader's address." }, 400);
      const per = num(body?.per_trade, 10, 5000);
      const lev = num(body?.max_lev, 1, 20);
      const stop = body?.stop_loss === null || body?.stop_loss === undefined || body?.stop_loss === "" ? null : num(body?.stop_loss, 1, 1_000_000);
      if (per === null) return json({ error: "Per trade is $10 to $5,000." }, 400);
      if (lev === null) return json({ error: "Leverage is 1x to 20x." }, 400);
      if (body?.stop_loss != null && body?.stop_loss !== "" && stop === null) return json({ error: "Enter the stop as a dollar amount." }, 400);
      const agent = await sb(env, `copy_agents?follower=eq.${owner}&select=agent_address`);
      if (!agent?.[0]) return json({ error: "Approve copying first." }, 400);
      const rows = await sb(env, `copy_follows?follower=eq.${owner}&active=eq.true&select=whale`);
      if ((rows || []).length >= MAX_COPIES && !(rows || []).some((r) => r.whale === whale)) return json({ error: `You can copy up to ${MAX_COPIES} traders. Stop one first.` }, 400);
      await sb(env, "copy_follows?on_conflict=follower,whale", {
        method: "POST",
        prefer: "resolution=merge-duplicates",
        body: { follower: owner, whale, per_trade: per, max_lev: Math.round(lev), copy_closes: body?.copy_closes !== false, stop_loss: stop, active: true, paused_why: null, updated_at: new Date().toISOString() },
      });
      // copying a trader also follows them: their moves are watched, and you get the alerts
      await sb(env, "whale_follows?on_conflict=follower,whale", { method: "POST", prefer: "resolution=ignore-duplicates", body: { follower: owner, whale } }).catch(() => {});
      return json({ ok: true });
    }
    if (parts.length === 2 && method === "DELETE") {
      const whale = String(parts[1] || "").toLowerCase();
      if (!isAddr(whale)) return json({ error: "That isn't a trader's address." }, 400);
      await sb(env, `copy_follows?follower=eq.${owner}&whale=eq.${whale}`, { method: "PATCH", body: { active: false, paused_why: "stopped", updated_at: new Date().toISOString() } });
      return json({ ok: true });
    }
  } catch (e) {
    if (e.missing) return json({ error: "Copy trading opens soon." }, 503);
    throw e;
  }
  return json({ error: "Not found." }, 404);
}
