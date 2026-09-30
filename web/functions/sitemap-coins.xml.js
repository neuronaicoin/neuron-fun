/**
 * /sitemap-coins.xml: every actively traded coin page (ours and other DEXs'),
 * so search engines find them. Refreshed at most every 30 minutes.
 */
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const SITE = "https://sasapad.fun";

export async function onRequestGet() {
  const h = { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cf: { cacheTtl: 1800, cacheEverything: true } };
  const urls = [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ext_coins_all?select=network,address,seen_at&order=vol_24h.desc.nullslast&limit=5000`, h);
    if (r.ok) for (const c of await r.json()) urls.push([`${SITE}/x/?n=${c.network}&amp;a=${c.address}`, c.seen_at]);
  } catch {}
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/coin_list?select=id,created_at&order=created_at.desc&limit=5000`, h);
    if (r.ok) for (const c of await r.json()) urls.push([`${SITE}/coin/?id=${encodeURIComponent(c.id)}`, c.created_at]);
  } catch {}
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(([u, t]) => `<url><loc>${u}</loc>${t && !isNaN(Date.parse(t)) ? `<lastmod>${new Date(t).toISOString()}</lastmod>` : ""}<changefreq>hourly</changefreq></url>`)
      .join("\n") +
    `\n</urlset>\n`;
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=1800" } });
}
