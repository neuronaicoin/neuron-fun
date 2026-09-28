-- Social layer: profiles, follows, leaderboard. Run once in the Supabase SQL
-- editor BEFORE uploading update-30. Needs alerts.sql and forum.sql.

create table if not exists profiles (
  address     text primary key,                         -- lower-case wallet address
  username    text unique check (username is null or username ~ '^[a-z0-9_]{3,20}$'),
  color       text not null default '#ff6b1a' check (color ~ '^#[0-9a-f]{6}$'),
  emoji       text not null default '' check (char_length(emoji) <= 8),
  bio         text not null default '' check (char_length(bio) <= 140),
  hide_trades boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists follows (
  follower   text not null,
  followee   text not null,
  created_at timestamptz not null default now(),
  primary key (follower, followee),
  check (follower <> followee)
);
create index if not exists follows_followee_idx on follows (followee);

create index if not exists trades_trader_ts_idx on trades (trader, ts desc);

alter table profiles enable row level security;
alter table follows  enable row level security;
revoke all on profiles, follows from anon, authenticated;

-- ------------------------------------------------------------------ public views

create or replace view profiles_public as
  select p.address, p.username, p.color, p.emoji, p.bio, p.hide_trades, p.created_at,
         (select count(*) from follows f where f.followee = p.address)::int as followers,
         (select count(*) from follows f where f.follower = p.address)::int as following
  from profiles p;

-- Who follows whom (public, like on X).
create or replace view follows_public as select follower, followee, created_at from follows;

grant select on profiles_public, follows_public to anon, authenticated;

-- ------------------------------------------------------------------ trader numbers
-- Profit uses average cost: every sell is compared with the average price the
-- trader paid for that coin. Amounts are in the chain's native coin (ETH).

create or replace function trader_stats(p_since timestamptz, p_traders text[] default null)
returns table (
  trader text,
  realized numeric,      -- profit from sells since p_since
  volume numeric,        -- buys + sells since p_since
  trades int,
  wins int,              -- coins sold at a profit since p_since
  closed int,            -- coins sold at all since p_since
  quick_sells int,       -- sells within 5 minutes of the first buy
  sells int
)
language sql stable as $$
  with scope as (
    select * from trades t
    where (p_traders is null or t.trader = any (p_traders))
  ),
  cost as (
    select trader, coin_id,
           sum(native_amount) filter (where is_buy) as spent,
           sum(token_amount) filter (where is_buy) as bought,
           min(ts) filter (where is_buy) as first_buy
    from scope group by trader, coin_id
  ),
  recent as (
    select s.trader, s.coin_id,
           sum(s.native_amount) filter (where not s.is_buy) as got,
           sum(s.token_amount) filter (where not s.is_buy) as sold,
           sum(s.native_amount) as vol,
           count(*) as n,
           count(*) filter (where not s.is_buy) as n_sells,
           count(*) filter (where not s.is_buy and s.ts < c.first_buy + interval '5 minutes') as n_quick
    from scope s join cost c on c.trader = s.trader and c.coin_id = s.coin_id
    where s.ts >= p_since
    group by s.trader, s.coin_id
  ),
  per_coin as (
    select r.trader, r.coin_id, r.vol, r.n, r.n_sells, r.n_quick,
           case when coalesce(r.sold, 0) > 0 and coalesce(c.bought, 0) > 0
                then r.got - (c.spent / c.bought) * r.sold
                else 0 end as pnl,
           coalesce(r.sold, 0) > 0 as did_sell
    from recent r join cost c on c.trader = r.trader and c.coin_id = r.coin_id
  )
  select trader,
         sum(pnl) / 1e18,
         sum(vol) / 1e18,
         sum(n)::int,
         count(*) filter (where did_sell and pnl > 0)::int,
         count(*) filter (where did_sell)::int,
         sum(n_quick)::int,
         sum(n_sells)::int
  from per_coin
  group by trader
$$;

-- Top traders for a period. Hidden profiles are left out.
create or replace function leaderboard(p_since timestamptz, p_min_volume numeric, p_limit int default 50)
returns table (trader text, realized numeric, volume numeric, trades int, wins int, closed int, quick_sells int, sells int)
language sql stable security definer set search_path = public as $$
  select s.* from trader_stats(p_since) s
  left join profiles p on p.address = s.trader
  where s.volume >= p_min_volume and coalesce(p.hide_trades, false) = false
  order by s.realized desc
  limit least(greatest(p_limit, 1), 100)
$$;

grant execute on function trader_stats(timestamptz, text[]) to anon, authenticated;
grant execute on function leaderboard(timestamptz, numeric, int) to anon, authenticated;
