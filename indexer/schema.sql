-- Neuron.fun database. Run once in the Supabase SQL editor.
--
-- The indexer writes (as the database owner, over a direct connection).
-- The website only reads, through the public Data API as `anon`.
-- Everything here is public chain data; nothing private is stored.

create table if not exists indexer_state (
  chain_id   integer primary key,
  last_block bigint  not null
);

-- One row per coin: the same creator + launch key on any number of chains.
create table if not exists coins (
  id               text primary key,          -- lower(creator) || ':' || launch_key
  creator          text not null,
  launch_key       text not null,
  name             text not null,
  symbol           text not null,
  logo             text not null default '',
  description      text not null default '',
  created_at       timestamptz not null,
  graduated_chain  integer,
  graduated_at     timestamptz
);
create index if not exists coins_created_idx on coins (created_at desc);
create index if not exists coins_creator_idx on coins (creator);

-- One row per coin per chain.
create table if not exists curves (
  chain_id            integer not null,
  curve               text    not null,
  token               text    not null,
  coin_id             text    not null references coins (id),
  state               smallint not null default 0,   -- 0 trading, 1 closed, 2 graduated
  initial_virtual_native numeric not null,
  virtual_native      numeric not null,
  virtual_token       numeric not null,
  real_native         numeric not null default 0,
  created_block       bigint  not null,
  created_at          timestamptz not null,
  primary key (chain_id, curve)
);
create unique index if not exists curves_token_idx on curves (chain_id, token);
create index if not exists curves_coin_idx on curves (coin_id);

-- Every buy and sell on a curve.
create table if not exists trades (
  chain_id      integer not null,
  tx_hash       text    not null,
  log_index     integer not null,
  block_number  bigint  not null,
  ts            timestamptz not null,
  curve         text    not null,
  coin_id       text    not null,
  trader        text    not null,
  is_buy        boolean not null,
  native_amount numeric not null,
  token_amount  numeric not null,
  fee           numeric not null,
  -- Curve price right after the trade: native per token.
  price         numeric not null,
  primary key (chain_id, tx_hash, log_index)
);
create index if not exists trades_coin_ts_idx on trades (coin_id, ts desc);
create index if not exists trades_curve_ts_idx on trades (chain_id, curve, ts);
create index if not exists trades_trader_idx on trades (trader);

-- Token transfers, kept only to maintain balances idempotently.
create table if not exists transfers (
  chain_id   integer not null,
  tx_hash    text    not null,
  log_index  integer not null,
  token      text    not null,
  from_addr  text    not null,
  to_addr    text    not null,
  amount     numeric not null,
  primary key (chain_id, tx_hash, log_index)
);

create table if not exists balances (
  chain_id integer not null,
  token    text    not null,
  holder   text    not null,
  amount   numeric not null default 0,
  primary key (chain_id, token, holder)
);
create index if not exists balances_holder_idx on balances (holder) where amount > 0;
create index if not exists balances_token_idx on balances (chain_id, token) where amount > 0;

-- ------------------------------------------------------------------ views

-- Addresses that hold tokens but are not people.
create or replace view system_addresses as
  select chain_id, token, curve as addr from curves
  union all
  select chain_id, token, '0x000000000000000000000000000000000000dead' from curves
  union all
  select chain_id, token, '0x0000000000000000000000000000000000000000' from curves;

create or replace view holder_counts as
  select b.chain_id, b.token, count(*)::int as holders
  from balances b
  where b.amount > 0
    and not exists (
      select 1 from system_addresses s
      where s.chain_id = b.chain_id and s.token = b.token and s.addr = b.holder)
  group by b.chain_id, b.token;

-- Everything a coin card or coin page header needs, in one row.
create or replace view coin_summary as
  select
    c.*,
    (select coalesce(json_agg(json_build_object(
        'chain_id', k.chain_id, 'curve', k.curve, 'token', k.token, 'state', k.state,
        'real_native', k.real_native::text, 'virtual_native', k.virtual_native::text,
        'virtual_token', k.virtual_token::text,
        'holders', coalesce(h.holders, 0)) order by k.chain_id), '[]'::json)
     from curves k
     left join holder_counts h on h.chain_id = k.chain_id and h.token = k.token
     where k.coin_id = c.id) as curves,
    (select count(*) from trades t where t.coin_id = c.id and t.ts > now() - interval '24 hours')::int as trades_24h,
    (select count(*) from trades t where t.coin_id = c.id and t.is_buy and t.ts > now() - interval '24 hours')::int as buys_24h,
    (select count(*) from trades t where t.coin_id = c.id and not t.is_buy and t.ts > now() - interval '24 hours')::int as sells_24h,
    (select coalesce(sum(t.native_amount), 0)::text from trades t where t.coin_id = c.id and t.ts > now() - interval '24 hours') as volume_native_24h,
    (select max(t.ts) from trades t where t.coin_id = c.id) as last_trade_at
  from coins c;

-- OHLC candles for one curve. bucket is in seconds (60, 300, 3600, ...).
create or replace function candles(p_chain_id integer, p_curve text, p_bucket integer, p_limit integer default 500)
returns table (t timestamptz, open numeric, high numeric, low numeric, close numeric, volume numeric)
language sql stable as $$
  select
    to_timestamp(floor(extract(epoch from ts) / p_bucket) * p_bucket) as t,
    (array_agg(price order by ts, log_index))[1] as open,
    max(price) as high,
    min(price) as low,
    (array_agg(price order by ts desc, log_index desc))[1] as close,
    sum(native_amount) as volume
  from trades
  where chain_id = p_chain_id and curve = lower(p_curve)
  group by 1
  order by 1 desc
  limit greatest(1, least(p_limit, 2000));
$$;

-- ------------------------------------------------------------------ access

alter table indexer_state enable row level security;
alter table coins         enable row level security;
alter table curves        enable row level security;
alter table trades        enable row level security;
alter table transfers     enable row level security;
alter table balances      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['coins', 'curves', 'trades', 'balances'] loop
    execute format('drop policy if exists "public read" on %I', t);
    execute format('create policy "public read" on %I for select to anon, authenticated using (true)', t);
    execute format('grant select on %I to anon, authenticated', t);
  end loop;
end $$;

grant select on system_addresses, holder_counts, coin_summary to anon, authenticated;
grant execute on function candles(integer, text, integer, integer) to anon, authenticated;
