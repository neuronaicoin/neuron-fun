-- One-time repair (update-75): on the dollar-edition testnets, trades in a
-- graduated coin's pool were stored with the price upside down when USDC was
-- the pool's second currency (showing absurd market values like $1e31M).
-- Real prices here (USDC units per token unit) are far below 1, so any pool
-- price above 1 is an inverted one: recompute it from the trade itself.
-- Safe to run more than once. Run AFTER update-75 is deployed.

update trades t
   set price = t.native_amount::numeric / t.token_amount::numeric
 where t.chain_id in (46630, 84532)
   and t.token_amount > 0
   and t.price > 1;

-- Graduated curves: market value follows the latest (now correct) pool price.
with last as (
  select distinct on (t.chain_id, t.curve) t.chain_id, t.curve, t.price
    from trades t
    join curves c on c.chain_id = t.chain_id and c.curve = t.curve and c.state = 2
   where t.chain_id in (46630, 84532) and t.price > 0
   order by t.chain_id, t.curve, t.block_number desc, t.log_index desc
)
update curves c
   set virtual_native = round(last.price * 1e27)::numeric,
       virtual_token  = 1e27::numeric
  from last
 where c.chain_id = last.chain_id and c.curve = last.curve;

-- Rebuild the precomputed lists now instead of waiting for the next refresh.
do $$ begin
  if exists (select 1 from pg_matviews where matviewname = 'coin_list') then refresh materialized view coin_list; end if;
  if exists (select 1 from pg_matviews where matviewname = 'coin_summary') then refresh materialized view coin_summary; end if;
end $$;
