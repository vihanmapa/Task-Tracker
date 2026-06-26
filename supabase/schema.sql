-- FM Navigate — shared workspace schema
-- Run this once in Supabase → SQL Editor → New query → Run.
--
-- Auth model: Supabase Auth. A signed-in user READS the workspace row;
-- the single EDITOR account WRITES it directly from the client. Row Level
-- Security enforces both — there is NO Edge Function and NO service_role
-- write path anymore. (See docs/PRIVATE-VAULT-SETUP.md for the full setup,
-- including the per-user private_resources vault.)
--
-- Before running: replace EDITOR_UID below with your editor's User UID
-- (Authentication → Users → click your user → copy User UID).

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

-- Multi-collection: each module gets its OWN workspace row, keyed by id.
-- The `tasks` jsonb column holds whatever JSON that collection needs (the
-- KPI scorecard stores an object, not an array). The editor UPDATE policy
-- below already covers every row, so writes need no change — but each row
-- must be SEEDED once here (there is no INSERT policy). Re-run this file
-- after adding a new collection id.
insert into public.workspace (id, tasks) values
  ('kpiScores', '{}'::jsonb)
on conflict (id) do nothing;

-- Row Level Security: only signed-in users may READ; only the editor may
-- WRITE (UPDATE). No INSERT/DELETE policy: the single 'main' row already
-- exists and is never created or removed via the public API. Reads/writes
-- by anon are denied (no anon policy = default deny).
alter table public.workspace enable row level security;

-- Anyone signed in can READ the shared workspace.
drop policy if exists "anon can read workspace" on public.workspace;
drop policy if exists "workspace read (authenticated)" on public.workspace;
create policy "workspace read (authenticated)"
  on public.workspace for select
  to authenticated
  using (true);

-- Only the editor account can WRITE the shared workspace.
drop policy if exists "workspace write (editor only)" on public.workspace;
create policy "workspace write (editor only)"
  on public.workspace for update
  to authenticated
  using (auth.uid() = 'EDITOR_UID'::uuid)
  with check (auth.uid() = 'EDITOR_UID'::uuid);

-- Enable realtime so connected clients get live updates.
alter publication supabase_realtime add table public.workspace;
