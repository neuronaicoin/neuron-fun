// Price alerts: checks every switched-on alert against the latest numbers,
// writes a notification (the 🔔 on the site) and sends a free web push to
// the owner's phones and browsers.
//
// Numbers are worked out exactly like the website does:
//   market cap  the biggest of the coin's open or graduated curves, price x 1B supply, in dollars
//   price       that market cap / 1B
//   curve       dollars in the open curves / TARGET_USD (100% once graduated)
//   % move      change of that curve's price over the last hour
//
// Env:
//   TARGET_USD          graduation target used by the site (default 5, testnet)
//   ALERT_EVERY_MS      how often alerts are checked (default 5000)
//   ALERT_COOLDOWN_MIN  minimum minutes between two firings of an alert kept on (default 15)
//   VAPID_PUBLIC_KEY    web push keys (push is skipped if missing; the 🔔 still works)
//   VAPID_PRIVATE_KEY
//   VAPID_SUBJECT       contact for push services (default https://sasapad.fun)
//   SITE_URL            used in notification links (default https://sasapad.fun)

import webpush from "web-push";

const SUPPLY = 1e9;
const HOUR = 3600_000;
export const NATIVE_BY_CHAIN = { 56: "BNB", 97: "BNB" }; // everything else is priced in ETH

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ formatting (same as the site)

export function money(v) {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e9) return `$${trim((v / 1e9).toFixed(2))}B`;
  if (v >= 1e6) return `$${trim((v / 1e6).toFixed(2))}M`;
  if (v >= 1e3) return `$${trim((v / 1e3).toFixed(1))}K`;
  return `$${v.toFixed(v < 10 ? 2 : 0)}`;
}
const trim = (s) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

export function price(p) {
  if (!(p > 0)) return "$0";
  if (p >= 1) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  const m = p.toFixed(18).match(/^0\.(0*)(\d+)/);
  if (!m) return `$${p}`;
  const zeros = m[1].length;
  const digits = m[2].slice(0, 4).replace(/0+$/, "") || "0";
  if (zeros >= 4) {
    const sub = "₀₁₂₃₄₅₆₇₈₉";
    return `$0.0${String(zeros).split("").map((d) => sub[+d]).join("")}${digits}`;
  }
  return `$0.${m[1]}${digits}`;
}

export function describe(a) {
  const t = Number(a.target);
  if (a.kind === "mc") return `Market cap ${a.dir === "above" ? "above" : "below"} ${money(t)}`;
  if (a.kind === "price") return `Price ${a.dir === "above" ? "above" : "below"} ${price(t)}`;
  if (a.kind === "move") return `${a.dir === "up" ? "Up" : a.dir === "down" ? "Down" : "Moves"} ${trim(String(t))}% in 1 hour`;
  if (a.kind === "bond") return "Curve 90% full";
  return "Graduated";
}

// ------------------------------------------------------------------ prices of the gas coins

let priceCache = { at: 0, prices: null };
export async function gasPrices() {
  if (priceCache.prices && Date.now() - priceCache.at < 60_000) return priceCache.prices;
  const out = { USD: 1 };
  await Promise.all(
    ["ETH", "BNB"].map(async (s) => {
      try {
        const r = await fetch(`https://api.coinbase.com/v2/prices/${s}-USD/spot`, { signal: AbortSignal.timeout(8000) });
        const p = Number((await r.json())?.data?.amount);
        if (Number.isFinite(p) && p > 0) out[s] = p;
      } catch {}
    })
  );
  if (!out.ETH) return priceCache.prices; // keep the last good prices; null the first time
  priceCache = { at: Date.now(), prices: out };
  return out;
}

// ------------------------------------------------------------------ the numbers for one coin

