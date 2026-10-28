/**
 * sasa Bot, test mode (admins only, Oct 2026): watches every new pump.fun coin live, scores it
 * the way the auto-trade bot will, and writes down what a bot would have done and how it would
 * have ended — without spending anything. The admin page /admin/bot/ shows the results, so the
 * filters are tuned on real numbers before the bot trades anyone's money.
 *
 * For each new coin:
 *   0–2 s   the coin's links (X, Telegram, website) from its info file; Telegram member count
 *           (public page), website up + domain age, links / picture / ticker reused by other coins
 *   0–15 s  every trade: unique buyers, buys vs sells, SOL in, the creator's buy and sells,
 *           wallets that bought in the launch's own block (bundles / snipers), top 10 wallets
 *   15 s    the decision: hard rules (any one fails the coin) and a score 0–100; coins that are
 *           close get their X account checked (followers, age; paid per lookup, capped per day)
 *   →60 min the outcome from the decision price: peak, lowest, and whether +50% (take profit) or
 *           −20% (stop loss) came first
 *
 * Env (Railway, indexer service):
 *   SNIPER_RPC_URL     the node for the live feed (default: Solana's free public node). Never the
 *                      site's paid/limited node: the feed is every pump.fun trade, and a provider
 *                      that counts each message (Helius) runs out of credits in a day
 *   SNIPER_OFF=1       switches this off
 *   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET   X lookups (same keys as the X bot);
 *                      without them X accounts aren't checked
 *   SNIPER_X_PER_DAY   most X lookups a day (default 300)
 */
import { createRequire } from "node:module";
import { oauthHeader } from "./xbot.mjs";
import { makeLate } from "./sniperlate.mjs";

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"; // PumpSwap: where pump.fun coins trade after they graduate
const WSOL = "So11111111111111111111111111111111111111112";
const SUPPLY_RAW = 1e15; // 1,000,000,000 coins × 10^6

// the decision
export const RULES = {
  decideSec: 15, // seconds after launch
  maxWaitSec: 25, // waits this long at most for the links to be read
  lateMultiple: 2.5, // already this far above the launch price: too late
  devMaxPct: 10, // creator's own buy above this share of the coins: no
  devLaunches24h: 3, // creator launched more than this many coins in 24 h: no
  bundleMaxPct: 25, // other wallets in the launch's own block hold more than this: no
  top10MaxPct: 40, // top 10 wallets (not the creator) hold more than this: no
  minBuyers: 5, // fewer unique buyers than this by the decision: no
  xMinFollowers: 20,
  xLookupFrom: 45, // only coins scoring at least this get their X account checked
  followMin: 60, // minutes the price is followed after the decision
  lateTickSec: 60, // how often the proven-coin signals are checked for their end
};
// the outcome
const TAKE_PROFIT = 1.5;
const STOP_LOSS = 0.8;
const BUCKET_MS = 5000; // the price path is kept in 5-second steps
const FEES = 0.03; // trading fees of a buy and a sale together (pump.fun + sasa)

/**
 * Ways to buy and sell, all tried on the same coins (each coin's price path after the decision):
 * take profit / stop loss pairs, a trailing exit, and later entries. r = return per trade after fees.
 */
export const STRATEGIES = [
  { key: "50/20", tp: 1.5, sl: 0.8 },
  { key: "50/30", tp: 1.5, sl: 0.7 },
  { key: "100/30", tp: 2, sl: 0.7 },
  { key: "200/40", tp: 3, sl: 0.6 },
  { key: "trail", trail: true, sl: 0.7 }, // half sold at 2×, the rest follows the price and sells 30% below its high
  { key: "50/30 @45s", tp: 1.5, sl: 0.7, at: 45 },
  { key: "100/30 @45s", tp: 2, sl: 0.7, at: 45 },
  { key: "50/30 @90s", tp: 1.5, sl: 0.7, at: 90 },
];

/**
 * The optimizer's grid (sniperopt.mjs): every entry point × every exit. Each coin's return under
 * all of them is worked out once when its hour ends and stored as one array (same order).
 * Entry points: at the decision (~15 s), at fixed times, or the first time the coin's market cap
 * crosses a level (it has proven itself) — later entries miss some of the rise but far fewer die.
 */
export const GRID_VERSION = 2;
export const GRID_ENTRIES = [
  { at: 0 },
  { at: 30 },
  { at: 45 },
  { at: 60 },
  { at: 90 },
  { at: 120 },
  { at: 180 },
  { at: 300 },
  { at: 600 },
  { mc: 8000 },
  { mc: 12000 },
  { mc: 20000 },
];
export const entryLabel = (e) => (e.mc ? `when it first crosses $${e.mc / 1000}K` : e.at ? `at ${e.at >= 120 ? `${e.at / 60} min` : `${e.at} s`}` : "at the decision (~15 s)");
export const GRID_EXITS = [
  ...[1.3, 1.5, 2, 3, 5].flatMap((tp) => [0.6, 0.7, 0.8, 0.85].map((sl) => ({ tp, sl }))),
  { trail: true, trailAt: 1.5, gap: 0.25, sl: 0.75 },
  { trail: true, trailAt: 2, gap: 0.3, sl: 0.7 },
  { trail: true, trailAt: 3, gap: 0.35, sl: 0.65 },
  // added Oct 27 (kept at the end: older coins' grids are the first 23 and still count)
  // out at once if the creator sells, or when trading dies down (the last minute's volume 60%
  // under its best minute since the buy)
  ...[
    [2, 0.7],
    [3, 0.6],
    [5, 0.6],
  ].flatMap(([tp, sl]) => [
    { tp, sl, devExit: true },
    { tp, sl, fade: 0.6 },
  ]),
  { trail: true, trailAt: 2, gap: 0.3, sl: 0.7, devExit: true, fade: 0.6 },
];
export const exitLabel = (x) =>
  (x.trail ? `half at ${x.trailAt}×, rest trails ${Math.round(x.gap * 100)}% · stop −${Math.round((1 - x.sl) * 100)}%` : `sell +${Math.round((x.tp - 1) * 100)}% · stop −${Math.round((1 - x.sl) * 100)}%`) +
  (x.devExit ? " · out if the creator sells" : "") +
  (x.fade ? ` · out when volume fades ${Math.round(x.fade * 100)}%` : "");

const FADE_STEPS = 12; // a minute of 5-second steps
const FADE_MIN_SOL = 1; // a quiet coin's tiny volume never counts as fading

/** Does an extra exit fire in step i (the creator sold, or the volume faded)? Keeps its rolling state in `f`. */
function extraExit(path, i, st, f) {
  if (st.devExit && path.ds?.[i]) return true;
  if (st.fade && path.v) {
    f.sum += path.v[i] ?? 0;
    f.win.push(path.v[i] ?? 0);
    if (f.win.length > FADE_STEPS) f.sum -= f.win.shift();
    if (f.win.length === FADE_STEPS) {
      if (f.sum > f.best) f.best = f.sum;
      if (f.best >= FADE_MIN_SOL && f.sum < f.best * (1 - st.fade)) return true;
    }
  }
  return false;
}

