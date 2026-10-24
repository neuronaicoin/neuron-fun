// @sasapadfun on X: posts on its own timeline only, by itself, with a picture card.
//
//   - whale moves: a top-30 trader (Data tab) opens, flips, adds to or closes a position worth
//     $500K or more (whale_moves, written by whales.mjs)
//   - predictions: now and then an open BTC / ETH price question that is close to 50/50
//
// It never replies, mentions, follows, likes or reads anyone's posts (X's automation rules allow
// automated posts on your own account; automated replies to others are not allowed). No links in
// the text (a post with a link costs much more on X's pay-per-use API; the link is on the profile).
//
// Limits: at most XBOT_PER_DAY posts in 24 hours (default 30), at least XBOT_GAP_MIN minutes apart
// (default 30), the same trader + coin at most once in 6 hours, a prediction at most every 3 hours.
//
// Env (all four keys are the @sasapadfun app's OAuth 1.0a keys, from console.x.com):
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET   without them this does nothing
//   XBOT_OFF=1         switch off            XBOT_DRY=1   write what it would post to the log only
//   XBOT_MIN_USD       smallest whale move worth a post (default 500000)
//   XBOT_PER_DAY, XBOT_GAP_MIN   see above

import { createHmac, randomBytes } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import { FONTS, WORDMARK, clip, escXml as esc, mark } from "./cards.mjs";
import { predictCardSvg } from "./marketcards.mjs";
import { fetchPredict } from "./predictboard.mjs";

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

/** Posts `text` with one PNG; returns the post id. */
export async function postWithImage(keys, text, png) {
  const m = await xPost(keys, "/2/media/upload", { media: Buffer.from(png).toString("base64"), media_category: "tweet_image" });
  const mediaId = m?.data?.id;
  if (!mediaId) throw new Error("X media upload: no id");
  const t = await xPost(keys, "/2/tweets", { text, media: { media_ids: [String(mediaId)] } });
  return t?.data?.id ?? null;
}

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

export async function xbotLoop(pool, log) {
  if (process.env.XBOT_OFF === "1") return;
  const keys = { apiKey: process.env.X_API_KEY, apiSecret: process.env.X_API_SECRET, accessToken: process.env.X_ACCESS_TOKEN, accessSecret: process.env.X_ACCESS_SECRET };
  if (!keys.apiKey || !keys.apiSecret || !keys.accessToken || !keys.accessSecret) return;
  const dry = process.env.XBOT_DRY === "1";
  const minUsd = Number(process.env.XBOT_MIN_USD ?? "500000");
  const perDay = Number(process.env.XBOT_PER_DAY ?? "30");
  const gap = Number(process.env.XBOT_GAP_MIN ?? "30") * 60e3;
  await pool.query(SQL);
  log(`x bot: on${dry ? " (dry run: nothing is posted)" : ""}; whale moves of ${money(minUsd)}+, up to ${perDay} posts a day`);
  let failures = 0;
  for (;;) {
    try {
      const { rows } = await pool.query(
        `select count(*)::int as day, max(posted_at) as last,
                max(posted_at) filter (where kind = 'predict') as last_predict
         from xbot_posts where posted_at > now() - interval '24 hours'`
      );
      const s = rows[0];
      const since = s.last ? Date.now() - new Date(s.last).getTime() : Infinity;
      if (s.day < perDay && since >= gap) {
        let post = null;
        const w = await nextWhale(pool, minUsd);
        if (w) {
          post = { kind: "whale", ref: `w:${w.id}:${w.address}:${w.coin}`, text: whaleText(w, w), svg: whaleCardSvg(w, w) };
        } else if (!s.last_predict || Date.now() - new Date(s.last_predict).getTime() > 3 * 3600e3) {
          const q = await nextPrediction().catch(() => null);
          if (q) {
            const title = q.title.replace(/(\d{2}:\d{2})(\?)?$/, "$1 UTC$2");
            post = { kind: "predict", ref: `p:${q.outcome}`, text: predictText({ ...q, title }, q.sides[0].price), svg: predictCardSvg({ tab: q.tab, title, sides: q.sides }) };
          }
        }
        if (post) {
          if (dry) {
            log(`x bot (dry): ${post.text.replace(/\n+/g, " / ")}`);
            await pool.query(`insert into xbot_posts (kind, ref, text) values ($1, $2, $3) on conflict (ref) do nothing`, [post.kind, post.ref, post.text]);
          } else {
            // the row first: if X takes the post but the answer is lost, it is never posted twice
            const ins = await pool.query(`insert into xbot_posts (kind, ref, text) values ($1, $2, $3) on conflict (ref) do nothing returning id`, [post.kind, post.ref, post.text]);
            if (ins.rowCount) {
              const id = await postWithImage(keys, post.text, png(post.svg));
              await pool.query(`update xbot_posts set post_id = $2 where id = $1`, [ins.rows[0].id, id]);
              log(`x bot: posted ${post.kind} (${id})`);
            }
          }
        }
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
