// Picture cards for the X bot's feature threads (xthreads.mjs): 1600x900 (X's own 16:9), in the
// same look as the hand-made sasa thread cards: dark background, soft orange glow, a big white
// headline, grey lines under it, an orange link pill, and a real phone screenshot of the feature
// (indexer/xshots/*.jpg) on the right.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { FONTS, escXml as esc, mark } from "./cards.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const W = 1600;
const H = 900;
const BG = "#0A0B10";
const INK = "#FFFFFF";
const SOFT = "#A0A5B9";
const MUTED = "#787D91";
const OR = "#FF7A1A";
const FRAME = "#3C3C50";

const shots = new Map();
/** A screenshot as { uri, w, h } (null if the file is missing). */
function shot(name) {
  if (shots.has(name)) return shots.get(name);
  const f = join(here, "xshots", `${name}.jpg`);
  let v = null;
  if (existsSync(f)) {
    const b = readFileSync(f);
    // JPEG size from the SOF marker
    let i = 2, w = 0, h = 0;
    while (i < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); break; }
      i += 2 + b.readUInt16BE(i + 2);
    }
    if (w && h) v = { uri: `data:image/jpeg;base64,${b.toString("base64")}`, w, h };
  }
  shots.set(name, v);
  return v;
}

/** Splits `t` into lines of at most `max` characters (by words). */
function wrap(t, max) {
  const out = [];
  let cur = "";
  for (const w of String(t).split(/\s+/)) {
    const n = cur ? `${cur} ${w}` : w;
    if (n.length > max && cur) { out.push(cur); cur = w; } else cur = n;
  }
  if (cur) out.push(cur);
  return out;
}

const T = (x, y, s, c, t, w = 700, a = "start") =>
  `<text x="${x}" y="${y}" font-family="Sora" font-weight="${w}" font-size="${s}" fill="${c}" text-anchor="${a}">${esc(String(t))}</text>`;

const frame = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
  `<defs><radialGradient id="g" cx="0.78" cy="0.62" r="0.55"><stop offset="0" stop-color="#5A2305" stop-opacity="0.95"/><stop offset="1" stop-color="#5A2305" stop-opacity="0"/></radialGradient></defs>` +
  `<rect width="${W}" height="${H}" fill="${BG}"/><rect width="${W}" height="${H}" fill="url(#g)"/>${inner}</svg>`;

const brand = (x = 70, y = 62) =>
  `<g transform="translate(${x},${y})">${mark(0, 0, 50).replace(/^<g[^>]*>/, "<g>")}</g>${T(x + 64, y + 40, 46, OR, "sasa", 700)}`;

function pill(x, y, t) {
  const w = Math.round(64 + String(t).length * 22.5);
  return `<rect x="${x}" y="${y}" width="${w}" height="68" rx="34" fill="${OR}"/>${T(x + w / 2, y + 46, 37, "#111111", t, 700, "middle")}`;
}

/** A screenshot in a rounded frame, fitted into the box (x, y, maxW, maxH), centred vertically. */
function phone(name, x1, maxW, maxH, idx = 0) {
  const s = shot(name);
  if (!s) return { svg: "", w: 0 };
  const k = Math.min(maxW / s.w, maxH / s.h);
  const w = Math.round(s.w * k), h = Math.round(s.h * k);
  const x = x1 - w, y = Math.round((H - h) / 2 + 30);
  return {
    w,
    svg:
      `<defs><clipPath id="c${idx}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="28"/></clipPath></defs>` +
      `<rect x="${x - 8}" y="${y - 8}" width="${w + 16}" height="${h + 16}" rx="34" fill="none" stroke="${FRAME}" stroke-width="3"/>` +
      `<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" xlink:href="${s.uri}" clip-path="url(#c${idx})"/>`,
  };
}

/** Headline + grey lines on the left, a screenshot on the right (the main card). */
export function shotCard({ shot: name, title, lines = [], link = "sasapad.fun" }) {
  const p = phone(name, W - 110, 640, 760);
  const textW = W - 110 - p.w - 120; // room left of the screenshot
  const size = textW > 760 ? 70 : 62;
  const tl = wrap(title, Math.max(14, Math.floor(textW / (size * 0.6)))).slice(0, 4);
  let y = 210, out = brand();
  for (const l of tl) { out += T(70, y, size, INK, l); y += size + 16; }
  y += 22;
  for (const l of lines.slice(0, 5)) { out += T(70, y, 32, SOFT, l, 600); y += 48; }
  out += pill(70, 770, link);
  return frame(out + p.svg);
}

