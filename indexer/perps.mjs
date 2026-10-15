// Perps alerts: a 🔔 notification and a phone push when a perps position on Hyperliquid is
// closed by its take profit, its stop loss, or a liquidation.
//
// Who is watched: people who opened a position on sasa's Perps screen while signed in
// (POST /api/perps/watch puts them in perps_watch, see perps.sql). Each round reads their
// positions (Hyperliquid's free info API, 2 weight each); when a position is gone or smaller, it
// reads the fills since the last look and tells what closed it. Someone with no position for a
// day stops being watched until they open one again. Notifications are written with
// pushed = false; alerts.mjs sends the push.
//
// Env:
//   PERPS_OFF=1          switch this off
//   PERPS_EVERY_MS       time between rounds (default 20000)
//   PERPS_BATCH          addresses read per round (default 100; Hyperliquid allows 1200 weight a minute per IP)
//   SITE_URL             used in notification links (default https://sasapad.fun)

const HL_INFO = "https://api.hyperliquid.xyz/info";
const DAY = 24 * 3600e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function info(body, tries = 2) {
  for (let i = 0; ; i++) {
    const r = await fetch(HL_INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch((e) => e);
    if (r instanceof Response && r.ok) return r.json();
    if (i + 1 >= tries) throw new Error(r instanceof Response ? `hyperliquid ${r.status}` : `hyperliquid: ${r && r.message}`);
    await sleep(r instanceof Response && r.status === 429 ? 5000 : 1000);
  }
}

/** Open positions as { coin: { s: signed size, e: entry price } }. */
export function positionsOf(state) {
  const out = {};
  for (const a of (state && state.assetPositions) || []) {
    const p = a && a.position;
    const sz = Number(p && p.szi);
    if (p && p.coin && Number.isFinite(sz) && sz !== 0) out[p.coin] = { s: sz, e: Number(p.entryPx) || 0 };
  }
  return out;
}

/**
 * True when anything about the positions changed since the last look (one closed, smaller,
 * bigger, new, or closed and opened again at another price): then the fills are read.
 */
export function changed(before, now) {
  const key = (m) =>
    JSON.stringify(
      Object.keys(m || {})
        .sort()
        .map((c) => [c, typeof m[c] === "number" ? m[c] : m[c].s, typeof m[c] === "number" ? 0 : m[c].e])
    );
  return key(before) !== key(now);
}

const money = (v) => `$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedMoney = (v) => `${v >= 0 ? "+" : "−"}${money(v)}`;
function price(p) {
  if (!(p > 0)) return "—";
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return Number(p.toPrecision(5)).toLocaleString("en-US", { maximumSignificantDigits: 5 });
}

/**
 * The closes worth telling about, from fills (oldest first). `typeOf(oid)` gives the order's
 * type ("Take Profit Market", "Stop Market", "Limit" …). One note per order.
 */
export async function closesFrom(fills, user, typeOf) {
  const me = user.toLowerCase();
  const byOrder = new Map();
  for (const f of fills || []) {
    if (!f || (!String(f.dir || "").startsWith("Close") && !f.liquidation)) continue;
    const liq = !!f.liquidation && (!f.liquidation.liquidatedUser || f.liquidation.liquidatedUser.toLowerCase() === me);
    const k = `${f.coin}:${f.oid}`;
    const g = byOrder.get(k) || { coin: f.coin, oid: f.oid, liq: false, sz: 0, notional: 0, pnl: 0, fee: 0, time: 0, long: String(f.dir || "").includes("Long") };
    const sz = Number(f.sz) || 0;
    g.sz += sz;
    g.notional += sz * (Number(f.px) || 0);
    g.pnl += Number(f.closedPnl) || 0;
    g.fee += Number(f.fee) || 0;
    g.time = Math.max(g.time, Number(f.time) || 0);
    g.liq = g.liq || liq;
    if (String(f.dir || "").includes("Short")) g.long = false;
    byOrder.set(k, g);
  }
  const out = [];
  for (const g of byOrder.values()) {
    let kind = null;
    if (g.liq) kind = "liq";
    else {
      // no answer from Hyperliquid: the whole look is tried again next round (nothing is lost)
      const t = String((await typeOf(g.oid)) || "");
      if (/take profit/i.test(t)) kind = "tp";
      else if (/stop/i.test(t)) kind = "sl";
    }
    if (!kind) continue; // closed by hand: they know
    const px = g.sz > 0 ? g.notional / g.sz : 0;
    const net = g.pnl - g.fee;
    const side = g.long ? "long" : "short";
    const title =
      kind === "tp" ? `Take profit hit: ${g.coin} ${side} closed` : kind === "sl" ? `Stop loss hit: ${g.coin} ${side} closed` : `${g.coin} ${side} was liquidated`;
    const body =
      kind === "liq"
        ? `Closed at ${price(px)}. The money in this position is gone.`
        : `Closed at ${price(px)}. ${net >= 0 ? "Profit" : "Loss"} ${signedMoney(net)}.`;
    out.push({ kind, coin: g.coin, oid: g.oid, time: g.time, title, body });
  }
  return out.sort((a, b) => a.time - b.time);
}

async function orderType(user, oid) {
  const r = await info({ type: "orderStatus", user, oid: Number(oid) });
  return r && r.status === "order" && r.order && r.order.order ? r.order.order.orderType : "";
}

/** One look at one address: writes notes, returns the row's new values. */
export async function checkOne(row, { site, read = info, typeOf = orderType, now = Date.now() } = {}) {
  const user = row.address;
  const state = await read({ type: "clearinghouseState", user });
  const pos = positionsOf(state);
  const before = row.positions || {};
  const first = !Number(row.last_fill);
  const notes = [];
  // closes from before they signed up (5 minutes of room) aren't news; a first look reads from
  // there too, so a TP that hit before it is still told
  const seen = row.seen_at ? new Date(row.seen_at).getTime() : 0;
  const floor = seen ? Math.min(now, seen) - 5 * 60_000 : now;
  let lastFill = Math.max(Number(row.last_fill) || 0, floor);
  if (first || changed(before, pos)) {
    const fills = await read({ type: "userFillsByTime", user, startTime: lastFill + 1, endTime: now + 60_000, aggregateByTime: true });
    const list = Array.isArray(fills) ? fills.filter((f) => Number(f.time) > lastFill) : [];
    for (const c of await closesFrom(list, user, (oid) => typeOf(user, oid))) {
      notes.push({ owner: user, kind: `perps-${c.kind}`, title: c.title, body: c.body, url: `${site}/perps/?c=${encodeURIComponent(c.coin)}` });
    }
    for (const f of list) lastFill = Math.max(lastFill, Number(f.time) || 0);
  }
  const open = Object.keys(pos).length > 0;
  const idleSince = open ? null : row.idle_since ? new Date(row.idle_since).getTime() : now;
  return { notes, positions: pos, lastFill, idleSince, active: open || now - idleSince < DAY };
}

export async function perpsRound(pool, log, { batch = 100, site = "https://sasapad.fun", read = info, typeOf = orderType } = {}) {
  const { rows } = await pool.query(
    `select address, positions, last_fill, idle_since, seen_at from perps_watch where active order by checked_at nulls first limit $1`,
    [batch]
  );
  let sent = 0;
  for (const row of rows) {
    let r;
    try {
      r = await checkOne(row, { site, read, typeOf });
    } catch (e) {
      // Hyperliquid busy: this address waits for the next round
      await pool.query("update perps_watch set checked_at = now() where address = $1", [row.address]);
      if (!/429/.test(String(e.message))) log(`perps: ${row.address.slice(0, 8)} ${e.message}`);
      continue;
    }
    const db = await pool.connect();
    try {
      await db.query("begin");
      for (const n of r.notes) {
        await db.query(`insert into notifications (owner, coin_id, kind, title, body, url, pushed) values ($1, null, $2, $3, $4, $5, false)`, [
          n.owner,
          n.kind,
          n.title,
          n.body,
          n.url,
        ]);
      }
      await db.query(
        `update perps_watch set positions = $2, last_fill = $3, idle_since = $4, active = ($5 or seen_at > now() - interval '1 day'), checked_at = now() where address = $1`,
        [row.address, JSON.stringify(r.positions), r.lastFill, r.idleSince ? new Date(r.idleSince) : null, r.active]
      );
      await db.query("commit");
      sent += r.notes.length;
    } catch (e) {
      await db.query("rollback").catch(() => {});
      throw e;
    } finally {
      db.release();
    }
  }
  return { checked: rows.length, sent };
}

export async function perpsLoop(pool, log) {
  if (process.env.PERPS_OFF === "1") return;
  const every = Number(process.env.PERPS_EVERY_MS ?? "20000");
  const batch = Number(process.env.PERPS_BATCH ?? "100");
  const site = (process.env.SITE_URL || "https://sasapad.fun").replace(/\/$/, "");
  let warned = false;
  for (;;) {
    const started = Date.now();
    try {
      await perpsRound(pool, log, { batch, site });
      warned = false;
    } catch (e) {
      // perps.sql not run yet: check again in a while, quietly
      const missing = /relation "perps_watch" does not exist|column "pushed" does not exist/.test(e.message);
      if (!warned) log(`perps: ${e.message}${missing ? " (run indexer/perps.sql)" : ""}`);
      warned = true;
      if (missing) {
        await sleep(10 * 60_000);
        continue;
      }
    }
    await sleep(Math.max(2_000, every - (Date.now() - started)));
  }
}
