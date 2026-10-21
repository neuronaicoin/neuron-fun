-- Airdrop activity (update-115). Run once in the Supabase SQL editor.
--
-- What counts toward the future sasa airdrop, on the mainnet chains only:
--   every coin you create   = 100
--   every $1 you trade      = 1      (buys and sells, any coin on sasa, including your own,
--                                     and swaps of other coins made on the site)
-- The score is only used to rank people; the site shows the coins and the dollars traded,
-- never the score itself or any ratio. Nothing is stored: it is always counted from the
-- launches and trades the indexer already records, so it can't drift.

create index if not exists race_trades_trader_lower_idx on race_trades (lower(trader));
create index if not exists race_coins_creator_lower_idx on race_coins (lower(creator));

create or replace view airdrop_activity as
  with mainnet(chain_id) as (values (8453), (56), (4663), (5042)),
  made as (
    select lower(c.creator) as owner, count(*)::bigint as coins
    from race_coins c
    where exists (select 1 from race_chains rc join mainnet m on m.chain_id = rc.chain_id where rc.coin_id = c.id)
    group by 1
  ),
  traded as (
    select lower(t.trader) as owner, sum(t.usd_amount) as usd
    from race_trades t join mainnet m on m.chain_id = t.chain_id
    where t.via <> 'system' and t.trader <> ''
    group by 1
    union all
    select lower(e.trader), sum(e.usd)
    from ext_trades e
    group by 1
  ),
  traded_sum as (select owner, sum(usd) as usd from traded group by owner)
  select coalesce(m.owner, t.owner) as owner,
         coalesce(m.coins, 0) as coins,
         round(coalesce(t.usd, 0), 2) as traded_usd,
         coalesce(m.coins, 0) * 100 + coalesce(t.usd, 0) as score
  from made m full join traded_sum t on t.owner = m.owner;

revoke all on airdrop_activity from anon, authenticated;

-- The top of the list (no scores, just what people did).
create or replace function airdrop_board(p_limit int default 100)
returns table (owner text, coins bigint, traded_usd numeric, rank bigint)
language sql stable security definer set search_path = public as $$
  select owner, coins, traded_usd, rank() over (order by score desc)
  from airdrop_activity where score > 0
  order by score desc limit least(greatest(p_limit, 1), 200)
$$;

-- One person's activity and place in the list.
create or replace function airdrop_me(p_owner text)
returns table (coins bigint, traded_usd numeric, rank bigint, players bigint)
language sql stable security definer set search_path = public as $$
  with s as (select coalesce((select score from airdrop_activity where owner = lower(p_owner)), 0) as score)
  select
    coalesce((select coins from airdrop_activity where owner = lower(p_owner)), 0),
    coalesce((select traded_usd from airdrop_activity where owner = lower(p_owner)), 0),
    case when s.score > 0 then (select count(*) + 1 from airdrop_activity where score > s.score) else 0 end,
    (select count(*) from airdrop_activity where score > 0)
  from s
$$;

grant execute on function airdrop_board(int) to anon, authenticated;
grant execute on function airdrop_me(text) to anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on airdrop_activity to service_role;
    grant execute on function airdrop_board(int), airdrop_me(text) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
