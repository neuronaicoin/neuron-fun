// Trend agent (Nov 19, 2026): every 4 hours it looks at what crypto is talking about right now and
// writes what it finds to x_trends; the X bot's evening "trend" slots (xbot.mjs) post the best
// fresh one. Free sources only, no keys:
//   - CoinGecko trending: the most searched coins of the last hours (real price / change numbers)
//   - news RSS (CoinDesk, Cointelegraph, Decrypt, The Block): a story counts as HOT only when at
//     least two outlets carry it in the last 8 hours, or it is a hack/exploit/CZ/ETF-type story.
// Posts only state what the source says (headline + outlet, or CoinGecko numbers), nothing made up.

const UA = { "user-agent": "Mozilla/5.0 (compatible; sasapad-trends/1.0; +https://sasapad.fun)", accept: "*/*" };
const FEEDS = [
  ["CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"],
  ["Cointelegraph", "https://cointelegraph.com/rss"],
  ["Decrypt", "https://decrypt.co/feed"],
  ["The Block", "https://www.theblock.co/rss.xml"],
];
const STOP = new Set("the a an and or of to in on for with at by from as is are was be its it this that after over into new says said will could may than up down more about amid how why what who week today crypto price market".split(" "));
// words that make a story the kind people argue about on X
const HOT = [
  [/\b(hack|hacked|exploit|exploited|drain|drained|stolen|heist|attack)\w*/i, "hack", 4],
  [/\b(CZ|Changpeng|Saylor|Musk|Trump|Vitalik|Toly|Ansem|SBF)\b/, "people", 3],
  [/\bETF\b|\bSEC\b|approv|lawsuit|ban\b|bans\b|arrest|charged/i, "rules", 3],
  [/record|all-time high|\bATH\b|surge|soar|rall|crash|plunge|tumble|liquidat/i, "move", 2],
  [/airdrop|listing|lists |delist|launch|memecoin|meme coin|pump\.fun/i, "meme", 2],
];

const SQL = `create table if not exists x_trends (
  id bigserial primary key,
  kind text not null,
  key text not null unique,
  title text not null,
  source text,
  score numeric default 0,
  data jsonb default '{}'::jsonb,
  found_at timestamptz default now(),
  posted_at timestamptz
);
create index if not exists x_trends_fresh on x_trends (found_at desc) where posted_at is null;`;

const get = async (url) => {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.text();
};
const unxml = (s) =>
  String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;|&rsquo;/g, "'")
    .replace(/&#8216;|&lsquo;/g, "'").replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#\d+;/g, "").replace(/\s+/g, " ").trim();
const words = (t) => new Set(t.toLowerCase().replace(/[^a-z0-9$ ]/g, " ").split(" ").filter((w) => w.length > 2 && !STOP.has(w)));

/** Headlines of the last 8 hours from every feed that answers. */
async function headlines(log) {
  const out = [];
  for (const [source, url] of FEEDS) {
    try {
      const xml = await get(url);
      for (const it of xml.split(/<item[\s>]/i).slice(1, 40)) {
        const title = unxml((it.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
        const when = Date.parse(unxml((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1]));
        if (!title || title.length < 20 || title.length > 140) continue;
        if (!Number.isFinite(when) || Date.now() - when > 8 * 3600e3) continue;
        out.push({ source, title, when, w: words(title) });
      }
    } catch (e) {
      log(`x trends: ${source}: ${String(e.message).slice(0, 80)}`);
    }
  }
  return out;
}

/** Score every headline: hot words + how many OTHER outlets carry the same story. */
function rankNews(list) {
  return list
    .map((h) => {
      const also = new Set();
      for (const o of list) {
        if (o.source === h.source) continue;
        let same = 0;
        for (const w of h.w) if (o.w.has(w)) same++;
        if (same >= 3) also.add(o.source);
      }
      let score = also.size * 3, tag = "news";
      for (const [re, t, s] of HOT) if (re.test(h.title)) { score += s; if (tag === "news") tag = t; }
      return { ...h, also: [...also], score, tag };
    })
    .filter((h) => h.also.length >= 1 || h.score >= 4)
    .sort((a, b) => b.score - a.score || b.when - a.when);
}

const money = (s) => Number(String(s || "").replace(/[^0-9.]/g, "")) || 0;

/** The most searched coins on CoinGecko right now. */
async function trendingCoins() {
  const j = JSON.parse(await get("https://api.coingecko.com/api/v3/search/trending"));
  return (j.coins || []).slice(0, 10).map(({ item }, i) => ({
    rank: i + 1,
    id: item.id,
    name: item.name,
    symbol: String(item.symbol || "").toUpperCase(),
    change: Number(item.data?.price_change_percentage_24h?.usd),
    mcap: money(item.data?.market_cap),
    vol: money(item.data?.total_volume),
  }));
}

export async function scanTrends(pool, log) {
  await pool.query(SQL);
  let n = 0;
  const news = rankNews(await headlines(log)).slice(0, 5);
  for (const h of news) {
    const key = `n:${[...h.w].sort().slice(0, 8).join("-")}`.slice(0, 200);
    const r = await pool.query(
      `insert into x_trends (kind, key, title, source, score, data) values ('news', $1, $2, $3, $4, $5)
       on conflict (key) do nothing`,
      [key, h.title, h.source, h.score, { tag: h.tag, also: h.also, when: h.when }]
    ).catch(() => ({ rowCount: 0 }));
    n += r.rowCount || 0;
  }
  try {
    const day = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
    for (const c of await trendingCoins()) {
      if (!c.symbol || !Number.isFinite(c.change) || c.mcap < 1e6) continue;
      const r = await pool.query(
        `insert into x_trends (kind, key, title, source, score, data) values ('coin', $1, $2, 'CoinGecko', $3, $4)
         on conflict (key) do nothing`,
        [`c:${c.id}:${day}`, c.name, 20 - c.rank + Math.min(10, Math.max(0, c.change / 10)), c]
      ).catch(() => ({ rowCount: 0 }));
      n += r.rowCount || 0;
    }
  } catch (e) {
    log(`x trends: coingecko: ${String(e.message).slice(0, 80)}`);
  }
  // keep the table tiny (Supabase quota)
  await pool.query(`delete from x_trends where found_at < now() - interval '7 days'`).catch(() => {});
  log(`x trends: ${n} new (${news.length} hot stories)`);
}

/** Runs the scan now and then every 4 hours. */
export async function trendLoop(pool, log) {
  if (process.env.XBOT_OFF === "1") return;
  await new Promise((r) => setTimeout(r, 90e3)); // let the old instance's db connections close first
  for (;;) {
    const ok = await scanTrends(pool, log).then(() => true, (e) => (log(`x trends: ${String(e.message).slice(0, 200)}`), false));
    await new Promise((r) => setTimeout(r, ok ? 4 * 3600e3 : 10 * 60e3)); // failed: try again in 10 min
  }
}
