// Forum pages, rendered on Cloudflare as complete HTML: search engines and AI
// crawlers get every word without running JavaScript. A small script
// (/forum.js) adds posting, likes and moderation for people.

import { GENERAL, SITE, boardSlug, boardUrl, coinFromSlug, fmtShare, pub, q, shortAddr, slugify, threadUrl } from "./forum-core.js";

const TARGET_USD_DEFAULT = 5; // testnet graduation target; set TARGET_USD on Cloudflare for mainnet
const THREADS_PER_PAGE = 25;
const POSTS_PER_PAGE = 50;
const CHAIN_NAMES = { 46630: "Robinhood Chain", 4663: "Robinhood Chain", 84532: "Base", 8453: "Base", 97: "BNB Chain", 56: "BNB Chain" };
const NATIVE = { 97: "BNB", 56: "BNB" };
const FEE_MODES = ["goes to the coin's creator", "buys the coin back and burns it", "is shared with the coin's holders"];
const COIN_COLS = "id,creator,launch_key,name,symbol,logo,description,created_at,graduated_chain,fee_mode,curves,holders_total,trades_24h,change_24h,last_trade_at";

// ------------------------------------------------------------------ small helpers

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const jsonLd = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
const iso = (d) => new Date(d).toISOString();
const plain = (s) => String(s || "").replace(/\s+/g, " ").trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);

function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<>"']+/g, (u) => {
    const trimmed = u.replace(/[.,;:!?)]+$/, "");
    const rest = u.slice(trimmed.length);
    return `<a href="${trimmed}" rel="nofollow ugc noopener" target="_blank">${trimmed}</a>${rest}`;
  });
}

function ago(d) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
const timeTag = (d) => `<time datetime="${iso(d)}">${ago(d)}</time>`;

function money(v) {
  if (v === null || !Number.isFinite(v)) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(v < 10 ? 2 : 0)}`;
}

function isImage(s) {
  return /^https:\/\/\S+$/i.test(s || "") || /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s || "");
}

function avatar(coin, size = 44) {
  if (coin && isImage(coin.logo) && !coin.logo.startsWith("data:")) {
    return `<img class="av" src="${esc(coin.logo)}" alt="" width="${size}" height="${size}" loading="lazy" style="width:${size}px;height:${size}px">`;
  }
  const letter = coin ? (coin.symbol || "?").slice(0, 1).toUpperCase() : "s";
  return `<span class="av" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px" aria-hidden="true">${esc(letter)}</span>`;
}
const userMark = (addr) => `<span class="av sm" aria-hidden="true">${esc(addr.slice(2, 4))}</span>`;

const cardImage = (env, id) => `${(env && env.SUPABASE_URL) || "https://rkoassatqhdkdptekvdt.supabase.co"}/storage/v1/object/public/cards/${id.replace(/[^0-9a-z]/g, "-")}.png`;

// ------------------------------------------------------------------ prices and coin facts

async function prices() {
  const out = { USD: 1 };
  await Promise.all(
    ["ETH", "BNB"].map(async (s) => {
      try {
        const r = await fetch(`https://api.coinbase.com/v2/prices/${s}-USD/spot`, { cf: { cacheTtl: 60, cacheEverything: true } });
        const p = Number((await r.json())?.data?.amount);
        if (Number.isFinite(p) && p > 0) out[s] = p;
      } catch {}
    })
  );
  return out;
}

function facts(coin, px, env) {
  const target = Number((env && env.TARGET_USD) || TARGET_USD_DEFAULT);
  const curves = Array.isArray(coin.curves) ? coin.curves : [];
  let mc = null;
  let open = 0;
  let priced = true;
  for (const k of curves) {
    const p = px[NATIVE[k.chain_id] || "ETH"];
    if (!p) {
      priced = false;
      continue;
    }
    if (k.state !== 1 && Number(k.virtual_token) > 0) {
      const v = (Number(k.virtual_native) / Number(k.virtual_token)) * 1e9 * p;
      if (mc === null || v > mc) mc = v;
    }
    if (k.state === 0) open += (Number(k.real_native) / 1e18) * p;
  }
  const chains = [...new Set(curves.map((k) => CHAIN_NAMES[k.chain_id]).filter(Boolean))];
  const graduated = coin.graduated_chain !== null && coin.graduated_chain !== undefined;
  return {
    mc,
    holders: Number(coin.holders_total || 0),
    chains,
    graduated,
    winner: graduated ? CHAIN_NAMES[coin.graduated_chain] || "one chain" : null,
    progress: graduated ? 1 : priced && target > 0 ? Math.min(1, open / target) : null,
    change: coin.change_24h === null || coin.change_24h === undefined ? null : Number(coin.change_24h),
  };
}

