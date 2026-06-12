# Auth, edit-lock & resources — Supabase setup

The app now uses **Supabase Auth** for everything:

- **Login is required** — nothing renders until you sign in.
- **Editing the shared workspace** (create/move/complete tasks & deliverables) is
  locked to a single **editor account** (you). Everyone else is read-only.
  The old `FMNavigate` edit password is **gone**.
- **Resources** (chat links + notes) can be attached to any task or deliverable.
  Each one is either **shared** (everyone sees it, lives in the workspace blob)
  or **private** (only you, lives in `private_resources` under per-user RLS).

If you set up the earlier vault already, you only need **steps 3 + 4** below
(the migration and the workspace write-lock). Steps 1–2 you've done.

---

## 1. Enable email auth

Supabase dashboard → **Authentication → Providers → Email** → enable, and turn
**off** "Confirm email" for a quick internal setup.

## 2. Create the accounts

Authentication → **Users → Add user** → one account per person:

- **You** — `vihancmapa@gmail.com` (this is the editor; matches `EDITOR_EMAIL`
  in `fm-navigate/config.js`).
- **Richard** — his own email + password (read-only viewer).

> If you change the editor's email, update `EDITOR_EMAIL` in `config.js` to match.

## 3. Resources table + RLS (create or migrate)

SQL Editor → **New query** → **Run**.

**If the table does not exist yet** (fresh setup):

```sql
create table if not exists public.private_resources (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  parent_type text not null default 'deliverable',  -- 'task' | 'deliverable'
  parent_id   text not null,
  kind        text not null default 'link',          -- 'link' | 'note'
  title       text default '',
  url         text default '',
  note        text default '',
  created_at  timestamptz not null default now()
);

alter table public.private_resources enable row level security;

create policy "own rows - select" on public.private_resources
  for select to authenticated using (auth.uid() = user_id);
create policy "own rows - insert" on public.private_resources
  for insert to authenticated with check (auth.uid() = user_id);
create policy "own rows - update" on public.private_resources
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - delete" on public.private_resources
  for delete to authenticated using (auth.uid() = user_id);

create index if not exists private_resources_owner_parent
  on public.private_resources (user_id, parent_type, parent_id);
```

**If you already created the earlier vault table** (it had `deliverable_id`),
migrate it instead — existing rows are preserved as deliverable resources:

```sql
alter table public.private_resources rename column deliverable_id to parent_id;
alter table public.private_resources add column if not exists parent_type text not null default 'deliverable';
create index if not exists private_resources_owner_parent
  on public.private_resources (user_id, parent_type, parent_id);
```

## 4. Lock workspace WRITES to the editor, allow READS to anyone signed in

Reads (signed-in) and the editor's writes now go **directly** to the `workspace`
table (no more Edge Function). Find your editor **User UID**: Authentication →
Users → click your user → copy **User UID**. Paste it into the policy below.

```sql
-- everyone signed in can READ the shared workspace
create policy "workspace read (authenticated)" on public.workspace
  for select to authenticated using (true);

-- only the editor (you) can WRITE it
create policy "workspace write (editor only)" on public.workspace
  for update to authenticated
  using (auth.uid() = 'PASTE-YOUR-USER-UID-HERE')
  with check (auth.uid() = 'PASTE-YOUR-USER-UID-HERE');
```

(If the read policy already exists from before, the editor `create policy` for it
will error "already exists" — that's fine, just run the write policy.)

> The old `tasks-mutate` Edge Function is no longer used and can be left in place
> or deleted later — your call.

---

## How it works now

1. Open the app → **Sign in** landing page → enter email + password.
2. Signed in as **you** → full edit. Signed in as **Richard** (or anyone else) →
   read-only view.
3. On any task or deliverable → **Resources** → **Add resource** → choose
   **Shared** (everyone) or **Private (only me)** → paste a ChatGPT / Gemini /
   NotebookLM link, title, optional note → Save.
4. The lock icon on a resource flips it between shared and private.

**Caveat:** privacy protects against other *users*. A Supabase project owner with
service-role/dashboard access can read any table — inherent to being the admin.
