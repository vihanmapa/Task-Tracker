# FM Navigate Execution Hub — KPI & Operations Plan

Source of truth for turning the app into the management **KPI Tracker**.
Derived from `FM Navigate - KPI Tracker 2026.xlsx` (14 sheets).
Status: **planning only — no UI built yet.**

---

## 1. What management requires

A **monthly KPI scorecard**: one sheet per month, **22 KPIs in 5 categories**,
each scored **0–5** with an **evidence** link/file/screenshot, notes, and status,
auto-rolling up to **per-category averages + an overall score**. Nine supporting
**operational logs** produce the evidence behind the scores.

Scoring guide (from the workbook): `0 = No progress … 5 = Fully met / exceeded`.

---

## 2. Module inventory (target state)

All modules live in the existing app: PM edits (password-gated), Founder reads,
Supabase-shared, evidence via the existing links/files/screenshot system.

| Module | Replaces sheet(s) | Priority |
|---|---|---|
| **KPI Scorecard** | KPI Scorecard Mar–Jun | P1 (core) |
| **Risk Register** | Risk Register | P1 |
| **Sprint Tracker** | Sprint Tracker | P2 |
| **Demo Log** | Demo Log | P2 |
| **Marketing Log** | Marketing Log | P2 |
| **Issue Resolution** | Issue Resolution | P2 |
| **Clients** (won deals) | _(implied by C1; not a sheet today)_ | P2 |
| **Attendance** | Attendance Log / Monthly | P3 |
| **Leads** (SL + End-user) | FM Leads – Sri Lanka, End-User Leads | P3 |
| **Tasks** (exists) | feeds Sprint Tracker / Jira backlog | done |

---

## 3. KPI catalog (the 22)

`type`: **auto** = score derivable from a log; **manual** = PM scores with evidence.

| Code | Category | KPI | Target | Source / formula | Type |
|---|---|---|---|---|---|
| A1 | A. Delivery & Technical | Sprint Delivery Rate | ≥ 90% tasks on time | Sprint Tracker `completionRate` (latest/avg in month) | auto |
| A2 | A | Developer Accountability | Weekly logs; bi-weekly in-office | Attendance — logs present + in-office days | auto |
| A3 | A | Development Plan Accuracy | ≤ 10% deviation from plan | Sprint planned vs delivered tasks | auto |
| A4 | A | Issue Resolution | Critical issues within SLA | Issue Resolution — % resolved within SLA | auto |
| A5 | A | Team Performance Reporting | Weekly dashboard submitted | manual (app dashboard = evidence) | manual |
| B1 | B. Communication | Weekly Monday Report | 100% on time | manual (evidence link) | manual |
| B2 | B | Friday Progress Summary | 100% on time | manual (Weekly Summary = evidence) | manual |
| B3 | B | Transparency Dashboard | Updated weekly, single source | manual (this app = evidence) | manual |
| B4 | B | Risk Reporting | All risks logged + mitigation | Risk Register — coverage of logged risks | auto |
| C1 | C. Marketing & Sales | New Clients Acquired | 3 in 3 mo; 5 in 6 mo | Clients — `wonDate` in window | auto |
| C2 | C | Demos Delivered | ≥ 3 / week | Demo Log — count ÷ weeks in month | auto |
| C3 | C | Marketing Content Produced | 4 / month | Marketing Log — content entries in month | auto |
| C4 | C | Lead Generation | ≥ 20 new leads / month | Leads — created in month (+ Marketing `leadsGenerated`) | auto |
| C5 | C | Reseller Pipeline | 3 active by month 3 | manual (evidence) | manual |
| C6 | C | Event Participation | 1 local event / month | Marketing Log — `activityType = Event` in month | auto |
| D1 | D. Operations | ISO 27001 Documentation | 100% drafted by Month 4 | manual (evidence: doc links) | manual |
| D2 | D | Cyber Essentials+ Maintenance | Updated quarterly | manual | manual |
| D3 | D | Legal Documents | All agreements finalised | manual | manual |
| E1 | E. Continuous Improvement | AI Improvements | As agreed | manual | manual |
| E2 | E | Process Improvements | 1 / month | manual | manual |
| E3 | E | Cross-Team Coordination | Weekly alignment | manual | manual |
| E4 | E | Customer Satisfaction | Positive demo/client feedback | Issue Resolution `customerFeedback` + manual | manual |

