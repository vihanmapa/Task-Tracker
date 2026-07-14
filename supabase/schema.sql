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
