// Shared by the forum pages (functions/forum) and the forum API (functions/api).
// Plain JavaScript on purpose: it runs on Cloudflare, outside the Next build.

export const SITE = "https://sasapad.fun";
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const PUBLIC_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
export const SUPPLY = 1e9;
export const COIN_ID = /^0x[0-9a-f]{40}:0x[0-9a-f]{64}$/;
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

/** Finds a coin from its board slug (last part = first 8 hex of its launch key). */
export async function coinFromSlug(env, slug) {
  const m = /-([0-9a-f]{8})$/.exec(slug);
  if (!m) return null;
  const rows = await pub(env, `coins?launch_key=like.0x${m[1]}*&select=id,creator,launch_key,name,symbol,logo,description,created_at,graduated_chain,fee_mode&order=created_at.asc&limit=20`);
  if (!rows.length) return null;
  return rows.find((c) => boardSlug(c) === slug) || rows[0];
}

export async function coinById(env, id) {
  const rows = await pub(env, `coins?id=eq.${q(id)}&select=id,creator,launch_key,name,symbol,logo,description,created_at,graduated_chain,fee_mode`);
  return rows[0] || null;
}

// ------------------------------------------------------------------ holdings

/**
 * How much of the coin a wallet holds, as a share of one chain's supply
 * (the biggest of its chains), in basis points of a percent (1% = 100).
 */
export async function holdingBps(env, coinId, owner) {
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