function faqItems(coin, f) {
  const sym = `$${coin.symbol}`;
  const created = new Date(coin.created_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const desc = plain(coin.description);
  return [
    [`What is ${coin.name} (${sym})?`, `${desc ? `${desc} ` : ""}${coin.name} is a meme coin launched on sasa on ${created}${f.chains.length ? `, on ${f.chains.join(" and ")}` : ""}.`],
    [`Which chains is ${sym} on?`, f.graduated ? `${sym} launched on ${f.chains.join(" and ")} and graduated on ${f.winner}, where it now trades in a locked pool.` : `${sym} is live on ${f.chains.join(" and ") || "sasa"} at the same time. Money on every chain counts toward one shared graduation target.`],
    [`Has ${sym} graduated?`, f.graduated ? `Yes. ${sym} graduated on ${f.winner}. Its liquidity is locked forever, so it can't be pulled.` : f.progress === null ? `Not yet. It is still on its bonding curves.` : `Not yet. Its bonding curves are ${Math.floor(f.progress * 100)}% of the way to the graduation target.`],
    [`What is ${sym}'s market cap?`, f.mc === null ? `The market cap shows up once prices load on the coin's page.` : `About ${money(f.mc)}, with ${f.holders} holder${f.holders === 1 ? "" : "s"}. Figures update from the chain.`],
    [`Where do ${sym}'s trading fees go?`, `Each trade pays a 1% fee. The creator's share ${FEE_MODES[Number(coin.fee_mode || 0)] || FEE_MODES[0]}. This was fixed when the coin was launched and can't be changed.`],
    [`How do I buy ${sym}?`, `Open ${coin.name} on sasa, log in with email, Google or a wallet, and tap Buy. Email users pay no network fees. Meme coins are risky; only use money you can afford to lose.`],
  ];
}

// ------------------------------------------------------------------ page frame

const CSS = `
:root{--mist:#0b0806;--paper:#110c09;--surface:#17110c;--line:#2a2019;--ink:#fff4ec;--ink2:#cdbbae;--ink3:#8f7f73;--acc:#ff6b1a;--acc-d:#e85a0c;--acc-soft:#2a170b;--on-acc:#1a0e05;--mint:#ffb020;--danger:#ef5b52;--up:#2fd39b;
--display:"Sora",ui-sans-serif,system-ui,sans-serif;--sans:"Instrument Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace;color-scheme:dark}
html[data-theme="light"]{--mist:#f7f3ef;--paper:#fdfbf9;--surface:#fff;--line:#e8dfd6;--ink:#1c140e;--ink2:#4d4239;--ink3:#8a7c70;--acc:#f2600c;--acc-d:#d65209;--acc-soft:#ffeadb;--on-acc:#fff;--mint:#d98a00;--danger:#d9443a;--up:#0f9d62;color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
@media (max-width:640px){html{font-size:14px}}
body{margin:0;background:var(--mist);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;padding-bottom:env(safe-area-inset-bottom,0px)}
a{color:inherit;text-decoration:none}
button,input,textarea{font:inherit;color:inherit}
input,textarea{font-size:16px}
button{cursor:pointer;background:none;border:0;padding:0}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.mono{font-family:var(--mono)}
.skip{position:absolute;left:-999px}.skip:focus{left:1rem;top:1rem;z-index:99;background:var(--surface);padding:.5rem 1rem;border-radius:.5rem}
header.top{position:sticky;top:0;z-index:40;background:color-mix(in srgb,var(--paper) 92%,transparent);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding-top:env(safe-area-inset-top,0px)}
.hbar{max-width:80rem;margin:0 auto;padding:0 1rem;height:4rem;display:flex;align-items:center;justify-content:space-between;gap:.75rem}
@media (min-width:640px){.hbar{padding:0 1.5rem}}
.logo{display:flex;align-items:center;gap:.6rem;font-family:var(--display);font-weight:700;font-size:1.375rem;letter-spacing:-.01em}
.nav{display:flex;gap:1rem;font-weight:500;font-size:.875rem;white-space:nowrap;min-width:0}.nav a:hover,.nav a[aria-current]{color:var(--acc)}
@media (min-width:1024px){.nav{gap:1.5rem;font-size:.9375rem}}@media (min-width:1280px){.nav{gap:1.75rem}}
@media (max-width:767px){.nav{display:none}}
.hr{display:flex;gap:.5rem;align-items:center}
.hbtn{position:relative;width:2.75rem;height:2.75rem;border-radius:1rem;border:1px solid var(--line);background:var(--surface);color:var(--ink2);display:flex;align-items:center;justify-content:center;box-shadow:0 1px 2px rgba(0,0,0,.04),0 6px 18px rgba(0,0,0,.06);cursor:pointer;flex-shrink:0}
.hbtn:hover{color:var(--ink);border-color:color-mix(in srgb,var(--acc) 60%,var(--line))}
html[data-theme="light"] .hbtn .i-sun,html:not([data-theme="light"]) .hbtn .i-moon{display:none}
.badge{position:absolute;top:-.375rem;right:-.375rem;min-width:1.15rem;height:1.15rem;padding:0 .25rem;border-radius:999px;background:var(--acc);color:var(--on-acc);font-size:.6875rem;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid var(--paper)}
.bellwrap{position:relative}
.bellpop{position:absolute;right:0;top:calc(100% + .5rem);width:min(22rem,calc(100vw - 2rem));background:var(--surface);border:1px solid var(--line);border-radius:1rem;box-shadow:0 18px 50px rgba(0,0,0,.35);overflow:hidden;z-index:50}
.bellpop h2{font-family:var(--display);font-size:1.0625rem;margin:0;padding:1rem 1rem .5rem}
.bellpop a.n{display:block;padding:.65rem 1rem;border-top:1px solid var(--line);font-size:.875rem}
.bellpop a.n:hover{background:var(--paper)}.bellpop a.n.u{font-weight:600}.bellpop a.n small{display:block;color:var(--ink3);font-weight:400;font-size:.75rem;margin-top:.15rem}
.bellpop .e{padding:1rem;color:var(--ink3);font-size:.875rem;border-top:1px solid var(--line)}
.bellpop .f{display:block;padding:.75rem 1rem;border-top:1px solid var(--line);color:var(--acc);font-weight:600;font-size:.8125rem}
.acct{height:2.75rem;display:flex;align-items:center;gap:.25rem;padding:0 .25rem;border-radius:1rem;background:var(--surface);border:1px solid var(--line);box-shadow:0 1px 2px rgba(0,0,0,.04),0 6px 18px rgba(0,0,0,.06);white-space:nowrap}
.acct:hover{border-color:color-mix(in srgb,var(--acc) 60%,var(--line))}
.acct .main{display:flex;align-items:center;gap:.5rem;height:2.25rem;padding:0 .4rem 0 .25rem}
.acct .ic{width:2rem;height:2rem;border-radius:.625rem;background:var(--acc-soft);color:var(--acc);display:none;align-items:center;justify-content:center}
@media (min-width:640px){.acct .ic{display:flex}}
.acct .v{display:flex;flex-direction:column;line-height:1;min-width:3.75rem}
.acct .v b{font-family:var(--mono);font-size:.9375rem;font-weight:700;letter-spacing:-.01em}
.acct .v small{font-size:.6875rem;color:var(--ink3);margin-top:.25rem}.acct .v small em{font-style:normal;font-family:var(--mono);color:var(--up);font-weight:600}
.acct .addr{font-family:var(--mono);font-size:.875rem;padding:0 .35rem}
.acct .plus{width:2rem;height:2rem;border-radius:.625rem;background:var(--acc);color:var(--on-acc);display:flex;align-items:center;justify-content:center}
.acct.login{background:var(--ink);color:var(--mist);font-weight:600;border:0;padding:0 1.1rem;box-shadow:none}
.wrap{max-width:52rem;margin:0 auto;padding:1.25rem 1rem 4rem}
.crumbs{font-size:.8125rem;color:var(--ink3);display:flex;flex-wrap:wrap;gap:.35rem;margin:0;padding:0;list-style:none}
.crumbs a{color:var(--acc);font-weight:600}
.crumbs li+li::before{content:"/";margin-right:.35rem;color:var(--ink3)}
h1{font-family:var(--display);font-weight:700;letter-spacing:-.02em;margin:.6rem 0 0;font-size:1.75rem;line-height:1.15;overflow-wrap:anywhere}
@media (min-width:640px){h1{font-size:2.25rem}}
.lead{color:var(--ink2);margin:.6rem 0 0;line-height:1.6;max-width:42rem}
.lead a,.inline a{color:var(--acc);font-weight:600}
.card{background:var(--surface);border:1px solid var(--line);border-radius:1rem;overflow:hidden}
.sect{margin-top:1.75rem}
.sect>h2{font-family:var(--display);font-weight:600;font-size:1.125rem;margin:0 0 .6rem}
.row{display:flex;align-items:center;gap:.75rem;padding:.85rem 1rem;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
a.row:hover{background:var(--paper)}
.av{border-radius:.8rem;display:inline-flex;align-items:center;justify-content:center;font-family:var(--display);font-weight:600;flex-shrink:0;background:var(--acc-soft);color:var(--acc-d);object-fit:cover}
.av.sm{width:2rem;height:2rem;border-radius:.6rem;font-size:.8rem}
.t{font-weight:600;font-size:.9375rem;line-height:1.35;overflow-wrap:anywhere}
.s{color:var(--ink3);font-size:.8125rem;margin-top:.15rem}
.grow{flex:1;min-width:0}
.num{font-family:var(--mono);font-size:.8125rem;color:var(--ink2);text-align:right;white-space:nowrap}
.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem;margin:1rem 0 0;padding:0}
@media (min-width:640px){.facts{grid-template-columns:repeat(4,minmax(0,1fr))}}
.fact{background:var(--paper);border:1px solid var(--line);border-radius:.9rem;padding:.7rem .85rem;margin:0}
.fact dt{color:var(--ink3);font-size:.75rem}
.fact dd{font-family:var(--mono);margin:.15rem 0 0;overflow-wrap:anywhere}
.up{color:var(--up)}.down{color:var(--danger)}
.btn{height:2.75rem;padding:0 1.1rem;border-radius:.8rem;background:var(--acc);color:var(--on-acc);font-weight:700;display:inline-flex;align-items:center;justify-content:center;gap:.4rem;white-space:nowrap}
.btn:hover{background:var(--acc-d)}.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--ink);font-weight:600}
.bar{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-top:1.25rem;flex-wrap:wrap}
.tabs{display:flex;gap:.25rem;background:var(--paper);border:1px solid var(--line);border-radius:.9rem;padding:.25rem}
.tabs a{height:2.1rem;padding:0 .8rem;border-radius:.6rem;font-weight:600;font-size:.8125rem;color:var(--ink2);display:flex;align-items:center}
.tabs a[aria-current]{background:var(--surface);color:var(--ink);box-shadow:0 0 0 1px var(--line)}
.pill{display:inline-flex;align-items:center;gap:.3rem;height:1.35rem;padding:0 .5rem;border-radius:999px;font-size:.6875rem;font-weight:700;background:var(--acc-soft);color:var(--acc);white-space:nowrap;flex-shrink:0}
.pill.creator{background:color-mix(in srgb,var(--mint) 18%,transparent);color:var(--mint)}
.pill.pin{background:var(--paper);color:var(--ink2);border:1px solid var(--line)}
@media (max-width:479px){.wide{display:none}}
.post{padding:1rem 1.1rem;border-top:1px solid var(--line);scroll-margin-top:5rem}
.post:first-child{border-top:0}
.post:target{background:color-mix(in srgb,var(--acc) 7%,transparent)}
.phead{display:flex;align-items:center;gap:.5rem;min-width:0}
.who{font-family:var(--mono);font-size:.8125rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.when{color:var(--ink3);font-size:.75rem;white-space:nowrap;flex-shrink:0}
.body{margin-top:.6rem;line-height:1.65;font-size:.9688rem;white-space:pre-wrap;overflow-wrap:anywhere}
.body a{color:var(--acc);text-decoration:underline}
.op .body{font-size:1.03rem}
.pacts{display:flex;gap:1rem;margin-top:.6rem;font-size:.8125rem;color:var(--ink3);align-items:center}
.pacts button:hover{color:var(--ink)}
.pacts .liked{color:var(--acc)}
.hidden-post{color:var(--ink3);font-style:italic;font-size:.875rem}
.menu{position:relative;margin-left:auto;flex-shrink:0}
.menu>button{width:2rem;height:2rem;border-radius:.6rem;color:var(--ink3)}
.menu-list{position:absolute;right:0;top:100%;margin-top:.3rem;background:var(--surface);border:1px solid var(--line);border-radius:.8rem;box-shadow:0 12px 30px rgba(0,0,0,.35);min-width:10rem;z-index:10;overflow:hidden}
.menu-list button{display:block;width:100%;text-align:left;padding:.65rem .9rem;font-size:.875rem}
.menu-list button:hover{background:var(--paper)}
.menu-list .danger{color:var(--danger)}
textarea,.inp{width:100%;background:var(--paper);border:1px solid var(--line);border-radius:.9rem;padding:.8rem .9rem;resize:vertical;outline:none}
textarea:focus,.inp:focus{border-color:var(--acc)}
.count{font-size:.75rem;color:var(--ink3);text-align:right;margin-top:.3rem}
.gate{background:var(--paper);border:1px dashed var(--line);border-radius:1rem;padding:1rem;color:var(--ink2);font-size:.9rem;line-height:1.5}
.gate b{color:var(--ink)}
.faq details{border-top:1px solid var(--line);padding:.85rem 1rem}
.faq details:first-child{border-top:0}
.faq summary{font-weight:600;cursor:pointer;list-style:none;display:flex;justify-content:space-between;gap:1rem}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";color:var(--ink3);font-weight:400}
.faq details[open] summary::after{content:"−"}
.faq p{margin:.5rem 0 0;color:var(--ink2);line-height:1.6;font-size:.9rem}
.note{margin-top:.75rem;font-size:.75rem;color:var(--ink3)}
.pager{display:flex;justify-content:space-between;gap:1rem;margin-top:1rem}
.pager a{color:var(--acc);font-weight:600}
.scrim{position:fixed;inset:0;z-index:50;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.6)}
@media (min-width:640px){.scrim{align-items:center}}
.sheet{width:100%;max-height:90dvh;overflow-y:auto;background:var(--surface);border-radius:1.5rem 1.5rem 0 0;padding:1.5rem 1.5rem calc(env(safe-area-inset-bottom,0px) + 1rem)}
@media (min-width:640px){.sheet{max-width:34rem;border-radius:1.5rem}}
.sh{display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;gap:1rem}
.sh h2{font-family:var(--display);font-size:1.375rem;font-weight:600;margin:0}
.x{width:2.5rem;height:2.5rem;margin-right:-.5rem;border-radius:999px;color:var(--ink3);font-size:1.625rem;line-height:1}
.lbl{font-weight:600;font-size:.875rem;margin:.9rem 0 .4rem;display:block}
.hint{font-size:.8125rem;color:var(--ink2);margin-top:.4rem}
.hint.err{color:var(--danger)}
.toast{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 1.25rem);z-index:70;background:var(--ink);color:var(--mist);font-weight:600;font-size:.875rem;padding:.75rem 1.1rem;border-radius:.9rem;max-width:calc(100vw - 2rem)}
footer.foot{border-top:1px solid var(--line);background:var(--paper)}
footer.foot .in{max-width:52rem;margin:0 auto;padding:1.75rem 1rem 2.5rem;font-size:.8125rem;color:var(--ink2);line-height:1.6}
footer.foot nav{display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;margin-top:.75rem}
footer.foot nav a{color:var(--acc);font-weight:600}
[hidden]{display:none!important}
`;

const LOGO = `<svg width="32" height="32" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="24" fill="#1A130D"/><path d="M26 60 L50 38 L74 60" fill="none" stroke="#FFB020" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/><path d="M26 80 L50 58 L74 80" fill="none" stroke="#FF6B1A" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/><circle cx="50" cy="22" r="6" fill="#FFB020"/></svg>`;
const THEME = `try{var t=localStorage.getItem("sasa-theme");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

function page({ title, description, path, robots = "index,follow", image, ld = [], body, data = {}, prev, next }) {
  const url = `${SITE}${path}`;
  const img = image || `${SITE}/og.png`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${robots},max-image-preview:large,max-snippet:-1">
<link rel="canonical" href="${esc(url)}">
${prev ? `<link rel="prev" href="${esc(SITE + prev)}">` : ""}${next ? `<link rel="next" href="${esc(SITE + next)}">` : ""}
<link rel="alternate" type="application/rss+xml" title="sasa forum" href="${SITE}/forum/feed.xml">
<meta property="og:type" content="website">
<meta property="og:site_name" content="sasa">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(img)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@sasapadfun">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(img)}">
<meta name="theme-color" content="#0b0806">
<link rel="icon" href="/sasa-icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" media="print" onload="this.media='all'" href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=Instrument+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<script>${THEME}</script>
<style>${CSS}</style>
${ld.map(jsonLd).join("\n")}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="hbar">
<a class="logo" href="/explore/">${LOGO}sasa</a>
<nav class="nav" aria-label="Main"><a href="/explore/">Explore</a><a href="/terminal/">Terminal</a><a href="/create/">Create a coin</a><a href="/me/">Your coins</a><a href="/traders/">Traders</a><a href="/copy/">Copy</a><a href="/forum/" aria-current="page">Forum</a><a href="/stats/">Stats</a></nav>
<div class="hr"><button class="hbtn" id="themeBtn" type="button" aria-label="Switch theme"><svg class="i-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><svg class="i-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button><div class="bellwrap" id="bellWrap" hidden><button class="hbtn" id="bellBtn" type="button" aria-label="Notifications" aria-expanded="false"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg><span class="badge" id="bellBadge" hidden></span></button><div class="bellpop" id="bellPop" role="dialog" aria-label="Notifications" hidden></div></div><div class="acct login" id="acct"><a class="main" href="/login/?next=${encodeURIComponent(path)}">Log in</a></div></div>
</div></header>
<main id="main" class="wrap">
${body}
</main>
<footer class="foot"><div class="in">
Meme coins are risky and can lose all their value. Posts are written by users and are not financial advice. Only holders of a coin can post on its board.
<nav aria-label="Footer"><a href="/forum/">Forum</a><a href="/forum/sasa/">sasa news &amp; help</a><a href="/learn/">Learn</a><a href="/how-it-works/">How it works</a><a href="/stats/">Stats</a><a href="https://x.com/sasapadfun" rel="noopener">X</a></nav>
</div></footer>
<script id="forum-data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script src="/forum.js?v=37" defer></script>
</body>
</html>`;
}

