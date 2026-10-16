-- Invite rewards for sasa v7 (race coins), other DEXs' coins and futures. Run once in the
-- Supabase SQL editor, after rewards.sql, race.sql and exttrades.sql (safe to run again).
-- Run it BEFORE the new indexer / site / keeper go live: they write the new columns below.
--
-- These rewards are counted in dollars and paid once a day in USDC on Base, from the rewards
-- wallet. In reward_ledger they use chain_id 845300 ("dollars, paid on Base") and amounts in
-- USDC units (6 decimals), so they never mix with the older per-chain rewards (wei).
--
-- Every reward is a share of a fee sasa really received:
--   race coins       the pool fees the builder collected (race_fees), shared out over the
--                    trades they came from
--   other DEXs' coins the fee Relay paid sasa on that trade (ext_trades.fee_usd)
--   futures          sasa's builder fee in Hyperliquid's own daily file of sasa's fills

-- race coins: where each fee collection sits in the chain (the trades before it paid it)
alter table race_fees add column if not exists block_number bigint;
alter table race_fees add column if not exists created_at timestamptz not null default now();

-- other DEXs' coins: sasa's fee on the trade (dollars) and when the trade was made
alter table ext_trades add column if not exists fee_usd numeric;
alter table ext_trades add column if not exists traded_at timestamptz;
create index if not exists ext_trades_trader_idx on ext_trades (trader, created_at);

-- futures: Hyperliquid's daily files of sasa's fills already read
create table if not exists reward_perp_days (
  day     date        primary key,
  fills   integer     not null default 0,
  read_at timestamptz not null default now()
);
alter table reward_perp_days enable row level security;
revoke all on reward_perp_days from anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on reward_perp_days to service_role;
  end if;
end $$;

-- A person's own rewards summary (totals only). earned/paid/pending: the older rewards, in wei;
-- usd_*: the dollar rewards (USDC units, 6 decimals).
drop function if exists reward_summary(text);
create function reward_summary(p_owner text)
returns table (earned numeric, paid numeric, pending numeric, friends int, friends_traded int,
               usd_earned numeric, usd_paid numeric, usd_pending numeric)
language sql stable security definer set search_path = public as $$
  select
    coalesce((select sum(amount) from reward_ledger where owner = lower(p_owner) and chain_id <> 845300), 0),
    coalesce((select sum(amount) from reward_ledger where owner = lower(p_owner) and chain_id <> 845300 and paid_at is not null), 0),
    coalesce((select sum(amount) from reward_ledger where owner = lower(p_owner) and chain_id <> 845300 and paid_at is null), 0),
    (select count(*) from referrals where referrer = lower(p_owner))::int,
    (select count(*) from referrals r where r.referrer = lower(p_owner)
       and (exists (select 1 from trades t where t.trader = r.referee and t.ts >= r.created_at)
         or exists (select 1 from race_trades t where t.trader = r.referee and t.ts >= r.created_at)
         or exists (select 1 from ext_trades t where t.trader = r.referee and t.created_at >= r.created_at)
         or exists (select 1 from reward_ledger l where l.owner = r.referrer and l.source = r.referee)))::int,
    coalesce((select sum(amount) from reward_ledger where owner = lower(p_owner) and chain_id = 845300), 0),
    coalesce((select sum(amount) from reward_ledger where owner = lower(p_owner) and chain_id = 845300 and paid_at is not null), 0),
    coalesce((select sum(amount) from reward_ledger where owner = lower(p_owner) and chain_id = 845300 and paid_at is null), 0)
$$;
revoke all on function reward_summary(text) from public;
grant execute on function reward_summary(text) to anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function reward_summary(text) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
