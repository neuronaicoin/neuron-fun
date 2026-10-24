// Share cards: a 1200x630 PNG per coin, shown when a coin link is shared on
// X, Telegram or Discord. Rendered here (server side) and uploaded to the
// public "cards" bucket in Supabase Storage; a small Cloudflare function on
// the website points each coin page's preview at its card.
//
// Env (all optional; cards are skipped if the storage key is missing):
//   SUPABASE_URL           https://<ref>.supabase.co
//   SUPABASE_SERVICE_KEY   service role key (secret; Railway only)
//   TARGET_USD             graduation target used by the site (default 5)
//   CARD_EVERY_MS          how often to look for cards to refresh (default 60000)

import { usdPerE18 } from "./alerts.mjs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const FONTS = ["Sora-Bold.ttf", "Sora-SemiBold.ttf", "IBMPlexMono-Regular.ttf"].map((f) => join(here, "fonts", f));

const CHAIN = {
  46630: { name: "Robinhood", color: "#12B886" },
  4663: { name: "Robinhood", color: "#12B886" },
  84532: { name: "Base", color: "#3B6FF5" },
  8453: { name: "Base", color: "#3B6FF5" },
  97: { name: "BNB", color: "#F3BA2F" },
  56: { name: "BNB", color: "#F3BA2F" },
};