function crumbs(items) {
  const html = `<nav aria-label="Breadcrumb"><ol class="crumbs">${items
    .map((it, i) => `<li>${i < items.length - 1 ? `<a href="${esc(it[1])}">${esc(it[0])}</a>` : `<span aria-current="page">${esc(it[0])}</span>`}</li>`)
    .join("")}</ol></nav>`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it[0], item: `${SITE}${it[1]}` })),
  };
  return { html, ld };
}

// ------------------------------------------------------------------ pieces

function boardName(coin) {
  return coin ? `${coin.name} ($${coin.symbol})` : "sasa news & help";
}

function threadRow(t, coin, showBoard) {
  const board = coin || GENERAL;
  const replies = Number(t.reply_count || 0);
  return `<a class="row" href="${esc(threadUrl(board, t))}">${userMark(t.author)}<div class="grow"><div class="t">${t.pinned ? '<span class="pill pin">Pinned</span> ' : ""}${esc(t.title)}</div><div class="s">${showBoard ? `${esc(boardName(coin))} · ` : ""}by <span class="mono">${esc(shortAddr(t.author))}</span> · ${timeTag(t.last_post_at)}</div></div><div class="num">${replies} ${replies === 1 ? "reply" : "replies"}</div></a>`;
}

function badges(p, coin) {
  let out = "";
  if (coin && p.author === coin.creator) out += '<span class="pill creator">Creator</span>';
  if (p.share_bps > 0) out += `<span class="pill" title="Held ${fmtShare(p.share_bps)} of the supply when posting"><span class="wide">Holder </span>${fmtShare(p.share_bps)}</span>`;
  return out;
}

