/**
 * /sitemap-days.xml: the daily meme coin archive (/day/...), every day and chain page worth a
 * place in search results (indexer/seopages.mjs → day_pages). Refreshed at most every hour.
 */
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const SITE = "https://sasapad.fun";
const SLUGS = new Set(["all", "solana", "base", "bnb-chain", "robinhood-chain", "arc", "ethereum"]);

export async function onRequestGet() {
  // 1,000 rows per call (the database's limit), up to 40,000 pages
  let list = [];
  try {
    for (let k = 0; k < 40; k++) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/day_pages?ok=is.true&select=day,chain,updated_at&order=day.desc,chain.asc&limit=1000&offset=${k * 1000}`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        cf: { cacheTtl: 3600, cacheEverything: true },
      });
      if (!r.ok) throw new Error(String(r.status));
      const got = await r.json();
      list.push(...got);
      if (got.length < 1000) break;
    }
  } catch {
    list = null;
  }
  // the database didn't answer: try again soon (never cache an empty file for an hour)
  if (!Array.isArray(list)) return new Response("Try again soon", { status: 503, headers: { "retry-after": "300", "cache-control": "no-store" } });
  const urls = [[`${SITE}/day/`, null]];
  for (const d of list) {
    if (!SLUGS.has(d.chain) || !/^\d{4}-\d{2}-\d{2}$/.test(d.day)) continue;
    urls.push([`${SITE}/day/${d.day}/${d.chain === "all" ? "" : `${d.chain}/`}`, String(d.updated_at || "").slice(0, 10) || null]);
  }
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(([u, t]) => `<url><loc>${u}</loc>${t ? `<lastmod>${t}</lastmod>` : ""}</url>`).join("\n") +
    `\n</urlset>\n`;
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
