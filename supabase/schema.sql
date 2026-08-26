-- FM Navigate — shared workspace + RBAC schema
-- Run this once in Supabase → SQL Editor → New query → Run.
-- (Re-running is safe: everything is idempotent.)
--
-- AUTH MODEL (Phase 1 RBAC)
--   Authentication : Supabase Auth (email + password).
--   Authorization  : a per-user ROLE, stamped into the JWT by a custom
--                    access-token hook and enforced by Row Level Security.
--                    The role's SOURCE OF TRUTH at runtime is the JWT claim
--                    `user_role`; the editable copy lives in public.profiles.
--   UI permissions : fm-navigate/permissions.js mirrors the same rules so the
--                    client can hide what a role can't do. The DB is the real
--                    security boundary — the client is only a convenience.
--
-- WHY the workspace is still ONE row: tasks/deliverables/weeks/KPIs all live
-- in the `tasks` jsonb of the 'main' row. So Phase-1 RLS can only gate writes
-- at the document level (owner + product_manager). Per-task / per-role row RLS
-- arrives when that blob is normalised into real tables (a later phase) — the
-- client's can() calls won't change, only the policies behind them.

-- ============================================================
-- 0. Roles
-- ============================================================
do $$ begin
  create type public.app_role as enum (
    'owner', 'product_manager', 'investor', 'business_analyst',
    'tech_lead', 'developer', 'qa', 'viewer'
  );
exception when duplicate_object then null;
end $$;

-- Convenience: the current request's role, straight from the JWT claim, used
-- throughout the policies below. (Do NOT use the top-level `role` claim — that's
-- the Postgres role.) The claim is stamped by custom_access_token_hook (sec. 2).
create or replace function public.jwt_role()
returns text language sql stable set search_path = '' as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'user_role',
    'viewer'
  )
$$;

-- ============================================================
-- 1. Profiles  (user info: name/email/avatar + role)
--    One row per auth user. `role` is editable here by an owner; the JWT
--    hook (section 2) copies it into every access token.
-- ============================================================
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  name        text,
  avatar_url  text,
  role        public.app_role not null default 'viewer',
  status      text not null default 'active',   -- 'active' | 'disabled'
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Any signed-in user can read the team directory (needed to show comment
-- authors, assignees, the user list, etc.). Names/avatars aren't secret.
drop policy if exists "profiles read (authenticated)" on public.profiles;
create policy "profiles read (authenticated)"
  on public.profiles for select to authenticated using (true);

-- A user may update their OWN profile (name/avatar). The role/status columns
-- are protected by the trigger below so self-update can't escalate.
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own"
  on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- An owner can do anything to any profile (assign roles, disable users).
drop policy if exists "profiles owner manage" on public.profiles;
create policy "profiles owner manage"
  on public.profiles for all to authenticated
  using (public.jwt_role() = 'owner') with check (public.jwt_role() = 'owner');

-- Block privilege escalation: only an owner may change role or status.
create or replace function public.protect_profile_privileges()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Only an owner may change anyone's role or status.
  if (new.role is distinct from old.role or new.status is distinct from old.status)
     and public.jwt_role() <> 'owner' then
    raise exception 'only an owner may change role or status';
  end if;

  -- Never strip ownership from the LAST active owner — demoting or disabling
  -- them would lock everyone out of user administration permanently. Enforced
  -- here (the DB), not just the UI, so it holds for direct SQL too.
  if old.role = 'owner'
     and (new.role <> 'owner' or new.status <> 'active')
     and (select count(*) from public.profiles
            where role = 'owner' and status = 'active' and id <> old.id) = 0 then
    raise exception 'cannot remove or disable the last active owner';
  end if;

  return new;
end $$;

drop trigger if exists protect_profile_privileges on public.profiles;
create trigger protect_profile_privileges
  before update on public.profiles
  for each row execute function public.protect_profile_privileges();

-- Same lockout protection for DELETE: the last active owner's profile can't be
-- removed (covers both direct deletes and cascade from deleting the auth user).
create or replace function public.protect_last_owner_delete()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.role = 'owner' and old.status = 'active'
     and (select count(*) from public.profiles
            where role = 'owner' and status = 'active' and id <> old.id) = 0 then
    raise exception 'cannot delete the last active owner';
  end if;
  return old;
end $$;

drop trigger if exists protect_last_owner_delete on public.profiles;
create trigger protect_last_owner_delete
  before delete on public.profiles
  for each row execute function public.protect_last_owner_delete();

-- Auto-create a profile (role = viewer) whenever a new auth user is added.
-- An owner then promotes them to their real role.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', new.email))
  on conflict (id) do nothing;
  return new;
end $$;

-- Trigger-only: trigger execution does not require client EXECUTE privilege.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- 2. JWT role claim  (custom access-token hook)
--    Adds `user_role` to every issued access token, read from profiles.
--    Enable it afterwards: Dashboard → Authentication → Hooks →
--    "Custom Access Token" → select public.custom_access_token_hook.
-- ============================================================
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  claims   jsonb;
  v_role   text;
  v_status text;
begin
  select role::text, status into v_role, v_status
    from public.profiles where id = (event->>'user_id')::uuid;
  -- A disabled user keeps their stored role but the EFFECTIVE claim drops to
  -- 'viewer', stripping every write permission (reads stay open to any signed-in
  -- user — to fully revoke sign-in, ban the user in Supabase Auth).
  if v_status is not null and v_status <> 'active' then
    v_role := 'viewer';
  end if;
  claims := event->'claims';
  claims := jsonb_set(claims, '{user_role}', to_jsonb(coalesce(v_role, 'viewer')));
  event := jsonb_set(event, '{claims}', claims);
  return event;
end $$;

-- The auth server (supabase_auth_admin) runs the hook and must read profiles.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
grant select on public.profiles to supabase_auth_admin;

drop policy if exists "auth admin read profiles" on public.profiles;
create policy "auth admin read profiles"
  on public.profiles for select to supabase_auth_admin using (true);

-- ============================================================
-- 3. Workspace  (the shared task/deliverable/KPI document)
-- ============================================================
create table if not exists public.workspace (
  id          text primary key default 'main',
  tasks       jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

insert into public.workspace (id, tasks)
values ('main', '[]'::jsonb)
on conflict (id) do nothing;

-- Legacy per-collection row kept only so existing KPI data migrates on first
-- load (loadWorkspace imports it into the document). No longer written to.
insert into public.workspace (id, tasks) values ('kpiScores', '{}'::jsonb)
on conflict (id) do nothing;

alter table public.workspace enable row level security;

-- Anyone signed in can READ the shared workspace.
drop policy if exists "anon can read workspace" on public.workspace;
drop policy if exists "workspace read (authenticated)" on public.workspace;
create policy "workspace read (authenticated)"
  on public.workspace for select to authenticated using (true);

-- WRITE is gated by ROLE (was: a single EDITOR_UID). Jira-style execution
-- model: every DELIVERY role may persist the document so they can work tasks
-- (progress, comments, checklists, evidence). investor + viewer stay read-only.
--
-- HONEST LIMIT: the workspace is still ONE jsonb document, so the DB can only
-- gate "may write the blob at all". The finer split — only leads change
-- owner/priority, only owner/PM delete tasks or manage deliverables — is
-- enforced in the app's mutation handlers (app.jsx) and is NOT a hard
-- boundary until the blob is normalised into per-resource tables. Acceptable
-- for a small trusted team; revisit at normalisation.
drop policy if exists "workspace write (editor only)" on public.workspace;
drop policy if exists "workspace write (role)" on public.workspace;
create policy "workspace write (role)"
  on public.workspace for update to authenticated
  using (public.jwt_role() in ('owner', 'product_manager', 'tech_lead', 'business_analyst', 'developer', 'qa'))
  with check (public.jwt_role() in ('owner', 'product_manager', 'tech_lead', 'business_analyst', 'developer', 'qa'));

-- ============================================================
-- 3b. Storage — task-attachments (progress-log evidence: images/files)
-- Private bucket (not public); mirrors the workspace read/write split above so
-- attachments follow the same auth model instead of a lower bar. Previously
-- these were base64 inline in workspace.tasks, ballooning that single jsonb
-- row to ~11MB and causing statement_timeout (57014) on every save — see
-- [[fm-navigate-save-timeout-2026-07-01]].
-- ============================================================
insert into storage.buckets (id, name, public)
values ('task-attachments', 'task-attachments', false)
on conflict (id) do nothing;

drop policy if exists "task-attachments read (authenticated)" on storage.objects;
create policy "task-attachments read (authenticated)"
  on storage.objects for select to authenticated
  using (bucket_id = 'task-attachments');

drop policy if exists "task-attachments write (role)" on storage.objects;
create policy "task-attachments write (role)"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'task-attachments' and public.jwt_role() in ('owner', 'product_manager', 'tech_lead', 'business_analyst', 'developer', 'qa'));

drop policy if exists "task-attachments update (role)" on storage.objects;
create policy "task-attachments update (role)"
  on storage.objects for update to authenticated
  using (bucket_id = 'task-attachments' and public.jwt_role() in ('owner', 'product_manager', 'tech_lead', 'business_analyst', 'developer', 'qa'));

drop policy if exists "task-attachments delete (role)" on storage.objects;
create policy "task-attachments delete (role)"
  on storage.objects for delete to authenticated
  using (bucket_id = 'task-attachments' and public.jwt_role() in ('owner', 'product_manager', 'tech_lead', 'business_analyst', 'developer', 'qa'));

-- ============================================================
-- 4. Comments  (generic — attach to any entity)
-- ============================================================
create table if not exists public.comments (
  id                uuid primary key default gen_random_uuid(),
  entity_type       text not null,            -- 'task' | 'deliverable' | 'kpi' | 'week' | ...
  entity_id         text not null,
  user_id           uuid not null references auth.users(id) on delete cascade,
  body              text not null,
  -- Reserved for threaded replies (disabled today; always NULL). Present now so
  -- enabling threads later needs no migration.
  parent_comment_id uuid references public.comments(id) on delete cascade,
  created_at        timestamptz not null default now()
);

create index if not exists comments_entity on public.comments (entity_type, entity_id, created_at);

alter table public.comments enable row level security;

drop policy if exists "comments read (authenticated)" on public.comments;
create policy "comments read (authenticated)"
  on public.comments for select to authenticated using (true);

-- Anyone signed in EXCEPT a pure viewer may comment, and only as themselves.
drop policy if exists "comments insert (non-viewer)" on public.comments;
create policy "comments insert (non-viewer)"
  on public.comments for insert to authenticated
  with check (auth.uid() = user_id and public.jwt_role() <> 'viewer');

-- Authors edit/delete their OWN comments; owners can moderate any.
drop policy if exists "comments update own" on public.comments;
create policy "comments update own"
  on public.comments for update to authenticated
  using (auth.uid() = user_id or public.jwt_role() = 'owner')
  with check (auth.uid() = user_id or public.jwt_role() = 'owner');

drop policy if exists "comments delete own" on public.comments;
create policy "comments delete own"
  on public.comments for delete to authenticated
  using (auth.uid() = user_id or public.jwt_role() = 'owner');

-- ============================================================
-- 5. Activity log  (append-only audit trail)
--    No UPDATE/DELETE policy => the log can't be rewritten or erased.
-- ============================================================
create table if not exists public.activity_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  action      text not null,                  -- 'created' | 'updated' | 'moved' | 'approved' | ...
  entity_type text,
  entity_id   text,
  meta        jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists activity_log_recent on public.activity_log (created_at desc);

alter table public.activity_log enable row level security;

drop policy if exists "activity read (authenticated)" on public.activity_log;
create policy "activity read (authenticated)"
  on public.activity_log for select to authenticated using (true);

drop policy if exists "activity insert (self)" on public.activity_log;
create policy "activity insert (self)"
  on public.activity_log for insert to authenticated
  with check (auth.uid() = user_id);

-- Auto-log administrative actions on profiles (user created, role changed, user
-- enabled/disabled). SECURITY DEFINER so it can write the append-only log even
-- though the actor's id may differ from the affected user. Logging in the DB
-- means it can't be skipped by forgetting to call it from the client.
create or replace function public.log_profile_admin_action()
returns trigger security definer set search_path = public language plpgsql as $$
declare
  actor uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    insert into public.activity_log (user_id, action, entity_type, entity_id, meta)
    values (actor, 'user_created', 'user', new.id::text, jsonb_build_object('email', new.email));
  elsif tg_op = 'UPDATE' then
    if new.role is distinct from old.role then
      insert into public.activity_log (user_id, action, entity_type, entity_id, meta)
      values (actor, 'role_changed', 'user', new.id::text,
              jsonb_build_object('from', old.role, 'to', new.role, 'email', new.email));
    end if;
    if new.status is distinct from old.status then
      insert into public.activity_log (user_id, action, entity_type, entity_id, meta)
      values (actor,
              case when new.status = 'active' then 'user_enabled' else 'user_disabled' end,
              'user', new.id::text, jsonb_build_object('email', new.email));
    end if;
  end if;
  return null;  -- AFTER trigger: return value ignored
