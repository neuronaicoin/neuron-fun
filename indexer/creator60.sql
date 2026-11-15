-- Creator bonus (rewards/creator.mjs): 60% of the trading fees to the creator once the coin holds
-- a $10K market cap for an hour. Bonus rows sit in reward_ledger (kind 'creator', dollars) and
-- are paid with the invite rewards. Run once in Supabase (the rewards service makes the tables
-- itself too).

create table if not exists creator_supply (
  chain_id   integer not null,
  coin_id    text    not null,
  supply     numeric not null,
  read_at    timestamptz not null default now(),
  primary key (chain_id, coin_id)
);
create table if not exists creator_qual (
  key         text primary key,
  above_since timestamptz,
  mcap        numeric,
  seen_paid   numeric,
  seen_n      integer,
  updated_at  timestamptz not null default now()
);
alter table creator_supply enable row level security;
alter table creator_qual enable row level security;
revoke all on creator_supply from anon, authenticated;
revoke all on creator_qual from anon, authenticated;

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'reward_ledger_kind_check'
             and pg_get_constraintdef(oid) not like '%creator%') then
    alter table reward_ledger drop constraint reward_ledger_kind_check;
    alter table reward_ledger add constraint reward_ledger_kind_check check (kind in ('referral', 'copy', 'creator'));
  end if;
end $$;

-- invite totals (the Earn page's invite box) leave the creator bonus out
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
    coalesce((select sum(amount) from reward_ledger where owner = lower(p_owner) and chain_id = 845300 and kind <> 'creator'), 0),
    coalesce((select sum(amount) from reward_ledger where owner = lower(p_owner) and chain_id = 845300 and kind <> 'creator' and paid_at is not null), 0),
    coalesce((select sum(amount) from reward_ledger where owner = lower(p_owner) and chain_id = 845300 and kind <> 'creator' and paid_at is null), 0)
$$;
revoke all on function reward_summary(text) from public;
grant execute on function reward_summary(text) to anon, authenticated;

-- a creator's own bonus totals (USDC units, 6 decimals)
create or replace function creator_bonus_summary(p_owner text)
returns table (earned numeric, paid numeric, pending numeric, coins int)
language sql stable security definer set search_path = public as $$
  select
    coalesce((select sum(amount) from reward_ledger where owner = lower(p_owner) and kind = 'creator'), 0),
    coalesce((select sum(amount) from reward_ledger where owner = lower(p_owner) and kind = 'creator' and paid_at is not null), 0),
    coalesce((select sum(amount) from reward_ledger where owner = lower(p_owner) and kind = 'creator' and paid_at is null), 0),
    (select count(distinct source) from reward_ledger where owner = lower(p_owner) and kind = 'creator')::int
$$;
revoke all on function creator_bonus_summary(text) from public;
grant execute on function creator_bonus_summary(text) to anon, authenticated;

notify pgrst, 'reload schema';