// The "sasa" wordmark, beside the mark at the top left of every card.
const WORDMARK = `<svg x="146" y="67" width="108" height="30" viewBox="15 -574 2161 598"><g transform="matrix(1,0,0.2,-1,0,0)"><path d="M253.0 -18.0Q133.0 -18.0 64.0 31.5Q-5.0 81.0 -10.0 171.0H150.0Q154.0 146.0 181.0 128.0Q208.0 110.0 257.0 110.0Q292.0 110.0 317.5 120.5Q343.0 131.0 343.0 155.0Q343.0 176.0 323.0 189.5Q303.0 203.0 250.0 208.0L212.0 212.0Q106.0 223.0 56.0 270.0Q6.0 317.0 6.0 388.0Q6.0 449.0 36.0 488.5Q66.0 528.0 119.0 548.0Q172.0 568.0 240.0 568.0Q351.0 568.0 419.0 519.5Q487.0 471.0 491.0 380.0H331.0Q327.0 405.0 304.0 422.5Q281.0 440.0 238.0 440.0Q207.0 440.0 187.5 429.0Q168.0 418.0 168.0 398.0Q168.0 377.0 186.5 367.0Q205.0 357.0 246.0 352.0L284.0 348.0Q390.0 337.0 447.5 289.5Q505.0 242.0 505.0 165.0Q505.0 108.0 474.5 67.0Q444.0 26.0 387.5 4.0Q331.0 -18.0 253.0 -18.0Z" fill="#FFF4EC"/><path d="M605,440 C645,490 705,500 785,500 C905,500 955,450 955,360 M955,380 L955,0 M955,290 L765,290 C655,290 595,240 595,170 C595,95 655,60 755,60 C865,60 945,110 955,200" stroke="#FFF4EC" fill="none" stroke-width="124" stroke-linejoin="round"/><path d="M1328.0 -18.0Q1208.0 -18.0 1139.0 31.5Q1070.0 81.0 1065.0 171.0H1225.0Q1229.0 146.0 1256.0 128.0Q1283.0 110.0 1332.0 110.0Q1367.0 110.0 1392.5 120.5Q1418.0 131.0 1418.0 155.0Q1418.0 176.0 1398.0 189.5Q1378.0 203.0 1325.0 208.0L1287.0 212.0Q1181.0 223.0 1131.0 270.0Q1081.0 317.0 1081.0 388.0Q1081.0 449.0 1111.0 488.5Q1141.0 528.0 1194.0 548.0Q1247.0 568.0 1315.0 568.0Q1426.0 568.0 1494.0 519.5Q1562.0 471.0 1566.0 380.0H1406.0Q1402.0 405.0 1379.0 422.5Q1356.0 440.0 1313.0 440.0Q1282.0 440.0 1262.5 429.0Q1243.0 418.0 1243.0 398.0Q1243.0 377.0 1261.5 367.0Q1280.0 357.0 1321.0 352.0L1359.0 348.0Q1465.0 337.0 1522.5 289.5Q1580.0 242.0 1580.0 165.0Q1580.0 108.0 1549.5 67.0Q1519.0 26.0 1462.5 4.0Q1406.0 -18.0 1328.0 -18.0Z" fill="#FF6B1A"/><path d="M1680,440 C1720,490 1780,500 1860,500 C1980,500 2030,450 2030,360 M2030,380 L2030,0 M2030,290 L1840,290 C1730,290 1670,240 1670,170 C1670,95 1730,60 1830,60 C1940,60 2020,110 2030,200" stroke="#FF6B1A" fill="none" stroke-width="124" stroke-linejoin="round"/></g></svg>`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function money(v) {
  if (v === null || !Number.isFinite(v)) return "—";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(v < 10 ? 2 : 0)}`;
}

/**
 * Numbers a card needs, from one coin_list row. `ethUsd` prices ETH chains;
 * USDC chains (sasa v5) are counted in dollars directly.
 */
export function cardFacts(row, ethUsd, targetUsd) {
  const curves = (row.curves ?? []).map((k) => {
    // Dollars per 1e18 raw units of this chain's money.
    const px = usdPerE18(k.chain_id, ethUsd ? { ETH: ethUsd } : null);
    return {
      chainId: k.chain_id,
      state: k.state,
      px,
      usd: px ? (Number(k.real_native) / 1e18) * px : null,
      price: Number(k.virtual_native) / Number(k.virtual_token),
    };
  });
  const graduated = row.graduated_chain !== null && row.graduated_chain !== undefined;
  const open = curves.filter((c) => c.state === 0);
  const known = curves.every((c) => c.px);
  const totalUsd = known ? open.reduce((s, c) => s + c.usd, 0) : null;
  const caps = curves.filter((c) => c.state !== 1 && c.px).map((c) => c.price * 1e9 * c.px);
  return {
    name: row.name,
    symbol: row.symbol,
    logo: row.logo,
    chains: curves.map((c) => ({ ...(CHAIN[c.chainId] ?? { name: `Chain ${c.chainId}`, color: "#8f7f73" }), state: c.state, usd: c.usd ?? 0 })),
    marketCap: caps.length ? Math.max(...caps) : null,
    progress: graduated ? 1 : totalUsd === null ? 0 : Math.min(1, totalUsd / targetUsd),
    graduated,
    winner: graduated ? CHAIN[row.graduated_chain]?.name ?? "" : "",
    targetUsd,
  };
}

/** A short fingerprint: the card is only redrawn when something visible changed. */
export function cardSignature(f) {
  const mc = f.marketCap ? Number(f.marketCap.toPrecision(2)) : 0;
  return createHash("sha1")
    .update(JSON.stringify(["wm2", f.name, f.symbol, f.logo?.length ?? 0, Math.round(f.progress * 100), mc, f.graduated, f.chains.map((c) => `${c.name}${c.state}`)]))
    .digest("hex");
}

function mark(x, y, s) {
  const k = s / 100;
  return `<g transform="translate(${x},${y})"><rect width="${s}" height="${s}" rx="${24 * k}" fill="#1A130D"/>
<path d="M${26 * k} ${60 * k} L${50 * k} ${38 * k} L${74 * k} ${60 * k}" fill="none" stroke="#FFB020" stroke-width="${11 * k}" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M${26 * k} ${80 * k} L${50 * k} ${58 * k} L${74 * k} ${80 * k}" fill="none" stroke="#FF6B1A" stroke-width="${11 * k}" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="${50 * k}" cy="${22 * k}" r="${6 * k}" fill="#FFB020"/></g>`;
}