end $$;

-- Trigger-only: prevent direct RPC execution by untrusted client roles.
revoke execute on function public.log_profile_admin_action() from public, anon, authenticated;

drop trigger if exists log_profile_admin_action on public.profiles;
create trigger log_profile_admin_action
  after insert or update on public.profiles
  for each row execute function public.log_profile_admin_action();

-- ============================================================
-- 6. Realtime
-- ============================================================
do $$ begin
  alter publication supabase_realtime add table public.workspace;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.comments;
exception when duplicate_object then null; end $$;

-- ============================================================
-- ============================================================
--  PHASE 2 — TABLE-DRIVEN ROLES & PERMISSIONS
--  (docs/TDD-ROLES-PERMISSIONS.md rev 0.3, approved 2026-07-17)
--
--  Permissions move from hardcoded role lists into data:
--    permissions          — the CATALOG: which capabilities exist.
--                           Migration-only, append-only, never runtime-edited.
--    role_templates +
--    template_permissions — the TEMPLATES: vendor "factory settings" per
--                           template. Migration-only. "Reset to template"
--                           restores a role to these.
--    roles                — one row per security role. Job titles are NOT
--                           roles — they live on profiles.job_title (display
--                           only, grant nothing).
--    role_permissions     — the CURRENT GRANTS. The only runtime-editable
--                           store (owners, via Settings → Roles & Permissions).
--
--  RLS policies stop naming roles and call authorize('<permission>') which
--  looks the caller's jwt_role() up in role_permissions AT QUERY TIME — so a
--  permission toggle takes effect on the next request, no re-login. Role
--  changes still apply at token refresh (hook unchanged).
--
--  Idempotency: catalog/templates are upserted to canonical values on every
--  run; role_permissions is seeded ONLY for a role that has no rows at all,
--  so re-running this file never clobbers an owner's runtime customisations
--  (exception: the owner role is always topped up to the full catalog — its
--  grants are immutable by design).
-- ============================================================

-- ---------- 2.0 Tables ----------
create table if not exists public.role_templates (
  slug  text primary key,
  label text not null
);

create table if not exists public.permissions (
  key         text primary key,      -- 'tasks.assign'
  grp         text not null,         -- UI grouping ('Tasks')
  layer       text not null,         -- capability layer (system|administration|governance|execution|collaboration|reporting|ai)
  label       text not null,
  description text,
  sort_order  int not null default 100,
  -- ENFORCED = this key has a real end-to-end effect TODAY (a client gate in
  -- fm-navigate/, an RLS authorize() call below, or both). The rest are in the
  -- catalog as the forward-compatible target shape but nothing checks them yet;
  -- the admin UI shows them read-only and labelled "Planned". Set canonically
  -- by the UPDATE after the catalog seed — the wired set lives in ONE place.
  enforced    boolean not null default false
);
-- Deploy-order safety: if an earlier Phase-2 run created this table without
-- the column, add it now (default false; the UPDATE below sets the real value).
alter table public.permissions add column if not exists enforced boolean not null default false;

create table if not exists public.template_permissions (
  template_slug  text not null references public.role_templates(slug) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  primary key (template_slug, permission_key)
);

create table if not exists public.roles (
  slug          text primary key,
  label         text not null,
  description   text,
  template_slug text not null references public.role_templates(slug),
  is_system     boolean not null default false,
  sort_order    int not null default 100,
  created_at    timestamptz not null default now()
);

create table if not exists public.role_permissions (
  role_slug      text not null references public.roles(slug) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  updated_by     uuid references auth.users(id) on delete set null,
  updated_at     timestamptz not null default now(),
  primary key (role_slug, permission_key)
);

-- ---------- 2.1 Permission catalog (migration-owned, canonical) ----------
insert into public.permissions (key, grp, layer, label, sort_order) values
  -- Tasks
  ('tasks.read',         'Tasks', 'execution',      'View tasks',                              10),
  ('tasks.create',       'Tasks', 'execution',      'Create tasks',                            11),
  ('tasks.execute',      'Tasks', 'execution',      'Work tasks — progress, checklist, evidence, status', 12),
  ('tasks.edit',         'Tasks', 'execution',      'Edit descriptive fields (title, due, effort…)',      13),
  ('tasks.link',         'Tasks', 'execution',      'Create linked tasks / link deliverables', 14),
  ('tasks.assign',       'Tasks', 'governance',     'Assign tasks / change owner',             15),
  ('tasks.prioritize',   'Tasks', 'governance',     'Change priority',                         16),
  ('tasks.delete',       'Tasks', 'governance',     'Delete tasks',                            17),
  ('tasks.approve',      'Tasks', 'governance',     'Approve tasks (MD review)',               18),
  -- Phase 3 (docs/TDD-PERSONAL-TASK-WORKSPACES.md §8.1): MANAGEMENT SCOPE.
  -- Without it a user sees only tasks they are the assignee or reporter of;
  -- with it they see every task in their own organization. This is the one
  -- key that separates "personal workspace" from "management oversight", and
  -- it is a capability an owner can grant to any role from Settings → Roles &
  -- Permissions — management is never derived from job_title or a role name.
  ('tasks.view_all',     'Tasks', 'governance',     'View all tasks in the organization',      19),
  -- Deliverables
  ('deliverables.read',   'Deliverables', 'execution',  'View deliverables',   20),
  ('deliverables.create', 'Deliverables', 'execution',  'Create deliverables', 21),
  ('deliverables.edit',   'Deliverables', 'execution',  'Edit deliverables',   22),
  ('deliverables.assign', 'Deliverables', 'governance', 'Assign deliverable owners', 23),
  ('deliverables.delete', 'Deliverables', 'governance', 'Delete deliverables', 24),
  ('deliverables.approve','Deliverables', 'governance', 'Approve deliverables', 25),
  -- Weekly Planning
  ('weekly.read',       'Weekly Planning', 'execution',  'View weekly plans',      30),
  ('weekly.write_own',  'Weekly Planning', 'execution',  'Edit own weekly plan',   31),
  ('weekly.write_team', 'Weekly Planning', 'execution',  'Edit team weekly plans', 32),
  ('weekly.approve',    'Weekly Planning', 'governance', 'Approve weekly plans',   33),
  -- KPI
  ('kpi.read',    'KPI', 'reporting',  'View KPI scorecard',   40),
  ('kpi.write',   'KPI', 'execution',  'Update KPI scores',    41),
  ('kpi.approve', 'KPI', 'governance', 'Approve KPI scores',   42),
  -- Reports
  ('reports.read',     'Reports', 'reporting', 'View reports & summaries', 50),
  ('reports.generate', 'Reports', 'reporting', 'Generate reports',         51),
  ('reports.export',   'Reports', 'reporting', 'Export data',              52),
  -- Comments
  ('comments.read',     'Comments', 'collaboration', 'Read comments',                60),
  ('comments.write',    'Comments', 'collaboration', 'Comment',                      61),
  ('comments.moderate', 'Comments', 'collaboration', 'Edit/delete others'' comments', 62),
  -- Users
  ('users.read',         'Users', 'administration', 'View the team directory', 70),
  ('users.invite',       'Users', 'administration', 'Invite users',            71),
  ('users.disable',      'Users', 'administration', 'Disable users',           72),
  ('users.assign_roles', 'Users', 'system',         'Assign roles',            73),
  ('users.delete',       'Users', 'system',         'Delete users',            74),
  -- Administration
  ('admin.workspace',   'Administration', 'governance',     'Manage workspace content (deliverables, weeks, KPI, import/clear)', 80),
  ('admin.backups',     'Administration', 'administration', 'Export backups',        81),
  ('admin.restore',     'Administration', 'system',         'Restore from backup',   82),
  ('admin.settings',    'Administration', 'administration', 'Manage app settings',   83),
  ('admin.audit_log',   'Administration', 'administration', 'View the audit log',    84),
  ('admin.permissions', 'Administration', 'system',         'Edit roles & permissions', 85),
  -- Dashboard (exceptional grants only — routine dashboards are role-derived views)
  ('dashboard.executive', 'Dashboard', 'reporting', 'View executive dashboard widgets', 90),
  ('dashboard.view_all',  'Dashboard', 'reporting', 'Switch to any dashboard view',     91)
on conflict (key) do update
  set grp = excluded.grp, layer = excluded.layer,
      label = excluded.label, sort_order = excluded.sort_order;

-- ENFORCED set (Phase 2, code-audited 2026-07-17, revised 2026-07-21).
-- STANDARD: a key is enforced only if it has a real end-to-end, user-visible
-- effect today — a control the user can hit whose allow/deny actually changes
-- persisted behaviour. RLS on a table the client never reads/writes does NOT
-- qualify (denying it changes nothing a user can observe).
--   Client-gated (fm-navigate/ can() call sites), 11:
--     tasks.read           nav item + every dashboard widget filter
--     tasks.execute        canExecute — task work + RLS workspace/storage write
--     tasks.assign         canAssign — owner field
--     tasks.prioritize     canPrioritize — priority field
--     tasks.delete         canDeleteTask — delete control
--     deliverables.read    nav item + Deliverables dashboard widget
--     weekly.read          nav item (This Week)
--     kpi.read             nav item (KPI Scorecard)
--     reports.read         nav item (Weekly Summary)
--     admin.workspace      canEdit — governance surfaces (import, New task, deliverable/week/KPI edits)
--     admin.permissions    Roles & Permissions admin card (+ RLS on role_permissions)
--   Client-gated + DB-enforced, 1:
--     users.assign_roles   Users admin card + RLS on profiles (role/status writes land)
--   Phase 3 — client-gated + DB-enforced on the NORMALIZED task tables, 3:
--     tasks.read           RLS SELECT on public.tasks (+ nav/widgets, as before)
--     tasks.create         RLS INSERT on public.tasks + the New task control
--     tasks.view_all       RLS read scope (own vs whole organization) + the
--                          management dashboard/People screen
--   tasks.execute / assign / prioritize / delete were already enforced; on the
--   normalized tables they now gate real per-row operations rather than the
--   coarse "may write the blob" document policy.
--
-- DELIBERATELY PLANNED despite having RLS: comments.write / comments.moderate.
-- The RLS policies on public.comments are live, but that TABLE IS UNUSED — the
-- comment UI (app.jsx addComment) writes into the workspace blob (task.comments)
-- gated by canExecute (tasks.execute), and nothing calls ds.addComment/
-- listComments. So denying comments.write does not stop anyone commenting; the
-- switch would be inert. They become enforced when a UI actually uses
-- public.comments (a normalisation-era change).
--
-- Any key NOT listed here is Planned (see TDD §2.1).
update public.permissions set enforced = key in (
  'tasks.read', 'tasks.create', 'tasks.execute', 'tasks.assign', 'tasks.prioritize',
  'tasks.delete', 'tasks.view_all',
  'deliverables.read', 'weekly.read', 'kpi.read', 'reports.read',
  'admin.workspace', 'admin.permissions', 'users.assign_roles'
);

-- ---------- 2.2 Templates (factory settings, migration-owned) ----------
insert into public.role_templates (slug, label) values
  ('everything',            'Everything'),
  ('executive',             'Executive + Governance + Reporting'),
  ('delivery_management',   'Delivery Management'),
  ('engineering_lead',      'Engineering Lead'),
  ('execution_lead',        'Execution Lead'),
  ('execution',             'Execution'),
  ('limited_execution',     'Limited Execution'),
  ('development',           'Development'),
  ('development_associate', 'Development (associate)'),
  ('testing',               'Testing'),
  ('personal_execution',    'Personal Workspace'),
  ('read_comment',          'Read + Comment'),
  ('read_only',             'Read Only')
on conflict (slug) do update set label = excluded.label;

-- Canonical template contents: wipe + reinsert every run (these are the
-- factory settings — runtime customisation lives in role_permissions).
delete from public.template_permissions;

-- everything = the whole catalog
insert into public.template_permissions (template_slug, permission_key)
select 'everything', key from public.permissions;

