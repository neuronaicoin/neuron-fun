-- sasa MAINNET switch day: run ONCE in the Supabase SQL editor, right after the site and
-- the Railway services are switched to mainnet. Clears every TEST coin, trade and balance
-- (test dollars, no value). Accounts, profiles, follows, invites, badges and points stay.
-- The indexer keeps its position per chain id, and mainnet chains (4663, 8453) start fresh
-- on their own; the testnet chains' positions are removed below.
-- Safe to run twice; tables that don't exist are skipped.

do $$
declare
  t text;
begin
  -- Old coins' forum boards (the general "sasa" board stays).
  if to_regclass('public.forum_threads') is not null then
    delete from forum_likes where post_id in (select p.id from forum_posts p join forum_threads th on th.id = p.thread_id where th.board <> 'sasa');
    delete from forum_reports where post_id in (select p.id from forum_posts p join forum_threads th on th.id = p.thread_id where th.board <> 'sasa');
    delete from forum_posts where thread_id in (select id from forum_threads where board <> 'sasa');
    delete from forum_threads where board <> 'sasa';
  end if;
  if to_regclass('public.notifications') is not null then
    delete from notifications where coin_id is not null;
  end if;
  -- Plain tables only (views like copy_fills are skipped).
  foreach t in array array[
    'trades', 'transfers', 'balances', 'coin_spark', 'coin_lock', 'coin_links', 'card_state',
    'alerts', 'copy_signals', 'reward_ledger', 'reward_payouts', 'chain_safety', 'coin_omni', 'curves', 'coins'
  ] loop
    if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = t and c.relkind = 'r') then
      execute format('delete from public.%I', t);
    end if;
  end loop;
end $$;

do $$ begin
  if exists (select 1 from pg_matviews where matviewname = 'coin_list') then refresh materialized view coin_list; end if;
  if exists (select 1 from pg_matviews where matviewname = 'holder_counts') then refresh materialized view holder_counts; end if;
  if exists (select 1 from pg_matviews where matviewname = 'coin_summary') then refresh materialized view coin_summary; end if;
end $$;

notify pgrst, 'reload schema';

do $$ begin
  if to_regclass('public.indexer_state') is not null then
    delete from indexer_state where chain_id in (46630, 84532);
  end if;
end $$;
