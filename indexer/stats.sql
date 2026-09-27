-- Public stats for sasapad.fun/stats. Run once in the Supabase SQL editor.
-- p_days: how many days back (use 3650 for "all time"). p_chain: null = all chains.

create or replace function stats_daily(p_days integer default 30, p_chain integer default null)
returns table (day date, volume_native numeric, trades bigint, traders bigint, fees_native numeric, launches bigint)
language sql stable as $$
  with bounds as (select (now() at time zone 'utc')::date - (greatest(p_days, 1) - 1) as since),
  days as (
    select generate_series((select since from bounds), (now() at time zone 'utc')::date, interval '1 day')::date as day
  ),
  t as (
    select (ts at time zone 'utc')::date as day, sum(native_amount) as v, count(*) as n,
           count(distinct trader) as u, sum(fee) as f
    from trades
    where ts >= (select since from bounds) and (p_chain is null or chain_id = p_chain)
    group by 1
  ),
  l as (
    select day, count(*) as n from (
      select (created_at at time zone 'utc')::date as day from coins
        where p_chain is null and created_at >= (select since from bounds)
      union all
      select (created_at at time zone 'utc')::date from curves
        where p_chain is not null and chain_id = p_chain and created_at >= (select since from bounds)
    ) x group by 1
  )
  select d.day, coalesce(t.v, 0), coalesce(t.n, 0), coalesce(t.u, 0), coalesce(t.f, 0), coalesce(l.n, 0)
  from days d left join t using (day) left join l using (day)
  order by d.day;
$$;

create or replace function stats_totals(p_days integer default 30, p_chain integer default null)
returns table (volume_native numeric, trades bigint, traders bigint, fees_native numeric, launches bigint, graduated bigint, holders bigint)
language sql stable as $$
  with since as (select now() - make_interval(days => greatest(p_days, 1)) as ts)
  select
    (select coalesce(sum(native_amount), 0) from trades where ts >= (select ts from since) and (p_chain is null or chain_id = p_chain)),
    (select count(*) from trades where ts >= (select ts from since) and (p_chain is null or chain_id = p_chain)),
    (select count(distinct trader) from trades where ts >= (select ts from since) and (p_chain is null or chain_id = p_chain)),
    (select coalesce(sum(fee), 0) from trades where ts >= (select ts from since) and (p_chain is null or chain_id = p_chain)),
    (case when p_chain is null
      then (select count(*) from coins where created_at >= (select ts from since))
      else (select count(*) from curves where chain_id = p_chain and created_at >= (select ts from since)) end),
    (select count(*) from coins where graduated_at >= (select ts from since)
       and (p_chain is null or graduated_chain = p_chain)),
    (select count(distinct b.holder) from balances b
       join curves k on k.chain_id = b.chain_id and k.token = b.token
       where b.amount > 0 and (p_chain is null or b.chain_id = p_chain)
         and b.holder <> k.curve
         and b.holder not in ('0x000000000000000000000000000000000000dead', '0x0000000000000000000000000000000000000000'));
$$;

create or replace function stats_top_coins(p_days integer default 30, p_chain integer default null, p_limit integer default 10)
returns table (coin_id text, name text, symbol text, logo text, volume_native numeric, trades bigint)
language sql stable as $$
  select c.id, c.name, c.symbol, c.logo, sum(t.native_amount), count(*)
  from trades t join coins c on c.id = t.coin_id
  where t.ts >= now() - make_interval(days => greatest(p_days, 1)) and (p_chain is null or t.chain_id = p_chain)
  group by c.id, c.name, c.symbol, c.logo
  order by 5 desc
  limit least(greatest(p_limit, 1), 50);
$$;

-- Creators ranked by what their coins earned them (0.3% of each 1% fee = 30% of fees).
create or replace function stats_top_creators(p_days integer default 30, p_chain integer default null, p_limit integer default 10)
returns table (creator text, coins bigint, earned_native numeric)
language sql stable as $$
  select c.creator, count(distinct c.id), sum(t.fee) * 0.3
  from trades t join coins c on c.id = t.coin_id
  where t.ts >= now() - make_interval(days => greatest(p_days, 1)) and (p_chain is null or t.chain_id = p_chain)
  group by c.creator
  order by 3 desc
  limit least(greatest(p_limit, 1), 50);
$$;

create index if not exists curves_created_idx on curves (created_at);
create index if not exists coins_graduated_idx on coins (graduated_at) where graduated_at is not null;
create index if not exists trades_ts_idx on trades (ts);

grant execute on function stats_daily(integer, integer), stats_totals(integer, integer),
  stats_top_coins(integer, integer, integer), stats_top_creators(integer, integer, integer) to anon, authenticated;
