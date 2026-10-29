// @sasapadfun on X: posts on its own timeline only, by itself, with a picture card.
//
//   - whale moves: a top-30 trader (Data tab) opens, flips, adds to or closes a position worth
//     $500K or more (whale_moves, written by whales.mjs)
//   - predictions: now and then an open BTC / ETH price question that is close to 50/50
//   - sasa races: a decided race (coin, chains, winner), at most 2 a day
//   - recap: the day's best traders so far, every 8 hours (3 a day)
//   - stocks: the biggest stock / commodity futures mover, every 8 hours (3 a day)
//   - fear & greed: once a day
//
// It never replies, mentions, follows, likes or reads anyone's posts (X's automation rules allow
// automated posts on your own account; automated replies to others are not allowed). No links in
// the text (a post with a link costs much more on X's pay-per-use API; the link is on the profile).
//
// Limits: at most XBOT_PER_DAY posts in 24 hours (default 30), at least XBOT_GAP_MIN minutes apart
// (default 30), the same trader + coin at most once in 6 hours, a prediction at most every 3 hours.
// Whale moves come first; the other kinds fill the quiet times.
//
// Env (all four keys are the @sasapadfun app's OAuth 1.0a keys, from console.x.com):
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET   without them this does nothing
//   XBOT_OFF=1         switch off            XBOT_DRY=1   write what it would post to the log only
//   XBOT_MIN_USD       smallest whale move worth a post (default 500000)
//   XBOT_PER_DAY, XBOT_GAP_MIN   see above

import { createHmac, randomBytes } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import { FONTS, WORDMARK, clip, escXml as esc, mark, raceCardName } from "./cards.mjs";
import { futuresCardSvg, futuresMarkets, predictCardSvg } from "./marketcards.mjs";
import { fetchPredict } from "./predictboard.mjs";
import * as card from "./xbotcards.mjs";
import * as say from "./xbottext.mjs";

