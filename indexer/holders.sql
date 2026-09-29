-- Holder map (update-43). Run once in the Supabase SQL editor BEFORE
-- uploading update-43. Lists wallets that sent a coin to each other (often
-- one person splitting a bag across wallets), for the coin page's map.
-- Transfers to or from sasa's own contracts are left out by the caller.

create index if not exists transfers_token_idx on transfers (chain_id, token);

create or replace function holder_links(p_coin text, p_skip text[])
returns table (chain_id integer, a text, b text, amount numeric)
language sql stable security definer set search_path = public as $$
  select t.chain_id, t.from_addr, t.to_addr, sum(t.amount)
  from transfers t
  join curves k on k.chain_id = t.chain_id and k.token = t.token
  where k.coin_id = p_coin
    and t.from_addr <> k.curve and t.to_addr <> k.curve
    and t.from_addr not in ('0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead')
    and t.to_addr   not in ('0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead')
    and not (t.from_addr = any(p_skip)) and not (t.to_addr = any(p_skip))
    and t.from_addr <> t.to_addr
  group by 1, 2, 3
  order by 4 desc
  limit 200
$$;
grant execute on function holder_links(text, text[]) to anon, authenticated;

notify pgrst, 'reload schema';