-- Reads every template gets (reads are open to all signed-in users today;
-- the seeded matrix mirrors that so table-driven UI == Phase-1 UI).
--
-- EXCEPT personal_execution (Phase 3): a self-registered member gets a PERSONAL
-- workspace, not the organization-wide governance screens. Handing them
-- deliverables/weekly/kpi/reports reads would put four org-wide items in their
-- navigation on day one, which the personal-workspace requirement rules out.
-- Their reads are granted explicitly below instead.
insert into public.template_permissions (template_slug, permission_key)
select t.slug, p.key
  from public.role_templates t
  cross join (values ('tasks.read'), ('deliverables.read'), ('weekly.read'),
                     ('kpi.read'), ('reports.read'), ('comments.read'), ('users.read')) as p(key)
 where t.slug not in ('everything', 'personal_execution');

-- comments.write: every template except read_only
insert into public.template_permissions (template_slug, permission_key)
select slug, 'comments.write' from public.role_templates
 where slug not in ('everything', 'read_only');

-- executive: governance + reporting, no execution. NOTE (honest limit): the
-- workspace blob-write policy below requires tasks.execute, so a governance-
-- only role cannot persist assign/prioritise/approve until the workspace is
-- normalised into tables. The executive role is assigned to nobody in Phase 2.
insert into public.template_permissions (template_slug, permission_key) values
  ('executive', 'tasks.assign'), ('executive', 'tasks.prioritize'),
  ('executive', 'tasks.delete'), ('executive', 'tasks.approve'),
  ('executive', 'deliverables.assign'), ('executive', 'deliverables.delete'),
  ('executive', 'deliverables.approve'),
  ('executive', 'weekly.approve'), ('executive', 'kpi.approve'),
  ('executive', 'reports.generate'), ('executive', 'reports.export'),
  ('executive', 'dashboard.executive'), ('executive', 'dashboard.view_all');

-- delivery_management (Product Manager): full task governance + workspace
-- content management. Mirrors Phase-1 PM exactly (incl. admin.workspace,
-- which backs the legacy can('workspace','write') canEdit gate).
insert into public.template_permissions (template_slug, permission_key) values
  ('delivery_management', 'tasks.create'), ('delivery_management', 'tasks.execute'),
  ('delivery_management', 'tasks.edit'), ('delivery_management', 'tasks.link'),
  ('delivery_management', 'tasks.assign'), ('delivery_management', 'tasks.prioritize'),
  ('delivery_management', 'tasks.delete'), ('delivery_management', 'tasks.approve'),
  ('delivery_management', 'deliverables.create'), ('delivery_management', 'deliverables.edit'),
  ('delivery_management', 'deliverables.assign'), ('delivery_management', 'deliverables.delete'),
  ('delivery_management', 'deliverables.approve'),
  ('delivery_management', 'weekly.write_own'), ('delivery_management', 'weekly.write_team'),
  ('delivery_management', 'kpi.write'),
  ('delivery_management', 'reports.generate'), ('delivery_management', 'reports.export'),
  ('delivery_management', 'admin.workspace'),
  ('delivery_management', 'dashboard.executive'), ('delivery_management', 'dashboard.view_all');

-- engineering_lead (Tech Lead): execution + task governance minus delete
insert into public.template_permissions (template_slug, permission_key) values
  ('engineering_lead', 'tasks.create'), ('engineering_lead', 'tasks.execute'),
  ('engineering_lead', 'tasks.edit'), ('engineering_lead', 'tasks.link'),
  ('engineering_lead', 'tasks.assign'), ('engineering_lead', 'tasks.prioritize'),
  ('engineering_lead', 'tasks.approve');

-- execution_lead (Senior BA): execution + assign
insert into public.template_permissions (template_slug, permission_key) values
  ('execution_lead', 'tasks.create'), ('execution_lead', 'tasks.execute'),
  ('execution_lead', 'tasks.edit'), ('execution_lead', 'tasks.link'),
  ('execution_lead', 'tasks.assign');

-- execution (BA) / development (SE) / testing (QA): work tasks, no governance
insert into public.template_permissions (template_slug, permission_key)
select t, k from (values ('execution'), ('development'), ('testing')) as ts(t)
  cross join (values ('tasks.create'), ('tasks.execute'), ('tasks.edit'), ('tasks.link')) as ks(k);

-- development_associate: as development but cannot edit descriptive fields
insert into public.template_permissions (template_slug, permission_key) values
  ('development_associate', 'tasks.create'), ('development_associate', 'tasks.execute'),
  ('development_associate', 'tasks.link');

-- personal_execution (Member — the self-signup default, Phase 3): a complete
-- PERSONAL task tracker and nothing else. Reads are the three a personal
-- workspace genuinely needs (own tasks, comments, the member directory that
-- backs avatars/attribution); no deliverables/weekly/kpi/reports, no
-- tasks.view_all, no assign/prioritize/delete, no admin. Scope comes from the
-- object relationship (assignee/reporter) enforced by RLS in Phase 3, not from
-- extra permission keys.
insert into public.template_permissions (template_slug, permission_key) values
  ('personal_execution', 'tasks.read'), ('personal_execution', 'comments.read'),
  ('personal_execution', 'users.read'),
  ('personal_execution', 'tasks.create'), ('personal_execution', 'tasks.execute'),
  ('personal_execution', 'tasks.edit'), ('personal_execution', 'tasks.link');

-- Management scope (Phase 3): who may see OTHER people's tasks. Seeded to the
-- two governance templates; owner gets it via 'everything'. Every other role
-- stays personal-only until an owner grants it in Settings → Roles &
-- Permissions — no deployment needed, which is the whole point of §8.1.
insert into public.template_permissions (template_slug, permission_key) values
  ('executive', 'tasks.view_all'), ('delivery_management', 'tasks.view_all');

-- limited_execution (BA intern): work assigned tasks only
insert into public.template_permissions (template_slug, permission_key) values
  ('limited_execution', 'tasks.execute');

-- read_comment (Investor): reads + comment + executive visibility
insert into public.template_permissions (template_slug, permission_key) values
  ('read_comment', 'dashboard.executive');

-- ---------- 2.3 Roles ----------
insert into public.roles (slug, label, template_slug, is_system, sort_order) values
  ('owner',                   'Owner',                       'everything',            true, 10),
  ('executive',               'Executive',                   'executive',             true, 20),
  ('product_manager',         'Product Manager',             'delivery_management',   true, 30),
  ('tech_lead',               'Tech Lead',                   'engineering_lead',      true, 40),
  ('senior_business_analyst', 'Senior Business Analyst',     'execution_lead',        true, 50),
  ('business_analyst',        'Business Analyst',            'execution',             true, 60),
  ('ba_intern',               'BA Intern',                   'limited_execution',     true, 70),
  ('developer',               'Software Engineer',           'development',           true, 80),
  ('associate_developer',     'Associate Software Engineer', 'development_associate', true, 90),
  ('qa',                      'QA Engineer',                 'testing',               true, 100),
  ('investor',                'Investor',                    'read_comment',          true, 110),
  -- Phase 3: the safe default for SELF-REGISTERED accounts. Not 'viewer' — a
  -- viewer cannot execute tasks, so a self-signed-up viewer would land in a
  -- personal workspace they cannot use. handle_new_user() hardcodes this slug.
  ('member',                  'Member',                      'personal_execution',    true, 115),
  ('viewer',                  'Viewer',                      'read_only',             true, 120)
on conflict (slug) do update
  set label = excluded.label, template_slug = excluded.template_slug,
      is_system = excluded.is_system, sort_order = excluded.sort_order;

-- ---------- 2.4 Seed current grants from templates ----------
-- Only for a role with NO rows yet (first run / brand-new role) so re-running
-- never clobbers runtime customisation.
insert into public.role_permissions (role_slug, permission_key)
select r.slug, tp.permission_key
  from public.roles r
  join public.template_permissions tp on tp.template_slug = r.template_slug
 where not exists (select 1 from public.role_permissions rp where rp.role_slug = r.slug)
on conflict do nothing;

-- The owner role is always the full catalog — top up on every run so catalog
-- additions automatically reach the owner (its grants are immutable below).
insert into public.role_permissions (role_slug, permission_key)
select 'owner', key from public.permissions
on conflict do nothing;

-- ---------- 2.5 profiles: role enum → text FK, plus job_title ----------
-- Business titles are display-only text; security roles are the FK. The old
-- app_role enum stays defined (dropped in a later cleanup) but the column is
-- text so Phase-3 custom roles need no type change.
do $$ begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profiles'
                and column_name = 'role' and udt_name = 'app_role') then
    alter table public.profiles alter column role drop default;
    alter table public.profiles alter column role type text using role::text;
    alter table public.profiles alter column role set default 'viewer';
  end if;
end $$;

do $$ begin
  alter table public.profiles
    add constraint profiles_role_fkey foreign key (role) references public.roles(slug);
exception when duplicate_object then null; end $$;

alter table public.profiles add column if not exists job_title text;

-- ---------- 2.6 authorize() — the enforcement primitive ----------
-- "Does the caller's role grant this permission RIGHT NOW?" security definer
-- so the lookup works even though role_permissions reads are scoped (2.8);
-- stable so Postgres caches it per statement. Fail closed: no row → false.
create or replace function public.authorize(requested_permission text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.role_permissions rp
    where rp.permission_key = requested_permission
      and rp.role_slug = public.jwt_role()
  );
$$;

-- RLS helper: authenticated policies need it, anonymous/direct public calls do not.
revoke execute on function public.authorize(text) from public, anon;
grant execute on function public.authorize(text) to authenticated;

-- ---------- 2.7 Guardrails + audit ----------
-- Owner grants are immutable: nothing can be revoked from 'owner', so an
-- owner can never lock themselves (and everyone else) out of administration.
create or replace function public.forbid_owner_revoke()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.role_slug = 'owner' then
    raise exception 'the owner role''s permissions are immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists protect_owner_grants on public.role_permissions;
create trigger protect_owner_grants
  before update or delete on public.role_permissions
  for each row execute function public.forbid_owner_revoke();

-- System roles cannot be deleted or renamed (their grants stay editable).
create or replace function public.protect_system_roles()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system then raise exception 'system roles cannot be deleted'; end if;
    return old;
  end if;
  if old.is_system and (new.slug <> old.slug or new.is_system <> old.is_system) then
    raise exception 'system roles cannot be renamed or demoted';
  end if;
  return new;
end $$;

drop trigger if exists protect_system_roles on public.roles;
create trigger protect_system_roles
  before update or delete on public.roles
  for each row execute function public.protect_system_roles();

