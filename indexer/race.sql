-- sasa v7 (five-minute race) tables. Run once in the Supabase SQL editor; safe to run again.
--
-- v7 coins live in their own tables so Explore, stats, points and the v5/v6 pages stay exactly
-- as they are. Holders reuse transfers/balances (keyed by token address, so nothing mixes).
--
--   race_coins   one row per coin (the race itself: start, end, winner, total)
--   race_chains  one row per coin per chain (pool, live money, report, won/lost, trade counts)
--   race_trades  every swap in a race pool (sasa router, other routers and bots alike)
--   race_state   the race indexer's checkpoint per chain

create table if not exists race_state (
  chain_id   integer primary key,
  last_block bigint  not null
);

create table if not exists race_coins (
  id           text primary key,             -- the coin id (bytes32, 0x… lowercase), same on every chain
  coin         text not null,                -- the token address, same on every chain
  creator      text not null,
  name         text not null,
  symbol       text not null,
  logo         text not null default '',
  description  text not null default '',
  fee_mode     smallint not null default 0,  -- 0 fees to the creator, 1 buyback & burn
  eids         integer[] not null,           -- LayerZero ids of the chains in the race
  launched_at  timestamptz not null,         -- the first chain's start
  ends_at      timestamptz not null,         -- when the last chain's five minutes are over
  winner_eid   integer,
  winner_chain integer,
  total_usd    numeric,                      -- all chains' race money at the verdict, dollars
  decided_at   timestamptz,
  created_block bigint not null default 0
);
create index if not exists race_coins_launched_idx on race_coins (launched_at desc);
create index if not exists race_coins_live_idx on race_coins (ends_at) where winner_eid is null;
create index if not exists race_coins_coin_idx on race_coins (coin);

create table if not exists race_chains (
  coin_id      text    not null references race_coins (id) on delete cascade,
  chain_id     integer not null,
  eid          integer not null,
  seat         text    not null,
  pool_id      text    not null default '',  -- the coin's launch pool (Uniswap v4 / PancakeSwap Infinity)
  native       text    not null,             -- 'ETH', 'BNB' or 'USDC': what the pool trades against
  launched_at  timestamptz,                  -- this chain's own start (each chain is launched in its own transaction)
  ends_at      timestamptz,                  -- this chain's launched_at + 5 minutes
  state        smallint not null default 1,  -- 1 racing, 2 won, 3 lost
  pool_native  numeric not null default 0,   -- pool money now, native units (human, not wei)
  pool_usd     numeric not null default 0,   -- the same in dollars (live during the race)
  reported_usd numeric,                      -- the chain's official race money (hub report)
  handed_over  boolean not null default false,
  buys         integer not null default 0,
  sells        integer not null default 0,
  volume_usd   numeric not null default 0,
  price_usd    numeric,                      -- last trade price, dollars per coin
  fees_native  numeric not null default 0,   -- pool fees collected after the race (native, human)
  updated_at   timestamptz not null default now(),
  primary key (coin_id, chain_id)
);
create index if not exists race_chains_chain_idx on race_chains (chain_id);
create index if not exists race_chains_racing_idx on race_chains (coin_id) where state = 1;

