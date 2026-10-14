/**
 * Cloudflare Pages Function: /races/, /races/<chain>/, /races/<chain>/<YYYY-MM-DD>/ and
 * /races/all/<YYYY-MM-DD>/. Server-rendered race results for search and AI engines,
 * built from live race data and cached at the edge for 10 minutes.
 */
import { chainBySlug, dayQuery, daysOf, parseDay, recentQuery, renderAllDay, renderChain, renderDay, renderHub } from "../../edge/race-pages.js";

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const CACHE_SECONDS = 600;

async function rows(env, query) {
  const base = (env && env.SUPABASE_URL) || SUPABASE_URL;
  const key = (env && env.SUPABASE_KEY) || SUPABASE_KEY;
  const r = await fetch(`${base}/rest/v1/${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`data ${r.status}`);
  return r.json();
}

const page = (body, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=120, s-maxage=${CACHE_SECONDS}` : "public, max-age=60",
      "x-content-type-options": "nosniff",
    },
  });
const notFound = () =>
  page(`<!doctype html><meta name="robots" content="noindex"><title>No races · sasa</title><p>No races on this day. <a href="/races/">See all races</a>.</p>`, 404);

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const path = url.pathname;
  if (!path.endsWith("/")) return Response.redirect(`${url.origin}${path}/`, 301);
  const parts = path.replace(/^\/races\/?/, "").replace(/\/$/, "").split("/").filter(Boolean);
  try {
    if (parts.length === 0) return page(renderHub(await rows(ctx.env, recentQuery(60))));
    if (parts.length === 1) {
      const chain = chainBySlug(parts[0]);
      if (!chain) return notFound();
      return page(renderChain(chain, daysOf(await rows(ctx.env, recentQuery(60)), chain)));
    }
    if (parts.length === 2) {
      const day = parseDay(parts[1]);
      if (!day || day.getTime() > Date.now()) return notFound();
      const data = await rows(ctx.env, dayQuery(null, day));
      const html = parts[0] === "all" ? renderAllDay(day, data) : chainBySlug(parts[0]) ? renderDay(chainBySlug(parts[0]), day, data) : null;
      return html ? page(html) : notFound();
    }
    return notFound();
  } catch {
    return page(`<!doctype html><meta name="robots" content="noindex"><title>Races · sasa</title><p>The race pages are updating. Try again in a minute.</p>`, 503);
  }
}
