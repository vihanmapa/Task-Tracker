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
-- `anon` records results too: the advisor-parity block below probes the REST
-- surface as the UNAUTHENTICATED role, which is the one an attacker holds.
grant usage on schema tests to authenticated, anon;
grant insert, select on tests.results to authenticated, anon;
grant usage, select on sequence tests.results_id_seq to authenticated, anon;

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

-- Signup now creates ONLY a personal workspace (ADR 0008), so the Evbex
-- members this suite needs are admitted deliberately — which is also the first
-- exercise of the invite/approve path.
insert into public.organization_members (organization_id, user_id)
select public.default_org_id(), id from public.profiles
 where id in ('11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222',
              '33333333-3333-3333-3333-333333333333',
              '44444444-4444-4444-4444-444444444444')
on conflict do nothing;

-- Xavier belongs to Acme ONLY (plus his own personal workspace).
insert into public.organization_members (organization_id, user_id)
values ('00000000-0000-0000-0000-0000000000aa', '55555555-5555-5555-5555-555555555555')
on conflict do nothing;

-- Eve is the PUBLIC self-registered account: she gets a personal workspace and
-- is never admitted to Evbex. Section A2 proves what that does and does not
-- give her.

-- ============================================================
-- A. Self-registration safety
-- ============================================================
select tests.check('signup: new account gets the member role',
  (select role from public.profiles where id = '11111111-1111-1111-1111-111111111111') = 'member');

select tests.check('signup: new account does NOT join the primary organization',
  not exists (select 1 from public.organization_members m
               join public.organizations o on o.id = m.organization_id
              where m.user_id = '66666666-6666-6666-6666-666666666666'
                and o.kind = 'team'));

select tests.check('signup: new account gets its OWN personal workspace',
  exists (select 1 from public.organizations o
            join public.organization_members m on m.organization_id = o.id
           where o.kind = 'personal' and o.owner_user_id = '66666666-6666-6666-6666-666666666666'
             and m.user_id = '66666666-6666-6666-6666-666666666666'));

select tests.check('signup: the personal workspace has exactly one member',
  (select count(*) from public.organization_members m
     join public.organizations o on o.id = m.organization_id
    where o.kind = 'personal' and o.owner_user_id = '66666666-6666-6666-6666-666666666666') = 1);

select tests.check('signup: client-submitted role is IGNORED (no Owner escalation)',
  (select role from public.profiles where id = '66666666-6666-6666-6666-666666666666') = 'member');

select tests.check('signup: client-submitted organization is IGNORED',
  not exists (select 1 from public.organization_members
               where user_id = '66666666-6666-6666-6666-666666666666'
                 and organization_id = '00000000-0000-0000-0000-0000000000aa'));

select tests.check('signup: client-submitted management flag grants nothing',
  not exists (select 1 from public.role_permissions rp
               join public.profiles p on p.role = rp.role_slug
              where p.id = '66666666-6666-6666-6666-666666666666'
                and rp.permission_key in ('tasks.view_all', 'users.assign_roles')));

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
-- A2. A public account is an ACCOUNT, not a membership (ADR 0008)
-- ============================================================
-- Eve registered through the public form. She has a working personal task
-- tracker and no reach whatsoever into Evbex. Both halves matter: the product
-- promises "anyone can have their own tracker", and the security model
-- promises "creating an account is not joining a company".
set role authenticated;
select public.test_sign_in('66666666-6666-6666-6666-666666666666');

select tests.expect_rows('public signup: sees ONLY its own personal workspace',
  $q$select id from public.organizations$q$, 1);
select tests.check('public signup: that workspace is a personal one it owns',
  (select kind = 'personal' and owner_user_id = auth.uid() from public.organizations limit 1));
select tests.check('public signup: is NOT a member of the primary organization',
  public.is_org_member(public.default_org_id()) = false);

select tests.expect_allowed('public signup: can create a task in its OWN workspace', $q$
  insert into public.tasks (id, organization_id, title, reporter_id, assignee_id, created_by, updated_by)
  select 'T-P1', o.id, 'My own private task', auth.uid(), auth.uid(), auth.uid(), auth.uid()
    from public.organizations o where o.owner_user_id = auth.uid()
$q$);
select tests.expect_rows('public signup: sees its own personal task',
  $q$select id from public.tasks where id = 'T-P1'$q$, 1);

