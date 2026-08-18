# 0007 — Reporter is metadata, not authorization scope

**Status:** accepted · 2026-08
**Supersedes:** the reporter clause in the Phase-3 scope predicates
**Related:** `docs/TDD-PERSONAL-TASK-WORKSPACES.md` §8, ADR 0006

## Context

The first Phase-3 implementation scoped tasks as:

```text
assignee = me  OR  reporter = me  OR  tasks.view_all
```

Including reporter felt generous and read well — "you should still see what you
raised". In practice it means something else entirely: a standard user keeps
**read and execute** rights over a task forever, on the strength of having typed
it in once. Reassignment stops meaning anything. A manager cannot move work
away from someone; they can only add someone. Every task any person has ever
created stays in their reach for the life of the workspace.

That is the exact behaviour normalising tasks was meant to end.

## Decision

**Standard task scope is the assignee relationship. Reporter grants nothing.**

```text
can_read  = is_org_member(task.org) AND authorize('tasks.read')
            AND (task.assignee_id = auth.uid() OR authorize('tasks.view_all'))

can_write = is_org_member(task.org) AND authorize('tasks.execute')
            AND (task.assignee_id = auth.uid() OR authorize('tasks.view_all'))
```

`reporter_id` stays exactly as it was: recorded at creation, pinned to
`auth.uid()` by the INSERT policy, immutable afterwards, and displayed in the
task detail beside the assignee. It is a fact about the task's origin. It is not
a capability.

Seeing across people is `tasks.view_all` — one runtime-configurable permission,
never a role name, never a job title, never an object relationship that
happens to be lying around.

## Consequences

- A manager who raises work for someone else still sees it — because they hold
  `tasks.view_all`, not because they raised it. The distinction is invisible in
  normal use and decisive when the grant is revoked, which the test suite
  exercises directly.
- Delegating work removes it from your reach unless you are management. That is
  the intended product behaviour: a personal tracker shows what you owe.
- "Tasks I requested" is now a missing feature rather than an accidental one.
  When it is wanted it should arrive as its own capability
  (`tasks.view_reported`) or an explicit sharing/object-role mechanism — a
  deliberate grant, visible in the Roles & Permissions screen, revocable.
  Deliberately not built here.

## Alternatives considered

**Reporter keeps read but not write.** Rejected: still a permanent, invisible,
non-revocable grant over another person's work, just a quieter one. Half a hole
is a hole, and it would have to be explained in every future audit.

**Reporter keeps access until first reassignment.** Rejected: state-dependent
authorization that no policy can express without extra columns, and nobody
could predict from the UI who can see what.
