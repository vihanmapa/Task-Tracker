# TDD — Personal Task Workspaces (Phase 3)

**Status:** approved blueprint · implemented on `claude/jira-personal-workspaces-yc424y`
**Supersedes nothing.** Extends `docs/TDD-ROLES-PERMISSIONS.md` (Phase 2 RBAC, live).
**Date:** 2026-08

---

## 1. Summary

Phase 2 made permissions *data*: a role's capabilities live in `role_permissions`
and RLS asks `authorize('<key>')` at query time. It answered **"may this role do
this?"** — but not **"on which task?"**, because every task still lived inside one
shared `workspace` jsonb document. A document has no rows, so Postgres cannot
enforce per-task privacy.

Phase 3 adds the missing half:

```text
RBAC            → may this user perform this capability?      (Phase 2, unchanged)
Object relation → is this task theirs?                        (new: assignee)
Organization    → is this task even in their tenant?          (new: organizations)
RLS             → enforces both, in Postgres                  (new: normalized tables)
```

It also opens the product up: anyone can **self-register**, lands in their **own
personal task workspace**, and management roles get **cross-user visibility and
assignment** — configurable at runtime from the existing Roles & Permissions
screen, not in code.

---

## 2. Goals

1. Self-signup with least-privilege defaults that cannot be escalated by the client.
2. Every user gets a personal task tracker: their own tasks, their own dashboard.
3. A standard user cannot read, modify, or assign another person's tasks — enforced
   by Postgres, not by React.
4. Management roles (owner, executive, product_manager by default) can see all
   organization tasks, create tasks for others, assign and reassign.
5. Reporter and Assignee are first-class and distinct.
6. Explicit organization/tenant ownership on every task; cross-org access denied
   for every role including owner.
7. Existing production data survives, with a deterministic, idempotent, verifiable
   migration and preserved task ids.
8. No regression to Phase 2 RBAC and no big-bang deploy.

## 3. Non-goals

Teams/sub-teams, per-project permission schemes, multi-org switching UI,
notification engine, time tracking, workflow designer, custom role conditions UI,
normalising deliverables / weekly plans / KPI scores. The schema is *shaped* so
teams and multi-org can arrive later without a rewrite; nothing more is built now.

---

## 4. Current architecture (before this increment)

- **Storage:** one row, `workspace('main')`, whose `tasks` jsonb column holds
  `{version, metadata, data:{tasks, deliverables, weeks, kpiScores}}` (see
  `ARCHITECTURE.md`, ADR 0001).
- **Auth:** Supabase Auth, **email + password**. `custom_access_token_hook` stamps
  `user_role` into every access token; `public.jwt_role()` reads it.
- **AuthZ:** `permissions` (41 keys, 12 enforced) → `role_templates` →
  `template_permissions` → `roles` (12) → `role_permissions` (191 grants) →
  `authorize(key)` called from RLS.
- **Client:** static, precompiled globals (`build.mjs` concatenates
  `fm-navigate/*.js{,x}`); `window.RBAC` mirrors the matrix for UI gating;
  `window.dataService` owns all persistence.
- **Honest limit (schema.sql §2.9):** the only DB-enforceable task gate is
  "may write the blob at all" (`tasks.execute`). Everything finer is app-side.

**That limit is exactly what this phase removes for tasks.**

---

## 5. Identity / organization model

### 5.1 Decision D4 — explicit tenant column, membership table, one seeded org

```text
organizations(id, slug, name, created_at)
organization_members(organization_id, user_id, joined_at)   -- PK(org, user)
tasks.organization_id  → organizations.id                   -- NOT NULL
```

Membership is the **only** source of truth for "who is in which org". Profiles do
*not* carry an org column — two stores would drift. Lookups go through one
SECURITY DEFINER helper:

```sql
public.is_org_member(uuid) → boolean        -- membership for auth.uid()
public.shares_org_with(uuid) → boolean      -- backs the profile directory read
public.default_org_id()    → uuid           -- the PRIMARY org; not used by signup
```

