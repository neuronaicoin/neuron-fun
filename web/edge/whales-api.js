// Following traders on the Data tab, for phone alerts (indexer/whales.mjs sends them). Called from
// functions/api/[[path]].js with the signed-in address:
//
//   GET    /api/whales/follow            → { whales: ["0x…"] }
//   POST   /api/whales/follow            { whale } → { ok }
//   DELETE /api/whales/follow/0x…        → { ok }
//
// Anyone's Hyperliquid positions are public, so any address can be followed; up to 50 each.

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const MAX_FOLLOWS = 50;

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
    err.missing = /whale_follows/.test(text) && /does not exist|schema cache/.test(text);
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

export async function whalesRoute(env, me, parts, method, body) {
  const owner = String(me || "").toLowerCase();
  if (!isAddr(owner)) return json({ error: "Please sign in again." }, 401);
  if (parts[1] !== "follow") return json({ error: "Not found." }, 404);
  try {
    if (parts.length === 2 && method === "GET") {
      const rows = await sb(env, `whale_follows?follower=eq.${owner}&select=whale&order=created_at.desc&limit=${MAX_FOLLOWS}`);
      return json({ whales: (rows || []).map((r) => r.whale) });
    }
    if (parts.length === 2 && method === "POST") {
      const whale = String((body && body.whale) || "").toLowerCase();
      if (!isAddr(whale)) return json({ error: "That isn't a trader's address." }, 400);
      const rows = await sb(env, `whale_follows?follower=eq.${owner}&select=whale&limit=${MAX_FOLLOWS + 1}`);
      if ((rows || []).length >= MAX_FOLLOWS && !(rows || []).some((r) => r.whale === whale))
        return json({ error: `You can get alerts for up to ${MAX_FOLLOWS} traders. Stop one first.` }, 400);
      await sb(env, "whale_follows?on_conflict=follower,whale", { method: "POST", prefer: "resolution=ignore-duplicates", body: { follower: owner, whale } });
      return json({ ok: true });
    }
    if (parts.length === 3 && method === "DELETE") {
      const whale = String(parts[2] || "").toLowerCase();
      if (!isAddr(whale)) return json({ error: "That isn't a trader's address." }, 400);
      await sb(env, `whale_follows?follower=eq.${owner}&whale=eq.${whale}`, { method: "DELETE" });
      return json({ ok: true });
    }
  } catch (e) {
    if (e.missing) return json({ error: "Trader alerts open soon." }, 503);
    throw e;
  }
  return json({ error: "Not found." }, 404);
}
