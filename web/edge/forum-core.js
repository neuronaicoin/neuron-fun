// Shared by the forum pages (functions/forum) and the forum API (functions/api).
// Plain JavaScript on purpose: it runs on Cloudflare, outside the Next build.

import { NETWORK } from "../lib/network.js";
import { MAINNET_IDS } from "./race-pages.js";

export const SITE = "https://sasapad.fun";
/** v6 coins (bonding curves) on testnet; on mainnet every board is a race coin's. */
export const V6 = NETWORK === "testnet";
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const PUBLIC_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
export const SUPPLY = 1e9;
export const COIN_ID = /^0x[0-9a-f]{40}:0x[0-9a-f]{64}$/;
/** A race coin's id (bytes32). */
export const RACE_ID = /^0x[0-9a-f]{64}$/;
/** A board id this site accepts: v6 coins on testnet, race coins on mainnet. */
export const isCoinBoard = (b) => (V6 ? COIN_ID.test(b) : RACE_ID.test(b));

/** Race coin columns, with its chains (only mainnet chains count on mainnet). */
export const RACE_COLS = "id,coin,creator,name,symbol,logo,description,fee_mode,launched_at,winner_chain,decided_at,total_usd,race_chains!inner(chain_id,state,pool_usd,reported_usd,price_usd,volume_usd)";
export const RACE_FILTER = `race_chains.chain_id=in.(${MAINNET_IDS.join(",")})`;

/** A race_coins row in the shape the forum uses for every coin. */
export function raceCoin(r) {
  return {
    ...r,
    race: true,
    address: r.coin,
    launch_key: r.id,
    created_at: r.launched_at,
    last_trade_at: r.decided_at || r.launched_at,
    lanes: Array.isArray(r.race_chains) ? r.race_chains : [],
  };
}

/** Where the coin is traded on the site. */
export const tradeUrl = (coin) => (coin.race ? `/r/?id=${coin.id}` : `/coin/?id=${encodeURIComponent(coin.id)}`);
export const GENERAL = "sasa";

// ------------------------------------------------------------------ database