`is_org_member` is DEFINER so policies never recurse into
`organization_members`' own RLS, and so the check costs one index probe.

**Revised by ADR 0008.** The primary (Evbex / FM Navigate) organization is
seeded with the fixed uuid `00000000-0000-0000-0000-000000000001`
(deterministic ⇒ idempotent), and every account that existed before this phase
was back-filled into it **once**, behind a marker row.

Self-signup does **not** join it. Every account instead gets its own
organization with `kind = 'personal'`, and joining a team organization requires
`add_organization_member()` — see §10.1. So there are now two kinds of
organization:

```sql
organizations.kind = 'team'      -- Evbex; membership granted deliberately
organizations.kind = 'personal'  -- one per account, its own private tracker
```

Multi-org *switching UI* is still not built; the schema supports it (everyone
has at least two organizations now) and the client picks the team one when
deciding where a new task belongs.

### 5.2 Profile visibility

`profiles` SELECT was `using (true)` — every signed-in user could read every
profile. It is now scoped to *self + same-organization members*, so an assignee
picker can never surface another tenant's people. Self is always readable so a
user with no membership row yet (mid-signup) can still load their own profile.

**Profile administration is scoped the same way**, and scoping the read alone
was not enough. The Phase-2 policy `profiles owner manage` is
`for all using (authorize('users.assign_roles'))` with no organization
predicate — correct while there was one tenant. Because Postgres ORs
permissive policies together, that `ALL` policy also answers SELECT, so it
defeated the scoped read above: an administrator of one organization could
list every account on the platform (including every public signup's email),
re-role another tenant's owner, and delete their profile row. Both clauses now
carry the tenant predicate as well as the capability.

That also restores **owner protection** under multi-tenancy.
`protect_profile_privileges` refuses to demote the last active owner by
counting the others, and that count is an ordinary SELECT inside a SECURITY
INVOKER trigger — so RLS scopes it to the caller's own organization, but only
once these policies are org-scoped. While the administration policy was
unscoped the count spanned every tenant, and any other organization's owner
satisfied it: an organization's sole owner could demote themselves and leave
nobody able to administer it.

---

## 6. Task data model

### 6.1 Decision D2 — normalize tasks, leave the rest of the document alone

Only the entities that need row-level security are normalized. Deliverables,
weekly plans and KPI scores stay in the workspace document: they are
organization-wide governance content, already gated by `admin.workspace`, and
normalising them buys no privacy.

```text
tasks                      one row per task, id preserved ('T-142')
 ├── task_checklist_items   sub-items, completion stamps, per-item notes/links
 ├── task_progress          the progress log (percent, status, note, evidence)
 ├── task_resources         links/files attached to the task
 ├── task_comments          task comments (normalized out of task.comments)
 └── task_activity          per-task event stream (created/status/progress/…)
```

`activity_log` (the Phase-2 append-only **security** audit) is untouched and is
*additionally* written by DB triggers for the six task events in §13 — business
activity lives in `task_activity`, security audit in `activity_log`, no duplication
of the *same* record.

### 6.2 Decision D8 — value lists stay jsonb

`dependencies` (free-text labels), `dep_task_ids`, per-entry `links` / `files`,
and the field-edit history `edits` remain jsonb columns. They are *values of a
task*, not independently secured entities: they are always read and written with
their parent row, so a separate table would add joins and migrations for zero
security gain.

### 6.3 Columns

```text
tasks(
  id text PK,                    -- 'T-142' preserved from the document
  organization_id uuid NOT NULL,
  title text NOT NULL, description text,
  reporter_id uuid, assignee_id uuid,          -- → profiles(id)
  status text, priority text, category text, effort text,
  progress int, due_date timestamptz,
  deliverable_id text,                          -- soft ref into the blob
  success_criteria text, risk text,
  dependencies jsonb, dep_task_ids jsonb, edits jsonb,
  created_at, updated_at, completed_at,
  created_by uuid, updated_by uuid,
  legacy_owner text                             -- unmapped pre-migration owner key
)
```

`legacy_owner` exists **only** so the migration is lossless when a legacy owner
key (`'vihan'`) has no matching profile. It is display/forensic data and grants
nothing.

---

## 7. Reporter vs Assignee

| | meaning | who sets it |
|---|---|---|
| `reporter_id` | who created / raised the task — **metadata, not scope** (ADR 0007) | server-side = `auth.uid()` at insert; immutable |
| `assignee_id` | who is responsible for completing it | self at insert; changed only with `tasks.assign` |

- Standard user creating a task: `reporter_id = assignee_id = auth.uid()` — the
  DB refuses anything else.
- Management creating for someone else: `reporter_id = auth.uid()`,
  `assignee_id = <member>` — allowed only with `tasks.assign`.
- Reassignment = changing `assignee_id`; also `tasks.assign`.

### Decision D3 — `ownerId` becomes a client alias of assignee

The whole UI (`tasks.jsx`, `weekly.jsx`, `dashboard.jsx`, exports…) reads
`task.ownerId`. Rather than a ~40-call-site rename, the data layer hydrates
`ownerId === assigneeId` and maps writes of `ownerId` back onto `assignee_id`.
`reporterId` is added alongside and surfaced in the task detail. Backward
compatible, and the DB has the clean two-column model the requirement asks for.

---

## 8. Authorization model

### 8.1 Decision D1 — `tasks.view_all` (Option B), not scoped grants (Option A)

Option A (adding a `scope` column to grants) changes the *shape* of
`role_permissions` and of `authorize()` — the production-tested Phase-2 core, and
every consumer of it (the admin screen, the parity verifier, the client matrix
loader). Option B adds one row to a catalog that is explicitly append-only.

**Chosen: one new capability key.**

```text
tasks.view_all   Tasks · governance · "View all tasks in the organization"
```

Everything else reuses existing keys:

| capability | key | notes |
|---|---|---|
| see tasks at all | `tasks.read` | now RLS-enforced, was client-only |
| create a task | `tasks.create` | now RLS-enforced, was Planned |
| work a task (progress/status/checklist/evidence) | `tasks.execute` | unchanged |
| assign / reassign / create for another person | `tasks.assign` | unchanged |
| change priority | `tasks.prioritize` | unchanged |
| delete | `tasks.delete` | unchanged |
| **see other people's tasks** | `tasks.view_all` | **new** |

No `tasks.edit_own` / `_assigned` / `_team` explosion: *scope comes from the
object relationship*, not from more permission keys. That is the core principle
of the whole increment.

Seeded to `executive`, `delivery_management` (Product Manager) and — via
`everything` — `owner`. **Management is never derived from `job_title`**, and an
owner can hand `tasks.view_all` to any other role from Settings → Roles &
Permissions with no deployment.

### 8.2 The rules (revised — ADR 0007)

```text
READ    org member(task.org) AND authorize('tasks.read')
        AND (assignee = me OR authorize('tasks.view_all'))

CREATE  org member(task.org) AND authorize('tasks.create')
        AND reporter = me AND created_by = me
        AND (assignee = me OR authorize('tasks.assign'))

UPDATE  org member(task.org) AND authorize('tasks.execute')
        AND (assignee = me OR authorize('tasks.view_all'))
        + column rules (trigger): assignee needs tasks.assign,
                                  priority needs tasks.prioritize,
                                  org/reporter/id immutable

DELETE  visible-for-read AND authorize('tasks.delete')

CHILD ROWS (checklist / progress / resources / comments / activity)
        inherit: readable iff the parent task row is readable,
                 writable iff the parent task row is writable
```

**Reporter is deliberately absent from READ and UPDATE.** The first
implementation included it, which meant a standard user kept read and execute
rights over work that had since been handed to somebody else — permanently, and
with no way for a manager to take it back. Who raised a task is a fact about its
origin; seeing across people is `tasks.view_all`. Reporter is still recorded,
still pinned to `auth.uid()` at insert, still immutable, still displayed. See
ADR 0007.

Child inheritance is written as `exists (select 1 from public.tasks t where
t.id = task_id)` — inside a policy, Postgres applies `tasks`' own RLS to that
subquery, so the parent's rules are the child's rules *by construction* and can
never drift out of sync.

Column-level rules live in a `BEFORE UPDATE` trigger (`protect_task_governance`)
because a `WITH CHECK` expression cannot see `OLD`. Same pattern as the existing
`protect_profile_privileges`.

### 8.3 Fail-closed

No policy has a `true` branch. `authorize()` returns false for an unknown key or
missing grant. A user with no organization membership sees zero tasks. The client
mirrors these rules for UI shaping only (`window.taskScope`), and the mirror is
unit-tested against the same truth table the SQL implements.

---

## 9. RLS rules — the test matrix

| actor | operation | expected |
|---|---|---|
| standard | SELECT own assigned task | allow |
| standard | SELECT another user's task | **deny** |
| standard | SELECT a task they RAISED but no longer own | **deny** (ADR 0007) |
| standard | UPDATE a task they RAISED but no longer own | **deny** (ADR 0007) |
| standard | read the audit log / comments / legacy map for another's task | **deny** (ADR 0009) |
| standard | INSERT self-assigned | allow |
| standard | INSERT assigned to another | **deny** |
| standard | UPDATE own assigned | allow |
| standard | UPDATE another's task | **deny** |
| standard | change `assignee_id` | **deny** |
| standard | change `priority` | **deny** (no `tasks.prioritize`) |
| standard | INSERT with forged `reporter_id` | **deny** |
| standard | DELETE own task | **deny** (no `tasks.delete`) |
| standard | read another's checklist/progress/comment rows | **deny** |
| management | SELECT any task in own org | allow |
| management | INSERT for another member | allow |
| management | reassign | allow |
| management | change priority | allow |
| any role incl. owner | anything in **another org** | **deny** |
| public signup | anything belonging to the primary organization | **deny** (ADR 0008) |
| public signup | create and work a task in their own personal workspace | allow |
| administrator | admit a user to a team organization | allow |
| owner | administration (roles, profiles, permissions) | unchanged |

Run: `npm run verify:rls` (spins a throwaway Postgres, loads the real
`schema.sql`, asserts every row above).

---

## 10. Signup flow

`LoginScreen` gains a Create-account tab → `dataService.signUp(email, password,
name)` → `supabase.auth.signUp`. **The existing authentication mechanism is
preserved: Supabase Auth, email + password.** (There is no mobile-number
verification in this application — `signInWithPassword` is the only auth path in
`data-service.js`; nothing is converted.)

Server side, `handle_new_user()` (AFTER INSERT on `auth.users`, SECURITY DEFINER)
now:

1. creates the profile with `role = 'member'` — **hardcoded in the trigger**, never
   read from `raw_user_meta_data`;
2. takes only `name` from client metadata (a display string, grants nothing);
3. creates the account's **own personal workspace** (an organization with
   `kind = 'personal'`) and makes it the only member;
