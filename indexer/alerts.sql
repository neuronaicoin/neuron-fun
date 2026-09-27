-- Price alerts and notifications. Run once in the Supabase SQL editor,
-- BEFORE uploading update-25.
--
-- These tables are private. The website never reads them directly: the
-- /api functions on Cloudflare (with the secret key) and the indexer on
-- Railway (database owner) are the only ones that touch them. Row level
-- security is on with no policies, so the public key sees nothing.

create table if not exists alerts (
  id          bigserial primary key,
  owner       text        not null,                 -- lower-case wallet address
  coin_id     text        not null references coins (id) on delete cascade,
  kind        text        not null check (kind in ('mc', 'price', 'move', 'bond', 'grad')),
  dir         text        not null default '' check (dir in ('above', 'below', 'up', 'down', 'any', '')),
  target      numeric     not null default 0 check (target >= 0),
  repeat      boolean     not null default false,
  push        boolean     not null default true,
  active      boolean     not null default true,
  -- Price / market cap alerts fire when the line is crossed, then wait
  -- until the value is back on the other side before they can fire again.
  armed       boolean     not null default true,
  fired_at    timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists alerts_owner_idx on alerts (owner, created_at desc);
create index if not exists alerts_active_idx on alerts (coin_id) where active;

create table if not exists notifications (
  id          bigserial primary key,
  owner       text        not null,
  coin_id     text,
  kind        text        not null default 'alert',
  title       text        not null,
  body        text        not null,
  url         text        not null default '',
  read        boolean     not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists notifications_owner_idx on notifications (owner, id desc);
create index if not exists notifications_unread_idx on notifications (owner) where not read;
create index if not exists notifications_age_idx on notifications (created_at);

-- One row per browser / phone that turned on notifications.
create table if not exists push_subs (
  endpoint    text primary key,
  owner       text        not null,
  p256dh      text        not null,
  auth        text        not null,
  failures    integer     not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists push_subs_owner_idx on push_subs (owner);

-- Hard limit, whatever calls the database: 50 alerts switched on per wallet.
create or replace function alerts_limit() returns trigger language plpgsql as $$
begin
  if new.active and (tg_op = 'INSERT' or not old.active) then
    if (select count(*) from alerts where owner = new.owner and active and id <> new.id) >= 50 then
      raise exception 'alert_limit' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists alerts_limit on alerts;
create trigger alerts_limit before insert or update of active on alerts
  for each row execute function alerts_limit();

-- Max 10 phones / browsers per wallet: the oldest one is dropped.
create or replace function push_subs_limit() returns trigger language plpgsql as $$
begin
  delete from push_subs where endpoint in (
    select endpoint from push_subs where owner = new.owner and endpoint <> new.endpoint
    order by created_at desc offset 9
  );
  return new;
end $$;
drop trigger if exists push_subs_limit on push_subs;
create trigger push_subs_limit after insert on push_subs
  for each row execute function push_subs_limit();

alter table alerts        enable row level security;
alter table notifications enable row level security;
alter table push_subs     enable row level security;
revoke all on alerts, notifications, push_subs from anon, authenticated;

-- Needed by the alert checker: price one hour ago on one curve.
create index if not exists trades_curve_ts_desc_idx on trades (chain_id, curve, ts desc);
