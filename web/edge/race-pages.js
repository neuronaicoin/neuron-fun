/**
 * Race pages for search and AI engines (/races/...): server-rendered HTML from live race
 * data, one page per chain per day ("Base meme coin races on October 20, 2026"), a page per
 * chain and a hub. Every page is built from that day's real races, so no two read alike;
 * days without a race are not pages at all (404). Pure functions: data in, HTML out.
 *
 * Only mainnet races count: testnet chains are not in CHAINS, so test races never show
 * up here or in the sitemap.
 */
import { SITE, dateLabel, esc, money, shell } from "./top-render.js";

/** Mainnet chains of the race, by their URL slug. */
export const CHAINS = [
  { slug: "base", name: "Base", chainId: 8453, color: "#2F6BFF", dex: "Uniswap v4", pair: "ETH" },
  { slug: "bnb-chain", name: "BNB Chain", chainId: 56, color: "#F0B90B", dex: "PancakeSwap Infinity", pair: "BNB" },
  { slug: "robinhood-chain", name: "Robinhood Chain", chainId: 4663, color: "#1FD15A", dex: "Uniswap v4", pair: "ETH" },
  // Arc mainnet chain id: confirm on deploy day (contracts-v7/deployments) and update here.
  { slug: "arc", name: "Arc", chainId: 5042, color: "#19B3E6", dex: "Uniswap v4", pair: "USDC" },
];
export const chainBySlug = (slug) => CHAINS.find((c) => c.slug === slug) || null;
export const chainById = (id) => CHAINS.find((c) => c.chainId === Number(id)) || null;
export const MAINNET_IDS = CHAINS.map((c) => c.chainId);

const DAY = 86400_000;
/** "2026-10-20" → Date at 00:00 UTC, or null if it isn't a real date. */
export function parseDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}
export const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const raceUrl = (id) => `${SITE}/r/?id=${id}`;
const laneUsd = (l) => Number(l?.reported_usd ?? l?.pool_usd ?? 0) || 0;
const n = (v) => Number(v || 0).toLocaleString("en-US");

const COLS = "id,name,symbol,logo,launched_at,winner_chain,total_usd,decided_at,race_chains(chain_id,pool_usd,reported_usd,volume_usd,buys,sells,state)";
/** PostgREST query: races of one day (UTC) that include `chain` (or any mainnet chain). */
export function dayQuery(chain, day) {
  const from = day.toISOString();
  const to = new Date(day.getTime() + DAY).toISOString();
  return `race_coins?select=${COLS}&launched_at=gte.${from}&launched_at=lt.${to}&order=launched_at.desc&limit=1000`;
}
/** PostgREST query: when races happened in the last `days` days (for day lists and the sitemap). */
export function recentQuery(days = 60, now = new Date()) {
  const from = new Date(now.getTime() - days * DAY).toISOString();
  return `race_coins?select=id,launched_at,winner_chain,total_usd,race_chains(chain_id,volume_usd)&launched_at=gte.${from}&order=launched_at.desc&limit=20000`;
}

/** Keeps mainnet races only, and for `chain` only the races it took part in. */
export function forChain(rows, chain) {
  return (rows || []).filter((r) => {
    const ids = (r.race_chains || []).map((l) => Number(l.chain_id));
    if (!ids.some((id) => MAINNET_IDS.includes(id))) return false;
    return chain ? ids.includes(chain.chainId) : true;
  });
}

