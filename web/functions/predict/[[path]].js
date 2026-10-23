/**
 * Cloudflare Pages Function for /predict/?m=<outcome>: a shared prediction's link preview shows its
 * own card (drawn by the indexer, marketcards.mjs: the question and its prices). The page itself
 * is unchanged.
 */
import { rewrite } from "../../edge/og-rewrite.js";

const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SITE = "https://sasapad.fun";

export async function onRequestGet(ctx) {
  const res = await ctx.next();
  if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
  const url = new URL(ctx.request.url);
  const m = Number(url.searchParams.get("m"));
  if (!Number.isInteger(m) || m <= 0) return res;
  const card = `${SUPABASE_URL}/storage/v1/object/public/cards/p-${m}.png`;
  let img = `${SITE}/og-plain.png`;
  try {
    const h = await fetch(card, { method: "HEAD", cf: { cacheTtl: 60 } });
    if (h.ok) img = card;
  } catch {}
  return rewrite(res, {
    title: "What's your call? Yes or no on sasa",
    description: "Prices, matches and rate decisions: pick yes or no. The right answer pays $1 a share.",
    pageUrl: `${SITE}/predict/?m=${m}`,
    img,
  });
}
