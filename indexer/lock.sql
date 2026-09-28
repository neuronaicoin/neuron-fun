-- Creator locks (update-38). Run once in the Supabase SQL editor BEFORE
-- uploading update-38. When a creator locks their coins at launch (v4
-- contracts), the indexer notes until when, per chain.

create table if not exists coin_lock (
  coin_id  text        not null,
  chain_id integer     not null,
  until    timestamptz not null,
  primary key (coin_id, chain_id)
);

alter table coin_lock enable row level security;
drop policy if exists "public read" on coin_lock;
create policy "public read" on coin_lock for select to anon, authenticated using (true);
grant select on coin_lock to anon, authenticated;

notify pgrst, 'reload schema';
