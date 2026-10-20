-- Copycats out of the coin lists (Oct 20, 2026).
--
-- Scammers launch copies of a known coin with the same name and ticker (Robinhood Chain had 80
-- "Pons" coins), often with a fake pool that shows millions in liquidity. Shared on X, a copy
-- even made people think it was sasa's own token.
-- Rule: among coins on one chain with the same name and ticker, only one is listed: the one with
-- its own X account first, then the one with the most trades in 24 h, then the oldest.
-- Run once in Supabase → SQL Editor. Same columns as before, so the site needs no change.

-- Also: when each coin's X account was last looked up on GeckoTerminal (the indexer fills
-- missing accounts so shares on X tag the project).
alter table ext_tokens add column if not exists xh_checked_at timestamptz;

create index if not exists ext_tokens_twin_idx on ext_tokens (network, lower(symbol), lower(btrim(name)));

create or replace view ext_coins as
  select network, chain_id, address, pool, dex, name, symbol, image, price_usd, fdv_usd, mcap_usd, liq_usd,
         vol_24h, change_1h, change_24h, buys_24h, sells_24h, pool_created, trending_rank, seen_at,
         gp_checked_at, gp_buy_tax, gp_sell_tax, gp_mintable, gp_top10, x_handle
  from (
    select t.*,
           row_number() over (
             partition by network, lower(symbol), lower(btrim(name))
             order by (x_handle is not null) desc,
                      coalesce(buys_24h, 0) + coalesce(sells_24h, 0) desc,
                      pool_created asc nulls last,
                      address
           ) as twin
    from ext_tokens t
    where seen_at > now() - interval '30 days'
      and coalesce(gp_honeypot, false) = false
      and coalesce(gp_cannot_sell, false) = false
      and coalesce(gp_sell_tax, 0) < 0.3
  ) x
  where twin = 1
    and coalesce(vol_24h, 0) >= 10000
    and coalesce(liq_usd, 0) >= 5000
    and seen_at > now() - interval '2 hours';

create or replace view ext_coins_all as
  select network, chain_id, address, pool, dex, name, symbol, image, price_usd, fdv_usd, mcap_usd, liq_usd,
         vol_24h, change_1h, change_24h, buys_24h, sells_24h, pool_created, trending_rank, seen_at,
         gp_checked_at, gp_buy_tax, gp_sell_tax, gp_mintable, gp_top10, x_handle
  from (
    select t.*,
           row_number() over (
             partition by network, lower(symbol), lower(btrim(name))
             order by (x_handle is not null) desc,
                      coalesce(buys_24h, 0) + coalesce(sells_24h, 0) desc,
                      pool_created asc nulls last,
                      address
           ) as twin
    from ext_tokens t
    where seen_at > now() - interval '30 days'
      and coalesce(gp_honeypot, false) = false
      and coalesce(gp_cannot_sell, false) = false
      and coalesce(gp_sell_tax, 0) < 0.3
  ) x
  where twin = 1;

grant select on ext_coins, ext_coins_all to anon, authenticated;
notify pgrst, 'reload schema';
