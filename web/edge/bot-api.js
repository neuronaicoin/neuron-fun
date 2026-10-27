// sasa Bot test mode, admins only (FORUM_ADMINS), called from functions/api/[[path]].js:
//
//   GET /api/bot/stats?hours=24   → { stats, coins }   what the bot would have picked and how it ended
//   GET /api/bot/launchlog        → { errors }         the last 50 Solana launches that failed, and why
//
// The indexer (indexer/sniper.mjs) watches every new pump.fun coin and fills sniper_signals.

import { admins } from "./forum-core.js";

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function db(env, path, init = {}) {
  const key = env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: key, "content-type": "application/json" };
  if (key && key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  const r = await fetch(`${env.SUPABASE_URL || SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await r.text();
  if (!r.ok) {
    // the indexer hasn't made the table yet: nothing to show
    if (/sniper_|sol_launch_errors/.test(text)) return null;
    throw new Error(`db ${r.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

// sasa's own admin accounts (the same ones that see the admin-only tests on the site)
const SASA_ADMINS = ["0x5a5506fce4c9d9c2989a2988cb2b63988207bd1b", "0xe0ba5905940d748b23dc01266aa884e2391cca2f", "0xf4bc1b22e117a621e1118d09f7bb015c685a9617"];

export async function botRoute(env, me, parts, method, url) {
  const who = String(me || "").toLowerCase();
  if (!SASA_ADMINS.includes(who) && !admins(env).includes(who)) return json({ error: "Not found." }, 404);
  // Solana launches that failed in someone's browser (edge/sol-api.js keeps them)
  if (parts.length === 2 && parts[1] === "launchlog" && method === "GET") {
    const rows = await db(env, "sol_launch_errors?select=at,owner,creator,mint,kind,step,error,ua&order=at.desc&limit=50").catch(() => null);
    return json({ errors: rows ?? [] });
  }
  if (!(parts.length === 2 && parts[1] === "stats" && method === "GET")) return json({ error: "Not found." }, 404);
  const hours = Math.max(1, Math.min(336, Math.floor(Number(url.searchParams.get("hours")) || 24)));
  const level = Math.max(0, Math.min(100, Math.floor(Number(url.searchParams.get("min")) || 50)));
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const [stats, coins, opt] = await Promise.all([
    db(env, "rpc/sniper_stats", { method: "POST", body: JSON.stringify({ p_hours: hours }) }),
    db(
      env,
      `sniper_signals?select=mint,created_at,name,symbol,x,telegram,website,score,passed,fail,checks,entry_mc,peak_mc,low_mc,peak_sec,result,done` +
        `&passed=eq.true&score=gte.${level}&created_at=gt.${encodeURIComponent(since)}&order=created_at.desc&limit=100`
    ),
    // the optimizer's latest run (indexer/sniperopt.mjs)
    db(env, "sniper_opt?select=run_at,result&order=run_at.desc&limit=1").catch(() => null),
  ]);
  return json({ stats: stats ?? null, coins: coins ?? [], opt: opt?.[0] ?? null });
}
