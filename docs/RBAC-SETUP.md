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

| Role               | `app_role`         | Workspace write? |
| ------------------ | ------------------ | ---------------- |
| Owner              | `owner`            | ✅ (everything)  |
| Product Manager    | `product_manager`  | ✅               |
| Investor           | `investor`         | ❌ read + comment |
| Business Analyst   | `business_analyst` | ❌ (stories later) |
| Tech Lead          | `tech_lead`        | ❌ (tasks later)  |
| Software Engineer  | `developer`        | ❌ (tasks later)  |
| QA Engineer        | `qa`               | ❌ (defects later) |
| Viewer             | `viewer`           | ❌ read only      |

**Phase 1 caveat:** tasks/deliverables/KPIs all live in ONE `workspace` jsonb
document, so the only DB-enforced WRITE today is the whole document — granted to
`owner` + `product_manager`. The finer per-resource rules in `permissions.js`
(tasks, stories, defects, roadmap…) are future-named: when the blob is split into
real tables, RLS tightens under the same `can()` calls with no UI change.

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
update public.profiles set role = 'owner', name = 'Richard Davies'
  where email = 'richard@...';
update public.profiles set role = 'product_manager', name = 'Vihan Mapalagama'
  where email = 'vihancmapa@gmail.com';
```

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