export function cardSvg(f) {
  const W = 1200, H = 630;
  const pic = /^data:image\/(jpeg|png|webp);base64,/.test(f.logo ?? "")
    ? `<image href="${f.logo}" x="80" y="150" width="300" height="300" preserveAspectRatio="xMidYMid slice" clip-path="url(#pic)"/>`
    : `<rect x="80" y="150" width="300" height="300" rx="40" fill="url(#art)"/><text x="230" y="335" text-anchor="middle" font-family="Sora" font-weight="700" font-size="120" fill="#FFF4EC" fill-opacity="0.92">${esc((f.symbol || "?").slice(0, 2).toUpperCase())}</text>`;

  // Race bar: each open chain's share of the target, in its own colour.
  let bar = "";
  const bx = 440, bw = 680, by = 418;
  if (f.graduated) {
    const c = f.chains.find((x) => x.name === f.winner);
    bar = `<rect x="${bx}" y="${by}" width="${bw}" height="16" rx="8" fill="${c?.color ?? "#FF6B1A"}"/>`;
  } else {
    let left = bw, x = bx;
    for (const c of [...f.chains].filter((c) => c.state === 0).sort((a, b) => b.usd - a.usd)) {
      const w = Math.min(left, (c.usd / f.targetUsd) * bw);
      if (w <= 0) continue;
      bar += `<rect x="${x}" y="${by}" width="${w}" height="16" fill="${c.color}"/>`;
      x += w;
      left -= w;
    }
    bar = `<rect x="${bx}" y="${by}" width="${bw}" height="16" rx="8" fill="#2A2019"/><g clip-path="url(#bar)">${bar}</g>`;
  }

  let chipX = 440;
  const chips = f.chains
    .map((c) => {
      const label = esc(c.name) + (c.state === 1 ? " · closed" : c.state === 2 ? " · winner" : "");
      const w = 26 + label.length * 11.5;
      const s = `<g transform="translate(${chipX},${478})"><rect width="${w}" height="40" rx="20" fill="${c.state === 1 ? "#2A2019" : c.color}"/><text x="${w / 2}" y="27" text-anchor="middle" font-family="Sora" font-weight="600" font-size="19" fill="${c.state === 1 ? "#8F7F73" : "#FFFFFF"}">${label}</text></g>`;
      chipX += w + 10;
      return s;
    })
    .join("");

  // Long names get a smaller size so they never run past the edge.
  const n = [...f.name].length;
  const nameSize = n <= 12 ? 60 : n <= 17 ? 48 : 40;
  const nameMax = nameSize === 40 ? 24 : 17;
  const pct = Math.round(f.progress * 100);
  const status = f.graduated ? `Graduated on ${esc(f.winner)}` : `${pct}% to graduation`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<radialGradient id="glow" cx="85%" cy="15%" r="70%"><stop offset="0%" stop-color="#FF6B1A" stop-opacity="0.30"/><stop offset="100%" stop-color="#FF6B1A" stop-opacity="0"/></radialGradient>
<linearGradient id="art" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FF8A3D"/><stop offset="100%" stop-color="#8A2E07"/></linearGradient>
<clipPath id="pic"><rect x="80" y="150" width="300" height="300" rx="40"/></clipPath>
<clipPath id="bar"><rect x="${bx}" y="${by}" width="${bw}" height="16" rx="8"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="#0B0806"/><rect width="${W}" height="${H}" fill="url(#glow)"/>
${mark(80, 56, 52)}
${WORDMARK}
<text x="1120" y="92" text-anchor="end" font-family="IBM Plex Mono" font-size="22" fill="#8F7F73">sasapad.fun</text>
<rect x="78" y="148" width="304" height="304" rx="42" fill="none" stroke="#2E231A" stroke-width="2"/>
${pic}
<text x="440" y="215" font-family="Sora" font-weight="700" font-size="${nameSize}" fill="#FFF4EC">${esc(clip(f.name, nameMax))}</text>
<text x="442" y="258" font-family="IBM Plex Mono" font-size="26" fill="#A8978A">$${esc(clip(f.symbol, 12))}</text>
<text x="440" y="340" font-family="Sora" font-weight="700" font-size="52" fill="#FFF4EC">${esc(money(f.marketCap))}</text>
<text x="442" y="372" font-family="IBM Plex Mono" font-size="20" fill="#8F7F73">market cap</text>
<text x="1120" y="340" text-anchor="end" font-family="Sora" font-weight="700" font-size="34" fill="${f.graduated ? "#2FD39B" : "#FFB020"}">${status}</text>
<text x="1120" y="372" text-anchor="end" font-family="IBM Plex Mono" font-size="20" fill="#8F7F73">${f.graduated ? "liquidity locked forever" : `target ${esc(money(f.targetUsd))} across all chains`}</text>
${bar}
${chips}
<text x="80" y="590" font-family="Sora" font-weight="600" font-size="24" fill="#8F7F73">Launch once. <tspan fill="#FF6B1A">Live on every chain.</tspan></text>
</svg>`;
}

export function renderCard(f) {
  const r = new Resvg(cardSvg(f), {
    fitTo: { mode: "width", value: 1200 },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Sora" },
  });
  return r.render().asPng();
}

export const cardFileName = (coinId) => `${coinId.toLowerCase().replace(/[^0-9a-z]/g, "-")}.png`;

async function upload(url, key, name, png) {
  const res = await fetch(`${url}/storage/v1/object/cards/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, apikey: key, "content-type": "image/png", "x-upsert": "true", "cache-control": "max-age=300" },
    body: png,
  });
  if (!res.ok) throw new Error(`upload ${name}: ${res.status} ${await res.text()}`);
}