-- Audit every grant/revoke to the append-only activity log (past-tense event
-- names per the TDD's permission/action/event contract). SECURITY DEFINER so
-- the log write always succeeds; in-DB logging can't be skipped by a client.
create or replace function public.log_permission_change()
returns trigger security definer set search_path = public language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into public.activity_log (user_id, action, entity_type, entity_id, meta)
    values (auth.uid(), 'permission_granted', 'role', new.role_slug,
            jsonb_build_object('permission', new.permission_key));
    return null;
  end if;
  insert into public.activity_log (user_id, action, entity_type, entity_id, meta)
  values (auth.uid(), 'permission_revoked', 'role', old.role_slug,
          jsonb_build_object('permission', old.permission_key));
  return null;
end $$;

-- Trigger-only: prevent direct RPC execution by untrusted client roles.
revoke execute on function public.log_permission_change() from public, anon, authenticated;

drop trigger if exists log_permission_change on public.role_permissions;
create trigger log_permission_change
  after insert or delete on public.role_permissions
  for each row execute function public.log_permission_change();

-- Reset a role to its template's factory settings.
--
-- SECURITY DEFINER (not INVOKER): the caller may be resetting their OWN role,
-- whose template need not include admin.permissions. Under INVOKER the DELETE
-- strips the caller's admin.permissions mid-statement, and the per-row RLS
-- WITH CHECK on the follow-up INSERT (authorize('admin.permissions')) then
-- evaluates false and aborts — leaving the role stranded with zero grants
-- (self-lockout). As DEFINER the delete+insert run with the function owner's
-- rights, so they complete atomically regardless of the caller's live grants.
--
-- Because DEFINER bypasses RLS, this function is the ONLY gate: it authorizes
-- the CALLER explicitly up front via authorize() (which reads the caller's JWT
-- claim + live grants — unaffected by DEFINER), refuses the immutable owner
-- role, and validates the role exists. search_path is locked so the trusted
-- body can't be hijacked by a caller-controlled path. auth.uid() still resolves
-- to the caller for the audit trail.
create or replace function public.reset_role_to_template(p_role text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.authorize('admin.permissions') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_role = 'owner' then
    raise exception 'the owner role''s permissions are immutable';
  end if;
  if not exists (select 1 from public.roles where slug = p_role) then
    raise exception 'unknown role: %', p_role using errcode = '22023';
  end if;
  delete from public.role_permissions where role_slug = p_role;
  insert into public.role_permissions (role_slug, permission_key, updated_by)
  select p_role, tp.permission_key, auth.uid()
    from public.roles r
    join public.template_permissions tp on tp.template_slug = r.template_slug
   where r.slug = p_role;
end $$;

-- DEFINER function must not be callable by anon; only signed-in users, and the
-- body re-checks admin.permissions. (System backstop against total lockout:
-- the owner role is immutable and can't be reset, and last-active-owner
-- protection guarantees an owner always exists — so admin.permissions can
-- never be reset out of existence system-wide; a non-owner admin who resets
-- their own role out of it is always recoverable by an owner.)
revoke execute on function public.reset_role_to_template(text) from public, anon;
grant execute on function public.reset_role_to_template(text) to authenticated;

-- ---------- 2.8 RLS on the new tables ----------
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_templates enable row level security;
alter table public.template_permissions enable row level security;
alter table public.role_permissions enable row level security;

-- Catalog data (roles, permission catalog, templates): readable by any signed-
-- in user (labels, admin UI); writable by nobody at runtime (migration-only).
drop policy if exists "roles read (authenticated)" on public.roles;
create policy "roles read (authenticated)"
  on public.roles for select to authenticated using (true);

drop policy if exists "permissions read (authenticated)" on public.permissions;
create policy "permissions read (authenticated)"
  on public.permissions for select to authenticated using (true);

drop policy if exists "role_templates read (authenticated)" on public.role_templates;
create policy "role_templates read (authenticated)"
  on public.role_templates for select to authenticated using (true);

drop policy if exists "template_permissions read (authenticated)" on public.template_permissions;
create policy "template_permissions read (authenticated)"
  on public.template_permissions for select to authenticated using (true);

-- Grants: a user reads their OWN role's grants (all can() ever needs); the
-- full matrix needs admin.permissions. Only admin.permissions holders mutate.
drop policy if exists "role_permissions read (own role or admin)" on public.role_permissions;
create policy "role_permissions read (own role or admin)"
  on public.role_permissions for select to authenticated
  using (role_slug = public.jwt_role() or public.authorize('admin.permissions'));

drop policy if exists "role_permissions insert (admin)" on public.role_permissions;
create policy "role_permissions insert (admin)"
  on public.role_permissions for insert to authenticated
  with check (public.authorize('admin.permissions'));

drop policy if exists "role_permissions delete (admin)" on public.role_permissions;
create policy "role_permissions delete (admin)"
  on public.role_permissions for delete to authenticated
  using (public.authorize('admin.permissions'));

-- ---------- 2.9 Swap hardcoded role lists → authorize() ----------
-- Workspace blob write: every role that may WORK tasks. (Honest limit
-- unchanged from Phase 1: the workspace is one jsonb document, so this is
-- the only DB-enforceable write gate until normalisation. Finer checks —
-- assign/prioritise/delete — stay in the app's mutation handlers.)
drop policy if exists "workspace write (role)" on public.workspace;
create policy "workspace write (role)"
  on public.workspace for update to authenticated
  using (public.authorize('tasks.execute'))
  with check (public.authorize('tasks.execute'));

-- Storage (task attachments) mirrors the workspace write gate.
drop policy if exists "task-attachments write (role)" on storage.objects;
create policy "task-attachments write (role)"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'task-attachments' and public.authorize('tasks.execute'));

drop policy if exists "task-attachments update (role)" on storage.objects;
create policy "task-attachments update (role)"
  on storage.objects for update to authenticated
  using (bucket_id = 'task-attachments' and public.authorize('tasks.execute'));

drop policy if exists "task-attachments delete (role)" on storage.objects;
create policy "task-attachments delete (role)"
  on storage.objects for delete to authenticated
  using (bucket_id = 'task-attachments' and public.authorize('tasks.execute'));

-- Comments: capability-driven instead of "not viewer" / "is owner".
-- NB: public.comments is currently UNUSED by the app — task comments live in
-- the workspace blob (task.comments, gated by tasks.execute). These policies
-- are kept ready for when a UI adopts this table, but until then comments.write
-- / comments.moderate are marked Planned (not enforced) in §2.1, because
-- toggling them changes nothing a user can observe.
drop policy if exists "comments insert (non-viewer)" on public.comments;
create policy "comments insert (non-viewer)"
  on public.comments for insert to authenticated
  with check (auth.uid() = user_id and public.authorize('comments.write'));

drop policy if exists "comments update own" on public.comments;
create policy "comments update own"
  on public.comments for update to authenticated
  using (auth.uid() = user_id or public.authorize('comments.moderate'))
  with check (auth.uid() = user_id or public.authorize('comments.moderate'));

drop policy if exists "comments delete own" on public.comments;
create policy "comments delete own"
  on public.comments for delete to authenticated
  using (auth.uid() = user_id or public.authorize('comments.moderate'));

-- Profile administration: capability, not role name.
drop policy if exists "profiles owner manage" on public.profiles;
create policy "profiles owner manage"
  on public.profiles for all to authenticated
  using (public.authorize('users.assign_roles'))
  with check (public.authorize('users.assign_roles'));

-- Privilege-escalation guard now checks the capability too.
create or replace function public.protect_profile_privileges()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.role is distinct from old.role or new.status is distinct from old.status)
     and not public.authorize('users.assign_roles') then
    raise exception 'only an administrator may change role or status';
  end if;

  if old.role = 'owner'
     and (new.role <> 'owner' or new.status <> 'active')
     and (select count(*) from public.profiles
            where role = 'owner' and status = 'active' and id <> old.id) = 0 then
    raise exception 'cannot remove or disable the last active owner';
  end if;

  return new;
end $$;

-- ---------- 2.10 Realtime ----------
do $$ begin
  alter publication supabase_realtime add table public.role_permissions;
exception when duplicate_object then null; end $$;

-- ============================================================
-- ============================================================
--  PHASE 3 — PERSONAL TASK WORKSPACES
--  (docs/TDD-PERSONAL-TASK-WORKSPACES.md)
--
--  Phase 2 answered "may this ROLE do this?". It could not answer "on
--  WHICH task?", because every task lived inside one shared jsonb
--  document and a document has no rows to secure. Phase 3 normalises
--  tasks into real tables so Postgres can answer both:
--
--      RBAC             → may this user perform this capability?
--      object relation  → is this task theirs? (assignee / reporter)
--      organization     → is this task even in their tenant?
--      RLS              → enforces all three, server-side
--
--  Management is a CAPABILITY (tasks.view_all), never a job title and
--  never a hardcoded role name — an owner can grant it to any role from
--  Settings → Roles & Permissions with no deployment.
--
--  Idempotent like the rest of this file: tables are `if not exists`,
--  seeds are `on conflict do nothing`, policies/triggers are dropped and
--  recreated. The workspace document is NEVER modified here — the task
--  migration (§3.9) is explicit, operator-run and non-destructive.
-- ============================================================

-- ---------- 3.1 Organizations (tenant boundary) ----------
create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  created_at  timestamptz not null default now()
);

-- 'team'     — a real shared organization (Evbex / FM Navigate). Membership is
--              granted deliberately: by invitation or by an administrator.
-- 'personal' — the private workspace every account gets at signup so that
--              "anyone can have their own task tracker" is true without anyone
--              being handed access to somebody else's organization (ADR 0008).
alter table public.organizations add column if not exists kind text not null default 'team';
alter table public.organizations add column if not exists owner_user_id uuid references auth.users(id) on delete cascade;
do $$ begin
  alter table public.organizations add constraint organizations_kind_check
    check (kind in ('team', 'personal'));
exception when duplicate_object then null; end $$;
-- One personal workspace per account, enforced by the database rather than by
-- the trigger remembering to check.
create unique index if not exists organizations_one_personal_per_user
  on public.organizations (owner_user_id) where kind = 'personal';

-- Membership is the ONE source of truth for "who is in which organization".
-- Deliberately NOT a column on profiles as well — two stores would drift.
create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  joined_at       timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index if not exists organization_members_user on public.organization_members (user_id);

-- The FM Navigate deployment is single-tenant today. A FIXED uuid keeps this
-- seed (and every back-fill that references it) idempotent across re-runs.
insert into public.organizations (id, slug, name)
values ('00000000-0000-0000-0000-000000000001', 'fm-navigate', 'FM Navigate')
on conflict (id) do nothing;

-- The PRIMARY (Evbex / FM Navigate) organization. Referenced by the one-shot
-- back-fill and by the invite path — NOT by signup. A new account never joins
-- this organization automatically (ADR 0008).
create or replace function public.default_org_id()
returns uuid language sql immutable set search_path = '' as $$
  select '00000000-0000-0000-0000-000000000001'::uuid
$$;

-- Back-fill: every account that existed BEFORE this phase belongs to the
-- primary organization. ONE SHOT, guarded by a marker row.
--
-- This guard is load-bearing, not tidiness. schema.sql is re-runnable by
-- design; an unguarded `insert … select from profiles` would sweep every
-- public self-registered account into Evbex the next time anyone applied the
-- file. The marker makes "existing users at rollout time" a fixed set.
create table if not exists public.schema_markers (
  key        text primary key,
  applied_at timestamptz not null default now(),
  note       text
);

-- This table holds no application data, which is exactly why it was easy to
-- miss — and why leaving it open was the worst of the three. Supabase grants
-- ALL on every table in `public` to `anon` and `authenticated` by default, so
-- without RLS this guard was editable over PostgREST by anyone holding the
-- (deliberately public) anon key. Deleting the row below re-arms the one-shot
-- back-fill, and the runbook's first rollout step is to re-apply this file:
-- the next apply would then sweep EVERY self-registered account into the
-- primary organization, where is_org_member() and shares_org_with() hand each
-- of them the whole tenant. Planting a key does the reverse — it silently
-- suppresses a migration that has not run yet.
--
-- Same shape as workspace_task_archive below: RLS on with NO policy, and the
-- default grants revoked, which denies every client outright. Nothing outside
-- the SQL editor reads this table — the guarded `do` blocks run as the owner
-- during an apply, and owners bypass RLS.
alter table public.schema_markers enable row level security;
revoke all on public.schema_markers from anon, authenticated;

do $$
begin
  if not exists (select 1 from public.schema_markers where key = 'phase3_backfill_primary_org') then
    insert into public.organization_members (organization_id, user_id)
    select public.default_org_id(), id from public.profiles
    on conflict do nothing;
    insert into public.schema_markers (key, note)
    values ('phase3_backfill_primary_org',
            'pre-Phase-3 accounts joined to the primary organization; never repeat');
  end if;
end $$;

-- Is the caller a member of this organization? SECURITY DEFINER so policies
-- never recurse into organization_members' own RLS, and so the check is one
-- index probe. Fail closed: no membership row → false.
create or replace function public.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.organization_members m
     where m.organization_id = p_org and m.user_id = auth.uid()
  )
$$;

revoke execute on function public.is_org_member(uuid) from public, anon;
grant execute on function public.is_org_member(uuid) to authenticated;

-- Does the caller share an organization with this user? Backs the profile
-- directory read (assignee pickers must never surface another tenant).
create or replace function public.shares_org_with(p_user uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.organization_members a
      join public.organization_members b on b.organization_id = a.organization_id
     where a.user_id = auth.uid() and b.user_id = p_user
  )
$$;

revoke execute on function public.shares_org_with(uuid) from public, anon;
grant execute on function public.shares_org_with(uuid) to authenticated;

alter table public.organizations       enable row level security;
alter table public.organization_members enable row level security;

-- Read your own organizations / co-members. No INSERT/UPDATE/DELETE policy at
-- all: membership is granted by the signup trigger and the migration (both
-- SECURITY DEFINER) — a client can never add itself to an organization.
drop policy if exists "organizations read (members)" on public.organizations;
create policy "organizations read (members)"
  on public.organizations for select to authenticated
  using (public.is_org_member(id));

drop policy if exists "organization_members read (same org)" on public.organization_members;
create policy "organization_members read (same org)"
  on public.organization_members for select to authenticated
  using (public.is_org_member(organization_id));

grant select on public.organizations, public.organization_members to authenticated;

