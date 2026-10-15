// Market: the 300 biggest coins, tradeable on sasa (topcoins.sql).
//
// Once a day: CoinGecko's ranking by market cap (top 500 looked at) and every coin's contract
// addresses. Stablecoins and wrapped / staked copies are left out. Each coin is traded on the
// cheapest of our chains where it has real DEX liquidity (DexScreener): Base, then BNB Chain,
// then Ethereum. Bitcoin, ETH and BNB are bought as cbBTC (Base), WETH (Base), WBNB (BNB Chain).
// Every 15 minutes: rank, market cap, 24h change and the 7-day line for the 300 (two CoinGecko calls).
// Every minute: each coin's price from its own DEX pool (DexScreener, no monthly limit), with
// market cap and 24h change scaled from CoinGecko's last numbers.
//
// Env: COINGECKO_KEY  optional free "demo" key (coingecko.com/en/api): steadier limits.
//      TOP_COINS (300), TOP_EVERY_MS (900000), TOP_OFF=1 turns it off.

const CG = "https://api.coingecko.com/api/v3";
const DS = "https://api.dexscreener.com";
const LIVE_MS = Number(process.env.TOP_LIVE_MS ?? "60000");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Our networks: CoinGecko platform id, DexScreener chain id, least DEX liquidity to list a coin there. */
export const NETS = [
  { id: "base", cg: "base", ds: "base", minLiq: 100_000 },
  { id: "bsc", cg: "binance-smart-chain", ds: "bsc", minLiq: 100_000 },
  { id: "eth", cg: "ethereum", ds: "ethereum", minLiq: 250_000 },
];

