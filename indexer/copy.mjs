// Copy trading signals: when a trader who allows copying buys or sells, every
// follower copying them gets a signal (copy_signals) and a 🔔 with web push.
// The follower applies or rejects it on the site; nothing trades by itself.
//
// Rules:
//  - no signals for trades in a coin the trader created (can't pump your own coin to copiers)
//  - no signals from traders who hide their trades
//  - sells go only to copiers who hold that coin and copy sells
//  - several buys of the same coin within 10 minutes become one signal
//  - signals nobody acts on expire after 24 hours
//
// Env: SITE_URL (default https://sasapad.fun), COPY_EVERY_MS (default 5000)

import { gasPrices, money, usdPerE18 } from "./alerts.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_SUGGEST_USD = 1;

export async function copyLoop(pool, log) {
  const every = Number(process.env.COPY_EVERY_MS ?? "5000");
  const site = (process.env.SITE_URL ?? "https://sasapad.fun").replace(/\/$/, "");
  let warned = false;
  let lastExpire = 0;
  for (;;) {
    try {
      const made = await makeSignals(pool, site);
      if (made) log(`copy: ${made} signals`);
      if (Date.now() - lastExpire > 60_000) {
        lastExpire = Date.now();
        await pool.query("update copy_signals set status = 'expired' where status = 'pending' and created_at < now() - interval '24 hours'");
        await pool.query("delete from copy_signals where status in ('expired', 'rejected') and created_at < now() - interval '60 days'");
      }
      warned = false;
    } catch (e) {
      if (/relation "copy_(follows|signals)" does not exist|column .*allow_copy/.test(e.message)) {
        if (!warned) log("copy trading off: run indexer/copy.sql in Supabase");
        warned = true;
        await sleep(60_000);
        continue;
      }
      log(`copy: ${e.message}`);
    }
    await sleep(every);
  }
}

export async function makeSignals(pool, site) {
  // Recent trades by copyable traders. Signals are unique per (follower, trade),
  // so reading the last few minutes again never makes duplicates.
  const { rows: trades } = await pool.query(
    `select t.chain_id, t.tx_hash, t.curve, t.coin_id, t.trader, t.is_buy,
            t.native_amount::text as native, t.token_amount::text as tokens,
            case when t.token_amount > 0 then (t.native_amount / t.token_amount)::float8 else 0 end as px,
            c.symbol, c.name, p.username
     from trades t
     join profiles p on p.address = t.trader and p.allow_copy and not p.hide_trades
     join coins c on c.id = t.coin_id
     where t.ts > now() - interval '10 minutes'
       and lower(c.creator) <> t.trader
       and exists (select 1 from copy_follows f where f.trader = t.trader)
     order by t.ts asc
     limit 300`
  );
  if (!trades.length) return 0;
  const prices = await gasPrices().catch(() => null);
  let made = 0;

  for (const t of trades) {
    const px = usdPerE18(t.chain_id, prices);
    const traderUsd = px ? (Number(t.native) / 1e18) * px : null;
    const who = t.username ? `@${t.username}` : `${t.trader.slice(0, 6)}…${t.trader.slice(-4)}`;

    // Share of their holding the trader sold (their balance after, on this chain).
    let sellPct = null;
    if (!t.is_buy) {
      const { rows: b } = await pool.query(
        `select coalesce(sum(bl.amount), 0)::text as left
         from balances bl join curves k on k.chain_id = bl.chain_id and k.token = bl.token
         where k.chain_id = $1 and k.curve = $2 and bl.holder = $3`,
        [t.chain_id, t.curve, t.trader]
      );
      const sold = Number(t.tokens);
      const left = Number(b[0]?.left ?? 0);
      sellPct = sold + left > 0 ? Math.min(100, Math.max(1, Math.round((sold / (sold + left)) * 100))) : 100;
    }

    // Everyone copying this trader who should get this one.
    const { rows: copiers } = await pool.query(
      `select f.follower, f.mode, f.amount::float8 as amount, f.copy_sells
       from copy_follows f
       where f.trader = $1
         and ($2::boolean or (f.copy_sells and exists (
               select 1 from balances bl join curves k on k.chain_id = bl.chain_id and k.token = bl.token
               where k.coin_id = $3 and bl.holder = f.follower and bl.amount > 0)))`,
      [t.trader, t.is_buy, t.coin_id]
    );

    for (const f of copiers) {
      const suggest = t.is_buy
        ? f.mode === "fixed"
          ? f.amount
          : traderUsd !== null
            ? Math.max(MIN_SUGGEST_USD, Math.round(traderUsd * f.amount) / 100)
            : null
        : null;

      // A second buy of the same coin soon after: fold it into the pending signal.
      if (t.is_buy) {
        const { rowCount } = await pool.query(
          `update copy_signals set trader_native = trader_native + $4::numeric, trader_usd = case when $5::numeric is null then trader_usd else coalesce(trader_usd, 0) + $5::numeric end,
                  suggest_usd = case when $6::numeric is null then suggest_usd when $7 = 'fixed' then suggest_usd else coalesce(suggest_usd, 0) + $6::numeric end
           where follower = $1 and trader = $2 and coin_id = $3 and is_buy and status = 'pending'
             and created_at > now() - interval '10 minutes' and trade_tx <> $8
             and not exists (select 1 from copy_signals x where x.follower = $1 and x.trade_tx = $8 and x.coin_id = $3)`,
          [f.follower, t.trader, t.coin_id, t.native, traderUsd, suggest, f.mode, t.tx_hash]
        );
        if (rowCount) {
          // Remember this trade too, so the next pass doesn't count it again.
          await pool.query(
            `insert into copy_signals (follower, trader, coin_id, chain_id, curve, is_buy, trade_tx, trader_native, trader_price, status, acted_at)
             values ($1, $2, $3, $4, $5, true, $6, $7, $8, 'expired', now()) on conflict do nothing`,
            [f.follower, t.trader, t.coin_id, t.chain_id, t.curve, t.tx_hash, t.native, t.px]
          );
          continue;
        }
      }

      const ins = await pool.query(
        `insert into copy_signals (follower, trader, coin_id, chain_id, curve, is_buy, trade_tx, trader_native, trader_price, trader_usd, suggest_usd, sell_pct)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (follower, trade_tx, coin_id) do nothing
         returning id`,
        [f.follower, t.trader, t.coin_id, t.chain_id, t.curve, t.is_buy, t.tx_hash, t.native, t.px, traderUsd, suggest, sellPct]
      );
      if (!ins.rowCount) continue;
      made++;
      const title = t.is_buy
        ? `${who} bought ${traderUsd !== null ? money(traderUsd) + " of " : ""}$${t.symbol}`
        : `${who} sold ${sellPct}% of their $${t.symbol}`;
      await pool.query(
        `insert into notifications (owner, coin_id, kind, title, body, url, pushed)
         values ($1, $2, 'copy', $3, $4, $5, false)`,
        [f.follower, t.coin_id, title, "Tap to apply or reject.", `${site}/copy/?s=${ins.rows[0].id}`]
      );
    }
  }
  return made;
}
