# 0005 — Jira-style execution permissions (governance vs. execution)

**Date:** 2026-07-13 · **Status:** Accepted

## Context

RBAC Phase 1 gated ALL writes behind `workspace.write` (owner + product_manager).
Multi-user testing with Richard (owner) and Jathurshan (business_analyst) proved
the collaboration flow but left every non-owner/PM delivery role read-only —
Jathurshan could be assigned a task he couldn't update. The intended model is
Jira-like: everyone involved in execution can execute; only governance is
restricted.

## Decision

Split permissions into two groups, extending (not replacing) the existing
`RBAC.can(role, resource, action)` framework:

- **Execution** (`tasks: write/create`) — all six delivery roles (owner, PM,
  tech_lead, business_analyst, developer, qa): work any task (progress,
  comments, checklist completion, evidence/resources, status changes, create
  and linked tasks), and edit descriptive fields on tasks they **own or
  created**.
- **Governance** — `tasks: assign` + `prioritize` (owner/PM/tech_lead),
  `tasks: delete` (owner/PM), deliverables/weekly/KPI/import/clear (owner/PM
  via `workspace.write`), users (owner only — unchanged), settings (owner).

New task actions in `permissions.js`: `create`, `assign`, `prioritize`.
New auth-context flags: `canExecute`, `canAssign`, `canPrioritize`,
`canDeleteTask` (`canEdit` keeps its meaning: governance).
All checks stay centralized in the `app.jsx` mutation handlers; UI flags only
shape rendering. Execution roles may edit/delete only their **own** progress
entries; governance may touch any.

## Deviations from the requested matrix (deliberate)

1. **User management stays owner-only** (matrix suggested PM ✓). The DB
   trigger and Users page are owner-scoped by an earlier decision
   (users-vs-people split); granting PM a client-side `users.write` would
   render UI the database rejects.
2. **Investor loses the comment composer** (client config nominally allowed
   `comments.write`). The DB never accepted investor writes — the composer was
   silently discarding their comments. Hidden until comments move to the
   `public.comments` table.

## Consequence: honest security boundary

The workspace is still ONE jsonb row, so RLS can only gate "may write the blob
at all" — now granted to all six delivery roles (`schema.sql` updated; investor
+ viewer remain read-only at the DB). The finer split (assign/prioritize/delete,
own-task field edits, own-entry progress edits) is app-enforced and a tampered
client could bypass it. Accepted for a small trusted team; becomes DB-enforced
when the blob is normalised into per-resource tables (same `can()` calls, no UI
rewrite).

## Future: Reporter / Assignee (documentation only — NOT implemented)

Today `task.ownerId` functions as the **assignee** (Jira sense), while the
**reporter** (creator) is only derivable from `activity[]` (`type: 'created'`
entry's `userId`). Places that assume "Owner" means the assignee:

| Location | Assumption |
|---|---|
| `app.jsx` `buildTask` | `ownerId: data.ownerId \|\| currentUser` — creator defaults to assignee |
| `app.jsx` `isMyTask` | "my task" = I'm `ownerId` OR I created it (already reporter-aware) |
| `tasks.jsx` list column `owner`, sort `owner`, filter `fOwner` | render/sort/filter by `ownerId` |
| `tasks.jsx` TaskDetail sidebar "Owner" row + `fmtVal('ownerId')` | label says Owner, semantics are assignee |
| `ai-compose.jsx` owner pickers (single + batch) | sets `ownerId` at creation |
| `ai-service.jsx` `ownerName` | AI prompts describe `ownerId` as owner |
| `data.js` seeds + `SEED_DELIVERABLES` | seed `ownerId` values |
| Weekly derivations | none — weeks derive from logs/activity, not `ownerId` (no change needed) |

Migration plan when we do it: (1) add `reporterId` populated from the
`created` activity entry (backfill script over the blob), (2) rename UI label
Owner → Assignee (data key `ownerId` can stay for compatibility), (3) update
`isMyTask` to `assigneeId === me || reporterId === me` (semantics unchanged),
(4) add a Reporter column/filter. No DB migration needed while the blob model
holds — it's a per-task key addition.
