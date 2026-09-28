-- Semi-automatic copy trading (update-34). Run once in the Supabase SQL
-- editor BEFORE uploading update-34. Needs social.sql and avatars.sql.
--
-- A trader lets followers copy them (profiles.allow_copy). A follower turns
-- copying on for that trader (copy_follows). Each time the trader trades,
-- the indexer writes a signal for every copier (copy_signals); the copier
-- applies or rejects it on the site. Nothing is ever traded automatically.

alter table profiles add column if not exists allow_copy boolean not null default false;

create table if not exists copy_follows (
  follower    text        not null,
  trader      text        not null,
  mode        text        not null default 'fixed' check (mode in ('fixed', 'pct')),
  amount      numeric     not null check (amount > 0 and amount <= 1000000),  -- dollars (fixed) or percent (pct)
  copy_sells  boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (follower, trader),
  check (follower <> trader)
);
create index if not exists copy_follows_trader_idx on copy_follows (trader);

create table if not exists copy_signals (
  id            bigserial   primary key,
  follower      text        not null,
  trader        text        not null,
  coin_id       text        not null,
  chain_id      integer     not null,
  curve         text        not null,
  is_buy        boolean     not null,
  trade_tx      text        not null,              -- the trader's transaction
  trader_native numeric     not null,              -- what the trader spent / got, in wei
  trader_price  numeric     not null,              -- native per token the trader paid / got
  trader_usd    numeric,                           -- the trader's trade in dollars, when known
  suggest_usd   numeric,                           -- buys: what we suggest the copier spends
  sell_pct      numeric,                           -- sells: share of their holding the trader sold
  status        text        not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'expired')),
  applied_tx    text,
  acted_at      timestamptz,
  created_at    timestamptz not null default now(),
  unique (follower, trade_tx, coin_id)
);
create index if not exists copy_signals_follower_idx on copy_signals (follower, id desc);
create index if not exists copy_signals_trader_idx on copy_signals (trader, status);
create index if not exists copy_signals_pending_idx on copy_signals (created_at) where status = 'pending';
create index if not exists copy_signals_applied_idx on copy_signals (chain_id, applied_tx) where status = 'applied';

alter table copy_follows enable row level security;
alter table copy_signals enable row level security;
revoke all on copy_follows, copy_signals from anon, authenticated;

-- Public profile now says whether the trader can be copied, and by how many.
create or replace view profiles_public as
  select p.address, p.username, p.color, p.emoji, p.bio, p.hide_trades, p.created_at,
         (select count(*) from follows f where f.followee = p.address)::int as followers,
         (select count(*) from follows f where f.follower = p.address)::int as following,
         p.avatar_url,
         p.allow_copy,
         (select count(*) from copy_follows c where c.trader = p.address)::int as copiers
  from profiles p;
grant select on profiles_public to anon, authenticated;

-- ------------------------------------------------------------------ results

-- Last traded price of a curve (native per token), from its latest trade.
create or replace function last_price(p_chain integer, p_curve text)
returns numeric language sql stable as $$
  select t.price from trades t where t.chain_id = p_chain and t.curve = p_curve order by t.ts desc limit 1
$$;

-- One row per applied buy: what the copier paid and what it's worth now.
create or replace view copy_fills as
  select s.id, s.follower, s.trader, s.coin_id, s.chain_id, s.curve, s.created_at, s.acted_at,
         t.native_amount as paid, t.token_amount as tokens, t.fee,
         case when t.token_amount > 0 then t.native_amount / t.token_amount end as entry,
         last_price(s.chain_id, s.curve) as now_price
  from copy_signals s
  join trades t on t.chain_id = s.chain_id and t.tx_hash = s.applied_tx and t.trader = s.follower and t.is_buy
  where s.status = 'applied' and s.is_buy;

-- "Best to copy": traders ranked by how their copiers' applied buys did.
-- avg_return: average change since the copied buy (0.25 = +25%).
-- earned: the trader's 10% of sasa's 0.7% share on copied trades, in wei.
create or replace function copy_board(p_since timestamptz, p_limit int default 50)
returns table (trader text, copiers int, applied int, avg_return numeric, earned numeric)
language sql stable security definer set search_path = public as $$
  with f as (
    select trader, count(*)::int as applied,
           avg(case when entry > 0 and now_price > 0 then now_price / entry - 1 end) as avg_return
    from copy_fills where acted_at >= p_since group by trader
  ),
  e as (
    select s.trader, sum(t.fee) * 0.07 as earned
    from copy_signals s
    join trades t on t.chain_id = s.chain_id and t.tx_hash = s.applied_tx and t.trader = s.follower
    where s.status = 'applied' group by s.trader
  )
  select p.address, (select count(*) from copy_follows c where c.trader = p.address)::int,
         coalesce(f.applied, 0), f.avg_return, coalesce(e.earned, 0)
  from profiles p
  left join f on f.trader = p.address
  left join e on e.trader = p.address
  where p.allow_copy and not p.hide_trades
  order by f.avg_return desc nulls last, 2 desc
  limit least(greatest(p_limit, 1), 100)
$$;
grant execute on function copy_board(timestamptz, int) to anon, authenticated;

-- A copier's own results, per trader (read through the site's API).
create or replace function my_copy_results(p_follower text)
returns table (trader text, applied int, rejected int, paid numeric, worth numeric)
language sql stable security definer set search_path = public as $$
  select c.trader,
         (select count(*) from copy_signals s where s.follower = p_follower and s.trader = c.trader and s.status = 'applied')::int,
         (select count(*) from copy_signals s where s.follower = p_follower and s.trader = c.trader and s.status = 'rejected')::int,
         coalesce((select sum(paid) from copy_fills x where x.follower = p_follower and x.trader = c.trader), 0),
         coalesce((select sum(tokens * coalesce(now_price, entry)) from copy_fills x where x.follower = p_follower and x.trader = c.trader), 0)
  from copy_follows c where c.follower = p_follower
$$;
revoke all on function my_copy_results(text) from anon, authenticated;
