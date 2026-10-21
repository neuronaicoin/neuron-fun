-- Faster Explore list (update-117). Run once in the Supabase SQL editor.
--
-- ext_coins (copycats.sql) ranked every coin seen in the last 30 days to hide copycats, on every
-- request: ~2 seconds, and sometimes over the 3-second limit for site visitors, so Explore
-- opened empty until a reload. Same result, but only the names that are trading right now are
-- ranked (a name with nothing trading can't show up anyway).

create index if not exists ext_tokens_active_idx on ext_tokens (seen_at desc) where coalesce(vol_24h, 0) >= 10000 and coalesce(liq_usd, 0) >= 5000;

create or replace view ext_coins as
  with live as (
    select distinct network, lower(symbol) as sym, lower(btrim(name)) as nm
    from ext_tokens
    where seen_at > now() - interval '2 hours'
      and coalesce(vol_24h, 0) >= 10000
      and coalesce(liq_usd, 0) >= 5000
      and coalesce(gp_honeypot, false) = false
      and coalesce(gp_cannot_sell, false) = false
      and coalesce(gp_sell_tax, 0) < 0.3
  )
  select network, chain_id, address, pool, dex, name, symbol, image, price_usd, fdv_usd, mcap_usd, liq_usd,
         vol_24h, change_1h, change_24h, buys_24h, sells_24h, pool_created, trending_rank, seen_at,
         gp_checked_at, gp_buy_tax, gp_sell_tax, gp_mintable, gp_top10, x_handle
  from (
    select t.*,
           row_number() over (
             partition by t.network, lower(t.symbol), lower(btrim(t.name))
             order by (t.x_handle is not null) desc,
                      coalesce(t.buys_24h, 0) + coalesce(t.sells_24h, 0) desc,
                      t.pool_created asc nulls last,
                      t.address
           ) as twin
    from ext_tokens t
    join live l on l.network = t.network and l.sym = lower(t.symbol) and l.nm = lower(btrim(t.name))
    where t.seen_at > now() - interval '30 days'
      and coalesce(t.gp_honeypot, false) = false
      and coalesce(t.gp_cannot_sell, false) = false
      and coalesce(t.gp_sell_tax, 0) < 0.3
  ) x
  where twin = 1
    and coalesce(vol_24h, 0) >= 10000
    and coalesce(liq_usd, 0) >= 5000
    and seen_at > now() - interval '2 hours';

notify pgrst, 'reload schema';
