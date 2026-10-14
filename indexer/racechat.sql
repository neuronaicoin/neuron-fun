-- Live race chat: short messages on a race coin's page while its race runs (and a little
-- after). Run once in the Supabase SQL editor. Written only by the site's API (secret key);
-- everyone can read what isn't hidden.

create table if not exists race_chat (
  id         bigserial primary key,
  coin_id    text        not null,
  author     text        not null,           -- wallet address, lowercase
  body       text        not null check (char_length(body) between 1 and 200),
  created_at timestamptz not null default now(),
  hidden     boolean     not null default false
);
create index if not exists race_chat_coin_idx on race_chat (coin_id, id desc);
create index if not exists race_chat_author_idx on race_chat (author, created_at desc);

alter table race_chat enable row level security;
drop policy if exists "public read" on race_chat;
create policy "public read" on race_chat for select to anon, authenticated using (not hidden);
revoke insert, update, delete on race_chat from anon, authenticated;
grant select on race_chat to anon, authenticated;
grant usage, select on sequence race_chat_id_seq to service_role;

notify pgrst, 'reload schema';
