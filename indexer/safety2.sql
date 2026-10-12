-- update: Supabase hardening (Oct 12, 2026). Already applied by hand in the SQL editor;
-- kept here so a fresh project gets the same state. Safe to run again.
--
-- 1. refresh_badges is SECURITY DEFINER and was executable by anon (default EXECUTE to PUBLIC)
revoke all on function refresh_badges(numeric) from anon, authenticated, public;
grant execute on function refresh_badges(numeric) to service_role;
-- 2. trader_badges was the only table without row level security
alter table trader_badges enable row level security;
revoke insert, update, delete on trader_badges from anon, authenticated;
drop policy if exists "public read" on trader_badges;
create policy "public read" on trader_badges for select to anon, authenticated using (true);
-- 3. views run with the owner's rights: keep private copy-trade fills and point totals off the public API
revoke all on copy_fills, points_totals from anon, authenticated, public;
-- 4. my_copy_results: the PUBLIC grant was still there
revoke all on function my_copy_results(text) from public;
notify pgrst, 'reload schema';
