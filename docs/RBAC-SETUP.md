# RBAC setup — roles, JWT claim, comments & audit log

Phase 1 of role-based access control. Replaces the single `EDITOR_EMAIL` /
`EDITOR_UID` editor with a per-user **role**. The role is the editable copy on
`public.profiles`; the **JWT `user_role` claim** is the runtime source of truth
that Row Level Security enforces. The client mirror is `fm-navigate/permissions.js`.

> **Security model.** The database is the boundary. `permissions.js` only shapes
> the UI (hides what a role can't do). A tampered client still hits RLS and is
> rejected. Reads are open to any signed-in user; writes are role-gated.

---

## Roles

Jira-style split: **execution** (work tasks — progress, comments, checklists,
evidence, create tasks) is open to every delivery role; **governance**
(assign owner, prioritise, delete tasks, deliverables, weekly plans, KPI,
import/clear, users, settings) stays with leads/owner/PM.

| Role               | `app_role`         | Execute tasks? | Assign/prioritise | Delete tasks / govern |
| ------------------ | ------------------ | -------------- | ----------------- | --------------------- |
| Owner              | `owner`            | ✅             | ✅                | ✅ (everything)       |
| Product Manager    | `product_manager`  | ✅             | ✅                | ✅ (not users/settings) |
| Tech Lead          | `tech_lead`        | ✅             | ✅                | ❌                    |
| Business Analyst   | `business_analyst` | ✅             | ❌                | ❌                    |
| Software Engineer  | `developer`        | ✅             | ❌                | ❌                    |
| QA Engineer        | `qa`               | ✅             | ❌                | ❌                    |
| Investor           | `investor`         | ❌ read only   | ❌                | ❌                    |
| Viewer             | `viewer`           | ❌ read only   | ❌                | ❌                    |

**Phase 1 caveat:** tasks/deliverables/KPIs all live in ONE `workspace` jsonb
document, so the only DB-enforced WRITE is the whole document — granted to all
six delivery roles above. The finer split (execution vs assign/prioritise/delete,
own-task field edits) is enforced centrally in the app's mutation handlers
(`app.jsx`) and is NOT a hard security boundary until the blob is normalised
into per-resource tables. Acceptable for a small trusted team. Execution roles
can also edit descriptive fields only on tasks they own or created.

---

## 1. Run the schema

Supabase dashboard → **SQL Editor → New query** → paste all of
[`supabase/schema.sql`](../supabase/schema.sql) → **Run**. It is idempotent
(safe to re-run). This creates:

- `app_role` enum + `public.profiles` (auto-created per auth user, default `viewer`)
- `custom_access_token_hook` (stamps `user_role` into the JWT) + `jwt_role()` helper
- role-gated `workspace` write policy
- `public.comments` and `public.activity_log` with RLS
- a trigger blocking non-owners from changing their own `role`/`status`

## 2. Enable the access-token hook  ← easy to miss

Dashboard → **Authentication → Hooks** → **Custom Access Token** →
enable → select **`public.custom_access_token_hook`** → save.

Until this is on, every token's `user_role` is absent and `jwt_role()` falls
back to `viewer` — i.e. **nobody can write**, including you. After enabling,
users must sign out / back in (or refresh the token) to get the claim.

## 3. Assign roles

> ⚠️ **Existing users must be backfilled.** The auto-create trigger only fires
> for *future* sign-ups. Anyone who already had a Supabase account before this
> migration has **no profile row**, so they resolve to `viewer` (read-only) and
> the live app looks broken for them. Backfill them once, right after step 1:

```sql
-- create a profile (role=viewer) for every existing auth user
insert into public.profiles (id, email, name)
select id, email, coalesce(raw_user_meta_data->>'name', email)
from auth.users
on conflict (id) do nothing;
```

**Bootstrap the first owner via SQL** (no owner exists yet to use the UI):

```sql
-- TWO owners: Vihan runs the platform day-to-day; Richard is the Managing
-- Director. Both get full authority (the last-active-owner guard keeps the
-- account from ever being locked out).
update public.profiles set role = 'owner', name = 'Vihan Mapalagama'
  where email = 'vihancmapa@gmail.com';
update public.profiles set role = 'owner', name = 'Richard Davies'
  where email = 'richard.davies@evbex.com';
-- The rest can be set here too, or via Settings → Users once an owner is live:
update public.profiles set role = 'business_analyst', name = 'Jathurshan Sivakumaran'
  where email = 'jathurshan.sivakumaran@evbex.com';
-- Isuru (tech_lead): assign via Settings → Users, or add his email here.
```

> Jathurshan's business title is *Senior* Business Analyst; the `app_role` enum
> has no seniority tiers, so he maps to `business_analyst`. Titles ≠ permission
> roles — add tiers only if permissions genuinely diverge.

After that, **the owner assigns everyone else from the app**: Settings → *Users
& roles* → pick a role per person, or disable a user. No more SQL. (Only the
owner sees this page — a PM or anyone else does not.)

> After any role change the user must re-authenticate (or refresh their token)
> for the new `user_role` claim to take effect — the JWT is only re-minted on
> sign-in/refresh.

**Adding a person:** create their account in Supabase (Authentication → Users).
They appear in the Users list on first sign-in; the owner then sets their role.
(A self-serve Invite-by-email flow needs the server-side admin API — a later
add; see below.)

## 4. Verify

1. Sign in as `product_manager` → can create/move/complete tasks; sidebar badge
   reads **Product Manager**.
2. Sign in as `viewer`/`investor` → UI is read-only; any forced write is also
   rejected by RLS (the `.select()`-after-update guard reports zero rows).
3. As a non-owner, `update profiles set role='owner' where id=auth.uid()` →
   rejected by the trigger (`only an owner may change role or status`).
4. Demote/disable/delete the **last active owner** → rejected
   (`cannot remove or disable the last active owner`). No way to lock everyone out.
5. **Disable a user** → on their next token refresh the `user_role` claim drops
   to `viewer`, removing every write. Reads stay open (workspace reads are open
   to any signed-in user); to fully block sign-in, ban them in Supabase Auth.

---

## Pre-merge smoke test

Run this manually against a project with the schema applied + the hook enabled.
These integration checks (auth + RLS) catch what unit tests miss. Requires at
least three accounts: an owner, a product_manager, and a viewer.

| Area            | Verify                                                        |
| --------------- | ------------------------------------------------------------- |
| Login           | Owner, PM, Viewer can all sign in                             |
| JWT             | `user_role` claim present (decode the access token)           |
| Workspace       | Owner/PM can create/move/complete; Viewer's edits are blocked |
| Execution roles | BA/Dev/QA/TL can create tasks, log progress, comment, tick checklist, add evidence — and the write PERSISTS (RLS accepts) |
| Execution limits| BA cannot change priority/owner (controls absent), cannot delete tasks, can edit description only on own/created tasks, can edit/delete only own progress entries |
| Tech Lead       | Same as BA plus owner + priority changes                      |
| Users page      | Visible to Owner only; absent for PM/Viewer                   |
| Role change     | Owner changes a role in Settings → Users; saves               |
| Session refresh | New role takes effect only after that user re-authenticates   |
| Disabled user   | After disable + their token refresh, all writes fail          |
| Last owner      | Demote/disable/delete of the sole owner is rejected           |
| Comments        | Non-viewer can comment; viewer insert is denied by RLS        |
| Activity log    | role_changed / user_disabled rows appear after admin actions  |

> Verified statically here (no live backend): permission-map outcomes, Users-page
> visibility gating, build/compile, zero console errors. Everything involving a
> real session, the JWT claim, and RLS must be checked against the deployed
> project — that's this checklist.

## What this is NOT (yet)

Deferred to later phases — intentionally, to stay simple:

- **Per-task / assigned-task RLS** — needs the workspace blob normalised into
  rows first.
- **Invite-by-email flow** — the Users screen (Settings → Users & roles) ships
  now for listing people and assigning roles/status, but creating accounts still
  happens in Supabase. Self-serve invite needs a server-side edge function with
  the service-role key (`auth.admin.inviteUserByEmail`).
- **Approval workflow, notifications, mentions** — comments + activity_log are
  the data foundation; UI comes later.

The contract that stays stable: the app always asks
`RBAC.can(role, resource, action)`. The implementation behind it can grow into a
permissions table, teams, or orgs without touching the UI.

---

# Phase 2 — table-driven Roles & Permissions

Blueprint: `docs/TDD-ROLES-PERMISSIONS.md` rev 0.3 (approved). Phase 2 moves
the permission rules out of code and into Supabase tables; owners edit them at
runtime in **Settings → Roles & Permissions**.

## Apply

Re-run `supabase/schema.sql` in the SQL editor (idempotent — the Phase 2
section at the bottom creates/seeds the new tables and swaps the policies).
Re-running later never clobbers runtime permission edits: only a role with
zero grant rows is re-seeded, and catalog/templates are migration-owned.

What it adds:

| Piece | Purpose |
| --- | --- |
| `permissions` | The catalog (41 keys, grouped, layered). Migration-only, append-only. |
| `role_templates` + `template_permissions` | Factory settings per template — "Reset to template" restores these. |
| `roles` | 12 seeded system roles, incl. new `executive`, `senior_business_analyst`, `ba_intern`, `associate_developer`. |
| `role_permissions` | Current grants — the only runtime-editable store. |
| `authorize(permission)` | RLS primitive: looks the caller's `jwt_role()` up in `role_permissions` at query time. Permission toggles apply on the **next request**, no re-login. Role changes still need a token refresh. |
| `profiles.job_title` | Display-only business title ("Managing Director"). Grants nothing — security roles are separate. |

Guardrails (all DB-enforced): owner grants immutable, system roles
undeletable/unrenamable, last-active-owner protection unchanged, every
grant/revoke audited to `activity_log` as `permission_granted` /
`permission_revoked`.

## What the admin matrix can actually change (enforcement boundary)

The catalog carries the full 41-key target shape, but Phase 2 only **wires 12
keys** end-to-end. The admin screen makes exactly those editable; every other
key is shown read-only with a **Planned** badge, because toggling it would have
no effect. The wired set is the `permissions.enforced` column (set canonically
by this SQL) and is code-audited, not assumed. Standard: a key is enforced only
with a real user-visible effect — **DB-only enforcement doesn't count**, which
is why `comments.write`/`comments.moderate` stay Planned (the RLS is live but
`public.comments` is unused; comments live in the workspace blob). See
`docs/TDD-ROLES-PERMISSIONS.md` §2.1 for the full table and rationale. When a
Planned key's control lands later, flip it to `enforced = true` in the same
migration slot — no catalog churn.

## Client behaviour

`permissions.js` fetches the matrix per sign-in and refetches on realtime
grant changes. If the Phase 2 tables aren't there (SQL not applied yet) the
client falls back to the hardcoded Phase-1 matrix — both deploy orders are
safe. Parity between the two is asserted by `npm run verify:rbac`.

## Verify after applying

1. `npm run verify:rbac` still green (static parity).
2. Sign in as a QA-role account → task work saves; Settings shows no admin cards.
3. As owner: Settings → Roles & Permissions → toggle `Work tasks` off for
   QA Engineer → the QA user's UI flips read-only within seconds (no
   re-login) and any in-flight save is rejected by RLS. Toggle back.
