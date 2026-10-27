/**
 * The rule optimizer for proven-coin signals (sniperlate.mjs): which signals to take and how to
 * sell, searched on the older 70% of signals and checked on the newest 30% (as sniperopt.mjs does
 * for brand-new coins). Pure: runs inside sniperopt.mjs's worker thread.
 */
import { CURVE_LEVELS, POOL_LEVELS } from "./sniperlate.mjs";
import { GRID_EXITS, exitLabel } from "./sniper.mjs";
import { winLow } from "./sniperopt.mjs";

const LEVELS = [...CURVE_LEVELS, ...POOL_LEVELS];
export const LATE_SPACE = {
  stage: [0, 1, 2], // 0 any, 1 still on its launch curve, 2 graduated to its pool
  minLevel: LEVELS,
  maxLevel: LEVELS,
  minAge: [0, 10, 30, 60, 180],
  maxAge: [30, 60, 180, 720, 99999],
  minBuyers: [0, 50, 100, 200, 400],
  minBuys5: [0, 10, 30, 60, 100],
  minNewBuyers5: [0, 5, 15, 30, 60],
  minNetSol5: [-99, 0, 2, 5, 10, 20],
  minRatio5: [0, 1, 1.5, 2, 3],
  minMove5: [0, 1, 1.1, 1.3, 1.6],
  maxMove5: [1.5, 2, 3, 99],
  needX: [0, 1, 2],
  minTg: [0, 1, 100, 500],
  devNotSold: [0, 1],
};
const KEYS = Object.keys(LATE_SPACE);
const OPEN = {
  stage: 0, minLevel: LEVELS[0], maxLevel: LEVELS[LEVELS.length - 1], minAge: 0, maxAge: 99999, minBuyers: 0, minBuys5: 0,
  minNewBuyers5: 0, minNetSol5: -99, minRatio5: 0, minMove5: 0, maxMove5: 99, needX: 0, minTg: 0, devNotSold: 0,
};
const NX = GRID_EXITS.length;
const MIN_TRAIN = 20;
const MIN_VAL = 8;

function passes(f, level, p) {
  if (p.stage === 1 && f.stage !== "curve") return false;
  if (p.stage === 2 && f.stage !== "pool") return false;
  if (level < p.minLevel || level > p.maxLevel) return false;
  if (p.minAge > 0 && (f.ageMin == null || f.ageMin < p.minAge)) return false;
  if (f.ageMin != null && f.ageMin > p.maxAge) return false;
  if ((f.buyers ?? 0) < p.minBuyers) return false;
  if ((f.buys5 ?? 0) < p.minBuys5) return false;
  if ((f.newBuyers5 ?? 0) < p.minNewBuyers5) return false;
  if ((f.netSol5 ?? 0) < p.minNetSol5) return false;
  if ((f.ratio5 ?? 0) < p.minRatio5) return false;
  if ((f.move5 ?? 1) < p.minMove5 || (f.move5 ?? 1) > p.maxMove5) return false;
  const xk = f.x === "profile" ? 2 : f.x ? 1 : 0;
  if (xk < p.needX) return false;
  if ((f.tg ?? 0) < p.minTg) return false;
  if (p.devNotSold && f.devSold !== false) return false; // unknown counts as not proven
  return true;
}

function tally(rows, idx, p) {
  const n = new Int32Array(NX);
  const w = new Int32Array(NX);
  const sum = new Float64Array(NX);
  for (const i of idx) {
    const row = rows[i];
    if (!passes(row.features, row.level, p)) continue;
    const r = row.grid.r;
    for (let x = 0; x < NX; x++) {
      const v = r[x];
      if (v == null) continue;
      n[x]++;
      sum[x] += v;
      if (v > 0) w[x]++;
    }
  }
  return { n, w, sum };
}

function best(t, min, mode) {
  let k = -1;
  let top = -Infinity;
  for (let j = 0; j < NX; j++) {
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
const randomRule = () => {
  let p;
  if (Math.random() < 0.15) p = Object.fromEntries(KEYS.map((k) => [k, pick(LATE_SPACE[k])]));
  else {
    // a few filters on top of "everything open"
    p = { ...OPEN };
    const n = 1 + Math.floor(Math.random() * 5);
    for (let i = 0; i < n; i++) {
      const k = pick(KEYS);
      p[k] = pick(LATE_SPACE[k]);
    }
  }
  if (p.maxLevel < p.minLevel) [p.minLevel, p.maxLevel] = [p.maxLevel, p.minLevel];
  return p;
};
function nudge(p) {
  const q = { ...p };
  const k = pick(KEYS);
  const list = LATE_SPACE[k];
  const i = list.indexOf(q[k]);
  q[k] = list[Math.max(0, Math.min(list.length - 1, i + (Math.random() < 0.5 ? -1 : 1)))];
  if (q.maxLevel < q.minLevel) [q.minLevel, q.maxLevel] = [q.maxLevel, q.minLevel];
  return q;
}
const ruleKey = (p) => KEYS.map((k) => p[k]).join(",");

export function optimizeLate(rows, tries = 200_000, rounds = 8000) {
  const order = rows.map((_, i) => i).sort((a, b) => Date.parse(rows[a].at) - Date.parse(rows[b].at));
  const cut = Math.floor(rows.length * 0.7);
  const train = order.slice(0, cut);
  const val = order.slice(cut);
  const days = (ids) => (ids.length > 1 ? Math.max(1 / 24, (Date.parse(rows[ids[ids.length - 1]].at) - Date.parse(rows[ids[0]].at)) / 86400_000) : 1);
  const trainDays = days(train);
  const valDays = days(val);
  const out = {};
  let tried = 0;
  for (const mode of ["profit", "steady"]) {
    const fit = (b) => (!b ? -Infinity : mode === "steady" ? winLow(b.wins, b.n) : b.avg - 0.25 / Math.sqrt(b.n));
    const seen = new Map();
    const evalRule = (p) => {
      const key = ruleKey(p);
      if (seen.has(key)) return seen.get(key);
      const b = best(tally(rows, train, p), MIN_TRAIN, mode);
      const e = { p, b, fit: fit(b) };
      seen.set(key, e);
      return e;
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
    const list = [];
    for (const e of pool) {
      const t = tally(rows, val, e.p);
      const k = e.b.k;
      const vn = t.n[k];
      if (vn < MIN_VAL) continue;
      const vAvg = t.sum[k] / vn;
      if (mode === "steady" && (t.w[k] / vn < 0.6 || vAvg <= 0)) continue;
      list.push({
        rule: e.p,
        exit: exitLabel(GRID_EXITS[k]),
        train: { n: e.b.n, wins: e.b.wins, avg: +e.b.avg.toFixed(3), perDay: +(e.b.n / trainDays).toFixed(1) },
        val: { n: vn, wins: t.w[k], avg: +vAvg.toFixed(3), perDay: +(vn / valDays).toFixed(1) },
      });
    }
    if (mode === "steady") list.sort((a, b) => Math.min(winLow(b.val.wins, b.val.n), winLow(b.train.wins, b.train.n)) - Math.min(winLow(a.val.wins, a.val.n), winLow(a.train.wins, a.train.n)));
    else list.sort((a, b) => Math.min(b.val.avg, b.train.avg) - Math.min(a.val.avg, a.train.avg));
    out[mode] = list.slice(0, 10);
  }
  return { signals: rows.length, train: train.length, val: val.length, tried, top: out.profit, steady: out.steady };
}