/** Coins without a token of their own on our chains: bought as their best-known wrapped form. */
export const NATIVE = {
  bitcoin: { network: "base", address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", via: "cbBTC on Base" },
  ethereum: { network: "base", address: "0x4200000000000000000000000000000000000006", via: "WETH on Base" },
  binancecoin: { network: "bsc", address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", via: "WBNB on BNB Chain" },
};

const STABLE_SYMBOLS = new Set(
  ["usdt", "usdc", "dai", "fdusd", "tusd", "usdd", "pyusd", "usde", "usds", "usd1", "rlusd", "gho", "frax", "lusd", "crvusd", "usdb", "usdx", "usd0", "eurc", "eurs", "susde", "busd", "usdg", "usdy", "ustb", "buidl", "bfusd", "usdf", "usdtb"]
);

/** A stablecoin (dollar, euro…): nothing to gain from buying it here. */
export function isStable(c) {
  const s = String(c?.symbol ?? "").toLowerCase();
  const n = String(c?.name ?? "");
  return STABLE_SYMBOLS.has(s) || /usd/.test(s) || /\bstable ?coin\b/i.test(n) || /\b(us dollar|euro coin|dollar)\b/i.test(n);
}

/** A copy of another coin (wrapped, staked, bridged): the original is listed instead. */
export function isCopy(c) {
  const id = String(c?.id ?? "");
  if (NATIVE[id]) return false;
  const s = String(c?.symbol ?? "").toLowerCase();
  const n = String(c?.name ?? "");
  return (
    /\b(wrapped|staked|restaked|bridged|liquid staking|binance-peg|tokenized)\b/i.test(n) ||
    /^w(eth|btc|bnb|steth|eeth|sol|avax|pol|matic)$/.test(s) ||
    /^(st|wst|we|ez|r|cb|s|m|os|rs|eth|l)eth$/.test(s) ||
    /^(cb|l|solv|uni|t|cl|f|e|pump|enz|x)btc$/.test(s) ||
    s === "btcb" ||
    /^(jito|m|b|j|ms|js|bn|dsol)sol$/.test(s)
  );
}

/**
 * Coins whose home is a chain we don't trade on (XRP Ledger, Solana, Cardano…): on our chains
 * they exist only as a token that stands for them (e.g. Binance-Peg XRP). Their page says so.
 */
export const NON_EVM = new Set(
  ("ripple dogecoin cardano polkadot litecoin bitcoin-cash the-open-network tron solana avalanche-2 stellar near cosmos filecoin " +
    "hedera-hashgraph internet-computer aptos sui ethereum-classic eos tezos algorand zcash dash elrond-erd-2 iota neo kaspa monero " +
    "vechain bittensor sei-network celestia osmosis injective-protocol kava zilliqa theta-token ontology waves qtum harmony " +
    "flow mina-protocol stacks thorchain hyperliquid berachain-bera story-2 bitcoin-sv ecash")
    .split(" ")
);
const CHAIN_NAME = { base: "Base", bsc: "BNB Chain", eth: "Ethereum" };

/** Where a coin could trade: its own token on each of our chains, cheapest chain first. */
export function candidates(id, platforms, symbol = "") {
  if (NATIVE[id]) return [{ ...NATIVE[id] }];
  const sym = String(symbol).toUpperCase();
  const out = [];
  for (const n of NETS) {
    const a = String(platforms?.[n.cg] ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) continue;
    const via = NON_EVM.has(id) ? (n.id === "bsc" ? `Binance-Peg ${sym} on BNB Chain` : `${sym} token on ${CHAIN_NAME[n.id]}`) : null;
    out.push({ network: n.id, address: a, via });
  }
  return out;
}

/** The most liquid DexScreener pair that trades `address` on `dsChain` (either side of the pair). */
export function bestPair(pairs, address, dsChain) {
  let best = null;
  for (const p of Array.isArray(pairs) ? pairs : []) {
    if (String(p?.chainId ?? "") !== dsChain) continue;
    const b = String(p?.baseToken?.address ?? "").toLowerCase();
    const q = String(p?.quoteToken?.address ?? "").toLowerCase();
    if (b !== address && q !== address) continue;
    const liq = num(p?.liquidity?.usd) ?? 0;
    if (!best || liq > best.liq) best = { pool: String(p?.pairAddress ?? "").toLowerCase() || null, dex: p?.dexId ?? null, liq };
  }
  return best;
}

/** Every 4th point of CoinGecko's 7-day hourly prices (about 42), rounded to 6 significant digits. */
export function spark(prices) {
  if (!Array.isArray(prices)) return null;
  const pts = prices.filter((v) => Number.isFinite(Number(v)) && Number(v) > 0).map(Number);
  if (pts.length < 8) return null;
  const out = pts.filter((_, i) => i % 4 === 0);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out.map((v) => Number(v.toPrecision(6)));
}

/** A CoinGecko market row → the price columns. */
export function priceCols(m) {
  return {
    rank: num(m?.market_cap_rank),
    price_usd: num(m?.current_price),
    mcap_usd: num(m?.market_cap),
    vol_24h: num(m?.total_volume),
    change_24h: num(m?.price_change_percentage_24h_in_currency ?? m?.price_change_percentage_24h),
    change_7d: num(m?.price_change_percentage_7d_in_currency),
    spark: spark(m?.sparkline_in_7d?.price),
  };
}

/**
 * The day's list: CoinGecko market rows (rank order) + platforms by id → up to `n` rows.
 * `liquidity(network, addresses)` answers Map(address → {pool, dex, liq}). Exported for tests.
 */
export async function pick(markets, platformsById, liquidity, n = 300) {
  const want = [];
  for (const m of markets) {
    if (!m?.id || isStable(m) || isCopy(m)) continue;
    const cands = candidates(m.id, platformsById.get(m.id), m.symbol);
    if (cands.length) want.push({ m, cands });
  }
  // DEX liquidity of every candidate, 30 addresses per call per chain
  const liq = new Map(); // `${network}:${address}` -> {pool, dex, liq}
  for (const net of NETS) {
    const addrs = [...new Set(want.flatMap((w) => w.cands.filter((c) => c.network === net.id).map((c) => c.address)))];
    // 10 at a time: popular tokens have many pools, and one answer only holds so many
    for (let i = 0; i < addrs.length; i += 10) {
      const got = await liquidity(net, addrs.slice(i, i + 10));
      for (const [a, v] of got) liq.set(`${net.id}:${a}`, v);
    }
  }
  const rows = [];
  for (const { m, cands } of want) {
    if (rows.length >= n) break;
    let chosen = null;
    for (const c of cands) {
      const net = NETS.find((x) => x.id === c.network);
      const l = liq.get(`${c.network}:${c.address}`);
      if (l && l.liq >= net.minLiq) {
        chosen = { ...c, ...l };
        break;
      }
    }
    if (!chosen) continue;
    const img = typeof m.image === "string" && m.image.startsWith("https://") ? m.image : null;
    rows.push({
      cg_id: String(m.id).slice(0, 100),
      name: String(m.name ?? m.symbol ?? "").slice(0, 80),
      symbol: String(m.symbol ?? "").toUpperCase().slice(0, 24),
      image: img,
      network: chosen.network,
      address: chosen.address,
      via: chosen.via,
      pool: chosen.pool,
      dex: chosen.dex,
      liq_usd: chosen.liq,
      ...priceCols(m),
      ref_price: num(m?.current_price),
      ref_mcap: num(m?.market_cap),
      ref_change: num(m?.price_change_percentage_24h_in_currency ?? m?.price_change_percentage_24h),
    });
  }
  return rows;
}

// ------------------------------------------------------------------ calls

async function cg(path, log) {
  const key = process.env.COINGECKO_KEY;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${CG}${path}`, {
      headers: { accept: "application/json", ...(key ? { "x-cg-demo-api-key": key } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (r.status === 429) {
      log(`market: CoinGecko busy, waiting a minute`);
      await sleep(65_000);
      continue;
    }
    if (!r.ok) throw new Error(`CoinGecko ${r.status} for ${path.split("?")[0]}`);
    return r.json();
  }
  throw new Error("CoinGecko kept saying busy");
}

async function dsLiquidity(net, addrs) {
  const r = await fetch(`${DS}/tokens/v1/${net.ds}/${addrs.join(",")}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`DexScreener ${r.status}`);
  const pairs = await r.json();
  const out = new Map();
  for (const a of addrs) {
    const b = bestPair(pairs, a, net.ds);
    if (b) out.set(a, b);
  }
  await sleep(1200); // DexScreener: 60 calls a minute
  return out;
}

const MARKET_Q = "vs_currency=usd&sparkline=true&price_change_percentage=24h,7d";

export async function pickToday(pool, log, n) {
  const markets = [];
  for (const page of [1, 2]) {
    markets.push(...(await cg(`/coins/markets?${MARKET_Q}&order=market_cap_desc&per_page=250&page=${page}`, log)));
    await sleep(3000);
  }
  const list = await cg(`/coins/list?include_platform=true`, log);
  const platforms = new Map((Array.isArray(list) ? list : []).map((c) => [c.id, c.platforms || {}]));
  const rows = await pick(markets, platforms, (net, addrs) => dsLiquidity(net, addrs).catch(() => new Map()), n);
  if (rows.length < Math.min(50, n)) throw new Error(`only ${rows.length} coins picked, keeping yesterday's list`);
  const cols = ["cg_id", "rank", "name", "symbol", "image", "network", "address", "via", "pool", "dex", "liq_usd", "price_usd", "mcap_usd", "vol_24h", "change_24h", "change_7d", "spark", "ref_price", "ref_mcap", "ref_change"];
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const r of rows) {
      const vals = cols.map((c) => (c === "spark" ? (r.spark ? JSON.stringify(r.spark) : null) : r[c]));
      await client.query(
        `insert into top_coins (${cols.join(",")}, listed, picked_at, updated_at)
         values (${cols.map((_, i) => `$${i + 1}`).join(",")}, true, now(), now())
         on conflict (cg_id) do update set ${cols.filter((c) => c !== "cg_id").map((c) => `${c} = excluded.${c}`).join(", ")},
           listed = true, picked_at = now(), updated_at = now()`,
        vals
      );
    }
    await client.query("update top_coins set listed = false where listed and not (cg_id = any($1))", [rows.map((r) => r.cg_id)]);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return rows.length;
}