async function ethPrice() {
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(8000) });
    const p = Number((await r.json())?.data?.amount);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

/** Redraws the cards of recently active or new coins whose visible numbers changed. */
export async function cardLoop(pool, log) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    log("share cards off (set SUPABASE_URL and SUPABASE_SERVICE_KEY to turn them on)");
    return;
  }
  const target = Number(process.env.TARGET_USD ?? "5");
  const every = Number(process.env.CARD_EVERY_MS ?? "60000");
  for (;;) {
    try {
      const ethUsd = await ethPrice();
      const { rows } = await pool.query(
        `select l.id, l.name, l.symbol, l.logo, l.graduated_chain, l.curves, s.sig
         from coin_list l left join card_state s on s.coin_id = l.id
         order by greatest(l.created_at, coalesce(l.last_trade_at, l.created_at)) desc
         limit 300`
      );
      let drawn = 0;
      for (const row of rows) {
        const f = cardFacts(row, ethUsd, target);
        const sig = cardSignature(f);
        if (sig === row.sig) continue;
        await upload(url, key, cardFileName(row.id), renderCard(f));
        await pool.query(
          `insert into card_state (coin_id, sig, drawn_at) values ($1, $2, now())
           on conflict (coin_id) do update set sig = excluded.sig, drawn_at = excluded.drawn_at`,
          [row.id, sig]
        );
        drawn++;
      }
      if (drawn) log(`share cards: drew ${drawn}`);
    } catch (e) {
      log(`share cards: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, every));
  }
}

// ---------------------------------------------------------------- coins from other DEXs
// Same idea for /x/ pages: a card with the coin's own name, picture and numbers,
// so a shared link never shows a sample coin. Drawn for the busiest listed coins.

const EXT_NET = {
  base: { name: "Base", color: "#3B6FF5" },
  robinhood: { name: "Robinhood Chain", color: "#12B886" },
  bsc: { name: "BNB Chain", color: "#F3BA2F" },
  eth: { name: "Ethereum", color: "#8A92B2" },
  arc: { name: "Arc", color: "#9B8CFF" },
};

export const extCardName = (network, address) => `x-${network}-${String(address).toLowerCase()}.png`;

/** Coin picture as a data: URL resvg can draw (remote images can't be fetched while drawing). */
const picCache = new Map();
async function picture(url) {
  if (typeof url !== "string" || !url.startsWith("https://")) return null;
  if (picCache.has(url)) return picCache.get(url);
  let out = null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const type = (r.headers.get("content-type") || "").split(";")[0].trim();
    if (r.ok && /^image\/(png|jpeg|webp)$/.test(type)) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 0 && buf.length < 600_000) out = `data:${type};base64,${buf.toString("base64")}`;
    }
  } catch {}
  if (picCache.size > 800) picCache.delete(picCache.keys().next().value);
  picCache.set(url, out);
  return out;
}

const pctText = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > 10_000) return null;
  return `${n >= 0 ? "+" : "−"}${Math.abs(n) >= 100 ? Math.abs(n).toFixed(0) : Math.abs(n).toFixed(1)}%`;
};

/** What an other-DEX coin's card shows, from one ext_coins row. */
export function extCardFacts(row, logo) {
  const mc = Number(row.mcap_usd) > 0 ? Number(row.mcap_usd) : Number(row.fdv_usd) > 0 ? Number(row.fdv_usd) : null;
  return {
    name: String(row.name || row.symbol || "?"),
    symbol: String(row.symbol || "?"),
    net: EXT_NET[row.network] ?? { name: String(row.network), color: "#8F7F73" },
    marketCap: mc,
    volume: Number(row.vol_24h) > 0 ? Number(row.vol_24h) : null,
    liquidity: Number(row.liq_usd) > 0 ? Number(row.liq_usd) : null,
    change: pctText(row.change_24h),
    up: Number(row.change_24h) >= 0,
    logo,
  };
}

/** Changes only when what people would notice changes (about 5% steps). */
export function extCardSignature(f) {
  const step = (v) => (v ? Math.round(Math.log(v) / Math.log(1.05)) : 0);
  return createHash("sha1").update(JSON.stringify(["wm2", f.name, f.symbol, f.net.name, step(f.marketCap), step(f.volume), f.change ? Math.round(parseFloat(f.change.replace("−", "-")) / 5) : null, !!f.logo])).digest("hex");
}

export function extCardSvg(f) {
  const W = 1200, H = 630;
  const pic = f.logo
    ? `<image href="${f.logo}" x="80" y="150" width="300" height="300" preserveAspectRatio="xMidYMid slice" clip-path="url(#pic)"/>`
    : `<rect x="80" y="150" width="300" height="300" rx="40" fill="url(#art)"/><text x="230" y="335" text-anchor="middle" font-family="Sora" font-weight="700" font-size="120" fill="#FFF4EC" fill-opacity="0.92">${esc((f.symbol || "?").slice(0, 2).toUpperCase())}</text>`;
  const n = [...f.name].length;
  const nameSize = n <= 12 ? 60 : n <= 17 ? 48 : 40;
  const nameMax = nameSize === 40 ? 24 : 17;
  const chipW = 26 + f.net.name.length * 11.5;
  const stat = (x, label, value) => `<text x="${x}" y="470" font-family="Sora" font-weight="700" font-size="34" fill="#FFF4EC">${esc(value)}</text><text x="${x + 2}" y="502" font-family="IBM Plex Mono" font-size="19" fill="#8F7F73">${label}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<radialGradient id="glow" cx="85%" cy="15%" r="70%"><stop offset="0%" stop-color="#FF6B1A" stop-opacity="0.30"/><stop offset="100%" stop-color="#FF6B1A" stop-opacity="0"/></radialGradient>
<linearGradient id="art" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FF8A3D"/><stop offset="100%" stop-color="#8A2E07"/></linearGradient>
<clipPath id="pic"><rect x="80" y="150" width="300" height="300" rx="40"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="#0B0806"/><rect width="${W}" height="${H}" fill="url(#glow)"/>
${mark(80, 56, 52)}
${WORDMARK}
<text x="1120" y="92" text-anchor="end" font-family="IBM Plex Mono" font-size="22" fill="#8F7F73">sasapad.fun</text>
<rect x="78" y="148" width="304" height="304" rx="42" fill="none" stroke="#2E231A" stroke-width="2"/>
${pic}
<text x="440" y="215" font-family="Sora" font-weight="700" font-size="${nameSize}" fill="#FFF4EC">${esc(clip(f.name, nameMax))}</text>
<text x="442" y="258" font-family="IBM Plex Mono" font-size="26" fill="#A8978A">$${esc(clip(f.symbol, 12))}</text>
<g transform="translate(442,282)"><rect width="${chipW}" height="40" rx="20" fill="${f.net.color}"/><text x="${chipW / 2}" y="27" text-anchor="middle" font-family="Sora" font-weight="600" font-size="19" fill="#FFFFFF">${esc(f.net.name)}</text></g>
<text x="440" y="390" font-family="Sora" font-weight="700" font-size="52" fill="#FFF4EC">${esc(money(f.marketCap))}</text>
${f.change ? `<text x="1120" y="390" text-anchor="end" font-family="Sora" font-weight="700" font-size="44" fill="${f.up ? "#2FD39B" : "#FF5C5C"}">${esc(f.change)}</text>` : ""}
<text x="442" y="420" font-family="IBM Plex Mono" font-size="20" fill="#8F7F73">market cap</text>
${f.change ? `<text x="1120" y="420" text-anchor="end" font-family="IBM Plex Mono" font-size="20" fill="#8F7F73">24h</text>` : ""}
${stat(440, "volume 24h", money(f.volume))}
${stat(760, "liquidity", money(f.liquidity))}
<text x="80" y="590" font-family="Sora" font-weight="600" font-size="24" fill="#8F7F73">Trade any coin. <tspan fill="#FF6B1A">Launch your own.</tspan></text>
</svg>`;
}

export function renderExtCard(f) {
  const r = new Resvg(extCardSvg(f), {
    fitTo: { mode: "width", value: 1200 },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Sora" },
  });
  return r.render().asPng();
}

/** Cards for the busiest other-DEX coins, redrawn when their numbers move about 5%. */
export async function extCardLoop(pool, log) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  const every = Number(process.env.EXT_CARD_EVERY_MS ?? "120000");
  const perRound = Number(process.env.EXT_CARD_PER_ROUND ?? "40");
  const minAge = Number(process.env.EXT_CARD_MIN_AGE_MS ?? String(12 * 3600e3));
  for (;;) {
    try {
      const { rows } = await pool.query(
        `select e.network, e.address, e.name, e.symbol, e.image, e.mcap_usd, e.fdv_usd, e.vol_24h, e.liq_usd, e.change_24h, s.sig, s.drawn_at
         from ext_coins e left join card_state s on s.coin_id = 'x:' || e.network || ':' || e.address
         order by e.vol_24h desc nulls last
         limit 2000`
      );
      let drawn = 0;
      for (const row of rows) {
        if (drawn >= perRound) break;
        // a card only shows in link previews: once drawn, leave it for minAge (each redraw is an upload)
        if (row.sig && row.drawn_at && Date.now() - new Date(row.drawn_at).getTime() < minAge) continue;
        const pre = extCardFacts(row, null);
        // cheap check first (no picture download) — the signature only records whether a picture exists
        if (row.sig && row.sig === extCardSignature({ ...pre, logo: row.image ? "x" : null })) continue;
        const f = extCardFacts(row, await picture(row.image));
        const sig = extCardSignature({ ...f, logo: row.image ? "x" : null });
        if (sig === row.sig) continue;
        await upload(url, key, extCardName(row.network, row.address), renderExtCard(f));
        await pool.query(
          `insert into card_state (coin_id, sig, drawn_at) values ($1, $2, now())
           on conflict (coin_id) do update set sig = excluded.sig, drawn_at = excluded.drawn_at`,
          [`x:${row.network}:${row.address}`, sig]
        );
        drawn++;
      }
      if (drawn) log(`share cards (other DEXs): drew ${drawn}`);
    } catch (e) {
      if (!/does not exist/.test(e.message)) log(`share cards (other DEXs): ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, every));
  }
}