function postHtml(p, coin, isOp) {
  if (p.hidden) {
    const why = p.hidden === "self" ? "Deleted by the author." : p.hidden === "reports" ? "Hidden after reports. A moderator will review it." : "Hidden by a moderator.";
    return `<article class="post" id="p${p.id}" data-post="${p.id}" data-author="${esc(p.author)}" data-hidden="${esc(p.hidden)}"><div class="phead">${userMark(p.author)}<span class="hidden-post">${why}</span><div class="menu" data-menu></div></div></article>`;
  }
  return `<article class="post${isOp ? " op" : ""}" id="p${p.id}" data-post="${p.id}" data-author="${esc(p.author)}"><div class="phead">${userMark(p.author)}<span class="who">${esc(shortAddr(p.author))}</span>${badges(p, coin)}<a class="when" href="#p${p.id}">${timeTag(p.created_at)}</a><div class="menu" data-menu></div></div><div class="body">${linkify(p.body)}</div><div class="pacts"><button type="button" data-like aria-pressed="false" aria-label="Like">▲ <span>${Number(p.like_count || 0)}</span></button><button type="button" data-reply>Reply</button></div></article>`;
}

// ------------------------------------------------------------------ pages

export async function renderHome(env, fresh) {
  const [boards, latest, active] = await Promise.all([
    pub(env, "forum_boards_public?select=board,threads,last_post_at&order=last_post_at.desc&limit=60", { fresh }),
    pub(env, "forum_threads_public?select=id,board,title,author,last_post_at,reply_count,pinned&order=last_post_at.desc&limit=20", { fresh }),
    pub(env, `coin_list?select=${COIN_COLS}&order=last_trade_at.desc.nullslast&limit=40`, { fresh }),
  ]);
  const byId = new Map(active.map((c) => [c.id, c]));
  const missing = [...new Set([...boards.map((b) => b.board), ...latest.map((t) => t.board)])].filter((id) => id !== GENERAL && !byId.has(id));
  if (missing.length) {
    const more = await pub(env, `coin_list?select=${COIN_COLS}&id=in.(${missing.map((m) => `"${m}"`).join(",")})`, { fresh });
    for (const c of more) byId.set(c.id, c);
  }
  const counts = new Map(boards.map((b) => [b.board, b]));
  const px = await prices();
  const general = counts.get(GENERAL);
  const coinBoards = [...byId.values()].sort((a, b) => {
    const la = counts.get(a.id)?.last_post_at || a.last_trade_at || a.created_at;
    const lb = counts.get(b.id)?.last_post_at || b.last_trade_at || b.created_at;
    return new Date(lb) - new Date(la);
  });

  const c = crumbs([["sasa", "/terminal/"], ["Forum", "/forum/"]]);
  const body = `${c.html}
<h1>sasa forum</h1>
<p class="lead">Talk about meme coins launched on sasa, the multi-chain launchpad. Every coin has its own board where only its holders can post, so you hear from people with skin in the game. Anyone can read.</p>
<section class="sect" aria-labelledby="h-general"><h2 id="h-general">News &amp; help</h2><div class="card">
<a class="row" href="/forum/sasa/">${avatar(null)}<div class="grow"><div class="t">sasa news &amp; help</div><div class="s">Questions about launching, trading and the chains sasa runs on</div></div><div class="num">${general ? general.threads : 0} threads</div></a>
</div></section>
<section class="sect" aria-labelledby="h-latest"><h2 id="h-latest">Latest discussions</h2><div class="card">${
    latest.length ? latest.map((t) => threadRow(t, t.board === GENERAL ? null : byId.get(t.board), true)).join("") : '<p class="row s">No threads yet. Open any coin board and start the first one.</p>'
  }</div></section>
<section class="sect" aria-labelledby="h-boards"><h2 id="h-boards">Coin boards</h2><div class="card">${coinBoards
    .map((coin) => {
      const f = facts(coin, px, env);
      const n = counts.get(coin.id)?.threads || 0;
      return `<a class="row" href="${esc(boardUrl(coin))}">${avatar(coin)}<div class="grow"><div class="t">${esc(coin.name)} ($${esc(coin.symbol)})</div><div class="s">Market cap ${money(f.mc)} · ${f.holders} ${f.holders === 1 ? "holder" : "holders"}${f.chains.length ? ` · ${esc(f.chains.join(", "))}` : ""}</div></div><div class="num">${n} ${n === 1 ? "thread" : "threads"}</div></a>`;
    })
    .join("")}</div></section>`;

  const ld = [
    c.ld,
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "sasa forum",
      url: `${SITE}/forum/`,
      description: "Discussion boards for meme coins launched on sasa, the multi-chain launchpad.",
      isPartOf: { "@type": "WebSite", name: "sasa", url: SITE },
    },
  ];
  return page({
    title: "sasa forum: meme coin discussions from real holders",
    description: "Discuss meme coins launched on sasa. Every coin has a board where only its holders can post. Market caps, chains and graduation status update from the chain.",
    path: "/forum/",
    ld,
    body,
    data: { page: "home" },
  });
}

