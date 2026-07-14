# PRD — FM Navigate Execution Hub v1.0

**Product:** FM Navigate Execution Hub
**Author:** Vihan Mapalagama (drafted with Claude)
**Date:** 2026-07-13 (rev. 1.4 — four-pillar architecture, multi-user demo checklist, 24h code freeze. Rev 1.3: renamed to Execution Hub, vision added. Rev 1.2: P0 cut to stakeholder commitment. **Planning closed — subsequent changes only from Richard's observed usage.**)
**Status:** Approved as implementation baseline
**Driver:** Richard (MD) feedback — he now treats the Execution Hub as Evbex's management workspace ("my eyes and ears"), not Vihan's personal task list.

## Product Vision

The Execution Hub is FM Navigate's executive operating workspace for planning, assigning, tracking, governing, and reporting work across the business. It provides a single source of truth for execution, replacing spreadsheets, chat updates, and fragmented reporting with one collaborative platform.

Tasks are one module within the Hub, not the product itself. The long-term architecture is four pillars:

```
Execution Hub
├── Execution
│   ├── Tasks                (live)
│   ├── Deliverables         (live)
│   ├── Weekly Planning      (live)
│   └── Progress Logs        (live)
├── Governance
│   ├── KPI Tracker          (planned — docs/KPI-PLAN.md)
│   ├── Risk Register        (P2)
│   ├── Decision Register    (P2)
│   └── Executive Approval   (P2)
├── Collaboration
│   ├── Comments             (live; integrity fix in P0)
│   ├── Attachments          (live; surfaced in P0)
│   ├── Activity Feed        (P1, evidence-gated)
│   └── Notifications        (P1, evidence-gated)
└── Intelligence
    ├── AI Assistant         (live)
    ├── Executive Reports    (Friday summary live; exec reports P2)
    └── Summaries & Recommendations (P2)
```

Naming note: the product name is **Execution Hub** (the platform for executing work) — deliberately not "Executive Hub"; it serves the whole team, with executive capabilities as one dimension. Stakeholder docs (01–03) already use this name. "Task" remains the atomic work item and is never renamed.

> **Rev 1.1 change note:** The original draft bundled watchers, in-app notifications, an executive feed, and new dashboard widgets into P0. Those were **product inferences, not Richard's requests**, and building them in demo week adds delivery risk. P0 is now exactly what Richard asked for; the inferred features moved to P1 with explicit evidence triggers.

---

## 1. Problem Statement

Richard reviews delivery through the Execution Hub but cannot act inside it: he cannot create, assign, or prioritise tasks, and his comments have no reliable path into the system. Executive direction still flows through meetings and chat, then gets re-typed into the Hub by Vihan — slow, lossy, and single-threaded on one person. If unsolved, the platform stays a reporting artifact instead of the management workspace Richard is asking for.

**Evidence — Richard's direct requests (meeting transcript):** access for himself, task creation, task allocation, prioritisation, commenting, file/link access on tasks, multi-user use, a demo next week, and a discussion with Isuru about reusing this inside FM Navigate.

**Not requested by Richard (product team inferences, held in P1 until usage proves the need):** watchers, notifications, an activity feed, dashboard changes, person filtering.

## 2. Current-State Audit (verified against code, 2026-07-13)

This PRD is grounded in what the codebase actually does today. Answers to the ten scoping questions:

| # | Question | Verified answer |
|---|----------|-----------------|
| 1 | Multiple owners per task? | **No.** Single `ownerId` string (`data.js`). No watcher/collaborator field. |
| 2 | Comments exist? | **Yes.** `task.comments[]` with composer in TaskDetail (`tasks.jsx:1552-1577`), `addComment` handler (`app.jsx:329`). Distinct from progress logs. **But** persistence writes the whole workspace blob, and RLS only lets `owner` + `product_manager` write — other roles' comments silently fail to persist. The composer is not permission-gated in the UI (latent bug). |
| 3 | Notification system? | **No.** The bell icon in the header (`app.jsx:849,890`) is a dead button. No in-app, email, or push delivery. |
| 4 | Task in multiple deliverables? | **No.** Single `deliverableId`, integrity-pruned in `repairData`. |
| 5 | Can Richard create/assign tasks today? | **Code-ready, deployment-blocked.** "New task" is gated by `canEdit = can('workspace','write')`, which the `owner` role has. RBAC-SETUP.md assigns Richard `owner`. But RBAC Phase 1 still needs `schema.sql` applied + the custom access-token hook enabled; until then Richard resolves to `viewer` and is read-only. |
| 6 | Full audit trail? | **Partial.** Per-task `activity[]` logs created/status/progress/comment/edit/revert/deliverable-link with `userId` + timestamp; field edits are revertible. Tasks carry `createdAt/updatedAt/completedAt`. Gaps: no `deletedBy` (hard delete, no tombstone), deliverables have thinner audit, no workspace-level audit table. |
| 7 | @mentions? | **No.** No mention parsing anywhere. |
| 8 | Task dependencies? | **Yes.** Structured `depTaskIds[]` plus free-text `dependencies[]`; TaskDetail shows both directions ("linked from" reverse lookup, `tasks.jsx:1453`); dangling ids auto-pruned. |
| 9 | Deliverable dependencies? | **No.** No dependency field on deliverables. |
| 10 | Dashboard filter by person? | **No on the dashboard** (aggregates all tasks). The task *list* already has an owner filter (`fOwner`, `tasks.jsx:105`). |

**Also verified:** task-level attachments **already exist** — `task.resources` renders via ResourceList in TaskDetail (`tasks.jsx:1543-1550`, shared + private items), in addition to progress-log evidence files and checklist attachments. Richard's "attachments are buried under progress" observation is a **section-ordering/visibility problem, not a missing feature**: TaskDetail currently renders Progress Log → Checklist → Resources → Comments.

**Consequence:** almost everything Richard asked for is already coded. P0 is an **activation and verification release**, not a build release. The only new code is a section reorder and a permission-gating fix.

**Architecture constraint that shapes P1+:** all tasks/deliverables/weeks live in one `workspace` jsonb row; every mutation rewrites the blob; realtime sync broadcasts the row. Registers, feeds, and notifications must work within (or gracefully beside) that model — normalization is explicitly deferred.

## 3. Goals

1. **Richard can direct work in-app:** create, assign, prioritise, and comment on tasks himself in the demo, and unaided in week 1 — zero requests relayed through Vihan.
2. **Every team member is in:** Richard, Jathu, and Isuru signed in with correct roles; Jathu assignable as a task owner.
3. **No silent data loss:** any comment a signed-in user is allowed to write actually persists; users who can't write see that clearly.
4. **Demo lands:** Richard completes create → assign → prioritise → comment → attach in the walkthrough without a workaround.
5. **Zero regressions to Vihan's workflow** — current task/progress/weekly flows unchanged.

## 4. Non-Goals (v1)

- **Watchers, notifications, activity feed, dashboard widgets, person filtering.** Not requested; P1 candidates gated on observed usage (see §6 P1). Building them in demo week is risk without evidence.
- **Email/push notification delivery.** No delivery infra exists; revisit only after in-app need is proven.
- **Multiple owners per task; task ↔ multiple deliverables.** No expressed need; both break existing accountability/roll-up semantics.
- **Workspace normalization (blob → tables).** Platform project; P1/P2 features are designed to survive it, not depend on it.
- **FM Navigate product module.** Richard's question gets a **feasibility discussion with Isuru** (P0 agenda item), not a build. Module decision after 1–2 months of real usage.
- **KPI Tracker build-out.** Already planned separately (docs/KPI-PLAN.md).

## 5. User Stories

**Richard (Managing Director / `owner` role) — all P0**
- As the MD, I want to sign in and have edit rights so that I can work in the Execution Hub directly.
- As the MD, I want to create a task with owner, priority, and due date so that direction lands in the system of record immediately.
- As the MD, I want to assign a task to anyone on the team (including Jathu) so that allocation doesn't route through Vihan.
- As the MD, I want to comment on any task and trust it saved, so that follow-ups don't need a meeting.
- As the MD, I want files and links visible at the top of a task, above progress history, so that I find current artifacts first.
- As the MD, I want a guided demo next week so that I can judge whether this becomes the team's workspace.

**Task owner (Vihan / Jathu / Isuru)**
- As a task owner, I want my comments to persist — or the composer to tell me I can't comment — so nothing silently vanishes. *(P0)*
- As a team member, I want to appear in the owner picker with my real profile so tasks can be assigned to me. *(P0)*

**P1 stories (build only when triggered — see §6):** watching a task, being notified of changes, scanning a cross-task feed, filtering by person.

## 6. Requirements

### P0 — Executive Collaboration Enablement (demo week; activation + verification, minimal new code)

*Framing for the demo: Richard isn't getting "RBAC activation" — he's getting the ability to participate in the workspace.*

**R1. Activate RBAC Phase 1 (critical path).**
Apply `supabase/schema.sql`, enable the custom access-token hook.
- [ ] **Snapshot the workspace row before any live change** (standing incident rule).
- [ ] Richard signs in → `canEdit` true → "New task" visible.
- [ ] A `viewer` account remains read-only at the DB (RLS verified, not just UI).

**R2. Profiles for the full team.** *(Inputs resolved 2026-07-13.)*
| Person | Email | `app_role` |
|---|---|---|
| Vihan Mapalagama | vihancmapa@gmail.com | `owner` (runs the platform day-to-day) |
| Richard Davies | richard.davies@evbex.com | `owner` (Managing Director) |
| Isuru Perera | (existing account) | `tech_lead` |
| Jathurshan Sivakumaran | jathurshan.sivakumaran@evbex.com | `business_analyst` |

*Role note (2026-07-14): two owners by decision — Vihan administers the platform, Richard is the MD; both hold full authority. The schema's last-active-owner guard prevents lockout. A "Managing Director" display label is a cosmetic follow-up if wanted.*

Jathurshan's business title is Senior Business Analyst; the enum has no seniority tiers, so `business_analyst` — permission tiers only if permissions genuinely diverge later. Verify the owner/assignee picker lists real profiles (not just the legacy 3-person USERS map) and attribution resolves via `window.userOf()`.
- [ ] All four sign in; each shows correct name/role badge.
- [ ] Jathurshan selectable as owner on a new task.
- [ ] ~~Known Phase-1 limit: Isuru/Jathurshan read-only~~ **Superseded 2026-07-13** by the Jira-style execution model (decision 0005): all delivery roles can now execute tasks (progress, comments, checklist, evidence, create); owner/priority changes stay with owner/PM/tech-lead, deletes with owner/PM. Requires re-running the updated `schema.sql` workspace write policy.

**R3. Verify Richard's create / assign / prioritise flow end-to-end.**
No new code expected — live verification of the existing composer under the `owner` role.
- [ ] Richard creates a task with title, owner, priority, due date in < 30s.
- [ ] Task syncs in realtime to a second signed-in session.
- [ ] Priority and owner editable after creation; edits attributed to Richard.

**R4. Comment integrity.**
- [ ] Comment by owner/PM persists across reload and to other sessions.
- [ ] Composer hidden or disabled-with-explanation for roles whose writes RLS rejects — no silent loss.
- [ ] Decision recorded on how non-editor roles (Isuru/Jathurshan) get comment rights. **Note:** `schema.sql` already ships `public.comments` + `public.activity_log` tables with RLS (non-viewer insert allowed) — the data foundation exists; only client wiring is missing. That makes "wire the comments table" the clear P1 path; interim coarse workspace-write grant remains the fallback, decided with Richard.

**R5. Attachments surfaced.**
Reorder TaskDetail: Description → **Attachments** (renamed from Resources) → Checklist → Progress Updates → Comments.
- [ ] Attachment count visible without scrolling into progress history.
- [ ] Add-link and add-file verified working at task level under Richard's role.
- [ ] Progress-log evidence untouched (logs stay history; nothing migrated).

**R6. Demo preparation.**
- [ ] Scripted walkthrough: sign-in → dashboard glance → create task → assign to Jathu → set priority → comment → attach link → show MD Review status in the existing board.
- [ ] Seed/live data sanity pass (no orphaned attributions, no test junk).
- [ ] Agenda item with Isuru: FM Navigate reuse feasibility (architecture: static bundle + Supabase vs. FM Navigate stack; what embedding/module would require). Outcome = a one-page technical note, not a commitment.
- [ ] **Multi-user verification checklist** run end-to-end with two live sessions before the demo:
  1. Richard creates a task → Vihan's session shows it in realtime.
  2. Richard reassigns it to Jathu → Jathu's session shows the assignment.
  3. Richard comments → comment survives a hard refresh in both sessions.
  4. Richard attaches a file/link → another user can open it.
  5. Each action above produced an attributed `activity[]` entry (correct person, correct time).
- [ ] **Code freeze 24h before the demo.** After freeze: no new features; only demo-blocking bug fixes. Remaining time = testing, data cleanup, rehearsal.

**Then stop.** Nothing else ships before the demo.

### P1 — Evidence-gated (observe Richard 1–2 weeks, build what usage proves)

Each item has an explicit trigger. No trigger observed → stays unbuilt.

| Feature | Build when Richard (or team) says/shows | Notes |
|---|---|---|
| **Notifications (in-app)** | "I don't know when something changes" / MD comments go unanswered | Derive client-side from realtime activity deltas; wire the dead bell. |
| **Executive feed** | "I have to open every task to see what happened" | Pure presentation — flatten existing `task.activity[]`. Cheapest of the three. |
| **Watchers** | "I want to follow this task" / he comments just to get updates | `watcherIds[]` on task; feeds notification fan-out. |
| **Dashboard widgets (MD Review, Today's Priorities)** | He asks "what needs me?" or keeps filtering the list manually | Most aggregates already computed in `dashboard.jsx`. |
| **Person filter on dashboard** | 1:1 prep pain / "show me only Jathu's work" | Reuse task-list `fOwner` pattern. |
| **Comment rights for non-editor roles** | Isuru/Jathu blocked from responding to MD comments | Proper fix = `comments` table + per-resource RLS. |

### P2 — Future considerations (design for, don't build)

- **Comments/notifications as real tables** (per-resource RLS, server-side unread; prerequisite for mentions). New collections keyed by stable ids so migration is mechanical.
- **@mentions**; **deliverable dependencies**; **email/digest delivery**; **Users vs People split** (per existing decision memo).
- **Executive approval workflow** — Richard regularly approves proposals, pricing, architecture, and commercial documents; today that's a comment saying "Approved". Future: a first-class approval action with Pending Approval / Approved / Rejected states and audit entry. Scaffolding already exists: the `MD Review` status (shipped June) is the de-facto pending state, and `permissions.js` already defines an `approve` action on tasks (owner / product_manager / tech_lead). Not built now — recorded so the P1/P2 data model doesn't preclude it.
- **Decision / blocker / risk registers** — from the earlier draft; revisit alongside KPI plan once Richard is active in the tool and asks "what concerns me?" in-app.
- **AI executive actions** (exec summary, weekly report, risk/delay summaries) — extend existing AI service once reporting demand is observed.
- **FM Navigate "Executive Workspace" module** — decision after 1–2 months of usage + Isuru's feasibility note.

## 7. Success Metrics

**Demo (week of Jul 20)**
- **Adoption proof:** Richard creates, assigns, comments on, and reprioritises at least one *real* task during the demo without assistance — not a scripted showcase, his own work item.
- Richard completes the full walkthrough flow himself, no workarounds.
- All four team members signed in with correct roles before the meeting.

**Leading (first 2 weeks)**
- Richard creates ≥ 3 tasks himself in week 1; zero tasks relayed through Vihan for entry.
- ≥ 1 task assigned to Jathu and ≥ 1 to Isuru by Richard.
- Zero lost comments (no reports of "I commented and it disappeared").
- **P1 trigger log:** every friction Richard voices is captured verbatim — this list *is* the P1 backlog input.

**Lagging (4–8 weeks)**
- Richard uses the Execution Hub (not chat/meetings) as the default channel for new direction — his subjective confirmation at 1 month.
- FM Navigate module go/no-go decision made on usage evidence + feasibility note.

**Measurement:** no analytics; measure via workspace data itself (creator ids, comment timestamps) + direct observation. Evaluate at demo, 2 weeks, 6 weeks.

## 8. Open Questions

| Q | Owner | Status |
|---|-------|--------|
| ~~Jathurshan's email + role~~ | — | **Resolved 2026-07-13:** jathurshan.sivakumaran@evbex.com, `business_analyst` (Senior BA title maps to existing role; no enum change) |
| ~~Richard's sign-in email~~ | — | **Resolved 2026-07-13:** richard.davies@evbex.com (RBAC-SETUP.md updated) |
| ~~Interim comment rights for Isuru/Jathurshan~~ | — | **Resolved 2026-07-13:** Jira-style execution model (decision 0005) — delivery roles get workspace write (coarse, RLS) with fine-grained rules app-enforced; comments-table wiring stays the P2 hardening path |
| Do MD-created tasks default to a deliverable, or is unlinked acceptable? (affects roll-ups) | Vihan | Open — No blocker |

## 9. Timeline & Phasing

**Hard deadline:** Richard's demo next week (week of Jul 20). P0 = R1–R6, in order — R1 → R2 → R3 → R4 → R5 → R6. R1/R2 touch the live database: snapshot workspace first, verify on staging check, then apply. R5 is the only UI code change; R4 gating is a small guard.

- **Phase 1 (this week):** R1–R6. Ship via existing pipeline (GitHub Pages, esbuild, cache-version bump).
- **Phase 2 (weeks 2–4):** observe usage; build only triggered P1 items, in trigger order. At the 2–3 week mark, run a dedicated **workflow feedback session** with Richard — about his morning routine, not features: What did you look for first each morning? What took extra clicks? What did you still ask Vihan instead of the system? What frustrated you? What did you expect to find but couldn't? Answers rank the P1 table; the trigger log (§7) is the input.
- **Phase 3 (later):** normalization, registers, AI actions, module decision.

**Dependencies:** Supabase access-token hook (dashboard toggle, owner action); Isuru's time for the feasibility discussion. No other external dependencies.

## 10. Testing & Rollout Notes

- All writes go through the existing debounced/retried save path (post-incident telemetry stays).
- Test in isolated local mode (scratchpad copy + `DATA_BACKEND 'local'` + seeded localStorage) — never against prod Supabase.
- Attribution must use `window.userOf()` everywhere (RBAC profile ids are not in the static USERS map).
- Bump asset cache version on release.
