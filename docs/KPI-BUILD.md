# KPI build tracker — one unit per session

Token-efficient build log. Each **unit ≈ one session**: small, self-contained,
ends with a working+committed increment. Don't bundle units.

## Resume protocol (do this at the start of every build session)

1. Read `memory/MEMORY.md` (auto-loaded) → `docs/KPI-PLAN.md` (model + decisions) →
   **this file**.
2. Pick the **first unchecked unit** below. Build only that.
3. Touch only the files listed for the unit. Don't re-read unrelated modules.
4. Verify against the unit's **Done-when**. Bump `?v=N` in `index.html` (cache bust).
5. Commit (`git push` → Pages auto-deploys). Tick the box, add a one-line note.
6. End the session.

Conventions: PM-edit gated by password (`canEdit`), Founder read-only. Reuse the
`Evidence` shape + attachment UI from the progress log. New screens register on
`window.*` and load via `index.html` (babel script, `?v=N`). Backend = Supabase
`workspace` table, one row per collection (see Unit 1).

> ⚠️ Units 1, and any "deploy" step, need the user to **redeploy the Edge Function**
> and may need `EDIT_PASSWORD` already set. Flag it; don't assume CLI access.

---

## Phase 1 — KPI Scorecard + Risk Register

- [x] **U1 · Backend: multi-collection**
  Files: `supabase/functions/tasks-mutate/index.ts`, `fm-navigate/data-service.js`,
  `supabase/schema.sql`.
  Add a `collection` param to the function (upsert `workspace` row `id=collection`,
  default `main`). Add `dataService.load(collection)` / `save(collection, rows)` /
  `subscribe(collection, cb)`. Backfill: existing tasks stay on `main`.
  User action: redeploy `tasks-mutate`. **Done-when:** can read+write a `__test`
  collection from the live client; tasks still load.

- [x] **U2 · KPI definitions constant**
  Files: NEW `fm-navigate/kpi-data.js`, `index.html`.
  Ship the 22 `KpiDef`s from PLAN §3 as `window.KPI_DEFS` + category meta + a
  `monthKey()` helper. No UI. **Done-when:** `window.KPI_DEFS.length === 22`,
  category counts A5/B4/C6/D3/E4.

- [x] **U3 · KPI Scorecard screen (read-only)**
  Files: NEW `fm-navigate/kpi.jsx`, `app.jsx` (NAV + route), `index.html`, `styles.css`.
  Grouped by category A–E, month selector, shows score/notes/status/evidence per KPI,
  computes **category avg + overall**. Loads `kpiScores` collection. **Done-when:**
  renders 22 rows grouped, rollups match, month switch works.

- [x] **U4 · KPI scoring edit**
  Files: `fm-navigate/kpi.jsx`, `app.jsx`.
  0–5 input + status + notes + evidence (reuse attachment UI); save per KPI/month to
  `kpiScores`; password-gated; activity entry. **Done-when:** edit persists, syncs to
  a 2nd browser, Founder can't edit.

- [ ] **U5 · Preload Mar–Jun scores**
  Files: data only (seed into `kpiScores`).
  Enter existing scores from the xlsx (Mar–Jun sheets) for the 22 KPIs. **Done-when:**
  four months selectable with their scores + rollups.

- [ ] **U6 · Risk Register screen + add/edit**
  Files: NEW `fm-navigate/risk.jsx`, `app.jsx` (NAV+route), `index.html`, `styles.css`.
  Table (RSK-###, likelihood×impact = score, owner, status, mitigation, evidence);
  add/edit gated; `risks` collection. **Done-when:** add a risk, score computes,
  persists + syncs, Founder read-only.

- [ ] **U7 · Import Risk Register rows**
  Enter the existing RSK-001…NN from the xlsx into `risks`. **Done-when:** register
  matches the sheet; feeds B4.

---

## Phase 2 — Operational logs + auto-score

- [ ] **U8 · Sprint Tracker** (`sprints` collection) + import + **A1/A3** auto-score.
  Files: NEW `fm-navigate/sprints.jsx`, `app.jsx`, `index.html`.
- [ ] **U9 · Demo Log** (`demos`) + import + **C2** auto. Files: NEW `demos.jsx`, wiring.
- [ ] **U10 · Marketing Log** (`marketing`) + import + **C3/C4/C6** auto.
- [ ] **U11 · Issue Resolution** (`issues`) + import + **A4/E4** auto.
- [ ] **U12 · Auto-score engine** — compute §5 suggestions, show as `autoScore` in the
  scorecard with a "use suggestion" action (PM still confirms). Files: NEW
  `fm-navigate/kpi-score.js`, `kpi.jsx`.

---

## Phase 3 — Attendance, leads, dashboard

- [ ] **U13 · Attendance** (`attendance`) + import + **A2** auto.
- [ ] **U14 · Leads link-only** — C4 evidence is the Excel link; small helper, no import.
- [ ] **U15 · Exec dashboard** — RAG per category + month-over-month KPI trend.

## Phase 4 — Export

- [ ] **U16 · Export** monthly scorecard → xlsx/PDF in management's layout.

---

## Session notes (append one line per completed unit)

- U1–U4 done (v48) — multi-collection `dataService.loadCollection/saveCollection/subscribeCollection`
  (no Edge Function; editor RLS already covers every `workspace` row, new rows just need seeding
  in `schema.sql`). New `kpi-data.js` (22 KPI_DEFS) + `kpi.jsx` Scorecard screen: month selector,
  A–E sections, 0–5 score select, auto status band (workbook score guide), notes, evidence links,
  category-avg bars + overall rollup. NAV `KPI Scorecard`. Status derived from score (not a
  separate field). Evidence = link URLs only for now (no file/base64 attach yet). **User action
  pending: run `supabase/schema.sql` once to seed the `kpiScores` row, else remote save fails
  (logs a clear warning; localStorage mirror still works).** U5 preload still open.