/** Per-day numbers for a chain (or all chains): races, wins, volume. Newest day first. */
export function daysOf(rows, chain) {
  const by = new Map();
  for (const r of forChain(rows, chain)) {
    const k = dayKey(r.launched_at);
    const d = by.get(k) || { day: k, races: 0, wins: 0, volume: 0 };
    d.races += 1;
    if (chain ? Number(r.winner_chain) === chain.chainId : r.winner_chain) d.wins += 1;
    for (const l of r.race_chains || []) if (!chain || Number(l.chain_id) === chain.chainId) d.volume += Number(l.volume_usd || 0);
    by.set(k, d);
  }
  return [...by.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

function stats(races, chain) {
  let wins = 0, volume = 0, raised = 0, trades = 0, best = null;
  for (const r of races) {
    const lane = (r.race_chains || []).find((l) => Number(l.chain_id) === chain.chainId);
    if (Number(r.winner_chain) === chain.chainId) wins += 1;
    volume += Number(lane?.volume_usd || 0);
    raised += laneUsd(lane);
    trades += Number(lane?.buys || 0) + Number(lane?.sells || 0);
    if (!best || laneUsd(lane) > laneUsd((best.race_chains || []).find((l) => Number(l.chain_id) === chain.chainId))) best = r;
  }
  return { wins, volume, raised, trades, best };
}

function lead(chain, label, races, s) {
  if (!races.length) return `No meme coin races ran on ${chain.name} on ${label}.`;
  const decided = races.filter((r) => r.winner_chain).length;
  const parts = [
    `On ${label}, ${races.length} meme coin ${races.length === 1 ? "race" : "races"} included ${chain.name}.`,
    decided ? `${chain.name} won ${s.wins} of the ${decided} decided ${decided === 1 ? "race" : "races"}${s.wins ? "" : ", so its buyers' coins were moved to the winning chains"}.` : "",
    `Buyers put ${money(s.raised)} into ${chain.name} pools and traded ${money(s.volume)} across ${n(s.trades)} trades.`,
    s.best ? `The biggest ${chain.name} lane belonged to ${s.best.name} ($${s.best.symbol}).` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

function raceRow(r, chain) {
  const lane = (r.race_chains || []).find((l) => Number(l.chain_id) === chain.chainId);
  const total = Number(r.total_usd) > 0 ? Number(r.total_usd) : (r.race_chains || []).reduce((s, l) => s + laneUsd(l), 0);
  const w = chainById(r.winner_chain);
  const result = !r.winner_chain && !r.decided_at ? "Racing" : w ? (w.chainId === chain.chainId ? `<b style="color:${w.color}">Won</b>` : `Lost to ${esc(w.name)}`) : "Over";
  const t = new Date(r.launched_at).toISOString().slice(11, 16);
  const av = typeof r.logo === "string" && r.logo.startsWith("https://") ? `<img src="${esc(r.logo)}" alt="" loading="lazy" width="32" height="32">` : `<span class="av" aria-hidden="true">${esc(String(r.symbol || "?").slice(0, 1).toUpperCase())}</span>`;
  return `<tr><td>${t}</td><td><a class="coin" href="${raceUrl(r.id)}">${av}<span><b>${esc(r.name)}</b><small>$${esc(r.symbol)} · ${(r.race_chains || []).length} chains<span class="m">${result.replace(/<[^>]+>/g, "")}</span></small></span></a></td>
<td>${money(laneUsd(lane))}</td><td class="h">${money(total)}</td><td class="h">${n(Number(lane?.buys || 0) + Number(lane?.sells || 0))}</td><td class="h">${result}</td></tr>`;
}

const crumbs = (items) => `<div class="crumbs">${items.map(([t, u]) => (u ? `<a href="${u}">${esc(t)}</a>` : esc(t))).join(" / ")}</div>`;
const breadcrumbLd = (items) => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: items.map(([name, u], i) => ({ "@type": "ListItem", position: i + 1, name, item: `${SITE}${u}` })),
});
const chainTabs = (current, day) =>
  `<nav class="tabs" aria-label="Chains"><a href="/races/${day ? `all/${day}/` : ""}"${!current ? ' class="on"' : ""}>All chains</a>${CHAINS.map(
    (c) => `<a href="/races/${c.slug}/${day ? `${day}/` : ""}"${current && current.slug === c.slug ? ' class="on" aria-current="page"' : ""}>${esc(c.name)}</a>`
  ).join("")}</nav>`;

const HOW = `<h2>How a launch race works</h2>
<p>Every coin on sasa launches on Base, BNB Chain, Robinhood Chain and Arc at the same moment, with the same contract address and its own pool on each chain. For five minutes anyone can buy on any chain. When time is up, the chain whose pool holds the most money (valued in dollars with Chainlink prices) wins: the other pools close, their money moves into the winner's pool minus a 2% hand-over fee, holders' coins move to the winning chain automatically, and the winning pool is locked forever. <a href="/learn/how-the-5-minute-launch-race-works/">Read the full guide</a>.</p>`;

/** One chain, one day. `rows` = dayQuery result. Returns null when there is no race (404). */
export function renderDay(chain, day, rows, now = new Date()) {
  const races = forChain(rows, chain);
  if (!races.length) return null;
  const key = dayKey(day);
  const label = dateLabel(day);
  const s = stats(races, chain);
  const canonical = `${SITE}/races/${chain.slug}/${key}/`;
  const title = `${chain.name} meme coin races on ${label}: ${races.length} ${races.length === 1 ? "launch" : "launches"}, ${s.wins} won · sasa`;
  const description = lead(chain, label, races, s).slice(0, 300);
  const faq = [
    { q: `How many meme coins launched on ${chain.name} on ${label}?`, a: `${races.length} coins raced on ${chain.name} that day, each launched on four chains at once through sasa's five-minute launch race.` },
    { q: `How often did ${chain.name} win?`, a: `${chain.name} won ${s.wins} of ${races.length} races on ${label}. A coin's winning chain keeps its pool, locked forever, and receives the other chains' money minus a 2% hand-over fee.` },
    { q: `What do ${chain.name} race pools trade against?`, a: `On ${chain.name} each coin's pool is paired with ${chain.pair} on ${chain.dex}, so DexScreener, GMGN and trading bots see it from the first trade.` },
  ];
  const ld = [
    { "@context": "https://schema.org", "@type": "CollectionPage", name: `${chain.name} meme coin races on ${label}`, url: canonical, description, dateModified: now.toISOString(), isPartOf: { "@type": "WebSite", name: "sasa", url: SITE },
      mainEntity: { "@type": "ItemList", numberOfItems: races.length, itemListElement: races.slice(0, 100).map((r, i) => ({ "@type": "ListItem", position: i + 1, name: `${r.name} (${r.symbol})`, url: raceUrl(r.id) })) } },
    breadcrumbLd([["sasa", "/"], ["Races", "/races/"], [chain.name, `/races/${chain.slug}/`], [label, `/races/${chain.slug}/${key}/`]]),
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) },
  ];
  const body = `<main>
${crumbs([["sasa", "/"], ["Races", "/races/"], [chain.name, `/races/${chain.slug}/`], [label, null]])}
<h1>${esc(chain.name)} meme coin races on ${esc(label)}</h1><p class="date">All times UTC · updated ${now.toISOString().slice(11, 16)} UTC</p>
<p class="lead">${esc(lead(chain, label, races, s))}</p>
${chainTabs(chain, key)}
<div class="wrap"><table><thead><tr><th>Time</th><th>Coin</th><th>On ${esc(chain.name)}</th><th class="h">Whole race</th><th class="h">Trades</th><th class="h">Result</th></tr></thead><tbody>${races.map((r) => raceRow(r, chain)).join("")}</tbody></table></div>
<p style="font-size:14px"><a href="/races/${chain.slug}/">← Every day of ${esc(chain.name)} races</a></p>
${HOW}
<h2>Questions</h2>
<dl class="faq">${faq.map((f) => `<dt>${esc(f.q)}</dt><dd>${esc(f.a)}</dd>`).join("")}</dl>
<h2>More</h2>
<div class="more"><a href="/races/${chain.slug}/">All ${esc(chain.name)} races<span>Day by day</span></a><a href="/top/${chain.slug === "bnb-chain" ? "bnb-chain" : chain.slug}-meme-coins/">Top ${esc(chain.name)} meme coins today<span>By 24-hour volume</span></a><a href="/learn/best-chains-to-launch-a-meme-coin/">Best chains to launch a meme coin<span>Guide</span></a><a href="/race/launch/">Launch a race<span>On four chains at once</span></a></div>
</main>`;
  return shell({ title, description, canonical, ld, body });
}

