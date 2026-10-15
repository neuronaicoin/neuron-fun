/** /sitemap-market.xml: the Market page and today's 300 coin pages. Refreshed at most every hour. */
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const SITE = "https://sasapad.fun";

export async function onRequestGet() {
  let rows = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/top_coins_pub?select=cg_id,updated_at&order=rank.asc.nullslast&limit=1000`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (r.ok) rows = await r.json();
  } catch {}
  if (!Array.isArray(rows)) return new Response("Try again soon", { status: 503, headers: { "retry-after": "300", "cache-control": "no-store" } });
  const day = (t) => (t && !isNaN(Date.parse(t)) ? new Date(t).toISOString().slice(0, 10) : null);
  const urls = [[`${SITE}/market/`, day(rows[0]?.updated_at)], ...rows.filter((c) => /^[a-z0-9][a-z0-9-]{0,99}$/.test(c.cg_id)).map((c) => [`${SITE}/m/${c.cg_id}/`, day(c.updated_at)])];
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(([u, t]) => `<url><loc>${u}</loc>${t ? `<lastmod>${t}</lastmod>` : ""}</url>`).join("\n") +
    `\n</urlset>\n`;
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