4. joins **no existing organization** (ADR 0008).

### 10.1 Signup is not membership (ADR 0008)

The first implementation auto-joined the primary organization here, which meant
anyone who could reach the signup form became an Evbex workspace member — with
a safe role, but able to see the organization's people, document and governance
screens. Creating an account and joining a company are different facts.

A personal workspace is an ordinary organization, so every task policy, the
tenant boundary and the whole client work there unchanged — no second code path,
no nullable `organization_id`, no special case in RLS. It is what keeps "anyone
can have their own task tracker" true without handing anyone somebody else's
work.

Joining a team organization requires `add_organization_member(org, user)`:
`authorize('users.assign_roles')` before any write, refuses an organization the
caller is not in, refuses a personal workspace. `organization_members` has no
INSERT policy at all, so that function is the only way in; an email invitation
flow can later call it without moving the boundary.

Two guards protect the existing installation:

- the Evbex back-fill is **one-shot behind a marker row** (`schema_markers`).
  `schema.sql` is re-runnable by design, and an unguarded
  `insert … select from profiles` would have swept every public account into
  Evbex the next time anyone applied the file. The marker table is therefore a
  tenancy control, not bookkeeping, and is locked down like one: RLS on, no
  policy, default grants revoked. It held no application data, so it was the
  one table in `public` that never got RLS — and a guard anyone can delete over
  PostgREST is not a guard, because the deletion re-arms the back-fill and the
  runbook's first rollout step is to apply this file again;
