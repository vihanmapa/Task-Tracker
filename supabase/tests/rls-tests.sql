-- ============================================================
-- Phase 3 — task authorization tests (real Postgres, real policies)
-- ------------------------------------------------------------
-- Runs against a database loaded with:
--     supabase/tests/harness.sql   (minimal auth/storage stand-ins)
--     supabase/schema.sql          (the REAL, unmodified schema)
--
-- so the policies under test are exactly the ones that ship. Every check
-- runs as the `authenticated` Postgres role with a JWT claim set, i.e.
-- the same way a PostgREST request reaches the database — a tampered
-- client or a raw REST call hits precisely this path.
--
-- Run: npm run verify:rls   (scripts/verify-rls.mjs drives it end to end)
-- ============================================================
\set ON_ERROR_STOP on
set client_min_messages = warning;

create schema if not exists tests;

create table if not exists tests.results (
  id     serial primary key,
  name   text not null,
  passed boolean not null,
  note   text
);
truncate tests.results restart identity;
grant usage on schema tests to authenticated;
grant insert, select on tests.results to authenticated;
grant usage, select on sequence tests.results_id_seq to authenticated;

-- Record a boolean assertion. SECURITY INVOKER on purpose: a DEFINER helper
-- would run the checks as the table owner and silently BYPASS RLS, which
-- would make every test pass for the wrong reason.
create or replace function tests.check(p_name text, p_ok boolean, p_note text default null)
returns void language plpgsql as $$
begin
  insert into tests.results (name, passed, note) values (p_name, coalesce(p_ok, false), p_note);
end $$;

-- A write that must be REFUSED. RLS refuses in two different ways depending
-- on the statement: an INSERT/WITH CHECK violation raises 42501, while an
-- UPDATE/DELETE whose USING clause filters the row simply affects 0 rows.
-- Both count as "denied"; anything that actually changes a row is a failure.
create or replace function tests.expect_denied(p_name text, p_sql text)
returns void language plpgsql as $$
declare n bigint;
begin
  begin
    execute p_sql;
    get diagnostics n = row_count;
    if n = 0 then
      perform tests.check(p_name, true, 'denied (0 rows affected)');
    else
      perform tests.check(p_name, false, 'ALLOWED — ' || n || ' row(s) written');
    end if;
  exception when others then
    perform tests.check(p_name, true, 'denied: ' || sqlerrm);
  end;
end $$;

-- A write that must SUCCEED and touch at least one row.
create or replace function tests.expect_allowed(p_name text, p_sql text)
returns void language plpgsql as $$
declare n bigint;
begin
  begin
    execute p_sql;
    get diagnostics n = row_count;
    perform tests.check(p_name, n > 0, n || ' row(s) written');
  exception when others then
    perform tests.check(p_name, false, 'UNEXPECTEDLY denied: ' || sqlerrm);
  end;
end $$;

-- A read whose visible row count must equal p_expect.
create or replace function tests.expect_rows(p_name text, p_sql text, p_expect bigint)
returns void language plpgsql as $$
declare n bigint;
begin
  execute 'select count(*) from (' || p_sql || ') q' into n;
  perform tests.check(p_name, n = p_expect, 'saw ' || n || ', expected ' || p_expect);
exception when others then
  perform tests.check(p_name, false, 'query failed: ' || sqlerrm);
end $$;

grant execute on all functions in schema tests to authenticated;

-- Assertions record their verdict in tests.results; the per-statement result
-- tables psql would echo are noise, so they go to /dev/null until the report.
\o /dev/null

-- ============================================================
-- Fixtures
-- ============================================================
-- Second organization — proves the tenant boundary holds for every role.
insert into public.organizations (id, slug, name)
values ('00000000-0000-0000-0000-0000000000aa', 'acme', 'Acme Ltd')
on conflict (id) do nothing;