function coinFacts(curves, graduated, prices, target) {
  let best = null;
  let openUsd = 0;
  for (const k of curves) {
    const px = prices[NATIVE_BY_CHAIN[k.chain_id] ?? "ETH"];
    if (!px) return null;
    const vn = Number(k.virtual_native);
    const vt = Number(k.virtual_token);
    if (k.state !== 1 && vt > 0) {
      const mc = (vn / vt) * SUPPLY * px;
      if (!best || mc > best.mc) best = { mc, chain_id: k.chain_id, curve: k.curve, native: vn / vt };
    }
    if (k.state === 0) openUsd += (Number(k.real_native) / 1e18) * px;
  }
  if (!best) return null;
  return {
    mc: best.mc,
    price: best.mc / SUPPLY,
    progress: graduated ? 1 : target > 0 ? Math.min(1, openUsd / target) : 0,
    graduated,
    curve: best,
  };
}

// ------------------------------------------------------------------ the loop

export async function alertLoop(pool, log) {
  const every = Number(process.env.ALERT_EVERY_MS ?? "5000");
  const cooldown = Number(process.env.ALERT_COOLDOWN_MIN ?? "15") * 60_000;
  const target = Number(process.env.TARGET_USD ?? "5");
  const site = (process.env.SITE_URL ?? "https://sasapad.fun").replace(/\/$/, "");
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  let push = false;
  if (vapidPublic && vapidPrivate) {
    try {
      webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "https://sasapad.fun", vapidPublic, vapidPrivate);
      push = true;
    } catch (e) {
      log(`web push off: ${e.message}`);
    }
  } else {
    log("web push off (set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to turn it on)");
  }

  let tableWarned = false;
  let lastPrune = 0;
  for (;;) {
    try {
      const fired = await checkOnce(pool, { cooldown, target, site });
      tableWarned = false;
      if (fired.length) {
        log(`alerts: ${fired.length} fired`);
        if (push) await sendPushes(pool, fired, log);
      }
      await followAlerts(pool, site, log);
      await sendPendingNotes(pool, push, log);
      if (Date.now() - lastPrune > HOUR) {
        lastPrune = Date.now();
        await pool.query("delete from notifications where created_at < now() - interval '30 days'");
        await pool.query("delete from alerts where not active and fired_at < now() - interval '30 days'");
      }
    } catch (e) {
      // alerts.sql not run yet: say so once and keep the indexer going.
      if (/relation "(alerts|notifications|push_subs)" does not exist/.test(e.message)) {
        if (!tableWarned) log("alerts off: run indexer/alerts.sql in Supabase");
        tableWarned = true;
        await sleep(60_000);
        continue;
      }
      log(`alerts: ${e.message}`);
    }
    await sleep(every);
  }
}

