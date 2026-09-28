-- Mini price charts for coin cards (update-36). Run once in the Supabase SQL
-- editor BEFORE uploading update-36. The indexer fills it every minute: for
-- each coin, 24 prices over the last 4 hours (one per 10 minutes) on its
-- busiest chain. The site only draws the shape.

create table if not exists coin_spark (
  coin_id    text        primary key,
  pts        float8[]    not null,
  updated_at timestamptz not null default now()
);

alter table coin_spark enable row level security;
drop policy if exists "public read" on coin_spark;
create policy "public read" on coin_spark for select to anon, authenticated using (true);
grant select on coin_spark to anon, authenticated;

notify pgrst, 'reload schema';
