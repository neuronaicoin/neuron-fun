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
    .update(JSON.stringify([f.name, f.symbol, f.logo?.length ?? 0, Math.round(f.progress * 100), mc, f.graduated, f.chains.map((c) => `${c.name}${c.state}`)]))
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
<text x="146" y="94" font-family="Sora" font-weight="700" font-size="32" fill="#FFF4EC">sasa</text>
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
  return createHash("sha1").update(JSON.stringify([f.name, f.symbol, f.net.name, step(f.marketCap), step(f.volume), f.change ? Math.round(parseFloat(f.change.replace("−", "-")) / 5) : null, !!f.logo])).digest("hex");
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
<text x="146" y="94" font-family="Sora" font-weight="700" font-size="32" fill="#FFF4EC">sasa</text>
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
  const perRound = Number(process.env.EXT_CARD_PER_ROUND ?? "120");
  for (;;) {
    try {
      const { rows } = await pool.query(
        `select e.network, e.address, e.name, e.symbol, e.image, e.mcap_usd, e.fdv_usd, e.vol_24h, e.liq_usd, e.change_24h, s.sig
         from ext_coins e left join card_state s on s.coin_id = 'x:' || e.network || ':' || e.address
         order by e.vol_24h desc nulls last
         limit 2000`
      );
      let drawn = 0;
      for (const row of rows) {
        if (drawn >= perRound) break;
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