export async function refreshPrices(pool, log) {
  const { rows } = await pool.query("select cg_id from top_coins where listed order by rank nulls last");
  const ids = rows.map((r) => r.cg_id);
  let n = 0;
  for (let i = 0; i < ids.length; i += 150) {
    const part = ids.slice(i, i + 150);
    const markets = await cg(`/coins/markets?${MARKET_Q}&ids=${encodeURIComponent(part.join(","))}&per_page=250&page=1`, log);
    for (const m of Array.isArray(markets) ? markets : []) {
      const p = priceCols(m);
      if (p.price_usd === null) continue;
      await pool.query(
        `update top_coins set rank = coalesce($2, rank), price_usd = $3, mcap_usd = $4, vol_24h = $5, change_24h = $6, change_7d = $7,
           spark = coalesce($8::jsonb, spark), ref_price = $3, ref_mcap = $4, ref_change = $6, updated_at = now() where cg_id = $1`,
        [m.id, p.rank, p.price_usd, p.mcap_usd, p.vol_24h, p.change_24h, p.change_7d, p.spark ? JSON.stringify(p.spark) : null]
      );
      n++;
    }
    await sleep(3000);
  }
  return n;
}

/**
 * The coin's dollar price from a DexScreener pair it trades in (either side of the pair), or
 * null. DexScreener's priceUsd is the pair's first token; the other side is priceUsd / priceNative.
 */
