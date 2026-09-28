-- Profile pictures. Run once in the Supabase SQL editor BEFORE uploading update-32.
-- Needs social.sql.

alter table profiles add column if not exists avatar_url text check (avatar_url is null or char_length(avatar_url) <= 300);

create or replace view profiles_public as
  select p.address, p.username, p.color, p.emoji, p.bio, p.hide_trades, p.created_at,
         (select count(*) from follows f where f.followee = p.address)::int as followers,
         (select count(*) from follows f where f.follower = p.address)::int as following,
         p.avatar_url
  from profiles p;
grant select on profiles_public to anon, authenticated;

-- Reports: 3 different wallets remove a picture until the owner uploads a new one.
create table if not exists avatar_reports (
  address    text not null,
  reporter   text not null,
  created_at timestamptz not null default now(),
  primary key (address, reporter)
);
alter table avatar_reports enable row level security;
revoke all on avatar_reports from anon, authenticated;

create or replace function report_avatar(p_address text, p_reporter text) returns integer
language plpgsql as $$
declare n integer;
begin
  insert into avatar_reports (address, reporter) values (p_address, p_reporter) on conflict do nothing;
  select count(*) into n from avatar_reports where address = p_address;
  if n >= 3 then
    update profiles set avatar_url = null where address = p_address;
    delete from avatar_reports where address = p_address;
  end if;
  return n;
end $$;
revoke all on function report_avatar(text, text) from anon, authenticated, public;
grant execute on function report_avatar(text, text) to service_role;

-- Public bucket for the pictures (the API uploads with the secret key).
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('avatars', 'avatars', true, 262144, array['image/webp', 'image/jpeg', 'image/png'])
    on conflict (id) do nothing;
  end if;
end $$;