-- Profile directory is now organization-scoped (was: every signed-in user
-- could read every profile). Self is always readable so an account mid-signup
-- can load its own row before the membership row lands.
-- Both names are dropped: the Phase-1 one because §1 recreates it every time
-- this file is applied, and the new one because `schema.sql` is re-runnable by
-- design (TDD §20 step 1, ADR 0008) and `create policy` has no `if not exists`.
-- Dropping only the old name made the second apply abort here, which left the
-- whole of §3 below unapplied and — until this statement was reached — §1's
-- permissive `using (true)` profile read live alongside the scoped one.
drop policy if exists "profiles read (authenticated)" on public.profiles;
drop policy if exists "profiles read (same organization)" on public.profiles;
create policy "profiles read (same organization)"
  on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_org_with(id));

-- Profile ADMINISTRATION is scoped the same way, and for the same reason.
-- §2.9's policy is `for all using (authorize('users.assign_roles'))` with no
-- organization predicate — correct when there was one tenant, a hole the
-- moment Phase 3 gave every public signup an organization of its own.
-- Postgres ORs permissive policies together, so that unscoped ALL policy
-- also answered SELECT: an administrator of one tenant could read every
-- account on the platform, re-role another tenant's owner, and delete their
-- profile outright. Exactly the ADR 0009 pattern — a rule that was right when
-- written and became wrong when the data underneath it changed shape.
--
-- Same rule as everywhere else: capability AND tenant. Administering your own
-- organization is unchanged; reaching outside it is not administration.
-- Self is kept readable/writable so a user mid-signup can still load and
-- update their own row before the membership lands (as in the read policy).
drop policy if exists "profiles owner manage" on public.profiles;
create policy "profiles owner manage"
  on public.profiles for all to authenticated
  using (public.authorize('users.assign_roles')
         and (id = auth.uid() or public.shares_org_with(id)))
  with check (public.authorize('users.assign_roles')
              and (id = auth.uid() or public.shares_org_with(id)));

-- ---------- 3.2 Normalized tasks ----------
-- ids are the EXISTING display ids ('T-142') so every link, weekly-plan
-- reference, export and audit record stays valid after the migration.
create table if not exists public.tasks (
  id               text primary key,
  organization_id  uuid not null references public.organizations(id),
  title            text not null,
  description      text,
  -- REPORTER = who raised it (immutable). ASSIGNEE = who is responsible for
  -- finishing it (changeable only with tasks.assign). They are frequently the
  -- same person: a standard user's own task is reported and assigned to them.
  reporter_id      uuid references public.profiles(id) on delete set null,
  assignee_id      uuid references public.profiles(id) on delete set null,
  status           text not null default 'Not Started',
  priority         text not null default 'Medium',
  category         text,
  effort           text,
  progress         int  not null default 0,
  due_date         timestamptz,
  completed_at     timestamptz,
  deliverable_id   text,
  success_criteria text,
  risk             text,
  -- Value lists, not independently secured entities: always read and written
  -- with their parent row (TDD §6.2). dependencies = free-text labels.
  dependencies     jsonb not null default '[]'::jsonb,
  dep_task_ids     jsonb not null default '[]'::jsonb,
  edits            jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id) on delete set null,
  updated_by       uuid references public.profiles(id) on delete set null,
  -- Migration-only forensic field: the pre-normalisation owner key when it
  -- could not be mapped to a real account. Display data; grants nothing.
  legacy_owner     text
);

create index if not exists tasks_org        on public.tasks (organization_id);
create index if not exists tasks_assignee   on public.tasks (organization_id, assignee_id);
create index if not exists tasks_reporter   on public.tasks (organization_id, reporter_id);
create index if not exists tasks_status     on public.tasks (organization_id, status);
create index if not exists tasks_due        on public.tasks (organization_id, due_date);

create table if not exists public.task_checklist_items (
  id                   text primary key,
  task_id              text not null references public.tasks(id) on delete cascade,
  title                text not null,
  note                 text,
  done                 boolean not null default false,
  links                jsonb not null default '[]'::jsonb,
  files                jsonb not null default '[]'::jsonb,
  completed_at         timestamptz,
  completed_by         uuid references public.profiles(id) on delete set null,
  completed_in_log_id  text,
  sort_order           int not null default 0
);
create index if not exists task_checklist_task on public.task_checklist_items (task_id, sort_order);

create table if not exists public.task_progress (
  id            text primary key,
  task_id       text not null references public.tasks(id) on delete cascade,
  percent       int  not null default 0,
  status        text,
  note          text,
  links         jsonb not null default '[]'::jsonb,
  files         jsonb not null default '[]'::jsonb,
  checklist_ids jsonb not null default '[]'::jsonb,
  user_id       uuid references public.profiles(id) on delete set null,
  at            timestamptz not null default now(),
  edited_at     timestamptz
);
create index if not exists task_progress_task on public.task_progress (task_id, at);

create table if not exists public.task_resources (
  id         text primary key,
  task_id    text not null references public.tasks(id) on delete cascade,
  kind       text not null default 'link',
  title      text,
  url        text,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists task_resources_task on public.task_resources (task_id);

create table if not exists public.task_comments (
  id         text primary key,
  task_id    text not null references public.tasks(id) on delete cascade,
  user_id    uuid references public.profiles(id) on delete set null,
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists task_comments_task on public.task_comments (task_id, created_at);

-- Per-task event feed the UI renders. `seq` is the entry's position in the
-- task's activity list, which makes the client's append-only sync idempotent
-- (`on conflict do nothing` re-sending the same entry is a no-op).
create table if not exists public.task_activity (
  task_id text not null references public.tasks(id) on delete cascade,
  seq     int  not null,
  type    text not null,
  user_id uuid references public.profiles(id) on delete set null,
  at      timestamptz not null default now(),
  detail  text,
  primary key (task_id, seq)
);

-- ---------- 3.3 The two scope predicates ----------
-- Every task policy is built from these, so read scope and write scope can
-- never drift apart across the six tables. Fail closed by construction:
-- there is no `true` branch anywhere.
--
--   READ  = in my organization AND I may read tasks at all
--           AND (it is assigned to me OR I am management)
--   WRITE = in my organization AND I may work tasks at all
--           AND (it is assigned to me OR I am management)
--
-- REPORTER IS NOT IN THESE PREDICATES (ADR 0007). Who raised a task is
-- metadata about its origin, not a standing grant over it. If a manager
-- creates work and assigns it to somebody else — or if you raise something
-- that is then reassigned away from you — the task is now that person's, and
-- continued sight of it is exactly what tasks.view_all is for. Letting
-- reporter imply access would mean a standard user keeps read AND execute
-- rights over another person's work indefinitely, which is the behaviour this
-- whole phase exists to prevent.
--
-- A future "tasks I requested" view would be its own explicit capability
-- (tasks.view_reported) or an object-role/sharing mechanism. Not built now.
--
-- Column-level rules (who may change assignee / priority / organization) are
-- NOT here: a WITH CHECK cannot see OLD, so they live in the BEFORE UPDATE
-- trigger in §3.5 — the same pattern as protect_profile_privileges.

-- Re-run safety: the predicates used to take a third (reporter) argument, and
-- Postgres records a dependency from every SQL function and policy that calls
-- them. Drop the old signature — and whatever still references it — before
-- creating the new one; everything dropped here is recreated below in this
-- same file, in order.
drop policy if exists "tasks read (own or management)" on public.tasks;
drop policy if exists "tasks update (assignee, reporter or management)" on public.tasks;
drop policy if exists "tasks update (assignee or management)" on public.tasks;
drop policy if exists "tasks delete (governance)" on public.tasks;
drop function if exists public.task_read_ok(uuid, uuid, uuid) cascade;
drop function if exists public.task_write_ok(uuid, uuid, uuid) cascade;

create or replace function public.task_read_ok(p_org uuid, p_assignee uuid)
returns boolean language sql stable set search_path = '' as $$
  select public.is_org_member(p_org)
     and public.authorize('tasks.read')
     and (p_assignee = auth.uid() or public.authorize('tasks.view_all'))
$$;

create or replace function public.task_write_ok(p_org uuid, p_assignee uuid)
returns boolean language sql stable set search_path = '' as $$
  select public.is_org_member(p_org)
     and public.authorize('tasks.execute')
     and (p_assignee = auth.uid() or public.authorize('tasks.view_all'))
$$;

-- Child-row helpers: a child row is exactly as visible/writable as its parent
-- task. Expressed once, reused by all five child tables.
create or replace function public.parent_task_readable(p_task text)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.tasks t
     where t.id = p_task
       and public.task_read_ok(t.organization_id, t.assignee_id)
  )
$$;

create or replace function public.parent_task_writable(p_task text)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.tasks t
     where t.id = p_task
       and public.task_write_ok(t.organization_id, t.assignee_id)
  )
$$;

-- ---------- 3.4 RLS ----------
alter table public.tasks                 enable row level security;
alter table public.task_checklist_items  enable row level security;
alter table public.task_progress         enable row level security;
alter table public.task_resources        enable row level security;
alter table public.task_comments         enable row level security;
alter table public.task_activity         enable row level security;

grant select, insert, update, delete on
  public.tasks, public.task_checklist_items, public.task_progress,
  public.task_resources, public.task_comments, public.task_activity
  to authenticated;

drop policy if exists "tasks read (own or management)" on public.tasks;
create policy "tasks read (own or management)"
  on public.tasks for select to authenticated
  using (public.task_read_ok(organization_id, assignee_id));

-- CREATE. A standard user may only ever create a task for THEMSELVES:
-- reporter and assignee both forced to auth.uid(). Creating for someone else
-- is the tasks.assign capability. reporter_id/created_by are pinned to the
-- caller, so a forged payload is REJECTED (not silently corrected).
--
-- Being the reporter grants nothing on its own (§3.3): a manager who creates
-- work for someone else can still see it because they hold tasks.view_all,
-- not because they raised it.
drop policy if exists "tasks insert (self or assigner)" on public.tasks;
create policy "tasks insert (self or assigner)"
  on public.tasks for insert to authenticated
  with check (
    public.is_org_member(organization_id)
    and public.authorize('tasks.create')
    and reporter_id = auth.uid()
    and created_by  = auth.uid()
    and (assignee_id = auth.uid() or public.authorize('tasks.assign'))
  );

-- UPDATE. Both USING and WITH CHECK use the write predicate, so a task can
-- never be edited out of the caller's own scope (e.g. reassigning it away and
-- keeping the edit) — the post-image must still be writable by the caller.
create policy "tasks update (assignee or management)"
  on public.tasks for update to authenticated
  using (public.task_write_ok(organization_id, assignee_id))
  with check (public.task_write_ok(organization_id, assignee_id));

drop policy if exists "tasks delete (governance)" on public.tasks;
create policy "tasks delete (governance)"
  on public.tasks for delete to authenticated
  using (public.task_read_ok(organization_id, assignee_id)
         and public.authorize('tasks.delete'));

-- Children: read with the parent, write with the parent.
drop policy if exists "checklist read"  on public.task_checklist_items;
drop policy if exists "checklist write" on public.task_checklist_items;
create policy "checklist read"  on public.task_checklist_items for select to authenticated
  using (public.parent_task_readable(task_id));
create policy "checklist write" on public.task_checklist_items for all to authenticated
  using (public.parent_task_writable(task_id))
  with check (public.parent_task_writable(task_id));

drop policy if exists "task_progress read"   on public.task_progress;
drop policy if exists "task_progress insert" on public.task_progress;
drop policy if exists "task_progress amend"  on public.task_progress;
drop policy if exists "task_progress remove" on public.task_progress;
create policy "task_progress read" on public.task_progress for select to authenticated
  using (public.parent_task_readable(task_id));
