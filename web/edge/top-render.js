/**
 * Daily "top meme coins" pages (/top/...): server-rendered HTML that search
 * and AI engines can read without JavaScript, rebuilt from live data every
 * 30 minutes. Pure functions: data in, HTML out (easy to test).
 */
export const SITE = "https://sasapad.fun";

/** Every list: its path, what it shows and how it is filtered and sorted. */
export const LISTS = [
  { slug: "trending-meme-coins", short: "Trending", h1: "Trending meme coins today", what: "the most traded meme coins across Solana, Robinhood Chain, Base, BNB Chain, Ethereum and Arc", network: null, sort: "volume" },
  { slug: "solana-meme-coins", short: "Solana", h1: "Top Solana meme coins today", what: "the most traded meme coins on Solana", network: "solana", chain: "Solana", sort: "volume" },
  { slug: "robinhood-chain-meme-coins", short: "Robinhood Chain", h1: "Top Robinhood Chain meme coins today", what: "the most traded meme coins on Robinhood Chain", network: "robinhood", chain: "Robinhood Chain", sort: "volume" },
  { slug: "base-meme-coins", short: "Base", h1: "Top Base meme coins today", what: "the most traded meme coins on Base", network: "base", chain: "Base", sort: "volume" },
  { slug: "bnb-chain-meme-coins", short: "BNB Chain", h1: "Top BNB Chain meme coins today", what: "the most traded meme coins on BNB Chain", network: "bsc", chain: "BNB Chain", sort: "volume" },
  { slug: "ethereum-meme-coins", short: "Ethereum", h1: "Top Ethereum meme coins today", what: "the most traded meme coins on Ethereum", network: "eth", chain: "Ethereum", sort: "volume" },
  { slug: "arc-meme-coins", short: "Arc", h1: "Top Arc meme coins today", what: "the most traded meme coins on Arc", network: "arc", chain: "Arc", sort: "volume" },
  { slug: "meme-coin-gainers", short: "Top gainers", h1: "Biggest meme coin gainers today", what: "the meme coins that rose the most in the last 24 hours, among coins with real trading volume", network: null, sort: "gainers" },
  { slug: "new-meme-coins", short: "New today", h1: "New meme coins today", what: "meme coins whose trading pool opened in the last 24 hours, busiest first", network: null, sort: "new" },
].map((l) => ({ ...l, main: true }));

// The same two views for every chain: biggest gainers and new pools.
const CHAIN_PAGES = [
  ["solana", "solana", "Solana"],
  ["robinhood-chain", "robinhood", "Robinhood Chain"],
  ["base", "base", "Base"],
  ["bnb-chain", "bsc", "BNB Chain"],
  ["ethereum", "eth", "Ethereum"],
  ["arc", "arc", "Arc"],
];
for (const [slug, network, chain] of CHAIN_PAGES) {
  LISTS.push(
    { slug: `${slug}-meme-coin-gainers`, short: `${chain} gainers`, h1: `Biggest ${chain} meme coin gainers today`, what: `the ${chain} meme coins that rose the most in the last 24 hours, among coins with real trading volume`, network, chain, sort: "gainers" },
    { slug: `new-${slug}-meme-coins`, short: `New on ${chain}`, h1: `New ${chain} meme coins today`, what: `${chain} meme coins whose trading pool opened in the last 24 hours, busiest first`, network, chain, sort: "new" }
  );
}
/** The list for a chain's network id and kind (used for links from coin pages). */
export const listFor = (network, sort = "volume") => LISTS.find((l) => l.network === network && l.sort === sort) || LISTS[0];

export const NETS = { solana: "Solana", base: "Base", bsc: "BNB Chain", eth: "Ethereum", robinhood: "Robinhood Chain", arc: "Arc" };
export const MIN_GAINER_VOLUME = 10_000;

