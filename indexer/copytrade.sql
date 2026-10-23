-- Copying whales on Futures (update-137). Run once in the Supabase SQL editor; safe to run twice.
--
-- A follower turns on copying for a Hyperliquid trader: when that trader opens a position, the
-- indexer (copytrade.mjs) opens the same side for the follower with the follower's own amount and
-- leverage cap; when the trader closes, it closes. Orders are placed by a trading key ("API wallet")
-- the follower approved on Hyperliquid: it can trade their futures account, never move money out.
-- The key is stored encrypted (COPY_KEY_SECRET, the same on Cloudflare and the indexer).

-- one trading key per follower
create table if not exists copy_agents (
  follower      text primary key,                -- lowercase sasa address
  agent_address text        not null,            -- the key's address (approved on Hyperliquid by the follower)
  key_enc       text        not null,            -- AES-GCM, base64(iv | ciphertext)
  created_at    timestamptz not null default now()
);
alter table copy_agents enable row level security;
revoke all on copy_agents from anon, authenticated;
grant all on copy_agents to service_role;

-- what each follower copies, and how
create table if not exists copy_follows (
  follower    text        not null,
  whale       text        not null,
  per_trade   numeric     not null,              -- dollars of margin per copied position
  max_lev     int         not null,              -- leverage cap
  copy_closes boolean     not null default true, -- close when the trader closes
  stop_loss   numeric,                           -- stop copying when the open copied positions lose this much (dollars)
  active      boolean     not null default true,
  paused_why  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (follower, whale)
);
create index if not exists copy_follows_whale_idx on copy_follows (whale) where active;
alter table copy_follows enable row level security;
revoke all on copy_follows from anon, authenticated;
grant all on copy_follows to service_role;

-- positions opened by copying (so only those are closed, never the follower's own)
create table if not exists copy_positions (
  follower  text        not null,
  whale     text        not null,
  coin      text        not null,
  side      text        not null,
  size      numeric     not null,
  entry     numeric,
  opened_at timestamptz not null default now(),
  primary key (follower, coin)
);
alter table copy_positions enable row level security;
revoke all on copy_positions from anon, authenticated;
grant all on copy_positions to service_role;

grant usage, select on all sequences in schema public to service_role;
notify pgrst, 'reload schema';