/** All chains, one day. */
export function renderAllDay(day, rows, now = new Date()) {
  const races = forChain(rows, null);
  if (!races.length) return null;
  const key = dayKey(day);
  const label = dateLabel(day);
  const canonical = `${SITE}/races/all/${key}/`;
  const wins = CHAINS.map((c) => ({ c, w: races.filter((r) => Number(r.winner_chain) === c.chainId).length })).sort((a, b) => b.w - a.w);
  const total = races.reduce((s, r) => s + (Number(r.total_usd) > 0 ? Number(r.total_usd) : (r.race_chains || []).reduce((a, l) => a + laneUsd(l), 0)), 0);
  const leadText = `On ${label}, ${races.length} meme coin ${races.length === 1 ? "race" : "races"} ran on sasa, raising ${money(total)} in total. ${wins[0].w ? `${wins[0].c.name} won the most (${wins[0].w}), ` : ""}${wins.slice(wins[0].w ? 1 : 0).map((x) => `${x.c.name} ${x.w}`).join(", ")}.`;
  const title = `Meme coin launch races on ${label}: ${races.length} races across four chains · sasa`;
  const ld = [
    { "@context": "https://schema.org", "@type": "CollectionPage", name: `Meme coin launch races on ${label}`, url: canonical, description: leadText, dateModified: now.toISOString(),
      mainEntity: { "@type": "ItemList", numberOfItems: races.length, itemListElement: races.slice(0, 100).map((r, i) => ({ "@type": "ListItem", position: i + 1, name: `${r.name} (${r.symbol})`, url: raceUrl(r.id) })) } },
    breadcrumbLd([["sasa", "/"], ["Races", "/races/"], [label, `/races/all/${key}/`]]),
  ];
  const rows2 = races
    .map((r) => {
      const w = chainById(r.winner_chain);
      const t = Number(r.total_usd) > 0 ? Number(r.total_usd) : (r.race_chains || []).reduce((a, l) => a + laneUsd(l), 0);
      return `<tr><td>${new Date(r.launched_at).toISOString().slice(11, 16)}</td><td><a class="coin" href="${raceUrl(r.id)}"><span class="av" aria-hidden="true">${esc(String(r.symbol || "?").slice(0, 1).toUpperCase())}</span><span><b>${esc(r.name)}</b><small>$${esc(r.symbol)}</small></span></a></td><td>${money(t)}</td><td>${w ? `<b style="color:${w.color}">${esc(w.name)}</b>` : r.decided_at ? "Over" : "Racing"}</td></tr>`;
    })
    .join("");
  const body = `<main>
${crumbs([["sasa", "/"], ["Races", "/races/"], [label, null]])}
<h1>Meme coin launch races on ${esc(label)}</h1><p class="date">All times UTC</p>
<p class="lead">${esc(leadText)}</p>
${chainTabs(null, key)}
<div class="wrap"><table><thead><tr><th>Time</th><th>Coin</th><th>Raised</th><th>Winner</th></tr></thead><tbody>${rows2}</tbody></table></div>
${HOW}
</main>`;
  return shell({ title, description: leadText.slice(0, 300), canonical, ld, body });
}