-- You log progress AS YOURSELF; governance may amend/remove anyone's entry,
-- everyone else only their own (mirrors the app's existing rule, now enforced).
create policy "task_progress insert" on public.task_progress for insert to authenticated
  with check (public.parent_task_writable(task_id) and user_id = auth.uid());
create policy "task_progress amend" on public.task_progress for update to authenticated
  using (public.parent_task_writable(task_id)
         and (user_id = auth.uid() or public.authorize('admin.workspace')))
  with check (public.parent_task_writable(task_id));
create policy "task_progress remove" on public.task_progress for delete to authenticated
  using (public.parent_task_writable(task_id)
         and (user_id = auth.uid() or public.authorize('admin.workspace')));

drop policy if exists "task_resources read"  on public.task_resources;
drop policy if exists "task_resources write" on public.task_resources;
create policy "task_resources read"  on public.task_resources for select to authenticated
  using (public.parent_task_readable(task_id));
create policy "task_resources write" on public.task_resources for all to authenticated
  using (public.parent_task_writable(task_id))
  with check (public.parent_task_writable(task_id));

drop policy if exists "task_comments read"   on public.task_comments;
drop policy if exists "task_comments insert" on public.task_comments;
drop policy if exists "task_comments amend"  on public.task_comments;
drop policy if exists "task_comments remove" on public.task_comments;
create policy "task_comments read" on public.task_comments for select to authenticated
  using (public.parent_task_readable(task_id));
create policy "task_comments insert" on public.task_comments for insert to authenticated
  with check (public.parent_task_writable(task_id)
              and user_id = auth.uid()
              and public.authorize('comments.write'));
create policy "task_comments amend" on public.task_comments for update to authenticated
  using (user_id = auth.uid() or public.authorize('comments.moderate'))
  with check (public.parent_task_readable(task_id));
create policy "task_comments remove" on public.task_comments for delete to authenticated
  using (public.parent_task_readable(task_id)
         and (user_id = auth.uid() or public.authorize('comments.moderate')));

-- Activity feed: append-only per task. No UPDATE/DELETE policy, so the feed
-- can be added to but never rewritten (same guarantee as activity_log).
drop policy if exists "task_activity read"   on public.task_activity;
drop policy if exists "task_activity append" on public.task_activity;
create policy "task_activity read" on public.task_activity for select to authenticated
  using (public.parent_task_readable(task_id));
create policy "task_activity append" on public.task_activity for insert to authenticated
  with check (public.parent_task_writable(task_id) and user_id = auth.uid());

-- ---------- 3.5 Column-level governance + integrity ----------
-- What a WITH CHECK cannot express (it never sees OLD): who may change the
-- assignee, who may change the priority, and which columns are immutable.
create or replace function public.protect_task_governance()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    -- An assignee must belong to the task's organization: assignment can never
    -- leak a task across the tenant boundary.
    if new.assignee_id is not null and not exists (
         select 1 from public.organization_members m
          where m.organization_id = new.organization_id and m.user_id = new.assignee_id) then
      raise exception 'assignee is not a member of this organization' using errcode = '42501';
    end if;
    return new;
  end if;

  -- Identity + tenancy are immutable: a task never changes id, organization,
  -- or who raised it.
  if new.id is distinct from old.id then
    raise exception 'a task id cannot be changed' using errcode = '42501';
  end if;
  if new.organization_id is distinct from old.organization_id then
    raise exception 'a task cannot move between organizations' using errcode = '42501';
  end if;
  if new.reporter_id is distinct from old.reporter_id then
    raise exception 'the reporter of a task cannot be changed' using errcode = '42501';
  end if;

  -- Assign / reassign is a capability, not a side effect of being able to edit.
  if new.assignee_id is distinct from old.assignee_id then
    if not public.authorize('tasks.assign') then
      raise exception 'not permitted to assign or reassign tasks' using errcode = '42501';
    end if;
    if new.assignee_id is not null and not exists (
         select 1 from public.organization_members m
          where m.organization_id = new.organization_id and m.user_id = new.assignee_id) then
      raise exception 'assignee is not a member of this organization' using errcode = '42501';
    end if;
  end if;

  if new.priority is distinct from old.priority and not public.authorize('tasks.prioritize') then
    raise exception 'not permitted to change priority' using errcode = '42501';
  end if;

  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), old.updated_by);
  return new;
end $$;

drop trigger if exists protect_task_governance on public.tasks;
create trigger protect_task_governance
  before insert or update on public.tasks
  for each row execute function public.protect_task_governance();

-- ---------- 3.6 Task audit (organization audit trail) ----------
-- The six task events, written in the DATABASE so they cannot be skipped by a
-- client that forgets to log. These land in the existing append-only
-- activity_log (security/organization audit); the per-task feed the UI renders
-- is task_activity, written by the app — the two are different records, not
-- duplicates of the same one.
create or replace function public.log_task_event()
returns trigger security definer set search_path = public, pg_temp language plpgsql as $$
declare actor uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    insert into public.activity_log (user_id, action, entity_type, entity_id, meta)
    values (actor, 'task_created', 'task', new.id,
            jsonb_build_object('title', new.title, 'assignee', new.assignee_id, 'reporter', new.reporter_id));
    if new.assignee_id is not null and new.assignee_id is distinct from new.reporter_id then
      insert into public.activity_log (user_id, action, entity_type, entity_id, meta)
      values (actor, 'task_assigned', 'task', new.id, jsonb_build_object('to', new.assignee_id));
    end if;
    return null;
  end if;

  if new.assignee_id is distinct from old.assignee_id then
    insert into public.activity_log (user_id, action, entity_type, entity_id, meta)
    values (actor, 'task_reassigned', 'task', new.id,
            jsonb_build_object('was', old.assignee_id, 'now', new.assignee_id));
  end if;
  if new.status is distinct from old.status then
    insert into public.activity_log (user_id, action, entity_type, entity_id, meta)
    values (actor, 'task_status_changed', 'task', new.id,
            jsonb_build_object('was', old.status, 'now', new.status));
    if new.status = 'Completed' then
      insert into public.activity_log (user_id, action, entity_type, entity_id, meta)
      values (actor, 'task_completed', 'task', new.id, jsonb_build_object('assignee', new.assignee_id));
    end if;
  end if;
  if new.priority is distinct from old.priority then
    insert into public.activity_log (user_id, action, entity_type, entity_id, meta)
    values (actor, 'task_priority_changed', 'task', new.id,
            jsonb_build_object('was', old.priority, 'now', new.priority));
  end if;
  return null;
end $$;

-- Trigger-only: prevent direct RPC execution by untrusted client roles.
revoke execute on function public.log_task_event() from public, anon, authenticated;

drop trigger if exists log_task_event on public.tasks;
create trigger log_task_event
  after insert or update on public.tasks
  for each row execute function public.log_task_event();

-- ---------- 3.7 Self-registration ----------
-- Replaces the Phase-1 version (which defaulted every new account to 'viewer'
-- and had no organization). Anyone may now create their own account; what they
-- GET is decided here, server-side:
--
--   1. the profile, with role = 'member' — HARDCODED, never read from client
--      metadata, so a tampered signup payload cannot request Owner/Executive/
--      Product Manager/administrator/management/any other role;
--   2. their OWN personal workspace, and membership of that and nothing else;
--   3. nothing in any existing organization.
--
-- CREATING AN ACCOUNT IS NOT JOINING A COMPANY (ADR 0008). The previous
-- version auto-joined the primary organization, which meant anyone who could
-- reach the signup form became an Evbex workspace member. Account and
-- membership are now separate facts: registration grants the first, and only
-- an invitation or an administrator grants the second (§3.7b).
--
-- The personal workspace is what keeps "anyone can have their own task
-- tracker" true. It is an ordinary organization with kind='personal', so every
-- task policy, the tenant boundary and the whole client work there unchanged —
-- no second code path, no special case in RLS.
--
-- Only `name` is taken from client metadata — a display string that grants
-- nothing. Later self-service role changes are already blocked by
-- protect_profile_privileges (requires users.assign_roles).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_role text := 'member';
  v_name text := coalesce(nullif(new.raw_user_meta_data->>'name', ''), new.email, 'Member');
  v_org  uuid;