create table if not exists race_trades (
  chain_id      integer not null,
  tx_hash       text    not null,
  log_index     integer not null,
  block_number  bigint  not null,
  ts            timestamptz not null,
  coin_id       text    not null,
  trader        text    not null,
  is_buy        boolean not null,
  native_amount numeric not null,   -- human units (ETH / BNB / USDC)
  token_amount  numeric not null,   -- human units (coins)
  usd_amount    numeric not null,
  price_usd     numeric not null,   -- dollars per coin after this trade
  via           text    not null,   -- 'sasa' (our router), 'launch' (creator's first buy), 'pool' (any other), 'system'
  primary key (chain_id, tx_hash, log_index)
);
create index if not exists race_trades_coin_ts_idx on race_trades (coin_id, ts desc);
create index if not exists race_trades_trader_idx on race_trades (trader);

-- Pool fees collected after the race (one row per collection, so a re-read never counts twice).
create table if not exists race_fees (
  chain_id      integer not null,
  tx_hash       text    not null,
  log_index     integer not null,
  coin_id       text    not null,
  native_amount numeric not null,   -- human units
  coin_amount   numeric not null,   -- human units
  block_number  bigint,             -- where the collection sits (the trades before it paid it)
  created_at    timestamptz not null default now(),
  primary key (chain_id, tx_hash, log_index)
);
create index if not exists race_fees_coin_idx on race_fees (coin_id);
alter table race_fees add column if not exists block_number bigint;
alter table race_fees add column if not exists created_at timestamptz not null default now();

-- ------------------------------------------------------------------ chart

-- Price candles of one race coin, dollars per coin. p_chain_id null = every chain together
-- (before the verdict each chain has its own pool and price, so the page asks per chain).
create or replace function race_candles(p_coin_id text, p_chain_id integer, p_bucket integer, p_limit integer default 500)
returns table (t timestamptz, open numeric, high numeric, low numeric, close numeric, volume numeric)
language sql stable as $$
  select
    to_timestamp(floor(extract(epoch from ts) / greatest(p_bucket, 1)) * greatest(p_bucket, 1)) as t,
    (array_agg(price_usd order by ts, chain_id, log_index))[1] as open,
    max(price_usd) as high,
    min(price_usd) as low,
    (array_agg(price_usd order by ts desc, chain_id desc, log_index desc))[1] as close,
    sum(usd_amount) as volume
  from race_trades
  where coin_id = lower(p_coin_id)
    and (p_chain_id is null or chain_id = p_chain_id)
    and price_usd > 0
  group by 1
  order by 1 desc
  limit greatest(1, least(p_limit, 2000));
$$;

-- Numbers for the Stats page and the race wall, in one call. p_since: start of "recent"
-- (the page sends 24 hours ago). Every figure comes from the indexed chain data.
create index if not exists race_trades_ts_idx on race_trades (ts desc);

create or replace function race_stats(p_since timestamptz)
returns json
language sql stable as $$
  select json_build_object(
    -- chain league: races each chain took part in, races it won, its race volume and traders
    'league', (
      select coalesce(json_agg(x order by x.wins desc, x.volume desc), '[]'::json)
      from (
        select c.chain_id,
               count(*)                              as races,
               count(*) filter (where c.state = 2)   as wins,
               coalesce(sum(c.volume_usd), 0)        as volume,
               (select count(distinct t.trader) from race_trades t where t.chain_id = c.chain_id and t.via <> 'system') as traders
        from race_chains c
        group by c.chain_id
      ) x
    ),
    'recent', json_build_object(
      'races',   (select count(*) from race_coins where launched_at >= p_since),
      'volume',  (select coalesce(sum(usd_amount), 0) from race_trades where ts >= p_since and via <> 'system'),
      'trades',  (select count(*) from race_trades where ts >= p_since and via <> 'system'),
      'traders', (select count(distinct trader) from race_trades where ts >= p_since and via <> 'system'),
      'new_traders', (
        select count(*) from (
          select trader from race_trades where via <> 'system' group by trader having min(ts) >= p_since
        ) n
      )
    ),
    'all', json_build_object(
      'races',   (select count(*) from race_coins),
      'decided', (select count(*) from race_coins where winner_chain is not null),
      'volume',  (select coalesce(sum(usd_amount), 0) from race_trades where via <> 'system'),
      'trades',  (select count(*) from race_trades where via <> 'system'),
      'traders', (select count(distinct trader) from race_trades where via <> 'system')
    ),
    'biggest_race', (
      select row_to_json(r) from (
        select id, name, symbol, logo, total_usd as usd, winner_chain as chain_id
        from race_coins where total_usd is not null order by total_usd desc limit 1
      ) r
    ),
    'biggest_buy', (
      select row_to_json(b) from (
        select c.id, c.name, c.symbol, c.logo, t.usd_amount as usd, t.chain_id
        from race_trades t join race_coins c on c.id = t.coin_id
        where t.is_buy and t.via <> 'system' order by t.usd_amount desc limit 1
      ) b
    ),
    'most_traders', (
      select row_to_json(m) from (
        select c.id, c.name, c.symbol, c.logo, count(distinct t.trader) as traders
        from race_trades t join race_coins c on c.id = t.coin_id
        where t.via <> 'system'
        group by c.id, c.name, c.symbol, c.logo
        order by count(distinct t.trader) desc limit 1
      ) m
    )
  );
$$;

-- ------------------------------------------------------------------ access (read-only for the site)

alter table race_state  enable row level security;
alter table race_coins  enable row level security;
alter table race_chains enable row level security;
alter table race_trades enable row level security;
alter table race_fees   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['race_coins', 'race_chains', 'race_trades', 'race_fees'] loop
    execute format('drop policy if exists "public read" on %I', t);
    execute format('create policy "public read" on %I for select to anon, authenticated using (true)', t);
    execute format('revoke insert, update, delete on %I from anon, authenticated', t);
    execute format('grant select on %I to anon, authenticated', t);
  end loop;
end $$;
revoke all on race_state from anon, authenticated;
grant execute on function race_candles(text, integer, integer, integer) to anon, authenticated;
grant execute on function race_stats(timestamptz) to anon, authenticated;

notify pgrst, 'reload schema';
