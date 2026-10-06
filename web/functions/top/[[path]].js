/**
 * Cloudflare Pages Function: /top/ and /top/<list>/
 * Daily "top meme coins" lists as complete HTML for search and AI engines,
 * rebuilt from live data and cached at the edge for 30 minutes.
 */
import { LISTS, cleanCoins, queryFor, renderHub, renderList } from "../../edge/top-render.js";

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const CACHE_SECONDS = 1800;

async function fetchList(env, list) {
  const base = (env && env.SUPABASE_URL) || SUPABASE_URL;
  const key = (env && env.SUPABASE_KEY) || SUPABASE_KEY;
  const r = await fetch(`${base}/rest/v1/${queryFor(list)}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`data ${r.status}`);
  return cleanCoins(await r.json(), list);
}

const page = (body, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=300, s-maxage=${CACHE_SECONDS}` : "no-store",
      "x-content-type-options": "nosniff",
    },
  });

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const path = url.pathname;
  if (!path.endsWith("/")) return Response.redirect(`${url.origin}${path}/`, 301);
  const slug = path.replace(/^\/top\/?/, "").replace(/\/$/, "");
  try {
    if (!slug) {
      const firsts = {};
      await Promise.all(
        LISTS.map(async (l) => {
          firsts[l.slug] = (await fetchList(ctx.env, l).catch(() => [])).slice(0, 5);
        })
      );
      return page(renderHub(firsts));
    }
    const list = LISTS.find((l) => l.slug === slug);
    if (!list) return Response.redirect(`${url.origin}/top/`, 302);
    return page(renderList(list, await fetchList(ctx.env, list)));
  } catch {
    return page("<!doctype html><title>Top meme coins · sasa</title><p>The lists are updating. Try again in a minute.</p>", 503);
  }
}