const API = "https://api.x.com";
const W = 1200;
const H = 630;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ X API (OAuth 1.0a, user context)

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The Authorization header for a request whose body is JSON (body values are not signed). */
export function oauthHeader(method, url, keys, nonce = randomBytes(16).toString("hex"), ts = Math.floor(Date.now() / 1000)) {
  const o = {
    oauth_consumer_key: keys.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(ts),
    oauth_token: keys.accessToken,
    oauth_version: "1.0",
  };
  const u = new URL(url);
  const params = [...Object.entries(o), ...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const base = [method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(params.map(([k, v]) => `${k}=${v}`).join("&"))].join("&");
  const sig = createHmac("sha1", `${enc(keys.apiSecret)}&${enc(keys.accessSecret)}`).update(base).digest("base64");
  return "OAuth " + Object.entries({ ...o, oauth_signature: sig }).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(", ");
}

async function xPost(keys, path, body) {
  const url = `${API}${path}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: oauthHeader("POST", url, keys), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {}
  if (!r.ok) throw new Error(`X ${path} ${r.status}: ${text.slice(0, 300)}`);
  return j;
}

/** Posts `text` (with one PNG, a poll, or as a reply / quote of one of our posts); returns the post id. */
export async function postTweet(keys, { text, png = null, poll = null, replyTo = null, quote = null }) {
  const body = { text };
  if (png) {
    const m = await xPost(keys, "/2/media/upload", { media: Buffer.from(png).toString("base64"), media_category: "tweet_image" });
    if (!m?.data?.id) throw new Error("X media upload: no id");
    body.media = { media_ids: [String(m.data.id)] };
  }
  if (poll) body.poll = poll;
  if (replyTo) body.reply = { in_reply_to_tweet_id: String(replyTo) };
  if (quote) body.quote_tweet_id = String(quote);
  const t = await xPost(keys, "/2/tweets", body);
  return t?.data?.id ?? null;
}
export const postWithImage = (keys, text, png) => postTweet(keys, { text, png });

// ------------------------------------------------------------------ words

const NAMES = {
  BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", HYPE: "HYPE", XRP: "XRP", DOGE: "Dogecoin", TSLA: "Tesla", NVDA: "Nvidia",
  AAPL: "Apple", MSFT: "Microsoft", AMZN: "Amazon", GOOGL: "Google", META: "Meta", NFLX: "Netflix", AMD: "AMD", HOOD: "Robinhood",
  COIN: "Coinbase", MSTR: "MicroStrategy", PLTR: "Palantir", GOLD: "Gold", SILVER: "Silver", CL: "Oil", OIL: "Oil", BRENTOIL: "Oil",
  NATGAS: "NatGas", XYZ100: "Nasdaq", SPX: "SP500",
};
const STOCKS = new Set(["TSLA", "NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "NFLX", "AMD", "INTC", "HOOD", "COIN", "MSTR", "PLTR", "ORCL", "TSM"]);
const COMMODITIES = new Set(["GOLD", "SILVER", "CL", "OIL", "BRENTOIL", "NATGAS", "COPPER"]);

export const labelOf = (coin) => String(coin).slice(String(coin).indexOf(":") + 1).toUpperCase();

export function money(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `$${Math.round(a / 1e3)}K`;
  return `$${Math.round(a)}`;
}
const px = (p) => (p >= 1000 ? `$${Math.round(p).toLocaleString("en-US")}` : p >= 1 ? `$${p.toFixed(2)}` : `$${Number(p.toPrecision(4))}`);

/** 4 hashtags: the coin first, then what it is. */
export function tagsFor(label) {
  const name = NAMES[label];
  const tags = [`#${label}`];
  if (name && name.toUpperCase() !== label) tags.push(`#${name.replace(/[^A-Za-z0-9]/g, "")}`);
  if (STOCKS.has(label)) tags.push("#Stocks", "#Whales", "#Trading");
  else if (COMMODITIES.has(label)) tags.push("#Commodities", "#Whales", "#Trading");
  else tags.push("#Whales", "#Crypto", "#WhaleAlert");
  return [...new Set(tags)].slice(0, 4).join(" ");
}

const SIDE = { long: "LONG", short: "SHORT" };
const dir = (side) => (side === "long" ? "UP" : "DOWN");

/** The post for one whale move (several ways of saying it, picked at random). */
export function whaleText(m, w) {
  const L = labelOf(m.coin);
  const size = money(m.usd);
  const month = w.pnl_month > 0 ? money(w.pnl_month) : null;
  const lev = m.lev ? `${Math.round(m.lev)}x` : null;
  const who = w.rank ? `the #${w.rank} trader this month` : "this WHALE";
  let lines;
  if (m.kind === "open" || m.kind === "flip") {
    lines = [
      `someone just put ${size} on ${L} going ${dir(m.side)}${lev ? `. ${lev}` : ""}.${month ? ` this wallet is +${month} this month… 👀` : " 👀"}`,
      `WHALE just opened a ${size} ${L} ${SIDE[m.side]}${lev ? ` at ${lev}` : ""}. entry ${px(m.px)}${month ? `\n\nhe's up ${month} in 30 days btw` : ""}`,
      `${who} just went ${SIDE[m.side]} on ${L}. ${size}${lev ? `, ${lev}` : ""}\n\nyou fading him or following? 👀`,
      `${size} ${SIDE[m.side]} on ${L} just hit the books${month ? `\n\nsame wallet made ${month} this month. not a random guy` : ""}`,
    ];
    if (m.kind === "flip") lines = [`WHALE just FLIPPED ${L} to ${SIDE[m.side]}. ${size}${lev ? ` at ${lev}` : ""} 👀\n\nsomething changed his mind`, `${who} flipped ${L} ${m.side} out of nowhere. ${size} on it now`];
  } else if (m.kind === "add") {
    lines = [
      `WHALE just added ${size} more to his ${L} ${SIDE[m.side]}. he's not scared 👀`,
      `doubling down. ${who} just added ${size} to the ${L} ${m.side}${month ? `\n\n+${month} this month, so…` : ""}`,
    ];
  } else {
    lines = [
      `WHALE just closed his ${size} ${L} ${SIDE[m.side]}. out at ${px(m.px)} 👀\n\nhe knows something?`,
      `${who} just took his ${L} ${m.side} off the table. ${size}, gone`,
      `${size} ${L} ${SIDE[m.side]} closed. when this wallet leaves, people usually wish they'd followed`,
    ];
  }
  return `${pick(lines)}\n\n${tagsFor(L)}`;
}

/** The post for a prediction question. */
export function predictText(q, yes) {
  const L = q.tag || "BTC";
  const p = Math.round(yes * 100);
  const lines = [
    `${q.title.replace(/\?$/, "")}? market says ${p}% yes.\n\nyou think they're wrong? 👀`,
    `${q.title.toLowerCase()} yes or no, no in between`,
    `${p}% of people think yes. ${q.title.toLowerCase()}\n\nright call pays $1 a share`,
  ];
  return `${pick(lines)}\n\n#${L} #Predictions #Crypto #${NAMES[L] ? NAMES[L].replace(/[^A-Za-z]/g, "") : "Trading"}`;
}

const CHAIN = { 8453: "BASE", 56: "BNB", 4663: "ROBINHOOD", 5042: "ARC" };

export function raceText(r) {
  const chains = (r.chains || []).map((c) => CHAIN[c]).filter(Boolean);
  const win = CHAIN[r.winner_chain] || "one chain";
  const sym = `$${String(r.symbol).toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
  const usd = num(r.total_usd) > 0 ? money(num(r.total_usd)) : null;
  const lines = [
    `${sym} just raced on ${chains.length || "several"} chains at once. ${win} won${usd ? ` with ${usd} in` : ""} 🏁\n\nall the money from the losing chains moved to the winner`,
    `5 minutes. ${chains.length || "4"} chains. one winner.\n\n${sym} picked ${win}${usd ? `, ${usd} raced` : ""} 👀`,
    `${win} took the ${sym} race 🏁${usd ? ` ${usd} in, the losers' money merged into it` : ""}\n\nnext race could be yours`,
  ];
  return `${pick(lines)}\n\n#${sym.slice(1)} #MemeCoin #${win === "ROBINHOOD" ? "RobinhoodChain" : win === "BNB" ? "BNBChain" : win === "ARC" ? "Arc" : "Base"} #Crypto`;
}

export function recapText(top) {
  const a = top[0];
  const lines = [
    `today's best WHALE is already up ${money(a.pnl_day)} 👀\n\n#2 and #3 aren't far behind. guess what they're holding`,
    `${money(a.pnl_day)} made today by one wallet. TODAY.\n\nhere's who's printing right now`,
    `the top 3 WHALES made ${money(top.reduce((x, w) => x + w.pnl_day, 0))} between them today. you're watching the wrong charts`,
  ];
  return `${pick(lines)}\n\n#Whales #Crypto #Trading #WhaleAlert`;
}

export function stockText(m, weekend) {
  const L = m.label.toUpperCase();
  const ch = `${m.change >= 0 ? "+" : "-"}${Math.abs(m.change).toFixed(1)}%`;
  const name = NAMES[L] || m.name || L;
  const lines = weekend
    ? [`markets are closed. ${L} isn't 👀 ${ch} this weekend\n\nmonday open is gonna be interesting`, `wall street is sleeping and ${name} is ${ch} 👀\n\nyou can still long or short it right now`]
    : [`${name} ${ch} today and it's not stopping when the bell rings 👀\n\ntrades 24/7, nights and weekends`, `${L} ${ch}. biggest mover of the day\n\nlong or short it 24/7, even when the market's closed`];
  return `${pick(lines)}\n\n#${L} #${name.replace(/[^A-Za-z0-9]/g, "")} #Stocks #Trading`.replace(`#${L} #${L} `, `#${L} `);
}

const FG = (v) => (v <= 24 ? "EXTREME FEAR" : v <= 44 ? "FEAR" : v <= 55 ? "NEUTRAL" : v <= 74 ? "GREED" : "EXTREME GREED");
export function fearText(score, prev) {
  const label = FG(score);
  const move = prev !== null && prev !== undefined && prev !== score ? ` (${prev > score ? "down" : "up"} from ${prev} yesterday)` : "";
  const lines =
    score <= 44
      ? [`crypto fear & greed is at ${score}${move}. ${label} 😬\n\nbe greedy when others are fearful… right?`, `${score}/100. ${label}.\n\nthis is usually where WHALES start buying quietly 👀`]
      : score >= 56
        ? [`fear & greed just hit ${score}${move}. ${label} 🤑\n\nlast time it was this high, people got liquidated`, `${score}/100. everyone's feeling smart again 👀`]
        : [`fear & greed sitting at ${score}${move}. nobody knows what's next and that's exactly when the big moves come 👀`];
  return `${pick(lines)}\n\n#Bitcoin #Crypto #FearAndGreed #BTC`;
}

// ------------------------------------------------------------------ cards

const frame = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><radialGradient id="glow" cx="85%" cy="15%" r="70%"><stop offset="0%" stop-color="#FF6B1A" stop-opacity="0.30"/><stop offset="100%" stop-color="#FF6B1A" stop-opacity="0"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="#0B0806"/><rect width="${W}" height="${H}" fill="url(#glow)"/>
${mark(80, 56, 52)}
${WORDMARK}
<text x="1120" y="92" text-anchor="end" font-family="IBM Plex Mono" font-size="22" fill="#8F7F73">sasapad.fun</text>
${inner}
</svg>`;

export function whaleCardSvg(m, w) {
  const L = labelOf(m.coin);
  const closed = m.kind === "close";
  const badge = { open: "WHALE ALERT", flip: "WHALE FLIPPED", add: "WHALE ADDED", cut: "WHALE CUT", close: "WHALE CLOSED" }[m.kind] || "WHALE ALERT";
  const bw = Math.round(40 + badge.length * 13.5);
  const color = closed ? "#F0565E" : "#FF6B1A";
  const big = `${money(m.usd)} ${SIDE[m.side]}`;
  const bigColor = m.side === "long" ? "#2BC06D" : "#F0565E";
  const size = big.length <= 11 ? 110 : big.length <= 14 ? 92 : 76;
  const stat = (x, value, label) =>
    `<text x="${x}" y="500" font-family="Sora" font-weight="700" font-size="46" fill="#FFF4EC">${esc(value)}</text><text x="${x + 2}" y="540" font-family="IBM Plex Mono" font-size="22" fill="#8F7F73">${esc(label)}</text>`;
  return frame(`<g transform="translate(80,140)"><rect width="${bw}" height="48" rx="24" fill="${color}"/><text x="${bw / 2}" y="32" text-anchor="middle" font-family="Sora" font-weight="700" font-size="21" fill="#FFFFFF">${esc(badge)}</text></g>
<text x="76" y="${290 + (size - 92) / 3}" font-family="Sora" font-weight="700" font-size="${size}" fill="${closed ? "#FFF4EC" : bigColor}">${esc(big)}</text>
<text x="80" y="370" font-family="Sora" font-weight="700" font-size="42" fill="#FFF4EC">${esc(clip(L, 12))}${m.lev ? `  ·  ${Math.round(m.lev)}x` : ""}  ·  ${closed ? "out at" : "entry"} ${esc(px(m.px))}</text>
${stat(80, w.pnl_month > 0 ? `+${money(w.pnl_month)}` : "—", "last 30 days")}
${stat(450, w.rank ? `#${w.rank}` : "—", "30-day rank")}
${stat(780, w.account_value > 0 ? money(w.account_value) : "—", "account")}
<text x="80" y="600" font-family="Sora" font-weight="600" font-size="24" fill="#8F7F73">Follow every move live <tspan fill="#FF6B1A">· copy with one tap on sasa</tspan></text>`);
}

export function recapCardSvg(top) {
  const rows = top
    .slice(0, 3)
    .map((w, i) => {
      const y = 260 + i * 105;
      return `<text x="80" y="${y + 52}" font-family="Sora" font-weight="700" font-size="44" fill="#8F7F73">#${i + 1}</text>
<text x="190" y="${y + 52}" font-family="Sora" font-weight="700" font-size="44" fill="#FFF4EC">${esc(clip(w.name || `Whale #${w.rank}`, 18))}</text>
<text x="1120" y="${y + 52}" text-anchor="end" font-family="Sora" font-weight="700" font-size="52" fill="#2BC06D">+${esc(money(w.pnl_day))}</text>`;
    })
    .join("\n");
  return frame(`<g transform="translate(80,140)"><rect width="300" height="48" rx="24" fill="#FF6B1A"/><text x="150" y="32" text-anchor="middle" font-family="Sora" font-weight="700" font-size="21" fill="#FFFFFF">TODAY'S TOP WHALES</text></g>
${rows}
<text x="80" y="600" font-family="Sora" font-weight="600" font-size="24" fill="#8F7F73">See what they hold <tspan fill="#FF6B1A">· copy with one tap on sasa</tspan></text>`);
}

export function fearCardSvg(score) {
  const label = FG(score);
  const color = score <= 24 ? "#F0565E" : score <= 44 ? "#F59E42" : score <= 55 ? "#E8C547" : score <= 74 ? "#8BD15A" : "#2BC06D";
  const x = 80 + (1040 * score) / 100;
  return frame(`<g transform="translate(80,140)"><rect width="300" height="48" rx="24" fill="#2A1A10"/><text x="150" y="32" text-anchor="middle" font-family="Sora" font-weight="700" font-size="21" fill="#FF6B1A">FEAR &amp; GREED INDEX</text></g>
<text x="76" y="350" font-family="Sora" font-weight="700" font-size="150" fill="${color}">${score}</text>
<text x="${76 + String(score).length * 92 + 40}" y="340" font-family="Sora" font-weight="700" font-size="60" fill="#FFF4EC">${esc(label)}</text>
<defs><linearGradient id="fg" x1="0" x2="1"><stop offset="0" stop-color="#F0565E"/><stop offset="0.5" stop-color="#E8C547"/><stop offset="1" stop-color="#2BC06D"/></linearGradient></defs>
<rect x="80" y="420" width="1040" height="22" rx="11" fill="url(#fg)"/>
<circle cx="${x}" cy="431" r="22" fill="#FFF4EC" stroke="#0B0806" stroke-width="6"/>
<text x="80" y="480" font-family="IBM Plex Mono" font-size="22" fill="#8F7F73">0 fear</text><text x="1120" y="480" text-anchor="end" font-family="IBM Plex Mono" font-size="22" fill="#8F7F73">greed 100</text>
<text x="80" y="600" font-family="Sora" font-weight="600" font-size="24" fill="#8F7F73">Live market mood <tspan fill="#FF6B1A">· on sasa</tspan></text>`);
}

const png = (svg) => new Resvg(svg, { fitTo: { mode: "width", value: W }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Sora" } }).render().asPng();

// ------------------------------------------------------------------ the loop

const SQL = `create table if not exists xbot_posts (
  id        bigserial   primary key,
  kind      text        not null,
  ref       text        not null unique,
  text      text        not null,
  post_id   text,
  posted_at timestamptz not null default now()
);
alter table xbot_posts add column if not exists meta jsonb;
alter table xbot_posts add column if not exists done boolean not null default false;
alter table xbot_posts enable row level security;
revoke all on xbot_posts from anon, authenticated;`;

/** The next whale move worth a post, or null. */
async function nextWhale(pool, minUsd) {
  const { rows } = await pool.query(
    `select m.id, m.address, m.coin, m.kind, m.side, m.usd, m.px, m.lev, w.rank, w.name, w.pnl_month, w.account_value
     from whale_moves m join whales w on w.address = m.address and w.listed
     where m.t > now() - interval '20 minutes' and m.usd >= $1 and m.kind in ('open','flip','add','close')
       and not exists (select 1 from xbot_posts p where p.ref like 'w:' || m.id || ':%')
     order by (case m.kind when 'open' then 3 when 'flip' then 3 when 'close' then 2 else 1 end) * m.usd desc
     limit 20`,
    [minUsd]
  );
  for (const r of rows) {
    const recent = await pool.query(`select 1 from xbot_posts where kind = 'whale' and ref like $1 and posted_at > now() - interval '6 hours' limit 1`, [`w:%:${r.address}:${r.coin}`]);
    if (recent.rowCount) continue;
    // a close of a position we already posted: the follow-up under that post says it instead
    if (r.kind === "close") {
      const ours = await pool.query(`select 1 from xbot_posts where kind = 'whale' and meta->>'address' = $1 and meta->>'coin' = $2 and posted_at > now() - interval '3 days' limit 1`, [r.address, r.coin]);
      if (ours.rowCount) continue;
    }
    // numeric columns arrive as strings
    return { ...r, usd: num(r.usd), px: num(r.px), lev: num(r.lev), rank: num(r.rank) || null, pnl_month: num(r.pnl_month), account_value: num(r.account_value) };
  }
  return null;
}

/** A price question close to 50/50 ending in the next 15 min – 3 h, or null. */
async function nextPrediction() {
  const board = await fetchPredict();
  const now = Date.now();
  const ok = board.singles.filter((o) => {
    const yes = o.sides?.[0]?.price;
    return o.tab === "price" && /^(BTC|ETH|SOL)\b/.test(o.title) && yes >= 0.3 && yes <= 0.7 && o.expiry && o.expiry - now > 15 * 60e3 && o.expiry - now < 3 * 3600e3;
  });
  ok.sort((a, b) => Math.abs(a.sides[0].price - 0.5) - Math.abs(b.sides[0].price - 0.5));
  return ok[0] || null;
}

async function nextRace(pool) {
  const { rows } = await pool.query(
    `select c.id, c.symbol, c.name, c.winner_chain, c.total_usd, array_agg(r.chain_id) as chains
     from race_coins c join race_chains r on r.coin_id = c.id
     where c.winner_chain is not null and c.decided_at > now() - interval '2 hours'
       and c.name !~* '^test' and not exists (select 1 from xbot_posts p where p.ref = 'r:' || c.id)
     group by c.id order by c.total_usd desc nulls last limit 1`
  );
  return rows[0] || null;
}

async function raceCard(id) {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  const r = await fetch(`${base}/storage/v1/object/public/cards/${raceCardName(id)}`);
  return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
}

async function topToday(pool) {
  const { rows } = await pool.query(`select address, rank, name, pnl_day from whales where listed and pnl_day > 0 order by pnl_day desc limit 3`);
  return rows.map((r) => ({ ...r, pnl_day: num(r.pnl_day), rank: num(r.rank) }));
}

async function fearNow(pool) {
  const { rows } = await pool.query(
    `select (select score from fear_greed order by t desc limit 1) as now,
            (select score from fear_greed where t <= now() - interval '23 hours' order by t desc limit 1) as prev`
  );
  return rows[0]?.now === null || rows[0]?.now === undefined ? null : { score: num(rows[0].now), prev: rows[0].prev === null ? null : num(rows[0].prev) };
}

// ------------------------------------------------------------------ more kinds

const HL = "https://api.hyperliquid.xyz/info";
async function hl(body) {
  const r = await fetch(HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
  return r.json();
}
const pct = (v) => `${v >= 0 ? "+" : "-"}${Math.abs(v) >= 100 ? Math.round(Math.abs(v)) : Math.abs(v).toFixed(1)}%`;
const NET = { base: "BASE", bsc: "BNB", eth: "ETHEREUM", solana: "SOLANA", arbitrum: "ARBITRUM", robinhood: "ROBINHOOD" };
const sym = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "COIN";

/** The biggest gainer of the top 500 today (not posted in the last 24 h). */
async function nextSpot(pool) {
  const { rows } = await pool.query(
    `select cg_id, rank, name, symbol, price_usd, change_24h, mcap_usd, spark from top_coins
     where listed and rank <= 300 and change_24h >= 5 and coalesce(vol_24h, 0) >= 1000000
       and not exists (select 1 from xbot_posts p where p.ref = 'g:' || cg_id || ':' || to_char(now(), 'YYYY-MM-DD'))
     order by change_24h desc limit 1`
  );
  const r = rows[0];
  return r ? { ...r, price_usd: num(r.price_usd), change_24h: num(r.change_24h), mcap_usd: num(r.mcap_usd), rank: num(r.rank) } : null;
}

/** The hottest meme of the day on other DEXs: real volume and liquidity, passed the safety check. */
async function nextMeme(pool) {
  const { rows } = await pool.query(
    `select network, address, name, symbol, price_usd, change_24h, mcap_usd, fdv_usd, vol_24h, liq_usd from ext_coins
     where change_24h >= 30 and vol_24h >= 200000 and liq_usd >= 75000 and coalesce(mcap_usd, fdv_usd) >= 300000
       and not exists (select 1 from xbot_posts p where p.ref = 'm:' || network || ':' || address)
     order by change_24h desc limit 1`
  );
  const r = rows[0];
  return r ? { ...r, change_24h: num(r.change_24h), mcap: num(r.mcap_usd) || num(r.fdv_usd), vol: num(r.vol_24h), liq: num(r.liq_usd) } : null;
}

export function spotText(c) {
  const S = sym(c.symbol);
  const lines = [
    `${S} ${pct(c.change_24h)} today. biggest gainer in the top 500 right now 👀\n\nstill early or already too late?`,
    `nothing in the top 500 is pumping like ${S} today. ${pct(c.change_24h)} 🚀\n\nyou holding any?`,
    `${c.name} just did ${pct(c.change_24h)} in a day. #${c.rank} by market cap and moving like a meme 👀`,
  ];
  return `${pick(lines)}\n\n#${S} #Crypto #Altcoins #TopGainers`;
}
export function memeText(c) {
  const S = sym(c.symbol);
  const net = NET[c.network] || String(c.network).toUpperCase();
  const lines = [
    `this meme is ${pct(c.change_24h)} today on ${net} 👀\n\n$${S}. ${money(c.vol)} volume in 24h. people are paying attention`,
    `$${S} ${pct(c.change_24h)} in 24 hours. ${money(c.mcap)} market cap now\n\nwho caught this one early? 🙋`,
    `${pct(c.change_24h)} today. $${S} on ${net} is the hottest meme out there right now 🔥`,
  ];
  return `${pick(lines)}\n\n#${S} #MemeCoin #${net === "BNB" ? "BNBChain" : net.charAt(0) + net.slice(1).toLowerCase()} #Crypto`;
}

