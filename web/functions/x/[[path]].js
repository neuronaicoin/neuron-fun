import { isMemeForList, listFor } from "../../edge/top-render.js";
/**
 * Cloudflare Pages Function for coin pages from any DEX:
 *   /x/<network>/<address>     the page's own address (search engines, shares)
 *   /x/?n=<network>&a=<token>  in-app links; a full page load moves to the address above
 *
 * Fills in the meta tags, structured data and a plain-text summary for the coin, so link
 * previews, search engines and AI crawlers see it without running JavaScript. The data comes
 * from the live list (last 30 days) or the archive (every real coin we ever saw, never junk).
 * Only archived coins are offered to search engines; anything else is "noindex", and a coin we
 * don't have (or found bad) answers 404.
 */
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const SITE = "https://sasapad.fun";
const NETS = { base: "Base", bsc: "BNB Chain", eth: "Ethereum", robinhood: "Robinhood Chain", arc: "Arc" };
const PATH = /^\/x\/([a-z]+)\/(0x[0-9a-fA-F]{40})\/?$/;
/** Solana coins: /x/solana/<address>/ (base58, case-sensitive). */
const SOL_PATH = /^\/x\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})\/?$/;

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
const coinUrl = (network, address) => `${SITE}/x/${network}/${address}/`;

/** The coin's row in `view`; null when there is none; "error" when the database didn't answer. */
async function one(view, network, address, cacheTtl) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${view}?network=eq.${network}&address=eq.${address}&select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cf: { cacheTtl, cacheEverything: true },
    });
    if (!r.ok) return "error";
    const rows = await r.json();
    return Array.isArray(rows) ? rows[0] || null : "error";
  } catch {
    return "error";
  }
}