4. `activity_log` shows the `permission_revoked` / `permission_granted` pair.
5. Reset to template on a customised role restores the seeded set.

---

# Phase 3 — Personal task workspaces (rollout runbook)

Design: `docs/TDD-PERSONAL-TASK-WORKSPACES.md`. Decision: ADR 0006.
Everything below is in the same idempotent `supabase/schema.sql`.

**Nothing here happens automatically.** The migration is an explicit, operator-
run function, dry-run by default, and it never modifies the workspace document.

## What changes

| | before | after |
|---|---|---|
| where tasks live | `workspace('main').tasks` jsonb | `public.tasks` + 5 child tables |
| who can see a task | anyone signed in | the **assignee**, or `tasks.view_all` (ADR 0007) |
| who can assign | app-side check only | `tasks.assign`, enforced by trigger |
| tenant | implicit | `organization_id` on every task, checked on every operation |
| signup | owner creates the account in Supabase | anyone can self-register → `member` **+ their own personal workspace, and no Evbex membership** (ADR 0008) |
| joining Evbex | implicit | `add_organization_member()`, administrator-only |
| the document's task copy | shared, readable | archived to an admin-only table (ADR 0009) |

## Steps

1. **Apply the SQL.** Supabase → SQL Editor → run `supabase/schema.sql`.
   Re-running is safe. This adds Phase 3 alongside Phases 1–2; nothing is dropped.