export function spotCardSvg(c) {
  const S = sym(c.symbol);
  const up = c.change_24h >= 0;
  return frame(`<g transform="translate(80,140)"><rect width="330" height="48" rx="24" fill="#FF6B1A"/><text x="165" y="32" text-anchor="middle" font-family="Sora" font-weight="700" font-size="21" fill="#FFFFFF">TOP GAINER TODAY</text></g>
<text x="76" y="320" font-family="Sora" font-weight="700" font-size="${S.length <= 6 ? 120 : 84}" fill="#FFF4EC">${esc(S)}</text>
<text x="80" y="385" font-family="Sora" font-weight="600" font-size="38" fill="#A8978A">${esc(clip(c.name, 26))}${c.rank ? ` · #${c.rank}` : ""}</text>
<text x="1120" y="320" text-anchor="end" font-family="Sora" font-weight="700" font-size="110" fill="${up ? "#2BC06D" : "#F0565E"}">${esc(pct(c.change_24h))}</text>
<text x="1120" y="385" text-anchor="end" font-family="IBM Plex Mono" font-size="38" fill="#FFF4EC">${esc(c.price_usd ? px(c.price_usd) : "")}</text>
<line x1="80" y1="445" x2="1120" y2="445" stroke="#2E231A" stroke-width="2"/>
<text x="80" y="520" font-family="Sora" font-weight="700" font-size="40" fill="#FFF4EC">Buy or sell <tspan fill="#FF6B1A">${esc(S)}</tspan> on sasa</text>
<text x="80" y="575" font-family="Sora" font-weight="600" font-size="26" fill="#8F7F73">The 500 biggest coins, one tap, any chain.</text>`);
}
export function memeCardSvg(c) {
  const S = sym(c.symbol);
  const net = NET[c.network] || String(c.network).toUpperCase();
  const stat = (x, v, l) => `<text x="${x}" y="500" font-family="Sora" font-weight="700" font-size="44" fill="#FFF4EC">${esc(v)}</text><text x="${x + 2}" y="540" font-family="IBM Plex Mono" font-size="22" fill="#8F7F73">${esc(l)}</text>`;
  return frame(`<g transform="translate(80,140)"><rect width="300" height="48" rx="24" fill="#FF6B1A"/><text x="150" y="32" text-anchor="middle" font-family="Sora" font-weight="700" font-size="21" fill="#FFFFFF">HOTTEST MEME</text></g>
<text x="76" y="320" font-family="Sora" font-weight="700" font-size="${S.length <= 6 ? 120 : 84}" fill="#FFF4EC">$${esc(S)}</text>
<text x="80" y="385" font-family="Sora" font-weight="600" font-size="38" fill="#A8978A">${esc(clip(c.name || S, 22))} · ${esc(net)}</text>
<text x="1120" y="320" text-anchor="end" font-family="Sora" font-weight="700" font-size="110" fill="#2BC06D">${esc(pct(c.change_24h))}</text>
${stat(80, money(c.mcap), "market cap")}${stat(450, money(c.vol), "volume 24h")}${stat(780, money(c.liq), "liquidity")}
<text x="80" y="600" font-family="Sora" font-weight="600" font-size="24" fill="#8F7F73">Trade any meme <tspan fill="#FF6B1A">· or launch your own on sasa</tspan></text>`);
}

/** The top 30 traders' positions, from whale_state: [{ address, rank, coin, side, v, e, l }]. */
async function whalePositionsNow(pool) {
  const { rows } = await pool.query(
    `select w.address, w.rank, w.name, s.positions from whales w join whale_state s on s.address = w.address
     where w.listed and w.rank <= 30 and s.checked_at > now() - interval '30 minutes'`
  );
  const out = [];
  for (const r of rows)
    for (const [coin, p] of Object.entries(r.positions || {})) out.push({ address: r.address, rank: num(r.rank), name: r.name, coin, side: p.s > 0 ? "long" : "short", v: num(p.v), e: num(p.e), l: num(p.l) });
  return out;
}

export function crowdText(coin, longPct, fundingPos) {
  const L = labelOf(coin);
  const side = longPct >= 50 ? "LONG" : "SHORT";
  const p = Math.round(longPct >= 50 ? longPct : 100 - longPct);
  const crowd = fundingPos ? "long" : "short";
  const disagree = (side === "LONG") !== fundingPos;
  const lines = disagree
    ? [`top 30 WHALES are ${p}% ${side} on ${L} right now. the crowd is ${crowd}. someone's about to be very wrong 👀`, `smart money: ${p}% ${side} on ${L}. everyone else: ${crowd}.\n\nwho are you betting on?`]
    : [`${p}% of the top 30 WHALES are ${side} on ${L} right now. the crowd agrees… that's usually when it gets interesting 👀`, `WHALES and retail both ${side.toLowerCase()} ${L}. ${p}% of the big money on one side. what could go wrong`];
  return `${pick(lines)}\n\n#${L} #Whales #Crypto #${NAMES[L] ? NAMES[L].replace(/[^A-Za-z]/g, "") : "Trading"}`;
}
export function crowdCardSvg(coin, longPct, longUsd, shortUsd) {
  const L = labelOf(coin);
  const w = Math.round(1040 * longPct / 100);
  return frame(`<g transform="translate(80,140)"><rect width="330" height="48" rx="24" fill="#2A1A10"/><text x="165" y="32" text-anchor="middle" font-family="Sora" font-weight="700" font-size="21" fill="#FF6B1A">TOP 30 WHALES ON ${esc(L)}</text></g>
<text x="76" y="320" font-family="Sora" font-weight="700" font-size="100" fill="#2BC06D">${Math.round(longPct)}% LONG</text>
<text x="1120" y="320" text-anchor="end" font-family="Sora" font-weight="700" font-size="56" fill="#F0565E">${Math.round(100 - longPct)}% SHORT</text>
<rect x="80" y="380" width="1040" height="36" rx="18" fill="#F0565E"/><rect x="80" y="380" width="${Math.max(36, w)}" height="36" rx="18" fill="#2BC06D"/>
<text x="80" y="470" font-family="IBM Plex Mono" font-size="26" fill="#A8978A">${esc(money(longUsd))} long</text><text x="1120" y="470" text-anchor="end" font-family="IBM Plex Mono" font-size="26" fill="#A8978A">${esc(money(shortUsd))} short</text>
<text x="80" y="600" font-family="Sora" font-weight="600" font-size="24" fill="#8F7F73">See every position live <tspan fill="#FF6B1A">· on sasa</tspan></text>`);
}

export function biggestText(p) {
  const L = labelOf(p.coin);
  const lines = [
    `the biggest bet a top WHALE has on right now: ${money(p.v)} ${p.side.toUpperCase()} on ${L} 👀\n\nif this goes wrong…`,
    `${money(p.v)}. one position. ${L} ${p.side.toUpperCase()}${p.l ? ` at ${Math.round(p.l)}x` : ""}\n\nthis is what conviction looks like`,
    `someone is sitting on a ${money(p.v)} ${L} ${p.side} right now and not blinking 😳`,
  ];
  return `${pick(lines)}\n\n${tagsFor(L)}`;
}

/** The most extreme funding among busy markets: { coin, rate (hourly), apr, oi }. */
async function extremeFunding() {
  const [meta, ctxs] = await hl({ type: "metaAndAssetCtxs" });
  let best = null;
  meta.universe.forEach((u, i) => {
    const c = ctxs[i];
    if (!c || u.isDelisted) return;
    const oi = num(c.openInterest) * num(c.markPx);
    const f = num(c.funding);
    if (oi < 5_000_000) return;
    if (!best || Math.abs(f) > Math.abs(best.rate)) best = { coin: u.name, rate: f, apr: f * 24 * 365 * 100, oi };
  });
  return best && Math.abs(best.rate) >= 0.0001 ? best : null; // ≥ 0.01% an hour (~88% a year)
}
export function fundingText(f) {
  const L = labelOf(f.coin);
  const payers = f.rate > 0 ? "longs are paying shorts" : "shorts are paying longs";
  const lines = [
    `${payers} ${Math.abs(f.apr).toFixed(0)}% a year on ${L} right now 😳\n\nthat doesn't last. something's about to snap`,
    `funding on ${L} just went crazy. ${payers} every hour\n\nthis is how squeezes start 👀`,
  ];
  return `${pick(lines)}\n\n#${L} #Funding #Crypto #Trading`;
}
export function fundingCardSvg(f) {
  const L = labelOf(f.coin);
  return frame(`<g transform="translate(80,140)"><rect width="300" height="48" rx="24" fill="#2A1A10"/><text x="150" y="32" text-anchor="middle" font-family="Sora" font-weight="700" font-size="21" fill="#FF6B1A">FUNDING ALERT</text></g>
<text x="76" y="320" font-family="Sora" font-weight="700" font-size="120" fill="#FFF4EC">${esc(clip(L, 10))}</text>
<text x="1120" y="320" text-anchor="end" font-family="Sora" font-weight="700" font-size="96" fill="${f.rate > 0 ? "#F0565E" : "#2BC06D"}">${Math.abs(f.apr).toFixed(0)}%/yr</text>
<text x="80" y="400" font-family="Sora" font-weight="600" font-size="40" fill="#A8978A">${f.rate > 0 ? "longs paying shorts" : "shorts paying longs"} · ${esc(money(f.oi))} open</text>
<text x="80" y="600" font-family="Sora" font-weight="600" font-size="24" fill="#8F7F73">Long or short ${esc(L)} <tspan fill="#FF6B1A">· on sasa</tspan></text>`);
}

export function pollText() {
  const lines = [
    `BTC by tonight. UP or DOWN? 👇\n\nno "crab" option, pick a side`,
    `where's bitcoin by the end of the day? vote and come back to flex 👇`,
    `quick one. BTC tonight 👇`,
  ];
  return `${pick(lines)}\n\n#BTC #Bitcoin #Crypto #Poll`;
}

/** A whale open we posted that has since been closed: { post, pnl, hours, closePx }. */
async function nextFollowup(pool) {
  const { rows } = await pool.query(
    `select p.id, p.post_id, p.meta, p.posted_at, m.px as close_px, m.t as closed_at
     from xbot_posts p
     join lateral (select px, t from whale_moves m where m.address = p.meta->>'address' and m.coin = p.meta->>'coin'
                   and m.kind = 'close' and m.t > p.posted_at order by m.t limit 1) m on true
     where p.kind = 'whale' and not p.done and p.post_id is not null and p.meta->>'kind' in ('open','flip','add')
       and p.posted_at > now() - interval '3 days'
     order by m.t limit 1`
  );
  const r = rows[0];
  if (!r) return null;
  const o = r.meta;
  const entry = num(o.px);
  const close = num(r.close_px);
  if (!(entry > 0 && close > 0)) return { post: r, pnl: null };
  const pnl = (close / entry - 1) * num(o.usd) * (o.side === "long" ? 1 : -1);
  return { post: r, pnl, hours: (new Date(r.closed_at) - new Date(r.posted_at)) / 3600e3, closePx: close };
}
export function followupText(f) {
  const t = f.hours < 1 ? `${Math.max(1, Math.round(f.hours * 60))} minutes` : `${Math.round(f.hours)}h`;
  if (f.pnl === null) return `he just closed it 👀`;
  if (f.pnl >= 0)
    return pick([`remember this one? he just closed it. +${money(f.pnl)} in ${t} 👀\n\nfollow so you catch the next one`, `and it's done. +${money(f.pnl)} in ${t}. told you this wallet doesn't miss much 🐋`]);
  return pick([`closed. -${money(-f.pnl)} this time. even WHALES get it wrong sometimes`, `he's out. took a -${money(-f.pnl)} hit on this one. next move is the one to watch 👀`]);
}

/** A prediction we posted whose time is up: { post, yesWon, closePx }. */
async function nextResult(pool) {
  const { rows } = await pool.query(
    `select id, post_id, meta from xbot_posts
     where kind = 'predict' and not done and post_id is not null and meta ? 'expiry'
       and (meta->>'expiry')::bigint < extract(epoch from now()) * 1000 - 120000
       and posted_at > now() - interval '1 day'
     order by posted_at limit 1`
  );
  const r = rows[0];
  if (!r) return null;
  const m = r.meta;
  const t = num(m.expiry);
  const candles = await hl({ type: "candleSnapshot", req: { coin: m.underlying, interval: "1m", startTime: t - 120000, endTime: t + 60000 } });
  const c = (candles || []).filter((k) => num(k.t) < t).pop();
  if (!c) return { post: r, yesWon: null };
  const close = num(c.c);
  return { post: r, yesWon: close > num(m.target), closePx: close, yes: num(m.yes) };
}
export function resultText(r) {
  const m = r.post.meta;
  if (r.yesWon === null) return null;
  const right = Math.round((r.yesWon ? r.yes : 1 - r.yes) * 100);
  return pick([
    `${r.yesWon ? "YES" : "NO"} won. ${m.underlying} was at ${px(r.closePx)} 👀\n\n${right}% called it. next one's already live`,
    `and the answer is… ${r.yesWon ? "YES" : "NO"}. ${m.underlying} ${px(r.closePx)}\n\n${right < 50 ? "only " : ""}${right}% got it right. you in for the next one?`,
  ]);
}

// ------------------------------------------------------------------ the day's plan

// About 10 posts a day: up to 2 whale moves of $1M+ the moment they happen, and 8 planned posts.
// Times are Türkiye time (UTC+3); every day each one moves by up to ±25 minutes, so nothing goes
// out at the same minute two days running (people notice a bot on a timer).
export const PLAN = [
  { kind: "fear", at: "10:00" },
  { kind: "biggest", at: "13:00" },
  { kind: "predict", at: "15:00" },
  { kind: "stock", at: "16:30" },
  { kind: "spot", at: "17:30" },
  { kind: "meme", at: "18:30" },
  { kind: "poll", at: "19:30" },
  { kind: "recap", at: "21:00" },
];
const TR = 3 * 3600e3;

/** Today's time for a planned post (ms), moved by a fixed ±25 min for that day and kind. */
export function slotTime(kind, at, now = Date.now()) {
  const day = new Date(now + TR).toISOString().slice(0, 10);
  let h = 2166136261;
  for (const ch of `${day}:${kind}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const jitter = (h % 51) - 25; // minutes
  const [hh, mm] = at.split(":").map(Number);
  return Date.parse(`${day}T00:00:00Z`) - TR + ((hh * 60 + mm + jitter) * 60e3);
}

/** One of `list` ([id, text]) not used for this kind in the last 7 days: { text, tpl }. */
async function fresh(pool, kind, list) {
  const { rows } = await pool.query(`select meta->>'tpl' as tpl from xbot_posts where kind = $1 and posted_at > now() - interval '7 days' and meta ? 'tpl'`, [kind]).catch(() => ({ rows: [] }));
  const used = new Set(rows.map((r) => r.tpl));
  const left = list.filter(([id]) => !used.has(id));
  const [tpl, text] = (left.length ? left : list)[Math.floor(Math.random() * (left.length || list.length))];
  return { text, tpl };
}

const NETNAME = { base: "BASE", bsc: "BNB", eth: "ETHEREUM", solana: "SOLANA", arbitrum: "ARBITRUM", robinhood: "ROBINHOOD" };

/** What each planned kind posts (null: nothing worth posting right now; tried again later). */
function makers(pool) {
  const today = new Date(Date.now() + TR).toISOString().slice(0, 10);
  return {
    fear: async () => {
      const f = await fearNow(pool);
      if (!f) return null;
      const w = await fresh(pool, "fear", say.fear(f.score, f.prev));
      return { ref: `f:${today}`, text: w.text, meta: { tpl: w.tpl }, image: card.fearCard(f.score) };
    },
    biggest: async () => {
      const p = (await whalePositionsNow(pool)).sort((a, b) => b.v - a.v)[0];
      if (!p || p.v < 5_000_000) return null;
      const w = await fresh(pool, "biggest", say.biggest(p));
      return { ref: `b:${today}`, text: w.text, meta: { tpl: w.tpl }, image: card.biggestCard(p) };
    },
    predict: async () => {
      const q = await nextPrediction();
      if (!q) return null;
      const title = q.title.replace(/\s*(today|tomorrow)?\s*at\s*\d{2}:\d{2}\??$/i, "?").replace(/\?+$/, "?");
      const ends = q.expiry ? new Date(q.expiry).toISOString().slice(11, 16) + " UTC" : null;
      const m = /^(\w+) above \$([\d,.]+)/.exec(q.title);
      const meta = m && q.expiry ? { underlying: m[1], target: Number(m[2].replace(/,/g, "")), expiry: q.expiry, yes: q.sides[0].price } : null;
      const w = await fresh(pool, "predict", say.predict(q.title.replace(/(\d{2}:\d{2})(\?)?$/, "$1 UTC$2"), q.sides[0].price, m ? m[1] : "BTC"));
      return { ref: `p:${q.outcome}`, text: w.text, image: card.predictCard({ title, ends, yes: q.sides[0].price }), meta: { ...(meta || {}), tpl: w.tpl } };
    },
    stock: async () => {
      const all = (await futuresMarkets()).filter((x) => x.dex && (x.group === "stocks" || x.group === "commodities") && x.change !== null && x.vol > 100_000);
      const m = [...all].sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0];
      if (!m || Math.abs(m.change) < 1) return null;
      const tape = [...all].sort((a, b) => b.vol - a.vol).slice(0, 8).map((x) => ({ label: x.label.toUpperCase(), change: x.change }));
      let line = [];
      try {
        const now = Date.now();
        const c = await hl({ type: "candleSnapshot", req: { coin: m.coin, interval: "1h", startTime: now - 24 * 3600e3, endTime: now } });
        line = (c || []).map((k) => num(k.c)).filter((v) => v > 0);
      } catch {}
      const d = new Date();
      const closed = d.getUTCDay() === 0 || d.getUTCDay() === 6 || d.getUTCHours() < 13 || d.getUTCHours() >= 20;
      const w = await fresh(pool, "stock", say.stock(m, closed));
      return { ref: `s:${today}`, text: w.text, meta: { tpl: w.tpl }, image: card.stockCard(m, tape, line, closed) };
    },
    spot: async () => {
      const c = await nextSpot(pool);
      if (!c) return null;
      const w = await fresh(pool, "spot", say.spot(c));
      return { ref: `g:${c.cg_id}:${today}`, text: w.text, meta: { tpl: w.tpl }, image: card.spotCard(c) };
    },
    meme: async () => {
      const c = await nextMeme(pool);
      if (!c) return null;
      const net = NETNAME[c.network] || String(c.network).toUpperCase();
      const w = await fresh(pool, "meme", say.meme(c, net));
      return { ref: `m:${c.network}:${c.address}`, text: w.text, meta: { tpl: w.tpl }, image: card.memeCard(c, net) };
    },
    poll: async () => {
      const w = await fresh(pool, "poll", say.poll());
      return { ref: `q:${today}`, text: w.text, meta: { tpl: w.tpl }, poll: { options: ["UP 📈", "DOWN 📉"], duration_minutes: 360 } };
    },
    recap: async () => {
      const top = await topToday(pool);
      if (top.length < 3 || top[0].pnl_day < 100_000) return null;
      const w = await fresh(pool, "recap", say.recap(top));
      return { ref: `c:${today}`, text: w.text, meta: { tpl: w.tpl }, image: card.recapCard(top) };
    },
  };
}

// ------------------------------------------------------------------ the loop

export async function xbotLoop(pool, log) {
  if (process.env.XBOT_OFF === "1") return;
  const keys = { apiKey: process.env.X_API_KEY, apiSecret: process.env.X_API_SECRET, accessToken: process.env.X_ACCESS_TOKEN, accessSecret: process.env.X_ACCESS_SECRET };
  if (!keys.apiKey || !keys.apiSecret || !keys.accessToken || !keys.accessSecret) return;
  const dry = process.env.XBOT_DRY === "1";
  const minUsd = Number(process.env.XBOT_MIN_USD ?? "1000000");
  const whalesPerDay = Number(process.env.XBOT_WHALES_PER_DAY ?? "2");
  const repliesPerDay = Number(process.env.XBOT_REPLIES_PER_DAY ?? "6");
  await pool.query(SQL);
  log(`x bot: on${dry ? " (dry run: nothing is posted)" : ""}; ${PLAN.length} planned posts a day + up to ${whalesPerDay} whale moves of ${money(minUsd)}+`);

  const send = async (post) => {
    if (dry) {
      log(`x bot (dry) ${post.kind}: ${post.text.replace(/\n+/g, " / ")}`);
      await pool.query(`insert into xbot_posts (kind, ref, text, meta, post_id) values ($1, $2, $3, $4, 'dry') on conflict (ref) do nothing`, [post.kind, post.ref, post.text, post.meta ? JSON.stringify(post.meta) : null]);
      return;
    }
    // the row first: if X takes the post but the answer is lost, it is never posted twice
    const ins = await pool.query(`insert into xbot_posts (kind, ref, text, meta) values ($1, $2, $3, $4) on conflict (ref) do nothing returning id`, [post.kind, post.ref, post.text, post.meta ? JSON.stringify(post.meta) : null]);
    if (!ins.rowCount) return;
    let id;
    try {
      id = await postTweet(keys, { text: post.text, png: post.image ?? (post.svg ? png(post.svg) : null), poll: post.poll, replyTo: post.replyTo });
    } catch (e) {
      // a reply X won't take: say it as a quote of our own post instead
      if (post.replyTo && /\b403\b/.test(e.message)) id = await postTweet(keys, { text: post.text, quote: post.replyTo });
      else throw e;
    }
    await pool.query(`update xbot_posts set post_id = $2 where id = $1`, [ins.rows[0].id, id]);
    log(`x bot: posted ${post.kind} (${id})`);
  };

  let failures = 0;
  for (;;) {
    try {
      const now = Date.now();
      const dayStart = Date.parse(`${new Date(now + TR).toISOString().slice(0, 10)}T00:00:00Z`) - TR; // midnight, Türkiye
      const { rows } = await pool.query(`select kind, count(*)::int as n, max(posted_at) as last from xbot_posts where posted_at >= to_timestamp($1 / 1000.0) group by kind`, [dayStart]);
      const n = (k) => rows.find((r) => r.kind === k)?.n || 0;
      const lastAny = Math.max(0, ...rows.filter((r) => r.kind !== "followup" && r.kind !== "result").map((r) => new Date(r.last).getTime()));
      const replies = n("followup") + n("result");

      // follow-ups under our own posts (not counted in the 10)
      if (replies < repliesPerDay) {
        const f = await nextFollowup(pool).catch(() => null);
        if (f) {
          await pool.query(`update xbot_posts set done = true where id = $1`, [f.post.id]);
          if (f.pnl !== null && Math.abs(f.pnl) >= 50_000) {
            const t = await fresh(pool, "followup", say.followup(f));
            await send({ kind: "followup", ref: `fu:${f.post.id}`, text: t.text, meta: { tpl: t.tpl }, replyTo: f.post.post_id === "dry" ? null : f.post.post_id });
          }
        } else {
          const r = await nextResult(pool).catch(() => null);
          if (r) {
            await pool.query(`update xbot_posts set done = true where id = $1`, [r.post.id]);
            if (r.yesWon !== null) {
              const t = await fresh(pool, "result", say.result(r, r.post.meta.underlying));
              await send({ kind: "result", ref: `pr:${r.post.id}`, text: t.text, meta: { tpl: t.tpl }, replyTo: r.post.post_id === "dry" ? null : r.post.post_id });
            }
          }
        }
      }

      // at least 20 minutes between our own posts
      if (now - lastAny >= 20 * 60e3) {
        let post = null;
        if (n("whale") < whalesPerDay) {
          const w = await nextWhale(pool, minUsd);
          if (w) {
            const t = await fresh(pool, "whale", say.whale(w, w));
            post = { kind: "whale", ref: `w:${w.id}:${w.address}:${w.coin}`, text: t.text, image: card.whaleCard(w, w), meta: { address: w.address, coin: w.coin, kind: w.kind, side: w.side, px: w.px, usd: w.usd, tpl: t.tpl } };
          }
        }
        if (!post) {
          const make = makers(pool);
          // a planned post whose time has come today (and not more than 3 hours late)
          for (const p of PLAN) {
            if (n(p.kind) > 0) continue;
            const t = slotTime(p.kind, p.at, now);
            if (now < t || now > t + 3 * 3600e3) continue;
            const made = await make[p.kind]().catch((e) => (log(`x bot: ${p.kind}: ${String(e.message).slice(0, 150)}`), null));
            if (made) {
              post = { kind: p.kind, ...made };
              break;
            }
          }
        }
        if (post) await send(post);
      }
      failures = 0;
    } catch (e) {
      failures++;
      log(`x bot: ${String(e.message).slice(0, 300)}`);
      // X said no (bad keys, no credits): wait longer before trying again
      if (/X \/2\/.* (401|402|403)/.test(e.message)) await sleep(Math.min(6, failures) * 30 * 60e3);
    }
    await sleep(60e3);
  }
}
