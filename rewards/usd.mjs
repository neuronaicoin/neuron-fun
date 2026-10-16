// Invite rewards counted in dollars, paid once a day in USDC on Base from the rewards wallet.
//
// An invited friend's trades earn the inviter 25% (REFERRAL_BPS) of the fee sasa really received
// from them, for 12 months (REFERRAL_MONTHS) from the invite:
//   race coins (sasa v7)  sasa's 70% (PROTOCOL_BPS) of the pool fees the builder collected,
//                         shared out over the buys they came from (each buy's fee at that moment:
//                         10% at the open, sliding to 2% after two minutes; first buy 2%). The fee
//                         on a sell is paid in the coin itself and isn't counted. If someone else
//                         adds liquidity to the pool and takes part of the fees, less is collected
//                         and every share shrinks with it: rewards never exceed what sasa got.
//   other DEXs' coins     the fee Relay paid sasa's treasury on that trade (ext_trades.fee_usd)
//   futures               sasa's builder fee on the fill, from Hyperliquid's own daily file of
//                         sasa's fills (builder_fills), all of it sasa's
//
// Ledger rows: chain_id 845300 (USD_BUCKET), amount in USDC units (6 decimals), so they never
// mix with the older per-chain rewards. Every row is keyed by the trade, so reading the same
// trades again never counts them twice.
//
// Paying: once a day, each wallet owed at least MIN_PAYOUT_USD gets one USDC transfer. The
// signed transfer is saved before it is sent (a crash can't pay twice), rows are marked paid only
// when the chain confirms it, and never more than DAILY_CAP_USD or the wallet's USDC is paid.
// When the wallet can't cover what's owed, an alert says how much to add; the rest waits.
//
// Env: USD_PAYOUT  JSON { rpc, token } (Base RPC, USDC on Base); without it nothing is paid
//      REWARD_CHAIN_IDS  race chains that count (default the mainnets: 8453,4663,5042,56)
//      HL_BUILDER (sasa's futures fee address), HL_FILLS (builder_fills base URL)

import { encodeFunctionData, getAddress, keccak256, parseAbi, parseTransaction } from "viem";

export const USD_BUCKET = 845300;
const LOOKBACK = "3 days"; // collections / trades written late by the indexer or the site are still picked up

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address, uint256) returns (bool)",
]);

/** The hook's fee on a buy at time t (SQL): 10% at the open, sliding to 2% at two minutes. */
const RATE = `(case when t.via in ('launch', 'system') or c.launched_at is null then 0.02
                    else greatest(0.02, 0.10 - 0.08 * least(1, greatest(0, extract(epoch from (t.ts - c.launched_at)) / 120))) end)`;

/** Race-coin and other-DEX trades of invited friends -> ledger rows (dollars). */
export async function buildUsdLedger(pool, { protocolBps, referralBps, months, chainIds }) {
  // Each fee collection paid for the buys since the one before it (on that coin and chain). Only
  // collections the indexer has fully read past (race_state) are shared out, so all their buys
  // are in. A buy's share: its own fee x (collected / every buy's fee in that stretch), at most 1.
  const race = await pool.query(
    `insert into reward_ledger (owner, kind, chain_id, trade_tx, log_index, source, amount)
     with f as (
       select rf.chain_id, rf.coin_id, rf.block_number as b, rf.log_index as li, rf.native_amount as got, rf.created_at,
              lag(rf.block_number) over w as pb, lag(rf.log_index) over w as pl
       from race_fees rf
       where rf.block_number is not null and rf.chain_id = any($5::int[])
       window w as (partition by rf.coin_id, rf.chain_id order by rf.block_number, rf.log_index)
     ),
     ready as (
       select f.* from f join race_state s on s.chain_id = f.chain_id
       where s.last_block >= f.b and f.created_at > now() - interval '${LOOKBACK}' and f.got > 0
     ),
     tr as (
       select t.chain_id, t.tx_hash, t.log_index, t.trader, t.via, t.ts, t.usd_amount, t.native_amount,
              rd.coin_id, rd.b, rd.li, rd.got, ${RATE} as rate
       from ready rd
       join race_trades t on t.coin_id = rd.coin_id and t.chain_id = rd.chain_id and t.is_buy
            and (t.block_number, t.log_index) <= (rd.b, rd.li)
            and (rd.pb is null or (t.block_number, t.log_index) > (rd.pb, rd.pl))
       left join race_chains c on c.coin_id = t.coin_id and c.chain_id = t.chain_id
     ),
     n as (
       select coin_id, chain_id, b, li, sum(native_amount * rate) as nominal from tr group by coin_id, chain_id, b, li
     )
     select r.referrer, 'referral', $1, tr.chain_id || ':' || tr.tx_hash, tr.log_index, tr.trader,
            floor(tr.usd_amount * 1000000 * tr.rate * least(1, tr.got / n.nominal) * $2::numeric / 10000 * $3::numeric / 10000)
     from tr
     join n on n.coin_id = tr.coin_id and n.chain_id = tr.chain_id and n.b = tr.b and n.li = tr.li
     join referrals r on r.referee = tr.trader
     where tr.via <> 'system' and n.nominal > 0 and tr.usd_amount > 0
       and tr.ts >= r.created_at
       and tr.ts < r.created_at + make_interval(months => $4::int)
     on conflict do nothing`,
    [USD_BUCKET, String(protocolBps), String(referralBps), months, chainIds]
  );
  // Other DEXs' coins: the fee Relay paid sasa on the trade (all of it sasa's), counted from when
  // the trade was made.
  const ext = await pool.query(
    `insert into reward_ledger (owner, kind, chain_id, trade_tx, log_index, source, amount)
     select r.referrer, 'referral', $1, 'ext:' || e.chain_id || ':' || e.tx, 0, e.trader,
            floor(e.fee_usd * 1000000 * $2::numeric / 10000)
     from ext_trades e
     join referrals r on r.referee = e.trader
     where e.created_at > now() - interval '${LOOKBACK}'
       and e.fee_usd > 0
       and coalesce(e.traded_at, e.created_at) >= r.created_at
       and coalesce(e.traded_at, e.created_at) < r.created_at + make_interval(months => $3::int)
     on conflict do nothing`,
    [USD_BUCKET, String(referralBps), months]
  );
  return { race: race.rowCount, ext: ext.rowCount };
}