- every pre-existing account also gets a personal workspace, so the model is
  uniform rather than split between old and new users.

A user in both a team organization and their personal one creates tasks in the
**team** one — staff work in Evbex, public users in their own tracker.

The client sends exactly `{ name }`. Even a tampered client that posts
`{role:'owner', organization_id:…, is_management:true}` changes nothing: the
trigger ignores metadata for privilege fields, and `protect_profile_privileges`
already rejects any later self-service role change (`users.assign_roles` required).

### The `member` role (Decision D5)

`viewer` cannot execute tasks, so a self-registered user would land in a workspace
where they cannot create their own work — the requirement explicitly rules that
out. A new system role `member` (template `personal_execution`) is seeded:

```text
member: tasks.read, tasks.create, tasks.execute, tasks.edit, tasks.link,
        comments.read, comments.write, users.read
```

No `tasks.view_all`, no `tasks.assign`, no `tasks.prioritize`, no `tasks.delete`,
no `admin.*`, and — deliberately — **no** `deliverables.read` / `weekly.read` /
`kpi.read` / `reports.read`, so the org-wide governance screens do not even appear
in their navigation. This is the one template excluded from the "common reads"
cross-join in `schema.sql` §2.2 (mirrored in the parity verifier).

---

## 11. Personal dashboard

