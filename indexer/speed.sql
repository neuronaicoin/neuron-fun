-- Speed-up for the home page. Run once in the Supabase SQL editor.
--
-- coin_list is a precomputed copy of coin_summary with one extra column
-- (open_native: money still racing on open curves). The indexer refreshes
-- it every few seconds, so listing thousands of coins stays instant: the
-- site reads ready rows instead of recounting trades on every visit.

drop materialized view if exists coin_list;
create materialized view coin_list as
  select
    s.*,
    coalesce((select sum(k.real_native) from curves k where k.coin_id = s.id and k.state = 0), 0) as open_native,
    coalesce((select sum(h.holders) from curves k join holder_counts h on h.chain_id = k.chain_id and h.token = k.token
              where k.coin_id = s.id), 0)::int as holders_total
  from coin_summary s;

create unique index coin_list_id_idx on coin_list (id);
create index coin_list_created_idx on coin_list (created_at desc);
create index coin_list_active_idx on coin_list (last_trade_at desc nulls last);
create index coin_list_race_idx on coin_list (open_native desc) where graduated_chain is null;
create index coin_list_grad_idx on coin_list (graduated_at desc) where graduated_chain is not null;
create index coin_list_name_idx on coin_list (lower(name));
create index coin_list_symbol_idx on coin_list (lower(symbol));

grant select on coin_list to anon, authenticated;

-- Helps the live views stay quick as trades grow.
create index if not exists trades_coin_recent_idx on trades (coin_id, ts);