2. **Check the seed.** Expect 13 roles, 42 permissions, 14 enforced:
   ```sql
   select (select count(*) from roles) roles,
          (select count(*) from permissions) perms,
          (select count(*) from permissions where enforced) enforced,
          (select count(*) from role_permissions) grants;
   ```

3. **Map the legacy owner keys** to real accounts. The pre-normalisation
   document identifies people by workspace key (`vihan`, `richard`, `isuru`),
   not by uuid. Anything you don't map migrates **unassigned** — never to the
   wrong person — and keeps its original key in `tasks.legacy_owner`.
   ```sql
   insert into public.legacy_user_map (legacy_key, user_id)
   select 'vihan', id from public.profiles where email = 'REPLACE@example.com'
   on conflict (legacy_key) do update set user_id = excluded.user_id;
   -- repeat for 'richard', 'isuru', and any 'email:someone@example.com' keys
   select legacy_key, user_id from public.legacy_user_map;   -- confirm
   ```

4. **BACK UP THE WORKSPACE.** Settings → Data → Backup workspace → **Export**.
   Required, not optional. Keep the file until step 8 passes.

5. **Dry run** (signed in as an owner — the function refuses anyone else):
   ```sql
   select * from public.migrate_workspace_tasks(false);
   ```
   Read `document_tasks` (how many it found) and `unmapped_owners` (how many
   would land unassigned). If `unmapped_owners` surprises you, go back to step 3.

