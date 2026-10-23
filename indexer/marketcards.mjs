// Share cards for Futures markets and Predict questions: a 1200x630 PNG each, so a link shared
// on X shows what it is about ("TSLA · Tesla · $428.10", "BTC above $82,000 at 18:30 UTC?").
// Drawn here, uploaded to the public "cards" bucket (cards.mjs does the same for coins); the
// website's functions/futures and functions/predict point each link's preview at its card.
//
//   futures:  cards/f-<coin>.png   (coin "xyz:TSLA" → "xyz-tsla")  busiest 40 crypto + every stock / commodity / index
//   predict:  cards/p-<outcome>.png                                every open question
//
// Redrawn only when what it shows changes (price ±1%, chance ±2¢), looked at every 5 minutes.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (as cards.mjs); MARKET_CARD_EVERY_MS (default 300000);
//      MARKET_CARDS_OFF=1 switches this off.

import { Resvg } from "@resvg/resvg-js";
import { FONTS, WORDMARK, clip, escXml as esc, mark, upload } from "./cards.mjs";
import { fetchPredict } from "./predictboard.mjs";

const HL = "https://api.hyperliquid.xyz/info";
const W = 1200;
const H = 630;

async function info(body) {
  const r = await fetch(HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
  return r.json();
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export const futuresCardName = (coin) => `f-${String(coin).toLowerCase().replace(/[^0-9a-z]+/g, "-")}.png`;
export const predictCardName = (outcome) => `p-${Number(outcome)}.png`;

const NAMES = {
  TSLA: "Tesla", NVDA: "Nvidia", AAPL: "Apple", MSFT: "Microsoft", AMZN: "Amazon", GOOGL: "Alphabet", META: "Meta", NFLX: "Netflix",
  AMD: "AMD", INTC: "Intel", HOOD: "Robinhood", COIN: "Coinbase", MSTR: "Strategy", PLTR: "Palantir", ORCL: "Oracle", TSM: "TSMC",
  GOLD: "Gold", SILVER: "Silver", CL: "Crude oil", OIL: "Crude oil", BRENTOIL: "Brent oil", NATGAS: "Natural gas", COPPER: "Copper",
  XYZ100: "Nasdaq 100", SPX: "S&P 500", BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", HYPE: "Hyperliquid", XRP: "XRP", DOGE: "Dogecoin",
};

function price(v) {
  if (!(v > 0)) return "—";
  if (v >= 1) return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${Number(v.toPrecision(4))}`;
}
const pct = (v) => (v === null ? "" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`);

/** Words broken into lines of at most `max` characters (at most `lines` lines, the last cut with …). */
export function wrap(text, max, lines) {
  const out = [];
  let cur = "";
  for (const w of String(text).split(/\s+/)) {
    if (!w) continue;
    if ((cur ? cur.length + 1 : 0) + w.length <= max) cur = cur ? `${cur} ${w}` : w;
    else {
      if (cur) out.push(cur);
      cur = w.length > max ? w.slice(0, max - 1) + "…" : w;
    }
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = clip(kept[lines - 1] + " " + out.slice(lines).join(" "), max);
    return kept;
  }
  return out;
}

const frame = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><radialGradient id="glow" cx="85%" cy="15%" r="70%"><stop offset="0%" stop-color="#FF6B1A" stop-opacity="0.30"/><stop offset="100%" stop-color="#FF6B1A" stop-opacity="0"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="#0B0806"/><rect width="${W}" height="${H}" fill="url(#glow)"/>
${mark(80, 56, 52)}
${WORDMARK}
<text x="1120" y="92" text-anchor="end" font-family="IBM Plex Mono" font-size="22" fill="#8F7F73">sasapad.fun</text>
${inner}
</svg>`;

export function futuresCardSvg(m) {
  const up = (m.change ?? 0) >= 0;
  const kind = m.group === "stocks" ? "STOCK" : m.group === "commodities" ? "COMMODITY" : m.group === "indices" ? "INDEX" : m.group === "fx" ? "FX" : "CRYPTO";
  const badge = `${kind} FUTURES${m.dex ? " · 24/7" : ""} · UP TO ${m.maxLev}X`;
  const bw = Math.round(36 + badge.length * 12.2);
  const nameSize = m.label.length <= 6 ? 120 : m.label.length <= 9 ? 96 : 72;
  return frame(`<g transform="translate(80,170)"><rect width="${bw}" height="44" rx="22" fill="#2A1A10"/><text x="${bw / 2}" y="29" text-anchor="middle" font-family="Sora" font-weight="700" font-size="19" fill="#FF6B1A">${esc(badge)}</text></g>
<text x="76" y="${330 + (nameSize - 96) / 3}" font-family="Sora" font-weight="700" font-size="${nameSize}" fill="#FFF4EC">${esc(clip(m.label, 12))}</text>
${m.name ? `<text x="80" y="392" font-family="Sora" font-weight="600" font-size="40" fill="#A8978A">${esc(clip(m.name, 28))}</text>` : ""}
<text x="1120" y="320" text-anchor="end" font-family="IBM Plex Mono" font-size="76" fill="#FFF4EC">${esc(price(m.mark))}</text>
<text x="1120" y="382" text-anchor="end" font-family="IBM Plex Mono" font-size="40" fill="${up ? "#2BC06D" : "#F0565E"}">${esc(pct(m.change))} today</text>
<line x1="80" y1="445" x2="1120" y2="445" stroke="#2E231A" stroke-width="2"/>
<text x="80" y="510" font-family="Sora" font-weight="700" font-size="40" fill="#FFF4EC">Long or short <tspan fill="#FF6B1A">${esc(m.label)}</tspan> on sasa</text>
<text x="80" y="565" font-family="Sora" font-weight="600" font-size="26" fill="#8F7F73">${m.dex ? "Weekends and nights too. From your sasa balance." : "From your sasa balance, in seconds."}</text>`);
}

const dollars = (p) => (p === null || p === undefined ? "—" : `$${Math.max(0.01, Math.min(0.99, p)).toFixed(2)}`);

export function predictCardSvg(q) {
  const lines = wrap(q.title, 30, 3);
  const size = lines.length <= 2 ? 56 : 48;
  const top = 240;
  const title = lines.map((l, i) => `<text x="80" y="${top + i * (size + 14)}" font-family="Sora" font-weight="700" font-size="${size}" fill="#FFF4EC">${esc(l)}</text>`).join("\n");
  const kind = q.tab === "sports" ? "SPORTS" : q.tab === "rates" ? "RATES" : q.tab === "price" ? "PRICE" : "PREDICTION";
  const badge = `${kind} PREDICTION`;
  const bw = Math.round(36 + badge.length * 12.2);
  let answers;
  if (q.rows) {
    // a question with several answers: up to three rows
    answers = q.rows
      .slice(0, 3)
      .map((r, i) => {
        const y = 400 + i * 54;
        return `<text x="80" y="${y + 32}" font-family="Sora" font-weight="600" font-size="30" fill="#FFF4EC">${esc(clip(r.label, 30))}</text>
<rect x="840" y="${y}" width="280" height="44" rx="12" fill="#123A24"/><text x="980" y="${y + 31}" text-anchor="middle" font-family="IBM Plex Mono" font-size="26" fill="#2BC06D">Yes ${esc(dollars(r.price))}</text>`;
      })
      .join("\n");
  } else {
    const box = (x, color, bg, name, p) =>
      `<rect x="${x}" y="440" width="510" height="110" rx="22" fill="${bg}"/><text x="${x + 255}" y="510" text-anchor="middle" font-family="Sora" font-weight="700" font-size="44" fill="${color}">${esc(clip(name, 14))} ${esc(dollars(p))}</text>`;
    answers = box(80, "#2BC06D", "#123A24", q.sides[0].name, q.sides[0].price) + box(610, "#F0565E", "#3A1416", q.sides[1].name, q.sides[1].price);
  }
  return frame(`<g transform="translate(80,120)"><rect width="${bw}" height="44" rx="22" fill="#2A1A10"/><text x="${bw / 2}" y="29" text-anchor="middle" font-family="Sora" font-weight="700" font-size="19" fill="#FF6B1A">${esc(badge)}</text></g>
${title}
${answers}
<text x="80" y="600" font-family="Sora" font-weight="600" font-size="24" fill="#8F7F73">What's your call? <tspan fill="#FF6B1A">Yes or no on sasa</tspan></text>`);
}

function png(svg) {
  return new Resvg(svg, { fitTo: { mode: "width", value: W }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Sora" } }).render().asPng();
}

/** The markets worth a card: the busiest crypto, and every stock, commodity, index and FX (USDC builder exchanges). */
async function futuresMarkets() {
  const [meta, ctxs] = await info({ type: "metaAndAssetCtxs" });
  const rows = [];
  meta.universe.forEach((u, i) => {
    const c = ctxs[i];
    if (!c || u.isDelisted || !(num(c.markPx) > 0)) return;
    const prev = num(c.prevDayPx);
    rows.push({ coin: u.name, label: u.name, name: NAMES[u.name] ?? null, dex: "", group: "crypto", maxLev: Math.min(20, u.maxLeverage), mark: num(c.markPx), change: prev > 0 ? (num(c.markPx) / prev - 1) * 100 : null, vol: num(c.dayNtlVlm) });
  });
  const out = rows.sort((a, b) => b.vol - a.vol).slice(0, 40);
  const crypto = new Set(rows.map((r) => r.coin.toUpperCase()));
  const dexes = ((await info({ type: "perpDexs" }).catch(() => [])) || []).flatMap((d, i) => (i > 0 && d?.name ? [d.name] : []));
  const best = new Map();
  for (const dex of dexes) {
    const res = await info({ type: "metaAndAssetCtxs", dex }).catch(() => null);
    if (!res || (res[0]?.collateralToken ?? 0) !== 0) continue;
    res[0].universe.forEach((u, i) => {
      const c = res[1][i];
      if (!c || u.isDelisted || !(num(c.markPx) > 0)) return;
      const label = u.name.slice(u.name.indexOf(":") + 1);
      if (crypto.has(label.toUpperCase()) || !(num(c.dayNtlVlm) > 0)) return;
      const prev = num(c.prevDayPx);
      const m = { coin: u.name, label, name: NAMES[label.toUpperCase()] ?? null, dex, group: groupOf(label), maxLev: Math.min(20, u.maxLeverage), mark: num(c.markPx), change: prev > 0 ? (num(c.markPx) / prev - 1) * 100 : null, vol: num(c.dayNtlVlm) };
      const k = label.toUpperCase();
      if (!best.has(k) || best.get(k).vol < m.vol) best.set(k, m);
    });
  }
  return [...out, ...best.values()];
}
const COMMODITIES = new Set(["GOLD", "SILVER", "CL", "OIL", "WTI", "BRENTOIL", "BRENT", "NATGAS", "COPPER", "PLATINUM", "PALLADIUM", "URANIUM", "XAU", "XAG"]);
const INDICES = new Set(["XYZ100", "SPX", "SP500", "US500", "NDX", "NAS100", "US100", "DJI", "US30", "RUT", "VIX", "DAX", "JP225", "MAG7", "SMALL2000"]);
const FX = new Set(["EUR", "JPY", "GBP", "CHF", "AUD", "CAD", "NZD", "CNH", "DXY"]);
const groupOf = (l) => (COMMODITIES.has(l.toUpperCase()) ? "commodities" : INDICES.has(l.toUpperCase()) ? "indices" : FX.has(l.toUpperCase()) ? "fx" : "stocks");

const drawn = new Map(); // card name → what it showed last time
const utc = (t) => t.replace(/(\d{2}:\d{2})(\?)?$/, "$1 UTC$2");

export async function marketCardRound({ url, key, log = () => {}, put = upload } = {}) {
  let n = 0;
  const send = async (name, sig, svg) => {
    if (drawn.get(name) === sig) return;
    await put(url, key, name, png(svg));
    drawn.set(name, sig);
    n++;
  };
  try {
    for (const m of await futuresMarkets()) {
      const sig = `${Math.round(Math.log(m.mark) / Math.log(1.01))}:${Math.round(m.change ?? 0)}:${m.maxLev}`;
      await send(futuresCardName(m.coin), sig, futuresCardSvg(m)).catch((e) => log(`market cards: ${m.coin}: ${e.message}`));
    }
  } catch (e) {
    log(`market cards (futures): ${e.message}`);
  }
  try {
    const board = await fetchPredict();
    const items = [
      ...board.singles.map((o) => ({ id: o.outcome, q: { tab: o.tab, title: utc(o.title), sides: o.sides } })),
      ...board.groups.flatMap((g) => {
        const q = { tab: g.tab, title: utc(g.title), rows: g.answers.map((a) => ({ label: a.label || a.title, price: a.sides[0].price })) };
        return g.answers.map((a) => ({ id: a.outcome, q }));
      }),
    ];
    for (const { id, q } of items) {
      const sig = JSON.stringify([q.title, ...(q.rows ? q.rows.map((r) => Math.round((r.price ?? 0) * 50)) : q.sides.map((s) => Math.round((s.price ?? 0) * 50)))]);
      await send(predictCardName(id), sig, predictCardSvg(q)).catch((e) => log(`market cards: prediction ${id}: ${e.message}`));
    }
  } catch (e) {
    log(`market cards (predict): ${e.message}`);
  }
  if (drawn.size > 5000) drawn.clear();
  return n;
}

export async function marketCardLoop(log) {
  if (process.env.MARKET_CARDS_OFF === "1") return;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  const every = Number(process.env.MARKET_CARD_EVERY_MS ?? "300000");
  for (;;) {
    const n = await marketCardRound({ url, key, log }).catch((e) => (log(`market cards: ${e.message}`), 0));
    if (n) log(`market cards: drew ${n}`);
    await new Promise((r) => setTimeout(r, every));
  }
}
