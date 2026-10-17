-- Service heartbeats (watchdog.mjs, keeper/alert.mjs). Run once in the Supabase SQL editor
-- (safe to run again). Private: only the services (service key / database owner) touch it.
create table if not exists service_heartbeats (
  service text        primary key,
  at      timestamptz not null default now(),
  info    text        not null default ''
);
alter table service_heartbeats enable row level security;
revoke all on service_heartbeats from anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on service_heartbeats to service_role;
  end if;
end $$;
notify pgrst, 'reload schema';
