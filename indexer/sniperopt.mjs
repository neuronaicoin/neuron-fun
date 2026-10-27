/**
 * sasa Bot rule optimizer (test mode, admins): searches tens of thousands of filter + trading rule
 * combinations on the coins the bot followed (sniper.mjs) and keeps the ones that make money on
 * coins they were NOT tuned on.
 *
 *   data      every followed coin of the last 7 days: what was known at the decision (checks) and
 *             its return under every entry time × exit rule (the grid, worked out when its hour ended)
 *   split     older 70% to search on (train), newest 30% only to check the winners (validation):
 *             a rule that only fits the past fails here, so it can't be picked by luck
 *   search    random rules, then small changes around the best ones (hill climbing); each rule is
 *             a set of filters plus the best entry/exit for those coins on the train part
 *   result    the 10 best on validation (needing enough trades on both parts), saved in sniper_opt
 *             and shown on /admin/bot/
 *
 * Runs in its own thread (never slows the live feed) every 3 hours once there's enough data.
 */
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { GRID_ENTRIES, GRID_EXITS, GRID_VERSION, entryLabel, exitLabel } from "./sniper.mjs";
import { LATE_VERSION } from "./sniperlate.mjs";
import { optimizeLate } from "./sniperoptlate.mjs";

const EVERY_MS = 3 * 3600_000;
const MIN_COINS = 300;
const MIN_LATE = 150; // proven-coin signals needed before their search runs
const TRIES = 300_000;
const CLIMB_ROUNDS = 10_000;
const MIN_TRAIN = 25;
const MIN_VAL = 8;
/** Profit rules need this many trades on the newest coins (8 lets one lucky coin carry a rule). */
const MIN_VAL_PROFIT = 20;
/** Share of the balance put into each trade when a rule's daily return is worked out (10%). */
const STAKE = 0.1;
/** A rule is ready for real money only at 10%+ a day, net, on coins it was not tuned on. */
export const DAILY_TARGET = 0.1;
/** At 10% a trade only ~10 can be open at once: count at most this many trades a day. */
const MAX_PER_DAY = 50;
const dailyOf = (robustAvg, n, days) => STAKE * robustAvg * Math.min(n / Math.max(days, 1e-9), MAX_PER_DAY);

// what a rule can ask of a coin (value lists the search picks from)
export const SPACE = {
  minScore: [0, 35, 50, 65, 80],
  needX: [0, 1, 2], // 0 any, 1 some X link, 2 the coin's own X account
  minXFollowers: [0, 20, 100, 500],
  minTg: [0, 1, 100, 500, 1000], // 1 = has a Telegram
  needSite: [0, 1], // a live website of its own
  minDomainDays: [0, 7, 30],
  allowReused: [0, 1],
  allowSamePost: [0, 1],
  maxDevPct: [3, 5, 10, 20, 100],
  allowDevSold: [0, 1],
  maxDevLaunches: [1, 2, 3, 99],
  allowRugger: [0, 1],
  maxBundle: [5, 10, 20, 30, 100],
  maxTop10: [20, 30, 40, 60, 100],
  minBuyers: [0, 5, 10, 15, 20, 30],
  minNetSol: [-99, 0, 1, 2, 3, 5, 8],
  minRatio: [0, 1.5, 2, 3, 5],
  minMult: [0, 0.9, 1, 1.2, 1.5, 2, 3],
  maxMult: [1.5, 2, 2.5, 3, 5, 8, 99],
  // the last minute before the entry
  minNewBuyers60: [0, 5, 10, 20, 40],
  minNetSol60: [-99, 0, 1, 3, 5, 10],
  minRatio60: [0, 1, 1.5, 2, 3],
  // smart wallets among the coin's first buyers before the entry (wallets that keep getting in
  // early on coins that run 3×+; learned from the search part only)
  minSmart: [0, 1, 2, 3, 5],
};
const KEYS = Object.keys(SPACE);
/** Every filter switched off (lets every coin through): a rule starts here and turns on a few. */
export const OPEN = {
  minScore: 0, needX: 0, minXFollowers: 0, minTg: 0, needSite: 0, minDomainDays: 0, allowReused: 1, allowSamePost: 1,
  maxDevPct: 100, allowDevSold: 1, maxDevLaunches: 99, allowRugger: 1, maxBundle: 100, maxTop10: 100, minBuyers: 0,
  minNetSol: -99, minRatio: 0, minMult: 0, maxMult: 99, minNewBuyers60: 0, minNetSol60: -99, minRatio60: 0, minSmart: 0,
};

