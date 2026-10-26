/**
 * Daily meme coin pages (/day/...): one page per day for every chain together and one per chain,
 * built from that day's real record (indexer/seopages.mjs → day_pages): the coins that launched,
 * the biggest gainers, the busiest coins, the biggest trades and the coins launched on sasa.
 * Today's page fills up through the day; at midnight (UTC) it becomes the day's final record.
 * Every page is written from its own numbers, so no two read alike. Pure functions: data in,
 * HTML out.
 */
import { SITE, dateLabel, esc, money, price, shell } from "./top-render.js";

export const DAY_CHAINS = [
  { slug: "solana", network: "solana", name: "Solana", color: "#14f195" },
  { slug: "base", network: "base", name: "Base", color: "#2F6BFF" },
  { slug: "bnb-chain", network: "bsc", name: "BNB Chain", color: "#F0B90B" },
  { slug: "robinhood-chain", network: "robinhood", name: "Robinhood Chain", color: "#1FD15A" },
  { slug: "arc", network: "arc", name: "Arc", color: "#19B3E6" },
  { slug: "ethereum", network: "eth", name: "Ethereum", color: "#8C8CF2" },
];
export const chainBySlug = (slug) => DAY_CHAINS.find((c) => c.slug === slug) || null;
const chainByNet = (n) => DAY_CHAINS.find((c) => c.network === n) || null;
const netName = (n) => chainByNet(n)?.name || n;
const TX = { solana: "https://solscan.io/tx/", base: "https://basescan.org/tx/", bsc: "https://bscscan.com/tx/", eth: "https://etherscan.io/tx/" };

/** A coin page: Solana addresses keep their case, the others are lowercase. */
export const coinHref = (n, a) => (n === "solana" ? `${SITE}/x/solana/${encodeURIComponent(String(a))}/` : `${SITE}/x/${encodeURIComponent(n)}/${encodeURIComponent(String(a).toLowerCase())}/`);
export const dayHref = (day, slug) => `${SITE}/day/${day}/${slug && slug !== "all" ? `${slug}/` : ""}`;
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export { isDay };
const label = (day) => dateLabel(new Date(`${day}T12:00:00Z`));
const n0 = (v) => Number(v || 0).toLocaleString("en-US");
const pct = (v) => {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return { text: "—", cls: "" };
  const a = Math.abs(n);
  return { text: `${n > 0 ? "+" : n < 0 ? "−" : ""}${a >= 1000 ? `${(a / 1000).toFixed(1)}K` : a >= 100 ? a.toFixed(0) : a.toFixed(1)}%`, cls: n > 0.05 ? "up" : n < -0.05 ? "down" : "" };
};
/** A small stable number from a string: picks the wording for a page (the same page always reads the same). */
const pick = (seed, list) => {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return list[h % list.length];
};
const shortAddr = (a) => (a ? `${String(a).slice(0, 4)}…${String(a).slice(-4)}` : "—");
const timeUtc = (iso) => (iso ? `${String(iso).slice(11, 16)} UTC` : "—");

function coinCell(c, showChain) {
  const img = c.img ? `<img src="${esc(c.img)}" alt="" loading="lazy" width="32" height="32">` : `<span class="av" aria-hidden="true">${esc(String(c.sym || "?").slice(0, 1).toUpperCase())}</span>`;
  return `<a class="coin" href="${coinHref(c.n, c.a)}">${img}<span><b>${esc(c.name)}</b><small>$${esc(c.sym)}${showChain ? ` · ${esc(netName(c.n))}` : ""}</small></span></a>`;
}

