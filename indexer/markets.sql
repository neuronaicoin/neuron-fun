-- All coins (update-61): coins from every DEX on our chains, refreshed every
-- ~90 s by the indexer from GeckoTerminal, safety-checked with GoPlus.
-- Run once in the Supabase SQL editor.

create table if not exists ext_tokens (
  network        text        not null,          -- GeckoTerminal network id (base, bsc, eth, ...)
  chain_id       integer,                       -- EVM chain id
  address        text        not null,          -- token contract (lowercase)
  pool           text,                          -- its most liquid pool we saw
  dex            text,
  name           text,
  symbol         text,
  image          text,
  price_usd      numeric,
  fdv_usd        numeric,
  mcap_usd       numeric,
  liq_usd        numeric,
  vol_24h        numeric,
  change_1h      numeric,
  change_24h     numeric,
  buys_24h       integer,
  sells_24h      integer,
  pool_created   timestamptz,
  trending_rank  integer,                       -- lower = hotter; null = not trending now
  seen_at        timestamptz not null default now(),
  -- GoPlus token check (null = not checked / chain not covered)
  gp_checked_at  timestamptz,
  gp_honeypot    boolean,
  gp_cannot_sell boolean,
  gp_buy_tax     numeric,
  gp_sell_tax    numeric,
  gp_mintable    boolean,
  gp_top10       numeric,                       -- share held by the 10 biggest holders (0..1)
  primary key (network, address)
);
create index if not exists ext_tokens_vol_idx on ext_tokens (vol_24h desc);
create index if not exists ext_tokens_new_idx on ext_tokens (pool_created desc);
create index if not exists ext_tokens_trend_idx on ext_tokens (trending_rank);

-- What the site may show: active coins only, and never ones that can't be sold.
create or replace view ext_coins as
  select network, chain_id, address, pool, dex, name, symbol, image, price_usd, fdv_usd, mcap_usd, liq_usd,
         vol_24h, change_1h, change_24h, buys_24h, sells_24h, pool_created, trending_rank, seen_at,
         gp_checked_at, gp_buy_tax, gp_sell_tax, gp_mintable, gp_top10
  from ext_tokens
  where coalesce(vol_24h, 0) >= 10000
    and coalesce(liq_usd, 0) >= 5000
    and seen_at > now() - interval '2 hours'
    and coalesce(gp_honeypot, false) = false
    and coalesce(gp_cannot_sell, false) = false
    and coalesce(gp_sell_tax, 0) < 0.3;

alter table ext_tokens enable row level security; -- no public access to the raw table
grant all on ext_tokens to service_role;
grant select on ext_coins to anon, authenticated, service_role;
notify pgrst, 'reload schema';
