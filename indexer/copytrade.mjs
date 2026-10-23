// Copying whales on Futures (copytrade.sql). whales.mjs watches traders every 30 s; when a
// trader someone copies opens, flips or closes a position, this places the same move for each
// copier with their own trading key (copy_agents, approved by them on Hyperliquid: it can trade,
// never withdraw):
//   - open:  the same side, the copier's own amount (per_trade) at the trader's leverage, capped
//            by the copier's max and the market's; skipped if the copier already holds that coin
//   - close: closes the copied position (only one the copy opened; never the copier's own)
//   - flip:  close, then open the new side
//   - adds and cuts are not copied
// Every order carries sasa's builder fee (0.07%). Each step is told to the copier as a
// notification (and a phone push, alerts.mjs).
//
// A copier's open copied positions are checked every minute against their stop: when they
// lose more than it together, they are closed and copying stops.
//
// Env:
//   COPY_KEY_SECRET   the same secret as on Cloudflare (decrypts the trading keys); unset: copying is off
//   HL_BUILDER        sasa's builder address (default the sasa admin)
//   SITE_URL          used in notification links

import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { decryptKey } from "./copykey.mjs";

const BUILDER = (process.env.HL_BUILDER || "0xe0ba5905940d748b23dc01266aa884e2391cca2f").toLowerCase();
const FEE_TENTHS_BP = 70;
const SLIP = 0.01;
const MIN_NOTIONAL = 11; // Hyperliquid's smallest order is $10: a little room for the price moving

const transport = new HttpTransport();
const infoClient = new InfoClient({ transport });
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** A coin amount: at most szDecimals decimals, rounded down. */
export function sizeString(coins, szDecimals) {
  const f = 10 ** szDecimals;
  const v = Math.floor(coins * f + 1e-9) / f;
  return v.toFixed(szDecimals).replace(/\.?0+$/, "") || "0";
}
/** A price: at most 5 significant digits and (6 − szDecimals) decimals. */
export function priceString(px, szDecimals) {
  if (!(px > 0)) return "0";
  if (Number.isInteger(px) && px >= 1e5) return String(px);
  return Number(px.toPrecision(5)).toFixed(Math.max(0, 6 - szDecimals)).replace(/\.?0+$/, "");
}
/** The copier's leverage: the trader's, capped by the copier's max and the market's, at least 1x. */
export function copyLeverage(traderLev, maxLev, marketMax) {
  const want = traderLev > 0 ? Math.round(traderLev) : maxLev;
  return Math.max(1, Math.min(want, maxLev, marketMax || 20, 20));
}

let meta = null;
let metaAt = 0;
async function markets() {
  if (meta && Date.now() - metaAt < 10 * 60e3) return meta;
  const m = await infoClient.meta();
  meta = new Map();
  m.universe.forEach((u, index) => {
    if (!u.isDelisted) meta.set(u.name, { index, sz: u.szDecimals, maxLev: u.maxLeverage });
  });
  metaAt = Date.now();
  return meta;
}

const clients = new Map();
async function clientFor(follower, keyEnc, secret) {
  const k = `${follower}:${keyEnc.slice(0, 16)}`;
  if (!clients.has(k)) {
    if (clients.size > 500) clients.clear();
    clients.set(k, new ExchangeClient({ transport, wallet: privateKeyToAccount(await decryptKey(keyEnc, secret)) }));
  }
  return clients.get(k);
}

const money = (v) => `$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : 2 })}`;
const quiet = new Map(); // follower:reason → last told (ms): the same problem told at most once an hour

async function tell(pool, owner, title, body, url) {
  await pool.query(`insert into notifications (owner, coin_id, kind, title, body, url, pushed) values ($1, null, 'copy', $2, $3, $4, false)`, [owner, title, body, url]).catch(() => {});
}
async function pause(pool, follower, whale, why) {
  await pool.query(`update copy_follows set active = false, paused_why = $3, updated_at = now() where follower = $1 and (whale = $2 or $2 is null)`, [follower, whale, why]).catch(() => {});
}

/** What went wrong, for the copier and for us. */
function reason(e) {
  const m = String(e?.message ?? e);
  if (/does not exist|api wallet|agent/i.test(m)) return { pause: "not approved", text: "Copying isn't approved on your account anymore. Turn it on again." };
  if (/builder fee has not been approved/i.test(m)) return { pause: "fees not approved", text: "Trading isn't approved on your account. Open Futures once and turn copying on again." };
  if (/insufficient margin|not enough/i.test(m)) return { pause: null, text: "Not enough in your futures balance for this one." };
  return { pause: null, text: null, raw: m.slice(0, 200) };
}

