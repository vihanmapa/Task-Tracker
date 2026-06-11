# Private resources vault — Supabase setup

Per-deliverable private resources (chat links, notes) that **only the signed-in
owner** can read or write. Privacy is enforced by Supabase **Auth + Row Level
Security**, not by the UI — rows are filtered server-side to `auth.uid()`.

The app code is already wired (`data-service.js` auth + resource methods,
`ResourcesPanel` in `deliverables.jsx`). It activates once the steps below are done.

> Why this is needed: the shared workspace blob is readable with the public anon
> key, so anything stored there is visible to everyone. Private resources live in a
> **separate table** gated by per-user RLS, so they are never sent to other users.

---

## 1. Enable email auth

Supabase dashboard → **Authentication → Providers → Email** → enable.

For a quick internal setup, turn **off** "Confirm email" (Authentication →
Providers → Email → uncheck *Confirm email*). Otherwise each user must confirm
via an email link before signing in.

## 2. Create the user accounts

Authentication → **Users → Add user** → create an account for each person who
needs a private vault:

- your email + a password (this is "only you")
- (optional) Richard, if he wants his **own** separate private vault

Each user only ever sees their own rows — accounts do not share resources.

## 3. Create the table + RLS policies

SQL Editor → **New query** → paste and **Run**:

```sql
create table if not exists public.private_resources (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  deliverable_id text not null,
  kind          text not null default 'link',   -- 'link' | 'note'
  title         text default '',
  url           text default '',
  note          text default '',
  created_at    timestamptz not null default now()
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

create index if not exists private_resources_owner_deliverable
  on public.private_resources (user_id, deliverable_id);
```

## 4. Let signed-in users still read the shared workspace

When you sign in, requests carry your user token (role `authenticated`) instead
of `anon`. If the existing `workspace` SELECT policy only allows `anon`, the
tasks/deliverables would fail to load while signed in. Add an authenticated read
(safe — the workspace is shared anyway):

```sql
create policy "workspace read (authenticated)" on public.workspace
  for select to authenticated using (true);
```

(If you already have a `to public` select policy on `workspace`, you can skip this.)

---

## Using it

1. Open any deliverable → **Private resources** section at the bottom → **Sign in**.
2. Enter your email + password.
3. **Add resource** → Link or Note → paste a ChatGPT / Gemini / NotebookLM URL,
   title, and an optional note → Save.
4. Resources are tied to that deliverable and that account. Richard signed in as
   himself (or not signed in) never sees them.

**Caveat:** this protects against other *users*. A Supabase project owner with
service-role/dashboard access can still read any table — that's inherent to being
the project admin.
