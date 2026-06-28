# FM Navigate Execution Hub — Weekly Planning & Weekly Reporting

High-level implementation plan for the next execution layer: turn the existing
Task module into a **weekly execution loop** — plan Monday, execute all week,
report Friday, carry forward, repeat.

Status: **planning only — no UI built yet.** No code, migrations, or APIs here.

Grounded in the current architecture (no build step; in-browser React; one
`workspace` jsonb row per collection; tasks already hold all reporting signal).

---

## 1. Product Vision

A lightweight weekly operating rhythm layered on top of the existing backlog.

The Product Manager plans the week in under five minutes by **selecting existing
tasks** (never re-typing them), executes through the normal Task module all week,
and produces a polished Monday plan and Friday executive summary with one click
each. Reports are **generated from task activity**, not hand-written. Execution
performance accumulates over time and feeds the KPI Scorecard.

Design contract:
- A Weekly Plan **references** tasks; it never copies task data.
- Reports read live task state at generation time.
- Every screen reuses existing components, statuses, and the shared backend.
- The platform stays an *execution hub*, not a project-management tool.

---

## 2. User Journey

| Day | Action | Effort |
|---|---|---|
| **Monday AM** | Create week → pick backlog tasks → write objectives → generate Monday plan → edit → share | < 5 min |
| **Tue–Thu** | Work tasks normally (status, progress, comments) — no extra updates | 0 extra |
| **Friday PM** | Open week → one-click Friday summary → edit → publish | < 5 min |
| **Friday close** | Carry-forward sweep: incomplete tasks → next week / backlog / drop | < 2 min |

The Dashboard "Current Week" card is the landing page that ties the loop together.

```
Backlog → Weekly Plan → Monday Report → Daily Execution → Live Progress
   ↑                                                              ↓
   └──────── Carry Forward ←── Friday Summary ←──────────────────┘
```

---

## 3. Information Architecture

New top-level nav item **"Weekly Plan"** (`NAV` in `app.jsx`), placed between
`dashboard` and `kpi` so the loop reads Plan → Execute (Tasks/Deliverables) →
Score (KPI).

```
Dashboard      ← gains a "Current Week" card
Weekly Plan    ← NEW  (list of weeks + active-week workspace)
KPI Scorecard  ← gains weekly execution sub-scores / evidence
Deliverables
Tasks
Weekly Summary ← existing; folds into the Friday report engine
Ask AI
Settings
```

Weekly Plan screen has two modes (one component, route param):
- **Week list** — all plans, newest first, status chips, completion %.
- **Week workspace** — the active plan: objectives, task picker, live progress,
  report tabs (Monday / Friday), carry-forward panel.

New globals to add (mirrors `KpiScorecard` wiring): `window.WeeklyPlanScreen`,
loaded via a `weekly.jsx` `<script>` tag in `index.html` with the same `?v=` cache
bump, registered in `titleMap` and the `route ===` render block in `app.jsx`.

---

## 4. Weekly Planning Workflow

1. **Create week** — auto-fill week number + Mon–Fri date range from the calendar
   (reuse the `d()`/date helpers). PM only edits if needed.
2. **Set intent** — objectives (list), strategic focus (one line), risks, notes.
3. **Select tasks** — modal over the existing backlog with the same filters as the
   Task list (status, priority, category, deliverable). Selecting adds the task
   `id` to `plan.taskIds`. Tasks stay in the backlog untouched.
4. **Review capacity** (Section: Weekly Capacity) before committing.
5. **Generate Monday report** — one click; editable; status moves `draft → active`.

Carry-forward from the prior week pre-populates the task picker (see §7 Reporting
Logic and §"Carry Forward").

### Weekly Capacity Planning

Computed live from the selected task set — no new data entry:
- Planned task count.
- Priority distribution (Critical/High/Medium/Low) from `task.priority`.
- Estimated effort load — sum of `task.effort` (S/M/L → 1/2/3 points) vs. a
  configurable weekly capacity budget; over-budget shows a warning chip.
- Deliverables covered — distinct `task.deliverableId`.
- High-risk count — tasks with a non-empty `task.risk`.
- Blocked / Waiting count — from `task.status`.

This is a read-only panel that recalculates as tasks are added/removed, so the PM
balances the week before locking it.

---

## 5. Weekly Reporting Workflow

Two reports per week, both generated, both editable before sharing.

**Monday Planning Report** — sections: Weekly Objectives, Planned Deliverables,
Planned Tasks, High-Priority Work, Expected Outcomes, Key Risks, Dependencies.
Source: plan intent fields + the referenced tasks' fields
(`priority`, `dueDate`, `dependencies`, `risk`, `deliverableId`).

