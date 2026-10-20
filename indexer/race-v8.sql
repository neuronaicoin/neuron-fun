-- sasa v8 race contracts next to v7 (Oct 20, 2026).
--
-- v8 = v7 + the merge (the money from the losing chains buys the coin on the winner and lands
-- as full-range liquidity). v7 coins keep their own contracts; new launches use v8's. Every
-- coin now says which contract set it belongs to, so the indexer, keeper and site talk to the
-- right contracts for it. Existing coins are all v7.
-- Run once in Supabase → SQL Editor, before the indexer with v8 support starts.

alter table race_coins add column if not exists stack smallint not null default 7;
create index if not exists race_coins_stack_idx on race_coins (stack);

notify pgrst, 'reload schema';