Built on the **existing** widget registry (`dashboard.jsx`, TDD-ROLES §7.3): a
composition is a list of widget keys; a widget renders iff the role holds every
permission in its `requires`. Two compositions are added — `personal` (default)
and `management` (selected when the user holds `tasks.view_all`).

`personal`: My Tasks · Due Today · Overdue · In Progress · Blocked ·
Waiting/Pending · Recently Completed · My Weekly Progress · Recently Updated.

Every personal widget filters on `assigneeId === me` **client-side over data the
database already scoped to this user** — for a standard user RLS returns only
their own rows, so the filter is presentation, not privacy.

## 12. Management dashboard

`management`: Organization Snapshot (active/blocked/overdue/unassigned) ·
Needs Attention (all) · Work by Person (workload bars) · Unassigned · Overdue ·
Due Soon · Recently Completed · Task Activity.

Drill-down: a new **People** screen (nav item gated on `tasks.view_all`) lists
organization members with per-person counts → clicking a person opens the Tasks
screen filtered to them. No new analytics product; operational oversight only.

---

## 13. Audit / activity

DB triggers on `tasks` write both streams, so nothing depends on the client
remembering to log:

| event | when |
|---|---|
| `task_created` | INSERT |
| `task_assigned` | INSERT with an assignee |
| `task_reassigned` | `assignee_id` changed |
| `task_status_changed` | `status` changed |
| `task_priority_changed` | `priority` changed |
| `task_completed` | status → `Completed` |

`task_activity` carries the per-task feed the UI renders; `activity_log` gets the
same six events for the organization audit trail. Permission/role administration
keeps using the Phase-2 triggers unchanged.

## 14. Realtime

`tasks` and its child tables join `supabase_realtime`. Realtime respects RLS, so a
standard user's subscription only ever yields their own rows — the client does not
subscribe to an org-wide stream. Permission-change propagation
(`subscribeRolePermissions`) is untouched.

---

## 15. Migration strategy

### 15.1 Decision D7 — explicit, idempotent, operator-run

`public.migrate_workspace_tasks(p_commit boolean default false)` reads
`workspace('main') → data.tasks` and writes normalized rows. It is:

- **idempotent** — every insert is `on conflict (id) do nothing`; re-running is a
  no-op, so a partial run is safely resumable;
