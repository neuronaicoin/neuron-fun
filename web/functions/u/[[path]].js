/**
 * Cloudflare Pages Function: /u/<username or address>/
 * Serves the profile page (a static page that reads the name from the URL)
 * with the right title and link-preview tags filled in on the server.
 */
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const SITE = "https://sasapad.fun";

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const m = /^\/u\/([^/]+)\/?$/.exec(url.pathname);
  if (!m) return ctx.next();
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const key = decodeURIComponent(m[1]).toLowerCase();
  const shell = await ctx.env.ASSETS.fetch(new Request(new URL("/u/", url.origin), ctx.request));
  if (!/^(0x[0-9a-f]{40}|[a-z0-9_]{3,20})$/.test(key)) return new Response(shell.body, { status: 404, headers: shell.headers });

  const base = (ctx.env && ctx.env.SUPABASE_URL) || SUPABASE_URL;
  const apikey = (ctx.env && ctx.env.SUPABASE_KEY) || SUPABASE_KEY;
  let p = null;
  try {
    const filter = key.startsWith("0x") ? `address=eq.${key}` : `username=eq.${key}`;
    const r = await fetch(`${base}/rest/v1/profiles_public?${filter}&select=address,username,bio,followers`, {
      headers: { apikey, Authorization: `Bearer ${apikey}` },
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (r.ok) p = (await r.json())[0] || null;
  } catch {}
  if (!p && !key.startsWith("0x")) return new Response(shell.body, { status: 404, headers: shell.headers });

  const name = p && p.username ? `@${p.username}` : `${key.slice(0, 6)}…${key.slice(-4)}`;
  const title = `${name} on sasa`;
  const description = (p && p.bio) || `${name}'s trades, holdings and profit on sasa, the multi-chain meme coin launchpad.`;
  const canonical = `${SITE}/u/${p && p.username ? p.username : key}/`;
  const set = (v) => ({ element: (e) => e.setAttribute("content", v) });
  const res = new HTMLRewriter()
    .on("title", { element: (e) => e.setInnerContent(title) })
    .on('meta[name="description"]', set(description))
    .on('meta[property="og:title"]', set(title))
    .on('meta[name="twitter:title"]', set(title))
    .on('meta[property="og:description"]', set(description))
    .on('meta[name="twitter:description"]', set(description))
    .on('meta[property="og:url"]', set(canonical))
    .on('link[rel="canonical"]', { element: (e) => e.setAttribute("href", canonical) })
    .transform(shell);
  const headers = new Headers(res.headers);
  headers.set("cache-control", "public, max-age=0, s-maxage=60");
  return new Response(res.body, { status: 200, headers });
}
