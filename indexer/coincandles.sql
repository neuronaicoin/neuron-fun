-- One chart per coin (update-60): candles from every chain's trades together.
-- In the dollar edition all chains trade against USDC (6 decimals), so prices
-- from different chains are the same unit and can share one chart.
-- Run once in the Supabase SQL editor.

create index if not exists trades_coin_ts_idx on trades (coin_id, ts);

create or replace function candles_coin(p_coin_id text, p_bucket integer, p_limit integer default 500)
returns table (t timestamptz, open numeric, high numeric, low numeric, close numeric, volume numeric)
language sql stable as $$
  select
    to_timestamp(floor(extract(epoch from ts) / p_bucket) * p_bucket) as t,
    (array_agg(price order by ts, chain_id, log_index))[1] as open,
    max(price) as high,
    min(price) as low,
    (array_agg(price order by ts desc, chain_id desc, log_index desc))[1] as close,
    sum(native_amount) as volume
  from trades
  where coin_id = lower(p_coin_id)
  group by 1
  order by 1 desc
  limit greatest(1, least(p_limit, 2000));
$$;

grant execute on function candles_coin(text, integer, integer) to anon, authenticated, service_role;
notify pgrst, 'reload schema';
