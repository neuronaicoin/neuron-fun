-- Beta safety locks (update-33). Run once in the Supabase SQL editor BEFORE
-- uploading update-33. The indexer copies each chain's pause switch and
-- capacity here every few seconds, so the site reads one small table instead
-- of every visitor asking the chains.

create table if not exists chain_safety (
  chain_id    integer primary key,
  factory     text        not null,
  paused      boolean     not null default false,
  cap         numeric     not null default 0,   -- wei; 0 = no cap
  total       numeric     not null default 0,   -- wei held by all curves
  guardian    text        not null default '',
  owner       text        not null default '',
  updated_at  timestamptz not null default now()
);

alter table chain_safety enable row level security;
drop policy if exists "public read" on chain_safety;
create policy "public read" on chain_safety for select to anon, authenticated using (true);
grant select on chain_safety to anon, authenticated;
