/**
 * The search section of a coin page (/x/<network>/<address>/): what Google, Bing and AI engines
 * read, and what people see under the app's chart and trades. Written from the coin's own data:
 * a summary in plain words, key facts, daily price history (coin_days), its biggest trades
 * (big_trades), what sasa's traders did, the days it made sasa's daily lists, similar coins and
 * questions people search for. Same data, same words: the wording varies between coins (picked
 * from the address), never between visits. Pure functions: data in, HTML out.
 */
const SITE = "https://sasapad.fun";
export const CHAIN_NAMES = { solana: "Solana", base: "Base", bsc: "BNB Chain", eth: "Ethereum", robinhood: "Robinhood Chain", arc: "Arc" };
const TOP_SLUG = { solana: "solana", base: "base", bsc: "bnb-chain", eth: "ethereum", robinhood: "robinhood-chain", arc: "arc" };
const DAY_SLUG = { solana: "solana", base: "base", bsc: "bnb-chain", eth: "ethereum", robinhood: "robinhood-chain", arc: "arc" };
const TX = { solana: "https://solscan.io/tx/", base: "https://basescan.org/tx/", bsc: "https://bscscan.com/tx/", eth: "https://etherscan.io/tx/" };
const GUIDES = {
  solana: [["how-to-buy-solana-meme-coins-with-usdc", "How to buy Solana meme coins with USDC"], ["solana-meme-coin-safety-check", "Solana meme coin safety check"], ["how-to-sell-a-solana-meme-coin", "How to sell a Solana meme coin"]],
  base: [["how-to-buy-meme-coins-on-base", "How to buy meme coins on Base"], ["how-to-spot-a-meme-coin-rug-pull", "How to spot a meme coin rug pull"]],
  bsc: [["how-to-buy-meme-coins-on-bnb-chain", "How to buy meme coins on BNB Chain"], ["how-to-spot-a-meme-coin-rug-pull", "How to spot a meme coin rug pull"]],
  eth: [["how-to-buy-meme-coins-on-ethereum", "How to buy meme coins on Ethereum"], ["how-to-spot-a-meme-coin-rug-pull", "How to spot a meme coin rug pull"]],
  robinhood: [["how-to-buy-meme-coins-on-robinhood-chain", "How to buy meme coins on Robinhood Chain"], ["robinhood-chain-gas-fees", "Robinhood Chain gas fees"]],
  arc: [["arc-network-meme-coins", "Arc network meme coins"], ["what-is-arc-network", "What is Arc network"]],
};

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pos = (v) => {
  const n = num(v);
  return n !== null && n > 0 && n < 1e12 ? n : null;
};
export function money(v) {
  const n = pos(v);
  if (n === null) return "—";
  const t = (x) => x.replace(/\.?0+$/, "");
  if (n >= 1e9) return `$${t((n / 1e9).toFixed(2))}B`;
  if (n >= 999_950) return `$${t((n / 1e6).toFixed(2))}M`;
  if (n >= 1e3) return `$${t((n / 1e3).toFixed(1))}K`;
  return `$${n.toFixed(n < 10 ? 2 : 0)}`;
}
export function price(v) {
  const n = pos(v);
  if (n === null) return "—";
  if (n >= 1) return `$${n.toFixed(n >= 100 ? 2 : 4)}`;
  const d = Math.min(18, Math.max(2, -Math.floor(Math.log10(n)) + 2));
  return `$${n.toFixed(d)}`;
}
const pctText = (n) => {
  const a = Math.abs(n);
  return `${a >= 1000 ? `${(a / 1000).toFixed(1)}K` : a >= 100 ? a.toFixed(0) : a.toFixed(1)}%`;
};
const signed = (n) => (n === null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${pctText(n)}`);
const cls = (n) => (n === null ? "" : n > 0.05 ? "up" : n < -0.05 ? "down" : "");
const dateOf = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : null;
};
const shortDate = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const n0 = (v) => Number(v || 0).toLocaleString("en-US");
const short = (a) => (a ? `${String(a).slice(0, 4)}…${String(a).slice(-4)}` : "—");
/** Same coin, same wording; different coins read differently. */
function picker(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  let k = 0;
  return (list) => list[(h + 7 * k++) % list.length];
}
/** The DEX's name for people; the Solana launch curve's own brand is never shown. */
export function dexLabel(d) {
  const s = String(d || "").toLowerCase();
  if (!s || s.includes("pump")) return null;
  const names = { uniswap: "Uniswap", pancakeswap: "PancakeSwap", aerodrome: "Aerodrome", raydium: "Raydium", meteora: "Meteora", orca: "Orca", sushiswap: "SushiSwap", baseswap: "BaseSwap", "fluid": "Fluid" };
  for (const [k, v] of Object.entries(names)) if (s.includes(k)) return v + (/v4/.test(s) ? " v4" : /v3/.test(s) ? " v3" : /v2/.test(s) ? " v2" : "");
  return null;
}
export const coinHref = (n, a) => (n === "solana" ? `${SITE}/x/solana/${encodeURIComponent(String(a))}/` : `${SITE}/x/${encodeURIComponent(n)}/${encodeURIComponent(String(a).toLowerCase())}/`);

/**
 * Everything the section says, as data (also used for the page's meta description and FAQ).
 * c: the coin (live row or archive row); arch: archive row or null; days: coin_days newest first;
 * big: big trades (biggest first); sasa: { trades, usd, traders, last } or null; sasaCoin: launched on sasa.
 */
export function coinStory({ network, address, c, arch, days = [], big = [], sasa = null, sasaCoin = false, quiet = null }) {
  const chain = CHAIN_NAMES[network] || network;
  const pick = picker(address);
  const name = String(c.name || "This coin");
  const sym = String(c.symbol || "");
  const P = pos(c.price_usd);
  const mc = pos(c.mcap_usd) ?? pos(c.fdv_usd);
  const liq = pos(c.liq_usd);
  const vol = pos(c.vol_24h);
  const ch = num(c.change_24h) !== null && Math.abs(num(c.change_24h)) <= 10000 ? num(c.change_24h) : null;
  const buys = num(c.buys_24h) || 0;
  const sells = num(c.sells_24h) || 0;
  const peak = pos(arch?.peak_mcap ?? c.peak_mcap);
  const opened = dateOf(c.pool_created || arch?.pool_created);
  const dex = dexLabel(c.dex || arch?.dex);
  const s = [];

  // who it is
  s.push(
    pick([
      `${name} ($${sym}) is a meme coin on ${chain}${sasaCoin ? " launched on sasa" : ""}${opened ? `, first traded on ${opened}` : ""}.`,
      `${name}, ticker $${sym}, is a ${chain} meme coin${sasaCoin ? " created on sasa" : ""}${opened ? ` whose main pool opened on ${opened}` : ""}.`,
      `$${sym} (${name}) is a meme coin that trades on ${chain}${dex ? `, mostly on ${dex}` : ""}${opened ? `; it launched on ${opened}` : ""}${sasaCoin ? " through sasa" : ""}.`,
    ])
  );
  // where it is now
  if (quiet) s.push(`It is not actively traded right now: the last time it was, on ${dateOf(quiet)}, it was priced at ${price(P)}${mc ? ` for a ${money(mc)} market cap` : ""}.`);
  else if (P || mc)
    s.push(
      pick([
        `It trades at ${price(P)}${mc ? `, a market cap of ${money(mc)}` : ""}${liq ? `, with ${money(liq)} of liquidity in its pool` : ""}.`,
        `${mc ? `Its market cap is ${money(mc)}` : `Its price is ${price(P)}`}${mc && P ? ` at ${price(P)} a coin` : ""}${liq ? `, backed by ${money(liq)} of pool liquidity` : ""}.`,
      ])
    );
  // the last 24 hours
  if (!quiet && (ch !== null || vol)) {
    const move =
      ch === null ? "traded" : ch >= 100 ? `more than doubled (${signed(ch)})` : ch >= 20 ? `rose ${pctText(ch)}` : ch > 2 ? `edged up ${pctText(ch)}` : ch >= -2 ? "held roughly flat" : ch > -20 ? `slipped ${pctText(ch)}` : ch > -50 ? `fell ${pctText(ch)}` : `dropped ${pctText(ch)}`;
    const trades = buys + sells;
    s.push(`In the last 24 hours it ${move}${vol ? ` on ${money(vol)} of volume` : ""}${trades ? ` across ${n0(trades)} trades (${n0(buys)} buys, ${n0(sells)} sells)` : ""}.`);
    if (trades >= 40 && buys > sells * 1.5) s.push(pick(["Buyers clearly outnumbered sellers.", "More wallets were buying than selling."]));
    else if (trades >= 40 && sells > buys * 1.5) s.push(pick(["Sellers outnumbered buyers.", "More wallets were selling than buying."]));
  }
  // its best moment
  if (peak && mc) {
    const off = (1 - mc / peak) * 100;
    if (off > 5) s.push(pick([`Its highest market cap we recorded was ${money(peak)}; it is ${pctText(off)} below that now.`, `At its peak it reached a ${money(peak)} market cap, ${pctText(off)} above where it is today.`]));
    else s.push(`It is at or near the highest market cap we have recorded for it (${money(peak)}).`);
  }
  // the days we tracked
  const closes = days.filter((d) => pos(d.price));
  if (closes.length >= 3) {
    const first = closes[closes.length - 1];
    const last = closes[0];
    const change = (pos(last.price) / pos(first.price) - 1) * 100;
    // a wild jump between two closes is bad data, not a story
    if (Number.isFinite(change) && Math.abs(change) <= 10000)
      s.push(
        pick([
          `Across the ${closes.length} days in its price history below, it went from ${price(first.price)} on ${shortDate(first.day)} to ${price(last.price)} (${signed(change)}).`,
          `Since ${shortDate(first.day)} its daily close moved ${signed(change)}, from ${price(first.price)} to ${price(last.price)}.`,
        ])
      );
  }
  const gainDays = days.filter((d) => num(d.gain_rank));
  if (gainDays.length) s.push(`It made sasa's daily top gainers list ${gainDays.length === 1 ? "once" : `${gainDays.length} times`}, most recently on ${shortDate(gainDays[0].day)} (number ${gainDays[0].gain_rank}).`);
  if (big.length) {
    const top = big[0];
    s.push(`We recorded ${big.length}${big.length >= 10 ? "+" : ""} trade${big.length === 1 ? "" : "s"} of $1,000 or more in the last 7 days; the largest was a ${money(top.usd)} ${top.side === "buy" ? "buy" : "sale"} on ${shortDate(String(top.t).slice(0, 10))}.`);
  }
  // the token check
  const bt = num(arch?.buy_tax ?? c.gp_buy_tax);
  const st = num(arch?.sell_tax ?? c.gp_sell_tax);
  const mint = arch?.mintable ?? c.gp_mintable;
  const top10 = num(arch?.top10 ?? c.gp_top10);
  if (bt !== null || st !== null || top10 !== null) {
    const bits = [];
    if (bt !== null || st !== null) bits.push(!bt && !st ? "no buy or sell tax" : `${bt ? `a ${(bt * 100).toFixed(1)}% buy tax` : "no buy tax"} and ${st ? `a ${(st * 100).toFixed(1)}% sell tax` : "no sell tax"}`);
    if (mint === true) bits.push("the owner can still create more coins");
    if (mint === false) bits.push("no one can create more coins");
    if (top10 !== null) bits.push(`the 10 biggest wallets hold ${(top10 * 100).toFixed(0)}% of the supply`);
    s.push(`Token check: ${bits.join("; ")}.`);
  }
  if (liq && mc && liq / mc < 0.05) s.push("Its liquidity is thin for its size, so large sells can move the price a lot.");
  if (sasa && sasa.trades > 0) s.push(`${n0(sasa.trades)} trade${sasa.trades === 1 ? " worth" : "s worth"} ${money(sasa.usd)} ${sasa.trades === 1 ? "was" : "were"} made on sasa by ${n0(sasa.traders)} trader${sasa.traders === 1 ? "" : "s"}.`);

  const faq = [];
  faq.push({ q: `What is the price of ${name} ($${sym})?`, a: quiet ? `${name} last traded actively on ${dateOf(quiet)} at ${price(P)}.` : `${name} trades at ${price(P)}${ch !== null ? `, ${signed(ch)} in the last 24 hours` : ""}. The price on this page updates live.` });
  if (mc) faq.push({ q: `What is ${name}'s market cap?`, a: `About ${money(mc)}${peak && peak > mc * 1.05 ? `. The highest we recorded was ${money(peak)}` : ""}.` });
  faq.push({ q: `How do I buy ${name}?`, a: `On sasa: log in with your email or a wallet, add USDC and tap Buy on this page. You don't need ${network === "solana" ? "SOL or a Solana wallet" : `${chain}'s gas coin`} or a bridge; sasa routes the trade for you.` });
  if (network !== "solana") faq.push({ q: `Can I set a take profit or stop loss on $${sym}?`, a: "Yes. Use the Auto tab next to Buy and Sell on sasa: pick a price once and the order runs on its own, even with sasa closed. It costs 0.1% when it runs." });
  faq.push({ q: `What is the ${name} contract address?`, a: `${address} on ${chain}. Check the address before you buy: other coins can use the same name or ticker.` });
  faq.push({
    q: `Is ${name} safe?`,
    a: `${bt !== null || st !== null || top10 !== null ? `The token check found ${[!bt && !st ? "no buy or sell tax" : `${bt ? `${(bt * 100).toFixed(1)}% buy tax` : "no buy tax"} and ${st ? `${(st * 100).toFixed(1)}% sell tax` : "no sell tax"}`, top10 !== null ? `the top 10 wallets holding ${(top10 * 100).toFixed(0)}%` : ""].filter(Boolean).join(", with ")}. ` : ""}Coins that can't be sold are never listed on sasa, but every meme coin is very risky and can lose most of its value quickly.`,
  });
  if (opened) faq.push({ q: `When did ${name} launch?`, a: `Its main trading pool opened on ${opened}${dex ? ` on ${dex}` : ""}.` });
  return { sentences: s, faq, chain, name, sym };
}

const CSS = `#coin-seo{font-family:var(--font-sans,system-ui,sans-serif);color:var(--color-ink,#16120f);max-width:72rem;margin:0 auto;padding:0 1rem 2rem}
#coin-seo-slot #coin-seo{max-width:none;padding:0;margin:0}
#coin-seo-slot #coin-seo .cs:first-child{margin-top:0}
#coin-seo .cs{border:1px solid var(--color-line,#eeebe7);background:var(--color-surface,#fff);border-radius:1.5rem;padding:1.25rem;margin-top:1rem}
#coin-seo h2{font-family:var(--font-display,inherit);font-weight:700;font-size:1.125rem;margin:0 0 .75rem}
#coin-seo p{margin:0 0 .6rem;line-height:1.6;color:var(--color-ink-2,#4c4640);font-size:.9375rem}
#coin-seo table{width:100%;border-collapse:collapse;font-size:.8125rem;font-variant-numeric:tabular-nums}
#coin-seo th{color:var(--color-ink-3,#857e77);font-weight:500;text-align:right;padding:.45rem .4rem;border-bottom:1px solid var(--color-line,#eeebe7);white-space:nowrap}
#coin-seo td{padding:.45rem .4rem;text-align:right;border-top:1px solid var(--color-line,#eeebe7);white-space:nowrap}
#coin-seo th:first-child,#coin-seo td:first-child{text-align:left}
#coin-seo .tw{overflow-x:auto}
#coin-seo .up{color:var(--color-up,#12a150)}#coin-seo .down{color:var(--color-danger,#e5484d)}
#coin-seo dl.kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(220px,100%),1fr));gap:.25rem 1.25rem;margin:0}
#coin-seo dl.kv div{display:flex;justify-content:space-between;gap:.75rem;padding:.4rem 0;border-bottom:1px solid var(--color-line,#eeebe7);font-size:.875rem}
#coin-seo dl.kv dt{color:var(--color-ink-3,#857e77)}#coin-seo dl.kv dd{margin:0;font-weight:600;text-align:right;overflow:hidden;text-overflow:ellipsis}
#coin-seo .sim{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:.5rem}
#coin-seo .sim a{display:flex;align-items:center;gap:.6rem;border:1px solid var(--color-line,#eeebe7);border-radius:.875rem;padding:.6rem .75rem;text-decoration:none;color:inherit;min-width:0}
#coin-seo .sim img,#coin-seo .sim i{width:2rem;height:2rem;border-radius:50%;flex:none;object-fit:cover;background:var(--color-paper,#f6f6f4)}
#coin-seo .sim b{display:block;font-size:.875rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#coin-seo .sim small{color:var(--color-ink-3,#857e77);font-size:.75rem}
#coin-seo dl.faq dt{font-weight:600;margin-top:.85rem;font-size:.9375rem}#coin-seo dl.faq dd{margin:.25rem 0 0;color:var(--color-ink-2,#4c4640);font-size:.875rem;line-height:1.55}
#coin-seo .links{display:flex;flex-wrap:wrap;gap:.4rem .9rem;font-size:.875rem}#coin-seo .links a{color:var(--color-emerald,#f2600c);font-weight:600;text-decoration:none}
#coin-seo .note{font-size:.75rem;color:var(--color-ink-3,#857e77)}`;

/** The section's HTML. `similar`: other coins (rows of a coin list); `firstDay`: the first day page there is. */
export function renderCoinSeo(input, { similar = [], firstDay = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const { network, address, c, arch, days = [], big = [], quiet = null } = input;
  const st = coinStory(input);
  const { chain, name, sym } = st;
  const out = [];
  out.push(`<section class="cs"><h2>About ${esc(name)} ($${esc(sym)})</h2>${st.sentences.map((x) => `<p>${esc(x)}</p>`).join("")}<p class="note">Written from live market data${quiet ? "" : ", updated every 30 minutes"}. Meme coins are very risky; nothing here is financial advice.</p></section>`);

  const mc = pos(c.mcap_usd) ?? pos(c.fdv_usd);
  const fdv = pos(c.fdv_usd);
  const peak = pos(arch?.peak_mcap ?? c.peak_mcap);
  const trades = (num(c.buys_24h) || 0) + (num(c.sells_24h) || 0);
  const kv = [
    ["Chain", chain],
    ["Price", price(c.price_usd)],
    ["Market cap", money(mc)],
    fdv && mc && fdv > mc * 1.05 ? ["Fully diluted value", money(fdv)] : null,
    ["Liquidity", money(c.liq_usd)],
    quiet ? null : ["Volume (24h)", money(c.vol_24h)],
    trades && !quiet ? ["Trades (24h)", n0(trades)] : null,
    peak ? ["Highest market cap seen", money(peak)] : null,
    dateOf(c.pool_created || arch?.pool_created) ? ["Pool opened", dateOf(c.pool_created || arch?.pool_created)] : null,
    dexLabel(c.dex || arch?.dex) ? ["Main DEX", dexLabel(c.dex || arch?.dex)] : null,
    ["Contract", short(address)],
  ].filter(Boolean);
  out.push(`<section class="cs"><h2>${esc(name)} key facts</h2><dl class="kv">${kv.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl></section>`);

  const hist = days.filter((d) => pos(d.price)).slice(0, 30);
  if (hist.length >= 2) {
    out.push(
      `<section class="cs"><h2>${esc(name)} price history</h2><p>Daily close, day range, market cap and 24-hour volume (UTC days).</p><div class="tw"><table><thead><tr><th>Day</th><th>Close</th><th>Day range</th><th>Market cap</th><th>Volume</th><th>24h</th></tr></thead><tbody>${hist
        .map((d) => {
          const chg = num(d.chg);
          return `<tr><td>${esc(shortDate(d.day))}</td><td>${price(d.price)}</td><td>${pos(d.price_lo) && pos(d.price_hi) && d.price_hi > d.price_lo ? `${price(d.price_lo)} – ${price(d.price_hi)}` : "—"}</td><td>${money(d.mcap)}</td><td>${money(d.vol)}</td><td class="${cls(chg)}">${signed(chg)}</td></tr>`;
        })
        .join("")}</tbody></table></div></section>`
    );
  }
  if (big.length) {
    out.push(
      `<section class="cs"><h2>Biggest ${esc(sym ? `$${sym}` : name)} trades this week</h2><div class="tw"><table><thead><tr><th>When (UTC)</th><th>Side</th><th>Size</th><th>Wallet</th></tr></thead><tbody>${big
        .map(
          (t) =>
            `<tr><td>${esc(shortDate(String(t.t).slice(0, 10)))} ${esc(String(t.t).slice(11, 16))}</td><td class="${t.side === "buy" ? "up" : "down"}">${t.side === "buy" ? "Buy" : "Sell"}</td><td><b>${money(t.usd)}</b></td><td>${
              TX[network] && t.tx ? `<a href="${TX[network]}${esc(t.tx)}" rel="nofollow noopener" target="_blank">${esc(short(t.wallet))}</a>` : esc(short(t.wallet))
            }</td></tr>`
        )
        .join("")}</tbody></table></div></section>`
    );
  }
  // the days it made sasa's daily pages
  const links = [];
  const slug = DAY_SLUG[network];
  const opened = String(c.pool_created || arch?.pool_created || "").slice(0, 10);
  if (firstDay && slug && opened >= firstDay && opened <= today) links.push([`${SITE}/day/${opened}/${slug}/`, `Launch day: ${shortDate(opened)}`]);
  for (const d of days) {
    if (links.length >= 8) break;
    if (num(d.gain_rank)) links.push([`${SITE}/day/${d.day}/`, `Top gainer #${d.gain_rank} on ${shortDate(d.day)}`]);
    else if (num(d.vol_rank) && num(d.vol_rank) <= 10) links.push([`${SITE}/day/${d.day}/`, `Most traded #${d.vol_rank} on ${shortDate(d.day)}`]);
  }
  const sim = similar.filter((o) => o.address !== address).slice(0, 8);
  if (sim.length)
    out.push(
      `<section class="cs"><h2>Similar ${esc(chain)} meme coins</h2><div class="sim">${sim
        .map((o) => {
          const img = typeof o.image === "string" && o.image.startsWith("https://") ? `<img src="${esc(o.image)}" alt="" loading="lazy" width="32" height="32">` : "<i></i>";
          const ch = num(o.change_24h) !== null && Math.abs(num(o.change_24h)) <= 10000 ? num(o.change_24h) : null;
          return `<a href="${coinHref(o.network, o.address)}">${img}<span style="min-width:0"><b>${esc(o.name)}</b><small>$${esc(o.symbol)} · ${money(pos(o.mcap_usd) ?? pos(o.fdv_usd))}${ch !== null ? ` · <span class="${cls(ch)}">${signed(ch)}</span>` : ""}</small></span></a>`;
        })
        .join("")}</div></section>`
    );
  const top = TOP_SLUG[network];
  const more = [
    ...links,
    ...(top ? [[`${SITE}/top/${top}-meme-coins/`, `Top ${chain} meme coins today`], [`${SITE}/top/${top}-meme-coin-gainers/`, `${chain} gainers today`], [`${SITE}/top/new-${top}-meme-coins/`, `New ${chain} meme coins`]] : []),
    ...(slug ? [[`${SITE}/day/${today}/${slug}/`, `${chain} meme coins today`]] : []),
    ...(GUIDES[network] || []).map(([s, t]) => [`${SITE}/learn/${s}/`, t]),
  ];
  out.push(`<section class="cs"><h2>${links.length ? `${esc(name)} in sasa's daily lists` : "More to explore"}</h2><div class="links">${more.map(([u, t]) => `<a href="${u}">${esc(t)}</a>`).join("")}</div></section>`);
  out.push(`<section class="cs"><h2>${esc(name)} questions</h2><dl class="faq">${st.faq.map((f) => `<dt>${esc(f.q)}</dt><dd>${esc(f.a)}</dd>`).join("")}</dl></section>`);
  return `<style>${CSS}</style><div id="coin-seo" data-coin="${esc(network)}/${esc(address)}">${out.join("")}</div>`;
}

/** Structured data for the page head: FAQ and breadcrumbs. */
export function coinLd(input, pageUrl) {
  const st = coinStory(input);
  const net = input.network;
  return [
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: st.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "sasa", item: `${SITE}/` },
        ...(TOP_SLUG[net] ? [{ "@type": "ListItem", position: 2, name: `${st.chain} meme coins`, item: `${SITE}/top/${TOP_SLUG[net]}-meme-coins/` }] : []),
        { "@type": "ListItem", position: TOP_SLUG[net] ? 3 : 2, name: `${st.name} ($${st.sym})`, item: pageUrl },
      ],
    },
  ];
}
