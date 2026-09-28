// Mini price charts: every minute, 24 prices per coin over the last 4 hours
// (10-minute steps) on the coin's busiest chain, into coin_spark.
// Coins with no trade in the window get a flat line at their last price.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STEPS = 24;
const STEP_MS = 10 * 60_000;

export async function sparkLoop(pool, log) {
  let warned = false;
  for (;;) {
    try {
      const n = await drawSparks(pool);
      warned = false;
      if (n && process.env.SPARK_LOG) log(`sparks: ${n}`);
    } catch (e) {
      if (/relation "coin_spark" does not exist/.test(e.message)) {
        if (!warned) log("mini charts off: run indexer/spark.sql in Supabase");
        warned = true;
      } else log(`sparks: ${e.message}`);
    }
    await sleep(60_000);
  }
}

export async function drawSparks(pool) {
  // Each coin's busiest chain over the last day (or ever, if quiet).
  const { rows: main } = await pool.query(
    `select distinct on (coin_id) coin_id, chain_id, curve
     from (select coin_id, chain_id, curve, sum(native_amount) as v, max(ts) as last
           from trades where ts > now() - interval '30 days' group by 1, 2, 3) x
     order by coin_id, (last > now() - interval '1 day') desc, v desc`
  );
  if (!main.length) return 0;
  const key = (c, k) => `${c}:${k}`;
  const mainOf = new Map(main.map((m) => [m.coin_id, key(m.chain_id, m.curve)]));

  const now = Date.now();
  const from = new Date(now - STEPS * STEP_MS);
  // Last price in each 10-minute step, on every curve (we keep the main ones).
  const { rows: steps } = await pool.query(
    `select chain_id, curve, floor(extract(epoch from (ts - $1::timestamptz)) / 600)::int as b,
            (array_agg(price order by ts desc, log_index desc))[1]::float8 as p
     from trades where ts >= $1 group by 1, 2, 3`,
    [from.toISOString()]
  );
  // The price just before the window, to start each line.
  const { rows: before } = await pool.query(
    `select distinct on (chain_id, curve) chain_id, curve, price::float8 as p
     from trades where ts < $1 and ts > now() - interval '30 days'
     order by chain_id, curve, ts desc, log_index desc`,
    [from.toISOString()]
  );
  const startOf = new Map(before.map((r) => [key(r.chain_id, r.curve), r.p]));
  const byCurve = new Map();
  for (const s of steps) {
    const k = key(s.chain_id, s.curve);
    if (!byCurve.has(k)) byCurve.set(k, new Map());
    if (s.b >= 0 && s.b < STEPS) byCurve.get(k).set(s.b, s.p);
  }

  const ids = [];
  const pts = [];
  for (const [coin, k] of mainOf) {
    const inWin = byCurve.get(k);
    let last = startOf.get(k) ?? (inWin ? inWin.get(Math.min(...inWin.keys())) : null);
    if (last === null || last === undefined) continue;
    const line = [];
    for (let b = 0; b < STEPS; b++) {
      if (inWin && inWin.has(b)) last = inWin.get(b);
      line.push(last);
    }
    ids.push(coin);
    pts.push(`{${line.map((v) => (Number.isFinite(v) ? v : 0)).join(",")}}`);
  }
  if (!ids.length) return 0;
  await pool.query(
    `insert into coin_spark (coin_id, pts, updated_at)
     select i, p::float8[], now() from unnest($1::text[], $2::text[]) as t(i, p)
     on conflict (coin_id) do update set pts = excluded.pts, updated_at = now()`,
    [ids, pts]
  );
  return ids.length;
}
