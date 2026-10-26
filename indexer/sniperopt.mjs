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

const EVERY_MS = 3 * 3600_000;
const MIN_COINS = 300;
const TRIES = 300_000;
const CLIMB_ROUNDS = 10_000;
const MIN_TRAIN = 25;
const MIN_VAL = 8;

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
  minNetSol: [0, 1, 2, 3, 5, 8],
  minRatio: [0, 1.5, 2, 3, 5],
  minMult: [0.9, 1, 1.2, 1.5, 2, 3],
  maxMult: [1.5, 2, 2.5, 3, 5, 8, 99],
  // the last minute before the entry
  minNewBuyers60: [0, 5, 10, 20, 40],
  minNetSol60: [-99, 0, 1, 3, 5, 10],
  minRatio60: [0, 1, 1.5, 2, 3],
};
const KEYS = Object.keys(SPACE);

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
  for (const i of idx) {
    if (!passes(T, i, p)) continue;
    const em = T.em[i];
    const mo = T.mo[i];
    const r = T.r[i];
    for (let e = 0; e < GRID_ENTRIES.length; e++) {
      const m = em[e];
      // the price at that entry must still be in the rule's range (not too late, not falling)
      if (m == null || m < p.minMult || m > p.maxMult) continue;
      // and the minute before it must show buyers still coming
      const q = mo[e];
      if (!q || q[0] < p.minNewBuyers60 || q[1] < p.minNetSol60 || q[2] < p.minRatio60) continue;
      for (let x = 0; x < NX; x++) {
        const k = e * NX + x;
        const v = r[k];
        if (v == null) continue;
        n[k]++;
        sum[k] += v;
        if (v > 0) w[k]++;
      }
    }
  }
  return { n, w, sum };
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
function best(t, min, mode) {
  let k = -1;
  let top = -Infinity;
  for (let j = 0; j < t.n.length; j++) {
    if (t.n[j] < min) continue;
    const a = t.sum[j] / t.n[j];
    const v = mode === "steady" ? (a > 0 ? winLow(t.w[j], t.n[j]) : -Infinity) : a;
    if (v > top) {
      top = v;
      k = j;
    }
  }
  return k < 0 || top === -Infinity ? null : { k, n: t.n[k], wins: t.w[k], avg: t.sum[k] / t.n[k] };
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randomRule = () => Object.fromEntries(KEYS.map((k) => [k, pick(SPACE[k])]));
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

  const results = {};
  let tried = 0;
  for (const mode of ["profit", "steady"]) {
    // score on train — profit: average return, a little lower when it rests on few trades;
    // steady: how surely it wins (and it must make money too)
    const fit = (b) => (!b ? -Infinity : mode === "steady" ? winLow(b.wins, b.n) : b.avg - 0.25 / Math.sqrt(b.n));
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
      if (vn < MIN_VAL) continue;
      const entry = GRID_ENTRIES[Math.floor(k / NX)];
      const exit = GRID_EXITS[k % NX];
      const vAvg = t.sum[k] / vn;
      // steady rules must win at least 60% and make money on the newest coins too
      if (mode === "steady" && (t.w[k] / vn < 0.6 || vAvg <= 0)) continue;
      out.push({
        rule: e.p,
        entry: entryLabel(entry),
        exit: exitLabel(exit),
        train: { n: e.b.n, wins: e.b.wins, avg: +e.b.avg.toFixed(3), perDay: +(e.b.n / trainDays).toFixed(1) },
        val: { n: vn, wins: t.w[k], avg: +vAvg.toFixed(3), perDay: +(vn / valDays).toFixed(1) },
      });
    }
    // a rule losing (or, for steady, winning less) on either part never leads
    if (mode === "steady") out.sort((a, b) => Math.min(winLow(b.val.wins, b.val.n), winLow(b.train.wins, b.train.n)) - Math.min(winLow(a.val.wins, a.val.n), winLow(a.train.wins, a.train.n)));
    else out.sort((a, b) => Math.min(b.val.avg, b.train.avg) - Math.min(a.val.avg, a.train.avg));
    results[mode] = out.slice(0, 10);
  }
  return { coins: T.n, train: train.length, val: val.length, tried, top: results.profit, steady: results.steady };
}

// ------------------------------------------------------------------ running it

if (!isMainThread && workerData?.sniperOpt) {
  try {
    parentPort.postMessage({ ok: true, out: optimize(workerData.rows) });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e?.message ?? e) });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function sniperOptLoop(pool, log) {
  if (process.env.SNIPER_OFF === "1" || !process.env.SOLANA_RPC_URL) return;
  await sleep(5 * 60_000); // after the bot's own table is set up
  for (;;) {
    try {
      const rows = (
        await pool.query(
          `select created_at, score, telegram, checks, grid from sniper_signals
           where grid is not null and (grid->>'v')::int = $1 and created_at > now() - interval '7 days' and coalesce(result, '') <> 'restart'`,
          [GRID_VERSION]
        )
      ).rows;
      if (rows.length >= MIN_COINS) {
        const started = Date.now();
        const out = await new Promise((resolve, reject) => {
          const w = new Worker(fileURLToPath(import.meta.url), { workerData: { sniperOpt: true, rows } });
          w.once("message", (m) => (m.ok ? resolve(m.out) : reject(new Error(m.error))));
          w.once("error", reject);
        });
        await pool.query(`insert into sniper_opt (coins, result) values ($1, $2)`, [out.coins, JSON.stringify(out)]);
        await pool.query(`delete from sniper_opt where run_at < now() - interval '14 days'`);
        log(`bot optimizer: ${out.tried} rules on ${out.coins} coins in ${Math.round((Date.now() - started) / 1000)} s, ${out.top.length} kept`);
      } else log(`bot optimizer: ${rows.length} coins so far, starts at ${MIN_COINS}`);
    } catch (e) {
      log(`bot optimizer failed: ${e.message}`);
    }
    await sleep(EVERY_MS);
  }
}