6. **Commit:**
   ```sql
   select * from public.migrate_workspace_tasks(true);
   ```
   Idempotent — every insert is keyed on the original task id, so a partial run
   is safely resumable and a second run writes nothing.

7. **Verify:**
   ```sql
   select * from public.verify_task_migration();
   ```
   Every row's `matches` must be `true`. `unmapped_owners` is informational —
   those tasks appear in the management dashboard's **Unassigned** widget.

8. **Archive the document's task copy — do this now, not later.**
   ```sql
   select public.archive_workspace_tasks(false);   -- dry run
   select public.archive_workspace_tasks(true);    -- commit
   ```
   This MOVES the legacy task payload into an administrator-only archive table
   and empties the document's task array. Nothing is deleted;
   `restore_workspace_tasks(true)` puts it back.

   Why immediately: until this runs, the document still contains everybody's
   tasks, so its policy makes it **management-only** — which is safe but takes
   Deliverables / This Week / KPI away from every other role. Archiving both
   closes the last cross-user read path and gives those screens back.
   The function refuses to run unless step 7 is green.

9. **Deploy the client.** It probes for `public.tasks` and switches to the
   normalized path on its own; no coordinated cutover.

## UAT — sign-off checklist

Run these against the live deployment **after** step 9, in order. Each one is a
behaviour a real person can observe; none of them is "check the code".

| # | Check | Expected |
|---|---|---|
| 1 | Sign in as an existing management user (Owner / PM) | sees **all** Evbex tasks |
| 2 | Sign in as a normal member | sees **only** tasks assigned to them |
| 3 | Management reassigns one of that member's tasks to someone else | it disappears from the previous assignee's list |
| 4 | The previous assignee is still the task's reporter | they **cannot** retrieve it — not on any screen, not by direct URL |
| 5 | Sign up a fresh public account | personal workspace only; **no** Evbex tasks, people, or governance screens |
| 6 | Management creates a task and assigns it to another member | task appears on that member's list |
| 7 | Standard member opens the task form | **no** assignee control at all |
| 8 | Open an attachment on a task the signed-in user cannot see | refused (try the storage URL directly, not just the UI) |
| 9 | After the archive step, a non-management role opens Deliverables / This Week | works, and the document carries no task data |
| 10 | `select action, entity_id from activity_log order by created_at desc limit 10;` | `task_created`, `task_assigned`, `task_reassigned`, `task_status_changed` present |

Checks 4 and 8 are the two most worth doing by hand: they are the ones a UI can
appear to pass while the API still answers.

### Walkthrough

1. Sign out → **Create account** → sign up. You land in **your own** personal
   workspace: *My Tasks*, no People/Deliverables/KPI/This Week in the nav — and
   **no Evbex data of any kind**. Create a task; it lives in your workspace.
   To make that account a colleague, an owner runs:
   ```sql
   select public.add_organization_member(public.default_org_id(), '<their uuid>');
   ```
2. Create a task. It has no assignee picker; you are both reporter and assignee.
3. As a Product Manager: the dashboard shows *Work by person*, **People** is in
   the nav, and the task form has an assignee picker. Create a task for someone
   else and reassign it.
4. Sign back in as the member: the delegated task is on their list; the other
   member's tasks are not, on any screen or URL.
5. Reassign one of their tasks away from them (as management). It disappears
   from their list entirely — being its reporter does not keep it (ADR 0007).
5. `select action, entity_id from activity_log order by created_at desc limit 10;`
   → `task_created`, `task_assigned`, `task_reassigned`, `task_status_changed`.

## Widening management scope later — no deployment

Settings → Roles & Permissions → the role → grant **View all tasks in the
organization** (`tasks.view_all`). That user's next request sees the whole
organization and their dashboard switches to the management composition.
Revoking narrows it back the same way. This is why management is a permission
and not a role name or a job title.

## Rollback

- **Before step 8:** redeploy the previous client. The workspace document still
  holds every task — the migration never touches it — so the legacy path is
  intact and there is nothing to undo in the database.
- **After step 8:** run `select public.restore_workspace_tasks(true);` to copy
  the archived payload back into the document, then redeploy the previous
  client. The archive is never deleted, so this stays available indefinitely.
- Phase 1–2 objects are untouched in every case.

## Verify commands

```
npm run verify          # everything below, in order
npm run verify:rbac     # Phase-2 parity + account isolation (static)
npm run verify:auth     # bootstrap race, scope mirror, write planner
npm run verify:rls      # task authorization against a real Postgres
npm run build           # the precompiled bundle
npm run verify:ui       # personal vs management UX in headless Chromium
```
