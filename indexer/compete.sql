-- Creator competition (update-121). Run once in the Supabase SQL editor.
--
-- Ranks coin creators by the dollars other people traded in the coins they launched on sasa
-- during the competition (every chain's pool, buys and sells, through any app). The creator's
-- own trades, launch buys and sasa's system trades don't count; only coins launched in the
-- window count; team wallets are left out.

create index if not exists race_trades_ts_idx on race_trades (ts);

create or replace function comp_board(p_from timestamptz, p_to timestamptz, p_limit int default 100)
returns table (creator text, volume_usd numeric, coins bigint, trades bigint, rank bigint)
language sql stable security definer set search_path = public as $$
  with c as (
    select id, lower(creator) as creator
    from race_coins
    where launched_at >= p_from and launched_at < p_to
      and lower(creator) not in (
        '0x3c4e66b4b4ddd1f6348ad5fdfae7e60ac35aca6f', -- sasa treasury
        '0x5a5506fce4c9d9c2989a2988cb2b63988207bd1b', -- team
        '0x9f832eea4f7c246d196d8e9362fe2fc75202c528', -- keeper (v7)
        '0xd89ddf65ab3c12cc4b966db5bbe07fe01e881c21', -- keeper (v8)
        '0xb3d38b4007b287ad852aa4fc5da2c1029b6082ac'  -- relayer
      )
  ),
  t as (
    select c.creator, sum(t.usd_amount) as vol, count(*) as n
    from race_trades t join c on c.id = t.coin_id
    where t.chain_id in (8453, 56, 4663, 5042)
      and t.ts >= p_from and t.ts < p_to
      and t.via not in ('system', 'launch')
      and lower(t.trader) <> c.creator
    group by 1
  ),
  k as (select creator, count(*) as coins from c group by 1)
  select k.creator, round(coalesce(t.vol, 0), 2), k.coins, coalesce(t.n, 0), rank() over (order by coalesce(t.vol, 0) desc)
  from k left join t on t.creator = k.creator
  order by coalesce(t.vol, 0) desc, k.coins desc limit least(greatest(p_limit, 1), 200)
$$;

grant execute on function comp_board(timestamptz, timestamptz, int) to anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function comp_board(timestamptz, timestamptz, int) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