// ---------------------------------------------------------------- race coins (v7)
// A card per race: the coin, every chain's money as a bar, and the winner once decided.
// File r-<coin id>.png; the /r/ page's Cloudflare function points link previews at it.

const RACE_CHAIN = {
  84532: { name: "Base", color: "#2F6BFF" },
  8453: { name: "Base", color: "#2F6BFF" },
  97: { name: "BNB", color: "#F0B90B" },
  56: { name: "BNB", color: "#F0B90B" },
  46630: { name: "Robinhood", color: "#1FD15A" },
  4663: { name: "Robinhood", color: "#1FD15A" },
  5042002: { name: "Arc", color: "#19B3E6" },
  5042: { name: "Arc", color: "#19B3E6" },
};
const RACE_ORDER = ["Base", "BNB", "Robinhood", "Arc"];

export const raceCardName = (coinId) => `r-${String(coinId).toLowerCase().replace(/[^0-9a-z]/g, "-")}.png`;

/** What a race card shows, from one race_coins row with its lanes. */
export function raceCardFacts(row, logo) {
  const lanes = (row.lanes ?? [])
    .map((l) => {
      const c = RACE_CHAIN[Number(l.chain_id)] ?? { name: `Chain ${l.chain_id}`, color: "#8F7F73" };
      const usd = Number(l.reported_usd ?? l.pool_usd ?? 0);
      return { name: c.name, color: c.color, state: Number(l.state), usd: Number.isFinite(usd) && usd > 0 ? usd : 0 };
    })
    .sort((a, b) => RACE_ORDER.indexOf(a.name) - RACE_ORDER.indexOf(b.name));
  const winner = row.winner_chain ? (RACE_CHAIN[Number(row.winner_chain)]?.name ?? null) : null;
  const total = Number(row.total_usd) > 0 ? Number(row.total_usd) : lanes.reduce((s, l) => s + l.usd, 0);
  const decided = !!(row.winner_chain || row.decided_at);
  return { name: String(row.name || row.symbol || "?"), symbol: String(row.symbol || "?"), logo, lanes, winner, total, decided };
}

