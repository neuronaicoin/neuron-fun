/**
 * /s/<id>.json and /s/<id>.jpg: a Solana coin's info and picture (saved by /api/sol/meta).
 * A short address on sasa's own domain: it goes on chain with the coin, and every byte counts
 * there (the launch must fit in one Solana transaction). The files live in Supabase storage.
 */
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const NAME = /^\/s\/([0-9a-f]{24})\.(json|jpg|png|webp)$/;
const TYPES = { json: "application/json", jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const m = NAME.exec(url.pathname);
  if (!m) return new Response("Not found", { status: 404 });
  const r = await fetch(`${ctx.env.SUPABASE_URL || SUPABASE_URL}/storage/v1/object/public/cards/sol/${m[1]}.${m[2]}`, { cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!r.ok) return new Response("Not found", { status: 404, headers: { "access-control-allow-origin": "*" } });
  return new Response(r.body, {
    headers: {
      "content-type": TYPES[m[2]],
      // the files never change (each launch gets new ones)
      "cache-control": "public, max-age=31536000, immutable",
      "access-control-allow-origin": "*",
    },
  });
}
