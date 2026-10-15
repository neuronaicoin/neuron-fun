/**
 * /sitemap-coins.xml: a sitemap index. Coin pages from other DEXs come from the archive (every
 * real coin we ever saw, never junk), 40,000 per file: /sitemap-coins/0.xml, /1.xml, … (on
 * testnet also the older v6 coin pages, /sitemap-coins/v6.xml). Race coins are in
 * /sitemap-races.xml. Refreshed at most every hour.
 */
import { NETWORK } from "../lib/network.js";
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const SITE = "https://sasapad.fun";
/** Files at most; 40,000 coins each (a sitemap index may list 50,000 files). */
const MAX_FILES = 5000;

export async function onRequestGet() {
  let chunks = 1;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ext_sitemap_chunks`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (r.ok) chunks = Math.min(MAX_FILES, Math.max(1, Number(await r.json()) || 1));
  } catch {}
  const files = Array.from({ length: chunks }, (_, k) => `${SITE}/sitemap-coins/${k}.xml`);
  if (NETWORK === "testnet") files.push(`${SITE}/sitemap-coins/v6.xml`);
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    files.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join("\n") +
    `\n</sitemapindex>\n`;
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