async function checkOnce(pool, { cooldown, target, site }) {
  const { rows: alerts } = await pool.query(
    `select a.id, a.owner, a.coin_id, a.kind, a.dir, a.target::float8 as target, a.repeat, a.push, a.armed, a.fired_at,
            c.name, c.symbol, c.graduated_chain
     from alerts a join coins c on c.id = a.coin_id
     where a.active`
  );
  if (!alerts.length) return [];
  const prices = await gasPrices();
  if (!prices) return [];

  const coinIds = [...new Set(alerts.map((a) => a.coin_id))];
  const { rows: curves } = await pool.query(
    `select coin_id, chain_id, curve, state, virtual_native::text, virtual_token::text, real_native::text
     from curves where coin_id = any($1)`,
    [coinIds]
  );
  const byCoin = new Map();
  for (const k of curves) {
    if (!byCoin.has(k.coin_id)) byCoin.set(k.coin_id, []);
    byCoin.get(k.coin_id).push(k);
  }
  const facts = new Map();
  for (const a of alerts) {
    if (facts.has(a.coin_id)) continue;
    facts.set(a.coin_id, coinFacts(byCoin.get(a.coin_id) ?? [], a.graduated_chain !== null, prices, target));
  }

  // Price an hour ago, only for coins that have a % move alert.
  const hourAgo = new Map();
  for (const id of new Set(alerts.filter((a) => a.kind === "move").map((a) => a.coin_id))) {
    const f = facts.get(id);
    if (!f) continue;
    const { rows } = await pool.query(
      `(select price::float8 as p from trades where chain_id = $1 and curve = $2 and ts <= now() - interval '1 hour'
        order by ts desc, log_index desc limit 1)
       union all
       (select price::float8 from trades where chain_id = $1 and curve = $2 and ts > now() - interval '1 hour'
        order by ts asc, log_index asc limit 1)`,
      [f.curve.chain_id, f.curve.curve]
    );
    if (rows.length && rows[0].p > 0) hourAgo.set(id, rows[0].p);
  }

  const now = Date.now();
  const fired = [];
  const rearm = [];
  for (const a of alerts) {
    const f = facts.get(a.coin_id);
    if (!f) continue;
    const cooled = !a.fired_at || now - new Date(a.fired_at).getTime() >= cooldown;
    const name = `${a.name} ($${a.symbol})`;
    let body = null;

    if (a.kind === "mc" || a.kind === "price") {
      const v = a.kind === "mc" ? f.mc : f.price;
      const crossed = a.dir === "above" ? v >= a.target : v <= a.target;
      if (!a.armed) {
        if (!crossed) rearm.push(a.id);
        continue;
      }
      if (crossed && cooled) {
        const show = a.kind === "mc" ? money : price;
        body = `${a.kind === "mc" ? "Market cap" : "Price"} is ${show(v)}, ${a.dir === "above" ? "above" : "below"} your ${show(a.target)} alert.`;
      }
    } else if (a.kind === "move") {
      const ref = hourAgo.get(a.coin_id);
      if (!ref || !cooled) continue;
      const ch = (f.curve.native / ref - 1) * 100;
      const hit = a.dir === "up" ? ch >= a.target : a.dir === "down" ? ch <= -a.target : Math.abs(ch) >= a.target;
      if (hit) body = `${ch >= 0 ? "Up" : "Down"} ${Math.abs(ch).toFixed(1)}% in the last hour. Market cap ${money(f.mc)}.`;
    } else if (a.kind === "bond") {
      if (f.progress >= 0.9)
        body = f.graduated ? "The curve filled up and the coin graduated." : `The curve is ${Math.floor(f.progress * 100)}% full. Graduation is close.`;
    } else if (a.kind === "grad") {
      if (f.graduated) body = "It graduated and now trades in its locked pool.";
    }

    if (!body) continue;
    const once = !a.repeat || a.kind === "bond" || a.kind === "grad";
    fired.push({
      alert: a,
      once,
      title: `${name} · ${describe(a)}`,
      body,
      url: `${site}/coin/?id=${encodeURIComponent(a.coin_id)}`,
    });
  }

  if (rearm.length) await pool.query("update alerts set armed = true where id = any($1) and active", [rearm]);
  if (!fired.length) return [];

  // Write everything in one go; an alert is only marked fired together with its notification.
  const db = await pool.connect();
  try {
    await db.query("begin");
    for (const x of fired) {
      const a = x.alert;
      const upd = await db.query(
        `update alerts set fired_at = now(), armed = case when kind in ('mc','price') then false else armed end,
                active = $2
         where id = $1 and active returning id`,
        [a.id, !x.once]
      );
      if (!upd.rowCount) {
        x.skip = true; // deleted or switched off a moment ago
        continue;
      }
      await db.query(
        `insert into notifications (owner, coin_id, kind, title, body, url) values ($1, $2, $3, $4, $5, $6)`,
        [a.owner, a.coin_id, a.kind, x.title, x.body, x.url]
      );
    }
    await db.query("commit");
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
  return fired.filter((x) => !x.skip);
}

// Someone you follow bought: a 🔔 (and phone push) with a link that opens the Buy box.
let followCursor = null;
let followWarned = false;
async function followAlerts(pool, site, log) {
  try {
    if (!followCursor) {
      // Kept as text: JavaScript dates drop the microseconds and would re-read the same trade.
      const { rows } = await pool.query("select now()::text as t");
      followCursor = rows[0].t;
      return;
    }
    const { rows } = await pool.query(
      `select t.trader, t.coin_id, t.chain_id, t.native_amount::float8 as native, t.ts::text as ts,
              c.name, c.symbol, p.username
       from trades t
       join coins c on c.id = t.coin_id
       left join profiles p on p.address = t.trader
       where t.is_buy and t.ts > $1::timestamptz
         and coalesce(p.hide_trades, false) = false
         and exists (select 1 from follows f where f.followee = t.trader)
       order by t.ts asc limit 200`,
      [followCursor]
    );
    if (!rows.length) return;
    followCursor = rows[rows.length - 1].ts;
    const prices = await gasPrices();
    for (const r of rows) {
      const px = prices ? prices[NATIVE_BY_CHAIN[r.chain_id] ?? "ETH"] : null;
      const usd = px ? (r.native / 1e18) * px : null;
      const who = r.username ? `@${r.username}` : `${r.trader.slice(0, 6)}…${r.trader.slice(-4)}`;
      const title = `${who} bought ${usd !== null ? money(usd) + " of " : ""}$${r.symbol}`;
      await pool.query(
        `insert into notifications (owner, coin_id, kind, title, body, url, pushed)
         select f.follower, $2, 'follow', $3, $4, $5, false from follows f where f.followee = $1
           -- people copying this trader get a copy signal instead (copy.mjs)
           and not exists (select 1 from copy_follows c where c.follower = f.follower and c.trader = $1)`,
        [r.trader, r.coin_id, title, `${r.name}. Tap to buy too.`, `${site}/coin/?id=${encodeURIComponent(r.coin_id)}&buy=1`]
      );
    }
    followWarned = false;
  } catch (e) {
    // social.sql not run yet: stay quiet until it is.
    if (!/relation "(profiles|follows)" does not exist/.test(e.message) && !followWarned) log(`follow alerts: ${e.message}`);
    followWarned = true;
  }
}

// Notifications written elsewhere (forum replies) wait with pushed = false.
let pendingWarned = false;
async function sendPendingNotes(pool, push, log) {
  let rows;
  try {
    ({ rows } = await pool.query("select id, owner, title, body, url from notifications where not pushed order by id limit 200"));
  } catch (e) {
    // forum.sql not run yet (no "pushed" column): nothing to send.
    if (!pendingWarned && !/column "pushed" does not exist/.test(e.message)) log(`notes: ${e.message}`);
    pendingWarned = true;
    return;
  }
  if (!rows.length) return;
  await pool.query("update notifications set pushed = true where id = any($1)", [rows.map((r) => r.id)]);
  if (!push) return;
  await sendPushes(
    pool,
    rows.map((r) => ({ alert: { id: `n${r.id}`, owner: r.owner, push: true }, title: r.title, body: r.body, url: r.url })),
    log
  );
}

async function sendPushes(pool, fired, log) {
  const wanted = fired.filter((x) => x.alert.push);
  if (!wanted.length) return;
  const owners = [...new Set(wanted.map((x) => x.alert.owner))];
  const { rows: subs } = await pool.query("select endpoint, owner, p256dh, auth from push_subs where owner = any($1)", [owners]);
  if (!subs.length) return;
  const byOwner = new Map();
  for (const s of subs) {
    if (!byOwner.has(s.owner)) byOwner.set(s.owner, []);
    byOwner.get(s.owner).push(s);
  }
  const gone = [];
  const failed = [];
  const ok = [];
  await Promise.all(
    wanted.flatMap((x) =>
      (byOwner.get(x.alert.owner) ?? []).map(async (s) => {
        const payload = JSON.stringify({ title: x.title, body: x.body, url: x.url, tag: `alert-${x.alert.id}` });
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
            TTL: 3600,
            urgency: "high",
            timeout: 10_000,
          });
          ok.push(s.endpoint);
        } catch (e) {
          // 404 / 410: the phone or browser dropped this subscription.
          if (e.statusCode === 404 || e.statusCode === 410) gone.push(s.endpoint);
          else failed.push(s.endpoint);
        }
      })
    )
  );
  if (gone.length) await pool.query("delete from push_subs where endpoint = any($1)", [gone]);
  if (failed.length) {
    await pool.query("update push_subs set failures = failures + 1 where endpoint = any($1)", [failed]);
    await pool.query("delete from push_subs where failures >= 20");
    log(`push: ${failed.length} failed, will retry on the next alert`);
  }
  if (ok.length) await pool.query("update push_subs set failures = 0 where endpoint = any($1) and failures > 0", [ok]);
}