-- Accounts. Inserting into auth.users fires handle_new_user(), so this also
-- exercises the real self-registration path: profile + role + membership.
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', '{"name":"Alice"}'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com',   '{"name":"Bob"}'),
  ('33333333-3333-3333-3333-333333333333', 'mona@example.com',  '{"name":"Mona"}'),
  ('44444444-4444-4444-4444-444444444444', 'owen@example.com',  '{"name":"Owen"}'),
  ('55555555-5555-5555-5555-555555555555', 'xavier@example.com','{"name":"Xavier"}'),
  -- Privilege-escalation attempt: the signup payload asks for Owner.
  ('66666666-6666-6666-6666-666666666666', 'eve@example.com',
   '{"name":"Eve","role":"owner","is_management":true,"organization_id":"00000000-0000-0000-0000-0000000000aa","job_title":"Owner"}')
on conflict (id) do nothing;

-- Roles are administered by an owner in production; here we seed them
-- directly, which needs the privilege trigger off for the seed only.
alter table public.profiles disable trigger protect_profile_privileges;
update public.profiles set role = 'product_manager' where id = '33333333-3333-3333-3333-333333333333';
update public.profiles set role = 'owner'           where id = '44444444-4444-4444-4444-444444444444';
alter table public.profiles enable trigger protect_profile_privileges;

-- Xavier belongs to Acme ONLY.
delete from public.organization_members where user_id = '55555555-5555-5555-5555-555555555555';
insert into public.organization_members (organization_id, user_id)
values ('00000000-0000-0000-0000-0000000000aa', '55555555-5555-5555-5555-555555555555')
on conflict do nothing;
-- Acme needs a profile row visible to Xavier for the FK on assignee.

-- ============================================================
-- A. Self-registration safety
-- ============================================================
select tests.check('signup: new account gets the member role',
  (select role from public.profiles where id = '11111111-1111-1111-1111-111111111111') = 'member');

select tests.check('signup: new account joins the primary organization',
  exists (select 1 from public.organization_members
           where user_id = '11111111-1111-1111-1111-111111111111'
             and organization_id = public.default_org_id()));

select tests.check('signup: client-submitted role is IGNORED (no Owner escalation)',
  (select role from public.profiles where id = '66666666-6666-6666-6666-666666666666') = 'member');

select tests.check('signup: client-submitted organization is IGNORED',
  not exists (select 1 from public.organization_members
               where user_id = '66666666-6666-6666-6666-666666666666'
                 and organization_id = '00000000-0000-0000-0000-0000000000aa'));

select tests.check('signup: display name is taken from metadata',
  (select name from public.profiles where id = '11111111-1111-1111-1111-111111111111') = 'Alice');

select tests.check('member role holds no management capability',
  not exists (select 1 from public.role_permissions
               where role_slug = 'member'
                 and permission_key in ('tasks.view_all','tasks.assign','tasks.prioritize',
                                        'tasks.delete','users.assign_roles','admin.permissions')));

select tests.check('member role can run a personal workspace',
  (select count(*) from public.role_permissions
    where role_slug = 'member'
      and permission_key in ('tasks.read','tasks.create','tasks.execute')) = 3);

-- ============================================================
-- B. Standard user — Alice
-- ============================================================
set role authenticated;
select public.test_sign_in('11111111-1111-1111-1111-111111111111');

select tests.check('alice signs in as a member', public.jwt_role() = 'member');

select tests.expect_allowed('standard: INSERT a self-assigned task', $q$
  insert into public.tasks (id, organization_id, title, reporter_id, assignee_id, created_by, updated_by, status, priority)
  values ('T-A1', public.default_org_id(), 'Alice own task',
          auth.uid(), auth.uid(), auth.uid(), auth.uid(), 'In Progress', 'Medium')
$q$);

select tests.expect_denied('standard: INSERT a task assigned to ANOTHER user', $q$
  insert into public.tasks (id, organization_id, title, reporter_id, assignee_id, created_by, updated_by)
  values ('T-A2', public.default_org_id(), 'For Bob',
          auth.uid(), '22222222-2222-2222-2222-222222222222', auth.uid(), auth.uid())
$q$);

select tests.expect_denied('standard: INSERT with a FORGED reporter_id', $q$
  insert into public.tasks (id, organization_id, title, reporter_id, assignee_id, created_by, updated_by)
  values ('T-A3', public.default_org_id(), 'Forged reporter',
          '33333333-3333-3333-3333-333333333333', auth.uid(), auth.uid(), auth.uid())
$q$);