select tests.expect_denied('public signup: cannot create a task in Evbex', $q$
  insert into public.tasks (id, organization_id, title, reporter_id, assignee_id, created_by, updated_by)
  values ('T-P2', public.default_org_id(), 'Sneaking in', auth.uid(), auth.uid(), auth.uid(), auth.uid())
$q$);
select tests.expect_denied('public signup: cannot join Evbex', $q$
  insert into public.organization_members (organization_id, user_id)
  values (public.default_org_id(), auth.uid())
$q$);
select tests.expect_denied('public signup: cannot invite itself via the admin RPC', $q$
  select public.add_organization_member(public.default_org_id(), auth.uid())
$q$);
select tests.expect_rows('public signup: Evbex members are INVISIBLE',
  $q$select id from public.profiles where id <> auth.uid()$q$, 0);
select tests.expect_rows('public signup: Evbex membership rows are INVISIBLE',
  $q$select user_id from public.organization_members where organization_id = public.default_org_id()$q$, 0);
select tests.expect_rows('public signup: the workspace document is INVISIBLE',
  $q$select id from public.workspace$q$, 0);

-- …and the deliberate admission path does work, for an administrator.
reset role;
select public.test_sign_out();
set role authenticated;
select public.test_sign_in('44444444-4444-4444-4444-444444444444');   -- owner
select tests.expect_allowed('admin can admit a user to a team organization', $q$
  select public.add_organization_member(public.default_org_id(), '66666666-6666-6666-6666-666666666666')
  from generate_series(1, 1)
$q$);
select tests.check('admission is audited',
  exists (select 1 from public.activity_log where action = 'organization_member_added'));
select tests.expect_denied('nobody can add members to a personal workspace', $q$
  select public.add_organization_member(
    (select id from public.organizations where kind = 'personal' limit 1),
    '11111111-1111-1111-1111-111111111111')
$q$);

set role authenticated;
select public.test_sign_in('66666666-6666-6666-6666-666666666666');
select tests.check('after admission the user IS an Evbex member',
  public.is_org_member(public.default_org_id()));

-- Undo, so the rest of the suite sees Eve as the outsider she started as.
reset role;
delete from public.organization_members
 where organization_id = public.default_org_id()
   and user_id = '66666666-6666-6666-6666-666666666666';

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
select tests.check('standard: the personal workspace exists alongside Evbex membership',
  (select count(*) from public.organizations) = 2);
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

-- ---- no OTHER table may become a second index of everyone's work ----
-- The audit log carries task titles and status transitions; public.comments is
-- keyed by entity id; legacy_user_map maps staff keys to accounts. All three
-- were readable by any signed-in user before this correction round.
select tests.expect_rows('standard: cannot read audit rows about another user''s task',
  $q$select id from public.activity_log where entity_type = 'task' and entity_id = 'T-B1'$q$, 0);
select tests.check('standard: CAN read audit rows about their own task',
  (select count(*) from public.activity_log where entity_type = 'task' and entity_id = 'T-A1') > 0);
select tests.expect_rows('standard: cannot read role-administration audit rows',
  $q$select id from public.activity_log where entity_type = 'role'$q$, 0);