/** One chain: its recent days. `days` = daysOf(recent rows, chain). */
export function renderChain(chain, days, now = new Date()) {
  const canonical = `${SITE}/races/${chain.slug}/`;
  const races = days.reduce((s, d) => s + d.races, 0);
  const wins = days.reduce((s, d) => s + d.wins, 0);
  const volume = days.reduce((s, d) => s + d.volume, 0);
  const leadText = races
    ? `${chain.name} took part in ${n(races)} meme coin launch races in the last ${days.length === 1 ? "day" : `${days.length} active days`} and won ${n(wins)} of them (${Math.round((wins / races) * 100)}%), with ${money(volume)} traded in its pools. Each race puts a new coin on ${chain.name} and three other chains at once; the chain with the most money after five minutes keeps it.`
    : `No ${chain.name} races yet. Each race puts a new coin on ${chain.name} and three other chains at once; the chain with the most money after five minutes keeps it.`;
  const title = `${chain.name} meme coin races: daily launches and winners · sasa`;
  const ld = [
    { "@context": "https://schema.org", "@type": "CollectionPage", name: `${chain.name} meme coin races`, url: canonical, description: leadText, dateModified: now.toISOString(),
      hasPart: days.slice(0, 60).map((d) => ({ "@type": "CollectionPage", name: `${chain.name} meme coin races on ${dateLabel(new Date(d.day))}`, url: `${SITE}/races/${chain.slug}/${d.day}/` })) },
    breadcrumbLd([["sasa", "/"], ["Races", "/races/"], [chain.name, `/races/${chain.slug}/`]]),
  ];
  const table = days.length
    ? `<div class="wrap"><table><thead><tr><th>Day</th><th>Races</th><th>Won</th><th>Volume</th></tr></thead><tbody>${days
        .slice(0, 60)
        .map((d) => `<tr><td style="color:inherit"><a href="/races/${chain.slug}/${d.day}/">${esc(dateLabel(new Date(d.day)))}</a></td><td style="text-align:right">${d.races}</td><td>${d.wins}</td><td>${money(d.volume)}</td></tr>`)
        .join("")}</tbody></table></div>`
    : "";
  const body = `<main>
${crumbs([["sasa", "/"], ["Races", "/races/"], [chain.name, null]])}
<h1>${esc(chain.name)} meme coin races</h1>
<p class="lead">${esc(leadText)}</p>
${chainTabs(chain, null)}
${table}
${HOW}
</main>`;
  return shell({ title, description: leadText.slice(0, 300), canonical, ld, body, robots: races ? undefined : "noindex" });
}

