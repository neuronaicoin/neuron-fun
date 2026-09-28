-- AI launch helper (update-39): a small daily allowance per account.
-- Run once in the Supabase SQL editor BEFORE uploading update-39.

create table if not exists ai_usage (
  address text    not null,
  day     date    not null,
  kind    text    not null,
  n       integer not null default 0,
  primary key (address, day, kind)
);
alter table ai_usage enable row level security;
revoke all on ai_usage from anon, authenticated;

-- Counts one use and says whether it's still within today's limit.
create or replace function ai_take(p_address text, p_kind text, p_limit int)
returns boolean language plpgsql security definer set search_path = public as $$
declare v int;
begin
  insert into ai_usage (address, day, kind, n) values (lower(p_address), current_date, p_kind, 1)
  on conflict (address, day, kind) do update set n = ai_usage.n + 1
  returning n into v;
  if v > p_limit then
    update ai_usage set n = n - 1 where address = lower(p_address) and day = current_date and kind = p_kind;
    return false;
  end if;
  return true;
end $$;
revoke all on function ai_take(text, text, int) from anon, authenticated, public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function ai_take(text, text, int) to service_role;
    grant all on ai_usage to service_role;
  end if;
end $$;

-- Old rows are no use after a while.
delete from ai_usage where day < current_date - 30;

notify pgrst, 'reload schema';

-- Tightening from update-34: your own copy results stay private
-- (the site reads them through its API with the service key).
do $$ begin
  if exists (select 1 from pg_proc where proname = 'my_copy_results') then
    revoke all on function my_copy_results(text) from anon, authenticated, public;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      grant execute on function my_copy_results(text) to service_role;
    end if;
  end if;
end $$;
notify pgrst, 'reload schema';