/** One exit rule from step `from` on, bought at `entry` (market cap). A step reaching both the target and the stop counts as the stop. */
export function exitFrom(path, from, entry, st) {
  const { hi, lo, cl } = path;
  let last = entry;
  if (st.trail) {
    let half = false;
    let banked = 0;
    let high = entry;
    const f = { sum: 0, win: [], best: 0 };
    for (let i = from; i < hi.length; i++) {
      const extra = extraExit(path, i, st, f);
      if (hi[i] == null) {
        if (extra) return +((half ? banked + (0.5 * last) / entry : last / entry) - 1 - FEES).toFixed(3);
        continue;
      }
      if (!half) {
        if (lo[i] <= entry * st.sl) return +(st.sl - 1 - FEES).toFixed(3);
        if (hi[i] >= entry * (st.trailAt ?? 2)) {
          half = true;
          banked = 0.5 * (st.trailAt ?? 2);
          high = hi[i];
        }
      } else {
        high = Math.max(high, hi[i]);
        const keep = 1 - (st.gap ?? 0.3);
        if (lo[i] <= high * keep) return +(banked + (0.5 * high * keep) / entry - 1 - FEES).toFixed(3);
      }
      last = cl[i] ?? last;
      if (extra) return +((half ? banked + (0.5 * last) / entry : last / entry) - 1 - FEES).toFixed(3);
    }
    return +((half ? banked + (0.5 * last) / entry : last / entry) - 1 - FEES).toFixed(3);
  }
  const f = { sum: 0, win: [], best: 0 };
  for (let i = from; i < hi.length; i++) {
    const extra = extraExit(path, i, st, f);
    if (hi[i] == null) {
      if (extra) return +(last / entry - 1 - FEES).toFixed(3);
      continue;
    }
    if (lo[i] <= entry * st.sl) return +(st.sl - 1 - FEES).toFixed(3);
    if (hi[i] >= entry * st.tp) return +(st.tp - 1 - FEES).toFixed(3);
    last = cl[i] ?? last;
    // sold at the step's last price when the creator sells or the volume fades
    if (extra) return +(last / entry - 1 - FEES).toFixed(3);
  }
  return +(last / entry - 1 - FEES).toFixed(3);
}

const MOMENTUM_STEPS = Math.round(60_000 / BUCKET_MS); // the last minute

/**
 * All grid returns of one coin; for each entry point the price as a multiple of the launch price
 * (em) and the last minute's momentum (mo: [new buyers, net SOL in, buys per sell]).
 */
export function gridOf(path, decideIdx, entryMc, startMc) {
  const r = [];
  const em = [];
  const mo = [];
  const steps = path.hi.length;
  for (const e of GRID_ENTRIES) {
    // where and at what price it buys (null: this entry never happens for this coin)
    let idx = null;
    let price = null;
    let from = null;
    if (e.mc) {
      if (entryMc < e.mc) {
        for (let i = decideIdx; i < steps; i++) {
          if (path.hi[i] != null && path.hi[i] >= e.mc) {
            idx = i;
            price = Math.max(e.mc, path.cl[i] ?? e.mc);
            from = i + 1;
            break;
          }
        }
      }
    } else {
      const atIdx = e.at ? Math.floor((e.at * 1000) / BUCKET_MS) : decideIdx;
      if (atIdx <= decideIdx) {
        idx = decideIdx;
        price = entryMc;
        from = decideIdx; // the decision's step only holds what came after the buy
      } else if (atIdx < steps) {
        idx = atIdx;
        for (let i = atIdx; i >= 0 && price == null; i--) price = path.cl[i] ?? null;
        from = atIdx + 1;
      }
    }
    if (idx == null || !price) {
      em.push(null);
      mo.push(null);
      for (let x = 0; x < GRID_EXITS.length; x++) r.push(null);
      continue;
    }
    em.push(startMc ? +(price / startMc).toFixed(3) : null);
    let nb = 0;
    let ns = 0;
    let b = 0;
    let s = 0;
    for (let i = Math.max(0, idx - MOMENTUM_STEPS + 1); i <= idx; i++) {
      nb += path.nb?.[i] ?? 0;
      ns += path.ns?.[i] ?? 0;
      b += path.b?.[i] ?? 0;
      s += path.s?.[i] ?? 0;
    }
    mo.push([nb, +ns.toFixed(2), +(s ? b / s : b).toFixed(2)]);
    for (const x of GRID_EXITS) r.push(exitFrom(path, from, price, x));
  }
  return { v: GRID_VERSION, r, em, mo };
}

/**
 * One named strategy (the admin page's table) on a price path: from the decision, or a later
 * entry (`at` seconds after launch). Returns r or null.
 */
export function simulate(path, decideIdx, st, entryMc = null) {
  const { cl } = path;
  let start = decideIdx;
  if (st.at) start = Math.max(decideIdx, Math.floor((st.at * 1000) / BUCKET_MS));
  // the price at the entry: the decision's own price, or for a later entry the last trade at or before that step
  let entry = start === decideIdx && entryMc ? entryMc : null;
  for (let i = start; i >= 0 && entry == null; i--) entry = cl[i] ?? null;
  if (!entry) return null;
  // the decision step was restarted at the entry (only trades after it), a later entry's step wasn't
  const from = st.at && start > decideIdx ? start + 1 : start;
  return exitFrom(path, from, entry, st);
}
export const LEVELS = { safe: 80, balanced: 65, aggressive: 50 };