// These lists promise meme coins: leave out tokenized stocks, majors, big brand
// names, stablecoins and wrapped coins (they are still tradable in the app).
const MAJORS = new Set(["bitcoin", "ethereum", "ether", "solana", "tether", "usd coin", "chainlink", "uniswap", "aave", "polygon", "avalanche", "toncoin", "tron", "cardano", "litecoin", "xrp", "stellar", "bnb", "arbitrum", "optimism", "base", "robinhood", "coinbase"]);
const BRANDS = /\b(openai|chatgpt|anthropic|google|alphabet|meta platforms|facebook|apple|amazon|microsoft|nvidia|tesla|netflix|spacex|palantir|berkshire|jpmorgan|visa|mastercard|blackrock|microstrategy|strategy inc)\b/i;
const COMPANY = /\b(inc|corp|corporation|ltd|plc|llc|holdings|class [abc]|industries|tokeni[sz]ed|xstock|etf|trust|shares?)\b\.?/i;
const PLUMBING = /\b(wrapped|staked|stable ?coin|tether gold|pax gold)\b/i;
export function isMemeForList(c) {
  const name = String(c.name ?? "").trim();
  const sym = String(c.symbol ?? "").trim().toUpperCase();
  if (!name || !sym) return false;
  if (MAJORS.has(name.toLowerCase())) return false;
  // a launchpad's own token is not a meme coin (and its brand never shows on sasa)
  if (/pump/i.test(sym) && /^pump/i.test(name)) return false;
  if (BRANDS.test(name) || COMPANY.test(name) || PLUMBING.test(name)) return false;
  if (/USD/.test(sym) || /^W(ETH|BTC|BNB|SOL|AVAX|POL|MATIC|S)$/.test(sym) || /^(ST|WST|WE|EZ|R|CB|S|M|OS)?ETH$/.test(sym) || /^(C?BTC|BTCB|TBTC|WBTC)$/.test(sym)) return false;
  // Tokenized stocks: AAPLx, METAx, GOOGLx...
  if (/^[A-Z]{1,5}X$/.test(sym) && /x$/.test(String(c.symbol))) return false;
  return true;
}

/** Over +10,000% in a day means the pool just opened from a tiny first price: not a real move. */
export const sane24h = (v) => {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) || Math.abs(n) > 10_000 ? null : n;
};