/** Four big lines, the last one orange (the thread opener), with an optional screenshot. */
export function bigCard({ shot: name = null, big = [], sub = "", link = "sasapad.fun" }) {
  const p = name ? phone(name, W - 90, 560, 700) : { svg: "", w: 0 };
  const room = W - 90 - p.w - 110;
  const longest = Math.max(...big.map((l) => l.length), 1);
  const size = Math.max(54, Math.min(92, Math.floor(room / (longest * 0.66))));
  let y = 230, out = brand();
  big.slice(0, 5).forEach((l, i) => { out += T(70, y, size, i === big.length - 1 ? OR : INK, l, 700); y += size + 22; });
  if (sub) for (const l of wrap(sub, Math.floor(room / 19)).slice(0, 2)) { out += T(70, y + 20, 32, SOFT, l, 600); y += 46; }
  out += pill(70, 770, link);
  return frame(out + p.svg);
}

/** Numbered steps (01 / 02 / 03) next to a screenshot. */
export function stepsCard({ shot: name = null, title, steps = [], link = "sasapad.fun" }) {
  const p = name ? phone(name, W - 100, 560, 720) : { svg: "", w: 0 };
  const room = W - 100 - p.w - 120;
  let out = brand();
  let y = 200;
  for (const l of wrap(title, Math.floor(room / 38)).slice(0, 2)) { out += T(70, y, 62, INK, l); y += 76; }
  y += 30;
  steps.slice(0, 4).forEach(([head, body], i) => {
    out += T(70, y + 8, 52, OR, String(i + 1).padStart(2, "0"));
    out += T(170, y, 36, INK, head);
    const b = wrap(body, Math.floor((room - 100) / 17))[0] || "";
    out += T(170, y + 42, 28, SOFT, b, 600);
    y += 112;
  });
  out += pill(70, 790, link);
  return frame(out + p.svg);
}

const CHAINS = [["Robinhood", "#12B886"], ["Solana", "#9945FF"], ["Base", "#3B6FF5"], ["BNB Chain", "#F0B90B"], ["Arc", "#8B7CF6"]];

/** The closing card: launch on any chain, hold $10K for 1 hour, 60% of the fees. */
export function ctaCard({ title = "Launch your coin on ANY chain", sub = "Hold $10K market cap for 1 hour and you earn 60% of trade fees", link = "sasapad.fun" } = {}) {
  let out = brand();
  out += T(70, 230, 72, INK, title);
  out += T(70, 292, 34, SOFT, sub, 700);
  out += T(760, 360, 24, MUTED, "CREATOR CUT", 700) + T(1340, 360, 24, MUTED, "AFTER", 700);
  CHAINS.forEach(([n, c], i) => {
    const y = 382 + i * 76;
    out += `<rect x="70" y="${y}" width="1460" height="62" rx="14" fill="#14161F"/>`;
    out += `<circle cx="112" cy="${y + 31}" r="10" fill="${c}"/>`;
    out += T(140, y + 43, 38, INK, n);
    out += T(500, y + 43, 32, SOFT, "launch", 700);
    out += T(760, y + 43, 38, OR, "60%");
    out += `<rect x="930" y="${y + 18}" width="330" height="26" rx="13" fill="${OR}"/>`;
    out += T(1340, y + 43, 32, INK, "$10K · 1h", 600);
  });
  out += pill(70, 790, link);
  return frame(out);
}

export const renderPng = (svg) =>
  new Resvg(svg, { fitTo: { mode: "width", value: W }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Sora" } }).render().asPng();

/** One card spec ({ type, ... }) to PNG bytes. */
export function cardPng(spec) {
  const f = { shot: shotCard, big: bigCard, steps: stepsCard, cta: ctaCard }[spec.type] || shotCard;
  return renderPng(f(spec));
}
