-- Market list: price now, price 24 hours ago and the change, for the
-- gainers / losers / trending tabs. Run once in the Supabase SQL editor,
-- BEFORE the site update. Rebuilds coin_list (the indexer refreshes it).

drop materialized view if exists coin_list;

create materialized view coin_list as
  select
    s.*,
    coalesce((select sum(k.real_native) from curves k where k.coin_id = s.id and k.state = 0), 0) as open_native,
    coalesce((select sum(h.holders) from curves k join holder_counts h on h.chain_id = k.chain_id and h.token = k.token
              where k.coin_id = s.id), 0)::int as holders_total,
    last_px.price as price_now,
    -- For coins younger than a day, compare with their first trade.
    coalesce(day_px.price, first_px.price) as price_24h,
    case
      when last_px.price is not null and coalesce(day_px.price, first_px.price) > 0
      then last_px.price / coalesce(day_px.price, first_px.price) - 1
    end as change_24h
  from coin_summary s
  left join lateral (
    select t.price from trades t where t.coin_id = s.id order by t.ts desc, t.log_index desc limit 1
  ) last_px on true
  left join lateral (
    select t.price from trades t where t.coin_id = s.id and t.ts <= now() - interval '24 hours'
    order by t.ts desc, t.log_index desc limit 1
  ) day_px on true
  left join lateral (
    select t.price from trades t where t.coin_id = s.id order by t.ts asc, t.log_index asc limit 1
  ) first_px on true;

create unique index coin_list_id_idx on coin_list (id);
create index coin_list_created_idx on coin_list (created_at desc);
create index coin_list_active_idx on coin_list (last_trade_at desc nulls last);
create index coin_list_race_idx on coin_list (open_native desc) where graduated_chain is null;
create index coin_list_grad_idx on coin_list (graduated_at desc) where graduated_chain is not null;
create index coin_list_name_idx on coin_list (lower(name));
create index coin_list_symbol_idx on coin_list (lower(symbol));
create index coin_list_change_idx on coin_list (change_24h desc nulls last);
create index coin_list_trending_idx on coin_list (trades_24h desc, volume_native_24h desc);

grant select on coin_list to anon, authenticated;
