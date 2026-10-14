/**
 * /sitemap-races.xml: every mainnet race coin page and every chain×day race page that has
 * races, so search engines find them. Test races (testnet chains) are never listed.
 */
import { CHAINS, MAINNET_IDS, daysOf, recentQuery } from "../edge/race-pages.js";

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const SITE = "https://sasapad.fun";

export async function onRequestGet() {
  const h = { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cf: { cacheTtl: 1800, cacheEverything: true } };
  const urls = [[`${SITE}/races/`, null, "hourly"]];
  for (const c of CHAINS) urls.push([`${SITE}/races/${c.slug}/`, null, "hourly"]);
  try {
    // chain×day pages from the last 60 days
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${recentQuery(60)}`, h);
    if (r.ok) {
      const rows = await r.json();
      for (const d of daysOf(rows, null)) urls.push([`${SITE}/races/all/${d.day}/`, `${d.day}T23:59:59Z`, "daily"]);
      for (const c of CHAINS) for (const d of daysOf(rows, c)) urls.push([`${SITE}/races/${c.slug}/${d.day}/`, `${d.day}T23:59:59Z`, "daily"]);
    }
  } catch {}
  try {
    // every mainnet race coin (the sitemap protocol allows 50,000 URLs per file)
    const r = await fetch(`${SUPABASE_URL}/rest/v1/race_coins?select=id,launched_at,race_chains!inner(chain_id)&race_chains.chain_id=in.(${MAINNET_IDS.join(",")})&order=launched_at.desc&limit=45000`, h);
    if (r.ok) for (const c of await r.json()) urls.push([`${SITE}/r/?id=${c.id}`, c.launched_at, "daily"]);
  } catch {}
  const now = Date.now();
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(([u, t, f]) => {
        const ok = t && !isNaN(Date.parse(t));
        const lm = ok ? new Date(Math.min(Date.parse(t), now)).toISOString() : null;
        return `<url><loc>${u}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ""}<changefreq>${f}</changefreq></url>`;
      })
      .join("\n") +
    `\n</urlset>\n`;
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=1800" } });
}
