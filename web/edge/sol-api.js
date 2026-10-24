/**
 * Solana launches (/api/sol/*). See lib/sollaunch.ts for the launch itself and
 * indexer/solkeeper.mjs for what happens after it (checking each coin, paying out fees).
 *
 *   GET  /api/sol/config        { treasury, alt }: sasa's Solana wallet that gets its half of every
 *                               coin's creator fees (Railway's SOLANA_TREASURY, via sol_config), and the
 *                               address lookup table that keeps a launch in one transaction
 *                               (made by the keeper, kept in sol_config)
 *   POST /api/sol/meta          { name, symbol, description, image, twitter?, telegram?, website? }
 *                               → { uri }: the coin's picture and info, stored where every Solana
 *                               app (explorers, DexScreener, GMGN, wallets) reads them
 *   POST /api/sol/coin          { mint, creator, uri, sig? } → { ok }: a coin about to launch
 *                               (sent before signing); the keeper checks it on chain (and takes
 *                               its creator from there) before sasa lists it
 *   GET  /api/sol/coin/<mint>   { status }: pending / live / bad
 *
 * No sign-in needed (the launch is checked on chain); a signed-in user's sasa address is kept
 * with the coin. Rate-limited per network address.
 */

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
/** Where the coin files are served from (functions/s): short, because the address goes on chain. */
const SHORT = "https://sasapad.fun/s/";
const MAX_IMAGE = 300_000; // bytes, after decoding
const IMAGE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+=*)$/;

const json = (data, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache } });
const fail = (status, error) => json({ error }, status);

const clean = (s, n) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, n);

/** https link or nothing. */
function link(v, hosts) {
  const s = clean(v, 200);
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return "";
    if (hosts && !hosts.some((h) => u.host === h || u.host.endsWith(`.${h}`))) return "";
    return u.toString();
  } catch {
    return "";
  }
}

async function storagePut(env, path, bytes, type) {
  const key = env.SUPABASE_SERVICE_KEY;
  const r = await fetch(`${env.SUPABASE_URL || SUPABASE_URL}/storage/v1/object/cards/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, apikey: key, "content-type": type, "x-upsert": "false", "cache-control": "max-age=31536000" },
    body: bytes,
  });
  if (!r.ok) throw new Error(`storage ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return SHORT + path.replace(/^sol\//, "");
}

/** A short random id for the files (no clash, nothing guessable about the coin). */
function newId() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The treasury comes from one place only (the keeper writes Railway's SOLANA_TREASURY into
 * sol_config), so the site and the keeper can never disagree about it. */
async function config(env, sb) {
  let treasury = null;
  let alt = null;
  try {
    const { data } = await sb(env, "sol_config?key=in.(alt,treasury)&select=key,value");
    for (const r of data || []) {
      if (typeof r.value !== "string" || !B58.test(r.value)) continue;
      if (r.key === "alt") alt = r.value;
      if (r.key === "treasury") treasury = r.value;
    }
  } catch {
    // table not made yet (the keeper makes it): no launches until it has run
  }
  return json({ treasury, alt }, 200, "public, max-age=60");
}

async function meta(env, request, body, underLimit) {
  if (!(await underLimit(env, request, "solmeta", 40))) return fail(429, "Too many launches from here today. Try again tomorrow.");
  const name = clean(body.name, 32);
  const symbol = clean(body.symbol, 10)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!name || symbol.length < 2) return fail(400, "Give the coin a name and a ticker.");
  const description = clean(body.description, 500);
  const m = IMAGE.exec(String(body.image || ""));
  if (!m) return fail(400, "Add a picture for your coin.");
  let bytes;
  try {
    bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  } catch {
    return fail(400, "That picture could not be used.");
  }
  if (bytes.length > MAX_IMAGE || bytes.length < 100) return fail(400, "That picture could not be used.");
  const ext = m[1] === "jpeg" ? "jpg" : m[1];
  const id = newId();
  const image = await storagePut(env, `sol/${id}.${ext}`, bytes, `image/${m[1]}`);
  // the usual Solana coin info file (what pump-style apps, DexScreener, GMGN and wallets read)
  const info = {
    name,
    symbol,
    description,
    image,
    showName: true,
    createdOn: "https://sasapad.fun",
  };
  const twitter = link(body.twitter, ["x.com", "twitter.com"]);
  const telegram = link(body.telegram, ["t.me", "telegram.me"]);
  const website = link(body.website);
  if (twitter) info.twitter = twitter;
  if (telegram) info.telegram = telegram;
  if (website) info.website = website;
  const uri = await storagePut(env, `sol/${id}.json`, new TextEncoder().encode(JSON.stringify(info)), "application/json");
  return json({ uri, image });
}

async function record(env, request, body, me, sb, underLimit) {
  const mint = String(body.mint || "");
  const creator = String(body.creator || "");
  const sig = String(body.sig || "");
  const uri = String(body.uri || "");
  // recorded just before the launch is signed (no signature yet): the keeper checks it on chain
  if (!B58.test(mint) || !B58.test(creator) || (sig && !SIG.test(sig))) return fail(400, "Bad coin.");
  if (!uri.startsWith(SHORT) || uri.length > 80) return fail(400, "Bad coin.");
  if (!(await underLimit(env, request, "solcoin", 60))) return fail(429, "Too many launches from here today.");
  await sb(env, "sol_coins?on_conflict=mint", {
    method: "POST",
    body: {
      mint,
      creator,
      owner: me ? String(me).toLowerCase() : null,
      uri,
      sig: sig || null,
      name: clean(body.name, 32),
      symbol: clean(body.symbol, 10),
      image: clean(body.image, 200),
    },
    prefer: "resolution=ignore-duplicates,return=minimal",
  });
  return json({ ok: true });
}

async function status(env, mint, sb) {
  if (!B58.test(mint)) return fail(400, "Bad coin.");
  const { data } = await sb(env, `sol_coins?mint=eq.${mint}&select=status`);
  return json({ status: (data && data[0] && data[0].status) || null });
}

export async function solRoute(env, request, me, parts, method, body, { sb, underLimit }) {
  if (parts[1] === "config" && parts.length === 2 && method === "GET") return await config(env, sb);
  if (parts[1] === "meta" && parts.length === 2 && method === "POST") return await meta(env, request, body, underLimit);
  if (parts[1] === "coin" && parts.length === 2 && method === "POST") return await record(env, request, body, me, sb, underLimit);
  if (parts[1] === "coin" && parts.length === 3 && method === "GET") return await status(env, parts[2], sb);
  return fail(404, "Not found.");
}