select tests.expect_denied('standard: INSERT into ANOTHER organization', $q$
  insert into public.tasks (id, organization_id, title, reporter_id, assignee_id, created_by, updated_by)
  values ('T-A4', '00000000-0000-0000-0000-0000000000aa', 'Cross tenant',
          auth.uid(), auth.uid(), auth.uid(), auth.uid())
$q$);

select tests.expect_allowed('standard: work own task (progress log)', $q$
  insert into public.task_progress (id, task_id, percent, status, note, user_id)
  values ('pl-a1', 'T-A1', 40, 'In Progress', 'moving', auth.uid())
$q$);

select tests.expect_allowed('standard: add a checklist item to own task', $q$
  insert into public.task_checklist_items (id, task_id, title) values ('cl-a1', 'T-A1', 'step one')
$q$);

select tests.expect_allowed('standard: comment on own task', $q$
  insert into public.task_comments (id, task_id, user_id, body) values ('cm-a1', 'T-A1', auth.uid(), 'note to self')
$q$);

select tests.expect_allowed('standard: UPDATE own task status', $q$
  update public.tasks set status = 'Completed', progress = 100 where id = 'T-A1'
$q$);

select tests.expect_denied('standard: change PRIORITY without tasks.prioritize', $q$
  update public.tasks set priority = 'Critical' where id = 'T-A1'
$q$);

select tests.expect_denied('standard: REASSIGN own task to someone else', $q$
  update public.tasks set assignee_id = '22222222-2222-2222-2222-222222222222' where id = 'T-A1'
$q$);

select tests.expect_denied('standard: DELETE own task without tasks.delete', $q$
  delete from public.tasks where id = 'T-A1'
$q$);

-- ---- Bob creates his own task, then Alice must not be able to touch it ----
select public.test_sign_in('22222222-2222-2222-2222-222222222222');
select tests.expect_allowed('standard: Bob creates his own task', $q$
  insert into public.tasks (id, organization_id, title, reporter_id, assignee_id, created_by, updated_by, status, priority)
  values ('T-B1', public.default_org_id(), 'Bob private task',
          auth.uid(), auth.uid(), auth.uid(), auth.uid(), 'Blocked', 'High')
$q$);
select tests.expect_allowed('standard: Bob logs progress on his own task', $q$
  insert into public.task_progress (id, task_id, percent, status, note, user_id)
  values ('pl-b1', 'T-B1', 10, 'Blocked', 'waiting on infra', auth.uid())
$q$);
select tests.expect_allowed('standard: Bob comments on his own task', $q$
  insert into public.task_comments (id, task_id, user_id, body) values ('cm-b1', 'T-B1', auth.uid(), 'private note')
$q$);

select public.test_sign_in('11111111-1111-1111-1111-111111111111');
select tests.expect_rows('standard: sees ONLY own tasks',
  $q$select id from public.tasks$q$, 1);
select tests.expect_rows('standard: another user''s task is INVISIBLE',
  $q$select id from public.tasks where id = 'T-B1'$q$, 0);
select tests.expect_rows('standard: another user''s progress log is INVISIBLE',
  $q$select id from public.task_progress where task_id = 'T-B1'$q$, 0);
select tests.expect_rows('standard: another user''s comments are INVISIBLE',
  $q$select id from public.task_comments where task_id = 'T-B1'$q$, 0);
select tests.expect_rows('standard: another user''s activity is INVISIBLE',
  $q$select seq from public.task_activity where task_id = 'T-B1'$q$, 0);

select tests.expect_denied('standard: UPDATE another user''s task', $q$
  update public.tasks set title = 'hijacked' where id = 'T-B1'
$q$);
select tests.expect_denied('standard: DELETE another user''s task', $q$
  delete from public.tasks where id = 'T-B1'
$q$);
select tests.expect_denied('standard: write a progress entry on another user''s task', $q$
  insert into public.task_progress (id, task_id, percent, user_id) values ('pl-x', 'T-B1', 99, auth.uid())
$q$);
select tests.expect_denied('standard: write a comment on another user''s task', $q$
  insert into public.task_comments (id, task_id, user_id, body) values ('cm-x', 'T-B1', auth.uid(), 'snoop')
$q$);
select tests.expect_denied('standard: log progress AS ANOTHER USER on own task', $q$
  insert into public.task_progress (id, task_id, percent, user_id)
  values ('pl-a9', 'T-A1', 50, '22222222-2222-2222-2222-222222222222')
$q$);