export function pairPrice(p, address) {
  const usd = num(p?.priceUsd);
  if (!usd || usd <= 0) return null;
  if (String(p?.baseToken?.address ?? "").toLowerCase() === address) return usd;
  const nat = num(p?.priceNative);
  if (String(p?.quoteToken?.address ?? "").toLowerCase() === address && nat && nat > 0) return usd / nat;
  return null;
}

/**
 * Minute prices from the coins' own pools. A pool price far (over 15%) from CoinGecko's is not
 * trusted (a thin or broken pool): that coin keeps CoinGecko's number until the next check.
 * Market cap and 24h change follow the price: cap × (price / CoinGecko price); the change is
 * against CoinGecko's price of 24 hours ago. Exported for tests.
 */
export function livePatch(row, price) {
  const ref = num(row.ref_price);
  if (!price || !ref || ref <= 0 || Math.abs(price / ref - 1) > 0.15) return null;
  const mcap = num(row.ref_mcap);
  const ch = num(row.ref_change);
  const dayAgo = ch !== null && ch > -100 ? ref / (1 + ch / 100) : null;
  return {
    price_usd: Number(price.toPrecision(8)),
    mcap_usd: mcap !== null ? Math.round(mcap * (price / ref)) : null,
    change_24h: dayAgo ? Number(((price / dayAgo - 1) * 100).toFixed(4)) : ch,
  };
}

export async function livePrices(pool) {
  const { rows } = await pool.query("select cg_id, network, address, pool, ref_price, ref_mcap, ref_change from top_coins where listed and pool is not null");
  let n = 0;
  for (const net of NETS) {
    const mine = rows.filter((r) => r.network === net.id && /^0x[0-9a-f]{40}$/.test(r.pool));
    for (let i = 0; i < mine.length; i += 30) {
      const part = mine.slice(i, i + 30);
      const r = await fetch(`${DS}/latest/dex/pairs/${net.ds}/${part.map((x) => x.pool).join(",")}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`DexScreener ${r.status}`);
      const j = await r.json();
      const pairs = Array.isArray(j?.pairs) ? j.pairs : Array.isArray(j) ? j : [];
      const byPool = new Map(pairs.map((p) => [String(p?.pairAddress ?? "").toLowerCase(), p]));
      for (const row of part) {
        const p = byPool.get(row.pool);
        const patch = p ? livePatch(row, pairPrice(p, row.address)) : null;
        if (!patch) continue;
        await pool.query("update top_coins set price_usd = $2, mcap_usd = coalesce($3, mcap_usd), change_24h = $4, updated_at = now() where cg_id = $1", [
          row.cg_id,
          patch.price_usd,
          patch.mcap_usd,
          patch.change_24h,
        ]);
        n++;
      }
      await sleep(300);
    }
  }
  return n;
}

export async function topLoop(pool, log) {
  if (process.env.TOP_OFF === "1") return;
  const n = Number(process.env.TOP_COINS ?? "300");
  // 15 minutes: 2 CoinGecko calls each, about 6,000 a month (the free demo key allows 10,000)
  const every = Number(process.env.TOP_EVERY_MS ?? "900000");
  let lastPick = 0;
  let lastPrices = 0;
  try {
    const r = await pool.query("select max(picked_at) as t, max(updated_at) as u from top_coins where listed");
    if (r.rows[0]?.t) lastPick = new Date(r.rows[0].t).getTime();
    if (r.rows[0]?.u) lastPrices = new Date(r.rows[0].u).getTime();
  } catch (e) {
    log(`market: ${e.message} (run indexer/topcoins.sql)`);
    return;
  }
  let liveFailedAt = 0;
  for (;;) {
    const started = Date.now();
    try {
      if (Date.now() - lastPick > 24 * 3600e3) {
        const k = await pickToday(pool, log, n);
        lastPick = Date.now();
        lastPrices = Date.now();
        log(`market: picked ${k} coins`);
      } else if (Date.now() - lastPrices > every - 30_000) {
        // (a restart doesn't spend calls on numbers that are still fresh)
        await refreshPrices(pool, log);
        lastPrices = Date.now();
      }
    } catch (e) {
      log(`market: ${e.message}`);
      if (Date.now() - lastPick > 24 * 3600e3) lastPick = Date.now() - 23 * 3600e3; // try the daily pick again in an hour
    }
    try {
      await livePrices(pool);
    } catch (e) {
      if (Date.now() - liveFailedAt > 3600e3) log(`market: minute prices ${e.message}`);
      liveFailedAt = Date.now();
    }
    await sleep(Math.max(15_000, LIVE_MS - (Date.now() - started)));
  }
}
