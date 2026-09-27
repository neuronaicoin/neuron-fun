-- Fee modes. Run once in the Supabase SQL editor, BEFORE the site update.
-- Adds each coin's fee mode (0 creator, 1 buyback, 2 holders) and rebuilds
-- the two views that list coins so they include it.

alter table coins add column if not exists fee_mode smallint not null default 0;

drop materialized view if exists coin_list;
drop view if exists coin_summary;

create view coin_summary as
  select
    c.*,
    (select coalesce(json_agg(json_build_object(
        'chain_id', k.chain_id, 'curve', k.curve, 'token', k.token, 'state', k.state,
        'real_native', k.real_native::text, 'virtual_native', k.virtual_native::text,
        'virtual_token', k.virtual_token::text,
        'holders', coalesce(h.holders, 0)) order by k.chain_id), '[]'::json)
     from curves k
     left join holder_counts h on h.chain_id = k.chain_id and h.token = k.token
     where k.coin_id = c.id) as curves,
    (select count(*) from trades t where t.coin_id = c.id and t.ts > now() - interval '24 hours')::int as trades_24h,
    (select count(*) from trades t where t.coin_id = c.id and t.is_buy and t.ts > now() - interval '24 hours')::int as buys_24h,
    (select count(*) from trades t where t.coin_id = c.id and not t.is_buy and t.ts > now() - interval '24 hours')::int as sells_24h,
    (select coalesce(sum(t.native_amount), 0)::text from trades t where t.coin_id = c.id and t.ts > now() - interval '24 hours') as volume_native_24h,
    (select max(t.ts) from trades t where t.coin_id = c.id) as last_trade_at
  from coins c;

grant select on coin_summary to anon, authenticated;

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