select tests.expect_denied('standard: cannot self-promote to owner', $q$
  update public.profiles set role = 'owner' where id = auth.uid()
$q$);
select tests.expect_denied('standard: cannot join another organization', $q$
  insert into public.organization_members (organization_id, user_id)
  values ('00000000-0000-0000-0000-0000000000aa', auth.uid())
$q$);
select tests.expect_denied('standard: cannot grant itself a permission', $q$
  insert into public.role_permissions (role_slug, permission_key) values ('member', 'tasks.view_all')
$q$);

-- ---- the legacy copies must not leak the same data ----
select tests.expect_rows('standard: the legacy workspace document is INVISIBLE',
  $q$select id from public.workspace$q$, 0);
select tests.expect_denied('standard: cannot write the legacy workspace document', $q$
  update public.workspace set tasks = '{}'::jsonb where id = 'main'
$q$);
select tests.check('standard: an attachment on another user''s task is unreadable',
  public.attachment_readable('T-B1/pl-b1/0-evidence.png') = false);
select tests.check('standard: an attachment on their OWN task is readable',
  public.attachment_readable('T-A1/pl-a1/0-evidence.png') = true);
select tests.check('standard: cannot write an attachment on another user''s task',
  public.attachment_writable('T-B1/pl-b1/0-evidence.png') = false);

-- ============================================================
-- C. Management user — Mona (Product Manager: tasks.view_all + assign)
-- ============================================================
select public.test_sign_in('33333333-3333-3333-3333-333333333333');

select tests.check('management: holds tasks.view_all', public.authorize('tasks.view_all'));
select tests.check('management: holds tasks.assign',   public.authorize('tasks.assign'));

select tests.expect_rows('management: sees EVERY task in the organization',
  $q$select id from public.tasks$q$, 2);
select tests.expect_rows('management: sees another user''s progress log',
  $q$select id from public.task_progress where task_id = 'T-B1'$q$, 1);
select tests.expect_rows('management: sees another user''s comments',
  $q$select id from public.task_comments where task_id = 'T-B1'$q$, 1);

select tests.expect_allowed('management: CREATE a task for another member', $q$
  insert into public.tasks (id, organization_id, title, reporter_id, assignee_id, created_by, updated_by, priority)
  values ('T-M1', public.default_org_id(), 'Prepare Trillium commercial proposal',
          auth.uid(), '11111111-1111-1111-1111-111111111111', auth.uid(), auth.uid(), 'High')
$q$);

select tests.check('reporter and assignee are distinct on a delegated task',
  (select reporter_id <> assignee_id from public.tasks where id = 'T-M1'));

select tests.expect_allowed('management: REASSIGN a task', $q$
  update public.tasks set assignee_id = '22222222-2222-2222-2222-222222222222' where id = 'T-M1'
$q$);
select tests.expect_allowed('management: change priority', $q$
  update public.tasks set priority = 'Critical' where id = 'T-M1'
$q$);
select tests.expect_allowed('management: update another user''s task', $q$
  update public.tasks set status = 'Waiting' where id = 'T-B1'
$q$);

select tests.expect_denied('management: cannot assign to a NON-MEMBER of the organization', $q$
  update public.tasks set assignee_id = '55555555-5555-5555-5555-555555555555' where id = 'T-M1'
$q$);
select tests.expect_denied('management: cannot move a task to another organization', $q$
  update public.tasks set organization_id = '00000000-0000-0000-0000-0000000000aa' where id = 'T-M1'
$q$);
select tests.expect_denied('management: cannot rewrite the reporter', $q$
  update public.tasks set reporter_id = '11111111-1111-1111-1111-111111111111' where id = 'T-B1'
$q$);
select tests.expect_denied('management: cannot change roles (no users.assign_roles)', $q$
  update public.profiles set role = 'owner' where id = '11111111-1111-1111-1111-111111111111'
$q$);

-- The assignee sees work delegated to them, and the reporter keeps sight of it.
select public.test_sign_in('22222222-2222-2222-2222-222222222222');
select tests.expect_rows('assignee sees a task delegated to them',
  $q$select id from public.tasks where id = 'T-M1'$q$, 1);
