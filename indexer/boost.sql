-- Paid placement ("Boosted" row on Explore). Run once in Supabase; safe to run twice.
-- One row per coin address (the same on every chain): boosted until this time.
create table if not exists coin_boost (
  coin  text primary key,
  until timestamptz not null
);
grant select on coin_boost to anon, authenticated;
alter table coin_boost enable row level security;
drop policy if exists "public read" on coin_boost;
create policy "public read" on coin_boost for select using (true);

-- Coins boosted right now, newest end first, with their sasa coin id.
create or replace view boosted_coins as
  select distinct on (b.coin) cu.coin_id, b.coin, b.until
  from coin_boost b
  join curves cu on cu.token = b.coin
  where b.until > now()
  order by b.coin, b.until desc;
grant select on boosted_coins to anon, authenticated;
notify pgrst, 'reload schema';
