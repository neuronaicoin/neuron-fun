// Search and AI engines: tells IndexNow (Bing, Yandex, Seznam, Naver; Bing's
// index also feeds ChatGPT search and Copilot) about sasa pages as soon as
// they change, so new and busy coins show up in search within minutes.
//
//   - a coin launched on sasa: its page, right away
//   - a coin traded on sasa: its page again, at most once every 6 hours
//   - coins from other DEXs that trade: their pages, at most once a day each,
//     busiest first (new pools first)
//   - the daily "top meme coins" lists: every 6 hours
//   - every page in sasa's sitemap: once a day
//
// Turn off with SEO_PING=off. The key file lives at sasapad.fun/<key>.txt.

const SITE = (process.env.SITE_URL || "https://sasapad.fun").replace(/\/$/, "");
const HOST = new URL(SITE).host;
const KEY = process.env.INDEXNOW_KEY || "ba976996d56d88909a85f1b971ae913a";
const ENDPOINT = "https://api.indexnow.org/indexnow";
const TICK_MS = 2 * 60_000;
const OURS_AGAIN_MS = 6 * 3600_000;
const EXT_AGAIN_MS = 24 * 3600_000;
const SITEMAP_EVERY_MS = 24 * 3600_000;
const TOP_EVERY_MS = 6 * 3600_000;
const TOP_PAGES = ["", "trending-meme-coins", "robinhood-chain-meme-coins", "base-meme-coins", "bnb-chain-meme-coins", "ethereum-meme-coins", "arc-meme-coins", "meme-coin-gainers", "new-meme-coins", "robinhood-chain-meme-coin-gainers", "new-robinhood-chain-meme-coins", "base-meme-coin-gainers", "new-base-meme-coins", "bnb-chain-meme-coin-gainers", "new-bnb-chain-meme-coins", "ethereum-meme-coin-gainers", "new-ethereum-meme-coins", "arc-meme-coin-gainers", "new-arc-meme-coins"].map((s) => `${SITE}/top/${s ? `${s}/` : ""}`);
const EXT_PER_TICK = 150; // about 4,000 a day at most
const MAX_PER_REQUEST = 9_000; // IndexNow accepts up to 10,000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const coinUrl = (id) => `${SITE}/coin/?id=${encodeURIComponent(id)}`;
const extUrl = (network, address) => `${SITE}/x/?n=${network}&a=${address}`;

/** When each page was last sent (kept in memory; a restart only re-sends a few). */
const sent = new Map();
const due = (url, again, now) => now - (sent.get(url) ?? 0) >= again;

export async function submit(urls, log) {
  const list = [...new Set(urls)].filter((u) => u.startsWith(SITE));
  for (let i = 0; i < list.length; i += MAX_PER_REQUEST) {
    const urlList = list.slice(i, i + MAX_PER_REQUEST);
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `${SITE}/${KEY}.txt`, urlList }),
      signal: AbortSignal.timeout(20_000),
    });
    // 200 = taken, 202 = taken (key check pending). 429 = slow down.
    if (r.status === 429) throw Object.assign(new Error("IndexNow rate limit"), { retry: true });
    if (r.status !== 200 && r.status !== 202) throw new Error(`IndexNow answered ${r.status}`);
    const now = Date.now();
    for (const u of urlList) sent.set(u, now);
  }
  return list.length;
}

async function sitemapUrls() {
  const out = [];
  for (const path of ["/sitemap.xml", "/forum/sitemap.xml"]) {
    try {
      const r = await fetch(`${SITE}${path}`, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) continue;
      const xml = await r.text();
      for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) out.push(m[1].replace(/&amp;/g, "&").trim());
    } catch {}
  }
  return out;
}

export async function seoLoop(pool, log) {
  if ((process.env.SEO_PING || "").toLowerCase() === "off") {
    log("seo: IndexNow pings off (SEO_PING=off)");
    return;
  }
  let since = new Date(Date.now() - 15 * 60_000);
  let lastSitemap = 0;
  let pause = 0;
  for (;;) {
    const started = new Date();
    try {
      if (pause > Date.now()) {
        await sleep(TICK_MS);
        continue;
      }
      const now = Date.now();
      const urls = [];

      // Coins launched on sasa since the last round.
      const { rows: fresh } = await pool.query(`select id from coins where created_at > $1 order by created_at limit 2000`, [since]);
      for (const c of fresh) {
        const u = coinUrl(c.id);
        if (!sent.has(u)) urls.push(u);
      }

      // Coins traded on sasa since the last round.
      const { rows: traded } = await pool.query(`select distinct coin_id from trades where ts > $1 and coin_id is not null limit 5000`, [since]);
      for (const t of traded) {
        const u = coinUrl(t.coin_id);
        if (due(u, OURS_AGAIN_MS, now)) urls.push(u);
      }

      // Coins from other DEXs that are trading: new pools first, then by volume.
      try {
        const { rows: ext } = await pool.query(
          `select network, address from ext_coins
           where coalesce(vol_24h, 0) > 0 and coalesce(buys_24h, 0) + coalesce(sells_24h, 0) > 0
           order by (pool_created > now() - interval '1 day') desc nulls last, vol_24h desc nulls last
           limit 4000`
        );
        let n = 0;
        for (const e of ext) {
          if (n >= EXT_PER_TICK) break;
          const u = extUrl(e.network, e.address);
          if (due(u, EXT_AGAIN_MS, now)) {
            urls.push(u);
            n++;
          }
        }
      } catch (e) {
        if (!/does not exist/.test(e.message)) throw e;
      }

      // The daily "top meme coins" lists change all day: every 6 hours.
      if (TOP_PAGES.some((u) => due(u, TOP_EVERY_MS, now))) urls.push(...TOP_PAGES);

      // Everything in the sitemaps, once a day (Learn, forum boards, main pages).
      if (now - lastSitemap >= SITEMAP_EVERY_MS) {
        const all = await sitemapUrls();
        if (all.length) {
          urls.push(...all);
          lastSitemap = now;
        }
      }

      if (urls.length) {
        const n = await submit(urls, log);
        log(`seo: sent ${n} pages to IndexNow (${fresh.length} new coins, ${traded.length} traded)`);
      }
      since = started;
    } catch (e) {
      log(`seo: ${e.message}`);
      if (e.retry) pause = Date.now() + 30 * 60_000;
    }
    // Keep the memory small: forget pages sent more than two days ago.
    if (sent.size > 50_000) {
      const old = Date.now() - 2 * EXT_AGAIN_MS;
      for (const [u, t] of sent) if (t < old) sent.delete(u);
    }
    await sleep(TICK_MS);
  }
}