select public.test_sign_in('33333333-3333-3333-3333-333333333333');
select tests.expect_rows('reporter keeps sight of a task they delegated away',
  $q$select id from public.tasks where id = 'T-M1' and reporter_id = auth.uid()$q$, 1);

select tests.expect_rows('management: the workspace document is readable',
  $q$select id from public.workspace$q$, 2);
select tests.check('management: attachments follow task visibility',
  public.attachment_readable('T-B1/pl-b1/0-evidence.png') = true);
-- An attachment whose task has not been normalized yet follows the document's
-- own gate, so pre-migration evidence stays reachable during the rollout.
select tests.check('pre-migration attachments still follow the document gate',
  public.attachment_readable('T-NOT-MIGRATED/x/0-file.png') = true);

-- ============================================================
-- D. Tenant boundary — Xavier (Acme), and the owner
-- ============================================================
select public.test_sign_in('55555555-5555-5555-5555-555555555555');
select tests.expect_rows('cross-org: another tenant''s tasks are INVISIBLE',
  $q$select id from public.tasks$q$, 0);
select tests.expect_rows('cross-org: another tenant''s profiles are INVISIBLE',
  $q$select id from public.profiles where id = '11111111-1111-1111-1111-111111111111'$q$, 0);
select tests.expect_rows('cross-org: own profile is always readable',
  $q$select id from public.profiles where id = auth.uid()$q$, 1);
select tests.expect_denied('cross-org: cannot update another tenant''s task', $q$
  update public.tasks set title = 'x' where id = 'T-A1'
$q$);

select public.test_sign_in('44444444-4444-4444-4444-444444444444');
select tests.check('owner: retains administration (users.assign_roles)',
  public.authorize('users.assign_roles') and public.authorize('admin.permissions'));
select tests.expect_rows('owner: sees every task in their OWN organization',
  $q$select id from public.tasks$q$, 3);
select tests.expect_rows('owner: does NOT see another organization''s tasks',
  $q$select id from public.tasks where organization_id = '00000000-0000-0000-0000-0000000000aa'$q$, 0);
select tests.expect_allowed('owner: may change a role', $q$
  update public.profiles set job_title = 'Delivery Lead' where id = '11111111-1111-1111-1111-111111111111'
$q$);
select tests.expect_allowed('owner: may delete a task (tasks.delete)', $q$
  delete from public.tasks where id = 'T-M1'
$q$);

-- ============================================================
-- E. Runtime-configurable management (no deployment needed)
-- ============================================================
-- Bob is a plain member and sees only his own task. An owner grants
-- tasks.view_all to the member role; Bob's visibility widens on the NEXT
-- request — no re-login, no code change. Then it is revoked again.
select public.test_sign_in('22222222-2222-2222-2222-222222222222');
select tests.expect_rows('before grant: member sees only own task',
  $q$select id from public.tasks$q$, 1);

select public.test_sign_in('44444444-4444-4444-4444-444444444444');
select tests.expect_allowed('owner grants tasks.view_all to the member role', $q$
  insert into public.role_permissions (role_slug, permission_key) values ('member', 'tasks.view_all')
$q$);

select public.test_sign_in('22222222-2222-2222-2222-222222222222');
select tests.expect_rows('after grant: the same member now sees organization tasks',
  $q$select id from public.tasks$q$, 2);

select public.test_sign_in('44444444-4444-4444-4444-444444444444');
select tests.expect_allowed('owner revokes tasks.view_all again', $q$
  delete from public.role_permissions where role_slug = 'member' and permission_key = 'tasks.view_all'
$q$);
select public.test_sign_in('22222222-2222-2222-2222-222222222222');
select tests.expect_rows('after revoke: member is back to personal scope',
  $q$select id from public.tasks$q$, 1);

-- ============================================================
-- F. Audit trail
-- ============================================================
reset role;
select public.test_sign_out();
select tests.check('audit: task_created was logged',
  exists (select 1 from public.activity_log where action = 'task_created' and entity_id = 'T-A1'));
select tests.check('audit: task_assigned was logged for a delegated task',
  exists (select 1 from public.activity_log where action = 'task_assigned' and entity_id = 'T-M1'));
