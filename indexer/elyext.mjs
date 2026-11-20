// Elysium coins from other launchpads, tradable on sasa with plain USDC (Nov 20, 2026).
//
// sasa buys them with the user's Base USDC through Relay (USDC -> HYPE -> coin in one Relay step,
// lib/extcross.ts) and sells them back to Base USDC the same way. Only coins that pass every check
// below are listed (network "ely" in ext_tokens, so they show in Explore and on the Elysium tab):
//
//   market      $30K+ in the pool, $10K+ traded in 24h, 20+ buys and 20+ sells in 24h,
//               pool at least a day old, market cap $100K+, not a wrapped/staked HYPE or stablecoin
//   explorer    not on Elysium's own token scan list (blocked transfers or taxed), 150+ holders,
//               no single wallet (not a contract) holding over 20% of the supply
//   round trip  Relay prices a $20 buy from Base USDC and selling that back right away: the buy must
//               keep 94%+ of its value and the sale bring back 88%+ of the $20
//
// A coin that fails later stops being refreshed: it leaves every list (ext_coins wants a refresh in
// the last 2 hours) while its page stays, so anyone holding it can still sell. The page itself checks
// again before every buy (lib/extcross.ts elysiumSafeBuy). Read-only: nothing here is signed or sent.
//
// Env: ELY_EXT_OFF=1 turns it off. ELY_EXT_EVERY_MS (default 20 min).

import { notMeme } from "./markets.mjs";

const NETWORK = "ely"; // our id (GeckoTerminal and DexScreener call the chain "elysium")
const CHAIN_ID = 99901;
const GT = "https://api.geckoterminal.com/api/v2";
const DS = "https://api.dexscreener.com";
const EXPLORER = "https://elysium.kinetiq.xyz";
const RELAY = "https://api.relay.link";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PROBE_USER = "0x000000000000000000000000000000000000dEaD"; // a price question only, never a trade
const PROBE_USD = 20;

