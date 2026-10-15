-- Coin archive for search pages (update-44). Run once in the Supabase SQL editor (safe to run again).
--
-- ext_tokens only keeps coins seen in the last 30 days. Every coin that was ever a real coin
-- (traded, liquid, passed the token check) is copied here once and never deleted, so its page
-- (/x/<network>/<address>) stays up for search engines after it goes quiet. Junk never gets in:
-- no tiny pools, no wash-traded dust, nothing that failed the token check. A coin found bad later
-- (honeypot, can't sell, high sell tax) is marked bad and its page disappears.
-- The Explore lists are unchanged: they still show only active coins (ext_coins / ext_coins_all).

create table if not exists ext_archive (
  id            bigserial   unique,                 -- order for the sitemap files
  network       text        not null,
  address       text        not null,
  chain_id      integer,
  name          text        not null,
  symbol        text        not null,
  image         text,
  pool          text,
  dex           text,
  pool_created  timestamptz,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  price_usd     numeric,                            -- the last values we saw
  mcap_usd      numeric,
  liq_usd       numeric,
  vol_24h       numeric,
  peak_mcap     numeric,                            -- highest we ever saw
  peak_vol      numeric,
  peak_liq      numeric,
  buy_tax       numeric,
  sell_tax      numeric,
  mintable      boolean,
  top10         numeric,
  x_handle      text,
  bad           boolean     not null default false,
  primary key (network, address)
);
drop index if exists ext_archive_seen_idx;
-- the sync looks at coins seen in the last minutes
create index if not exists ext_tokens_seen_idx on ext_tokens (seen_at);

alter table ext_archive enable row level security;
revoke all on ext_archive from anon, authenticated;
grant all on ext_archive to service_role;

-- A real coin (not junk), judged on one fresh look at it.
create or replace function ext_is_real(t ext_tokens) returns boolean
language sql immutable as $$
  select t.gp_checked_at is not null
     and coalesce(t.gp_honeypot, false) = false
     and coalesce(t.gp_cannot_sell, false) = false
     and coalesce(t.gp_sell_tax, 0) < 0.1
     and coalesce(t.gp_buy_tax, 0) < 0.1
     and coalesce(t.liq_usd, 0) >= 10000
     and coalesce(t.vol_24h, 0) >= 25000
     and coalesce(t.buys_24h, 0) + coalesce(t.sells_24h, 0) >= 50
     and coalesce(t.mcap_usd, t.fdv_usd, 0) < 1e12
     and length(coalesce(t.name, '')) between 1 and 60
     and length(coalesce(t.symbol, '')) between 1 and 20
$$;

-- Found bad after it got in: can't be sold, a honeypot, or a tax above the entry bar.
create or replace function ext_is_bad(t ext_tokens) returns boolean
language sql immutable as $$
  select coalesce(t.gp_honeypot, false) or coalesce(t.gp_cannot_sell, false)
      or coalesce(t.gp_sell_tax, 0) >= 0.1 or coalesce(t.gp_buy_tax, 0) >= 0.1
$$;

-- Called by the market indexer each round: new real coins in, known ones refreshed, bad ones out.
create or replace function ext_archive_sync() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into ext_archive as a (network, address, chain_id, name, symbol, image, pool, dex, pool_created,
                                price_usd, mcap_usd, liq_usd, vol_24h, peak_mcap, peak_vol, peak_liq,
                                buy_tax, sell_tax, mintable, top10, x_handle)
  select t.network, t.address, t.chain_id, t.name, t.symbol, t.image, t.pool, t.dex, t.pool_created,
         t.price_usd, coalesce(t.mcap_usd, t.fdv_usd), t.liq_usd, t.vol_24h, coalesce(t.mcap_usd, t.fdv_usd), t.vol_24h, t.liq_usd,
         t.gp_buy_tax, t.gp_sell_tax, t.gp_mintable, t.gp_top10, t.x_handle
  from ext_tokens t
  where t.seen_at > now() - interval '20 minutes' and ext_is_real(t)
    and not exists (select 1 from ext_archive a where a.network = t.network and a.address = t.address)
  on conflict (network, address) do nothing;
  get diagnostics n = row_count;

  update ext_archive a set
    name = coalesce(nullif(t.name, ''), a.name),
    symbol = coalesce(nullif(t.symbol, ''), a.symbol),
    image = coalesce(t.image, a.image),
    pool = coalesce(t.pool, a.pool),
    dex = coalesce(t.dex, a.dex),
    pool_created = coalesce(t.pool_created, a.pool_created),
    last_seen = t.seen_at,
    price_usd = coalesce(t.price_usd, a.price_usd),
    mcap_usd = coalesce(t.mcap_usd, t.fdv_usd, a.mcap_usd),
    liq_usd = coalesce(t.liq_usd, a.liq_usd),
    vol_24h = coalesce(t.vol_24h, a.vol_24h),
    peak_mcap = greatest(a.peak_mcap, case when coalesce(t.mcap_usd, t.fdv_usd) < 1e12 then coalesce(t.mcap_usd, t.fdv_usd) end),
    peak_vol = greatest(a.peak_vol, t.vol_24h),
    peak_liq = greatest(a.peak_liq, t.liq_usd),
    buy_tax = coalesce(t.gp_buy_tax, a.buy_tax),
    sell_tax = coalesce(t.gp_sell_tax, a.sell_tax),
    mintable = coalesce(t.gp_mintable, a.mintable),
    top10 = coalesce(t.gp_top10, a.top10),
    x_handle = coalesce(t.x_handle, a.x_handle),
    bad = a.bad or ext_is_bad(t)
  from ext_tokens t
  where t.network = a.network and t.address = a.address and t.seen_at > now() - interval '20 minutes'
    -- refreshed at most every 30 minutes (fewer row writes), at once when a coin turns bad
    and (t.seen_at > a.last_seen + interval '30 minutes' or (ext_is_bad(t) and not a.bad));
  return n;
end $$;
revoke all on function ext_archive_sync() from public;
grant execute on function ext_archive_sync() to service_role;

-- What pages may show: never a bad coin. "indexed" = worth a place in search results: seen in
-- the last 90 days, or a coin that once reached a $1M market cap.
create or replace view ext_archive_pages as
  select network, chain_id, address, name, symbol, image, pool, dex, pool_created, first_seen, last_seen,
         price_usd, mcap_usd, liq_usd, vol_24h, peak_mcap, peak_vol, peak_liq, buy_tax, sell_tax, mintable,
         top10, x_handle,
         (last_seen > now() - interval '90 days' or coalesce(peak_mcap, 0) >= 1000000) as indexed
  from ext_archive
  where not bad;
grant select on ext_archive_pages to anon, authenticated;

-- Sitemaps: file k holds archive ids [k*40000, (k+1)*40000), one "network/address/lastmod" per line.
drop function if exists ext_sitemap_chunks(integer);
drop function if exists ext_sitemap_chunk(integer, integer);
create or replace function ext_sitemap_chunks() returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(max(id), 0)::integer / 40000 + 1 from ext_archive
$$;

create or replace function ext_sitemap_chunk(p_chunk integer) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(string_agg(network || '/' || address || '/' || to_char(last_seen at time zone 'UTC', 'YYYY-MM-DD'), e'\n' order by id), '')
  from ext_archive
  where p_chunk between 0 and 100000
    and id >= p_chunk::bigint * 40000 and id < (p_chunk::bigint + 1) * 40000
    and not bad
    and (last_seen > now() - interval '90 days' or coalesce(peak_mcap, 0) >= 1000000)
$$;
revoke all on function ext_sitemap_chunks(), ext_sitemap_chunk(integer) from public;
grant execute on function ext_sitemap_chunks(), ext_sitemap_chunk(integer) to anon, authenticated, service_role;

-- First fill: every real coin already known.
select ext_archive_sync();
insert into ext_archive (network, address, chain_id, name, symbol, image, pool, dex, pool_created, last_seen,
                         price_usd, mcap_usd, liq_usd, vol_24h, peak_mcap, peak_vol, peak_liq,
                         buy_tax, sell_tax, mintable, top10, x_handle)
select t.network, t.address, t.chain_id, t.name, t.symbol, t.image, t.pool, t.dex, t.pool_created, t.seen_at,
       t.price_usd, coalesce(t.mcap_usd, t.fdv_usd), t.liq_usd, t.vol_24h, coalesce(t.mcap_usd, t.fdv_usd), t.vol_24h, t.liq_usd,
       t.gp_buy_tax, t.gp_sell_tax, t.gp_mintable, t.gp_top10, t.x_handle
from ext_tokens t
where ext_is_real(t)
  and not exists (select 1 from ext_archive a where a.network = t.network and a.address = t.address)
on conflict (network, address) do nothing;

notify pgrst, 'reload schema';
