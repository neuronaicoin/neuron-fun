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
  primary key (chain_id, tx_hash, log_index)
);
create index if not exists race_fees_coin_idx on race_fees (coin_id);

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

notify pgrst, 'reload schema';
