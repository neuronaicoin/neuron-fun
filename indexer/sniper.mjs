/**
 * sasa Bot, test mode (admins only, Oct 2026): watches every new pump.fun coin live, scores it
 * the way the auto-trade bot will, and writes down what a bot would have done and how it would
 * have ended — without spending anything. The admin page /admin/bot/ shows the results, so the
 * filters are tuned on real numbers before the bot trades anyone's money.
 *
 * For each new coin:
 *   0–2 s   the coin's links (X, Telegram, website) from its info file; Telegram member count
 *           (public page), website up + domain age, links / picture / ticker reused by other coins
 *   0–15 s  every trade: unique buyers, buys vs sells, SOL in, the creator's buy and sells,
 *           wallets that bought in the launch's own block (bundles / snipers), top 10 wallets
 *   15 s    the decision: hard rules (any one fails the coin) and a score 0–100; coins that are
 *           close get their X account checked (followers, age; paid per lookup, capped per day)
 *   →60 min the outcome from the decision price: peak, lowest, and whether +50% (take profit) or
 *           −20% (stop loss) came first
 *
 * Env (Railway, indexer service):
 *   SOLANA_RPC_URL     the Helius URL (also used for the live feed, over its websocket)
 *   SNIPER_OFF=1       switches this off
 *   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET   X lookups (same keys as the X bot);
 *                      without them X accounts aren't checked
 *   SNIPER_X_PER_DAY   most X lookups a day (default 300)
 */
import { createRequire } from "node:module";
import { oauthHeader } from "./xbot.mjs";

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const WSOL = "So11111111111111111111111111111111111111112";
const SUPPLY_RAW = 1e15; // 1,000,000,000 coins × 10^6

// the decision
export const RULES = {
  decideSec: 15, // seconds after launch
  maxWaitSec: 25, // waits this long at most for the links to be read
  lateMultiple: 2.5, // already this far above the launch price: too late
  devMaxPct: 10, // creator's own buy above this share of the coins: no
  devLaunches24h: 3, // creator launched more than this many coins in 24 h: no
  bundleMaxPct: 25, // other wallets in the launch's own block hold more than this: no
  top10MaxPct: 40, // top 10 wallets (not the creator) hold more than this: no
  minBuyers: 5, // fewer unique buyers than this by the decision: no
  xMinFollowers: 20,
  xLookupFrom: 45, // only coins scoring at least this get their X account checked
  followMin: 60, // minutes the price is followed after the decision
};
// the outcome
const TAKE_PROFIT = 1.5;
const STOP_LOSS = 0.8;
export const LEVELS = { safe: 80, balanced: 65, aggressive: 50 };

export const SQL = `create table if not exists sniper_signals (
  mint        text primary key,
  created_at  timestamptz not null,
  decided_at  timestamptz,
  name        text,
  symbol      text,
  creator     text,
  x           text,
  telegram    text,
  website     text,
  score       int,
  passed      boolean not null default false,
  fail        text,
  checks      jsonb,
  start_mc    double precision,
  entry_mc    double precision,
  peak_mc     double precision,
  low_mc      double precision,
  peak_sec    int,
  result      text,
  done        boolean not null default false
);
create index if not exists sniper_signals_time on sniper_signals (created_at desc);
create index if not exists sniper_signals_score on sniper_signals (score desc, created_at desc);
alter table sniper_signals enable row level security;
revoke all on sniper_signals from anon, authenticated;
create or replace function sniper_stats(p_hours int) returns jsonb language sql stable as $$
  with s as (select * from sniper_signals where created_at > now() - make_interval(hours => greatest(1, least(p_hours, 24 * 14))))
  select jsonb_build_object(
    'coins', (select count(*) from s),
    'decided', (select count(*) from s where entry_mc is not null),
    'with_links', (select count(*) from s where x is not null or telegram is not null or website is not null),
    'levels', (select jsonb_agg(jsonb_build_object(
        'level', l.name, 'min', l.min,
        'picked', (select count(*) from s where passed and score >= l.min),
        'wins', (select count(*) from s where passed and score >= l.min and result = 'win'),
        'losses', (select count(*) from s where passed and score >= l.min and result = 'loss'),
        'open', (select count(*) from s where passed and score >= l.min and (result is null or result = 'open')),
        'hit_25k', (select count(*) from s where passed and score >= l.min and peak_mc >= 25000),
        'avg_peak_x', (select round(avg(peak_mc / nullif(entry_mc, 0))::numeric, 2) from s where passed and score >= l.min and done)
      ) order by l.min desc)
      from (values ('safe', ${LEVELS.safe}), ('balanced', ${LEVELS.balanced}), ('aggressive', ${LEVELS.aggressive})) as l(name, min)),
    'fails', (select jsonb_object_agg(f, n) from (select coalesce(fail, 'low score') as f, count(*) as n from s where entry_mc is not null and not passed group by 1 order by 2 desc limit 12) x)
  );
$$;
revoke all on function sniper_stats(int) from public, anon, authenticated;
grant execute on function sniper_stats(int) to service_role;
grant select on sniper_signals to service_role;
notify pgrst, 'reload schema';`;