**Friday Executive Summary** — sections: Objectives Achieved, Major Deliverables
Progressed, Tasks Completed, Tasks Carried Forward, Risks Encountered, Key
Decisions, Challenges, Next-Week Priorities. Source: each referenced task's
**delta over the week** — `activity[]` entries, `progressLog[]`, status
transitions, `comments[]`, and `completedAt`/`progress` within the date range.

Generation reuses `window.aiService` exactly like the current
`generateWeeklySummary(buckets)`: build a structured bucket object from the
referenced tasks, ask the AI for prose, store the returned markdown on the plan as
`mondayReport` / `fridayReport`. The PM edits the stored text; edits persist. A
"regenerate" action overwrites only if confirmed (don't clobber manual edits
silently).

The existing **Weekly Summary** screen becomes the Friday engine's preview/host so
there's one summary surface, not two.

---

## 6. Dashboard Integration

Add a **Current Week** card to the Dashboard (top, above existing cards), reading
the active plan:
- Week number + date range.
- Objectives (collapsed list).
- Planned / Completed / Blocked counts + completion % ring.
- Upcoming deadlines — referenced tasks with `dueDate` in the next 3 days.
- One-click into the Week workspace.

If no active plan exists, the card shows a "Plan this week" CTA — making weekly
planning the default landing action.

---

## 7. Data Model

One new collection row, reusing the generic collection plumbing already proven by
`kpiScores`. Stored as a jsonb **array** in a `workspace` row id `weeklyPlans`
(seeded once via `supabase/schema.sql`, same as other collections — RLS UPDATE
policy already covers all rows; only the one-time seed INSERT is needed).

```
WeeklyPlan {
  id            'W-2026-26'        // year + ISO week, stable + sortable
  weekNumber    26
  startDate     ISO (Mon)
  endDate       ISO (Fri)
  status        'draft' | 'active' | 'closed'
  objectives    [ string ]
  strategicFocus string
  risks         string
  notes         string
  taskIds       [ 'T-101', ... ]   // REFERENCES only — never task copies
  capacityBudget number            // optional weekly effort points
  mondayReport  { text, generatedAt, edited:bool }
  fridayReport  { text, generatedAt, edited:bool }
  carriedFrom   'W-2026-25' | null
  createdAt / updatedAt  ISO
}
```

Why references only: a task's status, progress, activity, and deliverable link are
the single source of truth in the `main` blob. The plan stores `taskIds` and
**derives** everything else at render time. No sync, no drift, no duplicate updates.

Loaded/saved/subscribed via `dataService.loadCollection('weeklyPlans', [])`,
`saveCollection`, `subscribeCollection` — identical to the KPI wiring in `app.jsx`
(local mirror + realtime + editor-only writes).

---

## 8. Functional Requirements

- **FR1** Create a weekly plan with auto-filled week number and Mon–Fri range.
- **FR2** Add/remove backlog tasks to a plan via a filtered picker; backlog
  unchanged.
- **FR3** Edit objectives, focus, risks, notes inline.
- **FR4** Live capacity panel (counts, priority mix, effort load, risk, blocked).
- **FR5** Live progress panel (completed / in-progress / waiting / blocked / %,
  deliverable progress, upcoming due dates) derived from referenced tasks.
- **FR6** Generate + edit + persist the Monday report.
- **FR7** Generate + edit + persist the Friday summary.
- **FR8** Close a week: carry-forward sweep with per-task choice (carry / backlog /
  drop).
- **FR9** Dashboard Current-Week card.
- **FR10** KPI Scorecard receives weekly execution metrics as evidence/sub-scores.
- **FR11** All writes editor-gated; founder sees read-only; realtime sync; offline
  localStorage mirror — inherited from `dataService`, no new auth work.

---

## 9. UI / UX Design

- Reuse existing visual language: `styles.css` tokens, status colors (incl.
  `MD Review`), priority chips, progress rings, the card/section primitives in
  `components.jsx`.
- **Week workspace** layout: left = intent (objectives/focus/risks/notes);
  right-top = capacity + live progress; right-bottom = report tabs. Single scroll.
- **Task picker**: same row component as the Task list so a task looks identical
  whether in the backlog or the plan — reinforces "same task, referenced."
- Minimal clicks: create-week defaults filled; one-click report generation; inline
  editing everywhere (match the deliverable inline-edit pattern already shipped).