/** Columns of numbers (fast to scan) from the coins' rows. */
function table(rows) {
  const n = rows.length;
  const f = (k) => new Float64Array(n);
  const T = {
    n,
    score: f(),
    xKind: f(),
    xF: f(),
    tg: f(),
    site: f(),
    domain: f(),
    reused: f(),
    samePost: f(),
    devPct: f(),
    devSold: f(),
    devLaunches: f(),
    rugger: f(),
    bundle: f(),
    top10: f(),
    buyers: f(),
    netSol: f(),
    ratio: f(),
    em: [], // per coin: price multiple at each entry point
    mo: [], // per coin: [new buyers, net SOL, buys per sell] in the minute before each entry point
    r: [], // per coin: grid returns
    t: new Float64Array(n),
  };
  rows.forEach((row, i) => {
    const c = row.checks || {};
    T.score[i] = row.score ?? 0;
    T.xKind[i] = c.x === "profile" ? 2 : c.x ? 1 : 0;
    T.xF[i] = c.xFollowers ?? -1; // -1: not looked up
    T.tg[i] = c.tg != null ? Math.max(1, c.tg) : row.telegram ? 1 : 0;
    T.site[i] = c.siteOwn && c.site ? 1 : 0;
    T.domain[i] = c.domainDays ?? -1;
    T.reused[i] = c.reused ? 1 : 0;
    T.samePost[i] = c.samePost ? 1 : 0;
    T.devPct[i] = c.devPct ?? 0;
    T.devSold[i] = c.devSold ? 1 : 0;
    T.devLaunches[i] = c.devLaunches ?? 1;
    T.rugger[i] = c.devRugs ? 1 : 0;
    T.bundle[i] = c.bundlePct ?? 0;
    T.top10[i] = c.top10 ?? 0;
    T.buyers[i] = c.buyers ?? 0;
    T.netSol[i] = c.netSol ?? 0;
    T.ratio[i] = c.ratio ?? (c.sells ? (c.buys ?? 0) / c.sells : c.buys ?? 0);
    T.em.push(row.grid.em);
    T.mo.push(row.grid.mo);
    T.r.push(row.grid.r);
    T.t[i] = Date.parse(row.created_at);
  });
  return T;
}

export const SMART_MIN_COINS = 3; // a wallet needs this many early buys on the search part…
export const SMART_MIN_RATE = 0.4; // …and this share of them running 3×+ to count as smart
const RUNNER = 3;

/**
 * Smart wallets, learned only from the search part (train): wallets among coins' first 40 buyers
 * whose coins ran 3×+ from launch often. Fills T.smart[i][entry] = smart wallets that had bought
 * coin i before that entry point. On the search part a coin's own result never counts for its
 * own buyers (left out), so the search can't learn from the answer.
 */
function learnSmart(rows, T, train, val) {
  const stat = new Map(); // wallet → [coins, runners]
  const runner = (i) => (rows[i].start_mc > 0 && rows[i].peak_mc >= rows[i].start_mc * RUNNER ? 1 : 0);
  for (const i of train) {
    const run = runner(i);
    const seenHere = new Set();
    for (const [w] of rows[i].buyers ?? []) {
      if (seenHere.has(w)) continue;
      seenHere.add(w);
      const s = stat.get(w) ?? [0, 0];
      s[0]++;
      s[1] += run;
      stat.set(w, s);
    }
  }
  let smartWallets = 0;
  for (const [, [n, r]] of stat) if (n >= SMART_MIN_COINS && r / n >= SMART_MIN_RATE) smartWallets++;
  const isTrain = new Uint8Array(T.n);
  for (const i of train) isTrain[i] = 1;
  T.smart = rows.map((row, i) => {
    const run = runner(i);
    const idx = row.checks?.idx ?? 3;
    // the 5-second step each entry point buys at (a market-cap entry: only what was known at the decision)
    const steps = GRID_ENTRIES.map((e) => (e.mc ? idx : Math.max(idx, Math.floor((e.at * 1000) / 5000))));
    const counts = new Array(GRID_ENTRIES.length).fill(0);
    const seenHere = new Set();
    for (const [w, st] of row.buyers ?? []) {
      if (seenHere.has(w)) continue;
      seenHere.add(w);
      const s = stat.get(w);
      if (!s) continue;
      let [n, r] = s;
      if (isTrain[i]) {
        n -= 1;
        r -= run;
      }
      if (n < SMART_MIN_COINS || r / n < SMART_MIN_RATE) continue;
      for (let e = 0; e < steps.length; e++) if (st <= steps[e]) counts[e]++;
    }
    return counts;
  });
  return smartWallets;
}