export const RULES = {
  minLiq: 30_000,
  minVol: 10_000,
  minBuys: 20,
  minSells: 20,
  minAgeH: 24,
  minMcap: 100_000,
  minHolders: 150,
  maxWalletPct: 20,
  minBuyKeep: 0.94,
  minRoundTrip: 0.88,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Some of these sites turn away requests that don't look like a browser, and all of them limit how
// fast one address asks (HTTP 429): look like a browser and wait it out, longer each time.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
async function get(url, init = {}, as = "json") {
  for (let i = 0; ; i++) {
    const r = await fetch(url, {
      ...init,
      headers: { "user-agent": UA, accept: as === "json" ? "application/json" : "text/html", "accept-language": "en-US,en;q=0.9", ...(init.headers || {}) },
      signal: AbortSignal.timeout(25_000),
    });
    if (r.ok) return as === "json" ? r.json() : r.text();
    if ((r.status === 429 || r.status >= 500) && i < 3) {
      await sleep([20_000, 45_000, 90_000][i]);
      continue;
    }
    throw new Error(`${r.status} ${url.split("?")[0]}`);
  }
}
const getJson = (url, init = {}) => get(url, init, "json");

/** Wrapped, staked or liquid-staked HYPE and dollars: plumbing, not coins to list. Exported for tests. */
export function notElyMeme(symbol, name) {
  const s = String(symbol ?? "").trim();
  return notMeme(s, name) || /^(W|K|ST|L|BE|M|V|U|H|X)?HYPE$/i.test(s) || (/HYPE/i.test(s) && /staked|wrapped|liquid/i.test(String(name ?? "")));
}

/** DexScreener pairs -> one row per coin (its most liquid pair). Exported for tests. */
export function rowsFromPairs(pairs) {
  const best = new Map();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    if (p?.chainId !== "elysium") continue;
    const address = String(p?.baseToken?.address ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
    const symbol = String(p?.baseToken?.symbol ?? "").trim();
    if (!symbol || notElyMeme(symbol, p?.baseToken?.name)) continue;
    const liq = num(p?.liquidity?.usd);
    const cur = best.get(address);
    if (cur && (cur.liq_usd ?? 0) >= (liq ?? 0)) continue;
    const img = p?.info?.imageUrl;
    const created = Number(p?.pairCreatedAt);
    let x = null;
    for (const s of Array.isArray(p?.info?.socials) ? p.info.socials : []) {
      const m = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/.exec(String(s?.url ?? ""));
      if (m && !/^(i|home|intent|search|share|hashtag)$/i.test(m[1])) x = m[1];
    }
    best.set(address, {
      network: NETWORK,
      chain_id: CHAIN_ID,
      address,
      pool: String(p?.pairAddress ?? "").toLowerCase() || null,
      dex: p?.dexId ?? null,
      name: String(p?.baseToken?.name ?? symbol).slice(0, 80),
      symbol: symbol.slice(0, 24),
      image: typeof img === "string" && /^https:\/\//.test(img) ? img : null,
      price_usd: num(p?.priceUsd),
      fdv_usd: num(p?.fdv),
      mcap_usd: num(p?.marketCap),
      liq_usd: liq,
      vol_24h: num(p?.volume?.h24),
      change_1h: num(p?.priceChange?.h1),
      change_24h: num(p?.priceChange?.h24),
      buys_24h: num(p?.txns?.h24?.buys),
      sells_24h: num(p?.txns?.h24?.sells),
      pool_created: Number.isFinite(created) && created > 0 ? new Date(created).toISOString() : null,
      trending_rank: null,
      x_handle: x,
    });
  }
  return [...best.values()];
}

/** The market part of the checks. Returns why a coin fails, or "" when it passes. Exported for tests. */
export function marketFail(r, now = Date.now()) {
  const mc = r.mcap_usd ?? r.fdv_usd ?? 0;
  if ((r.liq_usd ?? 0) < RULES.minLiq) return "liquidity";
  if ((r.vol_24h ?? 0) < RULES.minVol) return "volume";
  if ((r.buys_24h ?? 0) < RULES.minBuys) return "buys";
  if ((r.sells_24h ?? 0) < RULES.minSells) return "sells";
  if (!r.pool_created || now - Date.parse(r.pool_created) < RULES.minAgeH * 3600e3) return "age";
  if (mc < RULES.minMcap || mc >= 1e9) return "market cap";
  if (!(r.price_usd > 0)) return "price";
  return "";
}

/**
 * The explorer's token page -> holders and the biggest single wallet (not a contract) in the top
 * 10. The page is server-rendered; the holder table follows the "Holder / Percentage / Quantity"
 * header. Returns null when the page can't be read (the coin then isn't listed). Exported for tests.
 */
export function parseExplorer(html) {
  const h = /Holders<span[^>]*>([\d,]+)<\/span>/.exec(html);
  const holders = h ? Number(h[1].replace(/,/g, "")) : NaN;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  let start = -1;
  for (let i = 0; i < text.length - 2; i++)
    if (text[i] === "Holder" && text[i + 1] === "Percentage" && text[i + 2] === "Quantity") {
      start = i + 2;
      break;
    }
  if (!Number.isFinite(holders) || start < 0) return null;
  const rows = [];
  let cur = null;
  for (let i = start + 1; i < text.length && rows.length < 12; i++) {
    const s = text[i];
    if (/^\d{1,3}$/.test(s) && (!cur || cur.pct !== null)) {
      if (cur) rows.push(cur);
      cur = { rank: Number(s), contract: false, pct: null };
      continue;
    }
    if (!cur) continue;
    if (s === "Contract") cur.contract = true;
    const m = /^([\d.]+)%$/.exec(s);
    if (m && cur.pct === null) cur.pct = Number(m[1]);
  }
  if (cur) rows.push(cur);
  // the table starts with a summary row (the whole supply); the real ranks start at 1 after it
  if (rows.length > 1 && rows[1].rank === 1) rows.shift();
  const top = rows.filter((r) => r.rank >= 1 && r.rank <= 10 && r.pct !== null);
  if (top.length < Math.min(10, holders) * 0.5) return null;
  const wallet = Math.max(0, ...top.filter((r) => !r.contract).map((r) => r.pct));
  return { holders, wallet };
}

async function relayQuote(body) {
  const key = process.env.RELAY_API_KEY;
  const j = await getJson(`${RELAY}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: JSON.stringify({ user: PROBE_USER, recipient: PROBE_USER, tradeType: "EXACT_INPUT", ...body }),
  });
  const out = j?.details?.currencyOut;
  return { raw: String(out?.amount ?? "0"), usd: num(out?.amountUsd) ?? 0 };
}

/** $20 of Base USDC into the coin and straight back: what each leg keeps. */
async function roundTrip(address) {
  const buy = await relayQuote({ originChainId: 8453, originCurrency: BASE_USDC, destinationChainId: CHAIN_ID, destinationCurrency: address, amount: String(PROBE_USD * 1e6) });
  if (!(buy.usd > 0) || !/^[1-9]\d*$/.test(buy.raw)) return { buyKeep: 0, back: 0 };
  await sleep(600);
  const sell = await relayQuote({ originChainId: CHAIN_ID, originCurrency: address, destinationChainId: 8453, destinationCurrency: BASE_USDC, amount: buy.raw });
  return { buyKeep: buy.usd / PROBE_USD, back: sell.usd / PROBE_USD };
}

async function candidates(log) {
  // the busiest Elysium pools (GeckoTerminal), then fresh numbers for their coins (DexScreener)
  const addrs = new Set();
  for (const page of [1, 2, 3]) {
    try {
      const j = await getJson(`${GT}/networks/elysium/pools?include=base_token&sort=h24_volume_usd_desc&page=${page}`);
      for (const p of j?.data ?? []) {
        const id = p?.relationships?.base_token?.data?.id ?? "";
        const a = id.slice(id.indexOf("_") + 1).toLowerCase();
        if (/^0x[0-9a-f]{40}$/.test(a)) addrs.add(a);
      }
    } catch (e) {
      log(`ely coins: GeckoTerminal ${e.message}`);
    }
    await sleep(7000);
  }
  // DexScreener's search (its own, higher limits): Elysium pairs against HYPE, the chain's money
  for (const q of ["WHYPE", "HYPE elysium", "elysium", "elysium meme"]) {
    try {
      const j = await getJson(`${DS}/latest/dex/search?q=${encodeURIComponent(q)}`);
      for (const p of j?.pairs ?? []) {
        const a = String(p?.baseToken?.address ?? "").toLowerCase();
        if (p?.chainId === "elysium" && /^0x[0-9a-f]{40}$/.test(a)) addrs.add(a);
      }
    } catch (e) {
      log(`ely coins: DexScreener search ${e.message}`);
    }
    await sleep(1000);
  }
  // coins already listed stay checked even when they drop off those pages
  return [...addrs];
}

async function save(pool, r) {
  const cols = ["network", "chain_id", "address", "pool", "dex", "name", "symbol", "image", "price_usd", "fdv_usd", "mcap_usd", "liq_usd", "vol_24h", "change_1h", "change_24h", "buys_24h", "sells_24h", "pool_created", "trending_rank", "x_handle"];
  await pool.query(
    `insert into ext_tokens (${cols.join(",")},seen_at, gp_checked_at, gp_honeypot, gp_cannot_sell)
     values (${cols.map((_, i) => `$${i + 1}`).join(",")}, now(), now(), false, false)
     on conflict (network, address) do update set
       pool = excluded.pool, dex = excluded.dex, name = excluded.name, symbol = excluded.symbol,
       image = coalesce(excluded.image, ext_tokens.image), price_usd = excluded.price_usd,
       fdv_usd = excluded.fdv_usd, mcap_usd = excluded.mcap_usd, liq_usd = excluded.liq_usd,
       vol_24h = excluded.vol_24h, change_1h = excluded.change_1h, change_24h = excluded.change_24h,
       buys_24h = excluded.buys_24h, sells_24h = excluded.sells_24h,
       pool_created = coalesce(excluded.pool_created, ext_tokens.pool_created),
       x_handle = coalesce(excluded.x_handle, ext_tokens.x_handle), seen_at = now(),
       gp_checked_at = now(), gp_honeypot = false, gp_cannot_sell = false`,
    cols.map((c) => r[c] ?? null)
  );
}

/** Takes a coin off every list at once (its page stays, so holders can still sell). */
async function unlist(pool, address) {
  await pool.query(
    `update ext_tokens set seen_at = least(seen_at, now() - interval '3 hours') where network = $1 and address = $2`,
    [NETWORK, address]
  );
}

const explorerCache = new Map(); // address -> { at, v }

export async function scanEly(pool, log) {
  const found = await candidates(log);
  const { rows: listed } = await pool.query(`select address from ext_tokens where network = $1 and seen_at > now() - interval '2 hours'`, [NETWORK]);
  const all = [...new Set([...found, ...listed.map((r) => r.address)])];
  if (!all.length) return { checked: 0, listed: 0 };

  const rows = [];
  for (let i = 0; i < all.length; i += 30) {
    const pairs = await getJson(`${DS}/tokens/v1/elysium/${all.slice(i, i + 30).join(",")}`).catch(() => []);
    rows.push(...rowsFromPairs(pairs));
    await sleep(400);
  }
  const flagged = new Set();
  try {
    const j = await getJson(`${EXPLORER}/api/explorer/mainnet/token-scans`);
    for (const t of j?.tokens ?? []) if (t?.address) flagged.add(String(t.address).toLowerCase());
  } catch (e) {
    // without Elysium's scan list nothing new is listed this round, and nothing listed is refreshed
    log(`ely coins: token scan list ${e.message}; skipping this round`);
    return { checked: 0, listed: 0 };
  }

  const have = new Set(rows.map((r) => r.address));
  for (const a of listed.map((r) => r.address)) if (!have.has(a)) await unlist(pool, a); // no market data: off the lists

  let ok = 0;
  const why = {};
  for (const r of rows) {
    let fail = marketFail(r);
    if (!fail && flagged.has(r.address)) fail = "scan list";
    if (!fail) {
      let e = explorerCache.get(r.address);
      if (!e || Date.now() - e.at > 3600e3) {
        const html = await get(`${EXPLORER}/token/${r.address}`, {}, "html").catch(() => "");
        e = { at: Date.now(), v: html ? parseExplorer(html) : null };
        explorerCache.set(r.address, e);
        await sleep(1500);
      }
      if (!e.v) fail = "explorer";
      else if (e.v.holders < RULES.minHolders) fail = "holders";
      else if (e.v.wallet > RULES.maxWalletPct) fail = "big wallet";
    }
    if (!fail) {
      const t = await roundTrip(r.address).catch(() => ({ buyKeep: 0, back: 0 }));
      if (t.buyKeep < RULES.minBuyKeep) fail = "buy price";
      else if (t.back < RULES.minRoundTrip) fail = "sell back";
      await sleep(1000);
    }
    if (fail) {
      why[fail] = (why[fail] ?? 0) + 1;
      await unlist(pool, r.address);
      continue;
    }
    await save(pool, r);
    ok++;
  }
  if (explorerCache.size > 2000) explorerCache.clear();
  log(`ely coins: ${ok} listed of ${rows.length} checked (${Object.entries(why).map(([k, v]) => `${k} ${v}`).join(", ") || "none failed"})`);
  return { checked: rows.length, listed: ok };
}

export async function elyExtLoop(pool, log) {
  if (process.env.ELY_EXT_OFF === "1") return;
  const every = Number(process.env.ELY_EXT_EVERY_MS ?? 20 * 60_000);
  await sleep(2 * 60_000); // after start-up (the old instance's connections close first)
  for (;;) {
    const ok = await scanEly(pool, log).then(
      () => true,
      (e) => (log(`ely coins: ${e.message}`), false)
    );
    await sleep(ok ? every : 5 * 60_000);
  }
}
