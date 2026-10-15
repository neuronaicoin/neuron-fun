-- Auto orders on race coins and other DEXs' coins (take profit, stop loss, buy the dip).
-- Run once in the Supabase SQL editor (safe to run again).
--
-- An order is signed by the user (EIP-712, contracts-v7/src/auto/AutoOrders.sol) and stored
-- here by the site's API (/api/auto). sasa's keeper (keeper/auto.mjs) watches the open ones and
-- executes them on chain when the price is reached. Nobody but the API and the keeper (service
-- key) reads or writes this table: the site goes through the API.

create table if not exists auto_orders (
  id           bigserial   primary key,
  owner        text        not null,                    -- the user (lowercase)
  chain_id     integer     not null,                    -- where AutoOrders runs it
  contract     text        not null,                    -- AutoOrders address (lowercase)
  kind         text        not null check (kind in ('tp', 'sl', 'dip')),
  coin         text        not null,                    -- the coin (lowercase)
  coin_chain   integer     not null,                    -- where the coin is bought / sold
  coin_kind    text        not null check (coin_kind in ('race', 'ext')),
  race_id      text,                                    -- race coins: the race id
  network      text,                                    -- other DEXs' coins: the network id (base, bsc, ...)
  symbol       text        not null default '',
  trigger_usd  numeric     not null check (trigger_usd > 0), -- price per coin that sets it off
  amount_usd   numeric     not null default 0,          -- about how big it is, for display
  nonce        text        not null,
  order_json   jsonb       not null,                    -- the signed order (numbers as strings)
  signature    text        not null,
  status       text        not null default 'open' check (status in ('open', 'filled', 'cancelled', 'expired', 'failed')),
  note         text,
  attempts     integer     not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  filled_tx    text,
  filled_at    timestamptz,
  out_amount   text,
  unique (contract, owner, nonce)
);
create index if not exists auto_orders_open_idx on auto_orders (chain_id) where status = 'open';
create index if not exists auto_orders_owner_idx on auto_orders (owner, id desc);

alter table auto_orders enable row level security;
revoke all on auto_orders from anon, authenticated;
grant all on auto_orders to service_role;
grant usage, select on sequence auto_orders_id_seq to service_role;