/** Does coin i pass the rule's filters (everything known at the decision)? */
function passes(T, i, p) {
  if (T.score[i] < p.minScore) return false;
  if (T.xKind[i] < p.needX) return false;
  if (p.minXFollowers > 0 && T.xF[i] < p.minXFollowers) return false;
  if (T.tg[i] < p.minTg) return false;
  if (p.needSite && !T.site[i]) return false;
  if (p.minDomainDays > 0 && T.domain[i] < p.minDomainDays) return false;
  if (!p.allowReused && T.reused[i]) return false;
  if (!p.allowSamePost && T.samePost[i]) return false;
  if (T.devPct[i] > p.maxDevPct) return false;
  if (!p.allowDevSold && T.devSold[i]) return false;
  if (T.devLaunches[i] > p.maxDevLaunches) return false;
  if (!p.allowRugger && T.rugger[i]) return false;
  if (T.bundle[i] > p.maxBundle) return false;
  if (T.top10[i] > p.maxTop10) return false;
  if (T.buyers[i] < p.minBuyers) return false;
  if (T.netSol[i] < p.minNetSol) return false;
  if (T.ratio[i] < p.minRatio) return false;
  return true;
}

const NX = GRID_EXITS.length;

/** For the coins in `idx` passing the rule: count, wins and total return of every grid cell. */
function tally(T, idx, p) {
  const n = new Int32Array(GRID_ENTRIES.length * NX);
  const w = new Int32Array(n.length);
  const sum = new Float64Array(n.length);
  // each cell's single best trade: a rule must still make money without it (one lucky coin is not an edge)
  const mx = new Float64Array(n.length).fill(-Infinity);
  for (const i of idx) {
    if (!passes(T, i, p)) continue;
    const em = T.em[i];
    const mo = T.mo[i];
    const r = T.r[i];
    // coins followed before the newest exit rules have fewer exits per entry (those count as missing)
    const rowNX = Math.round(r.length / GRID_ENTRIES.length);
    for (let e = 0; e < GRID_ENTRIES.length; e++) {
      const m = em[e];
      // the price at that entry must still be in the rule's range (not too late, not falling)
      if (m == null || m < p.minMult || m > p.maxMult) continue;
      // and the minute before it must show buyers still coming
      const q = mo[e];
      if (!q || q[0] < p.minNewBuyers60 || q[1] < p.minNetSol60 || q[2] < p.minRatio60) continue;
      if (p.minSmart > 0 && T.smart[i][e] < p.minSmart) continue;
      for (let x = 0; x < Math.min(NX, rowNX); x++) {
        const k = e * NX + x;
        const v = r[e * rowNX + x];
        if (v == null) continue;
        n[k]++;
        sum[k] += v;
        if (v > mx[k]) mx[k] = v;
        if (v > 0) w[k]++;
      }
    }
  }
  return { n, w, sum, mx };
}

/** Lower bound of a win rate (Wilson, ~90%): 9 of 10 counts for less than 90 of 100. */
export const winLow = (w, n) => {
  if (!n) return 0;
  const z = 1.645;
  const p = w / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n);
};

/**
 * The best grid cell of a tally with at least `min` trades: by average return ("profit"), or by
 * how surely it wins among the cells that also make money ("steady").
 */
/** Average per trade without the cell's single best trade. */
const robust = (t, j) => (t.n[j] > 1 ? (t.sum[j] - t.mx[j]) / (t.n[j] - 1) : -Infinity);

