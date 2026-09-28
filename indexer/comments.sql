-- Coin comments. Run once in the Supabase SQL editor BEFORE uploading update-31.
-- Needs forum.sql. Each coin gets one pinned "comments" thread on its forum
-- board, so every comment is also on the server-rendered forum page (SEO).

alter table forum_threads add column if not exists kind text not null default 'thread' check (kind in ('thread', 'comments'));
create unique index if not exists forum_comments_one_per_coin on forum_threads (board) where kind = 'comments';

create or replace view forum_threads_public as
  select id, board, title, author, created_at, last_post_at, reply_count, like_count, words, pinned, kind
  from forum_threads where not hidden;
grant select on forum_threads_public to anon, authenticated;
