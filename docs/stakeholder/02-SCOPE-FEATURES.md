# FM Navigate Execution Hub — Full Scope & Feature Inventory

*Prepared: July 2026 · Companion to 01-EXECUTIVE-OVERVIEW.md*

This document is the complete functional scope of the platform as shipped,
module by module.

---

## 1. Tasks (core module)

The atomic unit of work. Everything else in the platform references tasks —
nothing copies them.

- **Views:** sortable list, kanban board, and deliverable-grouped list.
- **Workflow:** Not Started → In Progress → Waiting / Blocked → MD Review →
  Completed / Cancelled.
- **Priorities:** Critical, High, Medium, Low.
- **Categories:** Product Development, Delivery, Technical, Compliance, Sales,
  Marketing, Operations, Administration, Personal.
- **Fields:** owner, due date (with overdue badges), description, resources
  (links/files), progress %.
- **Checklists:** Trello-style sub-items on any task. Completing items is
  captured in the progress log that delivered them (who, when, which update).
- **Entry paths:** manual form, or **bulk paste** — plain text, numbered/bulleted
  lists, spreadsheet rows (TSV), or labeled markdown blocks are parsed into
  individual structured tasks automatically.
- **Navigation:** task ↔ deliverable deep links; every task/deliverable has a
  shareable URL.

## 2. Progress logs & evidence

- Per-task updates with %, status change, notes, multiple evidence links, and
  image/file attachments (paste a screenshot directly).
- In-app image lightbox for reviewing evidence.
- Attachments stored in dedicated cloud storage (not inline) — keeps the
  workspace fast regardless of how much evidence accumulates.
- Logs are the **history**; checklists/status are the **state**. Editing or
  deleting a log never silently reverts work records.

## 3. Deliverables (milestones)

- Parent milestones grouping related tasks; progress rolls up live.
- **5 business categories:** A — Delivery & Technical Team Management,
  B — Communication & Reporting, C — Marketing/Pre-Sales/Sales,
  D — Operational Readiness & Compliance, E — Continuous Improvement & Coordination.
- **3 delivery models:**
  - *One-Time* — single milestone with start/target dates.
  - *Recurring* — repeats on a cycle, with per-cycle history.
  - *Target-Based* — numeric target progress by a deadline.
- Statuses: Active, On Hold, Delivered, Cancelled.
- Inline editing of every field from the detail view.

## 4. Weekly Planning (execution loop)

Plan Monday → execute → report Friday → carry forward → repeat.

- Create/complete/delete weeks; navigate historical closed weeks.
- Weeks **select** existing backlog tasks (no re-typing); objectives and notes
  per week.
- **Monday Plan** and **Friday Executive Summary** generated on demand from
  live task activity: plan-vs-actual, activity counts, work delivered
  (from checklist completions), and deliverable movement during the week.
- Carry-forward sweep at week close: incomplete tasks → next week, backlog, or drop.
- Weeks store *intent* only; all reporting is derived from dated progress logs —
  reports stay truthful even when edited after the fact.

## 5. Dashboard

- KPI cards: totals, average progress, weekly activity.
- Current-week card as the daily landing point.

## 6. Assistant (built-in, private)

- **Task extraction** — paste unstructured text, get structured tasks.
- **Ask** — natural-language Q&A over the live workspace.
- **Weekly summary** — narrative generation for reports.
- Runs fully in the browser (heuristics/templates) — no data sent to any AI
  vendor, no API keys. Architecture has a ready seam to swap in a hosted model
  later without UI changes.

## 7. Access control & identity

- Supabase authentication; every action attributed to the signed-in user.
- **8 roles** with distinct permissions: Owner, Product Manager, Investor,
  Business Analyst, Tech Lead, Software Engineer, QA Engineer, Viewer.
- Enforcement is **server-side**: the role is stamped into the auth token and
  Postgres Row Level Security rejects unauthorized writes — a tampered client
  cannot bypass it. The UI layer additionally hides what a role can't use.
- Read-only stakeholder access (Investor/Viewer) is safe by construction.

## 8. Data platform & reliability

- **Single versioned workspace document** in Supabase; localStorage mirror for
  resilience; realtime sync pushes changes to all open sessions instantly.
- **Honest persistence:** save status indicator (Saving/Saved/Failed), verified
  writes, automatic retry of transient failures, no overlapping saves,
  debounced text autosave.
- **Load-failure safety:** a failed load can never be mistaken for an empty
  workspace (hardened after a June 2026 incident; fix verified in production).
- **Backup:** one-click export to JSON; import upgrades any version through the
  migration registry and validates before saving.
- **Migrations:** registry-based, one-time, automatic on load.

## 9. Delivery & operations

- Hosted on GitHub Pages; built via esbuild in CI on every push to `main`.
- Clean URLs with full deep-link support (direct links to any task/deliverable
  survive reload and sharing).
- Mobile: off-canvas drawer navigation; responsive layout.
- Themes: light/dark, density and scale controls per user.

## 10. Explicit non-goals (by design)

- Not a general project-management suite — it is an *execution hub*.
- No per-feature database sprawl; one workspace document until scale demands otherwise.
- No cloud AI dependency by default.
