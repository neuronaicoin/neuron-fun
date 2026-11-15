-- Fakes out of Explore (Nov 15, 2026). Run once in the Supabase SQL editor (already run live).
--
-- Explore listed a 20-hour-old "ChainLink Protocol (LINK)" at $8.8B and a "Solana (SOL)" on Base.
-- Same view as copycats-fast.sql, plus: no coin using a major's ticker, and nothing at $1B+.

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
    and seen_at > now() - interval '2 hours'
    -- fakes and majors (Nov 15, 2026): a "LINK" or "SOL" on a meme list is a copy or a bridged
    -- major (they belong in Spot), and a $1B+ coin isn't a meme people find here
    and upper(btrim(symbol)) not in ('BTC','ETH','SOL','LINK','XRP','DOGE','ADA','AVAX','DOT','TRX','TON','LTC','BCH','NEAR','UNI','AAVE','ATOM','XLM','SUI','APT','ARB','OP','HYPE','BNB','MATIC','POL','FIL','ICP','ETC','XMR','HBAR','KAS','RNDR','RENDER','INJ','TAO','WLD','ONDO','QNT','CRV','MKR','LDO','STX','SEI','TIA','JUP','PYTH','ENA','FET','CAKE','ZRO','BGB','OKB','CRO','LEO','KAVA')
    and coalesce(mcap_usd, fdv_usd, 0) < 1000000000;


notify pgrst, 'reload schema';
