/**
 * Cloudflare Pages Function: a guide (/learn/<slug>/) with today's live meme coin record put in
 * (edge/learn-live.js), so every guide carries fresh, real data and links to the day's pages.
 * The guide itself is the static page; if the data doesn't answer, it is served as it is.
 */
import { chainForSlug, renderLearnLive } from "../../edge/learn-live.js";

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";

async function dayRow(chain, day) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/day_pages?day=eq.${day}&chain=eq.${chain}&ok=is.true&select=data`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cf: { cacheTtl: 1800, cacheEverything: true },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0].data : null;
  } catch {
    return null;
  }
}

export async function onRequestGet(ctx) {
  const res = await ctx.next();
  const type = res.headers.get("content-type") || "";
  if (res.status !== 200 || !type.includes("text/html")) return res;
  const slug = String(ctx.params.slug || "");
  const chain = chainForSlug(slug);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  // the guide's chain, else every chain; yesterday's record just after midnight
  let d = await dayRow(chain ? chain.slug : "all", today);
  let live = true;
  if (!d) {
    d = await dayRow(chain ? chain.slug : "all", yesterday);
    live = false;
  }
  const html = d ? renderLearnLive(d, chain, { live }) : "";
  if (!html) return res;
  const headers = new Headers(res.headers);
  for (const h of ["etag", "last-modified", "content-length"]) headers.delete(h);
  headers.set("cache-control", "public, max-age=0, s-maxage=1800, must-revalidate");
  return new HTMLRewriter()
    .on("#learn-live", { element: (e) => e.setInnerContent(html, { html: true }) })
    .transform(new Response(res.body, { status: 200, headers }));
}