export const SQL = `create table if not exists sniper_signals (
  mint        text primary key,
  created_at  timestamptz not null,
  decided_at  timestamptz,
  name        text,
  symbol      text,
  creator     text,
  x           text,
  telegram    text,
  website     text,
  score       int,
  passed      boolean not null default false,
  fail        text,
  checks      jsonb,
  start_mc    double precision,
  entry_mc    double precision,
  peak_mc     double precision,
  low_mc      double precision,
  peak_sec    int,
  result      text,
  done        boolean not null default false
);
-- each strategy's return on this coin, and its price path (5-second steps) for later study
alter table sniper_signals add column if not exists sims jsonb;
alter table sniper_signals add column if not exists path jsonb;
alter table sniper_signals add column if not exists grid jsonb;
-- the coin's first 40 buyers and the 5-second step they bought in (smart-wallet study)
alter table sniper_signals add column if not exists buyers jsonb;
create index if not exists sniper_signals_grid on sniper_signals (created_at) where grid is not null;
create table if not exists sniper_opt (
  id      bigserial primary key,
  run_at  timestamptz not null default now(),
  coins   int,
  result  jsonb
);
alter table sniper_opt enable row level security;
revoke all on sniper_opt from anon, authenticated;
grant select on sniper_opt to service_role;
create index if not exists sniper_signals_time on sniper_signals (created_at desc);
create index if not exists sniper_signals_score on sniper_signals (score desc, created_at desc);
alter table sniper_signals enable row level security;
revoke all on sniper_signals from anon, authenticated;
create or replace function sniper_stats(p_hours int) returns jsonb language sql stable as $$
  with s as (select * from sniper_signals where created_at > now() - make_interval(hours => greatest(1, least(p_hours, 24 * 14))))
  select jsonb_build_object(
    'coins', (select count(*) from s),
    'decided', (select count(*) from s where entry_mc is not null),
    'with_links', (select count(*) from s where x is not null or telegram is not null or website is not null),
    'levels', (select jsonb_agg(jsonb_build_object(
        'level', l.name, 'min', l.min,
        'picked', (select count(*) from s where passed and score >= l.min),
        'wins', (select count(*) from s where passed and score >= l.min and result = 'win'),
        'losses', (select count(*) from s where passed and score >= l.min and result = 'loss'),
        'open', (select count(*) from s where passed and score >= l.min and (result is null or result = 'open')),
        'hit_25k', (select count(*) from s where passed and score >= l.min and peak_mc >= 25000),
        'avg_peak_x', (select round(avg(peak_mc / nullif(entry_mc, 0))::numeric, 2) from s where passed and score >= l.min and done and coalesce(result, '') <> 'restart'),
        'strategies', (select jsonb_object_agg(k, jsonb_build_object('n', n, 'wins', w, 'avg', a)) from (
            select e.key as k, count(*) as n, sum(case when e.value::float > 0 then 1 else 0 end) as w, round(avg(e.value::float)::numeric, 3) as a
            from s, jsonb_each_text(s.sims) e where s.passed and s.score >= l.min and s.sims is not null and e.value <> 'null' group by e.key) q)
      ) order by l.min desc)
      from (values ('safe', ${LEVELS.safe}), ('balanced', ${LEVELS.balanced}), ('aggressive', ${LEVELS.aggressive})) as l(name, min)),
    'fails', (select jsonb_object_agg(f, n) from (select coalesce(fail, 'low score') as f, count(*) as n from s where entry_mc is not null and not passed group by 1 order by 2 desc limit 12) x)
  );
$$;
revoke all on function sniper_stats(int) from public, anon, authenticated;
grant execute on function sniper_stats(int) to service_role;
grant select on sniper_signals to service_role;
-- Trend Radar (admin bot page): which themes new pump.fun coins are launching on right now and how
-- they do. Words of each coin's name and ticker, grouped into themes; last hour vs the 3 before it;
-- "hot" = 15+ buyers in its first seconds; 2x = a followed coin that doubled from its start.
create or replace function sniper_trends() returns jsonb language sql stable as $$
  with s as (
    select mint, name, symbol, created_at, start_mc, peak_mc, creator,
      (x is not null or telegram is not null or website is not null or passed) as followed,
      coalesce((checks->>'buyers')::int, 0) as buyers
    from sniper_signals where created_at > now() - interval '4 hours'
  ), w as (
    select s.*, lower(m[1]) as word
    from s, regexp_matches(coalesce(s.name, '') || ' ' || coalesce(s.symbol, ''), '([A-Za-z]{2,})', 'g') as m
  ), t as (
    select w.*, case
      when word in ('ai','agent','agents','gpt','agi','bot','bots','robot','neural','llm','claude','grok','openai','chatgpt','aixbt') then 'AI agents'
      when word in ('cat','cats','kitty','kitten','meow','neko','popcat','mew') then 'Cats'
      when word in ('dog','dogs','doge','inu','shib','shiba','puppy','pup','wif','bonk','woof') then 'Dogs'
      when word in ('pepe','frog','frogs','toad','kek') then 'Frogs'
      when word in ('trump','maga','donald','melania','barron','vance','potus') then 'Trump'
      when word in ('elon','musk','tesla','spacex','xai','doge') then 'Elon'
      when word in ('cz','binance','bnb','heyi') then 'CZ / Binance'
      when word in ('penguin','pengu','pudgy') then 'Penguins'
      when word in ('monkey','ape','apes','chimp','punch') then 'Apes'
      else word end as theme
    from w
    where (length(word) >= 3 or word in ('ai','cz'))
      and word not in ('the','and','for','you','your','are','was','not','but','with','this','that','from','all','one','get','just','new',
        'coin','token','tokens','sol','solana','pump','fun','meme','memecoin','official','real','first','ceo','dev','inc','club',
        'its','his','her','our','who','why','what','how','big','lil','mr','mrs','too','now','day','man','guy','boy','girl',
        'com','net','org','xyz','app','www','http','https','life','live','love','world','time','home','best','good','companions')
  ), d as (select distinct on (theme, mint) * from t), g as (
    select theme,
      -- different people, not coins: one creator spamming the same name is one, not 40
      count(distinct creator) filter (where created_at > now() - interval '1 hour') as n1,
      round((count(distinct creator) filter (where created_at <= now() - interval '1 hour'))::numeric / 3, 1) as prev,
      count(*) filter (where created_at > now() - interval '1 hour' and buyers >= 15) as hot1,
      count(*) filter (where followed and start_mc > 0) as tracked,
      count(*) filter (where followed and start_mc > 0 and peak_mc >= 2 * start_mc) as x2,
      round(avg(buyers) filter (where created_at > now() - interval '1 hour'))::int as buyers1
    from d group by theme
  )
  select coalesce(jsonb_agg(to_jsonb(r) order by r.score desc), '[]'::jsonb) from (
    select g.*, (g.n1 + 3 * g.hot1 + 2 * g.x2) as score,
      (select jsonb_agg(c) from (
        select d.name, d.symbol, d.mint, round((d.peak_mc / nullif(d.start_mc, 0))::numeric, 1) as x
        from d where d.theme = g.theme and d.followed and d.start_mc > 0
        order by d.peak_mc / nullif(d.start_mc, 0) desc nulls last limit 3) c) as best
    from g where g.n1 >= 3 order by score desc limit 15
  ) r;
$$;
revoke all on function sniper_trends() from public, anon, authenticated;
grant execute on function sniper_trends() to service_role;
-- Smart wallets (indexer/sniperopt.mjs learns them: wallets among new coins' first buyers whose
-- coins often ran 3x+) and their buys as they happen: the public sasa Bot page (edge/bot-api.js)
create table if not exists smart_wallets (
  wallet     text primary key, -- hex, as the feed sees it
  coins      int not null,
  runners    int not null,
  updated_at timestamptz not null default now()
);
create table if not exists smart_buys (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  wallet  text not null,
  mint    text not null,
  name    text,
  symbol  text,
  sol     double precision,
  usd     double precision,
  mc      double precision,
  coins   int,
  runners int
);
create index if not exists smart_buys_at on smart_buys (at desc);
-- the latest market cap of coins smart wallets bought (a day)
create table if not exists smart_coins (
  mint       text primary key,
  mc         double precision,
  updated_at timestamptz not null default now()
);
alter table smart_wallets enable row level security;
alter table smart_buys enable row level security;
alter table smart_coins enable row level security;
revoke all on smart_wallets, smart_buys, smart_coins from anon, authenticated;
grant all on smart_wallets, smart_buys, smart_coins to service_role;
grant usage on sequence smart_buys_id_seq to service_role;
-- everything the public sasa Bot page shows, in one call (edge/bot-api.js caches it a few seconds)
create or replace function bot_public() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'scanned', (select count(*) from sniper_signals where created_at > now() - interval '24 hours'),
    'traps', (select count(*) from sniper_signals where created_at > now() - interval '24 hours'
      and (fail in ('creator sold', 'creator holds too much', 'serial launcher', 'creator dumped before', 'bundled', 'top 10 hold too much') or fail like 'reused%')),
    'smart', (select count(*) from smart_wallets),
    'scans', (select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb) from (
      select mint, name, symbol, created_at, decided_at, start_mc, entry_mc, score, passed, fail, checks from sniper_signals
      where created_at > now() - interval '30 minutes' and decided_at is not null order by created_at desc limit 16) s),
    'buys', (select coalesce(jsonb_agg(to_jsonb(b) order by b.at desc), '[]'::jsonb) from (
      select b.id, b.at, b.wallet, b.mint, b.name, b.symbol, b.sol, b.usd, b.mc, b.coins, b.runners, c.mc as now_mc
      from smart_buys b left join smart_coins c on c.mint = b.mint order by b.at desc limit 24) b),
    'trends', sniper_trends()
  );
$$;
revoke all on function bot_public() from public, anon, authenticated;
grant execute on function bot_public() to service_role;
notify pgrst, 'reload schema';`;

// ------------------------------------------------------------------ reading pump.fun's events

const CREATE = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const TRADE = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const COMPLETE = Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]);
const MIGRATED = Buffer.from([189, 233, 93, 185, 92, 148, 234, 148]); // CompletePumpAmmMigrationEvent
const AMM_BUY = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
const AMM_SELL = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);
const WSOL_HEX = "069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001";