- Report editor: rendered markdown (existing `marked`+`DOMPurify` globals) with an
  edit toggle; "Copy" and "Regenerate" actions.
- Empty/first-run states guide the loop ("Plan this week", "Generate Friday
  summary").

---

## 10. Reporting Logic

The reporting engine is a pure function of the referenced tasks + the week's date
range; the AI only does prose.

1. **Resolve** `taskIds` → live task objects from `tasks`.
2. **Bucket** by derived state for the report type:
   - Monday: group by priority + deliverable; pull `dueDate`, `dependencies`,
     `risk`, `successCriteria`.
   - Friday: compute each task's **week delta** — filter `activity[]` and
     `progressLog[]` to `[startDate, endDate]`, detect status transitions and
     completions, collect in-range `comments[]`.
3. **Classify** for carry-forward: any referenced task not `Completed`/`Cancelled`
   at week close.
4. **Summarize** — hand the structured buckets to `aiService` (same call shape as
   `generateWeeklySummary`) for the narrative; assemble the section scaffold
   deterministically so structure is stable even if the AI is unavailable.
5. **Persist** the result text on the plan; never overwrite manual edits without
   confirm.

Deterministic fallback: if AI is off/unreachable, render the structured sections
from data alone (graceful degradation — the app already tolerates AI-absent).

---

## 11. KPI Integration

Weekly execution produces exactly the evidence the KPI Scorecard needs (see
`docs/KPI-PLAN.md`). Each closed week emits a metrics record:
- Planned vs. Completed, weekly completion rate.
- High-priority completion rate.
- Tasks carried forward, blocked-work trend.
- Deliverables progressed.

These feed KPI sub-scores the same way per-sprint A1/A3 sub-scores already roll up
(recent commit `KPI Scorecard: per-sprint sub-scores`). The Friday report becomes
an attachable **evidence** artifact for the relevant KPIs (Delivery/Reporting
categories), reusing the existing links/files/screenshot evidence system. No new
KPI mechanics — weekly data just becomes a feeder.

---

## 12. Implementation Phases

| Phase | Scope | Outcome |
|---|---|---|
| **P1 — Plan core** | `weeklyPlans` collection + seed; Weekly Plan nav/screen; create week; task picker; intent fields; persistence + realtime | Can plan a week end-to-end |
| **P2 — Live week** | Capacity panel + live progress panel (derived); Dashboard Current-Week card | Week is an operational dashboard |
| **P3 — Reporting** | Monday + Friday generation via `aiService`; editable persisted reports; deterministic fallback; fold in Weekly Summary screen | One-click reports |
| **P4 — Carry-forward** | Close-week sweep; carry/backlog/drop; pre-populate next week | Closed loop, no duplicate tasks |
| **P5 — Performance + KPI** | Per-week metrics record; trends; KPI sub-score/evidence feed | Execution measured over time |

Each phase ships independently and leaves the app working (matches the existing
incremental, cache-bumped release style).

---

## 13. Risks & Design Considerations

- **Stale references** — a referenced task is deleted. Resolve defensively: skip
  missing ids on render; offer a one-click cleanup. (The id high-water-mark in
  `data.js` already prevents id reuse, so a stale id never silently re-points.)
- **Report-vs-edit conflict** — regeneration must never clobber manual edits
  without confirm; track `edited` flag per report.
- **Week boundaries** — use ISO week + explicit start/end dates so date math and
  carry-forward are unambiguous across month/year edges.
- **AI availability** — reports must degrade to deterministic structure when AI is
  off; never block the Friday close on the model.
- **Realtime races** — two editor sessions on the same plan: rely on the existing
  last-write-wins blob model + `updated_by` echo-ignore; acceptable for a
  single-editor workflow.
- **Scope creep** — keep it a weekly *loop*, not a sprint tool. No estimates beyond
  S/M/L, no burndown charts in v1.
- **Seeding** — the new `weeklyPlans` row needs the one-time SQL seed (no INSERT
  policy); document it in `schema.sql` alongside `kpiScores`.

---

## 14. Future Enhancements

- Multi-week / monthly rollup view of completion trends.
- Auto-suggest the week's tasks from due dates, priority, and deliverable cadence.
- Template weeks (recurring objectives like sprint ceremonies).
- Slack/email push of the Friday summary.
- "What slipped and why" pattern analysis across weeks (chronic carry-forward).
- Capacity learning — calibrate the effort budget from historical completion.
- Tie recurring deliverables (e.g. Sprint Delivery `D-3` cycles) to auto-created
  weekly objectives.
