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

-- Seed the single 'main' row. NOTE: row id stays 'main' deliberately. It now
-- holds the ENTIRE workspace document — { version, metadata, data: { tasks,
-- deliverables, weeks, kpiScores, … } } — in the `tasks` jsonb column. (A more
-- descriptive id like 'workspace' would require creating a NEW row, but there
-- is no INSERT policy, so the client can't create one without manual SQL —
-- which is exactly what this architecture removes. So 'main' it stays.)
insert into public.workspace (id, tasks)
values ('main', '[]'::jsonb)
on conflict (id) do nothing;

-- NOTE (unified workspace document): the app now stores the ENTIRE workspace
-- as ONE jsonb object on the 'main' row — { tasks, deliverables, weeks,
-- kpiScores, ... }. Every feature is just a property, so NEW features never
-- need a new row, a seed, or an RLS change. The legacy per-collection rows
-- below are kept only so existing data migrates: loadWorkspace() imports the
-- old 'kpiScores' row into the document on first load. They are no longer
-- written to and are optional for a fresh database.
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
