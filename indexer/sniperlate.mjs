/**
 * sasa Bot, test mode — second hunting ground: coins that have already proven themselves.
 *
 * Brand-new coins are a lottery (most die in minutes). This watches every pump.fun coin that's
 * trading, at any age, and writes a signal the first time its market cap crosses a level —
 * $15K, $25K, $40K on its launch curve, $100K, $250K, $500K in its pool after it graduates —
 * with what the last 5 minutes looked like (buyers, new buyers, SOL in, buys per sell, the move).
 * Then it follows the price for 6 hours in 1-minute steps (curve trades, then PumpSwap trades
 * once it graduates) and works out every exit rule from the signal's price. Nothing is bought.
 *
 * The rule optimizer (sniperopt.mjs) searches these signals too and keeps only rules that make
 * money on coins they weren't tuned on.
 *
 * Fed by sniper.mjs (same live feed); this module keeps its own small state per coin.
 */
import { GRID_EXITS, exitFrom } from "./sniper.mjs";

export const LATE_VERSION = 1;
export const CURVE_LEVELS = [15_000, 25_000, 40_000];
export const POOL_LEVELS = [100_000, 250_000, 500_000];
export const LATE_RULES = { followMin: 6 * 60 }; // minutes followed after a signal
const STEP_MS = 60_000;
const WINDOW = 5; // minutes of momentum kept per coin
const IDLE_MS = 30 * 60_000; // a coin with no trade for this long is forgotten (unless followed)
const MAX_BUYERS = 400; // unique buyers remembered per coin (enough to count new ones)

export const LATE_SQL = `create table if not exists sniper_late (
  id          bigserial primary key,
  mint        text not null,
  at          timestamptz not null default now(),
  level       int not null,
  stage       text not null,
  name        text,
  symbol      text,
  mc          double precision,
  features    jsonb,
  peak_mc     double precision,
  low_mc      double precision,
  grid        jsonb,
  path        jsonb,
  result      text,
  done        boolean not null default false,
  unique (mint, level)
);
create index if not exists sniper_late_at on sniper_late (at desc);
alter table sniper_late enable row level security;
revoke all on sniper_late from anon, authenticated;
grant select on sniper_late to service_role;
update sniper_late set done = true, result = coalesce(result, 'restart') where not done;
notify pgrst, 'reload schema';`;

/** The momentum of the last `WINDOW` minutes from a coin's minute buckets. */
function momentum(k, now) {
  const cur = Math.floor(now / STEP_MS);
  let buys = 0;
  let sells = 0;
  let nb = 0;
  let net = 0;
  let firstMc = null;
  for (const m of k.mins) {
    if (cur - m.t >= WINDOW) continue;
    buys += m.b;
    sells += m.s;
    nb += m.nb;
    net += m.ns;
    if (firstMc == null || m.t < firstMc.t) firstMc = m;
  }
  return { buys, sells, nb, net: +net.toFixed(2), ratio: +(sells ? buys / sells : buys).toFixed(2), move: firstMc && firstMc.open ? +(k.mc / firstMc.open).toFixed(3) : 1 };
}

/**
 * Builds the tracker. `hexToB58` turns a key back into an address; `info(mintHex)` gives what the
 * main scanner knows about a coin it saw being created (name, links, creator), or null.
 */