/** A CSV line split into fields (plain commas; a quoted field may hold commas). */
function fields(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") out.push(cur), (cur = "");
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

const toMs = (v, fallback) => {
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return n > 1e12 ? n : n * 1000;
  }
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isFinite(t) ? t : fallback;
};

/** Rows of a builder_fills CSV that carry sasa's futures fee: { line, user, fee, time }. */
export function parseBuilderFills(text, dayStartMs) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return [];
  const head = fields(lines[0]).map((h) => h.toLowerCase());
  const col = (...names) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const iUser = col("user");
  const iFee = col("builder_fee", "builderfee");
  const iCoin = col("coin");
  const iTime = col("time", "timestamp");
  if (iUser < 0 || iFee < 0) throw new Error(`builder fills: unexpected columns (${head.join(",")})`);
  const out = [];
  for (let n = 1; n < lines.length; n++) {
    const f = fields(lines[n]);
    const user = String(f[iUser] ?? "").toLowerCase();
    const fee = Number(f[iFee]);
    if (!/^0x[0-9a-f]{40}$/.test(user) || !(fee > 0)) continue;
    const coin = iCoin >= 0 ? String(f[iCoin] ?? "") : "";
    if (coin.startsWith("@") || coin.includes("/")) continue; // spot: its fee isn't in USDC
    // without a readable time, the start of the day (so it never counts before the invite)
    out.push({ line: n, user, fee, time: iTime >= 0 ? toMs(String(f[iTime] ?? ""), dayStartMs) : dayStartMs });
  }
  return out;
}

/**
 * Futures: Hyperliquid publishes every day's fills that paid sasa's builder fee
 * (stats-data.hyperliquid.xyz/Mainnet/builder_fills/<builder>/<YYYYMMDD>.csv.lz4). Each finished
 * day is read once, from 6 hours after it ends. A day whose file isn't there yet is looked at
 * again on later runs for 7 days (marked fills = -1 meanwhile) without holding up the days after
 * it; after 7 days without a file it counts as a day with no fills, and an alert says so.
 * Returns { fills, days, missing } (missing: days given up on).
 */
