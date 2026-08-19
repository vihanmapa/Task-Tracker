#!/usr/bin/env node
/* ============================================================
   Phase 3 — auth bootstrap + task scope verification

   Three regressions this locks down:

   1. THE FIRST-LOGIN VIEWER RACE. The app used to render as soon as the
      session resolved, with role defaulting to 'viewer' while the profile
      and permission matrix were still loading — so a real Owner saw a
      Viewer UI until they refreshed. Asserted here as a truth table over
      the extracted state machine, plus static checks that auth-context.jsx
      actually uses it and no longer carries a 'viewer' fallback.

   2. THE CLIENT SCOPE MIRROR DRIFTING FROM THE POLICIES. window.taskScope
      shapes the UI; supabase/schema.sql enforces the truth. They are
      checked against ONE truth table here, and the SQL predicates are
      parsed to confirm they are built from the same three relationships.

   3. THE WRITE PLANNER SENDING MORE THAN IT SHOULD. An edit that doesn't
      touch priority must not send `priority` (the governance trigger would
      reject the whole write), and the append-only activity feed must never
      be re-sent from index 0.

   Run: node scripts/verify-auth-bootstrap.mjs   (exit 0 = all hold)
   ============================================================ */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(root, p), 'utf8');

const bootstrapJs = await read('fm-navigate/auth-bootstrap.js');
const taskStoreJs = await read('fm-navigate/task-store.js');
const authContext = await read('fm-navigate/auth-context.jsx');
const appJsx = await read('fm-navigate/app.jsx');
const composeJsx = await read('fm-navigate/ai-compose.jsx');
const sql = await read('supabase/schema.sql');

globalThis.window = globalThis;
new Function(bootstrapJs)();
new Function(taskStoreJs)();
const { authBootstrap, taskScope, taskStore } = globalThis;

const fails = [];
const check = (cond, msg) => { console.log((cond ? '  ok  ' : ' FAIL ') + msg); if (!cond) fails.push(msg); };

/* ---------- 1. Bootstrap state machine ---------- */
console.log('\nauth bootstrap — the app renders only when identity is fully resolved');

const P = 'pending', S = 'settled';
const ready = (o) => authBootstrap.computeReady(o);

check(ready({ shared: false }) === true,
  'local-only mode is ready immediately (no backend, no roles)');
check(ready({ shared: true, authUser: undefined, profileState: P, rbacState: P }) === false,
  'session still resolving → NOT ready');
check(ready({ shared: true, authUser: null, profileState: P, rbacState: P }) === true,
  'signed out → ready (the login screen needs no profile)');
check(ready({ shared: true, authUser: { id: 'u' }, profileState: P, rbacState: P }) === false,
  'signed in, profile pending → NOT ready  ← the Viewer race');
check(ready({ shared: true, authUser: { id: 'u' }, profileState: S, rbacState: P }) === false,
  'signed in, profile settled but permissions pending → NOT ready');
check(ready({ shared: true, authUser: { id: 'u' }, profileState: P, rbacState: S }) === false,
  'signed in, permissions settled but profile pending → NOT ready');
check(ready({ shared: true, authUser: { id: 'u' }, profileState: S, rbacState: S }) === true,
  'signed in, profile + permissions settled → ready');

check(authBootstrap.roleOf({ shared: true, authUser: { id: 'u' }, profile: null }) === null,
  'role is null (never "viewer") while the profile is unresolved');
check(authBootstrap.roleOf({ shared: true, authUser: { id: 'u' }, profile: { role: 'owner' } }) === 'owner',
  'role comes from the profile once resolved');
check(authBootstrap.roleOf({ shared: false }) === 'owner',
  'local-only mode still has full access');
check(authBootstrap.stageLabel({ shared: true, authUser: { id: 'u' }, profileState: P, rbacState: P }) === 'Loading your profile…',
  'a pending stage is named, so a slow one is diagnosable');

/* ---------- 2. The provider actually uses it ---------- */
console.log('\nauth context — no provisional role can reach the UI');

check(/window\.authBootstrap|authBootstrap\./.test(authContext),
  'auth-context.jsx derives its state from authBootstrap');