/** Redrawn when the winner, a chain's state or any chain's money moves about 5%. */
export function raceCardSignature(f) {
  const step = (v) => (v ? Math.round(Math.log(v) / Math.log(1.05)) : 0);
  return createHash("sha1")
    .update(JSON.stringify(["wm2", f.name, f.symbol, !!f.logo, f.winner, f.decided, step(f.total), f.lanes.map((l) => `${l.name}${l.state}:${step(l.usd)}`)]))
    .digest("hex");
}

export function raceCardSvg(f) {
  const W = 1200, H = 630;
  const pic = f.logo
    ? `<image href="${f.logo}" x="80" y="150" width="300" height="300" preserveAspectRatio="xMidYMid slice" clip-path="url(#pic)"/>`
    : `<rect x="80" y="150" width="300" height="300" rx="40" fill="url(#art)"/><text x="230" y="335" text-anchor="middle" font-family="Sora" font-weight="700" font-size="120" fill="#FFF4EC" fill-opacity="0.92">${esc((f.symbol || "?").slice(0, 2).toUpperCase())}</text>`;
  const n = [...f.name].length;
  const nameSize = n <= 12 ? 56 : n <= 17 ? 46 : 38;
  const nameMax = nameSize === 38 ? 24 : 17;
  const win = f.winner ? f.lanes.find((l) => l.name === f.winner) : null;
  const status = f.winner ? `Won on ${f.winner}` : f.decided ? "Race over" : "Racing now";
  const statusColor = win ? win.color : f.decided ? "#4A3C31" : "#FFB020";
  const statusW = Math.round(30 + status.length * 11.5);

  // one bar per chain, longest = the chain with the most money
  const max = Math.max(1, ...f.lanes.map((l) => l.usd));
  const bx = 600, bw = 380, top = 320, gap = 52;
  const rows = f.lanes
    .slice(0, 4)
    .map((l, i) => {
      const y = top + i * gap;
      const w = Math.max(10, Math.round((l.usd / max) * bw));
      const out = l.state === 3;
      const isWin = f.winner === l.name;
      return `<text x="440" y="${y + 15}" font-family="Sora" font-weight="${isWin ? 700 : 600}" font-size="22" fill="${out ? "#6F6157" : "#FFF4EC"}">${esc(l.name)}</text>
<rect x="${bx}" y="${y}" width="${bw}" height="18" rx="9" fill="#2A2019"/>
<rect x="${bx}" y="${y}" width="${w}" height="18" rx="9" fill="${l.color}" fill-opacity="${out ? 0.35 : 1}"/>
<text x="1120" y="${y + 16}" text-anchor="end" font-family="IBM Plex Mono" font-size="21" fill="${out ? "#6F6157" : "#D8C9BC"}">${esc(money(l.usd))}</text>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<radialGradient id="glow" cx="85%" cy="15%" r="70%"><stop offset="0%" stop-color="#FF6B1A" stop-opacity="0.30"/><stop offset="100%" stop-color="#FF6B1A" stop-opacity="0"/></radialGradient>
<linearGradient id="art" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FF8A3D"/><stop offset="100%" stop-color="#8A2E07"/></linearGradient>
<clipPath id="pic"><rect x="80" y="150" width="300" height="300" rx="40"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="#0B0806"/><rect width="${W}" height="${H}" fill="url(#glow)"/>
${mark(80, 56, 52)}
${WORDMARK}
<text x="1120" y="92" text-anchor="end" font-family="IBM Plex Mono" font-size="22" fill="#8F7F73">sasapad.fun</text>
<rect x="78" y="148" width="304" height="304" rx="42" fill="none" stroke="#2E231A" stroke-width="2"/>
${pic}
<text x="440" y="200" font-family="Sora" font-weight="700" font-size="${nameSize}" fill="#FFF4EC">${esc(clip(f.name, nameMax))}</text>
<text x="442" y="244" font-family="IBM Plex Mono" font-size="24" fill="#A8978A">$${esc(clip(f.symbol, 12))} · ${esc(money(f.total))} raised</text>
<g transform="translate(${1120 - statusW},216)"><rect width="${statusW}" height="40" rx="20" fill="${statusColor}"/><text x="${statusW / 2}" y="27" text-anchor="middle" font-family="Sora" font-weight="700" font-size="19" fill="${f.decided && !win ? "#FFF4EC" : "#0B0806"}">${esc(status)}</text></g>
<line x1="440" y1="280" x2="1120" y2="280" stroke="#2E231A" stroke-width="2"/>
${rows}
<text x="80" y="590" font-family="Sora" font-weight="600" font-size="24" fill="#8F7F73">One coin. Four chains. <tspan fill="#FF6B1A">Five minutes to win.</tspan></text>
</svg>`;
}

export function renderRaceCard(f) {
  const r = new Resvg(raceCardSvg(f), {
    fitTo: { mode: "width", value: 1200 },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Sora" },
  });
  return r.render().asPng();
}

/** Coin picture for a race card: a data: image as it is, an https one downloaded. */
async function raceLogo(logo) {
  if (typeof logo === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(logo) && logo.length < 800_000) return logo;
  return picture(logo);
}

/** Cards for the newest races, redrawn while they run and once more when decided. */
export async function raceCardLoop(pool, log) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  const every = Number(process.env.RACE_CARD_EVERY_MS ?? "30000");
  for (;;) {
    try {
      const { rows } = await pool.query(
        `select c.id, c.name, c.symbol, c.logo, c.winner_chain, c.total_usd, c.decided_at, s.sig,
                coalesce(json_agg(json_build_object('chain_id', r.chain_id, 'state', r.state, 'pool_usd', r.pool_usd, 'reported_usd', r.reported_usd))
                         filter (where r.chain_id is not null), '[]') as lanes
         from race_coins c
         left join race_chains r on r.coin_id = c.id
         left join card_state s on s.coin_id = 'r:' || c.id
         group by c.id, s.sig
         order by c.launched_at desc
         limit 200`
      );
      let drawn = 0;
      for (const row of rows) {
        const pre = raceCardFacts(row, row.logo ? "x" : null);
        const sig = raceCardSignature(pre);
        if (sig === row.sig) continue;
        const f = raceCardFacts(row, await raceLogo(row.logo));
        await upload(url, key, raceCardName(row.id), renderRaceCard(f));
        await pool.query(
          `insert into card_state (coin_id, sig, drawn_at) values ($1, $2, now())
           on conflict (coin_id) do update set sig = excluded.sig, drawn_at = excluded.drawn_at`,
          [`r:${row.id}`, sig]
        );
        drawn++;
      }
      if (drawn) log(`share cards (races): drew ${drawn}`);
    } catch (e) {
      if (!/does not exist/.test(e.message)) log(`share cards (races): ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, every));
  }
}

// shared with marketcards.mjs (futures and prediction share cards)
export { mark, WORDMARK, FONTS, upload, esc as escXml, clip };
