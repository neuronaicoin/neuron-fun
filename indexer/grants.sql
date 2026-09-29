-- One-time fix (update-50): the site's server key (service_role) gets full
-- access to every table and function, now and in the future. Supabase projects
-- created recently don't always grant this automatically, which caused the
-- "Something went wrong" errors on Copy (and can stall the forum).
-- Safe to run more than once. Visitors (anon) are NOT given anything new.

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;

notify pgrst, 'reload schema';