/** What a list shows: meme coins only, honest 24h changes, at most 50. */
export function cleanCoins(rows, list) {
  let out = (rows || []).filter(isMemeForList).map((c) => ({ ...c, change_24h: sane24h(c.change_24h) }));
  if (list && list.sort === "gainers") out = out.filter((c) => c.change_24h !== null).sort((a, b) => b.change_24h - a.change_24h);
  return out.slice(0, 50);
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const jsonLd = (o) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
export function money(v) {
  const n = num(v);
  if (n === null || n <= 0) return "—";
  const t = (x) => x.replace(/\.?0+$/, "");
  if (n >= 1e9) return `$${t((n / 1e9).toFixed(2))}B`;
  if (n >= 999_950) return `$${t((n / 1e6).toFixed(2))}M`;
  if (n >= 1e3) return `$${t((n / 1e3).toFixed(1))}K`;
  return `$${n.toFixed(n < 10 ? 2 : 0)}`;
}
export function price(v) {
  const n = num(v);
  if (n === null || n <= 0) return "—";
  if (n >= 1) return `$${n.toFixed(n >= 100 ? 2 : 4)}`;
  // Small prices keep three significant digits: $0.00000123.
  const decimals = Math.min(18, Math.max(2, -Math.floor(Math.log10(n)) + 2));
  return `$${n.toFixed(decimals)}`;
}
const pct = (v) => {
  const n = num(v);
  if (n === null) return { text: "—", cls: "" };
  const a = Math.abs(n);
  return { text: `${n > 0 ? "+" : n < 0 ? "−" : ""}${a >= 1000 ? `${(a / 1000).toFixed(1)}K` : a >= 100 ? a.toFixed(0) : a.toFixed(1)}%`, cls: n > 0.05 ? "up" : n < -0.05 ? "down" : "" };
};
// Solana addresses keep their case; the others are lowercase
const coinUrl = (c) => (c.network === "solana" ? `${SITE}/x/solana/${encodeURIComponent(String(c.address))}/` : `${SITE}/x/${encodeURIComponent(c.network)}/${encodeURIComponent(String(c.address).toLowerCase())}/`);
const mcapOf = (c) => (num(c.mcap_usd) > 0 ? c.mcap_usd : c.fdv_usd);
export const dateLabel = (d) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The PostgREST query for a list (on the ext_coins view: active coins that can be sold). */
export function queryFor(list, now = new Date(), view = list.network === "solana" ? "sol_ext_coins" : "ext_coins") {
  const cols = "network,address,name,symbol,image,price_usd,mcap_usd,fdv_usd,liq_usd,vol_24h,change_24h,buys_24h,sells_24h,pool_created";
  const q = [`select=${cols}`, "vol_24h=gt.0"];
  if (list.network) q.push(`network=eq.${list.network}`);
  if (list.sort === "gainers") q.push(`vol_24h=gte.${MIN_GAINER_VOLUME}`, "change_24h=not.is.null", "change_24h=lte.10000", "order=change_24h.desc");
  else if (list.sort === "new") q.push(`pool_created=gt.${new Date(now.getTime() - 86400_000).toISOString()}`, "order=vol_24h.desc.nullslast");
  else q.push("order=vol_24h.desc.nullslast");
  q.push("limit=120"); // more than shown: some are left out by cleanCoins
  // "vol_24h" appears twice for gainers: PostgREST combines them with AND, which is what we want.
  return `${view}?${q.join("&")}`;
}

function summary(list, coins, today) {
  if (!coins.length) return `No coins match this list right now. It refreshes every 30 minutes.`;
  const vol = coins.reduce((s, c) => s + (num(c.vol_24h) || 0), 0);
  const best = [...coins].filter((c) => num(c.change_24h) !== null).sort((a, b) => b.change_24h - a.change_24h)[0];
  const top = coins[0];
  const parts = [
    `As of ${today}, these are ${list.what}, ranked ${list.sort === "gainers" ? "by 24-hour price change" : "by 24-hour trading volume"}.`,
    `The ${coins.length} coins below traded ${money(vol)} in the last 24 hours.`,
    list.sort === "gainers" ? "" : `${top.name} ($${top.symbol}) leads with ${money(top.vol_24h)} in volume.`,
    best && num(best.change_24h) > 0 ? `The biggest move belongs to ${best.name} ($${best.symbol}), ${pct(best.change_24h).text} in a day.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

const CSS = `
:root{--bg:#fff;--bg2:#f6f6f4;--line:#ebebe8;--ink:#141414;--ink2:#45454a;--mut:#75757b;--acc:#f2600c;--up:#12a150;--down:#e5484d;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f10;--bg2:#1c1c1f;--line:#27272a;--ink:#f4f4f5;--ink2:#c7c7cc;--mut:#8e8e95;--acc:#ff6b1a;--up:#2bc06d;--down:#f0565e}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;padding:env(safe-area-inset-top,0) 0 env(safe-area-inset-bottom,0)}
a{color:inherit}
.top{border-bottom:1px solid var(--line)}
.bar{max-width:1080px;margin:0 auto;height:56px;padding:0 16px;display:flex;align-items:center;gap:16px}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:20px;text-decoration:none;letter-spacing:-.4px}
.bar nav{margin-left:auto;display:flex;align-items:center;gap:16px;font-size:14px}
.bar nav a{text-decoration:none;color:var(--mut)}.bar nav a:hover{color:var(--ink)}
.cta{height:38px;padding:0 14px;border-radius:10px;background:var(--acc);color:#fff!important;font-weight:600;display:flex;align-items:center}
main{max-width:1080px;margin:0 auto;padding:20px 16px 48px}
.crumbs{font-size:13px;color:var(--mut)}.crumbs a{text-decoration:none}
h1{font-size:clamp(26px,5vw,36px);line-height:1.15;letter-spacing:-.6px;margin:8px 0 6px}
.date{font-size:14px;color:var(--mut);margin:0}
.lead{color:var(--ink2);max-width:760px;margin:14px 0 0}
.tabs{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;margin:20px -16px 0;padding:0 16px}
.tabs::-webkit-scrollbar{display:none}
.tabs a{flex:none;height:34px;padding:0 12px;border-radius:8px;font-size:14px;text-decoration:none;color:var(--mut);display:flex;align-items:center;white-space:nowrap}
.tabs a.on{background:var(--bg2);color:var(--ink);font-weight:600}
.wrap{margin-top:14px;overflow-x:auto;border:1px solid var(--line);border-radius:14px}
table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}
th{font-size:12px;font-weight:500;color:var(--mut);text-align:right;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:10px 12px;border-top:1px solid var(--line);text-align:right;white-space:nowrap}
tr:first-child td{border-top:0}
th:nth-child(2),td:nth-child(2){text-align:left;white-space:normal}
th:first-child,td:first-child{text-align:left;color:var(--mut);width:36px}
.coin{display:flex;align-items:center;gap:10px;min-width:0;text-decoration:none}
.coin img,.coin .av{width:32px;height:32px;border-radius:50%;flex:none;object-fit:cover;background:var(--bg2)}
.coin .av{display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:var(--ink2)}
.coin b{display:block;font-weight:600;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.coin small{display:block;color:var(--mut);font-size:12px}
.up{color:var(--up)}.down{color:var(--down)}
.m{display:none}
@media (max-width:700px){.h{display:none}.m{display:block}.coin{gap:8px}.coin img,.coin .av{width:28px;height:28px}.coin>span{min-width:0}.coin b,.coin small{max-width:calc(100vw - 250px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}td,th{padding:10px 6px}th:first-child,td:first-child{width:22px;padding-left:10px}td:last-child,th:last-child{padding-right:10px}table{font-size:13px}}
@media (max-width:420px){.bar nav{gap:12px}.bar nav a:first-child{display:none}}
h2{font-size:20px;letter-spacing:-.3px;margin:36px 0 8px}
p,li{color:var(--ink2)}
.faq dt{font-weight:600;margin-top:14px}.faq dd{margin:4px 0 0;color:var(--ink2)}
.more{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(220px,100%),1fr));gap:8px;margin-top:10px}
.more a{border:1px solid var(--line);border-radius:12px;padding:12px;text-decoration:none;font-weight:600;font-size:15px}
.more a span{display:block;font-weight:400;font-size:13px;color:var(--mut)}
footer{border-top:1px solid var(--line);color:var(--mut);font-size:13px}
footer div{max-width:1080px;margin:0 auto;padding:20px 16px}
`;

const LOGO = `<svg width="26" height="26" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="24" fill="#1A130D"/><path d="M26 60 L50 38 L74 60" fill="none" stroke="#FFB020" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/><path d="M26 80 L50 58 L74 80" fill="none" stroke="#FF6B1A" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/><circle cx="50" cy="22" r="6" fill="#FFB020"/></svg>`;
/** The "sasa" wordmark; the dark half follows the text color. */
const WORDMARK = `<svg height="17" width="61" viewBox="15 -574 2161 598" role="img" aria-label="sasa" style="display:block"><g transform="matrix(1,0,0.2,-1,0,0)"><path d="M253.0 -18.0Q133.0 -18.0 64.0 31.5Q-5.0 81.0 -10.0 171.0H150.0Q154.0 146.0 181.0 128.0Q208.0 110.0 257.0 110.0Q292.0 110.0 317.5 120.5Q343.0 131.0 343.0 155.0Q343.0 176.0 323.0 189.5Q303.0 203.0 250.0 208.0L212.0 212.0Q106.0 223.0 56.0 270.0Q6.0 317.0 6.0 388.0Q6.0 449.0 36.0 488.5Q66.0 528.0 119.0 548.0Q172.0 568.0 240.0 568.0Q351.0 568.0 419.0 519.5Q487.0 471.0 491.0 380.0H331.0Q327.0 405.0 304.0 422.5Q281.0 440.0 238.0 440.0Q207.0 440.0 187.5 429.0Q168.0 418.0 168.0 398.0Q168.0 377.0 186.5 367.0Q205.0 357.0 246.0 352.0L284.0 348.0Q390.0 337.0 447.5 289.5Q505.0 242.0 505.0 165.0Q505.0 108.0 474.5 67.0Q444.0 26.0 387.5 4.0Q331.0 -18.0 253.0 -18.0Z" fill="currentColor"/><path d="M605,440 C645,490 705,500 785,500 C905,500 955,450 955,360 M955,380 L955,0 M955,290 L765,290 C655,290 595,240 595,170 C595,95 655,60 755,60 C865,60 945,110 955,200" stroke="currentColor" fill="none" stroke-width="124" stroke-linejoin="round"/><path d="M1328.0 -18.0Q1208.0 -18.0 1139.0 31.5Q1070.0 81.0 1065.0 171.0H1225.0Q1229.0 146.0 1256.0 128.0Q1283.0 110.0 1332.0 110.0Q1367.0 110.0 1392.5 120.5Q1418.0 131.0 1418.0 155.0Q1418.0 176.0 1398.0 189.5Q1378.0 203.0 1325.0 208.0L1287.0 212.0Q1181.0 223.0 1131.0 270.0Q1081.0 317.0 1081.0 388.0Q1081.0 449.0 1111.0 488.5Q1141.0 528.0 1194.0 548.0Q1247.0 568.0 1315.0 568.0Q1426.0 568.0 1494.0 519.5Q1562.0 471.0 1566.0 380.0H1406.0Q1402.0 405.0 1379.0 422.5Q1356.0 440.0 1313.0 440.0Q1282.0 440.0 1262.5 429.0Q1243.0 418.0 1243.0 398.0Q1243.0 377.0 1261.5 367.0Q1280.0 357.0 1321.0 352.0L1359.0 348.0Q1465.0 337.0 1522.5 289.5Q1580.0 242.0 1580.0 165.0Q1580.0 108.0 1549.5 67.0Q1519.0 26.0 1462.5 4.0Q1406.0 -18.0 1328.0 -18.0Z" fill="#FF6B1A"/><path d="M1680,440 C1720,490 1780,500 1860,500 C1980,500 2030,450 2030,360 M2030,380 L2030,0 M2030,290 L1840,290 C1730,290 1670,240 1670,170 C1670,95 1730,60 1830,60 C1940,60 2020,110 2030,200" stroke="#FF6B1A" fill="none" stroke-width="124" stroke-linejoin="round"/></g></svg>`;

export function shell({ title, description, canonical, ld, body, robots }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${canonical}">${robots ? `<meta name="robots" content="${robots}">` : ""}
<meta property="og:type" content="website"><meta property="og:site_name" content="sasa"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${SITE}/og-plain.png">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@sasapadfun"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${SITE}/og-plain.png">
<link rel="icon" href="/sasa-icon.svg" type="image/svg+xml"><meta name="theme-color" content="#ffffff">
<style>${CSS}</style>${ld.map((o) => `<script type="application/ld+json">${jsonLd(o)}</script>`).join("")}</head><body>
<header class="top"><div class="bar"><a class="brand" href="/">${LOGO}${WORDMARK}</a><nav><a href="/top/">Top coins</a><a href="/day/">Daily</a><a href="/races/">Races</a><a href="/learn/">Learn</a><a class="cta" href="/explore/">Open app</a></nav></div></header>
${body}
<footer><div>Meme coins are risky and can lose all their value. Nothing here is financial advice. Data refreshes every 30 minutes from on-chain DEX pools. © ${new Date().getUTCFullYear()} sasa</div></footer>
</body></html>`;
}

function row(c, i) {
  const ch = pct(c.change_24h);
  const img = typeof c.image === "string" && c.image.startsWith("https://") ? `<img src="${esc(c.image)}" alt="" loading="lazy" width="32" height="32">` : `<span class="av" aria-hidden="true">${esc(String(c.symbol || "?").slice(0, 1).toUpperCase())}</span>`;
  return `<tr><td>${i + 1}</td><td><a class="coin" href="${coinUrl(c)}">${img}<span><b>${esc(c.name)}</b><small>$${esc(c.symbol)} · ${esc(NETS[c.network] || c.network)}<span class="m">Vol ${money(c.vol_24h)}</span></small></span></a></td>
<td class="h">${price(c.price_usd)}</td><td>${money(mcapOf(c))}</td><td class="h">${money(c.vol_24h)}</td><td class="h">${money(c.liq_usd)}</td><td class="${ch.cls}">${ch.text}</td></tr>`;
}

function faqFor(list) {
  const where = list.chain || "Solana, Base and other chains";
  return [
    { q: `What are the top ${list.chain ? `${list.chain} ` : ""}meme coins today?`, a: `This page lists ${list.what}, ranked ${list.sort === "gainers" ? "by 24-hour price change" : "by 24-hour trading volume"}. It refreshes every 30 minutes from live DEX pool data.` },
    { q: "How are the coins ranked?", a: list.sort === "gainers" ? `By price change over the last 24 hours. Only coins with at least ${money(MIN_GAINER_VOLUME)} of 24-hour volume are included, so a tiny trade can't top the list.` : list.sort === "new" ? "Coins whose main pool opened in the last 24 hours, ordered by how much they traded." : "By how much each coin traded in the last 24 hours, across its pools." },
    { q: `How do I buy these meme coins?`, a: `Open a coin and buy it on sasa with USDC in one tap: no bridging and no gas token needed on ${where}.` },
    { q: "Are these coins safe?", a: "Coins that can't be sold (honeypots) are hidden, but meme coins stay very risky. Check the holders, liquidity and first buyers on each coin page before buying, and only use money you can afford to lose." },
  ];
}

export function renderList(list, coins, now = new Date()) {
  const today = dateLabel(now);
  const canonical = `${SITE}/top/${list.slug}/`;
  const title = `${list.h1} (${today}): price, volume and market cap · sasa`;
  const description = summary(list, coins, today).slice(0, 300);
  const faq = faqFor(list);
  const ld = [
    { "@context": "https://schema.org", "@type": "CollectionPage", name: `${list.h1} (${today})`, url: canonical, description, dateModified: now.toISOString(), isPartOf: { "@type": "WebSite", name: "sasa", url: SITE },
      mainEntity: { "@type": "ItemList", numberOfItems: coins.length, itemListOrder: "https://schema.org/ItemListOrderDescending",
        itemListElement: coins.slice(0, 50).map((c, i) => ({ "@type": "ListItem", position: i + 1, name: `${c.name} (${c.symbol})`, url: coinUrl(c) })) } },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "sasa", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Top meme coins", item: `${SITE}/top/` },
      { "@type": "ListItem", position: 3, name: list.h1, item: canonical } ] },
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) },
  ];
  const tabList = LISTS.filter((l) => l.main || (list.network && l.network === list.network) || l.slug === list.slug);
  const tabs = tabList.map((l) => `<a href="/top/${l.slug}/"${l.slug === list.slug ? ' class="on" aria-current="page"' : ""}>${esc(l.short)}</a>`).join("");
  const table = coins.length
    ? `<div class="wrap"><table><thead><tr><th>#</th><th>Coin</th><th class="h">Price</th><th>Market cap</th><th class="h">Volume 24h</th><th class="h">Liquidity</th><th>24h</th></tr></thead><tbody>${coins.map(row).join("")}</tbody></table></div>`
    : `<p>No coins match this list right now. It refreshes every 30 minutes.</p>`;
  const body = `<main>
<div class="crumbs"><a href="/">sasa</a> / <a href="/top/">Top meme coins</a></div>
<h1>${esc(list.h1)}</h1><p class="date">Updated ${esc(today)}, ${now.toISOString().slice(11, 16)} UTC</p>
<p class="lead">${esc(summary(list, coins, today))}</p>
<nav class="tabs" aria-label="Lists">${tabs}</nav>
${table}
<h2>How this list works</h2>
<p>sasa tracks meme coin pools on Solana, Robinhood Chain, Base, BNB Chain, Ethereum and Arc and refreshes these numbers every 30 minutes. Coins that can't be sold, stablecoins and wrapped coins are left out. Market cap uses the circulating supply when it is known, otherwise the fully diluted value. Every coin links to its own page with a live chart, trades and holders, where you can buy or sell it with USDC.</p>
<h2>Questions</h2>
<dl class="faq">${faq.map((f) => `<dt>${esc(f.q)}</dt><dd>${esc(f.a)}</dd>`).join("")}</dl>
<h2>More lists</h2>
<div class="more">${LISTS.filter((l) => l.slug !== list.slug).map((l) => `<a href="/top/${l.slug}/">${esc(l.h1)}<span>Updated every 30 minutes</span></a>`).join("")}</div>
<h2>Learn more</h2>
<ul><li><a href="/learn/how-to-find-trending-meme-coins-early/">How to find trending meme coins early</a></li><li><a href="/learn/how-to-spot-a-meme-coin-rug-pull/">How to spot a meme coin rug pull</a></li><li><a href="/learn/meme-coin-market-cap-vs-fdv-vs-liquidity/">Market cap vs FDV vs liquidity</a></li><li><a href="/learn/meme-coin-glossary/">Meme coin glossary</a></li></ul>
</main>`;
  return shell({ title, description, canonical, ld, body });
}

