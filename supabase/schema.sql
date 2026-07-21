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
returns text language sql stable as $$
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
returns trigger language plpgsql as $$
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
returns trigger language plpgsql as $$
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
returns jsonb language plpgsql stable as $$
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
  'tasks.read', 'tasks.execute', 'tasks.assign', 'tasks.prioritize', 'tasks.delete',
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
insert into public.template_permissions (template_slug, permission_key)
select t.slug, p.key
  from public.role_templates t
  cross join (values ('tasks.read'), ('deliverables.read'), ('weekly.read'),
                     ('kpi.read'), ('reports.read'), ('comments.read'), ('users.read')) as p(key)
 where t.slug <> 'everything';

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

-- ---------- 2.7 Guardrails + audit ----------
-- Owner grants are immutable: nothing can be revoked from 'owner', so an
-- owner can never lock themselves (and everyone else) out of administration.
create or replace function public.forbid_owner_revoke()
returns trigger language plpgsql as $$
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
returns trigger language plpgsql as $$
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
returns trigger language plpgsql as $$
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
