-- Baseline: the complete `public` schema (tables, functions, triggers, RLS
-- policies, grants) exactly as dumped from the live Tasks Tracker project on
-- 2026-09-30 with `supabase db dump --linked --schema public`.
--
-- Generated file -- do not hand-edit. Later schema changes go in NEW migration
-- files. Objects outside `public` (auth trigger, Storage bucket + policies,
-- Realtime publication) are in 20260930000100_baseline_platform.sql; reference
-- rows the app cannot boot without are in 20260930000200_baseline_reference_data.sql.
-- See docs/SECOND-BACKEND-SETUP.md.




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."app_role" AS ENUM (
    'owner',
    'product_manager',
    'investor',
    'business_analyst',
    'tech_lead',
    'developer',
    'qa',
    'viewer'
);


ALTER TYPE "public"."app_role" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."add_organization_member"("p_org" "uuid", "p_user" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
end $$;


ALTER FUNCTION "public"."add_organization_member"("p_org" "uuid", "p_user" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."archive_workspace_tasks"("p_commit" boolean DEFAULT false) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
end $$;


ALTER FUNCTION "public"."archive_workspace_tasks"("p_commit" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."attachment_readable"("p_name" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."attachment_readable"("p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."attachment_task_id"("p_name" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$ select split_part(p_name, '/', 1) $$;


ALTER FUNCTION "public"."attachment_task_id"("p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."attachment_writable"("p_name" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."attachment_writable"("p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."authorize"("requested_permission" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.role_permissions rp
    where rp.permission_key = requested_permission
      and rp.role_slug = public.jwt_role()
  );
$$;


ALTER FUNCTION "public"."authorize"("requested_permission" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."custom_access_token_hook"("event" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."custom_access_token_hook"("event" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."default_org_id"() RETURNS "uuid"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
  select '00000000-0000-0000-0000-000000000001'::uuid
$$;


ALTER FUNCTION "public"."default_org_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."forbid_owner_revoke"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if old.role_slug = 'owner' then
    raise exception 'the owner role''s permissions are immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;


ALTER FUNCTION "public"."forbid_owner_revoke"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
end $$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_org_member"("p_org" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1 from public.organization_members m
     where m.organization_id = p_org and m.user_id = auth.uid()
  )
$$;


ALTER FUNCTION "public"."is_org_member"("p_org" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."jwt_role"() RETURNS "text"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'user_role',
    'viewer'
  )
$$;


ALTER FUNCTION "public"."jwt_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_permission_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."log_permission_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_profile_admin_action"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."log_profile_admin_action"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_task_event"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."log_task_event"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."map_legacy_user"("p_key" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
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
end $_$;


ALTER FUNCTION "public"."map_legacy_user"("p_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."migrate_workspace_tasks"("p_commit" boolean DEFAULT false) RETURNS TABLE("metric" "text", "value" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."migrate_workspace_tasks"("p_commit" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."parent_task_readable"("p_task" "text") RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from public.tasks t
     where t.id = p_task
       and public.task_read_ok(t.organization_id, t.assignee_id)
  )
$$;


ALTER FUNCTION "public"."parent_task_readable"("p_task" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."parent_task_writable"("p_task" "text") RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from public.tasks t
     where t.id = p_task
       and public.task_write_ok(t.organization_id, t.assignee_id)
  )
$$;


ALTER FUNCTION "public"."parent_task_writable"("p_task" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_last_owner_delete"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if old.role = 'owner' and old.status = 'active'
     and (select count(*) from public.profiles
            where role = 'owner' and status = 'active' and id <> old.id) = 0 then
    raise exception 'cannot delete the last active owner';
  end if;
  return old;
end $$;


ALTER FUNCTION "public"."protect_last_owner_delete"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_profile_privileges"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."protect_profile_privileges"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_system_roles"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."protect_system_roles"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_task_governance"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."protect_task_governance"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_organization_member"("p_org" "uuid", "p_user" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
end $$;


ALTER FUNCTION "public"."remove_organization_member"("p_org" "uuid", "p_user" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reset_role_to_template"("p_role" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."reset_role_to_template"("p_role" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."restore_workspace_tasks"("p_commit" boolean DEFAULT false) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
end $$;


ALTER FUNCTION "public"."restore_workspace_tasks"("p_commit" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."shares_org_with"("p_user" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1 from public.organization_members a
      join public.organization_members b on b.organization_id = a.organization_id
     where a.user_id = auth.uid() and b.user_id = p_user
  )
$$;


ALTER FUNCTION "public"."shares_org_with"("p_user" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."task_read_ok"("p_org" "uuid", "p_assignee" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select public.is_org_member(p_org)
     and public.authorize('tasks.read')
     and (p_assignee = auth.uid() or public.authorize('tasks.view_all'))
$$;


ALTER FUNCTION "public"."task_read_ok"("p_org" "uuid", "p_assignee" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."task_write_ok"("p_org" "uuid", "p_assignee" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select public.is_org_member(p_org)
     and public.authorize('tasks.execute')
     and (p_assignee = auth.uid() or public.authorize('tasks.view_all'))
$$;


ALTER FUNCTION "public"."task_write_ok"("p_org" "uuid", "p_assignee" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verify_task_migration"() RETURNS TABLE("metric" "text", "in_document" bigint, "in_tables" bigint, "matches" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."verify_task_migration"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."activity_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "action" "text" NOT NULL,
    "entity_type" "text",
    "entity_id" "text",
    "meta" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."activity_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."comments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "parent_comment_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."legacy_user_map" (
    "legacy_key" "text" NOT NULL,
    "user_id" "uuid" NOT NULL
);


ALTER TABLE "public"."legacy_user_map" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organization_members" (
    "organization_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."organization_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "kind" "text" DEFAULT 'team'::"text" NOT NULL,
    "owner_user_id" "uuid",
    CONSTRAINT "organizations_kind_check" CHECK (("kind" = ANY (ARRAY['team'::"text", 'personal'::"text"])))
);


ALTER TABLE "public"."organizations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."permissions" (
    "key" "text" NOT NULL,
    "grp" "text" NOT NULL,
    "layer" "text" NOT NULL,
    "label" "text" NOT NULL,
    "description" "text",
    "sort_order" integer DEFAULT 100 NOT NULL,
    "enforced" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."private_resources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "parent_id" "text" NOT NULL,
    "kind" "text" DEFAULT 'link'::"text" NOT NULL,
    "title" "text" DEFAULT ''::"text",
    "url" "text" DEFAULT ''::"text",
    "note" "text" DEFAULT ''::"text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "parent_type" "text" DEFAULT 'deliverable'::"text" NOT NULL
);


ALTER TABLE "public"."private_resources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text",
    "name" "text",
    "avatar_url" "text",
    "role" "text" DEFAULT 'viewer'::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_title" "text"
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."role_permissions" (
    "role_slug" "text" NOT NULL,
    "permission_key" "text" NOT NULL,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."role_permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."role_templates" (
    "slug" "text" NOT NULL,
    "label" "text" NOT NULL
);


ALTER TABLE "public"."role_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."roles" (
    "slug" "text" NOT NULL,
    "label" "text" NOT NULL,
    "description" "text",
    "template_slug" "text" NOT NULL,
    "is_system" boolean DEFAULT false NOT NULL,
    "sort_order" integer DEFAULT 100 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."roles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."schema_markers" (
    "key" "text" NOT NULL,
    "applied_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "note" "text"
);


ALTER TABLE "public"."schema_markers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_activity" (
    "task_id" "text" NOT NULL,
    "seq" integer NOT NULL,
    "type" "text" NOT NULL,
    "user_id" "uuid",
    "at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "detail" "text"
);


ALTER TABLE "public"."task_activity" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_checklist_items" (
    "id" "text" NOT NULL,
    "task_id" "text" NOT NULL,
    "title" "text" NOT NULL,
    "note" "text",
    "done" boolean DEFAULT false NOT NULL,
    "links" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "files" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "completed_at" timestamp with time zone,
    "completed_by" "uuid",
    "completed_in_log_id" "text",
    "sort_order" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."task_checklist_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_comments" (
    "id" "text" NOT NULL,
    "task_id" "text" NOT NULL,
    "user_id" "uuid",
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."task_comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_progress" (
    "id" "text" NOT NULL,
    "task_id" "text" NOT NULL,
    "percent" integer DEFAULT 0 NOT NULL,
    "status" "text",
    "note" "text",
    "links" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "files" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "checklist_ids" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "user_id" "uuid",
    "at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "edited_at" timestamp with time zone
);


ALTER TABLE "public"."task_progress" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_resources" (
    "id" "text" NOT NULL,
    "task_id" "text" NOT NULL,
    "kind" "text" DEFAULT 'link'::"text" NOT NULL,
    "title" "text",
    "url" "text",
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."task_resources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tasks" (
    "id" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "reporter_id" "uuid",
    "assignee_id" "uuid",
    "status" "text" DEFAULT 'Not Started'::"text" NOT NULL,
    "priority" "text" DEFAULT 'Medium'::"text" NOT NULL,
    "category" "text",
    "effort" "text",
    "progress" integer DEFAULT 0 NOT NULL,
    "due_date" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "deliverable_id" "text",
    "success_criteria" "text",
    "risk" "text",
    "dependencies" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "dep_task_ids" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "edits" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_by" "uuid",
    "legacy_owner" "text"
);


ALTER TABLE "public"."tasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."template_permissions" (
    "template_slug" "text" NOT NULL,
    "permission_key" "text" NOT NULL
);


ALTER TABLE "public"."template_permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workspace" (
    "id" "text" DEFAULT 'main'::"text" NOT NULL,
    "tasks" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "text"
);


ALTER TABLE "public"."workspace" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workspace_task_archive" (
    "id" bigint NOT NULL,
    "workspace_id" "text" NOT NULL,
    "archived_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_by" "uuid",
    "task_count" integer NOT NULL,
    "payload" "jsonb" NOT NULL
);


ALTER TABLE "public"."workspace_task_archive" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."workspace_task_archive_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."workspace_task_archive_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."workspace_task_archive_id_seq" OWNED BY "public"."workspace_task_archive"."id";



ALTER TABLE ONLY "public"."workspace_task_archive" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."workspace_task_archive_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."activity_log"
    ADD CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."legacy_user_map"
    ADD CONSTRAINT "legacy_user_map_pkey" PRIMARY KEY ("legacy_key");



ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_pkey" PRIMARY KEY ("organization_id", "user_id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."private_resources"
    ADD CONSTRAINT "private_resources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_slug", "permission_key");



ALTER TABLE ONLY "public"."role_templates"
    ADD CONSTRAINT "role_templates_pkey" PRIMARY KEY ("slug");



ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_pkey" PRIMARY KEY ("slug");



ALTER TABLE ONLY "public"."schema_markers"
    ADD CONSTRAINT "schema_markers_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."task_activity"
    ADD CONSTRAINT "task_activity_pkey" PRIMARY KEY ("task_id", "seq");



ALTER TABLE ONLY "public"."task_checklist_items"
    ADD CONSTRAINT "task_checklist_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_comments"
    ADD CONSTRAINT "task_comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_progress"
    ADD CONSTRAINT "task_progress_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_resources"
    ADD CONSTRAINT "task_resources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."template_permissions"
    ADD CONSTRAINT "template_permissions_pkey" PRIMARY KEY ("template_slug", "permission_key");



ALTER TABLE ONLY "public"."workspace"
    ADD CONSTRAINT "workspace_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workspace_task_archive"
    ADD CONSTRAINT "workspace_task_archive_pkey" PRIMARY KEY ("id");



CREATE INDEX "activity_log_recent" ON "public"."activity_log" USING "btree" ("created_at" DESC);



CREATE INDEX "comments_entity" ON "public"."comments" USING "btree" ("entity_type", "entity_id", "created_at");



CREATE INDEX "organization_members_user" ON "public"."organization_members" USING "btree" ("user_id");



CREATE UNIQUE INDEX "organizations_one_personal_per_user" ON "public"."organizations" USING "btree" ("owner_user_id") WHERE ("kind" = 'personal'::"text");



CREATE INDEX "private_resources_owner_deliverable" ON "public"."private_resources" USING "btree" ("user_id", "parent_id");



CREATE INDEX "private_resources_owner_parent" ON "public"."private_resources" USING "btree" ("user_id", "parent_type", "parent_id");



CREATE INDEX "task_checklist_task" ON "public"."task_checklist_items" USING "btree" ("task_id", "sort_order");



CREATE INDEX "task_comments_task" ON "public"."task_comments" USING "btree" ("task_id", "created_at");



CREATE INDEX "task_progress_task" ON "public"."task_progress" USING "btree" ("task_id", "at");



CREATE INDEX "task_resources_task" ON "public"."task_resources" USING "btree" ("task_id");



CREATE INDEX "tasks_assignee" ON "public"."tasks" USING "btree" ("organization_id", "assignee_id");



CREATE INDEX "tasks_due" ON "public"."tasks" USING "btree" ("organization_id", "due_date");



CREATE INDEX "tasks_org" ON "public"."tasks" USING "btree" ("organization_id");



CREATE INDEX "tasks_reporter" ON "public"."tasks" USING "btree" ("organization_id", "reporter_id");



CREATE INDEX "tasks_status" ON "public"."tasks" USING "btree" ("organization_id", "status");



CREATE OR REPLACE TRIGGER "log_permission_change" AFTER INSERT OR DELETE ON "public"."role_permissions" FOR EACH ROW EXECUTE FUNCTION "public"."log_permission_change"();



CREATE OR REPLACE TRIGGER "log_profile_admin_action" AFTER INSERT OR UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."log_profile_admin_action"();



CREATE OR REPLACE TRIGGER "log_task_event" AFTER INSERT OR UPDATE ON "public"."tasks" FOR EACH ROW EXECUTE FUNCTION "public"."log_task_event"();



CREATE OR REPLACE TRIGGER "protect_last_owner_delete" BEFORE DELETE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."protect_last_owner_delete"();



CREATE OR REPLACE TRIGGER "protect_owner_grants" BEFORE DELETE OR UPDATE ON "public"."role_permissions" FOR EACH ROW EXECUTE FUNCTION "public"."forbid_owner_revoke"();



CREATE OR REPLACE TRIGGER "protect_profile_privileges" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."protect_profile_privileges"();



CREATE OR REPLACE TRIGGER "protect_system_roles" BEFORE DELETE OR UPDATE ON "public"."roles" FOR EACH ROW EXECUTE FUNCTION "public"."protect_system_roles"();



CREATE OR REPLACE TRIGGER "protect_task_governance" BEFORE INSERT OR UPDATE ON "public"."tasks" FOR EACH ROW EXECUTE FUNCTION "public"."protect_task_governance"();



ALTER TABLE ONLY "public"."activity_log"
    ADD CONSTRAINT "activity_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_parent_comment_id_fkey" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."comments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."legacy_user_map"
    ADD CONSTRAINT "legacy_user_map_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."private_resources"
    ADD CONSTRAINT "private_resources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_role_fkey" FOREIGN KEY ("role") REFERENCES "public"."roles"("slug");



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_role_slug_fkey" FOREIGN KEY ("role_slug") REFERENCES "public"."roles"("slug") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_template_slug_fkey" FOREIGN KEY ("template_slug") REFERENCES "public"."role_templates"("slug");



ALTER TABLE ONLY "public"."task_activity"
    ADD CONSTRAINT "task_activity_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_activity"
    ADD CONSTRAINT "task_activity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."task_checklist_items"
    ADD CONSTRAINT "task_checklist_items_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."task_checklist_items"
    ADD CONSTRAINT "task_checklist_items_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_comments"
    ADD CONSTRAINT "task_comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_comments"
    ADD CONSTRAINT "task_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."task_progress"
    ADD CONSTRAINT "task_progress_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_progress"
    ADD CONSTRAINT "task_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."task_resources"
    ADD CONSTRAINT "task_resources_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."template_permissions"
    ADD CONSTRAINT "template_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."template_permissions"
    ADD CONSTRAINT "template_permissions_template_slug_fkey" FOREIGN KEY ("template_slug") REFERENCES "public"."role_templates"("slug") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspace_task_archive"
    ADD CONSTRAINT "workspace_task_archive_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



CREATE POLICY "activity insert (self)" ON "public"."activity_log" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "activity read (scoped)" ON "public"."activity_log" FOR SELECT TO "authenticated" USING (
CASE
    WHEN ("entity_type" = 'task'::"text") THEN "public"."parent_task_readable"("entity_id")
    ELSE (("user_id" = "auth"."uid"()) OR "public"."authorize"('admin.audit_log'::"text"))
END);



ALTER TABLE "public"."activity_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "auth admin read profiles" ON "public"."profiles" FOR SELECT TO "supabase_auth_admin" USING (true);



CREATE POLICY "checklist read" ON "public"."task_checklist_items" FOR SELECT TO "authenticated" USING ("public"."parent_task_readable"("task_id"));



CREATE POLICY "checklist write" ON "public"."task_checklist_items" TO "authenticated" USING ("public"."parent_task_writable"("task_id")) WITH CHECK ("public"."parent_task_writable"("task_id"));



ALTER TABLE "public"."comments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "comments delete own" ON "public"."comments" FOR DELETE TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."authorize"('comments.moderate'::"text")));



CREATE POLICY "comments insert (scoped)" ON "public"."comments" FOR INSERT TO "authenticated" WITH CHECK ((("auth"."uid"() = "user_id") AND "public"."authorize"('comments.write'::"text") AND (("entity_type" <> 'task'::"text") OR "public"."parent_task_writable"("entity_id"))));



CREATE POLICY "comments read (scoped)" ON "public"."comments" FOR SELECT TO "authenticated" USING (
CASE
    WHEN ("entity_type" = 'task'::"text") THEN "public"."parent_task_readable"("entity_id")
    ELSE "public"."authorize"('comments.read'::"text")
END);



CREATE POLICY "comments update own" ON "public"."comments" FOR UPDATE TO "authenticated" USING ((("auth"."uid"() = "user_id") OR "public"."authorize"('comments.moderate'::"text"))) WITH CHECK ((("auth"."uid"() = "user_id") OR "public"."authorize"('comments.moderate'::"text")));



ALTER TABLE "public"."legacy_user_map" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organization_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "organization_members read (same org)" ON "public"."organization_members" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("organization_id"));



ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "organizations read (members)" ON "public"."organizations" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("id"));



CREATE POLICY "own rows - delete" ON "public"."private_resources" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "own rows - insert" ON "public"."private_resources" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "own rows - select" ON "public"."private_resources" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "own rows - update" ON "public"."private_resources" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "permissions read (authenticated)" ON "public"."permissions" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."private_resources" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles owner manage" ON "public"."profiles" TO "authenticated" USING (("public"."authorize"('users.assign_roles'::"text") AND (("id" = "auth"."uid"()) OR "public"."shares_org_with"("id")))) WITH CHECK (("public"."authorize"('users.assign_roles'::"text") AND (("id" = "auth"."uid"()) OR "public"."shares_org_with"("id"))));



CREATE POLICY "profiles read (same organization)" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((("id" = "auth"."uid"()) OR "public"."shares_org_with"("id")));



CREATE POLICY "profiles update own" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "id")) WITH CHECK (("auth"."uid"() = "id"));



ALTER TABLE "public"."role_permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "role_permissions delete (admin)" ON "public"."role_permissions" FOR DELETE TO "authenticated" USING ("public"."authorize"('admin.permissions'::"text"));



CREATE POLICY "role_permissions insert (admin)" ON "public"."role_permissions" FOR INSERT TO "authenticated" WITH CHECK ("public"."authorize"('admin.permissions'::"text"));



CREATE POLICY "role_permissions read (own role or admin)" ON "public"."role_permissions" FOR SELECT TO "authenticated" USING ((("role_slug" = "public"."jwt_role"()) OR "public"."authorize"('admin.permissions'::"text")));



ALTER TABLE "public"."role_templates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "role_templates read (authenticated)" ON "public"."role_templates" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "roles read (authenticated)" ON "public"."roles" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."schema_markers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."task_activity" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "task_activity append" ON "public"."task_activity" FOR INSERT TO "authenticated" WITH CHECK (("public"."parent_task_writable"("task_id") AND ("user_id" = "auth"."uid"())));



CREATE POLICY "task_activity read" ON "public"."task_activity" FOR SELECT TO "authenticated" USING ("public"."parent_task_readable"("task_id"));



ALTER TABLE "public"."task_checklist_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."task_comments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "task_comments amend" ON "public"."task_comments" FOR UPDATE TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR "public"."authorize"('comments.moderate'::"text"))) WITH CHECK ("public"."parent_task_readable"("task_id"));



CREATE POLICY "task_comments insert" ON "public"."task_comments" FOR INSERT TO "authenticated" WITH CHECK (("public"."parent_task_writable"("task_id") AND ("user_id" = "auth"."uid"()) AND "public"."authorize"('comments.write'::"text")));



CREATE POLICY "task_comments read" ON "public"."task_comments" FOR SELECT TO "authenticated" USING ("public"."parent_task_readable"("task_id"));



CREATE POLICY "task_comments remove" ON "public"."task_comments" FOR DELETE TO "authenticated" USING (("public"."parent_task_readable"("task_id") AND (("user_id" = "auth"."uid"()) OR "public"."authorize"('comments.moderate'::"text"))));



ALTER TABLE "public"."task_progress" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "task_progress amend" ON "public"."task_progress" FOR UPDATE TO "authenticated" USING (("public"."parent_task_writable"("task_id") AND (("user_id" = "auth"."uid"()) OR "public"."authorize"('admin.workspace'::"text")))) WITH CHECK ("public"."parent_task_writable"("task_id"));



CREATE POLICY "task_progress insert" ON "public"."task_progress" FOR INSERT TO "authenticated" WITH CHECK (("public"."parent_task_writable"("task_id") AND ("user_id" = "auth"."uid"())));



CREATE POLICY "task_progress read" ON "public"."task_progress" FOR SELECT TO "authenticated" USING ("public"."parent_task_readable"("task_id"));



CREATE POLICY "task_progress remove" ON "public"."task_progress" FOR DELETE TO "authenticated" USING (("public"."parent_task_writable"("task_id") AND (("user_id" = "auth"."uid"()) OR "public"."authorize"('admin.workspace'::"text"))));



ALTER TABLE "public"."task_resources" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "task_resources read" ON "public"."task_resources" FOR SELECT TO "authenticated" USING ("public"."parent_task_readable"("task_id"));



CREATE POLICY "task_resources write" ON "public"."task_resources" TO "authenticated" USING ("public"."parent_task_writable"("task_id")) WITH CHECK ("public"."parent_task_writable"("task_id"));



ALTER TABLE "public"."tasks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tasks delete (governance)" ON "public"."tasks" FOR DELETE TO "authenticated" USING (("public"."task_read_ok"("organization_id", "assignee_id") AND "public"."authorize"('tasks.delete'::"text")));



CREATE POLICY "tasks insert (self or assigner)" ON "public"."tasks" FOR INSERT TO "authenticated" WITH CHECK (("public"."is_org_member"("organization_id") AND "public"."authorize"('tasks.create'::"text") AND ("reporter_id" = "auth"."uid"()) AND ("created_by" = "auth"."uid"()) AND (("assignee_id" = "auth"."uid"()) OR "public"."authorize"('tasks.assign'::"text"))));



CREATE POLICY "tasks read (own or management)" ON "public"."tasks" FOR SELECT TO "authenticated" USING ("public"."task_read_ok"("organization_id", "assignee_id"));



CREATE POLICY "tasks update (assignee or management)" ON "public"."tasks" FOR UPDATE TO "authenticated" USING ("public"."task_write_ok"("organization_id", "assignee_id")) WITH CHECK ("public"."task_write_ok"("organization_id", "assignee_id"));



ALTER TABLE "public"."template_permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "template_permissions read (authenticated)" ON "public"."template_permissions" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."workspace" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workspace read (document scope)" ON "public"."workspace" FOR SELECT TO "authenticated" USING (("public"."authorize"('deliverables.read'::"text") AND ("public"."authorize"('tasks.view_all'::"text") OR ("jsonb_array_length"(COALESCE(("tasks" #> '{data,tasks}'::"text"[]), '[]'::"jsonb")) = 0))));



CREATE POLICY "workspace write (role)" ON "public"."workspace" FOR UPDATE TO "authenticated" USING (("public"."authorize"('deliverables.read'::"text") AND "public"."authorize"('tasks.execute'::"text"))) WITH CHECK (("public"."authorize"('deliverables.read'::"text") AND "public"."authorize"('tasks.execute'::"text")));



ALTER TABLE "public"."workspace_task_archive" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";
GRANT USAGE ON SCHEMA "public" TO "supabase_auth_admin";



REVOKE ALL ON FUNCTION "public"."add_organization_member"("p_org" "uuid", "p_user" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."add_organization_member"("p_org" "uuid", "p_user" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."add_organization_member"("p_org" "uuid", "p_user" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."archive_workspace_tasks"("p_commit" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."archive_workspace_tasks"("p_commit" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."archive_workspace_tasks"("p_commit" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."attachment_readable"("p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."attachment_readable"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."attachment_readable"("p_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."attachment_task_id"("p_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."attachment_task_id"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."attachment_task_id"("p_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."attachment_writable"("p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."attachment_writable"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."attachment_writable"("p_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."authorize"("requested_permission" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."authorize"("requested_permission" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."authorize"("requested_permission" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") TO "supabase_auth_admin";



GRANT ALL ON FUNCTION "public"."default_org_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."default_org_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."default_org_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."forbid_owner_revoke"() TO "anon";
GRANT ALL ON FUNCTION "public"."forbid_owner_revoke"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."forbid_owner_revoke"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_org_member"("p_org" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_org_member"("p_org" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_org_member"("p_org" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."jwt_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."jwt_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."jwt_role"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."log_permission_change"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."log_permission_change"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."log_profile_admin_action"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."log_profile_admin_action"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."log_task_event"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."log_task_event"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."map_legacy_user"("p_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."map_legacy_user"("p_key" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."migrate_workspace_tasks"("p_commit" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."migrate_workspace_tasks"("p_commit" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."migrate_workspace_tasks"("p_commit" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."parent_task_readable"("p_task" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."parent_task_readable"("p_task" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."parent_task_readable"("p_task" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."parent_task_writable"("p_task" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."parent_task_writable"("p_task" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."parent_task_writable"("p_task" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."protect_last_owner_delete"() TO "anon";
GRANT ALL ON FUNCTION "public"."protect_last_owner_delete"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."protect_last_owner_delete"() TO "service_role";



GRANT ALL ON FUNCTION "public"."protect_profile_privileges"() TO "anon";
GRANT ALL ON FUNCTION "public"."protect_profile_privileges"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."protect_profile_privileges"() TO "service_role";



GRANT ALL ON FUNCTION "public"."protect_system_roles"() TO "anon";
GRANT ALL ON FUNCTION "public"."protect_system_roles"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."protect_system_roles"() TO "service_role";



GRANT ALL ON FUNCTION "public"."protect_task_governance"() TO "anon";
GRANT ALL ON FUNCTION "public"."protect_task_governance"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."protect_task_governance"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."remove_organization_member"("p_org" "uuid", "p_user" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."remove_organization_member"("p_org" "uuid", "p_user" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."remove_organization_member"("p_org" "uuid", "p_user" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reset_role_to_template"("p_role" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reset_role_to_template"("p_role" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reset_role_to_template"("p_role" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."restore_workspace_tasks"("p_commit" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."restore_workspace_tasks"("p_commit" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."restore_workspace_tasks"("p_commit" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."shares_org_with"("p_user" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."shares_org_with"("p_user" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."shares_org_with"("p_user" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."task_read_ok"("p_org" "uuid", "p_assignee" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."task_read_ok"("p_org" "uuid", "p_assignee" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."task_read_ok"("p_org" "uuid", "p_assignee" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."task_write_ok"("p_org" "uuid", "p_assignee" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."task_write_ok"("p_org" "uuid", "p_assignee" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."task_write_ok"("p_org" "uuid", "p_assignee" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."verify_task_migration"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."verify_task_migration"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."verify_task_migration"() TO "service_role";



GRANT ALL ON TABLE "public"."activity_log" TO "anon";
GRANT ALL ON TABLE "public"."activity_log" TO "authenticated";
GRANT ALL ON TABLE "public"."activity_log" TO "service_role";



GRANT ALL ON TABLE "public"."comments" TO "anon";
GRANT ALL ON TABLE "public"."comments" TO "authenticated";
GRANT ALL ON TABLE "public"."comments" TO "service_role";



GRANT ALL ON TABLE "public"."legacy_user_map" TO "service_role";



GRANT ALL ON TABLE "public"."organization_members" TO "anon";
GRANT ALL ON TABLE "public"."organization_members" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_members" TO "service_role";



GRANT ALL ON TABLE "public"."organizations" TO "anon";
GRANT ALL ON TABLE "public"."organizations" TO "authenticated";
GRANT ALL ON TABLE "public"."organizations" TO "service_role";



GRANT ALL ON TABLE "public"."permissions" TO "anon";
GRANT ALL ON TABLE "public"."permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."permissions" TO "service_role";



GRANT ALL ON TABLE "public"."private_resources" TO "anon";
GRANT ALL ON TABLE "public"."private_resources" TO "authenticated";
GRANT ALL ON TABLE "public"."private_resources" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";
GRANT SELECT ON TABLE "public"."profiles" TO "supabase_auth_admin";



GRANT ALL ON TABLE "public"."role_permissions" TO "anon";
GRANT ALL ON TABLE "public"."role_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."role_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."role_templates" TO "anon";
GRANT ALL ON TABLE "public"."role_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."role_templates" TO "service_role";



GRANT ALL ON TABLE "public"."roles" TO "anon";
GRANT ALL ON TABLE "public"."roles" TO "authenticated";
GRANT ALL ON TABLE "public"."roles" TO "service_role";



GRANT ALL ON TABLE "public"."schema_markers" TO "service_role";



GRANT ALL ON TABLE "public"."task_activity" TO "anon";
GRANT ALL ON TABLE "public"."task_activity" TO "authenticated";
GRANT ALL ON TABLE "public"."task_activity" TO "service_role";



GRANT ALL ON TABLE "public"."task_checklist_items" TO "anon";
GRANT ALL ON TABLE "public"."task_checklist_items" TO "authenticated";
GRANT ALL ON TABLE "public"."task_checklist_items" TO "service_role";



GRANT ALL ON TABLE "public"."task_comments" TO "anon";
GRANT ALL ON TABLE "public"."task_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."task_comments" TO "service_role";



GRANT ALL ON TABLE "public"."task_progress" TO "anon";
GRANT ALL ON TABLE "public"."task_progress" TO "authenticated";
GRANT ALL ON TABLE "public"."task_progress" TO "service_role";



GRANT ALL ON TABLE "public"."task_resources" TO "anon";
GRANT ALL ON TABLE "public"."task_resources" TO "authenticated";
GRANT ALL ON TABLE "public"."task_resources" TO "service_role";



GRANT ALL ON TABLE "public"."tasks" TO "anon";
GRANT ALL ON TABLE "public"."tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."tasks" TO "service_role";



GRANT ALL ON TABLE "public"."template_permissions" TO "anon";
GRANT ALL ON TABLE "public"."template_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."template_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."workspace" TO "anon";
GRANT ALL ON TABLE "public"."workspace" TO "authenticated";
GRANT ALL ON TABLE "public"."workspace" TO "service_role";



GRANT ALL ON TABLE "public"."workspace_task_archive" TO "service_role";



GRANT ALL ON SEQUENCE "public"."workspace_task_archive_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."workspace_task_archive_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."workspace_task_archive_id_seq" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