/** The opening paragraph: written from the day's numbers. */
export function daySummary(d, chain) {
  const where = chain ? chain.name : "Solana, Base, BNB Chain, Robinhood Chain, Arc and Ethereum";
  const when = label(d.day);
  const seed = `${d.day}/${d.chain}`;
  const top = d.gainers?.[0];
  const busy = d.busiest?.[0];
  const big = d.big?.[0];
  const s = [];
  s.push(
    d.newMemeCount
      ? pick(seed, [
          `On ${when}, ${n0(d.newMemeCount)} new meme coins opened a trading pool on ${where}.`,
          `${n0(d.newMemeCount)} meme coins launched on ${where} on ${when}.`,
          `${when} saw ${n0(d.newMemeCount)} new meme coin pools open on ${where}.`,
        ])
      : `This is the meme coin record of ${when} on ${where}.`
  );
  if (top && Number(top.c) > 0)
    s.push(
      pick(seed + "g", [
        `The biggest gainer was ${top.name} ($${top.sym})${chain ? "" : ` on ${netName(top.n)}`}, ${pct(top.c).text} in 24 hours.`,
        `${top.name} ($${top.sym}) led the gainers with ${pct(top.c).text}${chain ? "" : ` on ${netName(top.n)}`}.`,
        `Top of the gainers: ${top.name} ($${top.sym}), up ${pct(top.c).text.replace("+", "")}${chain ? "" : ` on ${netName(top.n)}`}.`,
      ])
    );
  if (busy && Number(busy.v) > 0)
    s.push(
      pick(seed + "b", [
        `The most traded coin was ${busy.name} with ${money(busy.v)} of 24-hour volume.`,
        `${busy.name} ($${busy.sym}) drew the most trading, ${money(busy.v)} in a day.`,
      ])
    );
  if (d.bigCount && big)
    s.push(
      `We recorded ${n0(d.bigCount)} trade${d.bigCount === 1 ? "" : "s"} of $1,000 or more, worth ${money(d.bigUsd)} in total; the largest was a ${money(big.usd)} ${big.s === "buy" ? "buy" : "sale"} of ${big.name}${chain ? "" : ` on ${netName(big.n)}`}.`
    );
  if (!chain && d.perChain) {
    const tot = Object.values(d.perChain).reduce((a, b) => a + b, 0);
    const lead = Object.entries(d.perChain).sort((a, b) => b[1] - a[1])[0];
    if (lead && tot) s.push(`${netName(lead[0])} had the most new pools (${Math.round((lead[1] / tot) * 100)}%).`);
  }
  if (d.sasaCount) s.push(`${n0(d.sasaCount)} coin${d.sasaCount === 1 ? " was" : "s were"} launched on sasa.`);
  return s.join(" ");
}

function faqFor(d, chain) {
  const where = chain ? chain.name : "all chains";
  const when = label(d.day);
  const top = d.gainers?.[0];
  const busy = d.busiest?.[0];
  const big = d.big?.[0];
  const out = [];
  if (d.newMemeCount) out.push({ q: `How many meme coins launched on ${chain ? `${chain.name} on ` : ""}${when}?`, a: `${n0(d.newMemeCount)} new meme coins opened a trading pool on ${where} that day, by sasa's count of the pools it tracks.` });
  if (top) out.push({ q: `What was the best performing meme coin on ${when}${chain ? ` on ${chain.name}` : ""}?`, a: `${top.name} ($${top.sym}) gained ${pct(top.c).text} in 24 hours${top.v ? ` on ${money(top.v)} of volume` : ""}. Only coins with at least $10,000 of daily volume are ranked.` });
  if (busy) out.push({ q: `Which meme coin traded the most on ${when}?`, a: `${busy.name} ($${busy.sym}) with ${money(busy.v)} of 24-hour volume${busy.mc ? ` at a ${money(busy.mc)} market cap` : ""}.` });
  if (big) out.push({ q: `What was the biggest meme coin trade on ${when}?`, a: `A ${money(big.usd)} ${big.s === "buy" ? "buy" : "sale"} of ${big.name} ($${big.sym}) on ${netName(big.n)} at ${timeUtc(big.t)}.` });
  out.push({ q: "How do I buy these coins?", a: "Open any coin and buy it on sasa with USDC: no bridge, no gas token and no Solana wallet needed. Meme coins are very risky; only use money you can afford to lose." });
  return out;
}

const CSS = `
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:18px}
.stat{border:1px solid var(--line);border-radius:14px;padding:12px 14px}.stat span{display:block;font-size:12px;color:var(--mut)}.stat b{font-size:22px;letter-spacing:-.4px}
.bars div{display:flex;align-items:center;gap:10px;margin:6px 0;font-size:14px}.bars span:first-child{width:130px;flex:none}.bars i{display:block;height:10px;border-radius:6px;min-width:4px}
.pills{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.pills a{font-size:13px;border:1px solid var(--line);border-radius:999px;padding:3px 10px;text-decoration:none;color:var(--ink2)}
.pager{display:flex;justify-content:space-between;gap:12px;margin-top:28px;font-weight:600;font-size:15px}.pager a{color:var(--acc);text-decoration:none}
.cal{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr));gap:10px;margin-top:12px}
.cal section{border:1px solid var(--line);border-radius:14px;padding:12px 14px}.cal h3{margin:0 0 4px;font-size:16px}.cal h3 a{text-decoration:none}.cal p{margin:0;font-size:13px;color:var(--mut)}
td.l,th.l{text-align:left}
`;

