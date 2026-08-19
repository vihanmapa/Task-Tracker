# 0006 — Normalize tasks (only tasks) for per-user privacy

**Status:** accepted · 2026-08
**Supersedes for tasks only:** [0001 — unified workspace document](0001-unified-workspace-document.md)
**Related:** [0005 — Jira-style execution permissions](0005-jira-style-execution-permissions.md),
`docs/TDD-PERSONAL-TASK-WORKSPACES.md`

## Context

ADR 0001 put every collection in one versioned jsonb document and listed the
conditions that would justify revisiting it. Two of them have now happened:

> - Multiple users editing the same workspace concurrently.
> - Per-feature permissions are introduced.

The product requirement is stronger than either: **a standard user must not be
able to retrieve another person's tasks**, including by calling the API
directly. A document has no rows, so Postgres cannot express that. The Phase-2
schema said so plainly — its only enforceable task gate was "may write the blob
at all". Any per-user filtering on top of a whole-document read would be
decoration, not security.

## Decision

Normalize **tasks and their children only**:

```text
tasks · task_checklist_items · task_progress · task_resources ·
task_comments · task_activity
```

Everything else — deliverables, weekly plans, KPI scores — stays in the
workspace document. They are organization-wide governance content already gated
by `admin.workspace`; normalising them would buy no privacy and cost a
migration.

Within the normalized tables, **value lists stay jsonb**: `dependencies`
(free-text labels), `dep_task_ids`, per-entry `links`/`files`, and the
field-edit history `edits`. They are values of a task, always read and written
with their parent row, and giving each its own table would add joins for zero
security gain.

## Consequences

**Gained**
- Per-task RLS: privacy, management scope and the tenant boundary are decided by
  Postgres, on every request, for the UI and a raw REST call alike.
- Concurrency improves: last-write-wins is now per task row, not per whole
  document.
- Reporter and assignee become real columns, so "who raised it" and "who owes
  it" stop being inferred from an activity feed.

**Paid**
- Two persistence paths during the rollout (normalized ↔ document), chosen at
  runtime by probing for the tables. Deliberate: it removes the cutover instant
  where client and schema must match, and it is the rollback.
- The write path is now a diff-and-push (`task-store.js`) rather than "save the
  whole document". More code, but it sends only what changed — which is also
  what keeps the governance trigger honest.
- Adding a *task* field is no longer free: it needs a column. Adding a new
  *feature* collection is still free — ADR 0001 still governs everything else.

**Not done, on purpose**
- The document's copy of the tasks is not deleted by the migration. It is the
  rollback target. Retiring it is a separate, later, opt-in step
  (`prune_migrated_tasks_from_document`), and it is destructive.

## Alternatives considered

**Keep the document, filter in the client.** Rejected outright: it is not
security. Anyone signed in could read the whole document from the API.

**Encrypt per-user sections of the document.** Rejected: key management for a
5-person team, no queryability, and management oversight becomes impossible.

**Normalize everything.** Rejected as over-engineering: deliverables, weeks and
KPI have no per-user privacy requirement, and ADR 0001's reasoning still holds
for them.
