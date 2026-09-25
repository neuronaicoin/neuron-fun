/** Dollar prices of the chains' gas coins, from Coinbase. Null if unavailable. */
let cache: { at: number; prices: Record<string, number> } | null = null;

export async function fetchPrices(): Promise<Record<string, number> | null> {
  if (cache && Date.now() - cache.at < 60_000) return cache.prices;
  try {
    const symbols = ["ETH", "BNB"];
    const got = await Promise.all(
      symbols.map(async (s) => {
        const r = await fetch(`https://api.coinbase.com/v2/prices/${s}-USD/spot`);
        const j = await r.json();
        return [s, Number(j?.data?.amount)] as const;
      })
    );
    const prices: Record<string, number> = { USD: 1 };
    for (const [s, p] of got) if (Number.isFinite(p) && p > 0) prices[s] = p;
    if (!prices.ETH) return null;
    cache = { at: Date.now(), prices };
    return prices;
  } catch {
    return null;
  }
}
