-- Share cards. Run once in the Supabase SQL editor.

-- Public bucket the cards live in (read by X, Telegram, Discord…).
insert into storage.buckets (id, name, public)
values ('cards', 'cards', true)
on conflict (id) do update set public = true;

-- Which version of each card was last drawn (indexer only; not public).
create table if not exists card_state (
  coin_id  text primary key,
  sig      text not null,
  drawn_at timestamptz not null default now()
);
alter table card_state enable row level security;
