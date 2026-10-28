// sasa Bot test mode, admins only (FORUM_ADMINS), called from functions/api/[[path]].js:
//
//   GET /api/bot/stats?hours=24   → { stats, coins }   what the bot would have picked and how it ended
//   GET /api/bot/trends           → { themes }         Trend Radar: themes new coins launch on, last hour
//   GET /api/bot/launchlog        → { errors }         the last 50 Solana launches that failed, and why
//
// Public (anyone), the sasa Bot page (app/bot):
//   GET /api/bot/live             → { scanned, traps, smart, scans, buys, trends, futures }
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
    if (/sniper_|sol_launch_errors|bot_public|smart_|whale_moves/.test(text)) return null;
    throw new Error(`db ${r.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

// sasa's own admin accounts (the same ones that see the admin-only tests on the site)
const SASA_ADMINS = ["0x5a5506fce4c9d9c2989a2988cb2b63988207bd1b", "0xe0ba5905940d748b23dc01266aa884e2391cca2f", "0xf4bc1b22e117a621e1118d09f7bb015c685a9617"];

// what a coin's hard "no" means on the public page: a trap, or only "be careful"
const TRAP = /^(creator sold|creator holds too much|serial launcher|creator dumped before|bundled|top 10 hold too much|reused)/;

const WHY = {
  "creator sold": "The creator already sold",
  "creator holds too much": "The creator holds too much",
  "serial launcher": "This creator launches coin after coin",
  "creator dumped before": "This creator dumped a coin before",
  bundled: "Bundled: insiders bought the launch",
  "top 10 hold too much": "10 wallets hold too much",
  "no links": "No X, Telegram or site",
  "few buyers": "Few real buyers yet",
  falling: "Price is falling",
  "too late": "Already pumped 2.5×",
  "X account missing": "Its X account doesn't exist",
  "X followers < 20": "Its X account is empty",
};

/** One scanned coin for the public page: its checks in plain words and the verdict. */
export function scanOf(s) {
  const c = s.checks || {};
  const has = (v) => v !== undefined && v !== null;
  // the same limits as indexer/sniper.mjs RULES
  const items = [
    ["Creator holds under 10%", has(c.devPct) ? c.devPct <= 10 : null],
    ["Creator hasn't sold", !c.devSold],
    ["Not a serial launcher", has(c.devLaunches) ? c.devLaunches <= 3 : null],
    ["Creator never dumped", !c.devRugs],
    ["No bundled buys", has(c.bundlePct) ? c.bundlePct <= 25 : null],
    ["Top 10 hold under 40%", has(c.top10) ? c.top10 <= 40 : null],
    ["Has X, Telegram or a site", !!(c.x || c.tg != null || c.siteOwn)],
    ["Original links and picture", !c.reused],
    ["Real buyers", has(c.buyers) ? c.buyers >= 5 : null],
  ].filter((x) => x[1] !== null);
  const ok = items.filter((x) => x[1]).length;
  const verdict = s.fail && TRAP.test(s.fail) ? "trap" : s.passed ? "clean" : "careful";
  return {
    mint: s.mint,
    name: s.name,
    symbol: s.symbol,
    at: s.created_at,
    mc: s.entry_mc ?? s.start_mc ?? null,
    sec: c.sec ?? null,
    checks: items.map(([label, pass]) => ({ label, pass })),
    safety: items.length ? Math.round((ok / items.length) * 100) : 0,
    verdict,
    why: s.fail ? WHY[s.fail] ?? (s.fail.startsWith("reused") ? `Copied ${s.fail.slice(7)} from another coin` : s.fail) : null,
  };
}

/** The public page's data, cached a few seconds at the edge (one database call per few seconds). */
async function live(env) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request("https://sasapad.fun/__cache/bot-live-v1");
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const [pub, futures] = await Promise.all([
    db(env, "rpc/bot_public", { method: "POST", body: "{}" }).catch(() => null),
    db(env, "whale_moves_pub?select=id,address,coin,kind,side,usd,px,lev,t,rank,name&usd=gte.25000&order=t.desc&limit=24").catch(() => null),
  ]);
  const p = pub || {};
  const body = {
    scanned: p.scanned ?? 0,
    traps: p.traps ?? 0,
    smart: p.smart ?? 0,
    scans: (p.scans ?? []).map(scanOf),
    buys: p.buys ?? [],
    trends: p.trends ?? [],
    futures: futures ?? [],
    at: new Date().toISOString(),
  };
  const res = new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=4" },
  });
  if (cache) await cache.put(key, res.clone()).catch(() => {});
  return res;
}

export async function botRoute(env, me, parts, method, url) {
  if (parts.length === 2 && parts[1] === "live" && method === "GET") return live(env);
  const who = String(me || "").toLowerCase();
  if (!SASA_ADMINS.includes(who) && !admins(env).includes(who)) return json({ error: "Not found." }, 404);
  // Solana launches that failed in someone's browser (edge/sol-api.js keeps them)
  if (parts.length === 2 && parts[1] === "launchlog" && method === "GET") {
    const rows = await db(env, "sol_launch_errors?select=at,owner,creator,mint,kind,step,error,ua&order=at.desc&limit=50").catch(() => null);
    return json({ errors: rows ?? [] });
  }
  // Trend Radar: the themes new pump.fun coins launch on right now (indexer/sniper.mjs, sniper_trends)
  if (parts.length === 2 && parts[1] === "trends" && method === "GET") {
    // read directly (not through db(), which hides sniper_ errors) so a broken query shows its reason
    const key = env.SUPABASE_SERVICE_KEY;
    const headers = { apikey: key, "content-type": "application/json" };
    if (key && key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
    const r = await fetch(`${env.SUPABASE_URL || SUPABASE_URL}/rest/v1/rpc/sniper_trends`, { method: "POST", headers, body: "{}" }).catch((e) => ({ ok: false, text: async () => String(e) }));
    const text = await r.text();
    if (!r.ok) return json({ themes: [], error: text.slice(0, 300) });
    return json({ themes: text ? JSON.parse(text) ?? [] : [] });
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