-- Revoked outright rather than filtered, so this is a hard privilege error
-- rather than an empty result — a stronger denial than a policy would give.
select tests.expect_denied('standard: the legacy user map is unreachable', $q$
  select legacy_key from public.legacy_user_map
$q$);
select tests.expect_denied('standard: cannot plant a comment row about another user''s task', $q$
  insert into public.comments (entity_type, entity_id, user_id, body)
  values ('task', 'T-B1', auth.uid(), 'probe')
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
-- …and NOT the personal workspaces of people outside it: management scope is
-- bounded by the organization, always.
select tests.expect_rows('management: a public user''s personal task is still invisible',
  $q$select id from public.tasks where id = 'T-P1'$q$, 0);
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
select tests.check('management: CAN read audit rows about the tasks it oversees',
  (select count(*) from public.activity_log where entity_type = 'task' and entity_id = 'T-B1') > 0);
select tests.check('management: attachments follow task visibility',
  public.attachment_readable('T-B1/pl-b1/0-evidence.png') = true);
-- An attachment whose task has not been normalized yet follows the document's
-- own gate, so pre-migration evidence stays reachable during the rollout.
select tests.check('pre-migration attachments still follow the document gate',
  public.attachment_readable('T-NOT-MIGRATED/x/0-file.png') = true);

-- ============================================================
-- C2. Reporter is metadata, not authorization (ADR 0007)
-- ============================================================
-- The exact lifecycle the review asked about: Alice raises a task for herself,
-- works it, a manager reassigns it to Bob — and from that moment it is Bob's
-- work. Alice stays on the record as reporter forever and loses every right
-- over it, because "I raised this" is not a standing grant.
set role authenticated;
select public.test_sign_in('11111111-1111-1111-1111-111111111111');

select tests.expect_allowed('reporter lifecycle: Alice creates a self-task', $q$
  insert into public.tasks (id, organization_id, title, reporter_id, assignee_id, created_by, updated_by, status)
  values ('T-R1', public.default_org_id(), 'Alice raised this herself',
          auth.uid(), auth.uid(), auth.uid(), auth.uid(), 'In Progress')
$q$);
select tests.expect_rows('reporter lifecycle: 1. she can read it while assigned to her',
  $q$select id from public.tasks where id = 'T-R1'$q$, 1);
select tests.expect_allowed('reporter lifecycle: 2. she can execute it while assigned to her', $q$
  update public.tasks set progress = 25 where id = 'T-R1'
$q$);

-- 3. Management reassigns it to Bob.
select public.test_sign_in('33333333-3333-3333-3333-333333333333');
select tests.expect_allowed('reporter lifecycle: 3. management reassigns it to Bob', $q$
  update public.tasks set assignee_id = '22222222-2222-2222-2222-222222222222' where id = 'T-R1'
$q$);

-- 4/5. Bob now owns it outright.
select public.test_sign_in('22222222-2222-2222-2222-222222222222');
select tests.expect_rows('reporter lifecycle: 4. the new assignee can read it',
  $q$select id from public.tasks where id = 'T-R1'$q$, 1);
select tests.expect_allowed('reporter lifecycle: 5. the new assignee can execute it', $q$
  update public.tasks set progress = 60 where id = 'T-R1'
$q$);

-- 6/7/8. Alice is still the reporter, and that buys her nothing.
reset role;
select tests.check('reporter lifecycle: 6. Alice remains the recorded reporter',
  (select reporter_id from public.tasks where id = 'T-R1') = '11111111-1111-1111-1111-111111111111');

set role authenticated;
select public.test_sign_in('11111111-1111-1111-1111-111111111111');
select tests.expect_rows('reporter lifecycle: 7. reporter can NO LONGER read it',
  $q$select id from public.tasks where id = 'T-R1'$q$, 0);
select tests.expect_denied('reporter lifecycle: 8. reporter can NO LONGER execute it', $q$
  update public.tasks set progress = 5 where id = 'T-R1'
$q$);
select tests.expect_rows('reporter lifecycle: its progress log is invisible to the reporter',
  $q$select id from public.task_progress where task_id = 'T-R1'$q$, 0);
select tests.expect_denied('reporter lifecycle: reporter cannot comment on it either', $q$
  insert into public.task_comments (id, task_id, user_id, body) values ('cm-r1', 'T-R1', auth.uid(), 'still mine?')
$q$);
select tests.expect_denied('reporter lifecycle: reporter cannot claim it back', $q$
  update public.tasks set assignee_id = auth.uid() where id = 'T-R1'
$q$);

-- 9/10/11. Management scope is the ONLY thing that sees across people, and it
-- is a runtime grant, not a property of who raised what.
select public.test_sign_in('33333333-3333-3333-3333-333333333333');
select tests.expect_rows('reporter lifecycle: 9. management (view_all) can read it',
  $q$select id from public.tasks where id = 'T-R1'$q$, 1);

select public.test_sign_in('44444444-4444-4444-4444-444444444444');
select tests.expect_allowed('reporter lifecycle: revoke tasks.view_all from Product Manager', $q$
  delete from public.role_permissions where role_slug = 'product_manager' and permission_key = 'tasks.view_all'
$q$);
select public.test_sign_in('33333333-3333-3333-3333-333333333333');
select tests.expect_rows('reporter lifecycle: 10. without view_all, cross-user sight is gone at once',
  $q$select id from public.tasks where id = 'T-R1'$q$, 0);
select tests.check('reporter lifecycle: 10b. …even though they raised other tasks',
  (select count(*) from public.tasks where reporter_id = auth.uid()) = 0);

select public.test_sign_in('44444444-4444-4444-4444-444444444444');
select tests.expect_allowed('reporter lifecycle: grant it back', $q$
  insert into public.role_permissions (role_slug, permission_key) values ('product_manager', 'tasks.view_all')
$q$);
select public.test_sign_in('33333333-3333-3333-3333-333333333333');
select tests.expect_rows('reporter lifecycle: 11. restoring view_all restores visibility',
  $q$select id from public.tasks where id = 'T-R1'$q$, 1);

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
  $q$select id from public.tasks$q$, 4);
