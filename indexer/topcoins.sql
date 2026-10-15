-- Market: the 300 biggest coins (update-45). Run once in the Supabase SQL editor (safe to run again).
--
-- The indexer (topcoins.mjs) picks them once a day from CoinGecko's ranking by market cap:
-- no stablecoins, no wrapped / staked copies, and only coins that trade on a DEX of Base,
-- BNB Chain or Ethereum with enough liquidity (in that order: the cheapest chain wins).
-- Bitcoin, ETH and BNB are bought as cbBTC (Base), WETH (Base) and WBNB (BNB Chain).
-- Prices: every minute from each coin's DEX pool (DexScreener); rank, market cap, 24h change and
-- the 7-day line every 15 minutes from CoinGecko. The site reads top_coins_pub; only the indexer writes.

create table if not exists top_coins (
  cg_id       text        primary key,          -- CoinGecko id (bitcoin, ethereum, …): the page address
  rank        integer,                           -- market cap rank
  name        text        not null,
  symbol      text        not null,
  image       text,
  network     text        not null check (network in ('base', 'bsc', 'eth')),
  address     text        not null,              -- the token traded (lowercase)
  via         text,                              -- what is bought for it, when not the coin itself ("cbBTC on Base")
  pool        text,                              -- its most liquid DEX pool there (for the chart)
  dex         text,
  liq_usd     numeric,
  price_usd   numeric,
  mcap_usd    numeric,
  vol_24h     numeric,
  change_24h  numeric,
  change_7d   numeric,
  spark       jsonb,                             -- 7-day prices, about 42 points
  ref_price   numeric,                           -- CoinGecko's last price, market cap and 24h change:
  ref_mcap    numeric,                           -- the minute prices scale market cap and 24h change from them
  ref_change  numeric,
  listed      boolean     not null default true, -- in today's 300
  picked_at   timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table top_coins add column if not exists ref_price numeric;
alter table top_coins add column if not exists ref_mcap numeric;
alter table top_coins add column if not exists ref_change numeric;
create index if not exists top_coins_rank_idx on top_coins (rank) where listed;

alter table top_coins enable row level security;
revoke all on top_coins from anon, authenticated;
grant all on top_coins to service_role;

create or replace view top_coins_pub as
  select cg_id, rank, name, symbol, image, network, address, via, pool, dex, liq_usd, price_usd, mcap_usd,
         vol_24h, change_24h, change_7d, spark, updated_at
  from top_coins
  where listed;
grant select on top_coins_pub to anon, authenticated;

notify pgrst, 'reload schema';
