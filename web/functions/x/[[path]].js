import { isMemeForList } from "../../edge/top-render.js";
import { coinLd, coinStory, renderCoinSeo } from "../../edge/coin-seo.js";
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

/** Rows from a public table or view; [] when the database didn't answer. */
async function list(query, cacheTtl) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      cf: { cacheTtl, cacheEverything: true },
    });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : j && typeof j === "object" ? [j] : [];
  } catch {
    return [];
  }
}

/** Two significant digits: fewer distinct queries, so the edge cache works for similar coins. */
const round2 = (n) => {
  const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(n)) - 1));
  return Math.round(n / p) * p;
};

/**
 * The search section of a coin page: its summary, facts, price history, biggest trades, daily
 * lists, similar coins and questions (edge/coin-seo.js), plus the matching structured data.
 */
async function coinSeo({ network, address, c, arch, quiet, sasaCoin }) {
  const a = encodeURIComponent(address);
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const mc = Number(c.mcap_usd) > 0 ? Number(c.mcap_usd) : Number(c.fdv_usd) > 0 ? Number(c.fdv_usd) : 0;
  const view = network === "solana" ? "sol_ext_coins" : "ext_coins";
  const band = mc > 0 ? `&mcap_usd=gte.${round2(mc / 4)}&mcap_usd=lte.${round2(mc * 4)}` : "";
  const [days, big, sasa, firstDay, similar] = await Promise.all([
    list(`coin_days?network=eq.${network}&address=eq.${a}&select=day,price,price_hi,price_lo,mcap,vol,chg,gain_rank,vol_rank&order=day.desc&limit=60`, 1800),
    list(`big_trades?network=eq.${network}&address=eq.${a}&t=gte.${weekAgo}&select=t,side,usd,wallet,tx&order=usd.desc&limit=10`, 1800),
    list(`rpc/coin_sasa_stats?p_coin=${a}`, 1800),
    list("day_pages?chain=eq.all&select=day&order=day.asc&limit=1", 86400),
    list(`${view}?network=eq.${network}${band}&select=network,address,name,symbol,image,mcap_usd,fdv_usd,change_24h,vol_24h&order=vol_24h.desc.nullslast&limit=16`, 1800).then(async (rows) =>
      // nothing in its size band: the chain's busiest coins instead
      rows.length >= 4 || !band ? rows : list(`${view}?network=eq.${network}&select=network,address,name,symbol,image,mcap_usd,fdv_usd,change_24h,vol_24h&order=vol_24h.desc.nullslast&limit=16`, 1800)
    ),
  ]);
  const s = sasa[0] && Number(sasa[0].trades) > 0 ? { trades: Number(sasa[0].trades), usd: Number(sasa[0].usd), traders: Number(sasa[0].traders) } : null;
  const input = { network, address, c, arch, days, big, sasa: s, sasaCoin, quiet };
  return {
    html: renderCoinSeo(input, { similar: similar.filter(isMemeForList), firstDay: firstDay[0]?.day ?? null }),
    ld: coinLd(input, network === "solana" ? `${SITE}/x/solana/${address}/` : coinUrl(network, address)),
    story: coinStory(input),
  };
}