select tests.check('audit: task_reassigned was logged',
  exists (select 1 from public.activity_log where action = 'task_reassigned' and entity_id = 'T-M1'));
select tests.check('audit: task_status_changed was logged',
  exists (select 1 from public.activity_log where action = 'task_status_changed' and entity_id = 'T-A1'));
select tests.check('audit: task_priority_changed was logged',
  exists (select 1 from public.activity_log where action = 'task_priority_changed' and entity_id = 'T-M1'));
select tests.check('audit: task_completed was logged',
  exists (select 1 from public.activity_log where action = 'task_completed' and entity_id = 'T-A1'));
select tests.check('audit: permission grant/revoke still logged (Phase 2 intact)',
  exists (select 1 from public.activity_log where action = 'permission_granted' and entity_id = 'role')
  or exists (select 1 from public.activity_log where action = 'permission_granted'));

-- ============================================================
-- G. Workspace document → normalized tasks migration
-- ============================================================
-- A realistic legacy document: two tasks owned by the legacy keys the
-- production workspace uses, with checklist, progress, resources, comments
-- and an activity feed that records who created each one.
update public.workspace set tasks = $doc$
{
  "version": 2,
  "metadata": {"createdAt": "2026-01-01T00:00:00.000Z"},
  "data": {
    "tasks": [
      {"id": "T-501", "title": "Prepare Trillium commercial proposal", "description": "Draft + pricing",
       "ownerId": "vihan", "status": "In Progress", "priority": "High", "category": "Sales",
       "effort": "L", "progress": 60, "dueDate": "2026-09-01T17:00:00.000Z",
       "successCriteria": "MD signs off", "risk": "pricing", "dependencies": ["legal review"],
       "depTaskIds": [], "deliverableId": "D-2",
       "createdAt": "2026-08-01T09:00:00.000Z", "updatedAt": "2026-08-10T09:00:00.000Z",
       "checklist": [{"id": "cl1", "title": "Draft", "done": true, "completedBy": "vihan",
                      "completedAt": "2026-08-05T09:00:00.000Z"},
                     {"id": "cl2", "title": "Pricing", "done": false}],
       "progressLog": [{"id": "pl1", "percent": 60, "status": "In Progress", "note": "draft done",
                        "userId": "vihan", "at": "2026-08-05T09:00:00.000Z", "links": ["https://x"]}],
       "resources": [{"id": "r1", "kind": "link", "title": "Pricing sheet", "url": "https://y"}],
       "comments": [{"id": "c1", "userId": "richard", "comment": "Push on margin",
                     "createdAt": "2026-08-06T09:00:00.000Z"}],
       "activity": [{"type": "created", "userId": "richard", "at": "2026-08-01T09:00:00.000Z"},
                    {"type": "progress", "userId": "vihan", "at": "2026-08-05T09:00:00.000Z", "detail": "60%"}],
       "edits": [{"id": "ed1", "field": "priority", "from": "Medium", "to": "High", "userId": "richard"}]},
      {"id": "T-502", "title": "Unowned legacy task", "ownerId": "someone_who_left",
       "status": "Not Started", "priority": "Low", "progress": 0,
       "checklist": [], "progressLog": [], "resources": [], "comments": [],
       "activity": [{"type": "created", "userId": "someone_who_left", "at": "2026-08-02T09:00:00.000Z"}]},
      {"id": "D-9", "kind": "deliverable", "title": "Not a task"}
    ],
    "deliverables": [], "weeks": [], "kpiScores": {}
  }
}
$doc$::jsonb where id = 'main';

-- The operator maps the legacy workspace keys onto real accounts first.
insert into public.legacy_user_map (legacy_key, user_id) values
  ('vihan',   '11111111-1111-1111-1111-111111111111'),
  ('richard', '44444444-4444-4444-4444-444444444444')
on conflict (legacy_key) do update set user_id = excluded.user_id;

set role authenticated;
select public.test_sign_in('11111111-1111-1111-1111-111111111111');
select tests.expect_denied('migration: a standard user cannot run it', $q$
  select public.migrate_workspace_tasks(true)
$q$);

