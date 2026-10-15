/**
 * Where leverage trading (Perps) is not offered. Shared by the page (lib/perps.ts) and the edge
 * function that tells the page where the visitor is (functions/geo.js).
 *
 * Countries: the US and its territories, the UK, Türkiye, and the sanctioned countries in
 * Hyperliquid's terms. Regions: Ontario (Canada); Crimea, Sevastopol, Donetsk, Luhansk (Ukraine).
 * Codes are ISO 3166 (country) and ISO 3166-2 without the country part (region), as Cloudflare
 * reports them.
 */
export const PERPS_BLOCKED_COUNTRIES = ["US", "PR", "GU", "VI", "AS", "MP", "UM", "GB", "TR", "IR", "KP", "CU", "SY", "RU"];
export const PERPS_BLOCKED_REGIONS = { CA: ["ON"], UA: ["43", "40", "14", "09"] };

/** True when a visitor from `country` / `region` may not trade perps. Unknown place: allowed. */
export function perpsBlocked(country, region) {
  const c = String(country || "").toUpperCase();
  if (!c || c === "XX" || c === "T1") return c === "T1"; // T1 = Tor: location hidden, not offered
  if (PERPS_BLOCKED_COUNTRIES.includes(c)) return true;
  const r = String(region || "").toUpperCase();
  return !!(PERPS_BLOCKED_REGIONS[c] && PERPS_BLOCKED_REGIONS[c].includes(r));
}
