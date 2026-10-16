-- Data tab (update-51): top traders, whale alerts, Market Fear & Greed history.
-- Run once in the Supabase SQL editor (safe to run again).
--
-- The indexer (whales.mjs) refreshes the top traders from Hyperliquid's public leaderboard,
-- saves one Fear & Greed reading an hour, and sends a 🔔 + phone push to people following a
-- trader when that trader opens, adds to, cuts or closes a position. The site reads the *_pub
-- views; only the indexer and the site's server write.

create table if not exists whales (
  address       text        primary key,          -- lowercase
  rank          integer,                          -- by 30-day profit
  name          text,                             -- the name they set on Hyperliquid, if any
  account_value numeric,
  pnl_day       numeric,
  pnl_week      numeric,
  pnl_month     numeric,
  pnl_all       numeric,
  roi_month     numeric,                          -- 0.25 = +25%
  vol_month     numeric,
  listed        boolean     not null default true,
  updated_at    timestamptz not null default now()
);
create index if not exists whales_rank_idx on whales (rank) where listed;
alter table whales enable row level security;
revoke all on whales from anon, authenticated;
grant all on whales to service_role;
create or replace view whales_pub as
  select address, rank, name, account_value, pnl_day, pnl_week, pnl_month, pnl_all, roi_month, vol_month, updated_at
  from whales where listed;
grant select on whales_pub to anon, authenticated;

create table if not exists fear_greed (
  t      timestamptz primary key,                 -- the hour
  score  integer     not null check (score between 0 and 100),
  parts  jsonb
);
alter table fear_greed enable row level security;
revoke all on fear_greed from anon, authenticated;
grant all on fear_greed to service_role;
create or replace view fear_greed_pub as select t, score from fear_greed;
grant select on fear_greed_pub to anon, authenticated;

-- who follows which trader (for alerts)
create table if not exists whale_follows (
  follower   text        not null,                -- lowercase sasa address
  whale      text        not null,                -- lowercase Hyperliquid address
  created_at timestamptz not null default now(),
  primary key (follower, whale)
);
create index if not exists whale_follows_whale_idx on whale_follows (whale);
alter table whale_follows enable row level security;
revoke all on whale_follows from anon, authenticated;
grant all on whale_follows to service_role;

-- the followed traders' positions at the last look
create table if not exists whale_state (
  address    text        primary key,
  positions  jsonb       not null default '{}',
  checked_at timestamptz
);
alter table whale_state enable row level security;
revoke all on whale_state from anon, authenticated;
grant all on whale_state to service_role;

alter table notifications add column if not exists pushed boolean not null default true;

notify pgrst, 'reload schema';