/** A PumpSwap buy or sale (pool, SOL moved, the pool's reserves after it), or null. */
export function decodeAmm(b64) {
  let b;
  try {
    b = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (b.length < 184) return null;
  const head = b.subarray(0, 8);
  const buy = head.equals(AMM_BUY);
  if (!buy && !head.equals(AMM_SELL)) return null;
  const u = (i) => Number(b.readBigUInt64LE(16 + 8 * i));
  return {
    kind: "amm",
    buy,
    base: u(4), // the pool's coins (raw, 6 decimals)
    quote: u(5), // the pool's SOL (lamports)
    sol: u(6),
    pool: b.subarray(120, 152).toString("hex"),
    user: b.subarray(152, 184).toString("hex"),
  };
}
/** Market cap in dollars of a PumpSwap pool (1,000,000,000 coins). */
export const ammMc = (base, quote, solUsd) => (base > 0 ? (quote / base) * 1e6 * solUsd : 0);

function reader(b, at = 8) {
  let o = at;
  const need = (n) => {
    if (o + n > b.length) throw new Error("short");
  };
  return {
    str() {
      need(4);
      const n = b.readUInt32LE(o);
      o += 4;
      need(n);
      const s = b.toString("utf8", o, o + n);
      o += n;
      return s;
    },
    key() {
      need(32);
      const k = b.subarray(o, o + 32);
      o += 32;
      return k;
    },
    u64() {
      need(8);
      const v = b.readBigUInt64LE(o);
      o += 8;
      return v;
    },
    i64() {
      need(8);
      const v = b.readBigInt64LE(o);
      o += 8;
      return v;
    },
    bool() {
      need(1);
      return b[o++] !== 0;
    },
    left: () => b.length - o,
  };
}

/** One pump.fun event from a "Program data:" log line (null for any other event). Keys stay as bytes (hex) until stored. */
export function decodeEvent(b64) {
  let b;
  try {
    b = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (b.length < 8) return null;
  const head = b.subarray(0, 8);
  try {
    if (head.equals(TRADE)) {
      const r = reader(b);
      const mint = r.key();
      const sol = r.u64();
      const tokens = r.u64();
      const buy = r.bool();
      const user = r.key();
      r.i64();
      const vSol = r.u64();
      const vTok = r.u64();
      return { kind: "trade", mint: mint.toString("hex"), sol: Number(sol), tokens: Number(tokens), buy, user: user.toString("hex"), vSol: Number(vSol), vTok: Number(vTok) };
    }
    if (head.equals(CREATE)) {
      const r = reader(b);
      const name = r.str();
      const symbol = r.str();
      const uri = r.str();
      const mint = r.key();
      r.key(); // bonding curve
      const user = r.key();
      const creator = r.key();
      r.i64();
      const vTok = Number(r.u64());
      const vSol = Number(r.u64());
      r.u64();
      r.u64();
      // newer launches: token program, two flags, then the quote coin (SOL or something else)
      let quote = null;
      if (r.left() >= 32 + 2 + 32) {
        r.key();
        r.bool();
        r.bool();
        quote = r.key();
      }
      return { kind: "create", name, symbol, uri, mint: mint.toString("hex"), user: user.toString("hex"), creator: creator.toString("hex"), vSol, vTok, quote };
    }
    if (head.equals(MIGRATED)) {
      const r = reader(b);
      r.key(); // user
      const mint = r.key();
      r.u64();
      r.u64();
      r.u64();
      r.key(); // bonding curve
      r.i64();
      const pool = r.key();
      const quote = r.left() >= 32 ? r.key().toString("hex") : null;
      return { kind: "migrated", mint: mint.toString("hex"), pool: pool.toString("hex"), quote };
    }
    if (head.equals(COMPLETE)) {
      const r = reader(b);
      r.key(); // user
      const mint = r.key();
      return { kind: "complete", mint: mint.toString("hex") };
    }
  } catch {
    return null;
  }
  return null;
}

// ------------------------------------------------------------------ links

const lower = (s) => String(s || "").trim().toLowerCase();

/** The coin's X link: its own account (profile), a post someone made, or a community. */
export function parseX(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^mobile\./, "").toLowerCase();
  if (host !== "x.com" && host !== "twitter.com") return null;
  const p = u.pathname.split("/").filter(Boolean);
  if (!p.length) return null;
  if (p[0] === "i" && p[1] === "communities" && p[2]) return { kind: "community", id: p[2], key: `xc:${p[2]}` };
  if (p[0] === "i") return null;
  // X's own pages (a search for the ticker, a hashtag…) aren't anyone's account
  if (/^(search|hashtag|home|explore|intent|share|messages|notifications|settings|login|signup|tos|privacy|compose)$/i.test(p[0])) return null;
  const handle = p[0].replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  if (p[1] === "status" && p[2]) return { kind: "post", handle, id: p[2], key: `xp:${p[2]}` };
  return { kind: "profile", handle, key: `xu:${handle.toLowerCase()}` };
}

/** A public Telegram group/channel name (invite links can't be looked up). */
export function parseTelegram(raw) {
  const s = String(raw || "").trim();
  const m = /(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,32})\/?$/i.exec(s.split("?")[0]);
  if (!m || /^(joinchat|addlist|share|s)$/i.test(m[1])) return null;
  return m[1];
}

const THIRD_PARTY = new RegExp(
  "(^|\\.)(" +
    [
      // social and video
      "x.com", "twitter.com", "t.me", "telegram.me", "telegra.ph", "youtube.com", "youtu.be", "tiktok.com", "instagram.com", "facebook.com", "fb.com",
      "threads.net", "bsky.app", "truthsocial.com", "reddit.com", "redd.it", "discord.gg", "discord.com", "twitch.tv", "kick.com", "rumble.com",
      "linkedin.com", "snapchat.com", "pinterest.com", "tumblr.com", "imgur.com", "giphy.com", "knowyourmeme.com", "9gag.com",
      // link pages, blogs, code
      "linktr.ee", "linktree.com", "beacons.ai", "bio.link", "medium.com", "substack.com", "github.com", "gitbook.io", "notion.so", "docs.google.com",
      "google.com", "apple.com", "amazon.com", "spotify.com", "soundcloud.com", "imdb.com", "wikipedia.org", "wikimedia.org", "fandom.com",
      // crypto sites and tools
      "pump.fun", "dexscreener.com", "dextools.io", "birdeye.so", "solscan.io", "gmgn.ai", "coingecko.com", "coinmarketcap.com", "jup.ag", "raydium.io",
      "bonk.fun", "letsbonk.fun", "meteora.ag", "photon-sol.tinyastro.io", "axiom.trade", "coindesk.com", "cointelegraph.com", "decrypt.co", "theblock.co",
      // news
      "cnn.com", "bbc.com", "bbc.co.uk", "nytimes.com", "foxnews.com", "reuters.com", "bloomberg.com", "apnews.com", "theguardian.com", "washingtonpost.com",
      "wsj.com", "forbes.com", "cnbc.com", "nbcnews.com", "abcnews.go.com", "cbsnews.com", "dailymail.co.uk", "nypost.com", "usatoday.com", "politico.com",
      "axios.com", "theverge.com", "techcrunch.com", "businessinsider.com", "yahoo.com", "msn.com", "tmz.com", "espn.com", "skysports.com", "independent.co.uk",
    ]
      .map((d) => d.replace(/\./g, "\\."))
      .join("|") +
    ")$"
);

export function parseWebsite(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (!host.includes(".")) return null;
    // social sites, link pages, news and other big sites (the story a coin is about) aren't a
    // website of the coin's own: many coins pointing at the same article is normal, not a scam
    if (THIRD_PARTY.test(host)) return { url: u.toString(), host, own: false };
    return { url: u.toString(), host, own: true };
  } catch {
    return null;
  }
}

