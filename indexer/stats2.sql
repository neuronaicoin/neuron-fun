-- Stats page v2. Run once in the Supabase SQL editor, BEFORE the site update.
-- Fee split per trade: 1% total; 0.3% creator side (paid by fee mode), 0.7% protocol.
-- p_days: how far back (3650 = all time). p_chain: null = all chains.

-- Daily series: volume, trades, traders, fees, launches, graduations, protocol revenue.
drop function if exists stats_daily(integer, integer);
create function stats_daily(p_days integer default 30, p_chain integer default null)
returns table (day date, volume_native numeric, trades bigint, traders bigint, fees_native numeric,
               launches bigint, graduations bigint, revenue_native numeric)
language sql stable as $$
  with bounds as (select (now() at time zone 'utc')::date - (greatest(p_days, 1) - 1) as since),
  days as (select generate_series((select since from bounds), (now() at time zone 'utc')::date, interval '1 day')::date as day),
  t as (
    select (ts at time zone 'utc')::date as day, sum(native_amount) v, count(*) n, count(distinct trader) u, sum(fee) f
    from trades where ts >= (select since from bounds) and (p_chain is null or chain_id = p_chain) group by 1
  ),
  l as (
    select day, count(*) n from (
      select (created_at at time zone 'utc')::date as day from coins where p_chain is null and created_at >= (select since from bounds)
      union all
      select (created_at at time zone 'utc')::date from curves where p_chain is not null and chain_id = p_chain and created_at >= (select since from bounds)
    ) x group by 1
  ),
  g as (
    select (graduated_at at time zone 'utc')::date as day, count(*) n from coins
    where graduated_at >= (select since from bounds) and (p_chain is null or graduated_chain = p_chain) group by 1
  )
  select d.day, coalesce(t.v, 0), coalesce(t.n, 0), coalesce(t.u, 0), coalesce(t.f, 0),
         coalesce(l.n, 0), coalesce(g.n, 0), coalesce(t.f, 0) * 0.7
  from days d left join t using (day) left join l using (day) left join g using (day)
  order by d.day;
$$;

-- Headline numbers beyond stats_totals.
create or replace function stats_extra(p_days integer default 30, p_chain integer default null)
returns table (creators bigint, holder_payouts_native numeric, creator_payouts_native numeric,
               buyback_native numeric, burned_tokens numeric)
language sql stable as $$
  with since as (select now() - make_interval(days => greatest(p_days, 1)) as ts),
  tr as (
    select t.*, c.fee_mode from trades t join coins c on c.id = t.coin_id
    where t.ts >= (select ts from since) and (p_chain is null or t.chain_id = p_chain)
  )
  select
    (select count(distinct c.creator) from coins c
       where c.created_at >= (select ts from since)
         and (p_chain is null or exists (select 1 from curves k where k.coin_id = c.id and k.chain_id = p_chain))),
    (select coalesce(sum(fee) * 0.3, 0) from tr where fee_mode = 2),
    (select coalesce(sum(fee) * 0.3, 0) from tr where fee_mode = 0),
    (select coalesce(sum(native_amount), 0) from tr where trader = '0x000000000000000000000000000000000000dead'),
    (select coalesce(sum(token_amount), 0) from tr where trader = '0x000000000000000000000000000000000000dead');
$$;

-- Launches and creator-side fees, per fee mode (0 creator, 1 buyback, 2 holders).
create or replace function stats_by_mode(p_days integer default 30, p_chain integer default null)
returns table (fee_mode smallint, launches bigint, share_native numeric)
language sql stable as $$
  with since as (select now() - make_interval(days => greatest(p_days, 1)) as ts),
  modes as (select m::smallint as fee_mode from generate_series(0, 2) m)
  select m.fee_mode,
    (select count(*) from coins c where c.fee_mode = m.fee_mode and c.created_at >= (select ts from since)
       and (p_chain is null or exists (select 1 from curves k where k.coin_id = c.id and k.chain_id = p_chain))),
    (select coalesce(sum(t.fee) * 0.3, 0) from trades t join coins c on c.id = t.coin_id
       where c.fee_mode = m.fee_mode and t.ts >= (select ts from since) and (p_chain is null or t.chain_id = p_chain))
  from modes m order by m.fee_mode;
$$;

-- Per chain: volume, trades, holders and a daily volume line for the sparkline.
create or replace function stats_by_chain(p_days integer default 30)
returns table (chain_id integer, volume_native numeric, trades bigint, holders bigint, spark numeric[])
language sql stable as $$
  with since as (select (now() at time zone 'utc')::date - (least(greatest(p_days, 1), 90) - 1) as d0),
  chains as (select distinct chain_id from curves)
  select ch.chain_id,
    (select coalesce(sum(native_amount), 0) from trades t where t.chain_id = ch.chain_id and t.ts >= now() - make_interval(days => greatest(p_days, 1))),
    (select count(*) from trades t where t.chain_id = ch.chain_id and t.ts >= now() - make_interval(days => greatest(p_days, 1))),
    (select count(distinct b.holder) from balances b join curves k on k.chain_id = b.chain_id and k.token = b.token
       where b.chain_id = ch.chain_id and b.amount > 0 and b.holder <> k.curve
         and b.holder not in ('0x000000000000000000000000000000000000dead', '0x0000000000000000000000000000000000000000')),
    (select array_agg(coalesce(v, 0) order by d) from (
       select d::date as d, (select sum(native_amount) from trades t where t.chain_id = ch.chain_id and (t.ts at time zone 'utc')::date = d::date) as v
       from generate_series((select d0 from since), (now() at time zone 'utc')::date, interval '1 day') d
     ) s)
  from chains ch order by 2 desc;
$$;

-- Leaderboards. p_kind: 'volume' | 'fees' (creator side, any mode) | 'holders' (paid to holders) | 'burn' (bought back and burned).
create or replace function stats_leaders(p_days integer default 30, p_chain integer default null, p_kind text default 'volume', p_limit integer default 10)
returns table (coin_id text, name text, symbol text, logo text, fee_mode smallint, chain_id integer, value numeric, trades bigint)
language sql stable as $$
  with since as (select now() - make_interval(days => greatest(p_days, 1)) as ts),
  tr as (
    select t.* from trades t
    where t.ts >= (select ts from since) and (p_chain is null or t.chain_id = p_chain)
  ),
  per as (
    select c.id, c.name, c.symbol, c.logo, c.fee_mode,
      (select tt.chain_id from tr tt where tt.coin_id = c.id group by tt.chain_id order by sum(tt.native_amount) desc limit 1) as chain_id,
      case p_kind
        when 'fees' then sum(tr.fee) * 0.3
        when 'holders' then case when c.fee_mode = 2 then sum(tr.fee) * 0.3 else 0 end
        when 'burn' then sum(case when tr.trader = '0x000000000000000000000000000000000000dead' then tr.native_amount else 0 end)
        else sum(tr.native_amount)
      end as value,
      count(*) as trades
    from tr join coins c on c.id = tr.coin_id
    group by c.id, c.name, c.symbol, c.logo, c.fee_mode
  )
  select id, name, symbol, logo, fee_mode, chain_id, value, trades from per
  where value > 0 order by value desc limit least(greatest(p_limit, 1), 50);
$$;

grant execute on function stats_daily(integer, integer), stats_extra(integer, integer), stats_by_mode(integer, integer),
  stats_by_chain(integer), stats_leaders(integer, integer, text, integer) to anon, authenticated;
