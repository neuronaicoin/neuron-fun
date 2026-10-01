-- Trader badges (update-79). Run once in the Supabase SQL editor. Safe to run twice.
--
-- The indexer calls refresh_badges() every 5 minutes and stores the result in
-- trader_badges, so pages read ready rows instead of recounting trades.
--
--   whale    top 5% of traders by 30-day trading volume
--   early    among the first 10 buyers of a coin (its creator not counted)
--   diamond  bought a coin 7+ days ago, never sold it, still holds it
--   creator  launched a coin that graduated
--   streak   traded on 7+ days in a row (UTC days)
--   pnl      top 10% of traders by 30-day realized profit (profit above zero)
--
-- p_unit: USD per 1e18 raw units of the money coins trade against, the same
-- number refresh_points() takes (1e12 for USDC, 6 decimals).

create table if not exists trader_badges (
  trader     text primary key,
  badges     text[] not null default '{}',
  updated_at timestamptz not null default now()
);

grant select on trader_badges to anon, authenticated;
grant all on trader_badges to service_role;

create or replace function refresh_badges(p_unit numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  create temporary table if not exists _badges (trader text, badge text) on commit drop;
  truncate _badges;

  -- whale + pnl: from the same numbers as the Traders leaderboard.
  insert into _badges
  with s as (
    select trader, volume * p_unit as vol, realized * p_unit as pnl
    from trader_stats(now() - interval '30 days')
    where trader not in ('0x000000000000000000000000000000000000dead', '0x0000000000000000000000000000000000000000')
  ),
  ranked as (
    select trader, vol, pnl,
           row_number() over (order by vol desc) as vr,
           row_number() over (order by pnl desc) as pr,
           count(*) over () as n,
           count(*) filter (where pnl > 0) over () as np
    from s
    where vol > 0
  )
  select trader, 'whale' from ranked where vr <= greatest(1, ceil(n * 0.05))
  union all
  select trader, 'pnl' from ranked where pnl > 0 and pr <= greatest(1, ceil(np * 0.10));

  -- early: the first 10 different buyers of each coin, not counting its creator.
  insert into _badges
  with first_buy as (
    select t.coin_id, t.trader, min(t.ts) as ts
    from trades t
    join coins c on c.id = t.coin_id
    where t.is_buy and t.trader <> lower(c.creator)
      and t.trader not in ('0x000000000000000000000000000000000000dead', '0x0000000000000000000000000000000000000000')
    group by t.coin_id, t.trader
  ),
  ranked as (
    select trader, row_number() over (partition by coin_id order by ts) as rn from first_buy
  )
  select distinct trader, 'early' from ranked where rn <= 10;

  -- diamond: first buy 7+ days ago, no sell since, still holding on that chain.
  insert into _badges
  with held as (
    select t.trader, t.chain_id, t.curve
    from trades t
    group by t.trader, t.chain_id, t.curve
    having min(t.ts) filter (where t.is_buy) <= now() - interval '7 days'
       and count(*) filter (where not t.is_buy) = 0
  )
  select distinct h.trader, 'diamond'
  from held h
  join curves k on k.chain_id = h.chain_id and k.curve = h.curve
  join balances b on b.chain_id = k.chain_id and b.token = k.token and b.holder = h.trader
  where b.amount > 0
    and h.trader not in ('0x000000000000000000000000000000000000dead', '0x0000000000000000000000000000000000000000');

  -- creator: launched at least one coin that graduated.
  insert into _badges
  select distinct lower(creator), 'creator' from coins where graduated_chain is not null;

  -- streak: 7+ trading days in a row, at any time.
  insert into _badges
  with days as (
    select distinct trader, (ts at time zone 'utc')::date as d
    from trades
    where trader not in ('0x000000000000000000000000000000000000dead', '0x0000000000000000000000000000000000000000')
  ),
  runs as (
    select trader, d - (row_number() over (partition by trader order by d))::int as grp from days
  )
  select distinct trader, 'streak' from runs group by trader, grp having count(*) >= 7;

  -- Store: one row per trader with badges, in a fixed order; drop the rest.
  insert into trader_badges (trader, badges, updated_at)
  select trader,
         array_agg(badge order by array_position(array['whale','pnl','creator','early','diamond','streak'], badge)),
         now()
  from (select distinct trader, badge from _badges) x
  group by trader
  on conflict (trader) do update set badges = excluded.badges, updated_at = excluded.updated_at
    where trader_badges.badges is distinct from excluded.badges;

  delete from trader_badges tb where not exists (select 1 from _badges x where x.trader = tb.trader);
end;
$$;

grant execute on function refresh_badges(numeric) to service_role;

notify pgrst, 'reload schema';
