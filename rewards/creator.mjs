// Creator bonus: a coin launched on sasa that holds a market cap of at least CREATOR_MC_USD
// ($10K) for CREATOR_HOLD_MIN (60) minutes pays its creator 60% of the trading fees from then on
// (sasa keeps 40%), for as long as it stays above. Below it, the normal split again (and another
// full hour above before the bonus starts again).
//
// The contracts already pay the creator their normal share on chain; the bonus is the difference,
// paid in USDC on Base once a day with the invite rewards (same ledger, same payout, kind
// 'creator'), to the creator's sasa account:
//   race coins (Base, BNB, Robinhood, Arc)  on chain 30% creator / 70% sasa -> bonus 30% of the fee
//       counted per buy exactly like invite rewards (usd.mjs): each buy's own fee, scaled to what
//       the builder really collected. A buy counts when, at that trade, the coin's market cap on
//       its chain (price x that chain's supply) was at or above the line and had been since a
//       trade at least an hour earlier. Coins whose creator chose buyback & burn are left out.
//   Solana coins (pump.fun curve)           on chain 50% creator / 50% sasa -> bonus 10% of every
//       creator-fee payout made while the coin qualifies (the keeper pays out every 30 minutes;
//       its market cap is read every few minutes from the keeper and DexScreener).
// Only fees made after CREATOR_FROM count (the program's start), never anything earlier.
//
// Every ledger row is keyed by the trade (race) or the payout (Solana), so running again never
// counts anything twice.

import { createPublicClient, defineChain, http, parseAbi } from "viem";
import { USD_BUCKET } from "./usd.mjs";

const LOOKBACK = "3 days";
const erc20 = parseAbi(["function totalSupply() view returns (uint256)"]);

