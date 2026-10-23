-- Keeper log lines in the database (update-127). Run once in the Supabase SQL editor.
-- The race keepers write their meaningful lines here (status, sends, failures, alerts) so they
-- can be read without Railway access. Rows older than 3 days are removed by the keepers.
create table if not exists keeper_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  service text not null,
  line text not null
);
create index if not exists keeper_log_at_idx on keeper_log (at desc);
alter table keeper_log enable row level security;
drop policy if exists keeper_log_read on keeper_log;
create policy keeper_log_read on keeper_log for select using (true);
grant select on keeper_log to anon, authenticated;
notify pgrst, 'reload schema';
