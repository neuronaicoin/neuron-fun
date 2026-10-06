/**
 * /llms-coins.txt: the coins people trade on sasa right now, as plain text for
 * AI answer engines (linked from /llms.txt). Refreshed at most every 30 minutes.
 */
const SUPABASE_URL = "https://rkoassatqhdkdptekvdt.supabase.co";
const SUPABASE_KEY = "sb_publishable_200jvFq0EQhdLdVToTzI7w_eWGtE1Ol";
const SITE = "https://sasapad.fun";
const NETS = { base: "Base", bsc: "BNB Chain", eth: "Ethereum", robinhood: "Robinhood Chain", arc: "Arc" };

const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "n/a";
  const t = (x) => x.replace(/\.?0+$/, "");
  if (n >= 1e9) return `$${t((n / 1e9).toFixed(2))}B`;
  if (n >= 1e6) return `$${t((n / 1e6).toFixed(2))}M`;
  if (n >= 1e3) return `$${t((n / 1e3).toFixed(1))}K`;
  return `$${n.toFixed(2)}`;
};
const pct = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? "n/a" : `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(1)}%`);
const clean = (s) => String(s ?? "").replace(/[\r\n|[\]]+/g, " ").trim().slice(0, 60);

export async function onRequestGet() {
  const h = { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, cf: { cacheTtl: 1800, cacheEverything: true } };
  let ours = [];
  let ext = [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/coin_list?select=id,name,symbol,graduated_chain,volume_native_24h,holders_total,change_24h,created_at&order=volume_native_24h.desc.nullslast&limit=150`, h);
    if (r.ok) ours = await r.json();
  } catch {}
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ext_coins?select=network,address,name,symbol,mcap_usd,fdv_usd,liq_usd,vol_24h,change_24h&order=vol_24h.desc.nullslast&limit=300`, h);
    if (r.ok) ext = await r.json();
  } catch {}

  const lines = [
    "# Coins on sasa right now",
    "",
    `> Updated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC. sasa (${SITE}) lists meme coins launched on sasa and the busiest coins from other DEXs on Robinhood Chain, Base and more. Every coin can be bought and sold with USDC in one tap. Figures are 24-hour values.`,
    "",
    "## Launched on sasa",
    "",
    ...(ours.length
      ? ours.map(
          (c) =>
            `- [${clean(c.name)} ($${clean(c.symbol)})](${SITE}/coin/?id=${encodeURIComponent(c.id)}): ${c.graduated_chain ? "graduated" : "on its bonding curve"}; volume ${money(Number(c.volume_native_24h || 0) / 1e6)}; holders ${Number(c.holders_total || 0)}; change ${pct(c.change_24h === null ? null : Number(c.change_24h) * 100)}`
        )
      : ["- None yet."]),
    "",
    "## Trading on other DEXs",
    "",
    ...(ext.length
      ? ext.map(
          (c) =>
            `- [${clean(c.name)} ($${clean(c.symbol)}) on ${NETS[c.network] || c.network}](${SITE}/x/?n=${c.network}&a=${c.address}): market cap ${money(Number(c.mcap_usd) > 0 ? c.mcap_usd : c.fdv_usd)}; volume ${money(c.vol_24h)}; liquidity ${money(c.liq_usd)}; change ${pct(c.change_24h)}`
        )
      : ["- None right now."]),
    "",
  ];
  return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=1800" } });
}