function best(t, min, mode) {
  let k = -1;
  let top = -Infinity;
  for (let j = 0; j < t.n.length; j++) {
    if (t.n[j] < min) continue;
    const a = t.sum[j] / t.n[j];
    const v = mode === "steady" ? (a > 0 ? winLow(t.w[j], t.n[j]) : -Infinity) : mode === "daily" ? (robust(t, j) > 0 ? robust(t, j) * t.n[j] : -Infinity) : robust(t, j);
    if (v > top) {
      top = v;
      k = j;
    }
  }
  return k < 0 || top === -Infinity ? null : { k, n: t.n[k], wins: t.w[k], avg: t.sum[k] / t.n[k], robust: robust(t, k) };
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
/**
 * A random rule: most are a few filters on top of "everything open" (a rule with all 23 filters
 * set at random almost never lets enough coins through to judge it); some are fully random.
 */
const randomRule = () => {
  if (Math.random() < 0.15) return Object.fromEntries(KEYS.map((k) => [k, pick(SPACE[k])]));
  const p = { ...OPEN };
  const n = 1 + Math.floor(Math.random() * 5);
  for (let i = 0; i < n; i++) {
    const k = pick(KEYS);
    p[k] = pick(SPACE[k]);
  }
  return p;
};
function nudge(p) {
  const q = { ...p };
  const k = pick(KEYS);
  const list = SPACE[k];
  const i = list.indexOf(q[k]);
  q[k] = list[Math.max(0, Math.min(list.length - 1, i + (Math.random() < 0.5 ? -1 : 1)))];
  return q;
}
const ruleKey = (p) => KEYS.map((k) => p[k]).join(",");

/** The whole search (pure: the test runs it on made-up coins). */
export function optimize(rows, tries = TRIES, rounds = CLIMB_ROUNDS) {
  const T = table(rows);
  const order = [...Array(T.n).keys()].sort((a, b) => T.t[a] - T.t[b]);
  const cut = Math.floor(T.n * 0.7);
  const train = order.slice(0, cut);
  const val = order.slice(cut);
  const days = (ids) => (ids.length > 1 ? Math.max(1 / 24, (T.t[ids[ids.length - 1]] - T.t[ids[0]]) / 86400_000) : 1);
  const trainDays = days(train);
  const valDays = days(val);
  const smartWallets = learnSmart(rows, T, train, val);

  const results = {};
  let tried = 0;
  for (const mode of ["profit", "steady", "daily"]) {
    // score on train — profit: average return, a little lower when it rests on few trades;
    // steady: how surely it wins (and it must make money too)
    const fit = (b) => (!b ? -Infinity : mode === "steady" ? winLow(b.wins, b.n) : mode === "daily" ? dailyOf(b.robust, b.n, trainDays) : b.robust - 0.25 / Math.sqrt(b.n));
    const seen = new Map();
    const evalRule = (p) => {
      const key = ruleKey(p);
      if (seen.has(key)) return seen.get(key);
      const b = best(tally(T, train, p), MIN_TRAIN, mode);
      const out = { p, b, fit: fit(b) };
      seen.set(key, out);
      return out;
    };
    let pool = [];
    for (let i = 0; i < tries; i++) {
      const e = evalRule(randomRule());
      if (e.b) pool.push(e);
    }
    pool.sort((a, b) => b.fit - a.fit);
    pool = pool.slice(0, 40);
    for (let r = 0; r < rounds && pool.length; r++) {
      const base = pool[Math.floor(Math.random() * Math.min(10, pool.length))];
      const e = evalRule(nudge(base.p));
      if (e.b && e.fit > pool[pool.length - 1].fit) {
        pool.push(e);
        pool.sort((a, b) => b.fit - a.fit);
        pool = pool.filter((x, i, arr) => arr.findIndex((y) => ruleKey(y.p) === ruleKey(x.p)) === i).slice(0, 40);
      }
    }
    tried += seen.size;
    // checked on the newest coins, with the entry/exit chosen on train
    const out = [];
    for (const e of pool) {
      const t = tally(T, val, e.p);
      const k = e.b.k;
      const vn = t.n[k];
      if (vn < (mode === "steady" ? MIN_VAL : MIN_VAL_PROFIT)) continue;
      const entry = GRID_ENTRIES[Math.floor(k / NX)];
      const exit = GRID_EXITS[k % NX];
      const vAvg = t.sum[k] / vn;
      const vRobust = vn > 1 ? (t.sum[k] - t.mx[k]) / (vn - 1) : 0;
      // profit rules must make money on the newest coins even without their best trade
      if (mode !== "steady" && vRobust <= 0) continue;
      // steady rules must win at least 60% and make money on the newest coins too
      if (mode === "steady" && (t.w[k] / vn < 0.6 || vAvg <= 0)) continue;
      out.push({
        rule: e.p,
        entry: entryLabel(entry),
        exit: exitLabel(exit),
        train: { n: e.b.n, wins: e.b.wins, avg: +e.b.avg.toFixed(3), robust: +e.b.robust.toFixed(3), perDay: +(e.b.n / trainDays).toFixed(1), daily: +dailyOf(e.b.robust, e.b.n, trainDays).toFixed(4) },
        val: { n: vn, wins: t.w[k], avg: +vAvg.toFixed(3), robust: +vRobust.toFixed(3), perDay: +(vn / valDays).toFixed(1), daily: +dailyOf(vRobust, vn, valDays).toFixed(4) },
      });
    }
    // a rule losing (or, for steady, winning less) on either part never leads
    if (mode === "daily") out.sort((a, b) => Math.min(b.val.daily, b.train.daily) - Math.min(a.val.daily, a.train.daily));
    else if (mode === "steady") out.sort((a, b) => Math.min(winLow(b.val.wins, b.val.n), winLow(b.train.wins, b.train.n)) - Math.min(winLow(a.val.wins, a.val.n), winLow(a.train.wins, a.train.n)));
    else out.sort((a, b) => Math.min(b.val.robust, b.train.robust) - Math.min(a.val.robust, a.train.robust));
    results[mode] = out.slice(0, 10);
  }
  return { coins: T.n, train: train.length, val: val.length, tried, smartWallets, top: results.profit, steady: results.steady, daily: results.daily };
}

// ------------------------------------------------------------------ running it

if (!isMainThread && workerData?.sniperOpt) {
  try {
    const { rows = [], lateRows = [] } = workerData;
    const out = rows.length >= MIN_COINS ? optimize(rows) : { coins: rows.length, train: 0, val: 0, tried: 0, top: [], steady: [] };
    // proven-coin signals (sniperlate.mjs)
    out.late = lateRows.length >= MIN_LATE ? optimizeLate(lateRows) : { signals: lateRows.length, train: 0, val: 0, tried: 0, top: [], steady: [] };
    parentPort.postMessage({ ok: true, out });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e?.message ?? e) });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function sniperOptLoop(pool, log) {
  if (process.env.SNIPER_OFF === "1") return;
  await sleep(5 * 60_000); // after the bot's own table is set up
  for (;;) {
    try {
      const rows = (
        await pool.query(
          `select created_at, score, telegram, checks, grid, buyers, start_mc, peak_mc from sniper_signals
           where grid is not null and (grid->>'v')::int = $1 and created_at > now() - interval '7 days' and coalesce(result, '') <> 'restart'`,
          [GRID_VERSION]
        )
      ).rows;
      const lateRows = (
        await pool
          .query(
            `select at, level, features, grid from sniper_late
             where grid is not null and (grid->>'v')::int = $1 and at > now() - interval '7 days' and coalesce(result, '') <> 'restart'`,
            [LATE_VERSION]
          )
          .catch(() => ({ rows: [] }))
      ).rows;
      if (rows.length >= MIN_COINS || lateRows.length >= MIN_LATE) {
        const started = Date.now();
        const out = await new Promise((resolve, reject) => {
          const w = new Worker(fileURLToPath(import.meta.url), { workerData: { sniperOpt: true, rows, lateRows } });
          w.once("message", (m) => (m.ok ? resolve(m.out) : reject(new Error(m.error))));
          w.once("error", reject);
        });
        await pool.query(`insert into sniper_opt (coins, result) values ($1, $2)`, [out.coins, JSON.stringify(out)]);
        await pool.query(`delete from sniper_opt where run_at < now() - interval '14 days'`);
        log(`bot optimizer: ${out.tried + out.late.tried} rules on ${out.coins} new coins + ${out.late.signals} proven-coin signals in ${Math.round((Date.now() - started) / 1000)} s`);
      } else log(`bot optimizer: ${rows.length} new coins and ${lateRows.length} proven-coin signals so far, starts at ${MIN_COINS} / ${MIN_LATE}`);
    } catch (e) {
      log(`bot optimizer failed: ${e.message}`);
    }
    await sleep(EVERY_MS);
  }
}
