/**
 * /sitemap-coins/<k>.xml: coin pages k*40,000 … (k+1)*40,000 of the archive (see
 * /sitemap-coins.xml and indexer/archive.sql). Only coins worth a place in search results:
 * never bad ones, and quiet small ones drop out after 90 days.
 * /sitemap-coins/v6.xml (testnet only): the older v6 coin pages.
 */
import { NETWORK } from "../../lib/network.js";
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const SITE = "https://sasapad.fun";
const NETS = new Set(["base", "bsc", "eth", "robinhood", "arc"]);

const xml = (urls) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map(([u, t]) => `<url><loc>${u}</loc>${t ? `<lastmod>${t}</lastmod>` : ""}</url>`).join("\n") +
      `\n</urlset>\n`,
    { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } }
  );

/** One archive line "network/address/YYYY-MM-DD" → [url, lastmod], or null if it isn't one. */
export function lineToUrl(line) {
  const [n, a, d] = String(line).split("/");
  // Solana addresses are base58 and keep their case
  if (n === "solana" ? !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a || "") : !NETS.has(n) || !/^0x[0-9a-f]{40}$/.test(a || "")) return null;
  return [`${SITE}/x/${n}/${a}/`, /^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d : null];
}

export async function onRequestGet(ctx) {
  const name = new URL(ctx.request.url).pathname.replace(/^\/sitemap-coins\//, "");
  const h = { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cf: { cacheTtl: 3600, cacheEverything: true } };
  if (name === "v6.xml") {
    if (NETWORK !== "testnet") return new Response("Not found", { status: 404 });
    const urls = [];
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/coin_list?select=id,created_at&order=created_at.desc&limit=5000`, h);
      if (r.ok) for (const c of await r.json()) urls.push([`${SITE}/coin/?id=${encodeURIComponent(c.id)}`, String(c.created_at || "").slice(0, 10) || null]);
    } catch {}
    return xml(urls);
  }
  const m = /^(\d{1,4})\.xml$/.exec(name);
  if (!m) return new Response("Not found", { status: 404 });
  let text = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ext_sitemap_chunk?p_chunk=${Number(m[1])}`, h);
    if (r.ok) text = String((await r.json()) || "");
  } catch {}
  // the database didn't answer: try again soon (never cache an empty file for an hour)
  if (text === null) return new Response("Try again soon", { status: 503, headers: { "retry-after": "300", "cache-control": "no-store" } });
  const urls = text.split("\n").map(lineToUrl).filter(Boolean);
  // a file with no coins (all bad or quiet) isn't a valid sitemap: say there is none
  if (!urls.length) return new Response("Not found", { status: 404, headers: { "cache-control": "public, max-age=3600" } });
  return xml(urls);
}
