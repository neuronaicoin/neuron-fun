-- safety3 (security review, Oct 2026): the site's visitors (anon / authenticated) can only READ.
-- Run once in the Supabase SQL editor. Safe to run again.
--
-- Why: Supabase gives anon and authenticated every right on new tables AND views by default.
-- A simple view (profiles_public, follows_public …) can be written through, and it writes as
-- its owner, past the table's row security. The site never writes with those roles (every
-- write goes through sasa's server with the service key), so taking the rights away changes
-- nothing for the site.

-- 1. every table and view in public: read only for visitors
do $$
declare v record;
begin
  for v in select table_name from information_schema.tables where table_schema = 'public' loop
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from anon, authenticated', v.table_name);
  end loop;
end $$;

-- 2. tables and views made from now on: read rights only for visitors
alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;

-- 3. heavy jobs only the server runs
do $$ begin
  if exists (select 1 from pg_proc where proname = 'ext_archive_sync') then
    revoke all on function ext_archive_sync() from anon, authenticated, public;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      grant execute on function ext_archive_sync() to service_role;
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';

-- Check (should list nothing): any table or view visitors could still write to.
select table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
order by 1, 2;