export async function buildPerpLedger(pool, { builder, base = "https://stats-data.hyperliquid.xyz/Mainnet/builder_fills", referralBps, months, decompress, fetchFn = fetch, now = Date.now(), maxDays = 4 }) {
  if (!builder) return { fills: 0, days: 0, missing: [] };
  const DAY = 86_400_000;
  const { rows } = await pool.query("select day::text as day, fills from reward_perp_days where day > ($1::date - 12)", [new Date(now).toISOString().slice(0, 10)]);
  const seen = new Map(rows.map((r) => [r.day, Number(r.fills)]));
  const first = (await pool.query("select min(day)::text as d from reward_perp_days")).rows[0]?.d;
  // nothing read yet: start two days back (rewards start with mainnet, not before)
  const start = Math.max(first ? Date.parse(`${first}T00:00:00Z`) : Math.floor(now / DAY) * DAY - 2 * DAY, Math.floor(now / DAY) * DAY - 10 * DAY);
  let fills = 0;
  let days = 0;
  const missing = [];
  for (let day = start; days < maxDays && day + DAY + 6 * 3_600_000 <= now; day += DAY) {
    const ymd = new Date(day).toISOString().slice(0, 10);
    const had = seen.get(ymd);
    if (had !== undefined && had >= 0) continue; // read already
    const url = `${base}/${builder.toLowerCase()}/${ymd.replaceAll("-", "")}.csv.lz4`;
    const r = await fetchFn(url);
    let found = [];
    let mark;
    if (r.ok) {
      const text = Buffer.from(decompress(new Uint8Array(await r.arrayBuffer()))).toString("utf8");
      found = parseBuilderFills(text, day);
      mark = found.length;
    } else if (r.status === 404 || r.status === 403) {
      if (day + 8 * DAY > now) {
        // not there (yet): try again on a later run
        if (had === undefined) await pool.query("insert into reward_perp_days (day, fills) values ($1, -1) on conflict (day) do nothing", [ymd]);
        days++;
        continue;
      }
      mark = 0;
      missing.push(ymd);
    } else {
      throw new Error(`builder fills ${ymd}: ${r.status}`);
    }
    days++;
    const db = await pool.connect();
    try {
      await db.query("begin");
      const users = [...new Set(found.map((x) => x.user))];
      const refs = users.length
        ? (await db.query("select referee, referrer, created_at from referrals where referee = any($1::text[])", [users])).rows
        : [];
      const by = new Map(refs.map((x) => [x.referee, x]));
      let added = 0;
      for (const x of found) {
        const ref = by.get(x.user);
        if (!ref) continue;
        const from = new Date(ref.created_at).getTime();
        if (x.time < from || x.time >= from + months * 30.44 * DAY) continue;
        const amount = Math.floor((x.fee * 1e6 * referralBps) / 10000);
        if (amount <= 0) continue;
        const ins = await db.query(
          `insert into reward_ledger (owner, kind, chain_id, trade_tx, log_index, source, amount)
           values ($1, 'referral', $2, $3, $4, $5, $6) on conflict do nothing`,
          [ref.referrer, USD_BUCKET, `hlb:${ymd}`, x.line, x.user, amount]
        );
        added += ins.rowCount;
      }
      await db.query(
        "insert into reward_perp_days (day, fills) values ($1, $2) on conflict (day) do update set fills = excluded.fills, read_at = now() where reward_perp_days.fills < 0",
        [ymd, mark]
      );
      await db.query("commit");
      fills += added;
    } catch (e) {
      await db.query("rollback");
      throw e;
    } finally {
      db.release();
    }
  }
  return { fills, days, missing };
}

/** Settles USDC payouts left "sent" (e.g. after a restart): re-sends, or marks paid / unpaid. */
export async function reconcileUsd(pool, c, log, account) {
  const { rows } = await pool.query(
    "select id, tx_hash, raw_tx, created_at from reward_payouts where chain_id = $1 and status = 'sent' order by id",
    [USD_BUCKET]
  );
  for (const p of rows) {
    const receipt = await c.pub.getTransactionReceipt({ hash: p.tx_hash }).catch(() => null);
    if (!receipt) {
      const age = Date.now() - new Date(p.created_at).getTime();
      if (age > 10 * 60_000) {
        // its nonce was used by another transaction: this one can never be mined, owe it again
        const used = account ? await c.pub.getTransactionCount({ address: account.address, blockTag: "latest" }).catch(() => null) : null;
        if (used !== null && age > 30 * 60_000 && parseTransaction(p.raw_tx).nonce < used) {
          // ask once more, and only a clear "no such receipt" counts (an RPC hiccup never does)
          let again;
          try {
            again = await c.pub.getTransactionReceipt({ hash: p.tx_hash });
          } catch (e) {
            if (e?.name === "TransactionReceiptNotFoundError") again = { status: "dropped" };
            else continue;
          }
          await settleUsd(pool, p.tx_hash, again, log);
          continue;
        }
        await c.pub.sendRawTransaction({ serializedTransaction: p.raw_tx }).catch(() => {});
        log(`usd: re-sent payout ${p.tx_hash}`);
      }
      continue;
    }
    await settleUsd(pool, p.tx_hash, receipt, log);
  }
}

async function settleUsd(pool, hash, receipt, log) {
  const ok = receipt.status === "success";
  const db = await pool.connect();
  try {
    await db.query("begin");
    if (ok) {
      await db.query("update reward_ledger set paid_at = now() where paid_tx = $1 and paid_at is null", [hash]);
      await db.query("update reward_payouts set status = 'confirmed' where tx_hash = $1", [hash]);
    } else {
      await db.query("update reward_ledger set paid_tx = null, paid_at = null where paid_tx = $1", [hash]);
      await db.query("update reward_payouts set status = 'failed' where tx_hash = $1", [hash]);
    }
    await db.query("commit");
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    db.release();
  }
  log(`usd: payout ${hash} ${ok ? "confirmed" : "failed, owed again"}`);
}

