// Perps alerts sign-up, called from functions/api/[[path]].js after a signed-in user opens a
// perps position on sasa:
//
//   POST /api/perps/watch   → { ok }
//   GET  /api/perps/admin   → { admin }   (admins test Futures from a blocked country; FORUM_ADMINS)
//
// Puts the signed-in address in perps_watch (perps.sql). The indexer (perps.mjs) then tells them
// when a take profit, stop loss or liquidation closes a position. Only the caller's own address
// can be added (it comes from the session), and their Hyperliquid fills are public anyway.

import { NETWORK } from "../lib/network.js";
import { admins } from "./forum-core.js";

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function perpsRoute(env, me, parts, method) {
  if (parts.length === 2 && parts[1] === "admin" && method === "GET") return json({ admin: admins(env).includes(String(me || "").toLowerCase()) });
  if (!(parts.length === 2 && parts[1] === "watch" && method === "POST")) return json({ error: "Not found." }, 404);
  // perps trade at mainnet only; the test site never adds anyone
  if (NETWORK !== "mainnet" && !env.PERPS_ANY_NETWORK) return json({ ok: false });
  const address = String(me || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return json({ error: "Please sign in again." }, 401);
  const key = env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: key, "content-type": "application/json", prefer: "resolution=merge-duplicates" };
  if (key && key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  // a new sign-up starts watching from now; an existing one is switched back on
  const r = await fetch(`${env.SUPABASE_URL || SUPABASE_URL}/rest/v1/perps_watch?on_conflict=address`, {
    method: "POST",
    headers,
    body: JSON.stringify({ address, active: true, idle_since: null, seen_at: new Date().toISOString() }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    // perps.sql not run yet: nothing to sign up to, and nothing for the user to fix
    if (/perps_watch/.test(t)) return json({ ok: false });
    throw new Error(`db ${r.status}: ${t.slice(0, 200)}`);
  }
  return json({ ok: true });
}
