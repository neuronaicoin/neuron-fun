-- Animated coin pictures (GIFs). A launch keeps a small still picture with the coin; an animated GIF is
-- stored here instead and the coin points to https://sasapad.fun/api/gif/<sha256>.
-- Written and read only by the site's /api/gif (with the service key). Run once in Supabase SQL Editor.
create table if not exists public.sasa_images (
  hash  text primary key check (hash ~ '^[0-9a-f]{64}$'),
  mime  text not null check (mime in ('image/gif', 'image/webp', 'image/png')),
  data  text not null check (length(data) <= 2800000),   -- base64, about 2 MB of picture
  at    timestamptz not null default now()
);
alter table public.sasa_images enable row level security;
