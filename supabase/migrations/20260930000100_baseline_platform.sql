-- Baseline: objects the app depends on that live OUTSIDE the `public` schema,
-- so `supabase db dump --schema public` / `supabase db pull` do not capture
-- them. Transcribed from the live Tasks Tracker project's catalogs on
-- 2026-09-30 (pg_trigger, storage.buckets, pg_policies, pg_publication_tables).
-- Idempotent, so it is safe against a project that already has them.

-- 1. Auth: create a profile + personal workspace for every new sign-up.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2. Storage: private bucket for task attachments. Files themselves are NOT
--    migrated -- a new project starts with an empty bucket.
insert into storage.buckets (id, name, public)
values ('task-attachments', 'task-attachments', false)
on conflict (id) do nothing;

drop policy if exists "task-attachments read (task scope)" on storage.objects;
create policy "task-attachments read (task scope)"
  on storage.objects for select to authenticated
  using (bucket_id = 'task-attachments' and public.attachment_readable(name));

drop policy if exists "task-attachments write (role)" on storage.objects;
create policy "task-attachments write (role)"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'task-attachments' and public.attachment_writable(name));

drop policy if exists "task-attachments update (role)" on storage.objects;
create policy "task-attachments update (role)"
  on storage.objects for update to authenticated
  using (bucket_id = 'task-attachments' and public.attachment_writable(name));

drop policy if exists "task-attachments delete (role)" on storage.objects;
create policy "task-attachments delete (role)"
  on storage.objects for delete to authenticated
  using (bucket_id = 'task-attachments' and public.attachment_writable(name));

-- 3. Realtime: tables the app (or its planned relational task model) subscribes to.
do $$
declare t text;
begin
  foreach t in array array['workspace', 'comments', 'role_permissions', 'tasks',
                           'task_checklist_items', 'task_comments', 'task_progress']
  loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 4. Internal tables are service_role-only on the live project. pg_dump records
--    that as "no grant", but a fresh project's default privileges would hand
--    anon/authenticated the leftovers (incl. TRUNCATE, which RLS does not gate).
revoke all on table public.legacy_user_map, public.schema_markers, public.workspace_task_archive
  from anon, authenticated;
