# Standing up a second, independent backend

How to run this codebase against **your own** Supabase project while production
keeps pointing at the original one. Nothing here touches production.

```
main / GitHub Pages                 your local clone
    config.js                           config.js + config.local.js (gitignored)
        ↓                                   ↓
Tasks Tracker project               your Supabase project
qxrozpuupaddohzwulun                (e.g. wsjnwvrxvmcqwiowzozx)
```

The two projects share **code only**. No rows, users or files are shared, and a
change in one database never reaches the other.

## What the migrations give you

`supabase/migrations/` is a baseline taken from the live project on 2026-09-30.
Replayed on an empty database it was verified catalog-for-catalog identical to
live (21 tables, 47 RLS policies, 30 functions, 9 triggers, 54 constraints,
37 indexes, table grants, 7 realtime tables, the storage bucket, RBAC rows).

| File | Contents |
|---|---|
| `…000000_baseline_public_schema.sql` | Whole `public` schema: tables, functions, triggers, RLS policies, grants |
| `…000100_baseline_platform.sql` | `auth.users` sign-up trigger, `task-attachments` bucket + its 4 policies, realtime publication, grant hardening |
| `…000200_baseline_reference_data.sql` | RBAC catalogue (42 permissions, 13 roles, 202 grants), primary organization, empty `main` workspace row |

`supabase/schema.sql` is the older hand-maintained script and is **behind** the
live database. Use the migrations, not `schema.sql`, for a new project.

## What the migrations do NOT give you

`supabase db push` cannot reproduce these. Each is a manual step below.

| Not reproduced | Why | Step |
|---|---|---|
| Custom Access Token hook being **enabled** | Auth service setting, not a database object. The function is created; nothing calls it until you switch it on | 3 |
| Auth users | Accounts live in the source project's Auth and are not exported | 4 |
| An `owner` | New sign-ups get role `member`; the role-change guard blocks a plain `update` | 5 |
| Membership of the primary organization | Sign-up only creates a personal workspace | 5 |
| Stored files | The bucket and its policies are created; the 77 objects in production are not copied | — |
| Application data | Tasks, deliverables, KPI scores, comments, private resources all start empty | — |
| Your local backend config | `config.local.js` is gitignored by design | 6 |

**Do not deploy `supabase/functions/tasks-mutate`.** It is a legacy
password-gated proxy that writes with the service-role key, bypassing RLS. The
app no longer calls it; RBAC + RLS replaced it.

## Steps

### 1. Link the clone to your project

```bash
npm install
```

```bash
npx supabase login
```

```bash
npx supabase link --project-ref YOUR_PROJECT_REF
```

Log in with the Supabase account that owns the new project. `link` may ask for
the database password you chose when creating it. Never send that password, or
the service-role key, to anyone.

### 2. Push the schema

Preview first:

```bash
npx supabase db push --dry-run
```

It should list exactly the three `20260930…` baseline files. Then apply:

```bash
npx supabase db push
```

Only run this against a **new, empty** project. Do not run `supabase config
push` — `supabase/config.toml` holds CLI defaults, not this app's auth settings.

### 3. Enable the access-token hook

Dashboard → **Authentication → Hooks** → **Custom Access Token** → enable →
Postgres function → schema `public`, function `custom_access_token_hook` → save.

Without it no JWT carries a `user_role` claim, every user is treated as
`viewer`, and every write is rejected by RLS.

### 4. Create the first user

The app signs in with email + password and has no sign-up screen.

Dashboard → **Authentication → Users** → **Add user** → email + password, tick
**Auto Confirm User**. A `profiles` row and a personal workspace are created
automatically.

### 5. Promote that user to owner and join the primary organization

Dashboard → **SQL Editor**. Replace the email and name, then run as **one
statement**:

```sql
with _ as (select set_config('request.jwt.claims', '{"user_role":"owner"}', true)),
promoted as (
  update public.profiles p set role = 'owner', name = 'Your Name'
    from _ where p.email = 'you@example.com'
  returning p.id
),
joined as (
  insert into public.organization_members (organization_id, user_id)
  select public.default_org_id(), id from promoted
  on conflict do nothing
  returning user_id
)
select (select count(*) from promoted) as promoted,
       (select count(*) from joined)   as joined_primary_org;
```

Expected result: `1, 1`. The `set_config` line is required: the
`protect_profile_privileges` trigger refuses a role change unless the caller
holds `users.assign_roles`, and the SQL Editor carries no role claim. A bare
`update profiles set role = 'owner'` fails with *only an administrator may
change role or status*.

After this, add further users in the dashboard (step 4) and assign their roles
from the app: **Settings → Users**. Users added later must also be joined to the
primary organization to see shared work.

### 6. Point your local app at your project

Dashboard → **Project Settings → API** → copy the Project URL and the
anon / publishable key.

```bash
cp fm-navigate/config.local.example.js fm-navigate/config.local.js
```

Fill in the two values in `config.local.js`. Leave `config.js` alone — it is the
production default and is what GitHub Pages ships.

```bash
python3 fm-navigate/serve.py
```

Open http://localhost:4173, sign in, and **sign out and back in once after
step 5** so the token picks up the `owner` role.

`config.local.js` only affects the dev server above. `npm run build` ignores it,
so a locally built `dist/` still targets production.

### 7. Check it worked

1. In the browser console, `APP_CONFIG.SUPABASE_URL` shows your project.
2. The role badge reads **Owner**; Settings → Roles & Permissions lists 13 roles.
3. Create a task, reload — it persists. Attach a file — it lands in the
   `task-attachments` bucket of **your** project.
4. The production site shows none of it.

## For the production project's maintainer

The live project's migration history holds one entry (`99999999999999
emergency_restore`) that does not exist in this folder, so `supabase db push`
against production refuses to run. Leave it that way until the baseline is
deliberately recorded as already applied — the baseline files would otherwise be
replayed onto a database that already has these objects.
