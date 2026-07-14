# FM Navigate Execution Hub — Executive Overview

*Prepared: July 2026 · Audience: Founder / MD / Management · Status: Live in production*

---

## What it is

The Execution Hub is FM Navigate's single source of truth for **what is being done,
by whom, and how it's going** — replacing scattered spreadsheets, chat updates,
and hand-written status reports with one live, shared workspace.

**Live now at:** https://vihanmapa.github.io/Task-Tracker

## The problem it solves

| Before | Now |
|---|---|
| Status lived in spreadsheets and memory | One shared workspace, updated in real time |
| Weekly reports hand-written from recollection | Monday Plan & Friday Summary generated from actual task activity |
| Evidence (screenshots, links) scattered across chats | Attached directly to progress logs, auditable per task |
| No visibility into deliverable-level progress | Milestones roll up live from task progress |
| "Who changed what?" unanswerable | Every action attributed to a signed-in user with a role |

## What's live today

- **Task management** — list and kanban views, 7 workflow statuses (including MD Review),
  4 priority levels, 9 business categories, owners, due-date tracking, checklists.
- **Deliverables (milestones)** — group tasks under deliverables across 5 business
  areas (Delivery & Technical, Communication & Reporting, Marketing & Sales,
  Operational Readiness & Compliance, Continuous Improvement). Three delivery
  models: one-time, recurring (with cycle history), and target-based.
- **Progress logging with evidence** — every update carries %, status, notes,
  links, and file/screenshot attachments. Checklist completions are tied to the
  log that delivered them — state and history never drift apart.
- **Weekly operating rhythm** — plan Monday in under 5 minutes by selecting
  existing tasks; work normally all week; one-click Friday executive summary
  derived from real activity (plan-vs-actual, work delivered, deliverable movement).
- **Dashboard** — KPIs, average progress, weekly activity, current-week card.
- **Role-based access** — 8 roles (Owner, Product Manager, Investor, Business
  Analyst, Tech Lead, Engineer, QA, Viewer), enforced server-side at the database.
  Stakeholders can be given read-only access safely.
- **Built-in assistant** — paste any meeting notes or task list and it becomes
  structured tasks; ask questions over the workspace; generate weekly narratives.
  Runs entirely in-app — no data leaves the platform.

## Reliability & data safety

- Real-time sync across all users; changes attributed to the signed-in person.
- Honest save verification — the app confirms a write actually landed, retries
  transient failures, and shows Saving / Saved / Failed status at all times.
- One-click full workspace export/import for backup and audit.
- Automatic schema migration — no manual data intervention on upgrades.

## What's next (headline)

The platform becomes management's **KPI Tracker**: the 22-KPI monthly scorecard
(5 categories, 0–5 scoring with evidence) plus the 9 supporting operational logs
(Risk Register, Sprint Tracker, Demo Log, Marketing Log, Issue Resolution,
Clients, Attendance, Leads). Most KPI scores compute automatically from logs the
team already keeps. See *03-ROADMAP.md*.

## Cost & footprint

Runs on GitHub Pages (free static hosting) + a single Supabase project
(free/low tier). No servers to maintain, no per-seat licence.