- **non-destructive** — the workspace document is *not* modified; tasks stay in the
  blob as a fallback until the normalized path is verified in production;
- **dry-run by default** — `p_commit => false` reports what it *would* write;
- **owner-gated** — `authorize('admin.restore')`, revoked from `anon`;
- **never automatic** — no client code calls it.

### 15.2 Mapping

| document field | column | rule |
|---|---|---|
| `id` | `id` | preserved verbatim |
| `ownerId` | `assignee_id` | uuid → itself if it is a real profile; legacy key → `legacy_user_map`; else NULL + `legacy_owner` kept |
| `activity[type='created'].userId` | `reporter_id` | same mapping; falls back to assignee |
| `status`,`priority`,`category`,`effort`,`progress`,`dueDate`,`completedAt`,`createdAt`,`updatedAt`,`successCriteria`,`risk`,`deliverableId` | 1:1 | |
| `checklist[]` | `task_checklist_items` | id preserved |
| `progressLog[]` | `task_progress` | id preserved, evidence links/files kept |
| `resources[]` | `task_resources` | id preserved |
| `comments[]` | `task_comments` | id preserved |
| `activity[]` | `task_activity` | preserved, ordered by `at` |
| `edits[]` | `tasks.edits` jsonb | preserved |

`legacy_user_map(legacy_key, user_id)` is seeded by the operator (one INSERT per
legacy key, documented in `docs/RBAC-SETUP.md`). Unmapped owners produce
**unassigned** tasks — visible to management (who can then assign them from the
Unassigned widget), never silently handed to the wrong person.

### 15.3 Verification

`public.verify_task_migration()` returns document-vs-table counts for tasks,
checklist items, progress entries, resources, comments and activity, plus the
number of preserved ids, unmapped owners and org-less rows. Green = every count
matches and `unmapped_owner_count` is acceptable to the operator.

---

## 16. Backward compatibility

- **Two task backends, chosen at runtime.** `dataService.detectTaskBackend()`
  probes `public.tasks`. Present → normalized mode. Absent/unreadable → the client
  keeps using the workspace document exactly as today. So the client can ship
  before, during or after the SQL, in any order, with no coordinated cutover.
- Task ids, statuses, priorities, categories and the entire task JSON shape the UI
  consumes are unchanged.
- Deliverables, weekly plans, KPI scores, exports/imports, attachments storage,
  the private vault and all Phase-2 RBAC behaviour are untouched.
- `workspace` write RLS (`tasks.execute`) is unchanged, so the legacy path keeps
  working for the roles that have it.
- Backup/export still emits one document; in normalized mode the export includes
  the normalized tasks hydrated back into the document shape, so a backup taken
  after migration restores everything.

---

## 17. Failure modes

| failure | behaviour |
|---|---|
| Phase-3 SQL not applied | client stays on the workspace document; nothing breaks |
| `tasks` readable but empty (migration not run) | normalized mode shows an empty list — so the migration is a **required** step of the rollout, called out in §20 |
| RBAC tables unreachable | `RBAC` falls back to Phase-1 DEFAULTS; `tasks.view_all` is false for everyone ⇒ personal view only (fail closed) |
| profile fetch fails | app stays on the loading screen instead of rendering as Viewer (§18) |
| user in no organization | zero tasks, cannot create (fail closed) |
| unmapped legacy owner | task lands unassigned, surfaced in the management Unassigned widget |
| concurrent edit of the same task | last write wins per *task row* (was: per whole document — strictly better) |

## 18. First-login Viewer race (existing defect, fixed here)

**Cause.** `AuthProvider` exposed `ready = authUser !== undefined` while the
profile fetch was still in flight, and `role` defaulted to `'viewer'` in that
window. `App` therefore rendered a full Viewer UI for one paint.

**Fix.** Bootstrap is a four-stage state machine — session → profile → role →
RBAC matrix — and the app renders nothing until all four settle:

```js
window.authBootstrap.computeReady({ shared, authUser, profileState, rbacState })
```