/**
 * Pays what's owed in USDC on Base, once a day. Returns { paid, short } (short: USDC units the
 * wallet was missing; the caller alerts).
 */
export async function payUsd(pool, c, account, { minUsd, capUsd, minGasWei, log, dry = false }) {
  const today = new Date().toISOString().slice(0, 10);
  const done = await pool.query("select 1 from reward_payouts where chain_id = $1 and day = $2 and status <> 'failed' limit 1", [USD_BUCKET, today]);
  if (done.rowCount) return { paid: 0, short: 0n, skipped: "today" };

  const min = BigInt(Math.round(minUsd * 1e6));
  const { rows } = await pool.query(
    `select owner, sum(amount)::text as owed, array_agg(id) as ids
     from reward_ledger where chain_id = $1 and paid_tx is null
     group by owner having sum(amount) >= $2::numeric
     order by min(created_at)`,
    [USD_BUCKET, min.toString()]
  );
  if (!rows.length) return { paid: 0, short: 0n };

  const gas = await c.pub.getBalance({ address: account.address });
  if (gas < minGasWei) return { paid: 0, short: 0n, noGas: true };
  const have = await c.pub.readContract({ address: c.token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  const cap = BigInt(Math.round(capUsd * 1e6));
  let budget = have < cap ? have : cap;

  let paid = 0;
  let total = 0n;
  const refused = [];
  let waiting = 0n; // owed, but more than the wallet had left
  for (const r of rows) {
    const amount = BigInt(r.owed.split(".")[0]);
    if (amount > budget) {
      waiting += amount;
      continue;
    }
    if (dry) {
      log(`[dry] usd: would pay ${getAddress(r.owner)} ${Number(amount) / 1e6} USDC`);
      budget -= amount;
      total += amount;
      paid++;
      continue;
    }
    const to = getAddress(r.owner);
    let prepared;
    try {
      prepared = await c.wallet.prepareTransactionRequest({
        to: c.token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
      });
    } catch (e) {
      // a wallet USDC won't send to (e.g. on its blocklist): skip it, never hold up everyone else
      refused.push(to);
      log(`usd: can't pay ${to} (${e.shortMessage ?? e.message}); skipped`);
      continue;
    }
    const raw = await c.wallet.signTransaction(prepared);
    const hash = keccak256(raw);
    // saved before sending: what makes a crash unable to pay twice. Every row must still be
    // unpaid here; if another run took any of them first, this transfer is never sent.
    const db = await pool.connect();
    let claimed = false;
    try {
      await db.query("begin");
      const u = await db.query("update reward_ledger set paid_tx = $1 where id = any($2::bigint[]) and paid_tx is null", [hash, r.ids]);
      if (u.rowCount === r.ids.length) {
        await db.query(
          "insert into reward_payouts (chain_id, tx_hash, raw_tx, total, recipients, day) values ($1, $2, $3, $4, 1, $5)",
          [USD_BUCKET, hash, raw, amount.toString(), today]
        );
        await db.query("commit");
        claimed = true;
      } else {
        await db.query("rollback");
      }
    } catch (e) {
      await db.query("rollback");
      throw e;
    } finally {
      db.release();
    }
    if (!claimed) {
      log(`usd: ${to}'s rewards were taken by another run; not paid twice`);
      continue;
    }
    budget -= amount;
    total += amount;
    await c.pub.sendRawTransaction({ serializedTransaction: raw }).catch((e) => {
      if (!/already known|nonce too low/i.test(e.shortMessage ?? e.message)) throw e;
    });
    const receipt = await c.pub.waitForTransactionReceipt({ hash, timeout: 180_000 }).catch(() => null);
    if (receipt) await settleUsd(pool, hash, receipt, log);
    paid++;
  }
  const short = waiting;
  log(`usd: paid ${paid} of ${rows.length} wallet(s), ${Number(total) / 1e6} USDC${short ? `; ${Number(short) / 1e6} USDC still owed` : ""}`);
  return { paid, short, capped: have >= cap && short > 0n, refused };
}

async function hl(api, body, fetchFn) {
  const r = await fetchFn(`${api}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
  return r.json();
}

/** Dollars in sasa's futures fee account on Hyperliquid (it must keep at least 100 for the fee to work). */
export async function builderAccountUsd(api, builder, fetchFn = fetch) {
  const s = await hl(api, { type: "clearinghouseState", user: builder.toLowerCase() }, fetchFn);
  const v = Number(s?.marginSummary?.accountValue);
  return Number.isFinite(v) ? v : null;
}