select tests.expect_rows('owner: does NOT see another organization''s tasks',
  $q$select id from public.tasks where organization_id = '00000000-0000-0000-0000-0000000000aa'$q$, 0);

-- The tenant boundary binds the administrator too. "profiles owner manage" is
-- a permissive ALL policy, so before it was org-scoped it also answered SELECT
-- and handed an administrator of one tenant every account on the platform —
-- and, being ALL, let them re-role and delete those accounts as well. An
-- administrator administers their OWN organization; reaching outside it is not
-- administration. (TDD §5.2, §9 "any role incl. owner … deny", §19.)
select tests.expect_rows('owner: does NOT see another tenant''s profile',
  $q$select id from public.profiles where id = '55555555-5555-5555-5555-555555555555'$q$, 0);
select tests.expect_rows('owner: does NOT see a public signup''s profile',
  $q$select id from public.profiles where id = '66666666-6666-6666-6666-666666666666'$q$, 0);
select tests.expect_rows('owner: the directory is their own organization only',
  $q$select id from public.profiles where id <> auth.uid() and not public.shares_org_with(id)$q$, 0);
select tests.expect_denied('owner: cannot re-role another tenant''s owner', $q$
  update public.profiles set role = 'viewer' where id = '55555555-5555-5555-5555-555555555555'
$q$);
select tests.expect_denied('owner: cannot re-role a public signup', $q$
  update public.profiles set role = 'viewer' where id = '66666666-6666-6666-6666-666666666666'
$q$);
select tests.expect_denied('owner: cannot delete another tenant''s profile', $q$
  delete from public.profiles where id = '55555555-5555-5555-5555-555555555555'
$q$);
select tests.expect_denied('owner: cannot disable a public signup', $q$
  update public.profiles set status = 'disabled' where id = '66666666-6666-6666-6666-666666666666'
$q$);
-- Read back as Xavier himself: after the fix the other tenant's owner is not
-- even visible to Evbex's owner, so only Xavier can confirm he is intact.
select public.test_sign_in('55555555-5555-5555-5555-555555555555');
select tests.check('owner: the other tenant''s account is untouched by the denied writes',
  (select role || '/' || status from public.profiles where id = auth.uid()) = 'member/active');
select public.test_sign_in('44444444-4444-4444-4444-444444444444');
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
  $q$select id from public.tasks$q$, 2);

select public.test_sign_in('44444444-4444-4444-4444-444444444444');
select tests.expect_allowed('owner grants tasks.view_all to the member role', $q$
  insert into public.role_permissions (role_slug, permission_key) values ('member', 'tasks.view_all')
$q$);

select public.test_sign_in('22222222-2222-2222-2222-222222222222');
select tests.expect_rows('after grant: the same member now sees organization tasks',
  $q$select id from public.tasks$q$, 3);

select public.test_sign_in('44444444-4444-4444-4444-444444444444');
select tests.expect_allowed('owner revokes tasks.view_all again', $q$
  delete from public.role_permissions where role_slug = 'member' and permission_key = 'tasks.view_all'
$q$);
select public.test_sign_in('22222222-2222-2222-2222-222222222222');
select tests.expect_rows('after revoke: member is back to personal scope',
  $q$select id from public.tasks$q$, 2);

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

