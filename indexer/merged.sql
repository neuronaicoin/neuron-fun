-- Money from the losing chains that reached the winner's pool (update-84).
alter table race_chains add column if not exists merged_usd numeric not null default 0;

-- Already merged before the indexer counted it (Oct 19 2026 test races):
update race_chains set merged_usd = 35.85
  where coin_id = '0xd59e625f4d00ccb6538bb3ddbe167f2b48167cf198e36e92e33cd46aadfa9c66' and chain_id = 5042;
update race_chains set merged_usd = 28.59
  where coin_id = '0x2a126e01f3ffaca25a3b2c43a528ba12992ba1a640e969effb496a84bc55a18c' and chain_id = 56;

notify pgrst, 'reload schema';