/**
 * Copies one trader's moves (from whaleChanges) for everyone copying them. `read`/`exchange`
 * are swapped in tests.
 */
export async function copyChanges(pool, whale, changes, { site = "https://sasapad.fun", log = () => {}, secret = process.env.COPY_KEY_SECRET, exchange = clientFor, info = infoClient, marketsOf = markets } = {}) {
  const acts = (changes || []).filter((c) => c.kind === "open" || c.kind === "close" || c.kind === "flip");
  if (!acts.length || !secret) return { placed: 0 };
  let rows;
  try {
    ({ rows } = await pool.query(
      `select f.follower, f.per_trade, f.max_lev, f.copy_closes, a.key_enc
       from copy_follows f join copy_agents a on a.follower = f.follower
       where f.whale = $1 and f.active`,
      [whale]
    ));
  } catch (e) {
    if (/copy_(follows|agents)/.test(e.message)) return { placed: 0 }; // copytrade.sql not run yet
    throw e;
  }
  if (!rows.length) return { placed: 0 };
  const mk = await marketsOf();
  const mids = await info.allMids();
  const url = `${site}/futures/`;
  let placed = 0;

  for (const r of rows) {
    let ex;
    try {
      ex = await exchange(r.follower, r.key_enc, secret);
    } catch (e) {
      log(`copy: key of ${r.follower}: ${e.message}`);
      continue;
    }
    let state = null;
    const stateNow = async () => (state ??= await info.clearinghouseState({ user: r.follower }));
    for (const c of acts) {
      const m = mk.get(c.coin);
      if (!m) continue; // a market sasa can't trade here (builder exchanges aren't copied)
      const mid = num(mids[c.coin]);
      try {
        // ---------------------------------------------------------------- close (and the first half of a flip)
        if (c.kind === "close" || c.kind === "flip") {
          const { rows: mine } = await pool.query(`select side from copy_positions where follower = $1 and coin = $2 and whale = $3`, [r.follower, c.coin, whale]);
          if (mine.length && (r.copy_closes || c.kind === "flip")) {
            const p = ((await stateNow()).assetPositions || []).map((a) => a.position).find((p) => p.coin === c.coin);
            const s = num(p?.szi);
            const side = s > 0 ? "long" : s < 0 ? "short" : null;
            if (side && side === mine[0].side && mid > 0) {
              const buy = side === "short";
              await ex.order({
                orders: [{ a: m.index, b: buy, p: priceString(mid * (buy ? 1 + 2 * SLIP : 1 - 2 * SLIP), m.sz), s: sizeString(Math.abs(s), m.sz), r: true, t: { limit: { tif: "Ioc" } } }],
                grouping: "na",
                builder: { b: BUILDER, f: FEE_TENTHS_BP },
              });
              placed++;
              const pnl = num(p?.unrealizedPnl);
              await tell(pool, r.follower, `🐋 Copied: closed your ${c.coin} ${side}`, `The trader closed theirs. About ${pnl >= 0 ? "+" : "−"}${money(pnl)}.`, url);
              state = null;
            }
            // closed by the copier themselves meanwhile: nothing left to copy
            await pool.query(`delete from copy_positions where follower = $1 and coin = $2`, [r.follower, c.coin]);
          }
          if (c.kind === "close") continue;
        }

        // ---------------------------------------------------------------- open (and the second half of a flip)
        const { rows: held } = await pool.query(`select 1 from copy_positions where follower = $1 and coin = $2`, [r.follower, c.coin]);
        if (held.length) continue; // already copying this coin (from another trader): no stacking
        const st = await stateNow();
        if ((st.assetPositions || []).some((a) => a.position?.coin === c.coin && num(a.position?.szi) !== 0)) continue; // their own position: left alone
        if (!(mid > 0)) continue;
        const margin = num(r.per_trade);
        const lev = copyLeverage(num(c.lev), num(r.max_lev), m.maxLev);
        if (margin * lev < MIN_NOTIONAL) continue;
        if (num(st.withdrawable) < margin * 1.01) {
          const k = `${r.follower}:money`;
          if (Date.now() - (quiet.get(k) || 0) > 3600e3) {
            quiet.set(k, Date.now());
            await tell(pool, r.follower, `🐋 Couldn't copy a ${c.coin} ${c.side}`, `Not enough in your futures balance (${money(num(st.withdrawable))}; each copy uses ${money(margin)}). Add money to keep copying.`, url);
          }
          continue;
        }
        const buy = c.side === "long";
        const size = sizeString((margin * lev) / mid, m.sz);
        if (!(Number(size) > 0)) continue;
        await ex.updateLeverage({ asset: m.index, isCross: false, leverage: lev });
        const res = await ex.order({
          orders: [{ a: m.index, b: buy, p: priceString(mid * (buy ? 1 + SLIP : 1 - SLIP), m.sz), s: size, r: false, t: { limit: { tif: "Ioc" } } }],
          grouping: "na",
          builder: { b: BUILDER, f: FEE_TENTHS_BP },
        });
        const first = res?.response?.data?.statuses?.[0];
        const filled = first && typeof first === "object" && "filled" in first ? first.filled : null;
        state = null;
        if (!filled || !(num(filled.totalSz) > 0)) continue; // the price ran away: not chased
        placed++;
        await pool.query(
          `insert into copy_positions (follower, whale, coin, side, size, entry) values ($1, $2, $3, $4, $5, $6)
           on conflict (follower, coin) do update set whale = excluded.whale, side = excluded.side, size = excluded.size, entry = excluded.entry, opened_at = now()`,
          [r.follower, whale, c.coin, c.side, num(filled.totalSz), num(filled.avgPx)]
        );
        await tell(pool, r.follower, `🐋 Copied: ${c.coin} ${c.side} ${lev}x`, `${money(margin)} at ${priceString(num(filled.avgPx), m.sz)}, like the trader you copy.`, url);
      } catch (e) {
        const why = reason(e);
        if (why.pause) {
          await pause(pool, r.follower, null, why.pause);
          await tell(pool, r.follower, "🐋 Copying stopped", why.text, `${site}/data/`);
          clients.clear();
          break;
        }
        if (why.text) {
          const k = `${r.follower}:${why.text}`;
          if (Date.now() - (quiet.get(k) || 0) > 3600e3) {
            quiet.set(k, Date.now());
            await tell(pool, r.follower, `🐋 Couldn't copy a ${c.coin} move`, why.text, url);
          }
        } else log(`copy: ${r.follower} ${c.kind} ${c.coin}: ${why.raw}`);
      }
    }
  }
  if (quiet.size > 20000) quiet.clear();
  return { placed };
}

