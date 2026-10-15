/**
 * /geo: where the visitor is (Cloudflare's country and region) and whether Perps is offered
 * there (lib/perpsgeo.js). The Perps page asks this before showing trading.
 */
import { perpsBlocked } from "../lib/perpsgeo.js";

export async function onRequestGet(ctx) {
  const cf = ctx.request.cf || {};
  const country = String(cf.country || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  const region = String(cf.regionCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  return new Response(JSON.stringify({ country, region, perps: !perpsBlocked(country, region) }), {
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });
}
