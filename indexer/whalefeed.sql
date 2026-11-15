-- Whale card (web/components/whalecard.tsx): the last half hour's big trades, one list for every
-- visitor. Other DEXs' coins from $5,000 (big_trades, filled by whalefeed.mjs and seopages.mjs),
-- sasa race coins from $1,000 (race_trades).
create or replace view whale_feed as
  select 'ext'::text as kind, b.network as net, b.address as coin, b.tx, b.t,
         b.side = 'buy' as is_buy, b.usd::double precision as usd,
         coalesce(e.symbol, s.symbol) as symbol, coalesce(e.name, s.name) as name, coalesce(e.image, s.image) as image
  from big_trades b
  left join ext_tokens e on b.network <> 'solana' and e.network = b.network and e.address = b.address
  left join sol_ext_tokens s on b.network = 'solana' and s.address = b.address
  where b.t > now() - interval '30 minutes' and b.usd >= 5000
  union all
  select 'sasa', rt.chain_id::text, rt.coin_id, rt.tx_hash, rt.ts,
         rt.is_buy, rt.usd_amount::double precision,
         rc.symbol, rc.name, nullif(rc.logo, '')
  from race_trades rt
  join race_coins rc on rc.id = rt.coin_id
  where rt.ts > now() - interval '30 minutes' and rt.usd_amount >= 1000 and rt.via <> 'system';

grant select on whale_feed to anon, authenticated;
notify pgrst, 'reload schema';