/** Closes everything a copier copied, and stops their copying, once those positions lose more than their stop. */
export async function copyStopRound(pool, { site = "https://sasapad.fun", log = () => {}, secret = process.env.COPY_KEY_SECRET, exchange = clientFor, info = infoClient, marketsOf = markets } = {}) {
  if (!secret) return { stopped: 0 };
  let rows;
  try {
    ({ rows } = await pool.query(
      `select f.follower, min(f.stop_loss) as stop, a.key_enc
       from copy_follows f join copy_agents a on a.follower = f.follower
       where f.active and f.stop_loss is not null
         and exists (select 1 from copy_positions p where p.follower = f.follower)
       group by f.follower, a.key_enc`
    ));
  } catch (e) {
    if (/copy_(follows|agents|positions)/.test(e.message)) return { stopped: 0 };
    throw e;
  }
  let stopped = 0;
  for (const r of rows) {
    try {
      const { rows: mine } = await pool.query(`select coin, side from copy_positions where follower = $1`, [r.follower]);
      const st = await info.clearinghouseState({ user: r.follower });
      const open = (st.assetPositions || []).map((a) => a.position).filter((p) => mine.some((x) => x.coin === p.coin && x.side === (num(p.szi) > 0 ? "long" : "short")));
      const pnl = open.reduce((s, p) => s + num(p.unrealizedPnl), 0);
      if (!(pnl <= -num(r.stop))) continue;
      const ex = await exchange(r.follower, r.key_enc, secret);
      const mk = await marketsOf();
      const mids = await info.allMids();
      for (const p of open) {
        const m = mk.get(p.coin);
        const mid = num(mids[p.coin]);
        if (!m || !(mid > 0)) continue;
        const buy = num(p.szi) < 0;
        await ex
          .order({
            orders: [{ a: m.index, b: buy, p: priceString(mid * (buy ? 1 + 2 * SLIP : 1 - 2 * SLIP), m.sz), s: sizeString(Math.abs(num(p.szi)), m.sz), r: true, t: { limit: { tif: "Ioc" } } }],
            grouping: "na",
            builder: { b: BUILDER, f: FEE_TENTHS_BP },
          })
          .catch((e) => log(`copy stop: ${r.follower} ${p.coin}: ${e.message}`));
      }
      await pool.query(`delete from copy_positions where follower = $1`, [r.follower]);
      await pause(pool, r.follower, null, "stop reached");
      await tell(pool, r.follower, "🐋 Copying stopped: your stop was hit", `Your copied positions were down ${money(pnl)} together, past your ${money(num(r.stop))} stop. They were closed.`, `${site}/futures/`);
      stopped++;
    } catch (e) {
      log(`copy stop: ${r.follower}: ${String(e.message).slice(0, 200)}`);
    }
  }
  return { stopped };
}
