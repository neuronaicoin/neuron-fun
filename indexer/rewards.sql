-- Daily rewards (update-45a). Run once in the Supabase SQL editor BEFORE
-- starting the rewards service.
--
--  referrals      who invited whom (set once, never changed)
--  reward_ledger  every reward earned, one row per trade it came from
--                   referral: 20% of sasa's fee share on an invited friend's trades, for 12 months
--                   copy:     10% of sasa's fee share on trades copied from a trader
--  reward_payouts every daily payment transaction
--  rewards_state  an off switch for payouts (admin page)

create table if not exists referrals (
  referee    text        primary key,
  referrer   text        not null,
  created_at timestamptz not null default now(),
  check (referee <> referrer)
);
create index if not exists referrals_referrer_idx on referrals (referrer);

create table if not exists reward_ledger (
  id         bigserial   primary key,
  owner      text        not null,               -- who gets paid
  kind       text        not null check (kind in ('referral', 'copy')),
  chain_id   integer     not null,               -- paid on the chain the trade happened on
  trade_tx   text        not null,
  log_index  integer     not null,
  source     text        not null,               -- the friend / the copier whose trade earned it
  amount     numeric     not null check (amount >= 0),  -- wei of the chain's coin
  created_at timestamptz not null default now(),
  paid_tx    text,
  paid_at    timestamptz,
  unique (kind, chain_id, trade_tx, log_index, owner)
);
create index if not exists reward_ledger_unpaid_idx on reward_ledger (chain_id, owner) where paid_tx is null;
create index if not exists reward_ledger_owner_idx on reward_ledger (owner, created_at desc);

create table if not exists reward_payouts (
  id         bigserial   primary key,
  chain_id   integer     not null,
  tx_hash    text        not null unique,
  raw_tx     text        not null,               -- signed transaction, so it can be re-sent after a crash
  total      numeric     not null,
  recipients integer     not null,
  day        date        not null,
  status     text        not null default 'sent' check (status in ('sent', 'confirmed', 'failed')),
  created_at timestamptz not null default now()
);
create index if not exists reward_payouts_day_idx on reward_payouts (chain_id, day);

create table if not exists rewards_state (
  id         integer     primary key default 1 check (id = 1),
  paused     boolean     not null default false,
  cursor     timestamptz not null default now(),   -- trades up to here are in the ledger
  updated_at timestamptz not null default now()
);
insert into rewards_state (id) values (1) on conflict do nothing;

alter table referrals      enable row level security;
alter table reward_ledger  enable row level security;
alter table reward_payouts enable row level security;
alter table rewards_state  enable row level security;
revoke all on referrals, reward_ledger, reward_payouts, rewards_state from anon, authenticated;

-- The site's server key (service_role) reads and writes these through the API.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on referrals, reward_ledger, reward_payouts, rewards_state to service_role;
    grant usage, select on all sequences in schema public to service_role;
  end if;
end $$;

-- A person's own rewards summary (safe to show publicly: totals only).
create or replace function reward_summary(p_owner text)
returns table (earned numeric, paid numeric, pending numeric, friends int, friends_traded int)
language sql stable security definer set search_path = public as $$
  select
    coalesce((select sum(amount) from reward_ledger where owner = lower(p_owner)), 0),
    coalesce((select sum(amount) from reward_ledger where owner = lower(p_owner) and paid_tx is not null), 0),
    coalesce((select sum(amount) from reward_ledger where owner = lower(p_owner) and paid_tx is null), 0),
    (select count(*) from referrals where referrer = lower(p_owner))::int,
    (select count(*) from referrals r where r.referrer = lower(p_owner)
       and exists (select 1 from trades t where t.trader = r.referee and t.ts >= r.created_at))::int
$$;
grant execute on function reward_summary(text) to anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function reward_summary(text) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
