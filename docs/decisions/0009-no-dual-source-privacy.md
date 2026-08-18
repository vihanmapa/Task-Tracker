# 0009 — No dual-source privacy

**Status:** accepted · 2026-08
**Related:** ADR 0006, ADR 0007, `docs/TDD-PERSONAL-TASK-WORKSPACES.md` §19

## Context

Normalising tasks secured the new copy of the data. It did not remove the old
ones. After migration the same task existed in the workspace document, its
attachments sat in Storage, its events went to the audit log, and its id could
appear in a generic comments table — each with its own, older, more permissive
policy written when none of them held task data.

The result was one invariant with several answers: the `tasks` table would
correctly refuse a user another person's work while `activity_log` handed them
its title and `workspace` handed them the whole thing.

## Decision

**Once normalized task security exists, no other representation of a task may
answer differently.** Concretely, every path was brought to the same rule — a
row about a task is visible exactly when the task is:

| path | before | after |
|---|---|---|
| `tasks` + children | assignee/reporter/view_all | assignee/view_all (ADR 0007) |
| workspace document | `deliverables.read` | `deliverables.read` **and** no task payload present, else `tasks.view_all` |
| document's task copy | left in place | moved to an admin-only archive by an explicit step |
| Storage attachments | any signed-in user | parent task's scope; unknown ids need `tasks.view_all` post-migration |
| `activity_log` | `using (true)` | task rows follow the task; others are yours or need `admin.audit_log` |
| `public.comments` | `using (true)` read, unscoped insert | both follow the parent task |
| `legacy_user_map` | readable by all | revoked; migration-internal only |
| `map_legacy_user()` | executable by all | revoked; no account-probing oracle |

**Client-side filtering is never the answer.** A standard user's browser must
not receive another person's task and then be trusted to hide it. Each of the
above is a policy or a revoke, and each has a test that runs against real
Postgres.

## Consequences

- The document's task copy is **archived, not deleted**:
  `archive_workspace_tasks()` moves it to an administrator-only table and
  empties the shared document. `restore_workspace_tasks()` puts it back, so
  "stop reading the new tables" remains a complete rollback. Explicit,
  dry-run-first, owner-gated, and it refuses to run unless
  `verify_task_migration()` is green.
- Between migrating and archiving, the document is management-only. That is
  safe-by-default but it takes Deliverables/Weekly/KPI away from other roles,
  so archiving belongs **immediately after verification** in the runbook, not
  "some time later". The alternative — leaving the blob readable meanwhile —
  is the hole this ADR exists to close.
- `comments.read` joins `comments.write`/`comments.moderate` as documented
  dead-table RLS: the policies are live and correct, but no UI uses that table,
  so they stay Planned rather than pretending to be user-visible switches.
- New rule for future work: **any table that can hold a task id needs a task-
  scoped policy before it holds one.** The audit log is the cautionary tale —
  its `using (true)` was correct on the day it was written and became a leak
  when Phase 3 started writing task events into it.
