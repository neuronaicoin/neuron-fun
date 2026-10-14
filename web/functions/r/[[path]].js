/**
 * Cloudflare Pages Function for /r/?id=<race coin id>.
 *
 * Link previews (X, Telegram, Discord) and search engines read meta tags without
 * running JavaScript: fill them in for the race (name, chains, winner) and point the
 * preview at the race's own card (drawn by the indexer). The page itself is unchanged.
 */
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const SITE = "https://sasapad.fun";
const CHAIN = { 84532: "Base", 8453: "Base", 97: "BNB Chain", 56: "BNB Chain", 46630: "Robinhood Chain", 4663: "Robinhood Chain", 5042002: "Arc", 5042: "Arc" };

const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const t = (x) => x.replace(/\.?0+$/, "");
  if (n >= 1e6) return `$${t((n / 1e6).toFixed(2))}M`;
  if (n >= 1e3) return `$${t((n / 1e3).toFixed(1))}K`;
  return `$${n.toFixed(2)}`;
};
const html = (x) => String(x ?? "").replace(/[&<>"]/g, (k) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[k]);
// JSON inside <script>: only <, > and & need escaping.
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" })[c]);

export async function onRequestGet(ctx) {
  const res = await ctx.next();
  if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
  const url = new URL(ctx.request.url);
  const id = (url.searchParams.get("id") || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) return res;

  let c = null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/race_coins?id=eq.${id}&select=name,symbol,description,winner_chain,total_usd,decided_at,race_chains(chain_id,pool_usd,reported_usd)`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cf: { cacheTtl: 30, cacheEverything: true } }
    );
    if (r.ok) c = (await r.json())[0] || null;
  } catch {}
  if (!c) return res;

  const lanes = c.race_chains || [];
  const chains = [...new Set(lanes.map((l) => CHAIN[l.chain_id]).filter(Boolean))];
  const total = Number(c.total_usd) > 0 ? Number(c.total_usd) : lanes.reduce((s, l) => s + (Number(l.reported_usd ?? l.pool_usd) || 0), 0);
  const winner = c.winner_chain ? CHAIN[c.winner_chain] : null;
  const title = winner
    ? `${c.name} ($${c.symbol}) won the race on ${winner} · sasa`
    : c.decided_at
      ? `${c.name} ($${c.symbol}) race · sasa`
      : `${c.name} ($${c.symbol}) is racing on ${chains.length} chains · sasa`;
  const description = [
    `${c.name} launched on ${chains.join(", ")} at the same time. The chain with the most money after five minutes wins.`,
    money(total) ? `${money(total)} raised.` : "",
    winner ? `Winner: ${winner}.` : "",
    "Buy it in USDC on sasa.",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 300);
  const pageUrl = `${SITE}/r/?id=${id}`;
  const set = (value) => ({ element: (e) => e.setAttribute("content", value) });

  // the race's own card if the indexer drew it, else the plain sasa card
  const card = `${SUPABASE_URL}/storage/v1/object/public/cards/r-${id}.png`;
  let img = `${SITE}/og-plain.png`;
  try {
    const h = await fetch(card, { method: "HEAD", cf: { cacheTtl: 60 } });
    if (h.ok) img = card;
  } catch {}

  const ld = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description,
    url: pageUrl,
    about: { "@type": "Thing", name: `${c.name} (${c.symbol})` },
    isPartOf: { "@type": "WebSite", name: "sasa", url: SITE },
  };
  const summary =
    `<noscript><article><h1>${html(c.name)} ($${html(c.symbol)})</h1><p>${html(description)}</p>` +
    (c.description ? `<p>${html(String(c.description).slice(0, 500))}</p>` : "") +
    `<p><a href="${SITE}/explore/">Explore</a> · <a href="${SITE}/race/">How races work</a></p></article></noscript>`;

  return new HTMLRewriter()
    .on("title", { element: (e) => e.setInnerContent(title) })
    .on('meta[name="description"]', set(description))
    .on('meta[property="og:title"]', set(title))
    .on('meta[name="twitter:title"]', set(title))
    .on('meta[property="og:description"]', set(description))
    .on('meta[name="twitter:description"]', set(description))
    .on('meta[property="og:url"]', set(pageUrl))
    .on('meta[property="og:image"]', set(img))
    .on('meta[name="twitter:image"]', set(img))
    .on('meta[property="og:image:width"]', set("1200"))
    .on('meta[property="og:image:height"]', set("630"))
    .on('meta[property="og:image:alt"]', set(title))
    .on('link[rel="canonical"]', { element: (e) => e.setAttribute("href", pageUrl) })
    .on("head", { element: (e) => e.append(`<script type="application/ld+json">${esc(JSON.stringify(ld))}</script>`, { html: true }) })
    .on("body", { element: (e) => e.append(summary, { html: true }) })
    .transform(res);
}