Category counts (match workbook rollup): A=5, B=4, C=6, D=3, E=4 → **22 total**.

---

## 4. Data model

Shared primitive, reused everywhere (already exists in the progress log):

```js
Evidence = {
  links: string[],                                  // urls
  files: [{ name: string, data: string, type }]     // base64, ≤1.5MB each
}
```

### 4.1 KPI Scorecard

```js
// Static definitions (seeded from §3; ship as a constant, not user data)
KpiDef = {
  code: 'A1', category: 'A', categoryName: 'Delivery & Technical',
  name: 'Sprint Delivery Rate', target: '≥ 90% of sprint tasks completed on time',
  type: 'auto' | 'manual', source: 'sprints' | 'demos' | ... | null,
}

// User data — one record per KPI per month
KpiScore = {
  id, kpiCode: 'A1', month: '2026-06',     // YYYY-MM
  score: 0..5,
  autoScore: number | null,                 // suggested from logs; PM can override
  evidence: Evidence,
  notes: string,
  status: 'Not started' | 'On track' | 'At risk' | 'Met' | 'Exceeded',
  userId, at
}
// Rollup (computed, not stored): category avg + overall avg across the 22.
```

### 4.2 Risk Register  (RSK-###)

```js
Risk = {
  id: 'RSK-009', dateRaised, category: 'Delivery'|'Technical'|'People'|...,
  description, likelihood: 1..5, impact: 1..5,
  score: likelihood * impact,               // computed
  mitigation, owner, status: 'Open'|'Monitoring'|'Escalated'|'Resolved',
  evidence: Evidence, createdAt, updatedAt, activity: []
}
```

### 4.3 Sprint Tracker

```js
Sprint = {
  id: 'Sprint 59', startDate, endDate,
  totalTasks, completed, blocked, carryOver,
  completionRate: completed / totalTasks,   // computed → feeds A1
  notes
}
// Optionally auto-fill total/completed by tagging Tasks with a `sprint` field.
```

### 4.4 Demo Log  (DEMO-###)

```js
Demo = {
  id: 'DEMO-004', date, company, contact, region,
  demoType: 'Online'|'In-Person', durationMins,
  outcome: 'Won'|'Follow-up'|'Lost'|'No decision'|..., notes, evidence: Evidence
}
```

### 4.5 Marketing Log  (MKT-###)

```js
Marketing = {
  id: 'MKT-005', date,
  activityType: 'Content'|'Event / Webinar'|'Campaign'|'Social'|...,
  title, channel, contentLink, leadsGenerated: number, notes
}
// content count → C3; activityType Event → C6; leadsGenerated → C4
```

### 4.6 Issue Resolution

```js
Issue = {
  id, dateReported, customer, module, issue,
  assignedTo, status: 'Open'|'In Progress'|'Resolved',
  resolutionSummary, resolutionDate, customerFeedback,
  sla: { dueDate, metSLA: bool },            // feeds A4
  evidence: Evidence
}
```

### 4.7 Clients (won)

```js
Client = {
  id, name, segment, region, wonDate,        // wonDate in window → C1
  dealType, value, sourceDemoId, owner, notes
}
```

### 4.8 Attendance

```js
AttendanceWeek = {
  id, weekStart, member, role,
  days: { mon, tue, wed, thu, fri },         // 'O'|'R'|'L'|'H'
  inOffice: number                            // computed → A2
}
```

### 4.9 Leads (SL + End-user)

