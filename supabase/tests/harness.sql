-- ============================================================
-- Local test harness — minimal Supabase stand-ins
-- ------------------------------------------------------------
-- supabase/schema.sql expects a Supabase project: the `auth` and
-- `storage` schemas, the `anon` / `authenticated` / `supabase_auth_admin`
-- roles, and auth.uid() / request.jwt.claims. None of that exists in a
-- bare Postgres, so this file creates just enough of it to load the real
-- schema unmodified and exercise its RLS policies locally.
--
-- It is TEST-ONLY. It is never run against a Supabase project (there the
-- real objects already exist). Run it first, then schema.sql:
--   psql -f supabase/tests/harness.sql -f supabase/schema.sql
-- ============================================================

-- ---------- roles ----------
do $$ begin create role anon nologin;                 exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin;        exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
do $$ begin create role supabase_auth_admin nologin;  exception when duplicate_object then null; end $$;

grant usage on schema public to anon, authenticated, service_role, supabase_auth_admin;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- ---------- auth schema ----------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);
grant select on auth.users to authenticated, service_role, supabase_auth_admin;

-- The request's user id, exactly like Supabase: the `sub` JWT claim.
create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
      ''
    ), '')::uuid
$$;

create or replace function auth.role()
returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', 'anon')
$$;

-- ---------- storage schema ----------
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id     text primary key,
  name   text not null,
  public boolean not null default false
);

create table if not exists storage.objects (
  id        uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name      text,
  owner     uuid,
  created_at timestamptz not null default now()
);
alter table storage.objects enable row level security;
grant all on storage.objects to authenticated;

-- ---------- realtime publication ----------
do $$ begin
  create publication supabase_realtime;
exception when duplicate_object then null; end $$;

-- ---------- test helper: "sign in" as a user ----------
-- Sets the JWT claims the policies read (sub = user id). The role claim is
-- stamped by custom_access_token_hook in production; here we call the hook
-- itself so the test uses the SAME derivation as the real auth server.
-- SECURITY DEFINER because schema.sql revokes EXECUTE on the access-token hook
-- from `authenticated` (it is the auth server's function). The helper only
-- sets the request GUCs; the statements under test still run as the caller,
-- so RLS is fully in force for everything the assertions exercise.
create or replace function public.test_sign_in(p_user uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare ev jsonb;
begin
  ev := public.custom_access_token_hook(
          jsonb_build_object('user_id', p_user::text,
                             'claims', jsonb_build_object('sub', p_user::text)));
  perform set_config('request.jwt.claims', (ev->'claims')::text, false);
end $$;

create or replace function public.test_sign_out()
returns void language sql security definer as $$ select set_config('request.jwt.claims', '', false) $$;

grant execute on function public.test_sign_in(uuid), public.test_sign_out() to authenticated;
