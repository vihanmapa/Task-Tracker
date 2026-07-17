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