/** Only the search section (the app fetches it when it opens a coin without a full page load). */
const seoPart = (html) =>
  new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=600", "x-robots-tag": "noindex", "x-content-type-options": "nosniff" } });

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
  const part = url.searchParams.get("part") === "seo";
  if (!Object.prototype.hasOwnProperty.call(NETS, network)) return part ? new Response("", { status: 404 }) : notFound(await appShell(ctx, url));

  const [live, arch] = await Promise.all([one("ext_coins_all", network, address, 120), one("ext_archive_pages", network, address, 600)]);
  // the database didn't answer: "try again soon" (a 404 now could drop the page from search)
  // (the archive alone failing, e.g. before archive.sql has run, isn't fatal: the live list decides)
  if (live === "error" || (arch === "error" && !live)) {
    if (part) return new Response("", { status: 503, headers: { "cache-control": "no-store" } });
    const shell = await appShell(ctx, url);
    const headers = new Headers(shell.headers);
    headers.set("retry-after", "120");
    headers.set("cache-control", "no-store");
    return new HTMLRewriter().on("head", { element: (e) => e.append('<meta name="robots" content="noindex">', { html: true }) }).transform(new Response(shell.body, { status: 503, headers }));
  }
  const archRow = arch === "error" ? null : arch;
  const c = live ? { ...live, peak_mcap: archRow ? archRow.peak_mcap : null } : archRow;
  if (!c) return part ? new Response("", { status: 404 }) : notFound(await appShell(ctx, url));
  const indexed = !!archRow && archRow.indexed === true;
  const quiet = !live && archRow ? archRow.last_seen : null;
  const [shell, seo] = await Promise.all([part ? null : appShell(ctx, url), coinSeo({ network, address, c, arch: archRow, quiet, sasaCoin: false }).catch(() => null)]);
  if (part) return seo ? seoPart(seo.html) : new Response("", { status: 404 });
  const res = new Response(shell.body, { status: 200, headers: shell.headers });

  const chain = NETS[network];
  const mc = money(Number(c.mcap_usd) > 0 ? c.mcap_usd : c.fdv_usd);
  const ch = Number(c.change_24h);
  const title = `${c.name} ($${c.symbol}) price, chart and market cap on ${chain} · sasa`;
  // the coin's own numbers first: every page's description is different
  const description = [
    mc ? `${c.name} ($${c.symbol}) market cap ${mc}.` : `${c.name} ($${c.symbol}) on ${chain}.`,
    !quiet && money(c.vol_24h) ? `24h volume ${money(c.vol_24h)}.` : "",
    !quiet && Number.isFinite(ch) && c.change_24h !== null ? `24h change ${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%.` : "",
    `Live chart, price history, biggest trades and token check. Buy it with USDC on sasa.`,
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
    dateModified: new Date().toISOString(),
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
    .on("head", {
      element: (e) =>
        e.append(`${[ld, ...(seo ? seo.ld : [])].map((o) => `<script type="application/ld+json">${esc(JSON.stringify(o))}</script>`).join("")}${indexed ? "" : '<meta name="robots" content="noindex">'}`, { html: true }),
    });
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
  // The search section, readable without JavaScript; the app moves it under the coin's trades.
  if (seo) rw = rw.on("body", { element: (e) => e.append(seo.html, { html: true }) });
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
 * A Solana coin's page: its title, description, share card (drawn by the indexer) and search
 * section. In search results when the coin is in the archive (a real coin, same bar as the other
 * chains); otherwise kept out. A coin we don't know yet (launched a moment ago) still gets the
 * app page, which waits for it.
 */
async function solanaPage(ctx, url, address) {
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}/x/solana/${address}/${keepQuery(url)}`, 301);
  const part = url.searchParams.get("part") === "seo";
  const [market, ours, arch] = await Promise.all([solRow("sol_ext_coins_all", address, 120), solRow("sol_sasa_coins", address, 60), one("ext_archive_pages", "solana", address, 600)]);
  const archRow = arch && arch !== "error" ? arch : null;
  const own = ours && ours !== "error" ? ours : null;
  const live = (market && market !== "error" ? market : null) || own;
  const c = live ? { ...live, name: (own && own.name) || live.name, peak_mcap: archRow ? archRow.peak_mcap : null } : archRow;
  const quiet = !live && archRow ? archRow.last_seen : null;
  const indexed = !!archRow && archRow.indexed === true;
  const seo = c ? await coinSeo({ network: "solana", address, c, arch: archRow, quiet, sasaCoin: !!own }).catch(() => null) : null;
  if (part) return seo ? seoPart(seo.html) : new Response("", { status: 404 });
  const shell = await appShell(ctx, url);
  let rw = new HTMLRewriter();
  if (!indexed) rw = rw.on("head", { element: (e) => e.append('<meta name="robots" content="noindex">', { html: true }) });
  if (c) {
    const set = (value) => ({ element: (e) => e.setAttribute("content", value) });
    const mc = money(Number(c.mcap_usd) > 0 ? c.mcap_usd : c.fdv_usd);
    const title = `${c.name} ($${c.symbol}) price, chart and market cap on Solana · sasa`;
    const ch = Number(c.change_24h);
    const description = [
      mc ? `${c.name} ($${c.symbol}) market cap ${mc}.` : `${c.name} ($${c.symbol}) on Solana.`,
      !quiet && money(c.vol_24h) ? `24h volume ${money(c.vol_24h)}.` : "",
      !quiet && c.change_24h !== null && c.change_24h !== undefined && Number.isFinite(ch) ? `24h change ${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%.` : "",
      "Live chart, price history and biggest trades. Buy it with USDC on sasa, no SOL needed.",
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 300);
    const pageUrl = `${SITE}/x/solana/${address}/`;
    const card = `${SUPABASE_URL}/storage/v1/object/public/cards/x-solana-${address}.png`;
    let img = `${SITE}/og-plain.png`;
    try {
      const h = await fetch(card, { method: "HEAD", cf: { cacheTtl: 120 } });
      if (h.ok) img = card;
    } catch {}
    const ld = {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: title,
      description,
      url: pageUrl,
      dateModified: new Date().toISOString(),
      about: { "@type": "Thing", name: `${c.name} (${c.symbol})`, identifier: address },
      isPartOf: { "@type": "WebSite", name: "sasa", url: SITE },
    };
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
      .on('meta[property="og:image:alt"]', set(title))
      .on("head", { element: (e) => e.append([ld, ...(seo ? seo.ld : [])].map((o) => `<script type="application/ld+json">${esc(JSON.stringify(o))}</script>`).join(""), { html: true }) });
    if (seo) rw = rw.on("body", { element: (e) => e.append(seo.html, { html: true }) });
  }
  return rw.transform(new Response(shell.body, { status: 200, headers: shell.headers }));
}