async function getText(url, ms = 4000, max = 300_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; sasa-bot)" } });
    const text = (await r.text()).slice(0, max);
    return { ok: r.ok, status: r.status, text };
  } finally {
    clearTimeout(t);
  }
}

/** Members of a public Telegram group or channel, from its public page (null when unknown). */
export function telegramMembers(html) {
  const m = /tgme_page_extra">\s*([\d\s,.]+)\s*(members|subscribers)/i.exec(html);
  if (!m) return null;
  const n = Number(m[1].replace(/[\s,.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Days since the domain was registered (null when unknown). */
async function domainAgeDays(host) {
  const parts = host.split(".");
  const domain = parts.slice(-2).join(".");
  try {
    const r = await getText(`https://rdap.org/domain/${domain}`, 4000, 200_000);
    if (!r.ok) return null;
    const j = JSON.parse(r.text);
    const ev = (j.events || []).find((e) => e.eventAction === "registration");
    const t = ev ? Date.parse(ev.eventDate) : NaN;
    return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400_000) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ X lookups

const xCache = new Map(); // handle → { followers, ageDays, ok } | null (no such account)
let xDay = "";
let xUsed = 0;

async function xLookup(handle, log) {
  const k = handle.toLowerCase();
  if (xCache.has(k)) return xCache.get(k);
  const keys = { apiKey: process.env.X_API_KEY, apiSecret: process.env.X_API_SECRET, accessToken: process.env.X_ACCESS_TOKEN, accessSecret: process.env.X_ACCESS_SECRET };
  if (!keys.apiKey || !keys.apiSecret || !keys.accessToken || !keys.accessSecret) return undefined;
  const day = new Date().toISOString().slice(0, 10);
  if (day !== xDay) {
    xDay = day;
    xUsed = 0;
  }
  if (xUsed >= Number(process.env.SNIPER_X_PER_DAY || 300)) return undefined;
  xUsed++;
  const url = `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=public_metrics,created_at`;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(url, { headers: { authorization: oauthHeader("GET", url, keys) }, signal: ctl.signal }).finally(() => clearTimeout(t));
    const j = await r.json().catch(() => ({}));
    if (r.status === 429 || r.status >= 500) return undefined;
    if (!r.ok && r.status !== 404) {
      log(`bot test: X lookup ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
      return undefined;
    }
    const u = j.data;
    const out = u
      ? {
          followers: Number(u.public_metrics?.followers_count ?? 0),
          ageDays: u.created_at ? Math.floor((Date.now() - Date.parse(u.created_at)) / 86400_000) : null,
        }
      : null;
    xCache.set(k, out);
    if (xCache.size > 20_000) xCache.delete(xCache.keys().next().value);
    return out;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ the scanner

/** Market cap in dollars from the curve's virtual reserves. */
export const mcOf = (vSol, vTok, solUsd) => (vTok > 0 ? (vSol / 1e9 / (vTok / 1e6)) * 1e9 * solUsd : 0);

/**
 * The decision for one coin (pure: the test runs it on made-up coins). Returns
 * { score, fail, checks } — fail is the first hard rule the coin broke (null when none).
 */
export function judge(c, now, R = RULES) {
  const checks = {};
  let score = 0;
  let fail = null;
  const no = (why) => {
    if (!fail) fail = why;
  };
  const sec = (now - c.t0) / 1000;
  checks.sec = Math.round(sec);

  // links (up to 30)
  const x = c.x;
  checks.x = x ? x.kind : null;
  if (!x && !c.telegram && !c.site) no("no links");
  if (x?.kind === "profile") score += 10;
  else if (x?.kind === "community") score += 6;
  else if (x?.kind === "post") score += 3;
  if (c.telegram) {
    score += 4;
    checks.tg = c.tgMembers;
    if (c.tgMembers != null && c.tgMembers >= 500) score += 6;
    else if (c.tgMembers != null && c.tgMembers >= 100) score += 3;
  }
  if (c.site?.own) {
    checks.site = c.siteUp;
    checks.domainDays = c.domainDays;
    if (c.siteUp) score += 5;
    if (c.domainDays != null && c.domainDays >= 7) score += 5;
    if (c.siteUp === false) score -= 5;
  }
  if (c.reused) no(`reused ${c.reused}`);
  if (c.samePost) {
    checks.samePost = true;
    score -= 10;
  }
  if (c.copyTicker) {
    checks.copyTicker = c.copyTicker;
    score -= 5;
  }

  // creator (up to 20)
  const devPct = (c.devTokens / SUPPLY_RAW) * 100;
  checks.devPct = +devPct.toFixed(1);
  checks.devLaunches = c.devLaunches;
  if (c.devSold) no("creator sold");
  if (devPct > R.devMaxPct) no("creator holds too much");
  else if (devPct <= 5) score += 10;
  else score += 4;
  if (c.devLaunches > R.devLaunches24h) no("serial launcher");
  else if (c.devLaunches <= 1) score += 10;
  else score += 3;
  if (c.devRugs > 0) no("creator dumped before");

  // launch block (up to 15)
  const bundlePct = (c.bundleTokens / SUPPLY_RAW) * 100;
  checks.bundlePct = +bundlePct.toFixed(1);
  if (bundlePct > R.bundleMaxPct) no("bundled");
  else if (bundlePct < 10) score += 15;
  else if (bundlePct < 20) score += 5;

  // holders
  const held = [...c.holders.entries()].filter(([w, v]) => w !== c.creator && v > 0).map(([, v]) => v);
  held.sort((a, b) => b - a);
  const top10 = (held.slice(0, 10).reduce((n, v) => n + v, 0) / SUPPLY_RAW) * 100;
  checks.top10 = +top10.toFixed(1);
  if (top10 > R.top10MaxPct) no("top 10 hold too much");

  // momentum (up to 35)
  const buyers = c.buyers.size;
  checks.buyers = buyers;
  checks.buys = c.buys;
  checks.sells = c.sells;
  const inSol = (c.solIn - c.solOut) / 1e9;
  checks.netSol = +inSol.toFixed(2);
  const mult = c.startMc > 0 ? c.mc / c.startMc : 0;
  checks.mult = +mult.toFixed(2);
  if (buyers < R.minBuyers) no("few buyers");
  if (mult >= R.lateMultiple) no("too late");
  if (mult < 1) no("falling");
  if (buyers >= 20) score += 15;
  else if (buyers >= 10) score += 10;
  else if (buyers >= R.minBuyers) score += 4;
  const ratio = c.sells ? c.buys / c.sells : c.buys;
  if (ratio >= 3) score += 10;
  else if (ratio >= 1.5) score += 5;
  if (inSol >= 3) score += 10;
  else if (inSol >= 1) score += 5;

  // X account (looked up only when the coin is close)
  if (c.xInfo !== undefined) {
    checks.xFollowers = c.xInfo?.followers ?? 0;
    checks.xAgeDays = c.xInfo?.ageDays ?? null;
    if (c.xInfo === null) no("X account missing");
    else {
      if (c.xInfo.followers < R.xMinFollowers) no("X followers < 20");
      else if (c.xInfo.followers >= 500) score += 10;
      else if (c.xInfo.followers >= 100) score += 5;
      if (c.xInfo.ageDays != null && c.xInfo.ageDays < 2) score -= 10;
    }
  }
  // everything the rule optimizer (sniperopt.mjs) may want to filter on, kept even when it didn't decide
  checks.siteOwn = !!c.site?.own;
  if (c.reused) checks.reused = c.reused;
  if (c.devSold) checks.devSold = true;
  if (c.devRugs) checks.devRugs = c.devRugs;
  checks.ratio = +(c.sells ? c.buys / c.sells : c.buys).toFixed(2);
  return { score: Math.max(0, Math.min(100, Math.round(score))), fail, checks };
}

export async function sniperLoop(pool, log) {
  if (process.env.SNIPER_OFF === "1") return log("bot test off (SNIPER_OFF=1)");
  const rpc = process.env.SNIPER_RPC_URL || "https://api.mainnet-beta.solana.com";
  await pool.query(SQL);
  // coins being followed when the indexer stopped can't be followed on (their trades were missed):
  // closed as "restart", left out of the win rate
  await pool.query(`update sniper_signals set done = true, result = coalesce(result, 'restart') where not done`);
  const web3 = require("@solana/web3.js");
  const hexToB58 = (h) => new web3.PublicKey(Buffer.from(h, "hex")).toBase58();
  // what's known about each coin seen launching (24 h): for the proven-coins signals
  const metas = new Map();
  const late = makeLate({ pool, log, hexToB58, info: (m) => metas.get(m) ?? null });
  await pool.query(late.sql);

  let solUsd = 0;
  const price = async () => {
    try {
      const r = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot");
      const v = Number((await r.json())?.data?.amount);
      if (v > 0) solUsd = v;
    } catch {}
  };
  await price();
  setInterval(price, 60_000).unref();

  // ---- smart wallets (sniperopt.mjs learns them): their buys go on the public sasa Bot page
  let smart = new Map(); // wallet hex → [coins, runners]
  const loadSmart = async () => {
    try {
      const r = await pool.query("select wallet, coins, runners from smart_wallets");
      smart = new Map(r.rows.map((x) => [x.wallet, [x.coins, x.runners]]));
    } catch {}
  };
  await loadSmart();
  setInterval(() => void loadSmart(), 10 * 60_000).unref();
  const smartQueue = []; // buys waiting to be written
  const smartMc = new Map(); // mint hex → { mc, at, dirty }: coins smart wallets bought (a day)
  const SMART_MIN_SOL = 0.05e9; // smaller buys are left off the page
  const smartSeen = { any: 0, sized: 0, named: 0 }; // for the log: how many smart-wallet buys the feed saw
  function smartBuy(user, mintHex, lamports, mc) {
    const s = smart.get(user);
    if (!s) return;
    smartSeen.any++;
    if (lamports < SMART_MIN_SOL || !(mc > 0)) return;
    smartSeen.sized++;
    const meta = metas.get(mintHex);
    if (!meta) return; // a coin the bot never saw launch: no name to show
    smartSeen.named++;
    smartQueue.push([hexToB58(user), hexToB58(mintHex), meta.name, meta.symbol, lamports / 1e9, (lamports / 1e9) * solUsd, mc, s[0], s[1]]);
    smartMc.set(mintHex, { mc, at: Date.now(), dirty: true });
  }
  function smartPrice(mintHex, mc) {
    const m = smartMc.get(mintHex);
    if (m && mc > 0) {
      m.mc = mc;
      m.dirty = true;
    }
  }
  setInterval(async () => {
    if (smartQueue.length) {
      const rows = smartQueue.splice(0, 200);
      const args = [];
      const vals = rows.map((r, i) => {
        args.push(...r);
        return `(${r.map((_, k) => `$${i * r.length + k + 1}`).join(",")})`;
      });
      await pool
        .query(`insert into smart_buys (wallet, mint, name, symbol, sol, usd, mc, coins, runners) values ${vals.join(",")}`, args)
        .catch((e) => log(`bot test: smart buys: ${e.message}`));
    }
    const now = Date.now();
    const mints = [];
    const mcs = [];
    for (const [k, m] of smartMc) {
      if (now - m.at > 86400_000) smartMc.delete(k);
      else if (m.dirty) {
        m.dirty = false;
        mints.push(hexToB58(k));
        mcs.push(m.mc);
      }
    }
    if (mints.length)
      await pool
        .query(
          `insert into smart_coins (mint, mc, updated_at) select u.m, u.v, now() from unnest($1::text[], $2::float8[]) as u(m, v)
           on conflict (mint) do update set mc = excluded.mc, updated_at = now()`,
          [mints, mcs]
        )
        .catch(() => {});
  }, 5000).unref();

  const coins = new Map(); // mint hex → coin being watched
  const seen = new Map(); // link / picture key → { mint, at } (24 h)
  const tickers = new Map(); // ticker → [times] (1 h)
  const devs = new Map(); // creator hex → { launches: [times], rugs }
  const launched = new Map(); // mint hex → { creator, t0 } for 10 min (creators who dump early)
  let events = 0;
  let lastEvent = Date.now();

  const remember = (key, mint) => {
    if (!key) return null;
    const had = seen.get(key);
    if (had && had.mint !== mint && Date.now() - had.at < 86400_000) return had.mint;
    if (!had) seen.set(key, { mint, at: Date.now() });
    return null;
  };

  async function enrich(c) {
    try {
      const r = await getText(c.uri, 4000, 100_000);
      const m = JSON.parse(r.text);
      c.x = parseX(m.twitter);
      const tg = parseTelegram(m.telegram);
      c.telegram = tg;
      c.site = parseWebsite(m.website);
      c.links = { x: m.twitter || null, telegram: m.telegram || null, website: m.website || null };
      // the same link or picture on another coin (24 h): a copy, or a recycled scam
      const reused =
        (c.x && c.x.kind !== "post" && remember(c.x.key, c.mint) && "X") ||
        (tg && remember(`tg:${tg.toLowerCase()}`, c.mint) && "Telegram") ||
        (c.site?.own && remember(`w:${c.site.host}`, c.mint) && "website") ||
        (m.image && remember(`img:${String(m.image).replace(/^.*\/ipfs\//, "")}`, c.mint) && "picture");
      if (reused) c.reused = reused;
      // many coins point at the same viral post (the story they're about): not a scam on its own,
      // but every coin after the first is a copy of the same idea
      if (c.x?.kind === "post" && remember(c.x.key, c.mint)) c.samePost = true;
      const jobs = [];
      if (tg)
        jobs.push(
          getText(`https://t.me/${tg}`, 4000, 200_000)
            .then((p) => (c.tgMembers = telegramMembers(p.text)))
            .catch(() => {})
        );
      if (c.site?.own) {
        jobs.push(
          getText(c.site.url, 4000, 50_000)
            .then((p) => (c.siteUp = p.ok && p.text.length > 300))
            .catch(() => (c.siteUp = false))
        );
        jobs.push(domainAgeDays(c.site.host).then((d) => (c.domainDays = d)));
      }
      await Promise.all(jobs);
    } catch {
      // no info file or a broken one: judged without links
    } finally {
      c.enriched = true;
      const meta = metas.get(c.mint);
      if (meta) {
        meta.x = c.x?.kind ?? null;
        meta.tg = c.telegram ? Math.max(1, c.tgMembers ?? 1) : 0;
        meta.site = c.site?.own ? (c.siteUp ? 1 : 0) : null;
      }
    }
  }

  function onCreate(e, slot) {
    // coins priced in something other than SOL are left out
    if (e.quote && !e.quote.every((v) => v === 0) && new web3.PublicKey(e.quote).toBase58() !== WSOL) return;
    const now = Date.now();
    const dev = devs.get(e.creator) ?? { launches: [], rugs: 0 };
    dev.launches = dev.launches.filter((t) => now - t < 86400_000);
    dev.launches.push(now);
    devs.set(e.creator, dev);
    const tk = lower(e.symbol);
    const times = (tickers.get(tk) ?? []).filter((t) => now - t < 3600_000);
    times.push(now);
    tickers.set(tk, times);
    const startMc = mcOf(e.vSol, e.vTok, solUsd);
    const c = {
      mint: e.mint,
      t0: now,
      slot,
      name: e.name.slice(0, 64),
      symbol: e.symbol.slice(0, 16),
      uri: e.uri,
      creator: e.creator,
      startMc,
      mc: startMc,
      devTokens: 0,
      devSold: false,
      devLaunches: dev.launches.length,
      devRugs: dev.rugs,
      copyTicker: times.length >= 3 ? times.length : 0,
      bundleTokens: 0,
      holders: new Map(),
      buyers: new Set(),
      buys: 0,
      sells: 0,
      solIn: 0,
      solOut: 0,
      decided: false,
      path: null,
    };
    const steps = Math.ceil((RULES.followMin * 60_000) / BUCKET_MS) + 2;
    const zeros = () => new Array(steps).fill(0);
    c.path = { hi: new Array(steps).fill(null), lo: new Array(steps).fill(null), cl: new Array(steps).fill(null), b: zeros(), s: zeros(), nb: zeros(), ns: zeros(), v: zeros(), ds: zeros() };
    c.everBought = new Set(); // every wallet that bought (new buyers per step)
    c.firstBuyers = []; // [wallet hex, step] of the first 40 buyers (not the creator)
    c.path.cl[0] = c.path.hi[0] = c.path.lo[0] = Math.round(startMc);
    coins.set(e.mint, c);
    metas.set(e.mint, { t0: now, name: c.name, symbol: c.symbol, creator: e.creator, x: null, tg: 0, site: null, devSold: false });
    launched.set(e.mint, { creator: e.creator, t0: now });
    if (/^https?:\/\//i.test(e.uri)) void enrich(c);
    else c.enriched = true;
  }

  /** A price for a followed coin from its PumpSwap pool (after it graduates within its hour). */
  function poolPrice(c, mc) {
    c.mc = mc;
    const step = Math.floor((Date.now() - c.t0) / BUCKET_MS);
    if (step < c.path.hi.length) {
      const m = Math.round(mc);
      c.path.hi[step] = Math.max(c.path.hi[step] ?? 0, m);
      c.path.lo[step] = Math.min(c.path.lo[step] ?? Infinity, m);
      c.path.cl[step] = m;
    }
    if (c.entryMc) {
      if (mc > c.peak) {
        c.peak = mc;
        c.peakAt = Date.now();
      }
      if (mc < c.low) c.low = mc;
      if (!c.result) {
        if (mc >= c.entryMc * TAKE_PROFIT) c.result = "win";
        else if (mc <= c.entryMc * STOP_LOSS) c.result = "loss";
      }
    }
  }

  function onTrade(e, slot) {
    // every coin's trades feed the proven-coins signals
    const tradeMc = mcOf(e.vSol, e.vTok, solUsd);
    late.curveTrade(e, tradeMc);
    smartPrice(e.mint, tradeMc);
    if (e.buy) smartBuy(e.user, e.mint, e.sol, tradeMc);
    if (!e.buy) {
      const meta = metas.get(e.mint);
      if (meta && meta.creator === e.user) meta.devSold = true;
    }
    // the creator selling in the first 10 minutes marks them for their next coins
    if (!e.buy) {
      const l = launched.get(e.mint);
      if (l && l.creator === e.user && !l.rug && Date.now() - l.t0 < 10 * 60_000) {
        l.rug = true;
        const d = devs.get(e.user);
        if (d) d.rugs++;
      }
    }
    const c = coins.get(e.mint);
    if (!c) return;
    c.mc = mcOf(e.vSol, e.vTok, solUsd);
    // the price path in 5-second steps (high, low, last)
    const step = Math.floor((Date.now() - c.t0) / BUCKET_MS);
    if (step < c.path.hi.length) {
      const m = Math.round(c.mc);
      c.path.hi[step] = Math.max(c.path.hi[step] ?? 0, m);
      c.path.lo[step] = Math.min(c.path.lo[step] ?? Infinity, m);
      c.path.cl[step] = m;
      c.path.v[step] += e.sol / 1e9; // SOL traded
      if (!e.buy && e.user === c.creator) c.path.ds[step] = 1; // the creator sold
      if (e.buy) {
        c.path.b[step]++;
        c.path.ns[step] += e.sol / 1e9;
        if (!c.everBought.has(e.user)) {
          c.everBought.add(e.user);
          c.path.nb[step]++;
          // the first buyers and when they bought: who keeps getting in early on winners (smart wallets)
          if (c.firstBuyers.length < 40 && e.user !== c.creator) c.firstBuyers.push([e.user, step]);
        }
      } else {
        c.path.s[step]++;
        c.path.ns[step] -= e.sol / 1e9;
      }
    }
    if (!c.decided) {
      const delta = e.buy ? e.tokens : -e.tokens;
      c.holders.set(e.user, (c.holders.get(e.user) ?? 0) + delta);
      if (e.buy) {
        c.buys++;
        c.solIn += e.sol;
        if (e.user !== c.creator) c.buyers.add(e.user);
      } else {
        c.sells++;
        c.solOut += e.sol;
      }
      if (e.user === c.creator) {
        if (e.buy) c.devTokens += e.tokens;
        else c.devSold = true;
      } else if (e.buy && slot <= c.slot) c.bundleTokens += e.tokens;
    } else if (c.entryMc) {
      // after the decision: the path from the decision price
      if (c.mc > c.peak) {
        c.peak = c.mc;
        c.peakAt = Date.now();
      }
      if (c.mc < c.low) c.low = c.mc;
      if (!c.result) {
        if (c.mc >= c.entryMc * TAKE_PROFIT) c.result = "win";
        else if (c.mc <= c.entryMc * STOP_LOSS) c.result = "loss";
      }
    }
  }

  async function decide(c) {
    c.decided = true;
    const now = Date.now();
    let j = judge(c, now);
    // close enough: its X account is worth a lookup
    if (!j.fail && c.x?.kind === "profile" && j.score >= RULES.xLookupFrom) {
      c.xInfo = await xLookup(c.x.handle, log);
      j = judge(c, now);
    }
    c.entryMc = c.mc;
    c.peak = c.mc;
    c.low = c.mc;
    c.peakAt = now;
    c.score = j.score;
    c.passed = !j.fail;
    // only the price path is needed from here on
    c.holders = null;
    c.buyers = null;
    c.decideIdx = Math.floor((Date.now() - c.t0) / BUCKET_MS);
    // the decision's step starts again at the entry price: only what happens after the buy counts
    const m0 = Math.round(c.entryMc);
    if (c.decideIdx < c.path.hi.length) c.path.hi[c.decideIdx] = c.path.lo[c.decideIdx] = c.path.cl[c.decideIdx] = m0;
    // coins nobody could pass are watched no further (keeps the work small); coins with links that
    // only missed on timing are followed too (a later entry might have worked)
    // followed for an hour (price path kept): every coin with links, every pick, and 1 in 10 of the
    // rest as a baseline — what the optimizer learns from
    const follow = c.passed || j.score >= LEVELS.aggressive - 15 || !!(c.x || c.telegram || c.site) || Math.random() < 0.1;
    j.checks.idx = c.decideIdx;
    if (!follow) coins.delete(c.mint);
    await pool
      .query(
        `insert into sniper_signals (mint, created_at, decided_at, name, symbol, creator, x, telegram, website, score, passed, fail, checks, start_mc, entry_mc, peak_mc, low_mc, done)
         values ($1, to_timestamp($2 / 1000.0), now(), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, $14, $15)
         on conflict (mint) do nothing`,
        [
          hexToB58(c.mint),
          c.t0,
          c.name,
          c.symbol,
          hexToB58(c.creator),
          c.links?.x ?? null,
          c.links?.telegram ?? null,
          c.links?.website ?? null,
          j.score,
          c.passed,
          j.fail,
          JSON.stringify(j.checks),
          c.startMc,
          c.entryMc,
          !follow,
        ]
      )
      .catch((e) => log(`bot test: save failed: ${e.message}`));
  }

  async function finish(c) {
    coins.delete(c.mint);
    const sims = {};
    for (const st of STRATEGIES) sims[st.key] = simulate(c.path, c.decideIdx, st, c.entryMc);
    const grid = gridOf(c.path, c.decideIdx, c.entryMc, c.startMc);
    // the path without the empty tail
    let end = c.path.hi.length;
    while (end > 0 && c.path.hi[end - 1] == null) end--;
    const cut = (a) => a.slice(0, end);
    const path = {
      step: BUCKET_MS / 1000,
      hi: cut(c.path.hi),
      lo: cut(c.path.lo),
      cl: cut(c.path.cl),
      b: cut(c.path.b),
      s: cut(c.path.s),
      nb: cut(c.path.nb),
      ns: cut(c.path.ns).map((v) => +v.toFixed(2)),
      v: cut(c.path.v).map((v) => +v.toFixed(2)),
      ds: cut(c.path.ds),
    };
    c.everBought = null;
    const buyers = c.firstBuyers.map(([w, st]) => [hexToB58(w), st]);
    c.firstBuyers = null;
    await pool
      .query(`update sniper_signals set peak_mc = $2, low_mc = $3, peak_sec = $4, result = $5, done = true, sims = $6, path = $7, grid = $8, buyers = $9 where mint = $1`, [
        hexToB58(c.mint),
        c.peak,
        c.low,
        Math.round((c.peakAt - c.t0) / 1000),
        c.result ?? "open",
        JSON.stringify(sims),
        JSON.stringify(path),
        JSON.stringify(grid),
        JSON.stringify(buyers),
      ])
      .catch((e) => log(`bot test: update failed: ${e.message}`));
  }

  // the clock: decisions and endings
  let lateTick = Date.now();
  const tick = setInterval(() => {
    const now = Date.now();
    for (const c of coins.values()) {
      if (!c.decided) {
        const age = (now - c.t0) / 1000;
        if (age >= RULES.decideSec && (c.enriched || age >= RULES.maxWaitSec)) void decide(c);
      } else if (c.entryMc && now - c.t0 >= RULES.followMin * 60_000) void finish(c);
      else if (c.entryMc && now - (c.savedAt ?? 0) >= 60_000 && (c.peak !== c.savedPeak || c.low !== c.savedLow || c.result !== c.savedResult)) {
        // the admin page sees the path while it's followed (every minute at most)
        c.savedAt = now;
        c.savedPeak = c.peak;
        c.savedLow = c.low;
        c.savedResult = c.result;
        pool
          .query(`update sniper_signals set peak_mc = $2, low_mc = $3, peak_sec = $4, result = $5 where mint = $1 and not done`, [
            hexToB58(c.mint),
            c.peak,
            c.low,
            Math.round((c.peakAt - c.t0) / 1000),
            c.result ?? null,
          ])
          .catch(() => {});
      }
    }
    // keep the memory small
    if (seen.size > 200_000) for (const [k, v] of seen) if (now - v.at > 86400_000) seen.delete(k);
    if (devs.size > 200_000) for (const [k, v] of devs) if (!v.launches.some((t) => now - t < 86400_000)) devs.delete(k);
    if (tickers.size > 50_000) tickers.clear();
    if (now - lateTick >= RULES.lateTickSec * 1000) {
      lateTick = now;
      late.tick();
      for (const [k, v] of metas) if (now - v.t0 > 86400_000) metas.delete(k);
      else break; // oldest first
    }
    for (const [k, v] of launched) if (now - v.t0 > 10 * 60_000) launched.delete(k);
    else break; // oldest first
  }, 1000);

  // the feed: every pump.fun transaction, over the node's websocket
  let conn = null;
  let sub = null;
  let subAmm = null;
  const connect = async () => {
    if (conn && sub !== null) await conn.removeOnLogsListener(sub).catch(() => {});
    if (conn && subAmm !== null) await conn.removeOnLogsListener(subAmm).catch(() => {});
    conn = new web3.Connection(rpc, { commitment: "confirmed", wsEndpoint: rpc.replace(/^http/, "ws") });
    sub = conn.onLogs(
      new web3.PublicKey(PUMP),
      (l, ctx) => {
        if (l.err) return;
        lastEvent = Date.now();
        for (const line of l.logs) {
          if (!line.startsWith("Program data: ")) continue;
          const e = decodeEvent(line.slice(14));
          if (!e) continue;
          events++;
          if (e.kind === "create") onCreate(e, ctx.slot);
          else if (e.kind === "trade") onTrade(e, ctx.slot);
          else if (e.kind === "migrated") {
            // its PumpSwap pool, when priced in SOL: its trades are followed from now on
            if (!e.quote || e.quote === WSOL_HEX || /^0+$/.test(e.quote)) late.migrated(e.mint, e.pool);
          }
          else if (e.kind === "complete") {
            const c = coins.get(e.mint);
            if (c?.entryMc && !c.result) c.result = "win"; // moved to its pool: well above any take profit
          }
        }
      },
      "confirmed"
    );
    // PumpSwap: prices of coins that graduated while watched (SNIPER_AMM=0 switches it off)
    subAmm =
      process.env.SNIPER_AMM === "0"
        ? null
        : conn.onLogs(
            new web3.PublicKey(PUMP_AMM),
            (l) => {
              if (l.err) return;
              for (const line of l.logs) {
                if (!line.startsWith("Program data: ")) continue;
                const e = decodeAmm(line.slice(14));
                if (!e) continue;
                const mc = ammMc(e.base, e.quote, solUsd);
                const mint = late.poolTrade(e, mc);
                if (mint) {
                  smartPrice(mint, mc);
                  if (e.buy) smartBuy(e.user, mint, e.sol, mc);
                }
                const c = mint ? coins.get(mint) : null;
                if (c) poolPrice(c, mc);
              }
            },
            "confirmed"
          );
  };
  await connect();
  log("bot test: watching pump.fun live");

  // a quiet feed for a minute means the connection dropped: open a new one
  for (let n = 0; ; n++) {
    await sleep(30_000);
    if (Date.now() - lastEvent > 60_000) {
      log("bot test: feed quiet for a minute, reconnecting");
      await connect().catch((e) => log(`bot test: reconnect failed: ${e.message}`));
      lastEvent = Date.now();
    }
    if (n % 20 === 0) {
      const ls = late.size();
      log(`bot test: ${events} events, ${coins.size} new coins watched, ${ls.coins} trading coins, ${ls.follows} proven-coin signals followed, ${ls.pools} pools`);
      log(`bot test: smart wallets ${smart.size}, their buys seen ${smartSeen.any} (${smartSeen.sized} big enough, ${smartSeen.named} shown)`);
      await pool.query(`delete from sniper_signals where created_at < now() - interval '14 days'`).catch(() => {});
      await pool.query(`delete from smart_buys where at < now() - interval '2 days'`).catch(() => {});
      await pool.query(`delete from smart_coins where updated_at < now() - interval '2 days'`).catch(() => {});
      // price paths are the big part: kept 3 days (the optimizer uses the much smaller grid)
      await pool.query(`update sniper_signals set path = null where path is not null and created_at < now() - interval '3 days'`).catch(() => {});
    }
  }
  // (never returns; the interval keeps deciding)
  // eslint-disable-next-line no-unreachable
  clearInterval(tick);
}