/** Public RPCs used to read a race coin's supply on its chain when RPC_<chainId> isn't set. */
const PUBLIC_RPC = {
  8453: "https://mainnet.base.org",
  56: "https://bsc-dataseed.binance.org",
  4663: "https://rpc.mainnet.chain.robinhood.com",
  5042: "https://rpc.mainnet.arc.io",
};
const clients = new Map();
function client(chainId) {
  if (!clients.has(chainId)) {
    const rpc = (process.env[`RPC_${chainId}`] || PUBLIC_RPC[chainId] || "").split(",")[0].trim();
    if (!rpc) return null;
    const chain = defineChain({ id: chainId, name: `c${chainId}`, nativeCurrency: { name: "N", symbol: "N", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    clients.set(chainId, createPublicClient({ chain, transport: http(rpc) }));
  }
  return clients.get(chainId);
}

/** The hook's fee on a buy at time t (SQL), the same as usd.mjs. */
const RATE = `(case when t.via in ('launch', 'system') or c.launched_at is null then 0.02
                    else greatest(0.02, 0.10 - 0.08 * least(1, greatest(0, extract(epoch from (t.ts - c.launched_at)) / 120))) end)`;

/** Tables the bonus needs (safe to run every time). */
export async function ensureCreatorTables(pool) {
  await pool.query(`
    create table if not exists creator_supply (
      chain_id   integer not null,
      coin_id    text    not null,
      supply     numeric not null,
      read_at    timestamptz not null default now(),
      primary key (chain_id, coin_id)
    );
    create table if not exists creator_qual (
      key         text primary key,
      above_since timestamptz,
      mcap        numeric,
      seen_paid   numeric,
      seen_n      integer,
      updated_at  timestamptz not null default now()
    );
    alter table creator_supply enable row level security;
    alter table creator_qual enable row level security;
    revoke all on creator_supply from anon, authenticated;
    revoke all on creator_qual from anon, authenticated;
  `);
  // the ledger learns the new kind (the first version only knew 'referral' and 'copy')
  await pool.query(`
    do $$ begin
      if exists (select 1 from pg_constraint where conname = 'reward_ledger_kind_check'
                 and pg_get_constraintdef(oid) not like '%creator%') then
        alter table reward_ledger drop constraint reward_ledger_kind_check;
        alter table reward_ledger add constraint reward_ledger_kind_check check (kind in ('referral', 'copy', 'creator'));
      end if;
    end $$;
  `);
}

/** Supply of every race coin that traded near the line lately, read from its chain (10 min cache). */
async function refreshSupplies(pool, { chainIds, thresholdUsd, log }) {
  const { rows } = await pool.query(
    `select distinct t.chain_id, t.coin_id, rc.coin
     from race_trades t join race_coins rc on rc.id = t.coin_id
     left join creator_supply s on s.chain_id = t.chain_id and s.coin_id = t.coin_id
     where t.chain_id = any($1::int[]) and t.ts > now() - interval '${LOOKBACK}'
       and t.price_usd * 1000000000 >= $2::numeric
       and (s.read_at is null or s.read_at < now() - interval '10 minutes')
     limit 200`,
    [chainIds, String(thresholdUsd)]
  );
  for (const r of rows) {
    const c = client(Number(r.chain_id));
    if (!c) continue;
    try {
      const raw = await c.readContract({ address: r.coin, abi: erc20, functionName: "totalSupply" });
      const v = Number(raw) / 1e18;
      if (!(v > 0 && v <= 1_000_000_000 * 1.001)) continue;
      await pool.query(
        `insert into creator_supply (chain_id, coin_id, supply, read_at) values ($1, $2, $3, now())
         on conflict (chain_id, coin_id) do update set supply = excluded.supply, read_at = now()`,
        [r.chain_id, r.coin_id, v]
      );
    } catch (e) {
      log?.(`creator bonus: supply of ${r.coin} on ${r.chain_id}: ${e.shortMessage ?? e.message}`);
    }
  }
}

/** Race coins: the bonus on each qualifying buy -> ledger rows (dollars). */
async function raceBonus(pool, { chainIds, thresholdUsd, holdMin, bonusBps, from }) {
  const r = await pool.query(
    `insert into reward_ledger (owner, kind, chain_id, trade_tx, log_index, source, amount)
     with f as (
       select rf.chain_id, rf.coin_id, rf.block_number as b, rf.log_index as li, rf.native_amount as got, rf.created_at,
              lag(rf.block_number) over w as pb, lag(rf.log_index) over w as pl
       from race_fees rf
       where rf.block_number is not null and rf.chain_id = any($2::int[])
       window w as (partition by rf.coin_id, rf.chain_id order by rf.block_number, rf.log_index)
     ),
     ready as (
       select f.* from f join race_state s on s.chain_id = f.chain_id
       where s.last_block >= f.b and f.created_at > now() - interval '${LOOKBACK}' and f.got > 0
     ),
     pairs as (select distinct coin_id, chain_id from ready),
     q as (
       select t.coin_id, t.chain_id, t.block_number, t.log_index, t.ts,
              s.supply is not null and t.price_usd * s.supply >= $3::numeric as above,
              sum(case when s.supply is not null and t.price_usd * s.supply >= $3::numeric then 0 else 1 end)
                over (partition by t.coin_id, t.chain_id order by t.block_number, t.log_index rows unbounded preceding) as grp
       from race_trades t
       join pairs p on p.coin_id = t.coin_id and p.chain_id = t.chain_id
       left join creator_supply s on s.chain_id = t.chain_id and s.coin_id = t.coin_id
     ),
     q2 as (
       select q.*, min(q.ts) filter (where q.above) over (partition by q.coin_id, q.chain_id, q.grp) as since from q
     ),
     tr as (
       select t.chain_id, t.tx_hash, t.log_index, t.via, t.ts, t.usd_amount, t.native_amount,
              rd.coin_id, rd.b, rd.li, rd.got, ${RATE} as rate,
              (q2.above and q2.ts - q2.since >= make_interval(mins => $4::int)) as qualified
       from ready rd
       join race_trades t on t.coin_id = rd.coin_id and t.chain_id = rd.chain_id and t.is_buy
            and (t.block_number, t.log_index) <= (rd.b, rd.li)
            and (rd.pb is null or (t.block_number, t.log_index) > (rd.pb, rd.pl))
       join q2 on q2.coin_id = t.coin_id and q2.chain_id = t.chain_id and q2.block_number = t.block_number and q2.log_index = t.log_index
       left join race_chains c on c.coin_id = t.coin_id and c.chain_id = t.chain_id
     ),
     n as (
       select coin_id, chain_id, b, li, sum(native_amount * rate) as nominal from tr group by coin_id, chain_id, b, li
     )
     select lower(rc.creator), 'creator', $1, 'cb:' || tr.chain_id || ':' || tr.tx_hash, tr.log_index, tr.coin_id,
            floor(tr.usd_amount * 1000000 * tr.rate * least(1, tr.got / n.nominal) * $5::numeric / 10000)
     from tr
     join n on n.coin_id = tr.coin_id and n.chain_id = tr.chain_id and n.b = tr.b and n.li = tr.li
     join race_coins rc on rc.id = tr.coin_id
     where tr.qualified and tr.via <> 'system' and n.nominal > 0 and tr.usd_amount > 0
       and tr.ts >= $6::timestamptz
       and coalesce(rc.fee_mode, 0) = 0
       and rc.creator ~* '^0x[0-9a-f]{40}$'
     on conflict do nothing`,
    [USD_BUCKET, chainIds, String(thresholdUsd), holdMin, String(bonusBps), from]
  );
  return r.rowCount;
}

let solUsd = { v: null, at: 0 };
async function solPrice() {
  if (solUsd.v && Date.now() - solUsd.at < 60_000) return solUsd.v;
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", { signal: AbortSignal.timeout(8000) });
    const p = Number((await r.json())?.data?.amount);
    if (Number.isFinite(p) && p > 0) solUsd = { v: p, at: Date.now() };
  } catch {}
  return solUsd.v;
}

/** Solana coins: keep each coin's "above since", and add the bonus on new payouts while it qualifies. */
async function solBonus(pool, { thresholdUsd, holdMin, solBonusBps, from, log }) {
  const { rows } = await pool.query(
    `select c.mint, lower(c.owner) as owner, c.paid_lamports::text as paid, c.payouts,
            coalesce(case when e.seen_at > now() - interval '30 minutes' then e.mcap_usd end, c.mcap_usd) as mcap,
            q.above_since, q.seen_paid::text as seen_paid
     from sol_coins c
     left join sol_ext_tokens e on e.address = c.mint
     left join creator_qual q on q.key = 'sol:' || c.mint
     where c.status = 'live' and c.kind = 'pump'`
  );
  const price = await solPrice();
  let added = 0;
  for (const r of rows) {
    const mcap = r.mcap === null ? null : Number(r.mcap);
    const above = mcap !== null && mcap >= thresholdUsd;
    const since = above ? (r.above_since ? new Date(r.above_since) : new Date()) : null;
    const paid = BigInt(r.paid ?? "0");
    const seen = r.seen_paid === null ? null : BigInt(r.seen_paid);
    const qualified = since !== null && Date.now() - since.getTime() >= holdMin * 60_000 && Date.now() >= Date.parse(from);
    // a payout since the last look, made while the coin qualifies: its bonus
    if (seen !== null && paid > seen && qualified && r.owner && /^0x[0-9a-f]{40}$/.test(r.owner)) {
      if (!price) continue; // no SOL price right now: try again next round (seen stays as it was)
      const delta = paid - seen;
      const usd = (Number(delta) / 1e9) * price * (solBonusBps / 10_000);
      const amount = Math.floor(usd * 1_000_000);
      if (amount > 0) {
        const ins = await pool.query(
          `insert into reward_ledger (owner, kind, chain_id, trade_tx, log_index, source, amount)
           values ($1, 'creator', $2, $3, 0, $4, $5) on conflict do nothing`,
          [r.owner, USD_BUCKET, `cb:sol:${r.mint}:${paid.toString()}`, r.mint, amount]
        );
        added += ins.rowCount;
        log?.(`creator bonus: ${r.mint} +$${usd.toFixed(4)} (payout ${(Number(delta) / 1e9).toFixed(4)} SOL)`);
      }
    }
    await pool.query(
      `insert into creator_qual (key, above_since, mcap, seen_paid, seen_n, updated_at) values ($1, $2, $3, $4, $5, now())
       on conflict (key) do update set above_since = excluded.above_since, mcap = excluded.mcap,
         seen_paid = excluded.seen_paid, seen_n = excluded.seen_n, updated_at = now()`,
      ["sol:" + r.mint, since, mcap, paid.toString(), r.payouts ?? 0]
    );
  }
  return added;
}

/** One round: race coins and Solana coins. Returns how many ledger rows were added. */
export async function buildCreatorLedger(pool, opts) {
  const o = {
    thresholdUsd: 10_000,
    holdMin: 60,
    bonusBps: 3000, // race coins: 30% on chain + 30% bonus = 60%
    solBonusBps: 1000, // Solana: 50% on chain + 10% bonus = 60%
    ...opts,
  };
  await refreshSupplies(pool, o).catch((e) => o.log?.(`creator bonus: supplies ${e.message}`));
  const race = await raceBonus(pool, o);
  const sol = await solBonus(pool, o).catch((e) => {
    o.log?.(`creator bonus: solana ${e.message}`);
    return 0;
  });
  return { race, sol };
}