/** The address bar's other parameters (ref, utm…) kept when a page moves. */
function keepQuery(url) {
  const q = new URLSearchParams(url.search);
  q.delete("n");
  q.delete("a");
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** The app's coin page, fetched clean: no visitor cache headers in, no shared ETag out. */
async function appShell(ctx, url) {
  const r = await ctx.env.ASSETS.fetch(new URL("/x/", url.origin));
  const headers = new Headers(r.headers);
  for (const h of ["etag", "last-modified", "content-length"]) headers.delete(h);
  headers.set("cache-control", "public, max-age=0, must-revalidate");
  return { body: r.body, headers };
}

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const sol = SOL_PATH.exec(url.pathname);
  if (sol) return solanaPage(ctx, url, sol[1]);
  const m = PATH.exec(url.pathname);
  if (!m) {
    // /x/?n=solana&a=…: a Solana coin's own address
    if ((url.pathname === "/x/" || url.pathname === "/x") && url.searchParams.get("n") === "solana") {
      const sa = (url.searchParams.get("a") || "").trim();
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sa)) return Response.redirect(`${url.origin}/x/solana/${sa}/${keepQuery(url)}`, 301);
    }
    // /x/?n=…&a=…: the page lives at its own address
    const n = url.searchParams.get("n") || "";
    const a = (url.searchParams.get("a") || "").toLowerCase();
    if ((url.pathname === "/x/" || url.pathname === "/x") && Object.prototype.hasOwnProperty.call(NETS, n) && /^0x[0-9a-f]{40}$/.test(a)) {
      return Response.redirect(`${url.origin}/x/${n}/${a}/${keepQuery(url)}`, 301);
    }
    return ctx.next();
  }
  const network = m[1];
  const address = m[2].toLowerCase();
  // the app's coin page (one page for every coin; it reads the address from the URL)
  // one address per coin: lowercase, with the closing slash
  if (Object.prototype.hasOwnProperty.call(NETS, network) && (m[2] !== address || !url.pathname.endsWith("/")))
    return Response.redirect(`${url.origin}/x/${network}/${address}/${keepQuery(url)}`, 301);
  const shell = await appShell(ctx, url);
  if (!Object.prototype.hasOwnProperty.call(NETS, network)) return notFound(shell);

  const [live, arch] = await Promise.all([one("ext_coins_all", network, address, 120), one("ext_archive_pages", network, address, 600)]);
  // the database didn't answer: "try again soon" (a 404 now could drop the page from search)
  // (the archive alone failing, e.g. before archive.sql has run, isn't fatal: the live list decides)
  if (live === "error" || (arch === "error" && !live)) {
    const headers = new Headers(shell.headers);
    headers.set("retry-after", "120");
    headers.set("cache-control", "no-store");
    return new HTMLRewriter().on("head", { element: (e) => e.append('<meta name="robots" content="noindex">', { html: true }) }).transform(new Response(shell.body, { status: 503, headers }));
  }
  const archRow = arch === "error" ? null : arch;
  const c = live ? { ...live, peak_mcap: archRow ? archRow.peak_mcap : null } : archRow;
  if (!c) return notFound(shell);
  const indexed = !!archRow && archRow.indexed === true;
  const quiet = !live && archRow ? archRow.last_seen : null;
  const res = new Response(shell.body, { status: 200, headers: shell.headers });

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
  const pageUrl = coinUrl(network, address);
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
    .on("head", { element: (e) => e.append(`<script type="application/ld+json">${esc(JSON.stringify(ld))}</script>${indexed ? "" : '<meta name="robots" content="noindex">'}`, { html: true }) });
  // Share image: the coin's own card (drawn by the indexer for busy coins), else the plain sasa card.
  // Never the homepage's sample coin.
  const card = `${SUPABASE_URL}/storage/v1/object/public/cards/x-${network}-${address}.png`;
  let img = `${SITE}/og-plain.png`;
  try {
    const h = await fetch(card, { method: "HEAD", cf: { cacheTtl: 300 } });
    if (h.ok) img = card;
  } catch {}
  rw = rw
    .on('meta[property="og:image"]', set(img))
    .on('meta[name="twitter:image"]', set(img))
    .on('meta[property="og:image:width"]', set("1200"))
    .on('meta[property="og:image:height"]', set("630"))
    .on('meta[property="og:image:alt"]', set(title));
  // Other busy coins on the same chain: links that help crawlers find more pages.
  let related = "";
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ext_coins?network=eq.${network}&select=network,address,name,symbol,vol_24h&order=vol_24h.desc.nullslast&limit=24`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cf: { cacheTtl: 1800, cacheEverything: true },
    });
    if (r.ok) {
      const esc2 = (x) => String(x ?? "").replace(/[&<>"]/g, (k) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[k]);
      const list = (await r.json()).filter((o) => o.address !== address && isMemeForList(o)).slice(0, 12);
      if (list.length)
        related = `<h2>More meme coins on ${esc2(NETS[network])}</h2><ul>${list.map((o) => `<li><a href="${coinUrl(o.network, o.address)}">${esc2(o.name)} ($${esc2(o.symbol)})</a></li>`).join("")}</ul>`;
    }
  } catch {}

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
    quiet ? `Last actively traded: ${new Date(quiet).toISOString().slice(0, 10)}` : "",
    Number(c.peak_mcap) > 0 ? `Highest market cap seen: ${money(c.peak_mcap)}` : "",
    `Contract: ${address}`,
  ].filter(Boolean);
  const summary =
    `<noscript><article><h1>${html(c.name)} ($${html(c.symbol)}) on ${html(chain)}</h1><p>${html(description)}</p>` +
    `<ul>${facts.map((f) => `<li>${html(f)}</li>`).join("")}</ul>` +
    `<p>On sasa you can buy and sell ${html(c.name)} with USDC in one tap, with no bridging and no gas token, and follow its live chart and trades.</p>` +
    related +
    `<p><a href="${SITE}/top/${listFor(network).slug}/">Top ${html(chain)} meme coins today</a> · <a href="${SITE}/top/${listFor(network, "gainers").slug}/">Biggest ${html(chain)} gainers</a> · <a href="${SITE}/top/${listFor(network, "new").slug}/">New ${html(chain)} meme coins</a> · <a href="${SITE}/explore/">Explore</a> · <a href="${SITE}/learn/">Guides</a></p></article></noscript>`;
  rw = rw.on("body", { element: (e) => e.append(summary, { html: true }) });
  return rw.transform(res);
}

/** The app shell with a 404 status and kept out of search results. */
function notFound(shell) {
  const res = new Response(shell.body, { status: 404, headers: shell.headers });
  return new HTMLRewriter().on("head", { element: (e) => e.append('<meta name="robots" content="noindex">', { html: true }) }).transform(res);
}

/** A row from a Solana view by address; null when none; "error" when the database didn't answer. */
async function solRow(view, address, cacheTtl) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${view}?address=eq.${address}&select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cf: { cacheTtl, cacheEverything: true },
    });
    if (!r.ok) return "error";
    const rows = await r.json();
    return Array.isArray(rows) ? rows[0] || null : "error";
  } catch {
    return "error";
  }
}

/**
 * A Solana coin's page: its title, description and share card (drawn by the indexer). Kept out
 * of search results. A coin we don't know yet (launched a moment ago) still gets the app page,
 * which waits for it.
 */
async function solanaPage(ctx, url, address) {
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}/x/solana/${address}/${keepQuery(url)}`, 301);
  const shell = await appShell(ctx, url);
  const [market, ours] = await Promise.all([solRow("sol_ext_coins_all", address, 120), solRow("sol_sasa_coins", address, 60)]);
  const c = (market && market !== "error" ? market : null) || (ours && ours !== "error" ? ours : null);
  let rw = new HTMLRewriter().on("head", { element: (e) => e.append('<meta name="robots" content="noindex">', { html: true }) });
  if (c) {
    const set = (value) => ({ element: (e) => e.setAttribute("content", value) });
    const mc = money(Number(c.mcap_usd) > 0 ? c.mcap_usd : c.fdv_usd);
    const title = `${c.name} ($${c.symbol}) price, chart and market cap on Solana · sasa`;
    const description = [`Buy and sell ${c.name} ($${c.symbol}) on Solana with USDC on sasa. No SOL needed.`, mc ? `Market cap ${mc}.` : ""].filter(Boolean).join(" ");
    const pageUrl = `${SITE}/x/solana/${address}/`;
    const card = `${SUPABASE_URL}/storage/v1/object/public/cards/x-solana-${address}.png`;
    let img = `${SITE}/og-plain.png`;
    try {
      const h = await fetch(card, { method: "HEAD", cf: { cacheTtl: 120 } });
      if (h.ok) img = card;
    } catch {}
    rw = rw
      .on("title", { element: (e) => e.setInnerContent(title) })
      .on('meta[name="description"]', set(description))
      .on('meta[property="og:title"]', set(title))
      .on('meta[name="twitter:title"]', set(title))
      .on('meta[property="og:description"]', set(description))
      .on('meta[name="twitter:description"]', set(description))
      .on('meta[property="og:url"]', set(pageUrl))
      .on('link[rel="canonical"]', { element: (e) => e.setAttribute("href", pageUrl) })
      .on('meta[property="og:image"]', set(img))
      .on('meta[name="twitter:image"]', set(img))
      .on('meta[property="og:image:width"]', set("1200"))
      .on('meta[property="og:image:height"]', set("630"))
      .on('meta[property="og:image:alt"]', set(title));
  }
  return rw.transform(new Response(shell.body, { status: 200, headers: shell.headers }));
}
