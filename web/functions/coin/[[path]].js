/**
 * Cloudflare Pages Function for /coin/?id=…
 *
 * Link previews (X, Telegram, Discord) read the page's meta tags without
 * running JavaScript. This fills those tags in for the coin being shared:
 * its name, description and share card image. Everything else about the
 * page is left untouched.
 */
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const SITE = "https://sasapad.fun";
const ID = /^0x[0-9a-f]{40}:0x[0-9a-f]{64}$/;

const cardFile = (id) => `${id.replace(/[^0-9a-z]/g, "-")}.png`;

export async function onRequestGet(ctx) {
  const res = await ctx.next();
  const type = res.headers.get("content-type") || "";
  if (!type.includes("text/html")) return res;

  const url = new URL(ctx.request.url);
  const id = (url.searchParams.get("id") || "").toLowerCase();
  if (!ID.test(id)) return res;

  const base = (ctx.env && ctx.env.SUPABASE_URL) || SUPABASE_URL;
  const key = (ctx.env && ctx.env.SUPABASE_KEY) || SUPABASE_KEY;
  let coin = null;
  try {
    const r = await fetch(`${base}/rest/v1/coin_list?id=eq.${encodeURIComponent(id)}&select=name,symbol,description`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (r.ok) coin = (await r.json())[0] || null;
  } catch {}
  if (!coin) return res;

  const image = `${base}/storage/v1/object/public/cards/${cardFile(id)}`;
  let hasImage = false;
  try {
    const h = await fetch(image, { method: "HEAD", cf: { cacheTtl: 60 } });
    hasImage = h.ok;
  } catch {}

  const title = `${coin.name} ($${coin.symbol}) on sasa`;
  const description =
    (coin.description || "").trim().slice(0, 180) ||
    `Trade $${coin.symbol} on every chain at once. Launch once. Live on every chain.`;
  const pageUrl = `${SITE}/coin/?id=${encodeURIComponent(id)}`;
  const set = (value) => ({ element: (e) => e.setAttribute("content", value) });

  let rw = new HTMLRewriter()
    .on("title", { element: (e) => e.setInnerContent(title) })
    .on('meta[name="description"]', set(description))
    .on('meta[property="og:title"]', set(title))
    .on('meta[name="twitter:title"]', set(title))
    .on('meta[property="og:description"]', set(description))
    .on('meta[name="twitter:description"]', set(description))
    .on('meta[property="og:url"]', set(pageUrl))
    .on('meta[property="og:image:alt"]', set(title))
    .on('link[rel="canonical"]', { element: (e) => e.setAttribute("href", pageUrl) });
  if (hasImage) {
    rw = rw
      .on('meta[property="og:image"]', set(image))
      .on('meta[name="twitter:image"]', set(image))
      .on('meta[property="og:image:width"]', set("1200"))
      .on('meta[property="og:image:height"]', set("630"));
  }
  const out = rw.transform(res);
  const headers = new Headers(out.headers);
  headers.set("cache-control", "public, max-age=60");
  return new Response(out.body, { status: out.status, headers });
}