export function renderHub(firsts, now = new Date()) {
  const today = dateLabel(now);
  const canonical = `${SITE}/top/`;
  const title = `Top meme coins today (${today}) by chain · sasa`;
  const description = `Daily lists of the most traded meme coins on Solana, Robinhood Chain, Base, BNB Chain, Ethereum and Arc, plus today's biggest gainers and new launches. Updated every 30 minutes.`;
  const ld = [
    { "@context": "https://schema.org", "@type": "CollectionPage", name: `Top meme coins today (${today})`, url: canonical, description, dateModified: now.toISOString(),
      hasPart: LISTS.map((l) => ({ "@type": "CollectionPage", name: l.h1, url: `${SITE}/top/${l.slug}/` })) },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "sasa", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Top meme coins", item: canonical } ] },
  ];
  const cards = LISTS.filter((l) => l.main).map((l) => {
    const top = firsts[l.slug] || [];
    const lines = top.length ? `<ol>${top.map((c) => `<li><a href="${coinUrl(c)}">${esc(c.name)}</a> <span class="${pct(c.change_24h).cls}">${pct(c.change_24h).text}</span></li>`).join("")}</ol>` : "<p>No coins right now.</p>";
    return `<section style="border:1px solid var(--line);border-radius:14px;padding:14px 16px"><h2 style="margin:0 0 4px;font-size:18px"><a href="/top/${l.slug}/" style="text-decoration:none">${esc(l.h1)}</a></h2>${lines}<a href="/top/${l.slug}/" style="font-size:14px;color:var(--acc);text-decoration:none;font-weight:600">See the full list</a></section>`;
  }).join("");
  const body = `<main>
<div class="crumbs"><a href="/">sasa</a></div>
<h1>Top meme coins today</h1><p class="date">Updated ${esc(today)}, ${now.toISOString().slice(11, 16)} UTC</p>
<p class="lead">The most traded meme coins on each chain, today's biggest gainers and the newest pools, rebuilt from live DEX data every 30 minutes. Every coin links to a page where you can see its chart and holders and buy or sell it with USDC.</p>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:12px;margin-top:20px">${cards}</div>
<h2>By chain</h2>
<div class="more">${LISTS.filter((l) => !l.main).map((l) => `<a href="/top/${l.slug}/">${esc(l.h1)}<span>Updated every 30 minutes</span></a>`).join("")}</div>
</main>`;
  return shell({ title, description, canonical, ld, body });
}