extracted as a pure function (`fm-navigate/auth-bootstrap.js`) so it is unit
testable in Node, and `role` is `null` (not `'viewer'`) until the profile resolves.
Regression test: `scripts/verify-auth-bootstrap.mjs` — asserts the truth table and
statically asserts `auth-context.jsx` contains no `'viewer'` role fallback.

---

## 19. Security considerations

- Every task rule is a Postgres policy; the client mirror exists only to hide UI.
- Client-submitted signup data cannot set role, org, management flag or status.
- `reporter_id` / `created_by` are forced to `auth.uid()` by `WITH CHECK`; a forged
  payload is rejected, not silently corrected.
- Organization is checked on **every** operation, for **every** role, before the
  relationship check — an owner cannot reach another tenant's rows.
- `is_org_member` / `authorize` are SECURITY DEFINER with locked `search_path`.
- Direct PostgREST/REST tampering hits the same policies as the UI (tested).
- The append-only `activity_log` has no UPDATE/DELETE policy — unchanged.
- Deny-by-default everywhere: no policy grants `using (true)` on task data.
- **No dual-source privacy (ADR 0009).** A task has several representations —
  the tables, the legacy document, Storage objects, the audit log, the unused
  generic comments table — and every one of them now answers the same question
  the same way. The audit log is the cautionary tale: its `using (true)` was
  correct when written and became a leak the moment Phase 3 started writing
  task titles into it. New rule: any table that can hold a task id needs a
  task-scoped policy *before* it holds one.
- Reporter grants nothing (ADR 0007); signup grants no membership (ADR 0008).

## 20. Rollout

1. Apply `supabase/schema.sql` (idempotent; contains Phase 1 + 2 + 3).
2. Seed `legacy_user_map` for `vihan` / `richard` / `isuru` → real profile uuids.
3. **Back up the workspace** (Settings → Data → Export) — required.
4. `select * from public.migrate_workspace_tasks(false);` — dry run, read counts.
5. `select * from public.migrate_workspace_tasks(true);` — commit.
6. `select * from public.verify_task_migration();` — every count must match.
7. Deploy the client (it flips to normalized mode automatically once step 5 ran).
8. UAT: standard user sees only own work; management sees all; assignment works.

## 21. Rollback

- **Client:** redeploy the previous build, or set
  `window.APP_CONFIG.TASKS_BACKEND = 'workspace'` — the workspace document was
  never modified by the migration, so the legacy path is still fully populated.
- **Database:** the rollback is simply "stop reading the normalized tables".
  After `archive_workspace_tasks()` has run, the document's task array is empty,
  so restoring it is one further step: `restore_workspace_tasks(true)`, which
  copies the archived payload back. Both are owner-gated and dry-run by default.
  Nothing is ever deleted.
- Phase 2 objects are untouched by a Phase-3 rollback.

## 22. Test strategy

| suite | command | kind |
|---|---|---|
| RBAC seed↔client parity + enforcement boundary | `npm run verify:rbac` | static/behavioural |
| RBAC account isolation | `npm run verify:rbac` | behavioural |
| **Task RLS, tenant isolation, signup safety, migration** | `npm run verify:rls` | **real Postgres** |
| Auth bootstrap (Viewer race) | `npm run verify:auth` | behavioural + static |
| Client task-scope mirror | `npm run verify:auth` | behavioural |
| Bundle builds | `npm run build` | build |

`verify:rls` initialises a throwaway cluster, loads `supabase/tests/harness.sql`
(minimal `auth`/`storage` stand-ins) and then the **real, unmodified**
`supabase/schema.sql`, so the policies under test are the ones that ship.

## 23. Future architecture

Teams (`teams`, `team_members`, `tasks.team_id`) slot in as one more relationship
clause in the read policy. Multi-org onboarding needs only an org picker at signup
plus `is_org_member` already being multi-row. Per-project schemes would extend
`authorize()` with a scope argument — the point of D1 is that that decision stays
open, because no `*_own` / `*_team` keys were baked into the catalog.
