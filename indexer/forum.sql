-- Forum. Run once in the Supabase SQL editor, BEFORE uploading update-27.
-- Needs alerts.sql (update-25) to have been run already.
--
-- Writes only happen through the /api functions (secret key). Anyone can
-- read the public views below; hidden posts show no text there.

create table if not exists forum_threads (
  id            bigserial primary key,
  board         text        not null,              -- 'sasa' or a coin id
  title         text        not null check (char_length(title) between 8 and 120),
  author        text        not null,              -- lower-case wallet address
  created_at    timestamptz not null default now(),
  last_post_at  timestamptz not null default now(),
  reply_count   integer     not null default 0,
  like_count    integer     not null default 0,
  words         integer     not null default 0,    -- total words, for the noindex rule
  pinned        boolean     not null default false,
  hidden        boolean     not null default false
);
create index if not exists forum_threads_board_idx on forum_threads (board, pinned desc, last_post_at desc) where not hidden;
create index if not exists forum_threads_recent_idx on forum_threads (last_post_at desc) where not hidden;
create index if not exists forum_threads_author_idx on forum_threads (author, created_at desc);

create table if not exists forum_posts (
  id          bigserial primary key,
  thread_id   bigint      not null references forum_threads (id) on delete cascade,
  author      text        not null,
  body        text        not null check (char_length(body) between 2 and 4000),
  share_bps   integer     not null default 0,      -- holding at posting time, in 1/100 of a percent
  created_at  timestamptz not null default now(),
  like_count  integer     not null default 0,
  report_count integer    not null default 0,
  hidden      text        check (hidden in ('self', 'mod', 'reports'))
);
create index if not exists forum_posts_thread_idx on forum_posts (thread_id, id);
create index if not exists forum_posts_author_idx on forum_posts (author, created_at desc);

create table if not exists forum_likes (
  post_id    bigint not null references forum_posts (id) on delete cascade,
  owner      text   not null,
  created_at timestamptz not null default now(),
  primary key (post_id, owner)
);

create table if not exists forum_reports (
  post_id    bigint not null references forum_posts (id) on delete cascade,
  owner      text   not null,
  created_at timestamptz not null default now(),
  primary key (post_id, owner)
);

-- Forum notifications (replies) are sent to phones by the indexer on Railway.
alter table notifications add column if not exists pushed boolean not null default true;
create index if not exists notifications_unpushed_idx on notifications (id) where not pushed;

alter table forum_threads enable row level security;
alter table forum_posts   enable row level security;
alter table forum_likes   enable row level security;
alter table forum_reports enable row level security;
revoke all on forum_threads, forum_posts, forum_likes, forum_reports from anon, authenticated;

-- ------------------------------------------------------------------ public read views

create or replace view forum_threads_public as
  select id, board, title, author, created_at, last_post_at, reply_count, like_count, words, pinned
  from forum_threads where not hidden;

create or replace view forum_posts_public as
  select p.id, p.thread_id, p.author, p.share_bps, p.created_at, p.like_count, p.hidden,
         case when p.hidden is null then p.body else '' end as body
  from forum_posts p join forum_threads t on t.id = p.thread_id
  where not t.hidden;

-- Boards that have threads, busiest first (home page).
create or replace view forum_boards_public as
  select board, count(*)::int as threads, max(last_post_at) as last_post_at
  from forum_threads where not hidden group by board;

grant select on forum_threads_public, forum_posts_public, forum_boards_public to anon, authenticated;

-- ------------------------------------------------------------------ counters

-- Called by the API after a new reply: bumps the thread in one statement.
create or replace function forum_after_post(p_thread bigint, p_words integer, p_bump boolean default true) returns void
language sql as $$
  update forum_threads
     set reply_count = greatest(0, (select count(*) - 1 from forum_posts where thread_id = p_thread and hidden is null)),
         last_post_at = case when p_bump then now() else last_post_at end,
         words = words + p_words
   where id = p_thread;
$$;

-- Likes: toggles and returns the new count.
create or replace function forum_toggle_like(p_post bigint, p_owner text) returns integer
language plpgsql as $$
declare n integer; t bigint;
begin
  if exists (select 1 from forum_likes where post_id = p_post and owner = p_owner) then
    delete from forum_likes where post_id = p_post and owner = p_owner;
  else
    insert into forum_likes (post_id, owner) values (p_post, p_owner);
  end if;
  select count(*) into n from forum_likes where post_id = p_post;
  update forum_posts set like_count = n where id = p_post returning thread_id into t;
  update forum_threads set like_count = (select coalesce(sum(like_count), 0) from forum_posts where thread_id = t) where id = t;
  return n;
end $$;

-- Reports: 3 different wallets hide a post until a moderator looks.
create or replace function forum_report(p_post bigint, p_owner text) returns integer
language plpgsql as $$
declare n integer;
begin
  insert into forum_reports (post_id, owner) values (p_post, p_owner) on conflict do nothing;
  select count(*) into n from forum_reports where post_id = p_post;
  update forum_posts set report_count = n,
         hidden = case when n >= 3 and hidden is null then 'reports' else hidden end
   where id = p_post;
  return n;
end $$;

revoke all on function forum_after_post(bigint, integer, boolean), forum_toggle_like(bigint, text), forum_report(bigint, text) from anon, authenticated, public;
grant execute on function forum_after_post(bigint, integer, boolean), forum_toggle_like(bigint, text), forum_report(bigint, text) to service_role;
