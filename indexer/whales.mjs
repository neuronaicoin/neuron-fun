// Data tab (data.sql):
//   - top traders: Hyperliquid's public leaderboard every 15 minutes → whales (top 100 by 30-day profit)
//   - Market Fear & Greed: one reading an hour → fear_greed (same formula as web/lib/feargreed.js)
//   - whale alerts: people following a trader get a 🔔 + phone push when that trader opens, adds to,
//     cuts, flips or closes a position (notifications with pushed = false; alerts.mjs sends the push)
//
// Env:
//   WHALES_OFF=1           switch this off
//   WHALE_ALERT_MS         time between looks at followed traders (default 30000)
//   SITE_URL               used in notification links (default https://sasapad.fun)

const HL_INFO = "https://api.hyperliquid.xyz/info";
const LEADERBOARD = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function info(body) {
  const r = await fetch(HL_INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
  return r.json();
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ------------------------------------------------------------------ top traders

/** The top `n` by 30-day profit, from the leaderboard's rows (accounts of $100K or more). */
export function pickWhales(rows, n = 100) {
  const out = [];
  for (const r of rows || []) {
    const addr = String(r && r.ethAddress || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
    const perf = Object.fromEntries((r.windowPerformances || []).filter((x) => Array.isArray(x) && x[1]).map((x) => [x[0], x[1]]));
    const month = perf.month || {};
    const account = num(r.accountValue);
    if (account < 100_000 || !(num(month.pnl) > 0)) continue;
    out.push({
      address: addr,
      name: typeof r.displayName === "string" && r.displayName.trim() ? r.displayName.trim().slice(0, 40) : null,
      account_value: account,
      pnl_day: num(perf.day && perf.day.pnl),
      pnl_week: num(perf.week && perf.week.pnl),
      pnl_month: num(month.pnl),
      pnl_all: num(perf.allTime && perf.allTime.pnl),
      roi_month: num(month.roi),
      vol_month: num(month.vlm),
    });
  }
  out.sort((a, b) => b.pnl_month - a.pnl_month);
  return out.slice(0, n).map((w, i) => ({ ...w, rank: i + 1 }));
}

export async function refreshWhales(pool, fetchRows = async () => (await (await fetch(LEADERBOARD)).json()).leaderboardRows) {
  const list = pickWhales(await fetchRows());
  if (!list.length) return 0;
  const db = await pool.connect();
  try {
    await db.query("begin");
    for (const w of list) {
      await db.query(
        `insert into whales (address, rank, name, account_value, pnl_day, pnl_week, pnl_month, pnl_all, roi_month, vol_month, listed, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,now())
         on conflict (address) do update set rank = excluded.rank, name = excluded.name, account_value = excluded.account_value,
           pnl_day = excluded.pnl_day, pnl_week = excluded.pnl_week, pnl_month = excluded.pnl_month, pnl_all = excluded.pnl_all,
           roi_month = excluded.roi_month, vol_month = excluded.vol_month, listed = true, updated_at = now()`,
        [w.address, w.rank, w.name, w.account_value, w.pnl_day, w.pnl_week, w.pnl_month, w.pnl_all, w.roi_month, w.vol_month]
      );
    }
    await db.query("update whales set listed = false where listed and not (address = any($1))", [list.map((w) => w.address)]);
    await db.query("commit");
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
  return list.length;
}

// ------------------------------------------------------------------ fear & greed (keep in step with web/lib/feargreed.js)

const clamp = (v) => Math.max(0, Math.min(1, v));
export function fearGreed(markets) {
  const top = (markets || [])
    .filter((m) => m && Number.isFinite(m.change24h) && m.volume24h > 0)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, 50);
  if (top.length < 5) return null;
  let w = 0, up = 0, move = 0, fund = 0, vw = 0;
  for (const m of top) {
    const sw = Math.sqrt(m.volume24h);
    w += sw;
    if (m.change24h > 0) up += sw;
    move += m.change24h * m.volume24h;
    fund += (Number(m.funding) || 0) * m.volume24h;
    vw += m.volume24h;
  }
  const btc = top.find((m) => m.coin === "BTC");
  const avgMove = move / vw;
  const fundingYear = (fund / vw) * 24 * 365 * 100;
  const parts = {
    breadth: clamp(up / w),
    bitcoin: clamp(((btc ? btc.change24h : avgMove) + 8) / 16),
    momentum: clamp((avgMove + 10) / 20),
    funding: clamp((fundingYear + 20) / 60),
  };
  const score = Math.round(100 * (0.3 * parts.breadth + 0.25 * parts.bitcoin + 0.2 * parts.momentum + 0.25 * parts.funding));
  return { score, parts };
}

/** Hyperliquid's markets as the formula reads them. */
export function marketsOf([meta, ctxs]) {
  const out = [];
  (meta && meta.universe || []).forEach((u, i) => {
    const c = ctxs && ctxs[i];
    if (!c || u.isDelisted) return;
    const mark = num(c.markPx);
    const prev = num(c.prevDayPx);
    if (mark <= 0 || prev <= 0) return;
    out.push({ coin: u.name, change24h: (mark / prev - 1) * 100, volume24h: num(c.dayNtlVlm), funding: num(c.funding) });
  });
  return out;
}

export async function saveFearGreed(pool, read = info) {
  const fg = fearGreed(marketsOf(await read({ type: "metaAndAssetCtxs" })));
  if (!fg) return null;
  await pool.query(
    `insert into fear_greed (t, score, parts) values (date_trunc('hour', now()), $1, $2)
     on conflict (t) do update set score = excluded.score, parts = excluded.parts`,
    [fg.score, JSON.stringify(fg.parts)]
  );
  return fg.score;
}

// ------------------------------------------------------------------ whale alerts

/** Positions as { coin: { s: signed size, v: dollars, e: entry, l: leverage } }. */
export function whalePositions(state) {
  const out = {};
  for (const a of (state && state.assetPositions) || []) {
    const p = a && a.position;
    const s = num(p && p.szi);
    if (!p || !p.coin || !s) continue;
    out[p.coin] = { s, v: Math.abs(num(p.positionValue)), e: num(p.entryPx), l: num(p.leverage && p.leverage.value) };
  }
  return out;
}

const money = (v) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(a / 1e3).toFixed(1)}K`;
  return `$${a.toFixed(0)}`;
};
const price = (p) => (p >= 1000 ? p.toLocaleString("en-US", { maximumFractionDigits: 0 }) : Number(p.toPrecision(5)).toLocaleString("en-US", { maximumSignificantDigits: 5 }));

/** What changed between two looks, as alert lines (changes under 20% of the size are left out). */
export function whaleChanges(before, now) {
  const out = [];
  const coins = new Set([...Object.keys(before || {}), ...Object.keys(now || {})]);
  for (const coin of coins) {
    const b = before[coin];
    const n = now[coin];
    const side = (p) => (p.s > 0 ? "long" : "short");
    // usd: how much the move was worth; px: the price it happened around (entry, or the mark now)
    const mark = (p) => (p.s ? p.v / Math.abs(p.s) : p.e);
    if (!b && n)
      out.push({ coin, kind: "open", side: side(n), usd: n.v, px: n.e, lev: n.l, title: `opened a new ${coin} ${side(n)}`, body: `${money(n.v)} at ${price(n.e)} · ${n.l}x` });
    else if (b && !n)
      out.push({ coin, kind: "close", side: side(b), usd: b.v, px: mark(b), lev: b.l, title: `closed their ${coin} ${side(b)}`, body: `It was ${money(b.v)}, entered at ${price(b.e)}.` });
    else if (b && n && Math.sign(b.s) !== Math.sign(n.s))
      out.push({ coin, kind: "flip", side: side(n), usd: n.v, px: n.e, lev: n.l, title: `flipped ${coin} to ${side(n)}`, body: `Now ${money(n.v)} ${side(n)} at ${price(n.e)} · ${n.l}x` });
    else if (b && n) {
      const ch = Math.abs(n.s) / Math.abs(b.s) - 1;
      const delta = Math.abs(Math.abs(n.s) - Math.abs(b.s)) * mark(n);
      if (ch >= 0.2)
        out.push({ coin, kind: "add", side: side(n), usd: delta, px: mark(n), lev: n.l, title: `added to their ${coin} ${side(n)}`, body: `Now ${money(n.v)} (+${Math.round(ch * 100)}%) · entry ${price(n.e)}` });
      else if (ch <= -0.2)
        out.push({ coin, kind: "cut", side: side(n), usd: delta, px: mark(n), lev: n.l, title: `cut their ${coin} ${side(n)}`, body: `Now ${money(n.v)} (${Math.round(ch * 100)}%)` });
    }
  }
  return out;
}

// the same trader and coin isn't announced more than once in 10 minutes (opens and closes always are)
const lastNote = new Map();

export async function whaleAlertRound(pool, { site = "https://sasapad.fun", read = info, now = Date.now(), topN = 30, log = () => {} } = {}) {
  const { rows } = await pool.query(
    // the top 30 traders (their moves go on the Data page) and everyone someone follows
    `select a.whale, s.positions, s.checked_at, w.name, w.rank
     from (select address as whale from whales where listed and rank <= $1
           union select whale from whale_follows) a
     left join whale_state s on s.address = a.whale
     left join whales w on w.address = a.whale and w.listed
     order by s.checked_at nulls first
     limit 150`,
    [topN]
  );
  let moves = 0;
  let sent = 0;
  for (const r of rows) {
    let pos;
    try {
      pos = whalePositions(await read({ type: "clearinghouseState", user: r.whale }));
    } catch {
      continue; // next round
    }
    // a first look, or the first in a while (nobody followed them for a time): what they hold now
    // is the starting point, not news
    // (15 minutes: with many traders watched, a round checks 150 of them, the longest-unchecked first)
    const first = !r.checked_at || now - new Date(r.checked_at).getTime() > 15 * 60e3;
    const changes = first ? [] : whaleChanges(r.positions || {}, pos);
    const who = r.name || (r.rank ? `Whale #${r.rank}` : `Trader ${r.whale.slice(0, 6)}…${r.whale.slice(-4)}`);
    // the same coin: an open or close at most every 2 minutes, other changes every 10
    let notes = changes.filter((c) => {
      const big = c.kind === "open" || c.kind === "close";
      const k = `${r.whale}:${c.coin}:${big ? c.kind : "change"}`;
      const gap = big ? 2 * 60e3 : 10 * 60e3;
      if (now - (lastNote.get(k) || 0) < gap) return false;
      lastNote.set(k, now);
      return true;
    });
    // a busy trader (a bot moving many coins at once): one summary instead of a flood
    if (notes.length > 3)
      notes = [
        {
          coin: "*",
          kind: "many",
          title: `made ${notes.length} moves`,
          body: notes
            .slice(0, 4)
            .map((c) => `${c.title.replace(/^(opened a new|closed their|added to their|cut their|flipped) /, (m) => m.split(" ")[0] + " ")}`)
            .join(", ") + (notes.length > 4 ? "…" : ""),
        },
      ];
    if (lastNote.size > 20000) lastNote.clear();
    const db = await pool.connect();
    try {
      await db.query("begin");
      for (const c of notes) {
        const res = await db.query(
          `insert into notifications (owner, coin_id, kind, title, body, url, pushed)
           select follower, null, 'whale', $2, $3, $4, false from whale_follows where whale = $1`,
          [r.whale, `🐋 ${who} ${c.title}`, c.body, `${site}/data/whale/?a=${r.whale}`]
        );
        sent += res.rowCount || 0;
      }
      await db.query(
        `insert into whale_state (address, positions, checked_at) values ($1, $2, now())
         on conflict (address) do update set positions = excluded.positions, checked_at = now()`,
        [r.whale, JSON.stringify(pos)]
      );
      await db.query("commit");
    } catch (e) {
      await db.query("rollback").catch(() => {});
      throw e;
    } finally {
      db.release();
    }
    // every move of a top trader (not only the ones told by alert) goes on the public list;
    // someone only followed stays off it (who sasa users follow isn't shown to anyone)
    if (changes.length && r.rank && r.rank <= topN) {
      for (const c of changes) {
        if (![c.usd, c.px, c.lev].every(Number.isFinite)) continue;
        try {
          await pool.query(`insert into whale_moves (address, coin, kind, side, usd, px, lev) values ($1,$2,$3,$4,$5,$6,$7)`, [
            r.whale,
            c.coin,
            c.kind,
            c.side,
            Math.round(c.usd * 100) / 100,
            c.px,
            c.lev,
          ]);
          moves++;
        } catch (e) {
          const k = e.message.slice(0, 80);
          if (!movesWarned.has(k)) log(`whales: moves: ${e.message}${/whale_moves/.test(e.message) ? " (run indexer/data.sql again)" : ""}`);
          movesWarned.add(k);
        }
      }
    }
  }
  return { checked: rows.length, sent, moves };
}
const movesWarned = new Set();

