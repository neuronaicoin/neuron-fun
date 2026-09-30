-- Help desk (update-60): messages people send from sasapad.fun/help.
-- Only the site's server reads or writes them; admins answer from /admin.
-- Run once in the Supabase SQL editor.

create table if not exists support_tickets (
  id          bigserial   primary key,
  created_at  timestamptz not null default now(),
  name        text        not null,
  email       text        not null,
  message     text        not null,
  wallet      text,                       -- signed-in account, if any
  page        text,                       -- where they wrote from
  ip_hash     text,                       -- for rate limits only (never the raw IP)
  status      text        not null default 'open' check (status in ('open', 'answered', 'closed')),
  reply       text,
  replied_at  timestamptz,
  replied_by  text
);
create index if not exists support_tickets_status_idx on support_tickets (status, created_at desc);
create index if not exists support_tickets_email_idx on support_tickets (email, created_at desc);

alter table support_tickets enable row level security; -- no public policies: server only
grant all on support_tickets to service_role;
grant usage, select on sequence support_tickets_id_seq to service_role;
notify pgrst, 'reload schema';
