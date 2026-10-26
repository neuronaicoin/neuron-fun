/**
 * "On sasa today" for guide pages (/learn/<slug>/): today's real meme coin record from the daily
 * archive (day_pages, indexer/seopages.mjs), put into the static guide by functions/learn. It
 * links the guide to the day's pages, live lists and coins, and keeps every guide's content fresh.
 * The chain is picked from the guide's address (a Solana guide shows Solana). Pure: data in, HTML out.
 */
const SITE = "https://sasapad.fun";
const CHAINS = [
  { slug: "solana", network: "solana", name: "Solana", top: "solana", re: /solana/ },
  { slug: "base", network: "base", name: "Base", top: "base", re: /(^|-)base(-|$)/ },
  { slug: "bnb-chain", network: "bsc", name: "BNB Chain", top: "bnb-chain", re: /bnb/ },
  { slug: "robinhood-chain", network: "robinhood", name: "Robinhood Chain", top: "robinhood-chain", re: /robinhood/ },
  { slug: "arc", network: "arc", name: "Arc", top: "arc", re: /(^|-)arc(-|$)/ },
  { slug: "ethereum", network: "eth", name: "Ethereum", top: "ethereum", re: /ethereum/ },
];
const NAMES = Object.fromEntries(CHAINS.map((c) => [c.network, c.name]));
/** The chain a guide is about, from its slug; null for general guides. */
export const chainForSlug = (slug) => CHAINS.find((c) => c.re.test(String(slug))) || null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const t = (x) => x.replace(/\.?0+$/, "");
  if (n >= 1e9) return `$${t((n / 1e9).toFixed(2))}B`;
  if (n >= 999_950) return `$${t((n / 1e6).toFixed(2))}M`;
  if (n >= 1e3) return `$${t((n / 1e3).toFixed(1))}K`;
  return `$${n.toFixed(n < 10 ? 2 : 0)}`;
};
const pct = (v) => {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return "";
  const a = Math.abs(n);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${a >= 1000 ? `${(a / 1000).toFixed(1)}K` : a >= 100 ? a.toFixed(0) : a.toFixed(1)}%`;
};
const coinHref = (n, a) => (n === "solana" ? `${SITE}/x/solana/${encodeURIComponent(String(a))}/` : `${SITE}/x/${encodeURIComponent(n)}/${encodeURIComponent(String(a).toLowerCase())}/`);
const dateLabel = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

const CSS = `#learn-live .ll{border:1px solid var(--color-line,#eeebe7);background:var(--color-surface,#fff);border-radius:1.5rem;padding:1.25rem 1.25rem 1rem;margin-top:3rem;font-family:var(--font-sans,system-ui,sans-serif)}
#learn-live h2{font-family:var(--font-display,inherit);font-weight:700;font-size:1.25rem;margin:0}
#learn-live .sub{color:var(--color-ink-3,#857e77);font-size:.8125rem;margin:.25rem 0 0}
#learn-live .lead{color:var(--color-ink-2,#4c4640);margin:.75rem 0 0;line-height:1.6}
#learn-live .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:1rem;margin-top:1rem}
#learn-live h3{font-size:.875rem;font-weight:700;margin:0 0 .4rem}
#learn-live ol{margin:0;padding-left:1.25rem;font-size:.875rem;list-style:decimal}#learn-live li{margin:.3rem 0;color:var(--color-ink-2,#4c4640)}
#learn-live li a{color:var(--color-ink,#16120f);font-weight:600;text-decoration:none}
#learn-live .up{color:var(--color-up,#12a150)}#learn-live .down{color:var(--color-danger,#e5484d)}
#learn-live .links{display:flex;flex-wrap:wrap;gap:.4rem .9rem;margin-top:1rem;font-size:.875rem}#learn-live .links a{color:var(--color-emerald,#f2600c);font-weight:600;text-decoration:none}`;

/** The block's HTML. `d`: a day_pages row's data (chain = the guide's chain, or "all"). */
export function renderLearnLive(d, chain, { live = true } = {}) {
  if (!d) return "";
  const where = chain ? chain.name : "every chain sasa tracks";
  const when = dateLabel(d.day);
  const g = (d.gainers || []).slice(0, 5);
  const n = (d.newList || []).slice(0, 5);
  const big = (d.big || [])[0];
  if (!g.length && !n.length) return "";
  const lead = [
    d.newMemeCount ? `${Number(d.newMemeCount).toLocaleString("en-US")} new meme coins opened a pool on ${where} ${live ? "today" : `on ${when}`}.` : "",
    g[0] && Number(g[0].c) > 0 ? `The top gainer so far is ${g[0].name} ($${g[0].sym})${chain ? "" : ` on ${NAMES[g[0].n] || g[0].n}`}, ${pct(g[0].c)} in 24 hours.` : "",
    big ? `The biggest trade we recorded was a ${money(big.usd)} ${big.s === "buy" ? "buy" : "sale"} of ${big.name}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const item = (c, extra) => `<li><a href="${coinHref(c.n, c.a)}">${esc(c.name)}</a> <span>$${esc(c.sym)}</span> ${extra}</li>`;
  const cls = (v) => (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : "");
  const cols = [
    g.length ? `<div><h3>Top gainers</h3><ol>${g.map((c) => item(c, `<span class="${cls(c.c)}">${esc(pct(c.c))}</span>`)).join("")}</ol></div>` : "",
    n.length ? `<div><h3>New ${chain ? `on ${esc(chain.name)}` : "launches"}</h3><ol>${n.map((c) => item(c, `<span>${esc(money(c.mc))}</span>`)).join("")}</ol></div>` : "",
  ].join("");
  const dayUrl = `${SITE}/day/${d.day}/${chain ? `${chain.slug}/` : ""}`;
  const links = [
    [dayUrl, `${chain ? `${chain.name} meme coins` : "Meme coins"} on ${when}`],
    ...(chain
      ? [[`${SITE}/top/${chain.top}-meme-coins/`, `Top ${chain.name} meme coins`], [`${SITE}/top/new-${chain.top}-meme-coins/`, `New ${chain.name} meme coins`]]
      : [[`${SITE}/top/meme-coin-gainers/`, "Biggest gainers now"], [`${SITE}/top/new-meme-coins/`, "New meme coins now"]]),
    [`${SITE}/day/`, "Daily archive"],
  ];
  return `<style>${CSS}</style><section class="ll" aria-labelledby="learn-live-h"><h2 id="learn-live-h">On sasa ${live ? "today" : `on ${esc(when)}`}</h2><p class="sub">Live from sasa's daily meme coin record${chain ? ` for ${esc(chain.name)}` : ""}, updated every 30 minutes.</p><p class="lead">${esc(lead)}</p><div class="cols">${cols}</div><div class="links">${links.map(([u, t]) => `<a href="${u}">${esc(t)}</a>`).join("")}</div></section>`;
}