function table(head, rows) {
  return `<div class="wrap"><table><thead><tr>${head.map((h) => `<th${h.cls ? ` class="${h.cls}"` : ""}>${esc(h.t)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

export function renderDay(d, chainSlug, { prev = null, next = null, today = null, now = new Date() } = {}) {
  const chain = chainSlug === "all" ? null : chainBySlug(chainSlug);
  const when = label(d.day);
  const live = today === d.day;
  const canonical = dayHref(d.day, chainSlug);
  const h1 = chain ? `${chain.name} meme coins on ${when}` : `Meme coins on ${when}`;
  const title = `${h1}: new launches, top gainers and whale trades · sasa`;
  const lead = daySummary(d, chain);
  const faq = faqFor(d, chain);
  const showChain = !chain;

  const tabs = [{ slug: "all", name: "All chains" }, ...DAY_CHAINS]
    .map((c) => `<a href="${dayHref(d.day, c.slug)}"${c.slug === chainSlug ? ' class="on" aria-current="page"' : ""}>${esc(c.name)}</a>`)
    .join("");
  const stats = [
    ["New meme coins", n0(d.newMemeCount)],
    ["Volume of the busiest coins", money(d.volume)],
    ["Trades of $1,000+", n0(d.bigCount)],
    ["Launched on sasa", n0(d.sasaCount)],
  ]
    .map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><b>${esc(v)}</b></div>`)
    .join("");

  const parts = [];
  if (d.newList?.length)
    parts.push(
      `<h2>New meme coins launched ${live ? "today" : `on ${esc(when)}`}</h2><p>Coins whose first pool opened that day${chain ? ` on ${esc(chain.name)}` : ""}, busiest first. Market cap and volume as of ${live ? "now" : "the end of the day"}.</p>` +
        table(
          [{ t: "#" }, { t: "Coin" }, { t: "Opened", cls: "h" }, { t: "Market cap" }, { t: "Volume 24h", cls: "h" }, { t: "24h" }],
          d.newList.map((c, k) => `<tr><td>${k + 1}</td><td>${coinCell(c, showChain)}</td><td class="h">${timeUtc(c.pc)}</td><td>${money(c.mc)}</td><td class="h">${money(c.v)}</td><td class="${pct(c.c).cls}">${pct(c.c).text}</td></tr>`)
        )
    );
  if (d.gainers?.length)
    parts.push(
      `<h2>Biggest gainers of the day</h2><p>Ranked by 24-hour price change, among coins that traded at least $10,000.</p>` +
        table(
          [{ t: "#" }, { t: "Coin" }, { t: "Price", cls: "h" }, { t: "Market cap" }, { t: "Volume 24h", cls: "h" }, { t: "24h" }],
          d.gainers.map((c, k) => `<tr><td>${k + 1}</td><td>${coinCell(c, showChain)}</td><td class="h">${price(c.p)}</td><td>${money(c.mc)}</td><td class="h">${money(c.v)}</td><td class="${pct(c.c).cls}">${pct(c.c).text}</td></tr>`)
        )
    );
  if (d.big?.length)
    parts.push(
      `<h2>Whale trades ${live ? "today" : "of the day"}</h2><p>The largest single trades of $1,000 or more in the busiest meme coins${chain ? ` on ${esc(chain.name)}` : ""}.</p>` +
        table(
          [{ t: "Time" }, { t: "Coin" }, { t: "Side" }, { t: "Size" }, { t: "Wallet", cls: "h" }],
          d.big.map(
            (t) =>
              `<tr><td>${timeUtc(t.t)}</td><td>${coinCell(t, showChain)}</td><td class="${t.s === "buy" ? "up" : "down"}">${t.s === "buy" ? "Bought" : "Sold"}</td><td><b>${money(t.usd)}</b></td><td class="h">${
                TX[t.n] && t.tx ? `<a href="${TX[t.n]}${esc(t.tx)}" rel="nofollow noopener" target="_blank">${esc(shortAddr(t.w))}</a>` : esc(shortAddr(t.w))
              }</td></tr>`
          )
        )
    );
  if (d.busiest?.length)
    parts.push(
      `<h2>Most traded meme coins</h2>` +
        table(
          [{ t: "#" }, { t: "Coin" }, { t: "Price", cls: "h" }, { t: "Market cap" }, { t: "Volume 24h" }, { t: "Liquidity", cls: "h" }, { t: "24h" }],
          d.busiest.map((c, k) => `<tr><td>${k + 1}</td><td>${coinCell(c, showChain)}</td><td class="h">${price(c.p)}</td><td>${money(c.mc)}</td><td>${money(c.v)}</td><td class="h">${money(c.l)}</td><td class="${pct(c.c).cls}">${pct(c.c).text}</td></tr>`)
        )
    );
  if (d.sasa?.length)
    parts.push(
      `<h2>Launched on sasa</h2><p>Coins created on sasa that day${chain ? ` on ${esc(chain.name)}` : ""}. Anyone can launch one with USDC, no wallet or gas needed: <a href="/create/">create a coin</a>.</p><ul>${d.sasa
        .map((c) => {
          const href = c.kind === "race" ? `${SITE}/r/?id=${encodeURIComponent(c.id)}` : coinHref(c.n, c.a);
          return `<li><a href="${href}">${esc(c.name)} ($${esc(c.sym)})</a>${c.n ? ` · ${esc(netName(c.n))}` : ""} · ${timeUtc(c.t)}</li>`;
        })
        .join("")}</ul>`
    );
  if (!chain && d.perChain && Object.keys(d.perChain).length) {
    const tot = Object.values(d.perChain).reduce((a, b) => a + b, 0) || 1;
    const rows = Object.entries(d.perChain)
      .sort((a, b) => b[1] - a[1])
      .map(([n, v]) => `<div><span><a href="${dayHref(d.day, chainByNet(n)?.slug || "all")}">${esc(netName(n))}</a></span><i style="width:${Math.max(1, Math.round((v / tot) * 60))}%;background:${chainByNet(n)?.color || "var(--acc)"}"></i><span>${n0(v)} (${Math.round((v / tot) * 100)}%)</span></div>`)
      .join("");
    parts.push(`<h2>New pools by chain</h2><div class="bars">${rows}</div>`);
  }
  if (!parts.length) parts.push(`<p>Nothing was recorded for this day yet. The page fills up through the day.</p>`);

  const ld = [
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: h1,
      url: canonical,
      description: lead.slice(0, 300),
      datePublished: `${d.day}T00:00:00Z`,
      dateModified: d.builtAt || now.toISOString(),
      isPartOf: { "@type": "WebSite", name: "sasa", url: SITE },
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: (d.gainers || []).length,
        itemListElement: (d.gainers || []).slice(0, 25).map((c, k) => ({ "@type": "ListItem", position: k + 1, name: `${c.name} (${c.sym})`, url: coinHref(c.n, c.a) })),
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "sasa", item: `${SITE}/` },
        { "@type": "ListItem", position: 2, name: "Daily meme coin archive", item: `${SITE}/day/` },
        { "@type": "ListItem", position: 3, name: when, item: dayHref(d.day, "all") },
        ...(chain ? [{ "@type": "ListItem", position: 4, name: chain.name, item: canonical }] : []),
      ],
    },
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) },
  ];
  const updated = live ? `Updating through the day · last update ${timeUtc(d.builtAt)}` : `Final record of ${esc(when)}`;
  const body = `<style>${CSS}</style><main>
<div class="crumbs"><a href="/">sasa</a> / <a href="/day/">Daily archive</a> / ${chain ? `<a href="${dayHref(d.day, "all")}">${esc(when)}</a> / ${esc(chain.name)}` : esc(when)}</div>
<h1>${esc(h1)}</h1><p class="date">${updated}</p>
<p class="lead">${esc(lead)}</p>
<nav class="tabs" aria-label="Chains">${tabs}</nav>
<div class="stats">${stats}</div>
${parts.join("\n")}
<h2>Questions about this day</h2>
<dl class="faq">${faq.map((f) => `<dt>${esc(f.q)}</dt><dd>${esc(f.a)}</dd>`).join("")}</dl>
<div class="pager">${prev ? `<a href="${dayHref(prev, chainSlug)}">← ${esc(label(prev))}</a>` : "<span></span>"}<a href="/day/">All days</a>${next ? `<a href="${dayHref(next, chainSlug)}">${esc(label(next))} →</a>` : "<span></span>"}</div>
<h2>Live lists</h2>
<div class="more"><a href="/top/meme-coin-gainers/">Biggest gainers right now<span>Updated every 30 minutes</span></a><a href="/top/new-meme-coins/">New meme coins right now<span>Updated every 30 minutes</span></a><a href="/top/trending-meme-coins/">Trending meme coins<span>Updated every 30 minutes</span></a></div>
<h2>Learn</h2>
<ul><li><a href="/learn/how-to-use-daily-top-gainers-lists/">How to use daily top gainers lists</a></li><li><a href="/learn/how-to-find-new-solana-meme-coins/">How to find new Solana meme coins</a></li><li><a href="/learn/how-to-read-big-crypto-trades/">How to read big crypto trades</a></li><li><a href="/learn/how-to-spot-a-meme-coin-rug-pull/">How to spot a meme coin rug pull</a></li></ul>
</main>`;
  return shell({ title, description: lead.slice(0, 300), canonical, ld, body });
}

/** /day/: every day with a page, newest first, by month. `rows`: [{ day, chain, ok, nm (new meme coins) }]. */
export function renderHub(rows, now = new Date()) {
  const byDay = new Map();
  for (const r of rows) {
    if (!r.ok) continue;
    const e = byDay.get(r.day) || { day: r.day, chains: [], nm: 0 };
    if (r.chain === "all") e.nm = Number(r.nm) || 0;
    else e.chains.push(r.chain);
    byDay.set(r.day, e);
  }
  const days = [...byDay.values()].filter((e) => e.nm || e.chains.length).sort((a, b) => (a.day < b.day ? 1 : -1));
  const months = new Map();
  for (const e of days) {
    const m = e.day.slice(0, 7);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(e);
  }
  const canonical = `${SITE}/day/`;
  const title = "Daily meme coin archive: launches, gainers and whale trades by day · sasa";
  const description = "Every day's meme coin record on Solana, Base, BNB Chain, Robinhood Chain, Arc and Ethereum: new launches, the biggest gainers, the most traded coins and the largest trades.";
  const ld = [
    { "@context": "https://schema.org", "@type": "CollectionPage", name: "Daily meme coin archive", url: canonical, description, dateModified: now.toISOString(),
      hasPart: days.slice(0, 60).map((e) => ({ "@type": "CollectionPage", name: `Meme coins on ${label(e.day)}`, url: dayHref(e.day, "all") })) },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "sasa", item: `${SITE}/` }, { "@type": "ListItem", position: 2, name: "Daily meme coin archive", item: canonical }] },
  ];
  const sections = [...months.entries()]
    .map(([m, list]) => {
      const name = new Date(`${m}-15T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
      return `<h2>${esc(name)}</h2><div class="cal">${list
        .map(
          (e) =>
            `<section><h3><a href="${dayHref(e.day, "all")}">${esc(label(e.day))}</a></h3><p>${e.nm ? `${n0(e.nm)} new meme coins` : "Meme coin record"}</p><div class="pills">${DAY_CHAINS.filter((c) => e.chains.includes(c.slug))
              .map((c) => `<a href="${dayHref(e.day, c.slug)}">${esc(c.name)}</a>`)
              .join("")}</div></section>`
        )
        .join("")}</div>`;
    })
    .join("");
  const body = `<style>${CSS}</style><main>
<div class="crumbs"><a href="/">sasa</a></div>
<h1>Daily meme coin archive</h1>
<p class="lead">${esc(description)} Today's page updates every 30 minutes; at midnight UTC it becomes that day's final record.</p>
${sections || "<p>The first day is being recorded now.</p>"}
<h2>Live lists</h2>
<div class="more"><a href="/top/">Top meme coins today<span>Updated every 30 minutes</span></a><a href="/explore/">Explore every coin<span>Live in the app</span></a></div>
</main>`;
  return shell({ title, description, canonical, ld, body });
}
