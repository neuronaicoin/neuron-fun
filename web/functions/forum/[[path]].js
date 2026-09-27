/**
 * Cloudflare Pages Function: /forum/*
 * Serves the forum as complete HTML (search engines and AI crawlers read it
 * without JavaScript), plus /forum/sitemap.xml and /forum/feed.xml.
 * Pages are cached at the edge for 30 seconds; "?fresh=1" skips the cache
 * right after someone posts.
 */
import { renderBoard, renderFeed, renderHome, renderNotFound, renderSitemap, renderThread } from "../../edge/forum-render.js";

const CACHE_SECONDS = 30;

function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=0, s-maxage=${CACHE_SECONDS}` : "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  let path = url.pathname;

  if (path === "/forum") return Response.redirect(`${url.origin}/forum/${url.search}`, 301);
  if (!path.endsWith("/") && !/\.(xml|txt)$/.test(path)) return Response.redirect(`${url.origin}${path}/${url.search}`, 301);

  const fresh = url.searchParams.has("fresh");
  // One cache entry per page, whatever tracking junk is in the link.
  const keyUrl = new URL(url.origin + path);
  for (const k of ["page", "sort"]) if (url.searchParams.has(k)) keyUrl.searchParams.set(k, url.searchParams.get(k));
  const cacheKey = new Request(keyUrl.toString(), { method: "GET" });
  const cache = caches.default;
  if (!fresh) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let res;
  try {
    const parts = path.replace(/^\/forum\/?/, "").split("/").filter(Boolean);
    if (parts.length === 1 && parts[0] === "sitemap.xml") {
      res = new Response(await renderSitemap(env), { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=0, s-maxage=600" } });
    } else if (parts.length === 1 && parts[0] === "feed.xml") {
      res = new Response(await renderFeed(env), { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=0, s-maxage=300" } });
    } else if (parts.length === 0) {
      res = html(await renderHome(env, fresh));
    } else if (parts.length === 1) {
      const r = await renderBoard(env, parts[0], url, fresh);
      if (!r) return html(renderNotFound(), 404);
      if (r.redirect) return Response.redirect(url.origin + r.redirect, 301);
      res = html(r.html);
    } else if (parts.length === 2) {
      const r = await renderThread(env, parts[0], parts[1], url, fresh);
      if (!r) return html(renderNotFound(), 404);
      if (r.redirect) return Response.redirect(url.origin + r.redirect, 301);
      res = html(r.html);
    } else {
      return html(renderNotFound(), 404);
    }
  } catch (e) {
    console.error("forum error", e && e.message);
    return new Response("The forum is having a moment. Refresh in a few seconds.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "10", "cache-control": "no-store" },
    });
  }
  if (res.status === 200) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