```js
Lead = {
  id, list: 'sl' | 'enduser',
  company, segment, address, contact, title, phone, email,
  companySize, sites, painPoint, linkedin, status, createdAt   // createdAt → C4
}
```
**Note:** the SL list is ~1000 rows. Keep this collection in its **own backend row**
(see §6) so it never bloats the tasks/KPI payloads. Could stay Excel-linked at first.

---

## 5. Auto-score formulas (suggested → PM confirms)

Generic "higher is better": `score = clamp(round(value / target * 5), 0, 5)`.
Generic "deviation, lower better" (A3): `score = clamp(round((1 - dev/limit) * 5), 0, 5)`.

| KPI | value | target | note |
|---|---|---|---|
| A1 | sprint.completionRate (month avg) | 0.90 | 5 at ≥90% |
| A3 | 1 − |planned−delivered|/planned | ≤0.10 dev | |
| A4 | issuesResolvedWithinSLA / criticalIssues | 1.0 | |
| C2 | demosInMonth / weeksInMonth | 3 /wk | |
| C3 | contentEntriesInMonth | 4 /mo | |
| C4 | leadsInMonth + Σ marketing.leadsGenerated | 20 /mo | |
| C6 | eventEntriesInMonth | 1 /mo | |
| C1 | clients.wonDate in trailing window | 3 /3mo | |
| B4 | risks logged with mitigation / total risks | 1.0 | |

The score is always a **suggestion**; the PM can override and must attach evidence.
This matches the manual 0–5 process management already uses, just pre-filled.

---

## 6. Backend / integration

Current: Supabase table `workspace`, **one row `id='main'`** holding `tasks` jsonb,
written via the password-gated `tasks-mutate` Edge Function, read via anon + RLS,
realtime-synced. (See [[supabase-shared-backend]].)

**Evolution — one row per collection** (the table is already keyed by `id text`):

| row id | holds |
|---|---|
| `main` | tasks (unchanged) |
| `kpiScores` | KPI monthly scores |
| `risks`, `sprints`, `demos`, `marketing`, `issues`, `clients`, `attendance` | each module |
| `leads_sl`, `leads_enduser` | heavy lead lists, isolated |

Required change: `tasks-mutate` accepts a `collection` param and upserts that row
(today it hard-codes `id='main'`). Reads: `select … eq('id', collection)`. Realtime:
subscribe per collection. This keeps payloads small and lets the big Leads lists sit
apart from the frequently-written tasks/KPI data.

`data-service.js` gains `load(collection)` / `save(collection, rows)`; the rest of
the password/echo/realtime plumbing is unchanged.

---

## 7. Phasing

- **P1 — KPI Scorecard + Risk Register.** The artifact management opens, plus the one
  log they explicitly track. Multi-row backend change lands here. Manual scoring first.
- **P2 — Sprint, Demo, Marketing, Issue, Clients logs** + wire their **auto-scores**
  into the scorecard. Bulk-import existing xlsx rows via the paste importer.
- **P3 — Attendance + Leads**, RAG exec dashboard, month-over-month KPI trend.
- **P4 — Export** monthly scorecard → xlsx/PDF in management's format.

---

## 8. Decisions (locked — Jun 10 2026)

1. **Clients / reseller (C1, C5)** → **manual + evidence**. No Clients module for now;
   PM scores by hand with an evidence link. Add a module later only if needed.
2. **Leads (C4)** → **link Excel as evidence**. Keep the ~1000 SL rows + end-user list
   in Excel; attach as C4 evidence. No in-app Leads import in early phases.
3. **Months** → **preload Mar–Jun** existing scores from the xlsx, then continue forward.
4. **Auto-score formulas (§5)** → **approved as-is**. Always a *suggestion*; PM confirms
   or overrides and attaches evidence.

> Consequence: the **Clients** and **Leads** modules drop out of early scope. Active
> build set = KPI Scorecard, Risk Register, Sprint, Demo, Marketing, Issue, Attendance,
> plus exec dashboard + export. See `KPI-BUILD.md` for the per-session unit breakdown.