// ------------------------------------------------------------------ reading pump.fun's events

const CREATE = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const TRADE = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const COMPLETE = Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]);

function reader(b, at = 8) {
  let o = at;
  const need = (n) => {
    if (o + n > b.length) throw new Error("short");
  };
  return {
    str() {
      need(4);
      const n = b.readUInt32LE(o);
      o += 4;
      need(n);
      const s = b.toString("utf8", o, o + n);
      o += n;
      return s;
    },
    key() {
      need(32);
      const k = b.subarray(o, o + 32);
      o += 32;
      return k;
    },
    u64() {
      need(8);
      const v = b.readBigUInt64LE(o);
      o += 8;
      return v;
    },
    i64() {
      need(8);
      const v = b.readBigInt64LE(o);
      o += 8;
      return v;
    },
    bool() {
      need(1);
      return b[o++] !== 0;
    },
    left: () => b.length - o,
  };
}

/** One pump.fun event from a "Program data:" log line (null for any other event). Keys stay as bytes (hex) until stored. */
export function decodeEvent(b64) {
  let b;
  try {
    b = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (b.length < 8) return null;
  const head = b.subarray(0, 8);
  try {
    if (head.equals(TRADE)) {
      const r = reader(b);
      const mint = r.key();
      const sol = r.u64();
      const tokens = r.u64();
      const buy = r.bool();
      const user = r.key();
      r.i64();
      const vSol = r.u64();
      const vTok = r.u64();
      return { kind: "trade", mint: mint.toString("hex"), sol: Number(sol), tokens: Number(tokens), buy, user: user.toString("hex"), vSol: Number(vSol), vTok: Number(vTok) };
    }
    if (head.equals(CREATE)) {
      const r = reader(b);
      const name = r.str();
      const symbol = r.str();
      const uri = r.str();
      const mint = r.key();
      r.key(); // bonding curve
      const user = r.key();
      const creator = r.key();
      r.i64();
      const vTok = Number(r.u64());
      const vSol = Number(r.u64());
      r.u64();
      r.u64();
      // newer launches: token program, two flags, then the quote coin (SOL or something else)
      let quote = null;
      if (r.left() >= 32 + 2 + 32) {
        r.key();
        r.bool();
        r.bool();
        quote = r.key();
      }
      return { kind: "create", name, symbol, uri, mint: mint.toString("hex"), user: user.toString("hex"), creator: creator.toString("hex"), vSol, vTok, quote };
    }
    if (head.equals(COMPLETE)) {
      const r = reader(b);
      r.key(); // user
      const mint = r.key();
      return { kind: "complete", mint: mint.toString("hex") };
    }
  } catch {
    return null;
  }
  return null;
}

// ------------------------------------------------------------------ links

const lower = (s) => String(s || "").trim().toLowerCase();

/** The coin's X link: its own account (profile), a post someone made, or a community. */
export function parseX(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^mobile\./, "").toLowerCase();
  if (host !== "x.com" && host !== "twitter.com") return null;
  const p = u.pathname.split("/").filter(Boolean);
  if (!p.length) return null;
  if (p[0] === "i" && p[1] === "communities" && p[2]) return { kind: "community", id: p[2], key: `xc:${p[2]}` };
  if (p[0] === "i") return null;
  // X's own pages (a search for the ticker, a hashtag…) aren't anyone's account
  if (/^(search|hashtag|home|explore|intent|share|messages|notifications|settings|login|signup|tos|privacy|compose)$/i.test(p[0])) return null;
  const handle = p[0].replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  if (p[1] === "status" && p[2]) return { kind: "post", handle, id: p[2], key: `xp:${p[2]}` };
  return { kind: "profile", handle, key: `xu:${handle.toLowerCase()}` };
}

