/**
 * Market Fear & Greed: one number from 0 (extreme fear) to 100 (extreme greed), worked out from
 * Hyperliquid's live markets. The same formula runs in the indexer (indexer/whales.mjs), which
 * saves one value an hour for the history line.
 *
 * Four parts, each 0..1:
 *   breadth   share of the 50 busiest markets up over 24 hours (bigger markets count more)
 *   bitcoin   BTC's 24-hour move: −8% → 0, +8% → 1
 *   momentum  the 50 busiest markets' average 24-hour move: −10% → 0, +10% → 1
 *   funding   what longs pay shorts, a year's worth: −20% → 0, +40% → 1 (about +10% is normal)
 */

const clamp = (v) => Math.max(0, Math.min(1, v));

export const FG_WEIGHTS = { breadth: 0.3, bitcoin: 0.25, momentum: 0.2, funding: 0.25 };

/** markets: [{ coin, change24h, volume24h, funding }] (funding: Hyperliquid's hourly rate) */
export function fearGreed(markets) {
  const top = (markets || [])
    .filter((m) => m && Number.isFinite(m.change24h) && m.volume24h > 0)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, 50);
  if (top.length < 5) return null;
  let w = 0;
  let up = 0;
  let move = 0;
  let fund = 0;
  let vw = 0;
  for (const m of top) {
    const sw = Math.sqrt(m.volume24h);
    w += sw;
    if (m.change24h > 0) up += sw;
    move += m.change24h * m.volume24h;
    fund += (Number(m.funding) || 0) * m.volume24h;
    vw += m.volume24h;
  }
  const btc = top.find((m) => m.coin === "BTC");
  const avgMove = move / vw;
  const fundingYear = (fund / vw) * 24 * 365 * 100;
  const parts = {
    breadth: clamp(up / w),
    bitcoin: clamp(((btc ? btc.change24h : avgMove) + 8) / 16),
    momentum: clamp((avgMove + 10) / 20),
    funding: clamp((fundingYear + 20) / 60),
  };
  const score = Math.round(
    100 * (FG_WEIGHTS.breadth * parts.breadth + FG_WEIGHTS.bitcoin * parts.bitcoin + FG_WEIGHTS.momentum * parts.momentum + FG_WEIGHTS.funding * parts.funding)
  );
  return { score, label: fgLabel(score), parts, upShare: up / w, avgMove, fundingYear, btcMove: btc ? btc.change24h : null };
}

export function fgLabel(score) {
  if (score < 25) return "Extreme fear";
  if (score < 45) return "Fear";
  if (score < 56) return "Neutral";
  if (score < 76) return "Greed";
  return "Extreme greed";
}
