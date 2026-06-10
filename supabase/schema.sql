-- FM Navigate — shared workspace schema
-- Run this once in Supabase → SQL Editor → New query → Run.

-- One row holds the entire tasks array as JSON.
create table if not exists public.workspace (
  id          text primary key default 'main',
  tasks       jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- Seed the single 'main' row.
insert into public.workspace (id, tasks)
values ('main', '[]'::jsonb)
on conflict (id) do nothing;

-- Row Level Security: anyone (anon) may READ; nobody may write via the
-- public API. All writes go through the Edge Function (service_role),
-- which bypasses RLS, so no write policy is needed.
alter table public.workspace enable row level security;

drop policy if exists "anon can read workspace" on public.workspace;
create policy "anon can read workspace"
  on public.workspace for select
  to anon
  using (true);

-- Enable realtime so connected clients get live updates.
alter publication supabase_realtime add table public.workspace;
