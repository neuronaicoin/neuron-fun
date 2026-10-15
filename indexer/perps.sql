-- Perps alerts (update-47). Run once in the Supabase SQL editor (safe to run again).
--
-- People who opened a perps position on sasa while signed in. The indexer (perps.mjs) reads their
-- Hyperliquid positions every few seconds and writes a 🔔 notification (and phone push) when a take
-- profit, a stop loss or a liquidation closes one. Only the indexer and the site's server read or
-- write this table.

create table if not exists perps_watch (
  address     text        primary key,           -- lowercase sasa address (the Hyperliquid account)
  active      boolean     not null default true, -- false after a day with no open position
  positions   jsonb       not null default '{}', -- { coin: signed size } at the last look
  last_fill   bigint      not null default 0,    -- newest fill time already looked at (ms)
  idle_since  timestamptz,                       -- when the last position closed
  seen_at     timestamptz not null default now(),-- last time they opened one on sasa
  checked_at  timestamptz
);
create index if not exists perps_watch_active_idx on perps_watch (checked_at nulls first) where active;

alter table perps_watch enable row level security;
revoke all on perps_watch from anon, authenticated;
grant all on perps_watch to service_role;

-- notifications.pushed comes from forum.sql; make sure it's there
alter table notifications add column if not exists pushed boolean not null default true;

notify pgrst, 'reload schema';
