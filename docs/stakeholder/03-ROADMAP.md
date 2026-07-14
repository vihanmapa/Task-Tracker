# FM Navigate Execution Hub — Roadmap

*Prepared: July 2026 · Companion to 01-EXECUTIVE-OVERVIEW.md*

---

## Where we are

Shipped and live: tasks, deliverables, progress/evidence logging, weekly
planning with derived reporting, dashboard, 8-role access control, real-time
shared workspace, cloud attachment storage, mobile support. (Full inventory in
*02-SCOPE-FEATURES.md*.)

## Next: the KPI Tracker (management scorecard)

Turns the hub into the system of record for management's **monthly KPI
scorecard**: 22 KPIs across 5 categories, each scored 0–5 with evidence, notes,
and status, rolling up to per-category averages and an overall monthly score.
Replaces the `FM Navigate - KPI Tracker 2026.xlsx` workbook (14 sheets).

**Key design point:** the majority of KPI scores are *computed automatically*
from operational logs the team keeps as part of normal work — scores stop being
opinions and become evidence-backed measurements.

### KPI categories (22 KPIs)

| Category | Examples |
|---|---|
| A. Delivery & Technical | Sprint delivery rate, plan accuracy, issue-resolution SLA |
| B. Communication & Reporting | Monday report, Friday summary, transparency dashboard, risk reporting |
| C. Marketing & Sales | New clients, demos/week, content/month, leads/month, reseller pipeline, events |
| D. Operational Readiness & Compliance | (per workbook definitions) |
| E. Continuous Improvement | (per workbook definitions) |

Roughly two-thirds are **auto-scored** from logs; the rest are scored manually
with mandatory evidence attached.

### Supporting modules (the 9 operational logs)

| Phase | Modules | Why this order |
|---|---|---|
| **P1 — core** | KPI Scorecard, Risk Register | The scorecard itself + the log management reads most |
| **P2** | Sprint Tracker, Demo Log, Marketing Log, Issue Resolution, Clients | Feed the auto-scored KPIs in categories A & C |
| **P3** | Attendance, Leads (Sri Lanka + end-user) | Complete the evidence base |

All modules reuse the existing platform: same editing model, same evidence
system, same roles, same shared backend. No new infrastructure.

Detailed build plan: `docs/KPI-PLAN.md`.

## Also planned

- **RBAC completion** — finish rollout of the role system in the production
  database (schema + token hook); the application layer is already shipped.
- **People directory** — separate a collaborator-visible People picker (for
  assigning work) from the Owner-only user administration screen.
- **Hosted AI (optional)** — swap the built-in assistant's engine for a hosted
  model via a server-side function if richer summaries are wanted; the seam
  already exists, zero UI change.

## Deliberately deferred

Entity-level database normalization, per-feature tables, offline sync, and
concurrent multi-editor merging — revisited only if usage scale demands it.
The current architecture is documented (ARCHITECTURE.md + 4 ADRs) so these
decisions are auditable.
