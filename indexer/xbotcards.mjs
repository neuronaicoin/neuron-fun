// The X bot's picture cards (xbot.mjs): one look per kind of post, all in sasa's own colours
// (dark background, orange accent, green up / red down), so the timeline doesn't look like the
// same card over and over. 1200x675 (16:9, what X shows whole).

import { Resvg } from "@resvg/resvg-js";
import { FONTS, clip, escXml as esc, mark } from "./cards.mjs";

const W = 1200;
const H = 675;
const BG = "#0B0806";
const CARD = "#17110C";
const LINE = "#2E231A";
const INK = "#FFF4EC";
const MUTED = "#8F7F73";
const SOFT = "#A8978A";
const OR = "#FF6B1A";
const UP = "#2BC06D";
const DN = "#F0565E";
const GOLD = "#F5B544";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
export function money(v) {
  const a = Math.abs(num(v));
  if (a >= 1e9) return `$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `$${Math.round(a / 1e3)}K`;
  return `$${Math.round(a)}`;
}
export const px = (p) => (p >= 1000 ? `$${Math.round(p).toLocaleString("en-US")}` : p >= 1 ? `$${p.toFixed(2)}` : `$${Number(Number(p).toPrecision(4))}`);
const pct = (v, d = 1) => `${v >= 0 ? "+" : "-"}${Math.abs(v) >= 100 ? Math.round(Math.abs(v)) : Math.abs(v).toFixed(d)}%`;

const logo = (x = 60, y = 40) => `<g transform="translate(${x},${y})">${mark(0, 0, 44).replace(/^<g[^>]*>/, "<g>")}</g><text x="${x + 56}" y="${y + 34}" font-family="Sora" font-weight="700" font-size="34" fill="${INK}">sasa</text>`;
const T = (x, y, s, c, t, w = 700, a = "start", f = "Sora") =>
  `<text x="${x}" y="${y}" font-family="${f}" font-weight="${w}" font-size="${s}" fill="${c}" text-anchor="${a}">${esc(String(t))}</text>`;
const glow = (cx, cy, c = OR, o = 0.28) =>
  `<defs><radialGradient id="gl" cx="${cx}" cy="${cy}" r="70%"><stop offset="0" stop-color="${c}" stop-opacity="${o}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#gl)"/>`;
const svg = (inner, g = "") => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${BG}"/>${g}${inner}</svg>`;
const pill = (x, y, t, bg, fg) => {
  const w = Math.round(44 + String(t).length * 13);
  return `<rect x="${x}" y="${y}" width="${w}" height="46" rx="23" fill="${bg}"/>${T(x + w / 2, y + 31, 21, fg, t, 800, "middle")}`;
};
/** Font size so `text` fits `width` (Sora bold is about 0.62 em a character). */
const fit = (text, width, max, min = 40) => Math.max(min, Math.min(max, Math.floor(width / (String(text).length * 0.62))));

export const png = (s) => new Resvg(s, { fitTo: { mode: "width", value: W }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Sora" } }).render().asPng();

const label = (coin) => String(coin).slice(String(coin).indexOf(":") + 1).toUpperCase();

/** A top trader's move: sonar rings. m: { coin, kind, side, usd, px, lev }, w: { rank, pnl_month } */
export function whaleCard(m, w) {
  let rings = "";
  for (let i = 1; i <= 5; i++) rings += `<circle cx="980" cy="330" r="${i * 70}" fill="none" stroke="${OR}" stroke-opacity="${0.35 - i * 0.05}" stroke-width="3"/>`;
  const closed = m.kind === "close";
  const badge = { open: "WHALE ALERT", flip: "WHALE FLIPPED", add: "WHALE ADDED", close: "WHALE CLOSED" }[m.kind] || "WHALE ALERT";
  const big = `${money(m.usd)} ${m.side === "long" ? "LONG" : "SHORT"}`;
  const stats = [
    w.pnl_month > 0 ? [`+${money(w.pnl_month)}`, "last 30 days"] : null,
    w.rank ? [`#${w.rank}`, "top trader"] : null,
  ].filter(Boolean);
  return png(
    svg(
      `${rings}<circle cx="980" cy="330" r="16" fill="${OR}"/>${logo()}${pill(60, 130, badge, closed ? DN : OR, "#FFFFFF")}
${T(56, 300, fit(big, 760, 120), closed ? INK : m.side === "long" ? UP : DN, big, 800)}
${T(60, 370, 42, INK, `${clip(label(m.coin), 10)}${m.lev ? ` · ${Math.round(m.lev)}x` : ""} · ${closed ? "out at" : "entry"} ${px(m.px)}`)}
${stats.length ? `<rect x="60" y="430" width="${stats.length * 280}" height="96" rx="18" fill="${CARD}" stroke="${LINE}"/>` : ""}
${stats.map(([v, l], i) => T(90 + i * 280, 475, 34, INK, v, 800) + T(90 + i * 280, 508, 20, MUTED, l, 400, "start", "IBM Plex Mono")).join("")}
${T(60, 630, 24, SOFT, closed ? "his next move shows on sasa first" : "copy him in one tap on sasa", 600)}`,
      glow("85%", "45%")
    )
  );
}

/** Fear & greed: a dial. */
export function fearCard(score) {
  const ang = (v) => Math.PI * (1 - v / 100);
  const pt = (v, rr) => [600 + rr * Math.cos(ang(v)), 480 - rr * Math.sin(ang(v))];
  const cols = [DN, "#F5803E", GOLD, "#8BD15A", UP];
  let arcs = "";
  for (let i = 0; i < 5; i++) {
    const [a, b] = pt(i * 20 + 1, 280);
    const [c, d] = pt((i + 1) * 20 - 1, 280);
    arcs += `<path d="M${a} ${b} A280 280 0 0 1 ${c} ${d}" stroke="${cols[i]}" stroke-width="40" fill="none"/>`;
  }
  const [nx, ny] = pt(score, 225);
  const lab = score <= 24 ? "EXTREME FEAR" : score <= 44 ? "FEAR" : score <= 55 ? "NEUTRAL" : score <= 74 ? "GREED" : "EXTREME GREED";
  const col = cols[Math.min(4, Math.floor(score / 20))];
  return png(
    svg(
      `${logo()}${T(1140, 74, 22, MUTED, "FEAR & GREED · TODAY", 700, "end")}${arcs}<line x1="600" y1="480" x2="${nx}" y2="${ny}" stroke="${INK}" stroke-width="12" stroke-linecap="round"/><circle cx="600" cy="480" r="20" fill="${INK}"/>
${T(600, 590, 96, col, score, 800, "middle")}${T(600, 645, 30, INK, lab, 800, "middle")}`,
      glow("50%", "80%", col, 0.18)
    )
  );
}

/** A yes / no question: a ticket. q: { title, ends, yes } */
export function predictCard(q) {
  const yes = Math.round(num(q.yes) * 100);
  return png(
    svg(`${logo()}<rect x="60" y="120" width="1080" height="500" rx="28" fill="${CARD}" stroke="${LINE}" stroke-width="2"/><circle cx="60" cy="370" r="34" fill="${BG}"/><circle cx="1140" cy="370" r="34" fill="${BG}"/><line x1="100" y1="370" x2="1100" y2="370" stroke="${LINE}" stroke-width="3" stroke-dasharray="14 12"/>
${T(100, 180, 22, OR, `PREDICTION${q.ends ? ` · ENDS ${q.ends}` : ""}`, 800)}${T(100, 270, fit(q.title, 1000, 64, 40), INK, clip(q.title, 40), 800)}${T(100, 325, 28, MUTED, "right call pays $1 a share", 600)}
<rect x="100" y="420" width="470" height="150" rx="20" fill="#123A24"/>${T(335, 520, 64, UP, `YES ${yes}%`, 800, "middle")}<rect x="630" y="420" width="470" height="150" rx="20" fill="#3A1416"/>${T(865, 520, 64, DN, `NO ${100 - yes}%`, 800, "middle")}`)
  );
}

/** A stock / commodity mover: ticker tape and its day. m: { label, name, mark, change }, tape: [{label, change}], line: [prices] */
export function stockCard(m, tape = [], line = [], closed = false) {
  const t = tape.map((x) => `${x.label} ${pct(x.change)}`).join("   ");
  const up = m.change >= 0;
  let chart = "";
  if (line.length >= 4) {
    const lo = Math.min(...line);
    const hi = Math.max(...line);
    const pts = line.map((v, i) => `${Math.round(60 + (1080 * i) / (line.length - 1))},${Math.round(600 - (hi > lo ? ((v - lo) / (hi - lo)) * 150 : 75))}`).join(" ");
    chart = `<polyline points="${pts}" fill="none" stroke="${up ? UP : DN}" stroke-width="7" stroke-linejoin="round"/>`;
  }
  const L = clip(m.label.toUpperCase(), 8);
  return png(
    svg(`<rect y="0" width="${W}" height="56" fill="${CARD}"/>${T(20, 38, 24, SOFT, `${t}   ${t}`, 600, "start", "IBM Plex Mono")}${logo(60, 90)}${T(1140, 124, 22, OR, `STOCKS · 24/7${closed ? " · MARKET CLOSED" : ""}`, 800, "end")}
${T(56, 330, fit(L, 600, 160, 90), INK, L, 800)}${m.name ? T(62, 385, 36, SOFT, clip(m.name, 24), 600) : ""}${T(1140, 300, 96, up ? UP : DN, pct(m.change), 800, "end")}${T(1140, 365, 48, INK, px(m.mark), 400, "end", "IBM Plex Mono")}
${chart}${T(60, 655, 24, SOFT, closed ? `wall street is asleep. ${L} isn't.` : `long or short ${L} on sasa, nights and weekends too`, 700)}`)
  );
}

/** The day's biggest top-300 gainer: rising bars from its last days. c: { symbol, name, rank, price_usd, change_24h, spark } */
export function spotCard(c) {
  const S = String(c.symbol || "").toUpperCase().slice(0, 8);
  const sp = Array.isArray(c.spark) ? c.spark.map(num).filter((x) => x > 0) : [];
  const vals = sp.length >= 7 ? Array.from({ length: 7 }, (_, i) => sp[Math.floor((i * (sp.length - 1)) / 6)]) : [90, 130, 120, 170, 210, 260, 330];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const bars = vals.map((v, i) => { const h = Math.round(60 + (hi > lo ? ((v - lo) / (hi - lo)) * 270 : 150)); return `<rect x="${720 + i * 62}" y="${560 - h}" width="44" height="${h}" rx="8" fill="${i === 6 ? UP : "#1E3B2A"}"/>`; }).join("");
  return png(
    svg(
      `${bars}${logo()}${pill(60, 130, "#1 GAINER · TOP 300", UP, "#06200F")}${T(56, 330, fit(S, 620, 150, 80), INK, S, 800)}${T(60, 440, 110, UP, pct(c.change_24h), 800)}${T(60, 505, 32, SOFT, `${px(num(c.price_usd))}${c.rank ? ` · #${c.rank} by market cap` : ""}`, 600)}${T(60, 630, 24, SOFT, "still early or already late?", 600)}`,
      glow("80%", "70%", UP, 0.16)
    )
  );
}

/** The day's hottest meme: a tilted sticker. c: { symbol, change_24h, mcap, vol, network } */
export function memeCard(c, net) {
  const S = `$${String(c.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10)} ${pct(c.change_24h)}`;
  return png(
    svg(
      `${logo()}<g transform="rotate(-4 600 360)"><rect x="140" y="170" width="920" height="380" rx="36" fill="${OR}"/>${T(600, 280, 46, "#2A1204", "HOTTEST MEME TODAY", 800, "middle")}${T(600, 400, fit(S, 860, 110, 56), "#FFFFFF", S, 800, "middle")}${T(600, 470, 32, "#2A1204", `${money(c.mcap)} mcap · ${money(c.vol)} volume · ${net}`, 700, "middle")}</g>${T(600, 640, 26, SOFT, "who caught this one early?", 700, "middle")}`,
      glow("50%", "50%", OR, 0.22)
    )
  );
}

/** The day's best traders: a podium. top: [{ name, rank, pnl_day }] x3 */
export function recapCard(top) {
  const who = (w) => clip(w.name || `Whale #${w.rank}`, 14);
  const col = (x, y, wdt, h, color, n, w, big) =>
    `<rect x="${x}" y="${y}" width="${wdt}" height="${h}" rx="16" fill="${CARD}" stroke="${color}" stroke-width="${big ? 3 : 2}"/>${T(x + wdt / 2, y + (big ? 80 : 70), big ? 72 : 58, color, `#${n}`, 800, "middle")}${T(x + wdt / 2, y + (big ? 160 : 140), big ? 44 : 38, UP, `+${money(w.pnl_day)}`, 800, "middle")}${T(x + wdt / 2, Math.min(y + (big ? 210 : 185), y + h - 24), 24, SOFT, who(w), 700, "middle")}`;
  return png(
    svg(
      `${logo()}${T(600, 160, 44, GOLD, "TODAY'S TOP WHALES", 800, "middle")}${col(440, 300, 320, 320, GOLD, 1, top[0], true)}${col(100, 380, 320, 240, "#C9CED6", 2, top[1])}${col(780, 430, 320, 190, "#C98A4B", 3, top[2])}`,
      glow("50%", "20%", GOLD, 0.16)
    )
  );
}

/** The biggest open position among top traders: warning stripes. p: { coin, side, v, l } */
export function biggestCard(p) {
  const L = label(p.coin);
  const side = `${clip(L, 8)} ${p.side === "long" ? "LONG" : "SHORT"}`;
  const stripes = Array.from({ length: 16 }, (_, i) => `<rect x="${i * 90 - 60}" y="625" width="45" height="50" fill="${DN}" transform="skewX(-30)"/>`).join("");
  return png(
    svg(
      `${stripes}${logo()}${T(60, 170, 24, DN, "THE BIGGEST BET ON THE BOARD RIGHT NOW", 800)}${T(56, 330, 140, INK, money(p.v), 800)}${T(60, 430, fit(side, 1080, 88, 56), p.side === "long" ? UP : DN, side, 800)}${T(60, 495, 32, SOFT, `${p.l ? `${Math.round(p.l)}x · ` : ""}one wallet · if this goes wrong…`, 600)}`,
      glow("90%", "20%", DN, 0.14)
    )
  );
}
