/**
 * Cloudflare Pages Function for /coin/?id=…
 *
 * Link previews (X, Telegram, Discord) read the page's meta tags without
 * running JavaScript. This fills those tags in for the coin being shared:
 * its name, description and share card image. Everything else about the
 * page is left untouched.
 */
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const SITE = "https://sasapad.fun";
const ID = /^0x[0-9a-f]{40}:0x[0-9a-f]{64}$/;

const cardFile = (id) => `${id.replace(/[^0-9a-z]/g, "-")}.png`;

export async function onRequestGet(ctx) {
  const res = await ctx.next();
  const type = res.headers.get("content-type") || "";
  if (!type.includes("text/html")) return res;

  const url = new URL(ctx.request.url);
  const id = (url.searchParams.get("id") || "").toLowerCase();
  if (!ID.test(id)) return res;

  const base = (ctx.env && ctx.env.SUPABASE_URL) || SUPABASE_URL;
  const key = (ctx.env && ctx.env.SUPABASE_KEY) || SUPABASE_KEY;
  let coin = null;
  try {
    const r = await fetch(`${base}/rest/v1/coin_list?id=eq.${encodeURIComponent(id)}&select=name,symbol,description,launch_key,created_at,holders_total,curves,graduated_chain,volume_native_24h,trades_24h,change_24h`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (r.ok) coin = (await r.json())[0] || null;
  } catch {}
  if (!coin) return res;

  const image = `${base}/storage/v1/object/public/cards/${cardFile(id)}`;
  let hasImage = false;
  try {
    const h = await fetch(image, { method: "HEAD", cf: { cacheTtl: 60 } });
    hasImage = h.ok;
  } catch {}

  const title = `${coin.name} ($${coin.symbol}) price, chart and holders · sasa`;
  const description =
    (coin.description || "").trim().slice(0, 180) ||
    `Trade $${coin.symbol} on every chain at once. Launch once. Live on every chain.`;
  const pageUrl = `${SITE}/coin/?id=${encodeURIComponent(id)}`;
  const set = (value) => ({ element: (e) => e.setAttribute("content", value) });

  let rw = new HTMLRewriter()
    .on("title", { element: (e) => e.setInnerContent(title) })
    .on('meta[name="description"]', set(description))
    .on('meta[property="og:title"]', set(title))
    .on('meta[name="twitter:title"]', set(title))
    .on('meta[property="og:description"]', set(description))
    .on('meta[name="twitter:description"]', set(description))
    .on('meta[property="og:url"]', set(pageUrl))
    .on('meta[property="og:image:alt"]', set(title))
    .on('link[rel="canonical"]', { element: (e) => e.setAttribute("href", pageUrl) });
  if (hasImage) {
    rw = rw
      .on('meta[property="og:image"]', set(image))
      .on('meta[name="twitter:image"]', set(image))
      .on('meta[property="og:image:width"]', set("1200"))
      .on('meta[property="og:image:height"]', set("630"));
  }
  // Structured data for search engines and AI answers: what this page is,
  // where it sits, and where people discuss the coin (its forum board).
  const slug = (x, max) =>
    String(x || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
  const nameSlug = slug(coin.name, 40) || "coin";
  const symSlug = slug(coin.symbol, 16);
  const board = `${SITE}/forum/${[nameSlug, symSlug && symSlug !== nameSlug ? symSlug : "", String(coin.launch_key || "").slice(2, 10)].filter(Boolean).join("-")}/`;
  const ld = [
    {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: title,
      url: pageUrl,
      description,
      ...(hasImage ? { image: image } : {}),
      isPartOf: { "@type": "WebSite", name: "sasa", url: SITE },
      about: { "@type": "Thing", name: `${coin.name} ($${coin.symbol})`, description: (coin.description || "").trim().slice(0, 300) || undefined },
      discussionUrl: board,
      ...(coin.created_at ? { datePublished: new Date(coin.created_at).toISOString() } : {}),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "sasa", item: `${SITE}/` },
        { "@type": "ListItem", position: 2, name: `${coin.name} ($${coin.symbol})`, item: pageUrl },
      ],
    },
  ];
  // A plain-text summary for crawlers and AI engines that don't run JavaScript.
  // People never see it (the app renders the page); it says the same things.
  const CHAIN_NAMES = { 46630: "Robinhood Chain", 4663: "Robinhood Chain", 84532: "Base", 8453: "Base", 56: "BNB Chain", 1: "Ethereum" };
  const curves = Array.isArray(coin.curves) ? coin.curves : [];
  const chains = [...new Set(curves.map((k) => CHAIN_NAMES[k.chain_id]).filter(Boolean))];
  const raised = curves.filter((k) => k.state === 0 || k.state === 3).reduce((s, k) => s + Number(String(k.real_native || "0").split(".")[0]) / 1e6, 0);
  const vol = Number(coin.volume_native_24h || 0) / 1e6;
  const ch = coin.change_24h === null || coin.change_24h === undefined ? null : Number(coin.change_24h) * 100;
  const usd = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(2)}`);
  const html = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const facts = [
    chains.length ? `Chains: ${chains.join(", ")}` : "",
    coin.graduated_chain ? "Status: graduated, trading in a locked Uniswap pool" : `Status: on its bonding curve${raised > 0 ? `, ${usd(raised)} raised so far` : ""}`,
    coin.holders_total ? `Holders: ${Number(coin.holders_total).toLocaleString("en-US")}` : "",
    vol > 0 ? `24h volume: ${usd(vol)}` : "",
    Number.isFinite(ch) ? `24h change: ${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%` : "",
    coin.trades_24h ? `Trades in the last 24 hours: ${coin.trades_24h}` : "",
    coin.created_at ? `Launched: ${new Date(coin.created_at).toISOString().slice(0, 10)}` : "",
  ].filter(Boolean);
  const summary =
    `<noscript><article><h1>${html(coin.name)} ($${html(coin.symbol)})</h1>` +
    `<p>${html(description)}</p><ul>${facts.map((f) => `<li>${html(f)}</li>`).join("")}</ul>` +
    `<p>${html(coin.name)} was launched on sasa, a multi-chain meme coin launchpad. Buy and sell it with USDC in one tap, see its live chart, holder map and first buyers on this page.</p>` +
    `<p><a href="${board}">${html(coin.name)} forum</a> · <a href="${SITE}/explore/">Explore coins on sasa</a> · <a href="${SITE}/learn/">Guides</a></p></article></noscript>`;
  rw = rw.on("body", { element: (e) => e.append(summary, { html: true }) });
  const ldTag = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\u003c")}</script><link rel="alternate" href="${board}" title="${String(coin.name).replace(/"/g, "&quot;")} forum">`;
  rw = rw.on("head", { element: (e) => e.append(ldTag, { html: true }) });
  const out = rw.transform(res);
  const headers = new Headers(out.headers);
  headers.set("cache-control", "public, max-age=60");
  return new Response(out.body, { status: out.status, headers });
}
