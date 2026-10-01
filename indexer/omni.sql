-- v6 omnichain coins (run once in Supabase; safe to run twice).
-- Which chains each v6 coin launched on, and its address (the same on every chain).
create table if not exists coin_omni (
  coin_id text primary key references coins (id),
  coin    text not null,
  eids    integer[] not null
);
grant select on coin_omni to anon, authenticated;
alter table coin_omni enable row level security;
drop policy if exists "public read" on coin_omni;
create policy "public read" on coin_omni for select using (true);
notify pgrst, 'reload schema';
