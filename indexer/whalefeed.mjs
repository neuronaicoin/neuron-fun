// Whale card feed (web/components/whalecard.tsx): big trades in the busiest coins from other
// DEXs, read every few seconds — one pool per call, in turn — so the site's whale card shows them
// within minutes. Rows go into big_trades (seopages.mjs makes the table; $1,000+ kept 30 days);
// the view whale_feed (whalefeed.sql) serves the last half hour: other-DEX trades of $5,000+ and
// sasa race-coin trades of $1,000+.
//
// GeckoTerminal's free limit (~30 calls a minute) is shared with markets.mjs and seopages.mjs,
// so this takes one call every WHALE_GAP_MS (15 s by default: 4 a minute).

const GT = "https://api.geckoterminal.com/api/v2";
const GAP = Number(process.env.WHALE_GAP_MS ?? "15000");
/** How many of the busiest pools are watched (whole lap ≈ POOLS × GAP). */
const POOLS = Number(process.env.WHALE_POOLS ?? "40");
const MIN_USD = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function busiest(pool) {
  const { rows } = await pool.query(
    `select network, address, pool from (
       select network, address, pool, vol_24h::double precision as v from ext_coins where pool is not null
       union all
       select network, address, pool, vol_24h::double precision from sol_ext_coins where pool is not null
     ) x where coalesce(v, 0) >= 100000 order by v desc nulls last limit $1`,
    [POOLS]
  );
  return rows;
}

async function readPool(pool, c) {
  const r = await fetch(`${GT}/networks/${c.network}/pools/${c.pool}/trades?trade_volume_in_usd_greater_than=${MIN_USD}&token=${c.address}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status === 429) return "limit";
  if (!r.ok) return 0;
  const json = await r.json();
  const sol = c.network === "solana";
  const values = [];
  const cutoff = Date.now() - 60 * 60_000;
  for (const t of json?.data ?? []) {
    const a = t?.attributes ?? {};
    const usd = Number(a.volume_in_usd);
    const at = Date.parse(a.block_timestamp);
    const side = a.kind === "buy" || a.kind === "sell" ? a.kind : null;
    if (!side || !Number.isFinite(usd) || usd < MIN_USD || usd > 1e9 || !Number.isFinite(at) || at < cutoff || !a.tx_hash) continue;
    const tx = sol ? String(a.tx_hash) : String(a.tx_hash).toLowerCase();
    const wallet = a.tx_from_address ? (sol ? String(a.tx_from_address) : String(a.tx_from_address).toLowerCase()) : null;
    values.push([c.network, c.address, tx, new Date(at).toISOString(), side, usd, wallet]);
  }
  if (!values.length) return 0;
  const ph = values.map((_, i) => `($${i * 7 + 1},$${i * 7 + 2},$${i * 7 + 3},$${i * 7 + 4},$${i * 7 + 5},$${i * 7 + 6},$${i * 7 + 7})`).join(",");
  const res = await pool.query(`insert into big_trades (network, address, tx, t, side, usd, wallet) values ${ph} on conflict do nothing`, values.flat());
  return res.rowCount ?? 0;
}

export async function whaleFeedLoop(pool, log) {
  if (process.env.WHALE_FEED === "false") return;
  let list = [];
  let i = 0;
  let saved = 0;
  let lapAt = Date.now();
  for (;;) {
    try {
      if (i >= list.length) {
        if (list.length) log?.(`whale feed: lap of ${list.length} pools, ${saved} big trades saved, ${Math.round((Date.now() - lapAt) / 1000)} s`);
        list = await busiest(pool);
        i = 0;
        saved = 0;
        lapAt = Date.now();
        if (!list.length) {
          await sleep(60_000);
          continue;
        }
      }
      const got = await readPool(pool, list[i++]);
      if (got === "limit") {
        await sleep(30_000);
        continue;
      }
      saved += got;
    } catch (e) {
      log?.(`whale feed: ${e.message}`);
    }
    await sleep(GAP);
  }
}