export function makeLate({ pool, log, hexToB58, info }) {
  const coins = new Map(); // mint hex → state
  const pools = new Map(); // PumpSwap pool hex → mint hex (coins that graduated while we watched)
  const follows = new Set(); // signals being followed

  function stateOf(mint, now) {
    let k = coins.get(mint);
    if (!k) {
      k = { mint, firstSeen: now, last: now, mc: 0, mins: [], buyers: new Set(), crossed: new Set(), graduated: false };
      coins.set(mint, k);
    }
    return k;
  }

  function bucket(k, now) {
    const t = Math.floor(now / STEP_MS);
    let m = k.mins[k.mins.length - 1];
    if (!m || m.t !== t) {
      m = { t, b: 0, s: 0, nb: 0, ns: 0, open: k.mc || null };
      k.mins.push(m);
      if (k.mins.length > WINDOW + 1) k.mins.shift();
    }
    return m;
  }

  /** One trade (curve or pool): updates the coin and its followed signals; may start a signal. */
  function onPrice(mint, mc, { buy, sol, user }) {
    const now = Date.now();
    const k = stateOf(mint, now);
    const before = k.mc;
    k.mc = mc;
    k.last = now;
    const m = bucket(k, now);
    if (m.open == null) m.open = before || mc;
    if (buy) {
      m.b++;
      m.ns += sol / 1e9;
      const u = user.slice(-16);
      if (!k.buyers.has(u) && k.buyers.size < MAX_BUYERS) {
        k.buyers.add(u);
        m.nb++;
      }
    } else {
      m.s++;
      m.ns -= sol / 1e9;
    }
    // followed signals of this coin
    if (k.follows) for (const f of k.follows) step(f, mc, now);
    // a level crossed for the first time (from below: a coin first seen above it doesn't count)
    const levels = k.graduated ? POOL_LEVELS : CURVE_LEVELS;
    for (const lv of levels) {
      if (k.crossed.has(lv)) continue;
      if (before && before < lv && mc >= lv) {
        k.crossed.add(lv);
        void signal(k, lv, now);
      } else if (!before && mc >= lv) k.crossed.add(lv); // first seen above it
    }
  }

  function step(f, mc, now) {
    const i = Math.floor((now - f.t0) / STEP_MS);
    if (i < 0 || i >= f.hi.length) return;
    const m = Math.round(mc);
    f.hi[i] = Math.max(f.hi[i] ?? 0, m);
    f.lo[i] = Math.min(f.lo[i] ?? Infinity, m);
    f.cl[i] = m;
    if (m > f.peak) f.peak = m;
    if (m < f.low) f.low = m;
  }

  async function signal(k, level, now) {
    const mo = momentum(k, now);
    const meta = info(k.mint);
    const features = {
      stage: k.graduated ? "pool" : "curve",
      ageMin: meta?.t0 ? Math.round((now - meta.t0) / 60_000) : null,
      seenMin: Math.round((now - k.firstSeen) / 60_000),
      buyers: k.buyers.size,
      buys5: mo.buys,
      sells5: mo.sells,
      newBuyers5: mo.nb,
      netSol5: mo.net,
      ratio5: mo.ratio,
      move5: mo.move,
      x: meta?.x ?? null,
      tg: meta?.tg ?? null,
      site: meta?.site ?? null,
      devSold: meta?.devSold ?? null,
    };
    const steps = Math.ceil((LATE_RULES.followMin * 60_000) / STEP_MS) + 1;
    const f = { mint: k.mint, level, t0: now, entry: k.mc, peak: k.mc, low: k.mc, hi: new Array(steps).fill(null), lo: new Array(steps).fill(null), cl: new Array(steps).fill(null), id: null };
    // followed from this trade on (the save below takes a moment)
    (k.follows ??= []).push(f);
    follows.add(f);
    const drop = () => {
      follows.delete(f);
      k.follows = k.follows.filter((x) => x !== f);
    };
    try {
      const r = await pool.query(
        `insert into sniper_late (mint, level, stage, name, symbol, mc, features) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (mint, level) do nothing returning id`,
        [hexToB58(k.mint), level, features.stage, meta?.name ?? null, meta?.symbol ?? null, f.entry, JSON.stringify(features)]
      );
      if (!r.rows[0]) return drop(); // already signalled (before a restart)
      f.id = r.rows[0].id;
    } catch (e) {
      drop();
      log(`bot test: late signal save failed: ${e.message}`);
    }
  }

  async function finish(f) {
    follows.delete(f);
    const k = coins.get(f.mint);
    if (k?.follows) k.follows = k.follows.filter((x) => x !== f);
    const path = { hi: f.hi, lo: f.lo, cl: f.cl };
    // the exits that watch the creator or the volume need per-trade data this follow doesn't keep
    const r = GRID_EXITS.map((x) => (x.devExit || x.fade ? null : exitFrom(path, 0, f.entry, x)));
    let end = f.hi.length;
    while (end > 0 && f.hi[end - 1] == null) end--;
    if (!f.id) return; // its save never finished
    await pool
      .query(`update sniper_late set peak_mc = $2, low_mc = $3, grid = $4, path = $5, done = true where id = $1`, [
        f.id,
        f.peak,
        f.low,
        JSON.stringify({ v: LATE_VERSION, r }),
        JSON.stringify({ step: STEP_MS / 1000, hi: f.hi.slice(0, end), lo: f.lo.slice(0, end), cl: f.cl.slice(0, end) }),
      ])
      .catch((e) => log(`bot test: late update failed: ${e.message}`));
  }

  return {
    sql: LATE_SQL,
    /** A trade on the launch curve. */
    curveTrade(e, mc) {
      onPrice(e.mint, mc, e);
    },
    /** The coin moved to its PumpSwap pool. */
    migrated(mint, poolHex) {
      pools.set(poolHex, mint);
      const k = coins.get(mint);
      if (k) k.graduated = true;
    },
    /** A trade in a PumpSwap pool: the coin's mint if it's one we follow, else null. */
    poolTrade(e, mcOfPool) {
      const mint = pools.get(e.pool);
      if (!mint) return null;
      const k = coins.get(mint);
      if (k) k.graduated = true;
      onPrice(mint, mcOfPool, e);
      return mint;
    },
    /** Every minute: endings and forgetting quiet coins. */
    tick() {
      const now = Date.now();
      for (const f of [...follows]) if (now - f.t0 >= LATE_RULES.followMin * 60_000) void finish(f);
      for (const [mint, k] of coins) if (now - k.last > IDLE_MS && !k.follows?.length) coins.delete(mint);
    },
    size: () => ({ coins: coins.size, follows: follows.size, pools: pools.size }),
  };
}