-- ---- the legacy copy must stop being a second route to other people's tasks ----
-- While the document still carries task payload it is management-only, so a
-- delivery role holding deliverables.read cannot read everyone's work out of
-- the blob. Archiving then empties it and gives those roles the document back.
select public.test_sign_in('11111111-1111-1111-1111-111111111111');
select tests.expect_rows('legacy blob: a standard user cannot read the document at all',
  $q$select id from public.workspace$q$, 0);

select public.test_sign_in('44444444-4444-4444-4444-444444444444');
select tests.check('archive: dry run reports without moving anything',
  public.archive_workspace_tasks(false) like 'dry run:%'
  and (select jsonb_array_length(tasks #> '{data,tasks}') from public.workspace where id = 'main') = 3);

-- Two statements on purpose: a subquery in the SAME statement as the function
-- call would read the pre-call snapshot and quietly pass for the wrong reason.
select tests.check('archive: commit reports the move',
  public.archive_workspace_tasks(true) like 'archived%');
select tests.check('archive: the shared document no longer carries task data',
  (select jsonb_array_length(tasks #> '{data,tasks}') from public.workspace where id = 'main') = 0);

-- Read back as the table owner: `authenticated` has no privilege on the
-- archive at all (not even a policy to evaluate), which is itself the point.
reset role;
select tests.check('archive: the payload is preserved, not destroyed',
  (select task_count from public.workspace_task_archive where workspace_id = 'main'
    order by id desc limit 1) = 3
  and (select jsonb_array_length(payload) from public.workspace_task_archive
        where workspace_id = 'main' order by id desc limit 1) = 3);

select tests.check('archive: the move is audited',
  exists (select 1 from public.activity_log where action = 'workspace_tasks_archived'));

select tests.check('archive: the archive table has no policy for ordinary clients',
  (select count(*) from pg_policies where tablename = 'workspace_task_archive') = 0);

set role authenticated;
select public.test_sign_in('44444444-4444-4444-4444-444444444444');

select tests.check('archive: rollback can put it back',
  public.restore_workspace_tasks(false) like 'dry run: would restore 3%');

select public.test_sign_in('11111111-1111-1111-1111-111111111111');
select tests.expect_denied('archive: a standard user cannot archive', $q$
  select public.archive_workspace_tasks(true)
$q$);
select tests.expect_denied('archive: a standard user cannot restore', $q$
  select public.restore_workspace_tasks(true)
$q$);
select tests.expect_denied('archive: a standard user cannot read the archive', $q$
  select payload from public.workspace_task_archive
$q$);

-- With the document emptied of tasks, non-management roles get the governance
-- content back — the point of archiving rather than tightening the gate.
select public.test_sign_in('33333333-3333-3333-3333-333333333333');
select tests.expect_rows('archive: the document is readable again once task-free',
  $q$select id from public.workspace$q$, 2);

-- A migrated task is subject to exactly the same RLS as a native one.
select public.test_sign_in('22222222-2222-2222-2222-222222222222');
select tests.expect_rows('migration: a migrated task stays private to its assignee',
  $q$select id from public.tasks where id = 'T-501'$q$, 0);
select public.test_sign_in('11111111-1111-1111-1111-111111111111');
select tests.expect_rows('migration: the assignee sees their migrated task',
  $q$select id from public.tasks where id = 'T-501'$q$, 1);

-- ============================================================
-- ============================================================
-- UAT-SEC-03 — the Settings "Load demo data" / "Clear all tasks" controls
-- ------------------------------------------------------------
-- Live UAT found both controls VISIBLE to a member (Devni). They are now
-- gated on `canEdit` (admin.workspace) in app.jsx, but a UI gate is not a
-- boundary: a tampered client, or a raw PostgREST call, reaches the same
-- routes. These assertions pin the SERVER side of both controls.
--
-- What the controls actually emit (fm-navigate/app.jsx:893-897 →
-- task-store.js plan()/persist() → data-service.js):
--   Load demo  → insertTaskRow() per seed task  (+ deletes for the replaced set)
--                and a workspace document write of SEED_DELIVERABLES
--   Clear all  → deleteTaskRow() per task, and a document write emptying
--                deliverables / weeks / kpiScores
-- The seed rows carry ownerId 'vihan' — not a uuid — so insertRow() leaves
-- assignee_id NULL and records legacy_owner, which is exactly why the INSERT
-- policy refuses them for a member (no tasks.assign).
--
-- Alice is a plain member: tasks.create + tasks.execute, but no tasks.delete,
-- no tasks.assign, no admin.workspace, no deliverables.read.
select public.test_sign_in('11111111-1111-1111-1111-111111111111');
select tests.check('UAT-SEC-03: persona is a member with no delete/assign/govern rights',
  public.jwt_role() = 'member'
  and not public.authorize('tasks.delete') and not public.authorize('tasks.assign')
  and not public.authorize('admin.workspace') and not public.authorize('deliverables.read'));

-- ---- "Load demo data" ----
select tests.expect_denied('UAT-SEC-03 Load demo: seed row (assignee NULL, legacy_owner) refused', $q$
  insert into public.tasks (id, organization_id, title, reporter_id, assignee_id, created_by, legacy_owner)
  values ('T-SEC03-SEED', public.default_org_id(), 'demo seed', auth.uid(), null, auth.uid(), 'vihan')
$q$);
select tests.expect_denied('UAT-SEC-03 Load demo: seed row assigned to another member refused', $q$
  insert into public.tasks (id, organization_id, title, reporter_id, assignee_id, created_by)
  values ('T-SEC03-OTHER', public.default_org_id(), 'demo seed',
          auth.uid(), '22222222-2222-2222-2222-222222222222', auth.uid())
$q$);
select tests.expect_denied('UAT-SEC-03 Load demo: document overwrite of shared deliverables refused', $q$
  update public.workspace
     set tasks = jsonb_set(tasks, '{data,deliverables}', '[{"id":"DEMO"}]'::jsonb)
   where id = 'main'
$q$);

-- ---- "Clear all tasks" ----
select tests.expect_denied('UAT-SEC-03 Clear all: bulk delete of every organisation task refused',
  $q$delete from public.tasks$q$);
select tests.expect_denied('UAT-SEC-03 Clear all: deleting another member''s task refused',
  $q$delete from public.tasks where assignee_id <> auth.uid()$q$);
select tests.expect_denied('UAT-SEC-03 Clear all: deleting even their OWN task refused (no tasks.delete)',
  $q$delete from public.tasks where assignee_id = auth.uid()$q$);
-- Scoped to OTHER people's child rows on purpose: removing your own progress
-- entry on your own task is intended behaviour with a UI affordance
-- (app.jsx deleteProgress; policy "task_progress remove" allows user_id = self).
-- What "Clear all" must never reach is somebody else's.
select tests.expect_denied('UAT-SEC-03 Clear all: bulk delete of ANOTHER user''s child rows refused',
  $q$delete from public.task_progress where user_id <> auth.uid()$q$);
select tests.expect_denied('UAT-SEC-03 Clear all: bulk delete of ANOTHER user''s comments refused',
  $q$delete from public.task_comments where user_id <> auth.uid()$q$);
select tests.expect_denied('UAT-SEC-03 Clear all: emptying the document''s governance content refused', $q$
  update public.workspace set tasks = jsonb_set(jsonb_set(tasks,
      '{data,deliverables}', '[]'::jsonb), '{data,weeks}', '[]'::jsonb)
   where id = 'main'
$q$);
-- TRUNCATE is never governed by RLS — the only thing between a member and the
-- whole table is the GRANT, and schema.sql deliberately grants exactly
-- select/insert/update/delete (§3.2). This has to be asserted rather than
-- attempted, because TRUNCATE leaves row_count at 0 and so *looks* denied.
--
-- The harness is deliberately more permissive than a Supabase project here:
-- it does `alter default privileges … grant all`, which hands `authenticated`
-- TRUNCATE on everything it creates. Normalise the task tables to what
-- schema.sql actually grants, then assert — otherwise this measures the
-- harness, not the product.
reset role;
revoke truncate, references, trigger on
  public.tasks, public.task_checklist_items, public.task_progress,
  public.task_resources, public.task_comments, public.task_activity, public.workspace
  from authenticated, anon;
set role authenticated;
select tests.check('UAT-SEC-03: TRUNCATE is not granted to authenticated on any task table',
  not exists (select 1 from information_schema.role_table_grants
               where grantee = 'authenticated' and privilege_type = 'TRUNCATE'
                 and table_name in ('tasks','task_checklist_items','task_progress',
                                    'task_resources','task_comments','task_activity','workspace')),
  'still granted on: ' || coalesce((select string_agg(distinct table_name, ',')
                            from information_schema.role_table_grants
                           where grantee='authenticated' and privilege_type='TRUNCATE'
                             and table_name in ('tasks','task_checklist_items','task_progress',
                                    'task_resources','task_comments','task_activity','workspace')), 'none'));
select tests.expect_denied('UAT-SEC-03: TRUNCATE tasks is refused outright',
  $q$truncate public.tasks cascade$q$);
-- The bulk RPCs behind any "reset the workspace" idea are owner-gated.
select tests.expect_denied('UAT-SEC-03: member cannot run migrate_workspace_tasks',
  $q$select * from public.migrate_workspace_tasks(true)$q$);
select tests.expect_denied('UAT-SEC-03: member cannot run restore_workspace_tasks',
  $q$select public.restore_workspace_tasks(true)$q$);

-- Nothing above may have changed shared data.
select public.test_sign_in('44444444-4444-4444-4444-444444444444');
select tests.check('UAT-SEC-03: no demo row was written to the organisation',
  (select count(*) from public.tasks where id like 'T-SEC03-%') = 0);

-- Ordinary self-service is untouched: a member may still create their own work.
select public.test_sign_in('11111111-1111-1111-1111-111111111111');
select tests.expect_allowed('UAT-SEC-03: a member may still create a self-assigned task', $q$
  insert into public.tasks (id, organization_id, title, reporter_id, assignee_id, created_by)
  values ('T-SEC03-OK', public.default_org_id(), 'my own work', auth.uid(), auth.uid(), auth.uid())
$q$);

-- ============================================================
-- Owner protection survives multi-tenancy
-- ------------------------------------------------------------
-- protect_profile_privileges refuses to demote the last active owner by
-- counting the others. That count is an ordinary SELECT inside a SECURITY
-- INVOKER trigger, so RLS scopes it to what the caller may see — which is the
-- caller's own organization, and only because the profiles policies are
-- org-scoped. While "profiles owner manage" was unscoped the count spanned
-- every tenant, and another organization's owner satisfied it: Evbex's sole
-- owner could demote themselves and leave the organization with nobody able
-- to administer it. Verified — it succeeded before the scoping, and is
-- refused after.
reset role;   -- seeding a role needs table ownership; the checks below re-enter authenticated
alter table public.profiles disable trigger protect_profile_privileges;
update public.profiles set role = 'owner' where id = '55555555-5555-5555-5555-555555555555';
alter table public.profiles enable trigger protect_profile_privileges;
set role authenticated;

select public.test_sign_in('44444444-4444-4444-4444-444444444444');
select tests.check('owner protection: another tenant''s owner is not visible to this one',
  (select count(*) from public.profiles
    where role = 'owner' and status = 'active' and id <> auth.uid()) = 0);
select tests.expect_denied('owner protection: the last owner of an org cannot demote themselves', $q$
  update public.profiles set role = 'viewer' where id = auth.uid()
$q$);
select tests.expect_denied('owner protection: nor disable themselves', $q$
  update public.profiles set status = 'disabled' where id = auth.uid()
$q$);
select tests.check('owner protection: the organization still has its owner',
  (select role || '/' || status from public.profiles where id = auth.uid()) = 'owner/active');

-- Put the fixture back so the assertions below see the seeded shape.
reset role;
alter table public.profiles disable trigger protect_profile_privileges;
update public.profiles set role = 'member' where id = '55555555-5555-5555-5555-555555555555';
alter table public.profiles enable trigger protect_profile_privileges;
set role authenticated;

-- ============================================================
-- Re-apply safety (ADR 0008 — schema.sql is re-runnable by design)
-- ------------------------------------------------------------
-- verify-rls.mjs loads schema.sql twice before this file runs, so reaching
-- here at all already proves the second apply did not abort. What follows
-- proves the second apply did not RESURRECT anything either: §1 recreates the
-- Phase-1 `using (true)` profile read on every apply, and it is the later
-- §3 statement that must always be the one left standing. Postgres ORs
-- permissive policies together, so a surviving `using (true)` would silently
-- reopen the whole directory across tenants.
select tests.check('re-apply: exactly one client-facing profiles SELECT policy',
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and cmd = 'SELECT'
      and roles::text[] @> array['authenticated']) = 1);
select tests.check('re-apply: no permissive profiles SELECT policy survived',
  not exists (select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and cmd = 'SELECT'
      and roles::text[] @> array['authenticated'] and qual = 'true'));
select tests.check('re-apply: the surviving profiles policy is the org-scoped one',
  exists (select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and cmd = 'SELECT'
      and policyname = 'profiles read (same organization)'));
select tests.check('re-apply: no account has two personal workspaces',
  not exists (select owner_user_id from public.organizations
               where kind = 'personal' group by owner_user_id having count(*) > 1));

reset role;
select public.test_sign_out();

-- ============================================================
-- Advisor parity — rls_disabled_in_public
-- ------------------------------------------------------------
-- Supabase grants ALL on every table created in `public` to `anon` and
-- `authenticated` by default (harness.sql reproduces exactly that), so a table
-- in this schema is reachable over PostgREST the moment it exists, with the
-- committed anon key as the only credential. RLS is the ONLY thing between it
-- and the internet — which is what Supabase's `rls_disabled_in_public` lint is
-- telling us when it fires.
--
-- schema_markers is the table that got missed, because it holds no application
-- data — only the one-shot migration guards. That made it look harmless and it
-- is the opposite: deleting 'phase3_backfill_primary_org' re-arms
--     insert into organization_members select default_org_id(), id from profiles
-- so the operator's next (by-design re-runnable) apply of schema.sql sweeps
-- EVERY self-registered account into the primary tenant, where is_org_member()
-- and shares_org_with() then hand each of them the whole of it. The
-- mirror-image write is as bad: planting a marker key BEFORE a rollout
-- silently suppresses the migration that key guards.
--
-- Nothing outside the SQL editor ever reads this table, so the fix is the
-- workspace_task_archive shape — RLS on, no policy, grants revoked — and these
-- assertions are what keep it that way.
-- ============================================================
select tests.check('advisor: every table in public has RLS enabled',
  not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity),
  'unprotected: ' || coalesce((select string_agg(tablename, ', ' order by tablename)
                                 from pg_tables
                                where schemaname = 'public' and not rowsecurity), 'none'));

set role anon;
select tests.expect_denied('schema_markers: anon cannot read the migration guards', $q$
  select key from public.schema_markers
$q$);
select tests.expect_denied('schema_markers: anon cannot delete the Evbex back-fill guard', $q$
  delete from public.schema_markers where key = 'phase3_backfill_primary_org'
$q$);
select tests.expect_denied('schema_markers: anon cannot plant a guard to suppress a migration', $q$
  insert into public.schema_markers (key, note) values ('phase9_unrun', 'planted')
$q$);
reset role;

set role authenticated;
select public.test_sign_in('55555555-5555-5555-5555-555555555555');
select tests.expect_denied('schema_markers: a signed-in member cannot read the guards', $q$
  select key from public.schema_markers
$q$);
select tests.expect_denied('schema_markers: a signed-in member cannot delete a guard', $q$
  delete from public.schema_markers where key = 'phase3_personal_workspaces'
$q$);
reset role;
select public.test_sign_out();

-- And, as the operator: the guards that keep a re-apply from changing data are
-- both still there and still readable by the role that actually applies the
-- file. Locking a table down is only correct if it stays usable from inside.
select tests.check('re-apply: both one-shot back-fill markers are recorded',
  (select count(*) from public.schema_markers
    where key in ('phase3_backfill_primary_org', 'phase3_personal_workspaces')) = 2);
select tests.check('re-apply: no marker was planted by a client',
  (select count(*) from public.schema_markers) = 2);

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