/** Old moves go (a week is kept). */
export async function pruneMoves(pool) {
  await pool.query("delete from whale_moves where t < now() - interval '7 days'");
}

export async function whalesLoop(pool, log) {
  if (process.env.WHALES_OFF === "1") return;
  const every = Number(process.env.WHALE_ALERT_MS ?? "30000");
  const site = (process.env.SITE_URL || "https://sasapad.fun").replace(/\/$/, "");
  let lastBoard = 0;
  let lastFg = 0;
  const warned = new Set();
  const warn = (k, e) => {
    const missing = /relation "(whales|fear_greed|whale_follows|whale_state)" does not exist/.test(e.message);
    if (!warned.has(k)) log(`whales: ${k}: ${e.message}${missing ? " (run indexer/data.sql)" : ""}`);
    warned.add(k);
    return missing;
  };
  for (;;) {
    const started = Date.now();
    let missing = false;
    if (Date.now() - lastBoard > 15 * 60e3) {
      try {
        const n = await refreshWhales(pool);
        lastBoard = Date.now();
        warned.delete("leaderboard");
        if (n) log(`whales: ${n} top traders`);
      } catch (e) {
        missing = warn("leaderboard", e) || missing;
        lastBoard = Date.now() - 10 * 60e3; // again in 5 minutes
      }
    }
    if (Date.now() - lastFg > 60 * 60e3 - 60e3 || new Date().getMinutes() === 0) {
      try {
        await saveFearGreed(pool);
        lastFg = Date.now();
        warned.delete("fear & greed");
      } catch (e) {
        missing = warn("fear & greed", e) || missing;
      }
    }
    try {
      await whaleAlertRound(pool, { site, log });
      warned.delete("alerts");
      if (new Date().getMinutes() === 30) await pruneMoves(pool).catch(() => {});
    } catch (e) {
      missing = warn("alerts", e) || missing;
    }
    await sleep(missing ? 10 * 60e3 : Math.max(5_000, every - (Date.now() - started)));
  }
}
