-- Points, Season 0 (update-45b). Run once in the Supabase SQL editor BEFORE
-- uploading update-45b. The indexer calls refresh_points() every few minutes;
-- everything here is recomputed from what people actually did on-chain and
-- on the site, so the numbers can always be rebuilt.
--
-- How points are earned
--   quests (once each)     first coin 200 · AI idea 100 · first buy 50 · follow 3 traders 50
--                          copy a trader 100 · price alert 30 · forum post 50 · locked launch 150
--   trading (every day)    1 point per $1 traded, up to 500 a day; trades in your own coins don't count
--   streak boost           trading days in a row multiply that day's trading points, up to 2x at 7 days
--   graduation             1,000 for every coin you launched that graduates
--   welcome                100 when you join with a friend's invite link
--   friends                20% of the points your invited friends earn (not counting their own friends/welcome points)

create table if not exists points_events (
  owner      text        not null,
  kind       text        not null,
  ref        text        not null,   -- what it was for: a quest name, a day, a coin, a friend
  pts        integer     not null check (pts >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner, kind, ref)
);
create index if not exists points_events_owner_idx on points_events (owner);

alter table points_events enable row level security;
revoke all on points_events from anon, authenticated;

create or replace function refresh_points(p_eth_usd numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  -- ---------------------------------------------------------------- quests
  begin
    insert into points_events (owner, kind, ref, pts)
      select distinct lower(creator), 'quest', 'launch', 200 from coins
    on conflict do nothing;
  exception when undefined_table or undefined_column then null; -- that feature's SQL not run yet
  end;
  begin
    insert into points_events (owner, kind, ref, pts)
      select distinct lower(c.creator), 'quest', 'locked', 150 from coins c join coin_lock l on l.coin_id = c.id
    on conflict do nothing;
  exception when undefined_table or undefined_column then null; -- that feature's SQL not run yet
  end;
  begin
    insert into points_events (owner, kind, ref, pts)
      select distinct trader, 'quest', 'buy', 50 from trades where is_buy
    on conflict do nothing;
  exception when undefined_table or undefined_column then null; -- that feature's SQL not run yet
  end;
  begin
    insert into points_events (owner, kind, ref, pts)
      select follower, 'quest', 'follow3', 50 from follows group by follower having count(*) >= 3
    on conflict do nothing;
  exception when undefined_table or undefined_column then null; -- that feature's SQL not run yet
  end;
  begin
    insert into points_events (owner, kind, ref, pts)
      select distinct follower, 'quest', 'copy', 100 from copy_follows
    on conflict do nothing;
  exception when undefined_table or undefined_column then null; -- that feature's SQL not run yet
  end;
  begin
    insert into points_events (owner, kind, ref, pts)
      select distinct owner, 'quest', 'alert', 30 from alerts
    on conflict do nothing;
  exception when undefined_table or undefined_column then null; -- that feature's SQL not run yet
  end;
  begin
    insert into points_events (owner, kind, ref, pts)
      select distinct lower(author), 'quest', 'forum', 50 from forum_posts
    on conflict do nothing;
  exception when undefined_table or undefined_column then null; -- that feature's SQL not run yet
  end;
  begin
    insert into points_events (owner, kind, ref, pts)
      select distinct lower(address), 'quest', 'ai', 100 from ai_usage where kind = 'ideas' and n > 0
    on conflict do nothing;
  exception when undefined_table or undefined_column then null; -- that feature's SQL not run yet
  end;

  -- ---------------------------------------------------------------- graduations
  insert into points_events (owner, kind, ref, pts)
    select lower(creator), 'grad', id, 1000 from coins where graduated_chain is not null
  on conflict do nothing;

  -- ---------------------------------------------------------------- welcome
  insert into points_events (owner, kind, ref, pts)
    select referee, 'welcome', 'invite', 100 from referrals
  on conflict do nothing;

  -- ---------------------------------------------------------------- trading, last 2 days
  -- Streak: days in a row (ending that day) with at least one counted trade.
  with days as (
    select t.trader, (t.ts at time zone 'utc')::date as day, sum(t.native_amount) as vol
    from trades t join coins c on c.id = t.coin_id
    where t.ts > now() - interval '40 days' and lower(c.creator) <> t.trader
    group by 1, 2
  ),
  runs as (
    select trader, day, vol,
           day - (row_number() over (partition by trader order by day))::int as grp
    from days
  ),
  streaks as (
    select trader, day, vol,
           row_number() over (partition by trader, grp order by day) as streak
    from runs
  )
  insert into points_events (owner, kind, ref, pts, updated_at)
    select trader, 'trade', day::text,
           floor(least(500, floor(vol / 1e18 * p_eth_usd)) * least(2.0, 1 + (streak - 1) / 6.0))::int,
           now()
    from streaks
    where day >= (now() at time zone 'utc')::date - 1 and vol > 0
  on conflict (owner, kind, ref) do update set pts = excluded.pts, updated_at = now();

  -- ---------------------------------------------------------------- friends (20%)
  insert into points_events (owner, kind, ref, pts, updated_at)
    select r.referrer, 'friends', r.referee,
           floor(0.2 * coalesce((select sum(e.pts) from points_events e
                                 where e.owner = r.referee and e.kind not in ('friends', 'welcome')), 0))::int,
           now()
    from referrals r
  on conflict (owner, kind, ref) do update set pts = excluded.pts, updated_at = now();
end $$;
revoke all on function refresh_points(numeric) from anon, authenticated, public;

-- ---------------------------------------------------------------- reading

create or replace view points_totals as
  select owner, sum(pts)::bigint as total from points_events group by owner;

-- The top of the board.
create or replace function points_board(p_limit int default 50)
returns table (owner text, total bigint, rank bigint)
language sql stable security definer set search_path = public as $$
  select owner, total, rank() over (order by total desc) from points_totals
  where total > 0 order by total desc limit least(greatest(p_limit, 1), 200)
$$;

-- One person's points page.
create or replace function points_me(p_owner text)
returns table (total bigint, rank bigint, players bigint, today int, streak int, quests text[], friends int, friends_pts int)
language sql stable security definer set search_path = public as $$
  with me as (select lower(p_owner) as a),
  t as (select coalesce((select total from points_totals, me where owner = me.a), 0) as total)
  select
    t.total,
    (select count(*) + 1 from points_totals where total > t.total),
    (select count(*) from points_totals where total > 0),
    coalesce((select sum(pts) from points_events, me where owner = me.a and kind = 'trade'
              and ref = ((now() at time zone 'utc')::date)::text), 0)::int,
    (with d as (select distinct (ts at time zone 'utc')::date as day from trades, me where trader = me.a
                and ts > now() - interval '40 days'),
          r as (select day, day - (row_number() over (order by day))::int as g from d)
     select coalesce((select count(*) from r where g = (select g from r order by day desc limit 1)
                      and (select max(day) from d) >= (now() at time zone 'utc')::date - 1), 0))::int,
    coalesce((select array_agg(ref) from points_events, me where owner = me.a and kind = 'quest'), '{}'),
    (select count(*) from referrals, me where referrer = me.a)::int,
    coalesce((select sum(pts) from points_events, me where owner = me.a and kind = 'friends'), 0)::int
  from t
$$;

grant execute on function points_board(int) to anon, authenticated;
grant execute on function points_me(text) to anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on points_events to service_role;
    grant execute on function points_board(int), points_me(text), refresh_points(numeric) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