/** A public Telegram group/channel name (invite links can't be looked up). */
export function parseTelegram(raw) {
  const s = String(raw || "").trim();
  const m = /(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,32})\/?$/i.exec(s.split("?")[0]);
  if (!m || /^(joinchat|addlist|share|s)$/i.test(m[1])) return null;
  return m[1];
}

export function parseWebsite(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (!host.includes(".")) return null;
    // social sites and link pages aren't a website of the coin's own
    if (/(^|\.)(x\.com|twitter\.com|t\.me|telegram\.me|pump\.fun|dexscreener\.com|linktr\.ee|youtube\.com|tiktok\.com|instagram\.com|facebook\.com|google\.com)$/.test(host))
      return { url: u.toString(), host, own: false };
    return { url: u.toString(), host, own: true };
  } catch {
    return null;
  }
}

async function getText(url, ms = 4000, max = 300_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; sasa-bot)" } });
    const text = (await r.text()).slice(0, max);
    return { ok: r.ok, status: r.status, text };
  } finally {
    clearTimeout(t);
  }
}

/** Members of a public Telegram group or channel, from its public page (null when unknown). */
export function telegramMembers(html) {
  const m = /tgme_page_extra">\s*([\d\s,.]+)\s*(members|subscribers)/i.exec(html);
  if (!m) return null;
  const n = Number(m[1].replace(/[\s,.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Days since the domain was registered (null when unknown). */
async function domainAgeDays(host) {
  const parts = host.split(".");
  const domain = parts.slice(-2).join(".");
  try {
    const r = await getText(`https://rdap.org/domain/${domain}`, 4000, 200_000);
    if (!r.ok) return null;
    const j = JSON.parse(r.text);
    const ev = (j.events || []).find((e) => e.eventAction === "registration");
    const t = ev ? Date.parse(ev.eventDate) : NaN;
    return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400_000) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ X lookups

const xCache = new Map(); // handle → { followers, ageDays, ok } | null (no such account)
let xDay = "";
let xUsed = 0;

async function xLookup(handle, log) {
  const k = handle.toLowerCase();
  if (xCache.has(k)) return xCache.get(k);
  const keys = { apiKey: process.env.X_API_KEY, apiSecret: process.env.X_API_SECRET, accessToken: process.env.X_ACCESS_TOKEN, accessSecret: process.env.X_ACCESS_SECRET };
  if (!keys.apiKey || !keys.apiSecret || !keys.accessToken || !keys.accessSecret) return undefined;
  const day = new Date().toISOString().slice(0, 10);
  if (day !== xDay) {
    xDay = day;
    xUsed = 0;
  }
  if (xUsed >= Number(process.env.SNIPER_X_PER_DAY || 300)) return undefined;
  xUsed++;
  const url = `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=public_metrics,created_at`;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(url, { headers: { authorization: oauthHeader("GET", url, keys) }, signal: ctl.signal }).finally(() => clearTimeout(t));
    const j = await r.json().catch(() => ({}));
    if (r.status === 429 || r.status >= 500) return undefined;
    if (!r.ok && r.status !== 404) {
      log(`bot test: X lookup ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
      return undefined;
    }
    const u = j.data;
    const out = u
      ? {
          followers: Number(u.public_metrics?.followers_count ?? 0),
          ageDays: u.created_at ? Math.floor((Date.now() - Date.parse(u.created_at)) / 86400_000) : null,
        }
      : null;
    xCache.set(k, out);
    if (xCache.size > 20_000) xCache.delete(xCache.keys().next().value);
    return out;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ the scanner

/** Market cap in dollars from the curve's virtual reserves. */
export const mcOf = (vSol, vTok, solUsd) => (vTok > 0 ? (vSol / 1e9 / (vTok / 1e6)) * 1e9 * solUsd : 0);

/**
 * The decision for one coin (pure: the test runs it on made-up coins). Returns
 * { score, fail, checks } — fail is the first hard rule the coin broke (null when none).
 */
export function judge(c, now, R = RULES) {
  const checks = {};
  let score = 0;
  let fail = null;
  const no = (why) => {
    if (!fail) fail = why;
  };
  const sec = (now - c.t0) / 1000;
  checks.sec = Math.round(sec);

  // links (up to 30)
  const x = c.x;
  checks.x = x ? x.kind : null;
  if (!x && !c.telegram && !c.site) no("no links");
  if (x?.kind === "profile") score += 10;
  else if (x?.kind === "community") score += 6;
  else if (x?.kind === "post") score += 3;
  if (c.telegram) {
    score += 4;
    checks.tg = c.tgMembers;
    if (c.tgMembers != null && c.tgMembers >= 500) score += 6;
    else if (c.tgMembers != null && c.tgMembers >= 100) score += 3;
  }
  if (c.site?.own) {
    checks.site = c.siteUp;
    checks.domainDays = c.domainDays;
    if (c.siteUp) score += 5;
    if (c.domainDays != null && c.domainDays >= 7) score += 5;
    if (c.siteUp === false) score -= 5;
  }
  if (c.reused) no(`reused ${c.reused}`);
  if (c.samePost) {
    checks.samePost = true;
    score -= 10;
  }
  if (c.copyTicker) {
    checks.copyTicker = c.copyTicker;
    score -= 5;
  }

  // creator (up to 20)
  const devPct = (c.devTokens / SUPPLY_RAW) * 100;
  checks.devPct = +devPct.toFixed(1);
  checks.devLaunches = c.devLaunches;
  if (c.devSold) no("creator sold");
  if (devPct > R.devMaxPct) no("creator holds too much");
  else if (devPct <= 5) score += 10;
  else score += 4;
  if (c.devLaunches > R.devLaunches24h) no("serial launcher");
  else if (c.devLaunches <= 1) score += 10;
  else score += 3;
  if (c.devRugs > 0) no("creator dumped before");

  // launch block (up to 15)
  const bundlePct = (c.bundleTokens / SUPPLY_RAW) * 100;
  checks.bundlePct = +bundlePct.toFixed(1);
  if (bundlePct > R.bundleMaxPct) no("bundled");
  else if (bundlePct < 10) score += 15;
  else if (bundlePct < 20) score += 5;

  // holders
  const held = [...c.holders.entries()].filter(([w, v]) => w !== c.creator && v > 0).map(([, v]) => v);
  held.sort((a, b) => b - a);
  const top10 = (held.slice(0, 10).reduce((n, v) => n + v, 0) / SUPPLY_RAW) * 100;
  checks.top10 = +top10.toFixed(1);
  if (top10 > R.top10MaxPct) no("top 10 hold too much");

  // momentum (up to 35)
  const buyers = c.buyers.size;
  checks.buyers = buyers;
  checks.buys = c.buys;
  checks.sells = c.sells;
  const inSol = (c.solIn - c.solOut) / 1e9;
  checks.netSol = +inSol.toFixed(2);
  const mult = c.startMc > 0 ? c.mc / c.startMc : 0;
  checks.mult = +mult.toFixed(2);
  if (buyers < R.minBuyers) no("few buyers");
  if (mult >= R.lateMultiple) no("too late");
  if (mult < 1) no("falling");
  if (buyers >= 20) score += 15;
  else if (buyers >= 10) score += 10;
  else if (buyers >= R.minBuyers) score += 4;
  const ratio = c.sells ? c.buys / c.sells : c.buys;
  if (ratio >= 3) score += 10;
  else if (ratio >= 1.5) score += 5;
  if (inSol >= 3) score += 10;
  else if (inSol >= 1) score += 5;

  // X account (looked up only when the coin is close)
  if (c.xInfo !== undefined) {
    checks.xFollowers = c.xInfo?.followers ?? 0;
    checks.xAgeDays = c.xInfo?.ageDays ?? null;
    if (c.xInfo === null) no("X account missing");
    else {
      if (c.xInfo.followers < R.xMinFollowers) no("X followers < 20");
      else if (c.xInfo.followers >= 500) score += 10;
      else if (c.xInfo.followers >= 100) score += 5;
      if (c.xInfo.ageDays != null && c.xInfo.ageDays < 2) score -= 10;
    }
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), fail, checks };
}

export async function sniperLoop(pool, log) {
  if (process.env.SNIPER_OFF === "1") return log("bot test off (SNIPER_OFF=1)");
  const rpc = process.env.SOLANA_RPC_URL;
  if (!rpc) return log("bot test waiting: set SOLANA_RPC_URL (Helius) to turn it on");
  await pool.query(SQL);
  const web3 = require("@solana/web3.js");
  const hexToB58 = (h) => new web3.PublicKey(Buffer.from(h, "hex")).toBase58();

  let solUsd = 0;
  const price = async () => {
    try {
      const r = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot");
      const v = Number((await r.json())?.data?.amount);
      if (v > 0) solUsd = v;
    } catch {}
  };
  await price();
  setInterval(price, 60_000).unref();

  const coins = new Map(); // mint hex → coin being watched
  const seen = new Map(); // link / picture key → { mint, at } (24 h)
  const tickers = new Map(); // ticker → [times] (1 h)
  const devs = new Map(); // creator hex → { launches: [times], rugs }
  const launched = new Map(); // mint hex → { creator, t0 } for 10 min (creators who dump early)
  let events = 0;
  let lastEvent = Date.now();

  const remember = (key, mint) => {
    if (!key) return null;
    const had = seen.get(key);
    if (had && had.mint !== mint && Date.now() - had.at < 86400_000) return had.mint;
    if (!had) seen.set(key, { mint, at: Date.now() });
    return null;
  };

  async function enrich(c) {
    try {
      const r = await getText(c.uri, 4000, 100_000);
      const m = JSON.parse(r.text);
      c.x = parseX(m.twitter);
      const tg = parseTelegram(m.telegram);
      c.telegram = tg;
      c.site = parseWebsite(m.website);
      c.links = { x: m.twitter || null, telegram: m.telegram || null, website: m.website || null };
      // the same link or picture on another coin (24 h): a copy, or a recycled scam
      const reused =
        (c.x && c.x.kind !== "post" && remember(c.x.key, c.mint) && "X") ||
        (tg && remember(`tg:${tg.toLowerCase()}`, c.mint) && "Telegram") ||
        (c.site?.own && remember(`w:${c.site.host}`, c.mint) && "website") ||
        (m.image && remember(`img:${String(m.image).replace(/^.*\/ipfs\//, "")}`, c.mint) && "picture");
      if (reused) c.reused = reused;
      // many coins point at the same viral post (the story they're about): not a scam on its own,
      // but every coin after the first is a copy of the same idea
      if (c.x?.kind === "post" && remember(c.x.key, c.mint)) c.samePost = true;
      const jobs = [];
      if (tg)
        jobs.push(
          getText(`https://t.me/${tg}`, 4000, 200_000)
            .then((p) => (c.tgMembers = telegramMembers(p.text)))
            .catch(() => {})
        );
      if (c.site?.own) {
        jobs.push(
          getText(c.site.url, 4000, 50_000)
            .then((p) => (c.siteUp = p.ok && p.text.length > 300))
            .catch(() => (c.siteUp = false))
        );
        jobs.push(domainAgeDays(c.site.host).then((d) => (c.domainDays = d)));
      }
      await Promise.all(jobs);
    } catch {
      // no info file or a broken one: judged without links
    } finally {
      c.enriched = true;
    }
  }

  function onCreate(e, slot) {
    // coins priced in something other than SOL are left out
    if (e.quote && !e.quote.every((v) => v === 0) && new web3.PublicKey(e.quote).toBase58() !== WSOL) return;
    const now = Date.now();
    const dev = devs.get(e.creator) ?? { launches: [], rugs: 0 };
    dev.launches = dev.launches.filter((t) => now - t < 86400_000);
    dev.launches.push(now);
    devs.set(e.creator, dev);
    const tk = lower(e.symbol);
    const times = (tickers.get(tk) ?? []).filter((t) => now - t < 3600_000);
    times.push(now);
    tickers.set(tk, times);
    const startMc = mcOf(e.vSol, e.vTok, solUsd);
    const c = {
      mint: e.mint,
      t0: now,
      slot,
      name: e.name.slice(0, 64),
      symbol: e.symbol.slice(0, 16),
      uri: e.uri,
      creator: e.creator,
      startMc,
      mc: startMc,
      devTokens: 0,
      devSold: false,
      devLaunches: dev.launches.length,
      devRugs: dev.rugs,
      copyTicker: times.length >= 3 ? times.length : 0,
      bundleTokens: 0,
      holders: new Map(),
      buyers: new Set(),
      buys: 0,
      sells: 0,
      solIn: 0,
      solOut: 0,
      decided: false,
    };
    coins.set(e.mint, c);
    launched.set(e.mint, { creator: e.creator, t0: now });
    if (/^https?:\/\//i.test(e.uri)) void enrich(c);
    else c.enriched = true;
  }

  function onTrade(e, slot) {
    // the creator selling in the first 10 minutes marks them for their next coins
    if (!e.buy) {
      const l = launched.get(e.mint);
      if (l && l.creator === e.user && !l.rug && Date.now() - l.t0 < 10 * 60_000) {
        l.rug = true;
        const d = devs.get(e.user);
        if (d) d.rugs++;
      }
    }
    const c = coins.get(e.mint);
    if (!c) return;
    c.mc = mcOf(e.vSol, e.vTok, solUsd);
    if (!c.decided) {
      const delta = e.buy ? e.tokens : -e.tokens;
      c.holders.set(e.user, (c.holders.get(e.user) ?? 0) + delta);
      if (e.buy) {
        c.buys++;
        c.solIn += e.sol;
        if (e.user !== c.creator) c.buyers.add(e.user);
      } else {
        c.sells++;
        c.solOut += e.sol;
      }
      if (e.user === c.creator) {
        if (e.buy) c.devTokens += e.tokens;
        else c.devSold = true;
      } else if (e.buy && slot <= c.slot) c.bundleTokens += e.tokens;
    } else if (c.entryMc) {
      // after the decision: the path from the decision price
      if (c.mc > c.peak) {
        c.peak = c.mc;
        c.peakAt = Date.now();
      }
      if (c.mc < c.low) c.low = c.mc;
      if (!c.result) {
        if (c.mc >= c.entryMc * TAKE_PROFIT) c.result = "win";
        else if (c.mc <= c.entryMc * STOP_LOSS) c.result = "loss";
      }
    }
  }

  async function decide(c) {
    c.decided = true;
    const now = Date.now();
    let j = judge(c, now);
    // close enough: its X account is worth a lookup
    if (!j.fail && c.x?.kind === "profile" && j.score >= RULES.xLookupFrom) {
      c.xInfo = await xLookup(c.x.handle, log);
      j = judge(c, now);
    }
    c.entryMc = c.mc;
    c.peak = c.mc;
    c.low = c.mc;
    c.peakAt = now;
    c.score = j.score;
    c.passed = !j.fail;
    // only the price path is needed from here on
    c.holders = null;
    c.buyers = null;
    // coins nobody could pass are watched no further (keeps the work small)
    const follow = c.passed || j.score >= LEVELS.aggressive - 15;
    if (!follow) coins.delete(c.mint);
    await pool
      .query(
        `insert into sniper_signals (mint, created_at, decided_at, name, symbol, creator, x, telegram, website, score, passed, fail, checks, start_mc, entry_mc, peak_mc, low_mc, done)
         values ($1, to_timestamp($2 / 1000.0), now(), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, $14, $15)
         on conflict (mint) do nothing`,
        [
          hexToB58(c.mint),
          c.t0,
          c.name,
          c.symbol,
          hexToB58(c.creator),
          c.links?.x ?? null,
          c.links?.telegram ?? null,
          c.links?.website ?? null,
          j.score,
          c.passed,
          j.fail,
          JSON.stringify(j.checks),
          c.startMc,
          c.entryMc,
          !follow,
        ]
      )
      .catch((e) => log(`bot test: save failed: ${e.message}`));
  }

  async function finish(c) {
    coins.delete(c.mint);
    await pool
      .query(`update sniper_signals set peak_mc = $2, low_mc = $3, peak_sec = $4, result = $5, done = true where mint = $1`, [
        hexToB58(c.mint),
        c.peak,
        c.low,
        Math.round((c.peakAt - c.t0) / 1000),
        c.result ?? "open",
      ])
      .catch((e) => log(`bot test: update failed: ${e.message}`));
  }

  // the clock: decisions and endings
  const tick = setInterval(() => {
    const now = Date.now();
    for (const c of coins.values()) {
      if (!c.decided) {
        const age = (now - c.t0) / 1000;
        if (age >= RULES.decideSec && (c.enriched || age >= RULES.maxWaitSec)) void decide(c);
      } else if (c.entryMc && now - c.t0 >= RULES.followMin * 60_000) void finish(c);
      else if (c.entryMc && now - (c.savedAt ?? 0) >= 60_000 && (c.peak !== c.savedPeak || c.low !== c.savedLow || c.result !== c.savedResult)) {
        // the admin page sees the path while it's followed (every minute at most)
        c.savedAt = now;
        c.savedPeak = c.peak;
        c.savedLow = c.low;
        c.savedResult = c.result;
        pool
          .query(`update sniper_signals set peak_mc = $2, low_mc = $3, peak_sec = $4, result = $5 where mint = $1 and not done`, [
            hexToB58(c.mint),
            c.peak,
            c.low,
            Math.round((c.peakAt - c.t0) / 1000),
            c.result ?? null,
          ])
          .catch(() => {});
      }
    }
    // keep the memory small
    if (seen.size > 200_000) for (const [k, v] of seen) if (now - v.at > 86400_000) seen.delete(k);
    if (devs.size > 200_000) for (const [k, v] of devs) if (!v.launches.some((t) => now - t < 86400_000)) devs.delete(k);
    if (tickers.size > 50_000) tickers.clear();
    for (const [k, v] of launched) if (now - v.t0 > 10 * 60_000) launched.delete(k);
    else break; // oldest first
  }, 1000);

  // the feed: every pump.fun transaction, over the node's websocket
  let conn = null;
  let sub = null;
  const connect = async () => {
    if (conn && sub !== null) await conn.removeOnLogsListener(sub).catch(() => {});
    conn = new web3.Connection(rpc, { commitment: "confirmed", wsEndpoint: rpc.replace(/^http/, "ws") });
    sub = conn.onLogs(
      new web3.PublicKey(PUMP),
      (l, ctx) => {
        if (l.err) return;
        lastEvent = Date.now();
        for (const line of l.logs) {
          if (!line.startsWith("Program data: ")) continue;
          const e = decodeEvent(line.slice(14));
          if (!e) continue;
          events++;
          if (e.kind === "create") onCreate(e, ctx.slot);
          else if (e.kind === "trade") onTrade(e, ctx.slot);
          else if (e.kind === "complete") {
            const c = coins.get(e.mint);
            if (c?.entryMc && !c.result) c.result = "win"; // moved to its pool: well above any take profit
          }
        }
      },
      "confirmed"
    );
  };
  await connect();
  log("bot test: watching pump.fun live");

  // a quiet feed for a minute means the connection dropped: open a new one
  for (let n = 0; ; n++) {
    await sleep(30_000);
    if (Date.now() - lastEvent > 60_000) {
      log("bot test: feed quiet for a minute, reconnecting");
      await connect().catch((e) => log(`bot test: reconnect failed: ${e.message}`));
      lastEvent = Date.now();
    }
    if (n % 20 === 0) {
      log(`bot test: ${events} events, ${coins.size} coins watched`);
      await pool.query(`delete from sniper_signals where created_at < now() - interval '14 days'`).catch(() => {});
    }
  }
  // (never returns; the interval keeps deciding)
  // eslint-disable-next-line no-unreachable
  clearInterval(tick);
}
