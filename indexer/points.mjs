// Points, Season 0: recomputes everyone's points every few minutes from what
// they did (trades, launches, follows, alerts, forum posts, invites...).
// All the rules live in refresh_points() in points.sql.

import { gasPrices } from "./alerts.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pointsLoop(pool, log) {
  let warned = false;
  let lastPrice = null;
  for (;;) {
    try {
      const prices = await gasPrices().catch(() => null);
      if (prices?.ETH) lastPrice = prices.ETH;
      if (lastPrice) {
        await pool.query("select refresh_points($1)", [lastPrice]);
        warned = false;
      }
    } catch (e) {
      if (/function refresh_points|relation "points_events"/.test(e.message)) {
        if (!warned) log("points off: run indexer/points.sql in Supabase");
        warned = true;
      } else log(`points: ${e.message}`);
    }
    await sleep(3 * 60_000);
  }
}
