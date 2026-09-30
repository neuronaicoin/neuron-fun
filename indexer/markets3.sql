-- All coins, part 3 (update-71): each project's X account (from DexScreener),
-- so shares and daily posts can tag the project. Run once in the SQL editor.

alter table ext_tokens add column if not exists x_handle text;

create or replace view ext_coins as
  select network, chain_id, address, pool, dex, name, symbol, image, price_usd, fdv_usd, mcap_usd, liq_usd,
         vol_24h, change_1h, change_24h, buys_24h, sells_24h, pool_created, trending_rank, seen_at,
         gp_checked_at, gp_buy_tax, gp_sell_tax, gp_mintable, gp_top10, x_handle
  from ext_tokens
  where coalesce(vol_24h, 0) >= 10000
    and coalesce(liq_usd, 0) >= 5000
    and seen_at > now() - interval '2 hours'
    and coalesce(gp_honeypot, false) = false
    and coalesce(gp_cannot_sell, false) = false
    and coalesce(gp_sell_tax, 0) < 0.3;

create or replace view ext_coins_all as
  select network, chain_id, address, pool, dex, name, symbol, image, price_usd, fdv_usd, mcap_usd, liq_usd,
         vol_24h, change_1h, change_24h, buys_24h, sells_24h, pool_created, trending_rank, seen_at,
         gp_checked_at, gp_buy_tax, gp_sell_tax, gp_mintable, gp_top10, x_handle
  from ext_tokens
  where seen_at > now() - interval '30 days'
    and coalesce(gp_honeypot, false) = false
    and coalesce(gp_cannot_sell, false) = false
    and coalesce(gp_sell_tax, 0) < 0.3;

grant select on ext_coins, ext_coins_all to anon, authenticated;
notify pgrst, 'reload schema';
