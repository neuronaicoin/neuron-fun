/**
 * Cloudflare Pages Function for Market coin pages (the 300 biggest coins):
 *   /m/<id>/      the page's own address (search engines, shares); id = CoinGecko id
 *   /m/?id=<id>   in-app links; a full page load moves to the address above
 *
 * Fills in the meta tags, structured data and a plain-text summary, so link previews, search
 * engines and AI crawlers see the coin without running JavaScript. A coin not in today's list
 * answers 404.
 */
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const SITE = "https://sasapad.fun";
const NETS = { base: "Base", bsc: "BNB Chain", eth: "Ethereum" };
const PATH = /^\/m\/([^/]+)\/?$/;
const ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const t = (x) => x.replace(/\.?0+$/, "");
  if (n >= 1e12) return `$${t((n / 1e12).toFixed(2))}T`;
  if (n >= 1e9) return `$${t((n / 1e9).toFixed(2))}B`;
  if (n >= 1e6) return `$${t((n / 1e6).toFixed(2))}M`;
  if (n >= 1e3) return `$${t((n / 1e3).toFixed(1))}K`;
  return `$${n.toFixed(n < 1 ? 6 : 2)}`;
};
const price = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1 ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `$${n.toPrecision(4)}`;
};
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" })[c]);
const html = (x) => String(x ?? "").replace(/[&<>"]/g, (k) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[k]);
const pageUrl = (id) => `${SITE}/m/${id}/`;
const h = { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } };

function keepQuery(url) {
  const q = new URLSearchParams(url.search);
  q.delete("id");
  const s = q.toString();
  return s ? `?${s}` : "";
}

async function appShell(ctx, url) {
  const r = await ctx.env.ASSETS.fetch(new URL("/m/", url.origin));
  const headers = new Headers(r.headers);
  for (const k of ["etag", "last-modified", "content-length"]) headers.delete(k);
  headers.set("cache-control", "public, max-age=0, must-revalidate");
  return { body: r.body, headers };
}

function withStatus(shell, status, extraHead = "") {
  const headers = new Headers(shell.headers);
  if (status === 503) {
    headers.set("retry-after", "120");
    headers.set("cache-control", "no-store");
  }
  return new HTMLRewriter()
    .on("head", { element: (e) => e.append(`<meta name="robots" content="noindex">${extraHead}`, { html: true }) })
    .transform(new Response(shell.body, { status, headers }));
}

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const m = PATH.exec(url.pathname);
  // the app's own files under /m/ (index.txt, __next.*.txt for in-app navigation): served as they are
  if (m && m[1].includes(".")) return ctx.next();
  if (!m) {
    const id = (url.searchParams.get("id") || "").toLowerCase();
    if ((url.pathname === "/m/" || url.pathname === "/m") && ID.test(id)) return Response.redirect(`${url.origin}/m/${id}/${keepQuery(url)}`, 301);
    return ctx.next();
  }
  let raw = "";
  try {
    raw = decodeURIComponent(m[1]);
  } catch {}
  const id = raw.toLowerCase();
  if (ID.test(id) && (raw !== id || !url.pathname.endsWith("/"))) return Response.redirect(`${url.origin}/m/${id}/${keepQuery(url)}`, 301);
  const shell = await appShell(ctx, url);
  if (!ID.test(id)) return withStatus(shell, 404);

  let c = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/top_coins_pub?cg_id=eq.${id}&select=*`, { ...h, cf: { cacheTtl: 300, cacheEverything: true } });
    if (!r.ok) return withStatus(shell, 503);
    const rows = await r.json();
    c = Array.isArray(rows) ? rows[0] || null : null;
  } catch {
    return withStatus(shell, 503);
  }
  if (!c) return withStatus(shell, 404);

  const chain = NETS[c.network] || "Base";
  const ch = Number(c.change_24h);
  const p = price(c.price_usd);
  const title = `${c.name} (${String(c.symbol).toUpperCase()}) price today, chart and market cap · sasa`;
  const description = [
    `${c.name} price${p ? ` ${p}` : ""}${Number.isFinite(ch) ? ` (${ch >= 0 ? "+" : ""}${ch.toFixed(1)}% in 24h)` : ""}.`,
    money(c.mcap_usd) ? `Market cap ${money(c.mcap_usd)}${c.rank ? `, rank #${c.rank}` : ""}.` : "",
    `Buy and sell ${c.symbol} with USDC in one tap on sasa.`,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 300);
  const url2 = pageUrl(id);
  const set = (value) => ({ element: (e) => e.setAttribute("content", value) });
  const ld = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description,
    url: url2,
    about: { "@type": "Thing", name: `${c.name} (${c.symbol})` },
    isPartOf: { "@type": "WebSite", name: "sasa", url: SITE },
  };
  // more coins from the list: links that help crawlers find the others
  let related = "";
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/top_coins_pub?select=cg_id,name,symbol,rank&order=rank.asc.nullslast&limit=30`, { ...h, cf: { cacheTtl: 3600, cacheEverything: true } });
    if (r.ok) {
      const list = (await r.json()).filter((o) => o.cg_id !== id && ID.test(o.cg_id)).slice(0, 20);
      if (list.length) related = `<h2>More of the biggest coins</h2><ul>${list.map((o) => `<li><a href="${pageUrl(o.cg_id)}">${html(o.name)} (${html(o.symbol)})</a></li>`).join("")}</ul>`;
    }
  } catch {}
  const facts = [
    c.rank ? `Rank by market cap: #${c.rank}` : "",
    p ? `Price: ${p}` : "",
    money(c.mcap_usd) ? `Market cap: ${money(c.mcap_usd)}` : "",
    money(c.vol_24h) ? `24h volume: ${money(c.vol_24h)}` : "",
    Number.isFinite(ch) ? `24h change: ${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%` : "",
    Number.isFinite(Number(c.change_7d)) && c.change_7d !== null ? `7-day change: ${Number(c.change_7d) >= 0 ? "+" : ""}${Number(c.change_7d).toFixed(1)}%` : "",
    c.via ? `Bought on sasa as: ${c.via}` : `Traded on sasa on: ${chain}`,
    `Token contract: ${c.address}`,
  ].filter(Boolean);
  const summary =
    `<noscript><article><h1>${html(c.name)} (${html(c.symbol)}) price</h1><p>${html(description)}</p>` +
    `<ul>${facts.map((f) => `<li>${html(f)}</li>`).join("")}</ul>` +
    `<p>On sasa you can buy and sell ${html(c.name)} with USDC in one tap: sasa finds the best price across DEXs, with no bridging and no gas token needed to buy.</p>` +
    related +
    `<p><a href="${SITE}/market/">All 300 coins</a> · <a href="${SITE}/explore/">Meme coins</a> · <a href="${SITE}/learn/">Guides</a></p></article></noscript>`;
  const res = new Response(shell.body, { status: 200, headers: shell.headers });
  return new HTMLRewriter()
    .on("title", { element: (e) => e.setInnerContent(title) })
    .on('meta[name="description"]', set(description))
    .on('meta[property="og:title"]', set(title))
    .on('meta[name="twitter:title"]', set(title))
    .on('meta[property="og:description"]', set(description))
    .on('meta[name="twitter:description"]', set(description))
    .on('meta[property="og:url"]', set(url2))
    .on('meta[property="og:image"]', set(`${SITE}/og-plain.png`))
    .on('meta[name="twitter:image"]', set(`${SITE}/og-plain.png`))
    .on('link[rel="canonical"]', { element: (e) => e.setAttribute("href", url2) })
    .on("head", { element: (e) => e.append(`<script type="application/ld+json">${esc(JSON.stringify(ld))}</script>`, { html: true }) })
    .on("body", { element: (e) => e.append(summary, { html: true }) })
    .transform(res);
}
