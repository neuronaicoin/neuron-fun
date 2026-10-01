// Trader badges: recomputed every 5 minutes into trader_badges (see badges.sql).
// Pages read the ready rows, so showing badges costs nothing per visit.

import { allChainsUsd, gasPrices } from "./alerts.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function badgesLoop(pool, log) {
  let warned = false;
  let unit = null;
  // Let the indexer catch up first after a restart.
  await sleep(30_000);
  for (;;) {
    try {
      // Same money unit as refresh_points(): USD per 1e18 raw units (1e12 for USDC).
      if (allChainsUsd()) unit = 1e12;
      else {
        const prices = await gasPrices().catch(() => null);
        if (prices?.ETH) unit = prices.ETH;
      }
      if (unit) {
        await pool.query("select refresh_badges($1)", [unit]);
        warned = false;
      }
    } catch (e) {
      if (/function refresh_badges|relation "trader_badges"/.test(e.message)) {
        if (!warned) log("badges off: run indexer/badges.sql in Supabase");
        warned = true;
      } else log(`badges: ${e.message}`);
    }
    await sleep(5 * 60_000);
  }
}