begin
  -- Deploy-order safety: if the Phase-2/3 role seed hasn't run yet, fall back
  -- to the always-present 'viewer' rather than failing the signup on the FK.
  if not exists (select 1 from public.roles where slug = v_role) then
    v_role := 'viewer';
  end if;

  insert into public.profiles (id, email, name, role)
  values (new.id, new.email, v_name, v_role)
  on conflict (id) do nothing;

  -- The account's own workspace. Deterministic slug, so a replayed trigger is
  -- a no-op rather than a duplicate.
  insert into public.organizations (slug, name, kind, owner_user_id)
  values ('personal-' || new.id::text,
          left(v_name, 40) || '''s Workspace',
          'personal', new.id)
  on conflict (slug) do nothing;

  select id into v_org from public.organizations where slug = 'personal-' || new.id::text;
  if v_org is not null then
    insert into public.organization_members (organization_id, user_id)
    values (v_org, new.id)
    on conflict do nothing;
  end if;

  return new;
end $fn$;

-- Reassert after the Phase-3 replacement of the Phase-1 trigger function.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 3.7b Joining a real organization ----------
-- The ONLY way into a team organization. organization_members has no INSERT
-- policy at all, so this SECURITY DEFINER function is not one path among
-- several — it is the path, and it authorizes the caller before it writes.
--
-- Gated on users.assign_roles: the capability that already means "may decide
-- what other people can do here". Deliberately NOT a new permission key —
-- inventing one would add a switch to the admin screen for what is the same
-- administrative act.
--
-- An invitation flow (email → accept) can be layered on later by having the
-- acceptance step call exactly this function; the authorization boundary would
-- not move.
create or replace function public.add_organization_member(p_org uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if not public.authorize('users.assign_roles') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- An administrator may only admit people to an organization they are in
  -- themselves; nobody hands out membership of a tenant they cannot see.
  if not public.is_org_member(p_org) then
    raise exception 'not a member of that organization' using errcode = '42501';
  end if;
  -- A personal workspace has exactly one member, forever.
  if exists (select 1 from public.organizations where id = p_org and kind = 'personal') then
    raise exception 'a personal workspace cannot take additional members' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'unknown user' using errcode = '22023';
  end if;

  insert into public.organization_members (organization_id, user_id)
  values (p_org, p_user)
  on conflict do nothing;

  insert into public.activity_log (user_id, action, entity_type, entity_id, meta)
  values (auth.uid(), 'organization_member_added', 'organization', p_org::text,
          jsonb_build_object('user', p_user));
end $fn$;

revoke execute on function public.add_organization_member(uuid, uuid) from public, anon;
grant  execute on function public.add_organization_member(uuid, uuid) to authenticated;

create or replace function public.remove_organization_member(p_org uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if not public.authorize('users.assign_roles') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not public.is_org_member(p_org) then
    raise exception 'not a member of that organization' using errcode = '42501';
  end if;
  if exists (select 1 from public.organizations where id = p_org and kind = 'personal') then
    raise exception 'a personal workspace cannot be emptied' using errcode = '42501';
  end if;

  delete from public.organization_members where organization_id = p_org and user_id = p_user;

  insert into public.activity_log (user_id, action, entity_type, entity_id, meta)
  values (auth.uid(), 'organization_member_removed', 'organization', p_org::text,
          jsonb_build_object('user', p_user));
end $fn$;

revoke execute on function public.remove_organization_member(uuid, uuid) from public, anon;
grant  execute on function public.remove_organization_member(uuid, uuid) to authenticated;

-- Back-fill: give every pre-existing account its personal workspace too, so
-- the model is uniform. One shot, same marker discipline as the org back-fill.
do $do$
declare r record; v_org uuid;
begin
  if not exists (select 1 from public.schema_markers where key = 'phase3_personal_workspaces') then
    for r in select id, coalesce(nullif(name, ''), email, 'Member') as nm from public.profiles loop
      insert into public.organizations (slug, name, kind, owner_user_id)
      values ('personal-' || r.id::text, left(r.nm, 40) || '''s Workspace', 'personal', r.id)
      on conflict (slug) do nothing;
      select id into v_org from public.organizations where slug = 'personal-' || r.id::text;
      if v_org is not null then
        insert into public.organization_members (organization_id, user_id)
        values (v_org, r.id) on conflict do nothing;
      end if;
    end loop;
    insert into public.schema_markers (key, note)
    values ('phase3_personal_workspaces', 'personal workspace created for pre-Phase-3 accounts');
  end if;
end $do$;

-- ---------- 3.8 Legacy owner mapping ----------
-- The pre-normalisation document identified people by a workspace key
-- ('vihan', 'richard', 'isuru', or 'email:someone@example.com') rather than an
-- auth uuid. The operator maps those to real accounts BEFORE running the
-- migration; anything unmapped migrates as UNASSIGNED (never silently handed
-- to the wrong person) and keeps its original key in tasks.legacy_owner.
--   insert into public.legacy_user_map (legacy_key, user_id)
--   values ('vihan', '<uuid>') on conflict (legacy_key) do update set user_id = excluded.user_id;
create table if not exists public.legacy_user_map (
  legacy_key text primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade
);
alter table public.legacy_user_map enable row level security;
drop policy if exists "legacy_user_map read (authenticated)" on public.legacy_user_map;
create policy "legacy_user_map read (authenticated)"
  on public.legacy_user_map for select to authenticated using (true);
grant select on public.legacy_user_map to authenticated;

-- Migration-internal only. It is SECURITY DEFINER and takes arbitrary text, so
-- leaving it callable would hand any signed-in user a probe for "is this string
-- a real account?". migrate_workspace_tasks is itself DEFINER and owned by the
-- same role, so it can still call this after the grants below.
create or replace function public.map_legacy_user(p_key text)
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid;
begin
  if p_key is null or p_key = '' then return null; end if;
  -- Post-Phase-1 records already carry the real profile uuid as the key.
  if p_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    select id into v from public.profiles where id = p_key::uuid;
    if v is not null then return v; end if;
  end if;
  select user_id into v from public.legacy_user_map where legacy_key = p_key;
  return v;
end $$;

-- Not callable from a client; the migration calls it as its owner.
revoke execute on function public.map_legacy_user(text) from public, anon, authenticated;

-- ---------- 3.9 Workspace document → normalized tasks ----------
-- Deterministic, idempotent, non-destructive, DRY-RUN BY DEFAULT.
--   select * from public.migrate_workspace_tasks(false);  -- report only
--   select * from public.migrate_workspace_tasks(true);   -- commit
-- The workspace document is never written to, so the legacy client keeps
-- working and rollback is "stop reading the new tables". Every insert is
-- `on conflict do nothing` keyed on the ORIGINAL id, so a partial run is
-- safely resumable and a second run is a no-op.
create or replace function public.migrate_workspace_tasks(p_commit boolean default false)
returns table (metric text, value bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_raw       jsonb;
  v_tasks     jsonb;
  v_task      jsonb;
  v_org       uuid := public.default_org_id();
  v_assignee  uuid;
  v_reporter  uuid;
  v_owner_key text;
  v_seq       int;
  v_item      jsonb;
  n_tasks     bigint := 0;
  n_existing  bigint := 0;
  n_unmapped  bigint := 0;
  n_check     bigint := 0;
  n_prog      bigint := 0;
  n_res       bigint := 0;
  n_comm      bigint := 0;
  n_act       bigint := 0;
begin
  if not public.authorize('admin.restore') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select w.tasks into v_raw from public.workspace w where w.id = 'main';
  -- v2 document { version, metadata, data:{ tasks: [...] } }; a bare array is
  -- the v1 legacy shape.
  if v_raw is null then
    v_tasks := '[]'::jsonb;
  elsif jsonb_typeof(v_raw) = 'array' then
    v_tasks := v_raw;
  else
    v_tasks := coalesce(v_raw #> '{data,tasks}', '[]'::jsonb);
  end if;
  if jsonb_typeof(v_tasks) <> 'array' then v_tasks := '[]'::jsonb; end if;

  for v_task in select * from jsonb_array_elements(v_tasks) loop
    -- Deliverables live in the same array tagged kind:'deliverable' — they are
    -- NOT tasks and stay in the document.
    continue when coalesce(v_task->>'kind', 'task') = 'deliverable';
    continue when coalesce(v_task->>'id', '') = '';

    n_tasks := n_tasks + 1;
    if exists (select 1 from public.tasks t where t.id = v_task->>'id') then
      n_existing := n_existing + 1;
      continue;
    end if;

    v_owner_key := v_task->>'ownerId';
    v_assignee  := public.map_legacy_user(v_owner_key);
    -- Reporter = whoever the activity feed records as having created it;
    -- falls back to the assignee (a task nobody else raised is your own).
    v_reporter := public.map_legacy_user((
      select a->>'userId' from jsonb_array_elements(coalesce(v_task->'activity', '[]'::jsonb)) a
       where a->>'type' = 'created' limit 1));
    if v_reporter is null then v_reporter := v_assignee; end if;
    if v_assignee is null then n_unmapped := n_unmapped + 1; end if;

    n_check := n_check + jsonb_array_length(coalesce(v_task->'checklist',   '[]'::jsonb));
    n_prog  := n_prog  + jsonb_array_length(coalesce(v_task->'progressLog', '[]'::jsonb));
    n_res   := n_res   + jsonb_array_length(coalesce(v_task->'resources',   '[]'::jsonb));
    n_comm  := n_comm  + jsonb_array_length(coalesce(v_task->'comments',    '[]'::jsonb));
    n_act   := n_act   + jsonb_array_length(coalesce(v_task->'activity',    '[]'::jsonb));

    continue when not p_commit;

    insert into public.tasks (
      id, organization_id, title, description, reporter_id, assignee_id,
      status, priority, category, effort, progress, due_date, completed_at,
      deliverable_id, success_criteria, risk, dependencies, dep_task_ids, edits,
      created_at, updated_at, created_by, updated_by, legacy_owner)
    values (
      v_task->>'id', v_org,
      coalesce(nullif(v_task->>'title', ''), '(untitled)'), v_task->>'description',
      v_reporter, v_assignee,
      coalesce(nullif(v_task->>'status', ''),   'Not Started'),
      coalesce(nullif(v_task->>'priority', ''), 'Medium'),
      v_task->>'category', v_task->>'effort',
      coalesce((v_task->>'progress')::int, 0),
      nullif(v_task->>'dueDate', '')::timestamptz,
      nullif(v_task->>'completedAt', '')::timestamptz,
      v_task->>'deliverableId', v_task->>'successCriteria', v_task->>'risk',
      coalesce(v_task->'dependencies', '[]'::jsonb),
      coalesce(v_task->'depTaskIds',   '[]'::jsonb),
      coalesce(v_task->'edits',        '[]'::jsonb),
      coalesce(nullif(v_task->>'createdAt', '')::timestamptz, now()),
      coalesce(nullif(v_task->>'updatedAt', '')::timestamptz, now()),
      v_reporter, v_reporter,
      case when v_assignee is null then v_owner_key else null end);

    insert into public.task_checklist_items (id, task_id, title, note, done, links, files,
                                             completed_at, completed_by, completed_in_log_id, sort_order)
    select c->>'id', v_task->>'id', coalesce(c->>'title', ''), c->>'note',
           coalesce((c->>'done')::boolean, false),
           coalesce(c->'links', '[]'::jsonb), coalesce(c->'files', '[]'::jsonb),
           nullif(c->>'completedAt', '')::timestamptz,
           public.map_legacy_user(c->>'completedBy'), c->>'completedInLogId', ord::int
      from jsonb_array_elements(coalesce(v_task->'checklist', '[]'::jsonb)) with ordinality as x(c, ord)
     where coalesce(c->>'id', '') <> ''
    on conflict (id) do nothing;

    insert into public.task_progress (id, task_id, percent, status, note, links, files,
                                      checklist_ids, user_id, at, edited_at)
    select p->>'id', v_task->>'id', coalesce((p->>'percent')::int, 0), p->>'status', p->>'note',
           coalesce(p->'links', '[]'::jsonb), coalesce(p->'files', '[]'::jsonb),
           coalesce(p->'checklistIds', '[]'::jsonb),
           public.map_legacy_user(p->>'userId'),
           coalesce(nullif(p->>'at', '')::timestamptz, now()),
           nullif(p->>'editedAt', '')::timestamptz
      from jsonb_array_elements(coalesce(v_task->'progressLog', '[]'::jsonb)) p
     where coalesce(p->>'id', '') <> ''
    on conflict (id) do nothing;

    insert into public.task_resources (id, task_id, kind, title, url, note)
    select r->>'id', v_task->>'id', coalesce(r->>'kind', 'link'), r->>'title', r->>'url', r->>'note'
      from jsonb_array_elements(coalesce(v_task->'resources', '[]'::jsonb)) r
     where coalesce(r->>'id', '') <> ''
    on conflict (id) do nothing;

    insert into public.task_comments (id, task_id, user_id, body, created_at)
    select k->>'id', v_task->>'id', public.map_legacy_user(k->>'userId'),
           coalesce(k->>'comment', k->>'body', ''),
           coalesce(nullif(k->>'createdAt', '')::timestamptz, now())
      from jsonb_array_elements(coalesce(v_task->'comments', '[]'::jsonb)) k
     where coalesce(k->>'id', '') <> ''
    on conflict (id) do nothing;

    v_seq := 0;
    for v_item in select * from jsonb_array_elements(coalesce(v_task->'activity', '[]'::jsonb)) loop
      insert into public.task_activity (task_id, seq, type, user_id, at, detail)
      values (v_task->>'id', v_seq, coalesce(v_item->>'type', 'edit'),
              public.map_legacy_user(v_item->>'userId'),
              coalesce(nullif(v_item->>'at', '')::timestamptz, now()),
              v_item->>'detail')
      on conflict do nothing;
      v_seq := v_seq + 1;
    end loop;
  end loop;

  return query
    select 'committed'::text,          case when p_commit then 1 else 0 end::bigint
    union all select 'document_tasks',  n_tasks
    union all select 'already_present', n_existing
    union all select 'tasks_written',   case when p_commit then n_tasks - n_existing else 0 end
    union all select 'unmapped_owners', n_unmapped
    union all select 'checklist_items', n_check
    union all select 'progress_entries', n_prog
    union all select 'resources',       n_res
    union all select 'comments',        n_comm
    union all select 'activity_entries', n_act;
end $$;

revoke execute on function public.migrate_workspace_tasks(boolean) from public, anon;
grant  execute on function public.migrate_workspace_tasks(boolean) to authenticated;

-- Post-migration verification: for every task IN THE DOCUMENT, does the
-- normalized side hold the same thing? Counts are scoped to the document's own
-- ids on both sides, so the check stays meaningful forever — tasks created
-- natively after the migration are new work, not a missing migration.
--   select * from public.verify_task_migration();
-- Green = `matches` is true on every row and unmapped_owners is a number the
-- operator accepts (each one is a task whose legacy owner key had no account).
create or replace function public.verify_task_migration()
returns table (metric text, in_document bigint, in_tables bigint, matches boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_raw   jsonb;
  v_tasks jsonb;
begin
  if not public.authorize('admin.audit_log') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select w.tasks into v_raw from public.workspace w where w.id = 'main';
  if v_raw is null then v_tasks := '[]'::jsonb;
  elsif jsonb_typeof(v_raw) = 'array' then v_tasks := v_raw;
  else v_tasks := coalesce(v_raw #> '{data,tasks}', '[]'::jsonb); end if;

  return query
  with doc as (
    select t from jsonb_array_elements(v_tasks) t
     where coalesce(t->>'kind', 'task') <> 'deliverable' and coalesce(t->>'id', '') <> ''
  ), ids as (
    select t->>'id' as id from doc
  ), d as (
    select
      count(*)                                                                     as tasks,
      coalesce(sum(jsonb_array_length(coalesce(t->'checklist',   '[]'::jsonb))), 0) as checklist,
      coalesce(sum(jsonb_array_length(coalesce(t->'progressLog', '[]'::jsonb))), 0) as progress,
      coalesce(sum(jsonb_array_length(coalesce(t->'resources',   '[]'::jsonb))), 0) as resources,
      coalesce(sum(jsonb_array_length(coalesce(t->'comments',    '[]'::jsonb))), 0) as comments,
      coalesce(sum(jsonb_array_length(coalesce(t->'activity',    '[]'::jsonb))), 0) as activity
      from doc
  ), m as (
    select
      (select count(*) from public.tasks                where id      in (select id from ids)) as tasks,
      (select count(*) from public.task_checklist_items where task_id in (select id from ids)) as checklist,
      (select count(*) from public.task_progress        where task_id in (select id from ids)) as progress,
      (select count(*) from public.task_resources       where task_id in (select id from ids)) as resources,
      (select count(*) from public.task_comments        where task_id in (select id from ids)) as comments,
      (select count(*) from public.task_activity        where task_id in (select id from ids)) as activity,
      (select count(*) from public.tasks where id in (select id from ids) and assignee_id is null) as unmapped
  )
  select 'tasks',            d.tasks,     m.tasks,     d.tasks     = m.tasks     from d, m
  union all
  select 'ids_preserved',    d.tasks,     m.tasks,     d.tasks     = m.tasks     from d, m
  union all
  select 'checklist_items',  d.checklist, m.checklist, d.checklist = m.checklist from d, m
  union all
  select 'progress_entries', d.progress,  m.progress,  d.progress  = m.progress  from d, m
  union all
  select 'resources',        d.resources, m.resources, d.resources = m.resources from d, m
  union all
  select 'comments',         d.comments,  m.comments,  d.comments  = m.comments  from d, m
  union all
  select 'activity_entries', d.activity,  m.activity,  d.activity  = m.activity  from d, m
  union all
  -- Informational, not a failure on its own: tasks whose legacy owner key had
  -- no mapped account. They migrate UNASSIGNED and surface in the management
  -- "Unassigned" widget for someone to pick up.
  select 'unmapped_owners',  0::bigint,   m.unmapped,  true                      from m;
end $$;

revoke execute on function public.verify_task_migration() from public, anon;
grant  execute on function public.verify_task_migration() to authenticated;

-- ---------- 3.10 Closing the legacy read paths ----------
-- Normalising tasks is only half the privacy story: the OLD copies are still
-- reachable. Two of them, both closed here.
--
-- (a) The workspace document. Its SELECT policy was `using (true)` — any
--     signed-in user could read the whole blob, tasks included. The document's
--     remaining purpose is organization-wide governance content (deliverables,
--     weekly plans, KPI scores), so its gate is now the capability that
--     governs exactly that content. A personal-workspace Member holds none of
--     it and therefore cannot read the document at all — which is what stops
--     them reading everybody's tasks out of the legacy copy.
--     Writing additionally still needs tasks.execute, unchanged for every
--     delivery role, so the pre-migration client keeps working: you may write
--     the document only if you can see the document.
drop policy if exists "workspace read (authenticated)" on public.workspace;
drop policy if exists "workspace read (document scope)" on public.workspace;
create policy "workspace read (document scope)"
  on public.workspace for select to authenticated
  using (
    public.authorize('deliverables.read')
    -- …AND the document must not still be carrying task data. deliverables.read
    -- is the right gate for the document's REMAINING content (deliverables,
    -- weekly plans, KPI); it is the wrong gate for tasks, and a Business
    -- Analyst holding it would otherwise read everybody's tasks straight out
    -- of the legacy blob while the normalized tables correctly refuse them.
    --
    -- So the rule is about what the row CONTAINS, not just who is asking:
    -- while task payload is present the whole document is management-only.
    -- Running archive_workspace_tasks() (§3.11) empties it and restores normal
    -- access for everyone — which is why that step belongs immediately after
    -- migration verification in the runbook, not "some time later".
    and (
      public.authorize('tasks.view_all')
      or jsonb_array_length(coalesce(tasks #> '{data,tasks}', '[]'::jsonb)) = 0
    )
  );

drop policy if exists "workspace write (role)" on public.workspace;
create policy "workspace write (role)"
  on public.workspace for update to authenticated
  using (public.authorize('deliverables.read') and public.authorize('tasks.execute'))
  with check (public.authorize('deliverables.read') and public.authorize('tasks.execute'));

-- (b) Task attachments in Storage. The bucket was readable by every signed-in
--     user, so progress-log evidence for someone else's task was one path
--     guess (or one list call) away. Attachment paths start with the task id
--     ("T-142/<entry>/<file>"), so access can follow the task itself.
--
--     SECURITY DEFINER so the "does this task exist?" probe is not itself
--     filtered by RLS — otherwise a task the caller may NOT read would look
--     like a task that does not exist and fall through to the legacy branch.
--     That legacy branch is what keeps PRE-MIGRATION attachments reachable:
--     until a task has a row, its files follow the document's own gate.
create or replace function public.attachment_task_id(p_name text)
returns text language sql immutable set search_path = '' as $$ select split_part(p_name, '/', 1) $$;

-- The legacy branch below applies ONLY before the migration has run. Once any
-- task row exists, an attachment whose path names no known task is an orphan,
-- and an orphan must not be a way around the task rules: it needs management
-- scope. Otherwise a role holding deliverables.read could read attachments by
-- guessing a path that happens not to resolve — the exact class of hole this
-- correction round is closing on the workspace document.
create or replace function public.attachment_readable(p_name text)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_task text := public.attachment_task_id(p_name);
begin
  if exists (select 1 from public.tasks where id = v_task) then
    return public.parent_task_readable(v_task);
  end if;
  if exists (select 1 from public.tasks) then          -- migration has run
    return public.authorize('tasks.view_all');
  end if;
  return public.authorize('deliverables.read');        -- pre-migration only
end $$;

create or replace function public.attachment_writable(p_name text)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_task text := public.attachment_task_id(p_name);
begin
  if exists (select 1 from public.tasks where id = v_task) then
    return public.parent_task_writable(v_task);
  end if;
  if exists (select 1 from public.tasks) then
    return public.authorize('tasks.view_all') and public.authorize('tasks.execute');
  end if;
  return public.authorize('deliverables.read') and public.authorize('tasks.execute');
end $$;

-- Storage-policy helpers remain callable by signed-in requests, but never by
-- anonymous callers or through PostgreSQL's implicit PUBLIC function grant.
revoke execute on function public.attachment_readable(text) from public, anon;
revoke execute on function public.attachment_writable(text) from public, anon;
grant execute on function public.attachment_readable(text) to authenticated;
grant execute on function public.attachment_writable(text) to authenticated;

drop policy if exists "task-attachments read (authenticated)" on storage.objects;
drop policy if exists "task-attachments read (task scope)" on storage.objects;
create policy "task-attachments read (task scope)"
  on storage.objects for select to authenticated
  using (bucket_id = 'task-attachments' and public.attachment_readable(name));

drop policy if exists "task-attachments write (role)" on storage.objects;
create policy "task-attachments write (role)"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'task-attachments' and public.attachment_writable(name));

drop policy if exists "task-attachments update (role)" on storage.objects;
create policy "task-attachments update (role)"
  on storage.objects for update to authenticated
  using (bucket_id = 'task-attachments' and public.attachment_writable(name));

drop policy if exists "task-attachments delete (role)" on storage.objects;
create policy "task-attachments delete (role)"
  on storage.objects for delete to authenticated
  using (bucket_id = 'task-attachments' and public.attachment_writable(name));

-- (c) The audit log. Its SELECT policy was `using (true)` from Phase 1, when it
--     only held role changes. Phase 3 started writing task events into it —
--     task_created carries the title, task_status_changed carries the
--     transition — so an unscoped audit log became a complete index of
--     everybody's work, readable by anyone signed in. Same invariant, so the
--     same rule: a row ABOUT A TASK is visible exactly when the task is.
--     Everything else is your own actions, or requires the audit capability.
drop policy if exists "activity read (authenticated)" on public.activity_log;
drop policy if exists "activity read (scoped)" on public.activity_log;
create policy "activity read (scoped)"
  on public.activity_log for select to authenticated
  using (
    case
      when entity_type = 'task' then public.parent_task_readable(entity_id)
      else user_id = auth.uid() or public.authorize('admin.audit_log')
    end
  );

-- (d) public.comments — the generic Phase-1 comment table. It is UNUSED (task
--     comments live in public.task_comments, §3.2) and therefore empty, but it
--     is keyed by (entity_type, entity_id) and was readable with `using (true)`.
--     An empty table is not a security argument: if anything ever writes a
--     task comment there it must not become the way around the task rules.
drop policy if exists "comments read (authenticated)" on public.comments;
drop policy if exists "comments read (scoped)" on public.comments;
create policy "comments read (scoped)"
  on public.comments for select to authenticated
  using (
    case when entity_type = 'task' then public.parent_task_readable(entity_id)
         else public.authorize('comments.read') end
  );

--     Writing needs the same treatment, and the test suite caught that it did
--     not have it: the insert policy only checked "is this comment yours" and
--     "may you comment", so a standard user could attach a row to ANOTHER
--     person's task id. Unreadable to them afterwards, but still a write into
--     someone else's stream — the same hole from the other side.
drop policy if exists "comments insert (non-viewer)" on public.comments;
drop policy if exists "comments insert (scoped)" on public.comments;
create policy "comments insert (scoped)"
  on public.comments for insert to authenticated
  with check (
    auth.uid() = user_id
    and public.authorize('comments.write')
    and (entity_type <> 'task' or public.parent_task_writable(entity_id))
  );

-- (e) legacy_user_map — the migration's legacy-key → account table. No client
--     reads it (only migrate_workspace_tasks does, as its owner), and letting
--     anyone read it would hand a public self-registered account a partial
--     staff directory. Policy removed entirely: RLS on, no policy, no access.
drop policy if exists "legacy_user_map read (authenticated)" on public.legacy_user_map;
revoke all on public.legacy_user_map from anon, authenticated;

-- ---------- 3.11 Retiring the document's task copy (archive, not delete) ----
-- After migration the document still holds a full copy of every task. That
-- copy is the rollback source, so it is not deleted — but it must not sit in
-- the shared document either, because the document is read by roles that have
-- no business seeing other people's tasks (§3.10a makes such a document
-- management-only, which is safe but takes Deliverables/Weekly/KPI away from
-- everyone else until this runs).
--
-- So: MOVE it. The payload goes to an administrator-only archive table and the
-- shared document's task array is emptied. Rollback stays possible in two
-- independent ways — the operator's export, and restore_workspace_tasks() —
-- while ordinary workspace reads stop carrying anybody's tasks.
--
-- Explicit, separately invoked, dry-run by default, owner-gated, and it
-- REFUSES to run unless verify_task_migration() is green. Never automatic and
-- never called by any client.
create table if not exists public.workspace_task_archive (
  id           bigserial primary key,
  workspace_id text not null,
  archived_at  timestamptz not null default now(),
  archived_by  uuid references auth.users(id) on delete set null,
  task_count   int not null,
  payload      jsonb not null
);

alter table public.workspace_task_archive enable row level security;
-- No policy for `authenticated` AT ALL: the archive is reachable only through
-- the SECURITY DEFINER functions below, both of which authorize first. A
-- table with RLS enabled and no policy denies everyone, which is the point.
revoke all on public.workspace_task_archive from anon, authenticated;

create or replace function public.archive_workspace_tasks(p_commit boolean default false)
returns text language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_bad   int;
  v_tasks jsonb;
  v_n     int;
begin
  if not public.authorize('admin.restore') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select count(*) into v_bad from public.verify_task_migration()
   where not matches and metric <> 'unmapped_owners';
  if v_bad > 0 then
    raise exception 'migration verification is not green (% mismatching metric(s)) — refusing to archive', v_bad;
  end if;

  select coalesce(w.tasks #> '{data,tasks}', '[]'::jsonb) into v_tasks
    from public.workspace w where w.id = 'main';
  v_n := jsonb_array_length(coalesce(v_tasks, '[]'::jsonb));

  if not p_commit then
    return format('dry run: would archive %s task entries out of the workspace document', v_n);
  end if;

  insert into public.workspace_task_archive (workspace_id, archived_by, task_count, payload)
  values ('main', auth.uid(), v_n, v_tasks);

  update public.workspace
     set tasks = jsonb_set(tasks, '{data,tasks}', '[]'::jsonb),
         updated_at = now()
   where id = 'main';

  insert into public.activity_log (user_id, action, entity_type, entity_id, meta)
  values (auth.uid(), 'workspace_tasks_archived', 'workspace', 'main',
          jsonb_build_object('task_count', v_n));

  return format('archived %s task entries; the shared document no longer carries task data', v_n);
end $fn$;

revoke execute on function public.archive_workspace_tasks(boolean) from public, anon;
grant  execute on function public.archive_workspace_tasks(boolean) to authenticated;

-- The rollback half. Puts the most recent archived payload back into the
-- document, so "stop reading the new tables" remains a complete rollback even
-- after archiving. Owner-gated and dry-run by default, like its counterpart.
create or replace function public.restore_workspace_tasks(p_commit boolean default false)
returns text language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_row public.workspace_task_archive%rowtype;
begin
  if not public.authorize('admin.restore') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select * into v_row from public.workspace_task_archive
   where workspace_id = 'main' order by archived_at desc, id desc limit 1;
  if v_row.id is null then
    return 'nothing archived for workspace main — nothing to restore';
  end if;

  if not p_commit then
    return format('dry run: would restore %s task entries archived at %s',
                  v_row.task_count, v_row.archived_at);
  end if;

  update public.workspace
     set tasks = jsonb_set(tasks, '{data,tasks}', v_row.payload),
         updated_at = now()
   where id = 'main';

  insert into public.activity_log (user_id, action, entity_type, entity_id, meta)
  values (auth.uid(), 'workspace_tasks_restored', 'workspace', 'main',
          jsonb_build_object('task_count', v_row.task_count, 'archived_at', v_row.archived_at));

  return format('restored %s task entries into the workspace document', v_row.task_count);
end $fn$;

revoke execute on function public.restore_workspace_tasks(boolean) from public, anon;
grant  execute on function public.restore_workspace_tasks(boolean) to authenticated;

-- ---------- 3.12 Realtime ----------
-- RLS applies to realtime, so a standard user's subscription only ever yields
-- rows they may read — no client is subscribed to an organization-wide stream.
do $$ begin alter publication supabase_realtime add table public.tasks;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.task_checklist_items;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.task_progress;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.task_comments;
exception when duplicate_object then null; end $$;
