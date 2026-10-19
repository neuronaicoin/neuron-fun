-- Trades of other DEXs' coins made on sasa (Buy / Sell on a coin page, and auto orders).
-- Run once in the Supabase SQL editor (safe to run again).
--
-- Rows are written only with the service key: by the site's API (/api/exttrade), after it has
-- checked the trade on chain and with Relay (sasa's fee on it, the dollars that moved), and by the
-- keeper when an auto order on such a coin runs. The Stats page reads the totals through
-- ext_stats(); nobody can read or write the rows themselves.

create table if not exists ext_trades (
  id          bigserial   primary key,
  chain_id    integer     not null,               -- where the trade was sent
  tx          text        not null,               -- its transaction (lowercase)
  request_id  text        unique,                 -- Relay's request (one trade, counted once)
  trader      text        not null,               -- lowercase
  side        text        not null check (side in ('buy', 'sell')),
  coin        text        not null default '',    -- lowercase
  coin_chain  integer     not null,               -- the chain the coin lives on
  usd         numeric     not null check (usd >= 0 and usd < 100000000),
  source      text        not null default 'trade' check (source in ('trade', 'auto')),
  created_at  timestamptz not null default now(),
  unique (chain_id, tx)
);
alter table ext_trades add column if not exists request_id text unique;
-- sasa's fee on the trade in dollars (what Relay paid the treasury) and when the trade was made
alter table ext_trades add column if not exists fee_usd numeric;
alter table ext_trades add column if not exists traded_at timestamptz;
create index if not exists ext_trades_time_idx on ext_trades (created_at desc);

alter table ext_trades enable row level security;
revoke all on ext_trades from anon, authenticated;
grant all on ext_trades to service_role;
grant usage, select on sequence ext_trades_id_seq to service_role;

-- Totals for the Stats page: last period ("recent", since p_since) and all time, and per chain.
create or replace function ext_stats(p_since timestamptz)
returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'recent', (select json_build_object('volume', coalesce(sum(usd), 0), 'trades', count(*), 'traders', count(distinct trader))
               from ext_trades where created_at >= p_since),
    'all',    (select json_build_object('volume', coalesce(sum(usd), 0), 'trades', count(*), 'traders', count(distinct trader))
               from ext_trades),
    'chains', (select coalesce(json_agg(x order by x.volume desc), '[]'::json)
               from (select coin_chain as chain_id, sum(usd) as volume, count(*) as trades
                     from ext_trades group by coin_chain) x)
  );
$$;
revoke all on function ext_stats(timestamptz) from public;
grant execute on function ext_stats(timestamptz) to anon, authenticated, service_role;

-- The coins someone bought on sasa (for the "You" page: every coin of another DEX they hold).
-- Only which coins, never amounts or dollars: the page reads the amounts on chain itself.
create or replace function ext_held(p_trader text)
returns table (coin text, coin_chain integer)
language sql stable security definer set search_path = public as $$
  select distinct coin, coin_chain from ext_trades
  where trader = lower(p_trader) and side = 'buy' and coin <> ''
  limit 200;
$$;
revoke all on function ext_held(text) from public;
grant execute on function ext_held(text) to anon, authenticated, service_role;
