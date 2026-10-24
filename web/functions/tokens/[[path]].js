/**
 * Public token info for coin trackers (DexScreener, GeckoTerminal, CoinGecko, wallets): every coin
 * launched on sasa, with its name, ticker, logo and page, read straight from the database.
 *
 *   /tokens/list.json                  all coins in the Uniswap token-list format (one entry per chain)
 *   /tokens/<chainId>/<address>.json   one coin: name, ticker, description, logo, sasa page, pools
 *   /tokens/logo/<address>.png         the coin's logo as an image (logos are stored on-chain as data URLs)
 *
 * Read-only, public data, no keys. Cached at the edge.
 */
import { pub } from "../../edge/forum-core.js";
import { CHAINS, MAINNET_IDS } from "../../edge/race-pages.js";

const SITE = "https://sasapad.fun";
const ADDR = /^0x[0-9a-f]{40}$/;
const CHAIN_NAME = Object.fromEntries(CHAINS.map((c) => [c.chainId, c.name]));
const cors = { "access-control-allow-origin": "*" };

const json = (data, maxAge = 300) =>
  new Response(JSON.stringify(data, null, 1), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${maxAge}`, ...cors },
  });
const notFound = (msg = "Not found") => new Response(JSON.stringify({ error: msg }), { status: 404, headers: { "content-type": "application/json", ...cors } });

const logoUrl = (address) => `${SITE}/tokens/logo/${address}.png`;
const pageUrl = (id) => `${SITE}/r/?id=${id}`;
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

export async function onRequestGet(ctx) {
  const { env, request } = ctx;
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/tokens\/?/, "").replace(/\/$/, "").split("/").filter(Boolean);
  try {
    if (parts.length === 1 && parts[0] === "list.json") return await list(env);
    if (parts.length === 2 && parts[0] === "logo") return await logo(env, parts[1].replace(/\.(png|jpg|jpeg|webp)$/i, "").toLowerCase());
    if (parts.length === 2 && /^\d+$/.test(parts[0])) return await one(env, Number(parts[0]), parts[1].replace(/\.json$/i, "").toLowerCase());
    return json({
      about: "Coins launched on sasa (sasapad.fun). Public, free to use.",
      list: `${SITE}/tokens/list.json`,
      token: `${SITE}/tokens/<chainId>/<address>.json`,
      logo: `${SITE}/tokens/logo/<address>.png`,
      chains: CHAINS.map((c) => ({ chainId: c.chainId, name: c.name, dex: c.dex })),
    }, 3600);
  } catch (e) {
    return new Response(JSON.stringify({ error: "Try again shortly." }), { status: 503, headers: { "content-type": "application/json", ...cors } });
  }
}

async function list(env) {
  const tokens = [];
  const seen = new Set();
  // newest first, in pages (no logos here: they are big, the logo link serves each one)
  for (let from = 0; from < 50_000; from += 1000) {
    const rows = await pub(
      env,
      `race_coins?select=coin,name,symbol,launched_at,race_chains!inner(chain_id)&race_chains.chain_id=in.(${MAINNET_IDS.join(",")})&order=launched_at.desc&offset=${from}&limit=1000`,
    );
    for (const r of rows) {
      const address = String(r.coin).toLowerCase();
      if (!ADDR.test(address)) continue;
      for (const l of r.race_chains || []) {
        const key = `${l.chain_id}:${address}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tokens.push({
          chainId: l.chain_id,
          address,
          name: clean(r.name, 40) || "sasa coin",
          symbol: clean(r.symbol, 20).replace(/\s+/g, "") || "COIN",
          decimals: 18,
          logoURI: logoUrl(address),
        });
      }
    }
    if (rows.length < 1000) break;
  }
  return json({
    name: "sasa",
    logoURI: `${SITE}/sasa-icon-512.png`,
    keywords: ["sasa", "launchpad", "meme"],
    timestamp: new Date().toISOString(),
    version: { major: 1, minor: 0, patch: 0 },
    tokens,
  });
}

async function one(env, chainId, address) {
  if (!ADDR.test(address) || !MAINNET_IDS.includes(chainId)) return notFound();
  const rows = await pub(
    env,
    `race_coins?select=id,coin,creator,name,symbol,description,launched_at,race_chains!inner(chain_id,pool_id,native)&coin=eq.${address}&race_chains.chain_id=eq.${chainId}&limit=1`,
  );
  const r = rows[0];
  if (!r) return notFound();
  const lane = (r.race_chains || [])[0] || {};
  return json({
    chainId,
    chain: CHAIN_NAME[chainId],
    address,
    name: clean(r.name, 40),
    symbol: clean(r.symbol, 20),
    decimals: 18,
    totalSupply: "1000000000",
    description: clean(r.description, 1000),
    logo: logoUrl(address),
    website: pageUrl(r.id),
    launchpad: { name: "sasa", url: SITE, x: "https://x.com/sasapadfun" },
    creator: r.creator,
    createdAt: r.launched_at,
    pool: lane.pool_id ? { id: lane.pool_id, quote: lane.native, dex: CHAINS.find((c) => c.chainId === chainId)?.dex } : null,
  });
}

async function logo(env, address) {
  if (!ADDR.test(address)) return notFound();
  const rows = await pub(env, `race_coins?select=logo&coin=eq.${address}&order=launched_at.asc&limit=1`);
  const src = rows[0]?.logo || "";
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(src);
  if (m) {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(bytes, { headers: { "content-type": `image/${m[1]}`, "cache-control": "public, max-age=86400, immutable", ...cors } });
  }
  if (/^https:\/\/\S+$/i.test(src)) return Response.redirect(src, 302);
  // no logo: sasa's own mark
  return Response.redirect(`${SITE}/sasa-icon-512.png`, 302);
}
