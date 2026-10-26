/**
 * Cloudflare Pages Function: the daily meme coin archive.
 *   /day/                      every day with a page
 *   /day/<YYYY-MM-DD>/         that day on every chain
 *   /day/<YYYY-MM-DD>/<chain>/ that day on one chain (solana, base, bnb-chain, robinhood-chain, arc, ethereum)
 * Data: day_pages (indexer/seopages.mjs). Today's page changes every 30 minutes; past days are final.
 * A day with too little on it is kept out of search results; a day we have no record of is a 404.
 */
import { chainBySlug, isDay, renderDay, renderHub } from "../../edge/day-render.js";

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";

async function rows(env, query, ttl) {
  const base = (env && env.SUPABASE_URL) || SUPABASE_URL;
  const key = (env && env.SUPABASE_KEY) || SUPABASE_KEY;
  const r = await fetch(`${base}/rest/v1/${query}`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!r.ok) throw new Error(`data ${r.status}`);
  return r.json();
}

/** Every row of a query, 1,000 at a time (the database answers at most 1,000 rows per call). */
async function allRows(env, query, ttl, max = 20) {
  const out = [];
  for (let k = 0; k < max; k++) {
    const got = await rows(env, `${query}&limit=1000&offset=${k * 1000}`, ttl);
    out.push(...got);
    if (got.length < 1000) break;
  }
  return out;
}

const page = (body, { status = 200, maxAge = 1800, noindex = false } = {}) => {
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": status === 200 ? `public, max-age=300, s-maxage=${maxAge}` : status === 404 ? "public, max-age=600" : "no-store",
    "x-content-type-options": "nosniff",
  };
  if (noindex) headers["x-robots-tag"] = "noindex";
  return new Response(body, { status, headers });
};

const notFound = (maxAge = 600) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Day not found · sasa</title><p style="font-family:sans-serif;padding:24px">We have no record of this day. <a href="/day/">See every day</a>.</p>`, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": `public, max-age=${maxAge}`, "x-robots-tag": "noindex" },
  });

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const path = url.pathname;
  if (!path.endsWith("/")) return Response.redirect(`${url.origin}${path}/`, 301);
  const parts = path.replace(/^\/day\/?/, "").split("/").filter(Boolean);
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (!parts.length) {
      const list = await allRows(ctx.env, "day_pages?select=day,chain,ok,nm:data->newMemeCount&order=day.desc,chain.asc", 900);
      return page(renderHub(list), { maxAge: 900 });
    }
    const [day, slug = "all", extra] = parts;
    if (extra || !isDay(day) || day > today) return notFound();
    if (slug !== "all" && !chainBySlug(slug)) return notFound();
    // "/day/<date>/all/" is the plain day page
    if (parts[1] === "all") return Response.redirect(`${url.origin}/day/${day}/`, 301);
    const live = day === today;
    // today changes every 30 minutes; yesterday's final build may have just landed; older days are final
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const ttl = live ? 600 : day === yesterday ? 900 : 86400;
    const [one, before, after] = await Promise.all([
      rows(ctx.env, `day_pages?day=eq.${day}&chain=eq.${slug}&select=data,ok`, ttl),
      rows(ctx.env, `day_pages?chain=eq.${slug}&ok=is.true&day=lt.${day}&select=day&order=day.desc&limit=1`, ttl),
      rows(ctx.env, `day_pages?chain=eq.${slug}&ok=is.true&day=gt.${day}&select=day&order=day.asc&limit=1`, live || day === yesterday ? 600 : 3600),
    ]);
    const row = one[0];
    // not built yet (just after midnight): say so briefly, don't let a "not found" stick
    if (!row || !row.data) return notFound(live || day === yesterday ? 60 : 600);
    const html = renderDay(row.data, slug, { prev: before[0]?.day ?? null, next: after[0]?.day ?? null, today });
    // too little on it to be worth a place in search results (it stays open for people)
    const out = row.ok ? html : html.replace("<head>", '<head><meta name="robots" content="noindex">');
    return page(out, { maxAge: ttl, noindex: !row.ok });
  } catch {
    return page("<!doctype html><title>Daily archive · sasa</title><p>The archive is updating. Try again in a minute.</p>", { status: 503 });
  }
}
