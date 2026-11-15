-- sasa Chat (/chat/): one public room. Short plain text (100 characters), no links or ads,
-- 20 messages a day per account. Messages older than 4 hours are not shown and are deleted
-- (the API deletes them as new ones come in). Written only by the site's API (secret key).
create table if not exists site_chat (
  id         bigserial primary key,
  author     text        not null,           -- wallet address, lowercase
  body       text        not null check (char_length(body) between 1 and 100),
  created_at timestamptz not null default now(),
  hidden     boolean     not null default false
);
create index if not exists site_chat_created_idx on site_chat (created_at desc);
create index if not exists site_chat_author_idx on site_chat (author, created_at desc);

alter table site_chat enable row level security;
drop policy if exists "public read" on site_chat;
create policy "public read" on site_chat for select to anon, authenticated
  using (not hidden and created_at > now() - interval '4 hours');
revoke insert, update, delete on site_chat from anon, authenticated;
grant select on site_chat to anon, authenticated;
grant usage, select on sequence site_chat_id_seq to service_role;

-- How many of today's 20 messages an account has left (the page shows it under the box).
create or replace function chat_left(p_address text)
returns int language sql stable security definer set search_path = public as $$
  select greatest(0, 20 - coalesce((select n from ai_usage where address = lower(p_address) and day = current_date and kind = 'sitechat'), 0))
$$;
grant execute on function chat_left(text) to anon, authenticated;

notify pgrst, 'reload schema';
