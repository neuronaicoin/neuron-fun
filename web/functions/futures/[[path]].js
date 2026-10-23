/**
 * Cloudflare Pages Function for /futures/?c=<market> (also the old /perps/ links redirect here).
 *
 * Link previews (X, Telegram, Discord) read meta tags without running JavaScript: name the market
 * in the title and point the preview at its card (drawn by the indexer, marketcards.mjs). The page
 * itself is unchanged.
 */
import { rewrite } from "../../edge/og-rewrite.js";

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SITE = "https://sasapad.fun";
const NAMES = {
  TSLA: "Tesla", NVDA: "Nvidia", AAPL: "Apple", MSFT: "Microsoft", AMZN: "Amazon", GOOGL: "Alphabet", META: "Meta", NFLX: "Netflix",
  AMD: "AMD", HOOD: "Robinhood", COIN: "Coinbase", MSTR: "Strategy", PLTR: "Palantir", GOLD: "Gold", SILVER: "Silver", CL: "Crude oil",
  OIL: "Crude oil", BRENTOIL: "Brent oil", NATGAS: "Natural gas", XYZ100: "Nasdaq 100", BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", HYPE: "Hyperliquid",
};

export async function onRequestGet(ctx) {
  const res = await ctx.next();
  if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
  const url = new URL(ctx.request.url);
  const coin = (url.searchParams.get("c") || "").replace(/[^A-Za-z0-9:]/g, "").slice(0, 20);
  if (!coin) return res;
  const label = coin.slice(coin.indexOf(":") + 1);
  const name = NAMES[label.toUpperCase()];
  const builder = coin.includes(":");
  const title = `${label}${name ? ` (${name})` : ""} futures${builder ? " · 24/7" : ""} · sasa`;
  const description = builder
    ? `Long or short ${name || label} 24/7 with up to 10x, weekends too, from your sasa balance.`
    : `Long or short ${name || label} with up to 20x leverage, from your sasa balance.`;
  const pageUrl = `${SITE}/futures/?c=${encodeURIComponent(coin)}`;
  const card = `${SUPABASE_URL}/storage/v1/object/public/cards/f-${coin.toLowerCase().replace(/[^0-9a-z]+/g, "-")}.png`;
  let img = `${SITE}/og-plain.png`;
  try {
    const h = await fetch(card, { method: "HEAD", cf: { cacheTtl: 60 } });
    if (h.ok) img = card;
  } catch {}
  return rewrite(res, { title, description, pageUrl, img });
}