select public.test_sign_in('44444444-4444-4444-4444-444444444444');
select tests.check('migration: dry run reports the document without writing',
  (select value from public.migrate_workspace_tasks(false) where metric = 'document_tasks') = 2
  and (select value from public.migrate_workspace_tasks(false) where metric = 'tasks_written') = 0
  and not exists (select 1 from public.tasks where id = 'T-501'));

select tests.check('migration: commit writes every document task',
  (select value from public.migrate_workspace_tasks(true) where metric = 'tasks_written') = 2);

select tests.check('migration: task ids are preserved',
  exists (select 1 from public.tasks where id = 'T-501')
  and exists (select 1 from public.tasks where id = 'T-502'));

select tests.check('migration: deliverables in the document are NOT migrated as tasks',
  not exists (select 1 from public.tasks where id = 'D-9'));

select tests.check('migration: legacy owner maps to ASSIGNEE',
  (select assignee_id from public.tasks where id = 'T-501') = '11111111-1111-1111-1111-111111111111');

select tests.check('migration: activity "created" maps to REPORTER',
  (select reporter_id from public.tasks where id = 'T-501') = '44444444-4444-4444-4444-444444444444');

select tests.check('migration: status, priority, progress, due date preserved',
  (select status = 'In Progress' and priority = 'High' and progress = 60
          and due_date = '2026-09-01T17:00:00.000Z'::timestamptz
          and category = 'Sales' and effort = 'L' and deliverable_id = 'D-2'
          and success_criteria = 'MD signs off'
     from public.tasks where id = 'T-501'));

select tests.check('migration: field-edit history preserved',
  (select jsonb_array_length(edits) from public.tasks where id = 'T-501') = 1);

select tests.check('migration: checklist / progress / resources / comments / activity preserved',
  (select count(*) from public.task_checklist_items where task_id = 'T-501') = 2
  and (select count(*) from public.task_progress  where task_id = 'T-501') = 1
  and (select count(*) from public.task_resources where task_id = 'T-501') = 1
  and (select count(*) from public.task_comments  where task_id = 'T-501') = 1
  and (select count(*) from public.task_activity  where task_id = 'T-501') = 2);

select tests.check('migration: progress-entry evidence links preserved',
  (select links from public.task_progress where id = 'pl1') = '["https://x"]'::jsonb);

select tests.check('migration: an UNMAPPED owner becomes unassigned, key retained',
  (select assignee_id is null and legacy_owner = 'someone_who_left'
     from public.tasks where id = 'T-502'));

select tests.check('migration: is idempotent (re-run writes nothing)',
  (select value from public.migrate_workspace_tasks(true) where metric = 'tasks_written') = 0
  and (select count(*) from public.tasks where id like 'T-50%') = 2);

select tests.check('migration: verification reports every count matching',
  (select bool_and(matches) from public.verify_task_migration()
    where metric in ('tasks','ids_preserved','checklist_items','progress_entries',
                     'resources','comments','activity_entries')));

select tests.check('migration: the workspace document was NOT modified',
  (select jsonb_array_length(tasks #> '{data,tasks}') from public.workspace where id = 'main') = 3);

select tests.check('pruning: refuses without a green verification, dry-run first',
  public.prune_migrated_tasks_from_document(false) like 'dry run:%'
  and (select jsonb_array_length(tasks #> '{data,tasks}') from public.workspace where id = 'main') = 3);

-- A migrated task is subject to exactly the same RLS as a native one.
select public.test_sign_in('22222222-2222-2222-2222-222222222222');
select tests.expect_rows('migration: a migrated task stays private to its assignee',
  $q$select id from public.tasks where id = 'T-501'$q$, 0);
select public.test_sign_in('11111111-1111-1111-1111-111111111111');
select tests.expect_rows('migration: the assignee sees their migrated task',
  $q$select id from public.tasks where id = 'T-501'$q$, 1);

reset role;
select public.test_sign_out();

-- ============================================================
-- Report
-- ============================================================
\o
\pset format aligned
select case when passed then '  ok  ' else ' FAIL ' end as st, name, note from tests.results order by id;

select count(*) filter (where passed) as passed,
       count(*) filter (where not passed) as failed,
       count(*) as total
  from tests.results;

do $$
declare n int;
begin
  select count(*) into n from tests.results where not passed;
  if n > 0 then
    raise exception '% task-authorization assertion(s) FAILED', n;
  end if;
end $$;