/** The hub: league table of the last 30 days and the latest days. */
export function renderHub(rows, now = new Date()) {
  const canonical = `${SITE}/races/`;
  const all = daysOf(rows, null);
  const league = CHAINS.map((c) => {
    const d = daysOf(rows, c);
    return { c, races: d.reduce((s, x) => s + x.races, 0), wins: d.reduce((s, x) => s + x.wins, 0), volume: d.reduce((s, x) => s + x.volume, 0) };
  }).sort((a, b) => b.wins - a.wins || b.volume - a.volume);
  const races = all.reduce((s, d) => s + d.races, 0);
  const leadText = races
    ? `${n(races)} meme coin launch races ran on sasa in the last 60 days. ${league[0].c.name} leads the chain league with ${n(league[0].wins)} wins. Every race launches one coin on Base, BNB Chain, Robinhood Chain and Arc at once; after five minutes the chain with the most money keeps it.`
    : "Every race launches one coin on Base, BNB Chain, Robinhood Chain and Arc at once; after five minutes the chain with the most money keeps it. The first races appear here as soon as they run.";
  const title = "Meme coin launch races: daily results and the chain league · sasa";
  const ld = [
    { "@context": "https://schema.org", "@type": "CollectionPage", name: "Meme coin launch races", url: canonical, description: leadText, dateModified: now.toISOString(),
      hasPart: CHAINS.map((c) => ({ "@type": "CollectionPage", name: `${c.name} meme coin races`, url: `${SITE}/races/${c.slug}/` })) },
    breadcrumbLd([["sasa", "/"], ["Races", "/races/"]]),
  ];
  const body = `<main>
${crumbs([["sasa", "/"], ["Races", null]])}
<h1>Meme coin launch races</h1>
<p class="lead">${esc(leadText)}</p>
${chainTabs(null, null)}
<h2>Chain league, last 60 days</h2>
<div class="wrap"><table><thead><tr><th>#</th><th>Chain</th><th>Wins</th><th>Races</th><th>Volume</th></tr></thead><tbody>${league
    .map((x, i) => `<tr><td>${i + 1}</td><td><a href="/races/${x.c.slug}/">${esc(x.c.name)}</a></td><td>${x.wins}</td><td>${x.races}</td><td>${money(x.volume)}</td></tr>`)
    .join("")}</tbody></table></div>
${all.length ? `<h2>Latest days</h2><div class="more">${all.slice(0, 30).map((d) => `<a href="/races/all/${d.day}/">${esc(dateLabel(new Date(d.day)))}<span>${d.races} ${d.races === 1 ? "race" : "races"} · ${money(d.volume)} traded</span></a>`).join("")}</div>` : ""}
${HOW}
</main>`;
  return shell({ title, description: leadText.slice(0, 300), canonical, ld, body, robots: races ? undefined : "noindex" });
}