check(!/\(authUser\s*\?\s*'viewer'\s*:/.test(authContext) && !/\|\|\s*'viewer'/.test(authContext),
  "auth-context.jsx has no 'viewer' role fallback left");
check(/const ready = window\.authBootstrap\.computeReady\(/.test(authContext) && /^\s*ready,\s*$/m.test(authContext),
  'the provider computes ready from the state machine and exposes it');
check(/if\s*\(shared\s*&&\s*!ready\)|!ready\s*\)\s*\{?\s*return/.test(appJsx) || /authReady|bootstrapReady/.test(appJsx),
  'app.jsx blocks rendering until the provider reports ready');

/* ---------- 3. Client scope mirror vs the SQL predicates ---------- */
console.log('\ntask scope — the UI mirror answers exactly like the policies');

// The SQL predicates, as shipped.
const defOf = (name) => {
  const i = sql.indexOf(`create or replace function public.${name}(`);
  return sql.slice(i, sql.indexOf('$$;', i));
};
for (const [name, cap] of [['task_read_ok', 'tasks.read'], ['task_write_ok', 'tasks.execute']]) {
  const body = defOf(name);
  check(body.includes(`authorize('${cap}')`), `${name} requires ${cap}`);
  check(body.includes('is_org_member(p_org)'), `${name} checks the organization boundary`);
  check(body.includes('p_assignee = auth.uid()'), `${name} accepts the assignee`);
  check(body.includes("authorize('tasks.view_all')"), `${name} accepts management scope`);
  // ADR 0007: reporter is metadata. Its absence here is the whole correction,
  // so assert the absence rather than trusting a comment.
  check(!/p_reporter|reporter_id/.test(body), `${name} does NOT grant access via reporter`);
  check(!/\btrue\b/.test(body.replace(/returns boolean/g, '')), `${name} has no unconditional true branch`);
}
// The policies must pass only the two arguments the predicate now takes.
check(!/task_read_ok\([^)]*reporter_id/.test(sql) && !/task_write_ok\([^)]*reporter_id/.test(sql),
  'no task policy still passes reporter_id into a scope predicate');

const ME = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const mine = { id: 'T-1', assigneeId: ME, reporterId: ME, ownerId: ME };
const delegatedToMe = { id: 'T-2', assigneeId: ME, reporterId: OTHER, ownerId: ME };
const raisedByMe = { id: 'T-3', assigneeId: OTHER, reporterId: ME, ownerId: OTHER };
const theirs = { id: 'T-4', assigneeId: OTHER, reporterId: OTHER, ownerId: OTHER };

const standard = { userId: ME, canRead: true, canExecute: true, canCreate: true,
  canViewAll: false, canAssign: false, canPrioritize: false, canDelete: false, canGovern: false };
const management = { ...standard, canViewAll: true, canAssign: true, canPrioritize: true, canDelete: true };
const noReads = { ...standard, canRead: false, canExecute: false };

check(taskScope.canRead(mine, standard) === true, 'standard user reads their own task');
check(taskScope.canRead(delegatedToMe, standard) === true, 'standard user reads a task delegated to them');
check(taskScope.canRead(raisedByMe, standard) === false,
  'standard user CANNOT read a task they raised but no longer own  ← ADR 0007');
check(taskScope.canWrite(raisedByMe, standard) === false,
  'standard user CANNOT execute a task they raised but no longer own');
check(taskScope.canRead(raisedByMe, management) === true,
  'management still reads it — through view_all, not through reporter');
check(taskScope.isMine(raisedByMe, standard) === false,
  '"mine" means assigned to me, never reported by me');
check(taskScope.canRead(theirs, standard) === false, "standard user CANNOT read another person's task");
check(taskScope.canRead(theirs, management) === true, 'management reads any task');
check(taskScope.canRead(mine, noReads) === false, 'without tasks.read nothing is readable (fail closed)');

check(taskScope.canWrite(mine, standard) === true, 'standard user works their own task');
check(taskScope.canWrite(theirs, standard) === false, "standard user CANNOT write another person's task");
check(taskScope.canWrite(theirs, management) === true, 'management writes any task');
check(taskScope.canWrite(mine, { ...standard, canExecute: false }) === false,
  'without tasks.execute nothing is writable');

check(taskScope.canCreateFor(ME, standard) === true, 'standard user creates a task for themselves');
check(taskScope.canCreateFor(OTHER, standard) === false, 'standard user CANNOT create a task for someone else');
check(taskScope.canCreateFor(OTHER, management) === true, 'management creates a task for another member');
check(taskScope.canCreateFor(ME, { ...standard, canCreate: false }) === false,
  'without tasks.create nothing can be created');

check(taskScope.fieldAllowed(mine, 'ownerId', standard) === false, 'standard user cannot change the assignee');
check(taskScope.fieldAllowed(mine, 'priority', standard) === false, 'standard user cannot change priority');
check(taskScope.fieldAllowed(mine, 'reporterId', management) === false, 'nobody can change the reporter');
check(taskScope.fieldAllowed(mine, 'title', standard) === true, 'standard user edits their own task fields');
check(taskScope.fieldAllowed(theirs, 'title', standard) === false, "standard user cannot edit another person's fields");
check(taskScope.fieldAllowed(theirs, 'ownerId', management) === true, 'management reassigns');
check(taskScope.canDelete(mine, standard) === false, 'standard user cannot delete (no tasks.delete)');
check(taskScope.canDelete(theirs, management) === true, 'management deletes within scope');

const all = [mine, delegatedToMe, raisedByMe, theirs];
check(taskScope.visible(all, standard).length === 2,
  'personal view shows only what is ASSIGNED to me (own + delegated to me)');
check(taskScope.visible(all, standard).every(t => t.assigneeId === ME),
  'nothing in the personal view is somebody else\'s work');
check(taskScope.visible(all, management).length === 4, 'management view shows everything');
check(taskScope.mine(all, standard).map(t => t.id).join(',') === 'T-1,T-2',
  'My Tasks = assigned to me (a task I delegated away is not on my list)');

/* ---------- 3b. Signup does not join an existing organization ---------- */
console.log('\nsignup — an account is not a membership (ADR 0008)');

// LAST definition wins at runtime — schema.sql defines a minimal Phase-1
// version early and replaces it in Phase 3. Assert on the effective one.
const hnuStart = sql.lastIndexOf('create or replace function public.handle_new_user');
const handleNewUser = sql.slice(hnuStart, sql.indexOf('drop trigger if exists on_auth_user_created', hnuStart));
check(hnuStart > sql.indexOf('-- ---------- 3.7 Self-registration'),
  'the effective handle_new_user is the Phase-3 one');
check(!/default_org_id\(\)/.test(handleNewUser),
  'handle_new_user never joins the primary organization');
check(/kind[^,]*,\s*owner_user_id|'personal'/.test(handleNewUser),
  'handle_new_user creates the account its OWN personal workspace instead');
check(/v_role text := 'member'/.test(handleNewUser),
  "the role is hardcoded to 'member', not read from client metadata");
check(!/raw_user_meta_data->>'role'|raw_user_meta_data->>'organization/.test(handleNewUser),
  'no privilege field is ever read from the signup payload');
check(/raw_user_meta_data->>'name'/.test(handleNewUser),
  'only the display name comes from the client');

const addMember = sql.slice(sql.indexOf('create or replace function public.add_organization_member'),
  sql.indexOf('revoke execute on function public.add_organization_member'));
check(addMember.indexOf("authorize('users.assign_roles')") < addMember.indexOf('insert into public.organization_members'),
  'add_organization_member authorizes BEFORE it writes');
check(/set search_path = public, pg_temp/.test(addMember),
  'add_organization_member locks its search_path');
check(!/create policy[^;]*on public\.organization_members for insert/.test(sql),
  'organization_members has no INSERT policy — the RPC is the only way in');

/* ---------- 3c. Every SECURITY DEFINER function is locked down ---------- */
console.log('\nSECURITY DEFINER audit');
for (const m of sql.matchAll(/create or replace function (public\.[a-z_]+)\(([^)]*)\)[\s\S]*?\$(?:fn|do|)\$/g)) {
  const decl = m[0];
  if (!/security definer/i.test(decl)) continue;
  const fn = m[1];
  check(/set search_path = public(, pg_temp)?/.test(decl), `${fn} locks its search_path`);
}
// Anything DEFINER that mutates or reads privileged data must not be callable
// by anon, and the mutating ones must authorize first.
for (const fn of ['migrate_workspace_tasks', 'verify_task_migration', 'archive_workspace_tasks',
                  'restore_workspace_tasks', 'add_organization_member', 'remove_organization_member']) {
  check(new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon`).test(sql),
    `${fn} is revoked from anon`);
  const body = sql.slice(sql.indexOf(`create or replace function public.${fn}`));
  check(/if not public\.authorize\('[a-z_.]+'\) then/.test(body.slice(0, 900)),
    `${fn} authorizes before doing anything`);
}
check(/revoke execute on function public\.map_legacy_user\(text\) from public, anon, authenticated/.test(sql),
  'map_legacy_user is not callable by any client (no account-probing oracle)');

/* ---------- 4. UI enforces "no assignee picker for standard users" ---------- */
console.log('\ntask forms — the assignee control exists only with tasks.assign');

check(/canAssign/.test(composeJsx), 'the composer gates its owner/assignee control on canAssign');
check(/canAssign\s*\?/.test(composeJsx) || /canAssign\s*&&/.test(composeJsx),
  'the composer renders the picker conditionally rather than always');

/* ---------- 5. The write planner ---------- */
console.log('\nwrite planner — sends the minimum, appends activity only');

const ctx = { userId: ME, organizationId: '00000000-0000-0000-0000-000000000001' };
const before = {
  id: 'T-9', title: 'Draft', status: 'In Progress', priority: 'Medium', progress: 20,
  ownerId: ME, assigneeId: ME, reporterId: ME, createdAt: '2026-01-01T00:00:00.000Z',
  checklist: [{ id: 'c1', title: 'one', done: false }],
  progressLog: [], resources: [], comments: [],
  activity: [{ type: 'created', userId: ME, at: '2026-01-01T00:00:00.000Z' }],
};
const after = {
  ...before, status: 'Completed', progress: 100,
  checklist: [{ id: 'c1', title: 'one', done: true }, { id: 'c2', title: 'two', done: false }],
  progressLog: [{ id: 'p1', percent: 100, status: 'Completed', userId: ME, at: '2026-02-01T00:00:00.000Z' }],
  activity: [...before.activity, { type: 'completed', userId: ME, at: '2026-02-01T00:00:00.000Z' }],
};

const p1 = taskStore.plan([before], [after], ctx);
check(p1.updates.length === 1, 'a changed task produces one update');
const patch = p1.updates[0].patch;
check('status' in patch && 'progress' in patch, 'the update carries the fields that changed');
check(!('priority' in patch), 'the update does NOT carry priority — an untouched field never trips tasks.prioritize');
check(!('assignee_id' in patch), 'the update does NOT carry assignee_id — an untouched field never trips tasks.assign');
check(!('reporter_id' in patch) && !('organization_id' in patch) && !('id' in patch),
  'immutable columns are never sent in an update');
check(p1.activity.length === 1 && p1.activity[0].seq === 1,
  'only the NEW activity entry is sent, at its real sequence (append-only)');
const cl = p1.children.find(c => c.kind === 'checklist');
check(cl && cl.upsert.length === 2 && cl.remove.length === 0,
  'the changed and the new checklist item are upserted, nothing removed');
const pr = p1.children.find(c => c.kind === 'progress');
check(pr && pr.upsert.length === 1, 'the new progress entry is written');

const created = taskStore.plan([], [after], ctx);
check(created.creates.length === 1, 'a new task produces one insert');
check(created.creates[0].reporter_id === ME && created.creates[0].created_by === ME,
  'a new task is reported and created by the signed-in user');
check(created.creates[0].organization_id === ctx.organizationId, 'a new task carries its organization');
check(created.activity.length === 2, 'a new task sends its whole activity feed once');

const removed = taskStore.plan([before], [], ctx);
check(removed.deletes.length === 1 && removed.deletes[0] === 'T-9', 'a removed task produces one delete');

const unchanged = taskStore.plan([before], [before], ctx);
check(!unchanged.creates.length && !unchanged.updates.length && !unchanged.deletes.length &&
      !unchanged.children.length && !unchanged.activity.length,
  'an unchanged list writes nothing at all');

const legacy = taskStore.plan([], [{ ...before, ownerId: 'vihan', assigneeId: null, reporterId: null }], ctx);
check(legacy.creates[0].assignee_id === null && legacy.creates[0].legacy_owner === 'vihan',
  'an unmapped legacy owner key is preserved, never written as an assignee');

/* ---------- report ---------- */
if (fails.length) {
  console.error(`\n✗ ${fails.length} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\n✓ auth bootstrap, task scope mirror and write planner all hold');
