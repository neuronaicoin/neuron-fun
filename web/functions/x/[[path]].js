/**
 * Cloudflare Pages Function for /x/?n=<network>&a=<token> (coins from any DEX).
 *
 * Link previews (X, Telegram) and search engines read meta tags without
 * running JavaScript: fill them in for the coin (name, price, market cap,
 * chain), plus structured data. The page itself is unchanged.
 */
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const SITE = "https://sasapad.fun";
const NETS = { base: "Base", bsc: "BNB Chain", eth: "Ethereum", robinhood: "Robinhood Chain", arc: "Arc" };

const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const t = (x) => x.replace(/\.?0+$/, "");
  if (n >= 1e9) return `$${t((n / 1e9).toFixed(2))}B`;
  if (n >= 1e6) return `$${t((n / 1e6).toFixed(2))}M`;
  if (n >= 1e3) return `$${t((n / 1e3).toFixed(1))}K`;
  return `$${n.toFixed(n < 1 ? 6 : 2)}`;
};
// JSON inside <script>: only <, > and & need escaping (quotes are already JSON-escaped).
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" })[c]);

export async function onRequestGet(ctx) {
  const res = await ctx.next();
  if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
  const url = new URL(ctx.request.url);
  const network = url.searchParams.get("n") || "";
  const address = (url.searchParams.get("a") || "").toLowerCase();
  if (!NETS[network] || !/^0x[0-9a-f]{40}$/.test(address)) return res;

  let c = null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/ext_coins_all?network=eq.${network}&address=eq.${address}&select=name,symbol,image,price_usd,mcap_usd,fdv_usd,vol_24h,change_24h,liq_usd,buys_24h,sells_24h,pool_created,dex`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cf: { cacheTtl: 120, cacheEverything: true } }
    );
    if (r.ok) c = (await r.json())[0] || null;
  } catch {}
  if (!c) return res;

  const chain = NETS[network];
  const mc = money(Number(c.mcap_usd) > 0 ? c.mcap_usd : c.fdv_usd);
  const ch = Number(c.change_24h);
  const title = `${c.name} ($${c.symbol}) price, chart and market cap on ${chain} · sasa`;
  const description = [
    `Buy and sell ${c.name} ($${c.symbol}) on ${chain} with USDC in one tap on sasa.`,
    mc ? `Market cap ${mc}.` : "",
    money(c.vol_24h) ? `24h volume ${money(c.vol_24h)}.` : "",
    Number.isFinite(ch) ? `24h change ${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%.` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 300);
  const pageUrl = `${SITE}/x/?n=${network}&a=${address}`;
  const set = (value) => ({ element: (e) => e.setAttribute("content", value) });
  const ld = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description,
    url: pageUrl,
    about: { "@type": "Thing", name: `${c.name} (${c.symbol})`, identifier: address },
    isPartOf: { "@type": "WebSite", name: "sasa", url: SITE },
  };
  let rw = new HTMLRewriter()
    .on("title", { element: (e) => e.setInnerContent(title) })
    .on('meta[name="description"]', set(description))
    .on('meta[property="og:title"]', set(title))
    .on('meta[name="twitter:title"]', set(title))
    .on('meta[property="og:description"]', set(description))
    .on('meta[name="twitter:description"]', set(description))
    .on('meta[property="og:url"]', set(pageUrl))
    .on('link[rel="canonical"]', { element: (e) => e.setAttribute("href", pageUrl) })
    .on("head", { element: (e) => e.append(`<script type="application/ld+json">${esc(JSON.stringify(ld))}</script>`, { html: true }) });
  // A plain-text summary for crawlers and AI engines that don't run JavaScript.
  const html = (x) => String(x ?? "").replace(/[&<>"]/g, (k) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[k]);
  const price = Number(c.price_usd);
  const facts = [
    `Chain: ${chain}`,
    Number.isFinite(price) && price > 0 ? `Price: $${price < 0.01 ? price.toPrecision(3) : price.toFixed(4)}` : "",
    mc ? `Market cap: ${mc}` : "",
    money(c.liq_usd) ? `Liquidity: ${money(c.liq_usd)}` : "",
    money(c.vol_24h) ? `24h volume: ${money(c.vol_24h)}` : "",
    Number.isFinite(ch) ? `24h change: ${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%` : "",
    Number(c.buys_24h) + Number(c.sells_24h) > 0 ? `Trades in the last 24 hours: ${Number(c.buys_24h) || 0} buys, ${Number(c.sells_24h) || 0} sells` : "",
    c.dex ? `Main pool: ${c.dex}` : "",
    c.pool_created ? `Pool created: ${new Date(c.pool_created).toISOString().slice(0, 10)}` : "",
    `Contract: ${address}`,
  ].filter(Boolean);
  const summary =
    `<noscript><article><h1>${html(c.name)} ($${html(c.symbol)}) on ${html(chain)}</h1><p>${html(description)}</p>` +
    `<ul>${facts.map((f) => `<li>${html(f)}</li>`).join("")}</ul>` +
    `<p>On sasa you can buy and sell ${html(c.name)} with USDC in one tap, with no bridging and no gas token, and follow its live chart and trades.</p>` +
    `<p><a href="${SITE}/explore/">Explore more coins on ${html(chain)}</a> · <a href="${SITE}/learn/">Guides</a></p></article></noscript>`;
  rw = rw.on("body", { element: (e) => e.append(summary, { html: true }) });
  return rw.transform(res);
}