export async function renderBoard(env, slug, url, fresh) {
  const general = slug === GENERAL;
  let coin = null;
  if (!general) {
    coin = await coinFromSlug(env, slug);
    if (!coin) return null;
    const rows = await pub(env, `coin_list?select=${COIN_COLS}&id=eq.${q(coin.id)}`, { fresh });
    coin = rows[0] || { ...coin, curves: [], holders_total: 0 };
    if (boardSlug(coin) !== slug) return { redirect: boardUrl(coin) };
  }
  const board = general ? GENERAL : coin.id;
  const sort = ["new", "top"].includes(url.searchParams.get("sort")) ? url.searchParams.get("sort") : "active";
  const pageNo = Math.max(1, Math.min(1000, Number(url.searchParams.get("page")) || 1));
  const order = sort === "new" ? "pinned.desc,created_at.desc" : sort === "top" ? "pinned.desc,like_count.desc,reply_count.desc" : "pinned.desc,last_post_at.desc";
  const { data: threads, total } = await pub(
    env,
    `forum_threads_public?board=eq.${q(board)}&select=id,board,title,author,created_at,last_post_at,reply_count,like_count,pinned&order=${order}&offset=${(pageNo - 1) * THREADS_PER_PAGE}&limit=${THREADS_PER_PAGE}`,
    { fresh, count: true }
  );
  const pages = Math.max(1, Math.ceil(total / THREADS_PER_PAGE));
  if (pageNo > pages && pageNo > 1) return { redirect: general ? "/forum/sasa/" : boardUrl(coin) };
  const base = general ? "/forum/sasa/" : boardUrl(coin);
  const path = pageNo > 1 ? `${base}?page=${pageNo}` : base;
  const c = crumbs([["sasa", "/terminal/"], ["Forum", "/forum/"], [general ? "News & help" : coin.name, base]]);

  let head, factsHtml = "", faqHtml = "", ldExtra = [], description, title;
  if (general) {
    title = "sasa news & help forum";
    description = "Questions and answers about launching and trading meme coins on sasa: bonding curves, graduation, fees, chains and wallets.";
    head = `<div style="display:flex;gap:.9rem;align-items:center;margin-top:.8rem">${avatar(null, 48)}<h1 style="margin:0">sasa news &amp; help</h1></div><p class="lead">Questions about launching and trading on sasa, the chains it runs on, and ideas for what to build next. Anyone with a sasa account can post here.</p>`;
  } else {
    const px = await prices();
    const f = facts(coin, px, env);
    const sym = `$${coin.symbol}`;
    const desc = plain(coin.description);
    title = `${coin.name} (${sym}) forum: news, price talk and holders`;
    description = clip(
      `${coin.name} (${sym}) community forum on sasa. ${f.mc !== null ? `Market cap ${money(f.mc)}, ` : ""}${f.holders} ${f.holders === 1 ? "holder" : "holders"}, ${f.graduated ? `graduated on ${f.winner}` : `on ${f.chains.join(" and ") || "sasa"}`}. ${desc}`,
      158
    );
    const change = f.change === null ? "—" : `<span class="${f.change >= 0 ? "up" : "down"}">${f.change >= 0 ? "+" : "−"}${Math.abs(f.change * 100).toFixed(1)}%</span>`;
    head = `<div style="display:flex;gap:.9rem;align-items:center;margin-top:.8rem">${avatar(coin, 48)}<h1 style="margin:0">${esc(coin.name)} (${esc(sym)}) forum</h1></div>
<p class="lead">${desc ? `${esc(desc)} ` : ""}Only ${esc(sym)} holders can post here. <a href="/coin/?id=${esc(encodeURIComponent(coin.id))}">Trade ${esc(sym)} on sasa</a></p>`;
    factsHtml = `<dl class="facts">
<div class="fact"><dt>Market cap</dt><dd>${money(f.mc)}</dd></div>
<div class="fact"><dt>24h</dt><dd>${change}</dd></div>
<div class="fact"><dt>Holders</dt><dd>${f.holders}</dd></div>
<div class="fact"><dt>${f.graduated ? "Graduated on" : "Graduation"}</dt><dd>${f.graduated ? esc(f.winner) : f.progress === null ? "—" : `${Math.floor(f.progress * 100)}%`}</dd></div>
</dl>`;
    const faq = faqItems(coin, f);
    faqHtml = `<section class="sect faq" aria-labelledby="h-about"><h2 id="h-about">About ${esc(sym)}</h2><div class="card">${faq
      .map((x, i) => `<details${i === 0 ? " open" : ""}><summary>${esc(x[0])}</summary><p>${esc(x[1])}</p></details>`)
      .join("")}</div><p class="note">Figures come from the chain and refresh every few minutes. Created by <span class="mono">${esc(shortAddr(coin.creator))}</span>. Nothing here is financial advice.</p></section>`;
    ldExtra = [
      { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map((x) => ({ "@type": "Question", name: x[0], acceptedAnswer: { "@type": "Answer", text: x[1] } })) },
    ];
  }

  const tab = (key, label) => `<a href="${base}${key === "active" ? "" : `?sort=${key}`}"${sort === key ? ' aria-current="true"' : ""} rel="nofollow">${label}</a>`;
  const listHtml = threads.length
    ? threads.map((t) => threadRow(t, coin, false)).join("")
    : `<p class="row s" style="margin:0">No threads yet. ${general ? "Ask the first question." : `Hold ${esc("$" + coin.symbol)}? Start the first thread.`}</p>`;
  const pager =
    pages > 1
      ? `<nav class="pager" aria-label="Pages">${pageNo > 1 ? `<a href="${base}${pageNo > 2 ? `?page=${pageNo - 1}` : ""}">← Newer</a>` : "<span></span>"}<span class="s">Page ${pageNo} of ${pages}</span>${pageNo < pages ? `<a href="${base}?page=${pageNo + 1}">Older →</a>` : "<span></span>"}</nav>`
      : "";

  const body = `${c.html}
${head}
${factsHtml}
<div class="bar"><div class="tabs" role="navigation" aria-label="Sort threads">${tab("active", "Active")}${tab("new", "New")}${tab("top", "Top")}</div><button class="btn" type="button" id="newThread">New thread</button></div>
<section class="sect" style="margin-top:.75rem" aria-label="Threads"><div class="card">${listHtml}</div>${pager}</section>
${faqHtml}`;

  const ld = [
    c.ld,
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: title,
      url: `${SITE}${path}`,
      description,
      isPartOf: { "@type": "WebSite", name: "sasa", url: SITE },
      ...(threads.length
        ? { mainEntity: { "@type": "ItemList", itemListElement: threads.map((t, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}${threadUrl(coin || GENERAL, t)}`, name: t.title })) } }
        : {}),
    },
    ...ldExtra,
  ];
  return {
    html: page({
      title: pageNo > 1 ? `${title} (page ${pageNo})` : title,
      description,
      path,
      robots: sort !== "active" ? "noindex,follow" : "index,follow",
      image: coin ? cardImage(env, coin.id) : undefined,
      ld,
      body,
      prev: pageNo > 1 ? (pageNo > 2 ? `${base}?page=${pageNo - 1}` : base) : null,
      next: pageNo < pages ? `${base}?page=${pageNo + 1}` : null,
      data: { page: "board", board, boardName: general ? "sasa" : `$${coin.symbol}`, symbol: coin ? coin.symbol : null, coinUrl: coin ? `/coin/?id=${encodeURIComponent(coin.id)}` : null },
    }),
  };
}

export async function renderThread(env, slug, threadPart, url, fresh) {
  const m = /^(\d{1,15})(?:-[a-z0-9-]*)?$/.exec(threadPart);
  if (!m) return null;
  const id = m[1];
  const rows = await pub(env, `forum_threads_public?id=eq.${id}&select=id,board,title,author,created_at,last_post_at,reply_count,like_count,words,pinned`, { fresh });
  const t = rows[0];
  if (!t) return null;
  const general = t.board === GENERAL;
  let coin = null;
  if (!general) {
    const c = await pub(env, `coin_list?select=${COIN_COLS}&id=eq.${q(t.board)}`, { fresh });
    coin = c[0] || null;
    if (!coin) return null;
  }
  const canonicalBase = threadUrl(coin || GENERAL, t);
  const pageNo = Math.max(1, Math.min(1000, Number(url.searchParams.get("page")) || 1));
  if (url.pathname !== canonicalBase) return { redirect: canonicalBase + (pageNo > 1 ? `?page=${pageNo}` : "") };

  const { data: posts, total } = await pub(
    env,
    `forum_posts_public?thread_id=eq.${id}&select=id,author,body,share_bps,created_at,like_count,hidden&order=id.asc&offset=${(pageNo - 1) * POSTS_PER_PAGE}&limit=${POSTS_PER_PAGE}`,
    { fresh, count: true }
  );
  if (!posts.length) return null;
  const pages = Math.max(1, Math.ceil(total / POSTS_PER_PAGE));
  const path = pageNo > 1 ? `${canonicalBase}?page=${pageNo}` : canonicalBase;
  const op = pageNo === 1 ? posts[0] : (await pub(env, `forum_posts_public?thread_id=eq.${id}&select=id,author,body,created_at,like_count,hidden&order=id.asc&limit=1`, { fresh }))[0];
  const boardBase = general ? "/forum/sasa/" : boardUrl(coin);
  const c = crumbs([["sasa", "/terminal/"], ["Forum", "/forum/"], [general ? "News & help" : coin.name, boardBase], [t.title, canonicalBase]]);
  const replies = Number(t.reply_count || 0);
  const opText = op && !op.hidden ? plain(op.body) : "";
  const description = clip(opText || `${t.title}. A discussion on the ${boardName(coin)} forum on sasa.`, 158);
  // Short, unanswered threads stay out of search until they have substance.
  const thin = replies === 0 && Number(t.words || 0) < 40;

  const related = await pub(
    env,
    `forum_threads_public?board=eq.${q(t.board)}&id=neq.${id}&select=id,board,title,author,last_post_at,reply_count,pinned&order=last_post_at.desc&limit=5`,
    { fresh }
  );

  const coinLine = coin
    ? (() => {
        return ` · <a href="/coin/?id=${esc(encodeURIComponent(coin.id))}">Trade $${esc(coin.symbol)}</a>`;
      })()
    : "";
  const pager =
    pages > 1
      ? `<nav class="pager" aria-label="Pages">${pageNo > 1 ? `<a href="${canonicalBase}${pageNo > 2 ? `?page=${pageNo - 1}` : ""}">← Earlier</a>` : "<span></span>"}<span class="s">Page ${pageNo} of ${pages}</span>${pageNo < pages ? `<a href="${canonicalBase}?page=${pageNo + 1}">Later →</a>` : "<span></span>"}</nav>`
      : "";

  const body = `${c.html}
<h1>${esc(t.title)}</h1>
<p class="s inline" style="margin-top:.45rem">${replies} ${replies === 1 ? "reply" : "replies"} · started ${timeTag(t.created_at)} in <a href="${esc(boardBase)}">${esc(boardName(coin))}</a>${coinLine}</p>
<div class="card" style="margin-top:1rem">${posts.map((p, i) => postHtml(p, coin, pageNo === 1 && i === 0)).join("")}</div>
${pager}
<section class="sect" id="replyArea" aria-label="Reply"><div class="gate"><b>Log in to reply.</b> Anyone can read; replying needs a sasa account${coin ? ` and some $${esc(coin.symbol)}` : ""}.</div></section>
${related.length ? `<section class="sect" aria-labelledby="h-more"><h2 id="h-more">More in ${esc(boardName(coin))}</h2><div class="card">${related.map((r) => threadRow(r, coin, false)).join("")}</div></section>` : ""}`;

  const visible = posts.filter((p) => !p.hidden);
  const person = (a) => ({ "@type": "Person", name: shortAddr(a), identifier: a });
  const ld = [
    c.ld,
    {
      "@context": "https://schema.org",
      "@type": "DiscussionForumPosting",
      "@id": `${SITE}${canonicalBase}#thread`,
      mainEntityOfPage: `${SITE}${path}`,
      url: `${SITE}${canonicalBase}`,
      headline: t.title,
      ...(opText ? { text: opText } : {}),
      author: person(t.author),
      datePublished: iso(t.created_at),
      dateModified: iso(t.last_post_at),
      isPartOf: { "@type": "WebPage", name: `${boardName(coin)} forum`, url: `${SITE}${boardBase}` },
      ...(coin ? { about: { "@type": "Thing", name: `${coin.name} ($${coin.symbol})`, url: `${SITE}${boardBase}` } } : {}),
      commentCount: replies,
      interactionStatistic: [
        { "@type": "InteractionCounter", interactionType: "https://schema.org/LikeAction", userInteractionCount: Number(t.like_count || 0) },
        { "@type": "InteractionCounter", interactionType: "https://schema.org/CommentAction", userInteractionCount: replies },
      ],
      comment: visible
        .filter((p) => !(pageNo === 1 && op && p.id === op.id))
        .map((p) => ({
          "@type": "Comment",
          url: `${SITE}${path}#p${p.id}`,
          text: plain(p.body),
          datePublished: iso(p.created_at),
          author: person(p.author),
          interactionStatistic: { "@type": "InteractionCounter", interactionType: "https://schema.org/LikeAction", userInteractionCount: Number(p.like_count || 0) },
        })),
    },
  ];

  return {
    html: page({
      title: `${t.title} · ${coin ? `$${coin.symbol}` : "sasa"} forum`,
      description,
      path,
      robots: thin ? "noindex,follow" : "index,follow",
      image: coin ? cardImage(env, coin.id) : undefined,
      ld,
      body,
      prev: pageNo > 1 ? (pageNo > 2 ? `${canonicalBase}?page=${pageNo - 1}` : canonicalBase) : null,
      next: pageNo < pages ? `${canonicalBase}?page=${pageNo + 1}` : null,
      data: {
        page: "thread",
        board: t.board,
        boardName: coin ? `$${coin.symbol}` : "sasa",
        symbol: coin ? coin.symbol : null,
        coinUrl: coin ? `/coin/?id=${encodeURIComponent(coin.id)}` : null,
        thread: Number(t.id),
        threadAuthor: t.author,
        firstPost: op ? Number(op.id) : null,
        creator: coin ? coin.creator : null,
        pinned: !!t.pinned,
      },
    }),
  };
}

export function renderNotFound() {
  return page({
    title: "Not found · sasa forum",
    description: "This forum page doesn't exist or was removed.",
    path: "/forum/",
    robots: "noindex,follow",
    body: `<h1>This page is gone</h1><p class="lead">The thread may have been deleted by its author or hidden by a moderator. <a href="/forum/">Back to the forum</a></p>`,
    data: { page: "missing" },
  });
}

// ------------------------------------------------------------------ sitemap and feed

export async function renderSitemap(env) {
  const [coins, threads] = await Promise.all([
    pub(env, "coin_list?select=id,name,symbol,launch_key,last_trade_at,created_at&order=last_trade_at.desc.nullslast&limit=5000"),
    pub(env, "forum_threads_public?select=id,board,title,last_post_at,reply_count,words&order=last_post_at.desc&limit=20000"),
  ]);
  const byId = new Map(coins.map((c) => [c.id, c]));
  const boardLast = new Map();
  for (const t of threads) if (!boardLast.has(t.board)) boardLast.set(t.board, t.last_post_at);
  const urls = [`<url><loc>${SITE}/forum/</loc>${threads[0] ? `<lastmod>${iso(threads[0].last_post_at)}</lastmod>` : ""}</url>`];
  urls.push(`<url><loc>${SITE}/forum/sasa/</loc>${boardLast.get(GENERAL) ? `<lastmod>${iso(boardLast.get(GENERAL))}</lastmod>` : ""}</url>`);
  for (const c of coins) {
    const last = boardLast.get(c.id) || c.last_trade_at || c.created_at;
    urls.push(`<url><loc>${SITE}${esc(boardUrl(c))}</loc><lastmod>${iso(last)}</lastmod></url>`);
  }
  for (const t of threads) {
    if (Number(t.reply_count) === 0 && Number(t.words) < 40) continue; // same rule as noindex
    const coin = t.board === GENERAL ? GENERAL : byId.get(t.board);
    if (!coin) continue;
    urls.push(`<url><loc>${SITE}${esc(threadUrl(coin, t))}</loc><lastmod>${iso(t.last_post_at)}</lastmod></url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export async function renderFeed(env) {
  const threads = await pub(env, "forum_threads_public?select=id,board,title,author,created_at,reply_count&order=created_at.desc&limit=50");
  const ids = [...new Set(threads.map((t) => t.board).filter((b) => b !== GENERAL))];
  const coins = ids.length ? await pub(env, `coins?select=id,name,symbol,launch_key&id=in.(${ids.map((i) => `"${i}"`).join(",")})`) : [];
  const byId = new Map(coins.map((c) => [c.id, c]));
  const items = threads
    .map((t) => {
      const coin = t.board === GENERAL ? GENERAL : byId.get(t.board);
      if (!coin) return "";
      const link = `${SITE}${threadUrl(coin, t)}`;
      const where = coin === GENERAL ? "sasa news & help" : `${coin.name} ($${coin.symbol})`;
      return `<item><title>${esc(t.title)}</title><link>${esc(link)}</link><guid isPermaLink="true">${esc(link)}</guid><pubDate>${new Date(t.created_at).toUTCString()}</pubDate><category>${esc(where)}</category><description>${esc(`${where} forum · ${t.reply_count} replies`)}</description></item>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>sasa forum</title><link>${SITE}/forum/</link><description>New threads on the sasa meme coin forum</description><language>en</language>\n${items}\n</channel></rss>\n`;
}

export { slugify };
