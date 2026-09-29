-- Coin links: X, Telegram and a website (update-48). Run once in the Supabase
-- SQL editor BEFORE uploading update-48. Only a coin's creator can set them
-- (through the site's API, which checks their signature); everyone can read.

create table if not exists coin_links (
  coin_id    text        primary key,
  x          text,
  telegram   text,
  website    text,
  updated_at timestamptz not null default now()
);

alter table coin_links enable row level security;
drop policy if exists "public read" on coin_links;
create policy "public read" on coin_links for select to anon, authenticated using (true);
grant select on coin_links to anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on coin_links to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
