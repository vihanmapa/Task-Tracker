# 0008 — Account signup and organization membership are separate

**Status:** accepted · 2026-08
**Supersedes:** the auto-join in the first Phase-3 `handle_new_user`
**Related:** `docs/TDD-PERSONAL-TASK-WORKSPACES.md` §10, ADR 0006

## Context

Phase 3 opened self-registration and, on signup, added the new account to the
primary organization. The role was safely `member`, so the account had no
management capability — but it *was* an Evbex workspace member, and a member
sees the organization's people, its document, its deliverables and its
governance screens.

Anyone who could reach the signup form could become one. The product
requirement is that anyone can have a task tracker, not that anyone can join
the company.

## Decision

**Registration creates an account. Only an invitation or an administrator
creates a membership.**

Signup (`handle_new_user`, SECURITY DEFINER, trigger-only) creates:

1. the profile, `role = 'member'` hardcoded — never read from client metadata;
2. a **personal workspace**: an organization with `kind = 'personal'`,
   `owner_user_id = the new account`, and that account as its only member;
3. nothing in any existing organization.

Joining a team organization goes through `add_organization_member(org, user)`:
SECURITY DEFINER, locked `search_path`, `authorize('users.assign_roles')`
before it writes, refuses an organization the caller is not in, and refuses a
personal workspace. `organization_members` has **no INSERT policy at all**, so
this is not one path among several — it is the path. An email invitation flow
can later call exactly this function without moving the boundary.

### Why a personal workspace (Option A) rather than org-less tasks (Option B)

A personal workspace is an ordinary organization. Every task policy, the tenant
boundary, `is_org_member`, the client's org resolution and the whole UI work
there unchanged — **no second code path and no special case in RLS**. Option B
would have meant `organization_id` becoming nullable and every policy growing an
"…or it has no organization and belongs to me" branch: more distortion, more
places to get wrong, for the same product outcome.

## Consequences

- A public account can use the product immediately and can reach nothing of
  anyone else's. Proven at the database, not by hiding UI.
- Existing staff keep their memberships. The Evbex back-fill is now **one-shot
  behind a marker row** — `schema.sql` is re-runnable by design, and an
  unguarded `insert … select from profiles` would have swept every public
  account into Evbex the next time anyone applied the file. That guard is
  load-bearing, not tidiness.
- Every pre-existing account also gets a personal workspace, so the model is
  uniform rather than split between old and new users.
- A user in both a team organization and their personal one needs a rule for
  where new tasks go: the team organization wins. Staff work in Evbex; people
  with only a personal workspace work in theirs.
- Multi-org switching is still not built. The schema now genuinely supports it
  (everyone already has two organizations); the UI does not, and that is the
  honest limit.
