-- All coins, part 2 (update-66): coins stay findable for 30 days, and a second
-- picture source (DexScreener). Run once in the Supabase SQL editor.

alter table ext_tokens add column if not exists ds_checked_at timestamptz;

-- Search and coin pages: every coin seen in the last 30 days, except ones
-- that can't be sold. (The lists keep using ext_coins: active coins only.)
create or replace view ext_coins_all as
  select network, chain_id, address, pool, dex, name, symbol, image, price_usd, fdv_usd, mcap_usd, liq_usd,
         vol_24h, change_1h, change_24h, buys_24h, sells_24h, pool_created, trending_rank, seen_at,
         gp_checked_at, gp_buy_tax, gp_sell_tax, gp_mintable, gp_top10
  from ext_tokens
  where seen_at > now() - interval '30 days'
    and coalesce(gp_honeypot, false) = false
    and coalesce(gp_cannot_sell, false) = false
    and coalesce(gp_sell_tax, 0) < 0.3;

grant select on ext_coins_all to anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on ext_coins_all to service_role;
  end if;
end $$;
notify pgrst, 'reload schema';