/** Read with the public key (cached briefly at the edge unless fresh). */
export async function pub(env, path, { fresh = false, count = false } = {}) {
  const key = (env && env.SUPABASE_KEY) || PUBLIC_KEY;
  const headers = { apikey: key, authorization: `Bearer ${key}` };
  if (count) headers.prefer = "count=exact";
  const r = await fetch(`${(env && env.SUPABASE_URL) || SUPABASE_URL}/rest/v1/${path}`, {
    headers,
    cf: fresh ? { cacheTtl: 0 } : { cacheTtl: 15, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`db ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const range = r.headers.get("content-range") || "";
  return count ? { data, total: Number(range.split("/")[1]) || 0 } : data;
}

/** Read or write with the secret key (API only). */
export async function sec(env, path, { method = "GET", body, prefer } = {}) {
  const key = env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: key, "content-type": "application/json" };
  if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  if (prefer) headers.prefer = prefer;
  const r = await fetch(`${env.SUPABASE_URL || SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!r.ok) {
    const e = new Error((data && (data.message || data.hint)) || text || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

export const q = (s) => encodeURIComponent(s);

// ------------------------------------------------------------------ names and links

export function slugify(s, max = 60) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** moon-otter-ottr-3fa9c2e1: readable, and the last part finds the coin. */
export function boardSlug(coin) {
  const name = slugify(coin.name, 40) || "coin";
  const sym = slugify(coin.symbol, 16);
  const key = String(coin.launch_key || coin.id.split(":")[1] || "").slice(2, 10);
  return [name, sym && sym !== name ? sym : "", key].filter(Boolean).join("-");
}

export const boardUrl = (coinOrGeneral) =>
  coinOrGeneral === GENERAL ? `/forum/${GENERAL}/` : `/forum/${boardSlug(coinOrGeneral)}/`;

export const threadUrl = (board, t) =>
  `${board === GENERAL ? `/forum/${GENERAL}/` : boardUrl(board)}${t.id}-${slugify(t.title, 70) || "thread"}/`;

/** Finds a coin from its board slug (last part = first 8 hex of its launch key, or of a race coin's id). */
export async function coinFromSlug(env, slug, { fresh = false } = {}) {
  const m = /-([0-9a-f]{8})$/.exec(slug);
  if (!m) return null;
  if (!V6) {
    const races = (await pub(env, `race_coins?id=like.0x${m[1]}*&select=${RACE_COLS}&${RACE_FILTER}&order=launched_at.asc&limit=20`, { fresh })).map(raceCoin);
    return races.find((c) => boardSlug(c) === slug) || races[0] || null;
  }
  const rows = await pub(env, `coins?launch_key=like.0x${m[1]}*&select=id,creator,launch_key,name,symbol,logo,description,created_at,graduated_chain,fee_mode&order=created_at.asc&limit=20`);
  if (!rows.length) return null;
  return rows.find((c) => boardSlug(c) === slug) || rows[0];
}

export async function coinById(env, id, { fresh = false } = {}) {
  if (!V6) {
    if (!RACE_ID.test(id)) return null;
    const rows = await pub(env, `race_coins?id=eq.${q(id)}&select=${RACE_COLS}&${RACE_FILTER}`, { fresh });
    return rows[0] ? raceCoin(rows[0]) : null;
  }
  const rows = await pub(env, `coins?id=eq.${q(id)}&select=id,creator,launch_key,name,symbol,logo,description,created_at,graduated_chain,fee_mode`);
  return rows[0] || null;
}

// ------------------------------------------------------------------ holdings

/**
 * How much of the coin a wallet holds, as a share of one chain's supply
 * (the biggest of its chains), in basis points of a percent (1% = 100).
 */
export async function holdingBps(env, coinId, owner) {
  if (!V6) {
    // race coin: its coins on every mainnet chain, as a share of the whole supply
    const coin = await coinById(env, coinId);
    if (!coin) return 0;
    const rows = await sec(env, `balances?holder=eq.${q(owner)}&token=eq.${q(String(coin.address).toLowerCase())}&chain_id=in.(${MAINNET_IDS.join(",")})&amount=gt.0&select=amount`);
    const share = (rows || []).reduce((a, r) => a + Number(r.amount) / 1e18, 0) / SUPPLY;
    return share > 0 ? Math.max(1, Math.round(share * 10000)) : 0;
  }
  const curves = await sec(env, `curves?coin_id=eq.${q(coinId)}&select=chain_id,token`);
  if (!curves || !curves.length) return 0;
  const tokens = [...new Set(curves.map((c) => c.token))];
  const rows = await sec(
    env,
    `balances?holder=eq.${q(owner)}&token=in.(${tokens.map((t) => `"${t}"`).join(",")})&amount=gt.0&select=chain_id,token,amount`
  );
  let best = 0;
  for (const r of rows || []) {
    if (!curves.some((c) => c.chain_id === r.chain_id && c.token === r.token)) continue;
    const share = Number(r.amount) / 1e18 / SUPPLY;
    if (share > best) best = share;
  }
  // Anything above zero counts as holding; show at least 0.01%.
  return best > 0 ? Math.max(1, Math.round(best * 10000)) : 0;
}

export function fmtShare(bps) {
  if (!bps) return "";
  const pct = bps / 100;
  return pct >= 10 ? `${pct.toFixed(0)}%` : pct >= 1 ? `${pct.toFixed(1)}%` : `${pct.toFixed(2)}%`;
}

// ------------------------------------------------------------------ misc

export const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function admins(env) {
  return String((env && env.FORUM_ADMINS) || "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
}

export const wordCount = (s) => (String(s).trim().match(/\S+/g) || []).length;
