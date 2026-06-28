# Architecture

FM Navigate Execution Hub — a single-user Product Management workspace.
Static HTML + in-browser React (Babel standalone, no build step), with Supabase
as a shared persistence + realtime backend. This document captures the
architectural decisions behind persistence so they don't have to be
rediscovered later.

---

## Architecture principles

1. **One workspace document.** All app data is a single versioned JSON document.
2. **Tasks are the single source of truth.** Other features reference task ids;
   they never copy task data.
3. **Persistence is centralized in `data-service.js`.** Feature modules work
   with in-memory state and never touch the storage shape.
4. **New features extend the workspace, not the database schema.** A feature is
   a new key under `data` — no new table, row, or migration.

## Data flow

```text
        React UI
           │
           ▼
   Application state (React slices)
   tasks · deliverables · weeks · kpiScores
           │
           ▼
     data-service.js
   (schema · validation · migration · sync)
           │
           ▼
   Workspace document (v2)
   { version, metadata, data }
           │
           ▼
   Supabase  +  localStorage mirror
```

---

## 1. The workspace document

All application data lives in **one versioned document**, stored as JSON in the
`tasks` column of the single `main` row in the Supabase `workspace` table:

```js
{
  version: 2,
  metadata: {
    createdAt,    // ISO — first time the document was written
    updatedAt,    // ISO — stamped on every save
    migratedAt,   // ISO — last schema upgrade
    appVersion,   // app version that wrote it (debugging aid)
  },
  data: {
    tasks: [],
    deliverables: [],
    weeks: [],
    kpiScores: {},
    // … future features go here (goals, notes, templates, settings, …)
  },
}
```

- **`metadata` describes the document itself** — never put feature state here
  (no `currentWeek`, `selectedTasks`, etc.). Those belong under `data`.
- **`data` holds every feature collection.** Adding a feature = adding a key.

> Row id stays `main` deliberately. A clearer id like `workspace` would require
> creating a *new* row, but the table has no `INSERT` RLS policy, so the client
> cannot create rows — that's the whole point (see §6). Renaming would
> reintroduce the manual-SQL seeding this architecture removes.

---

## 2. Migrations — registry-based, one-time

Schema upgrades are **explicit and version-gated**, not shape-detected forever.

```js
const MIGRATIONS = {
  1: (doc) => /* v1 → v2 */,
  2: (doc) => /* v2 → v3 */,   // add the next bump here
};

// step the document up until it reaches the current version
while (doc.version < SCHEMA_VERSION && MIGRATIONS[doc.version]) {
  doc = MIGRATIONS[doc.version](doc);
  migrated = true;
}
```

- Any legacy shape (a bare array, or a flat pre-version object) is wrapped as
  **v1** by `toEnvelope()`, then walked up through the registry.
- When `migrated` is true the app **persists immediately**, so the upgrade is
  recorded once and never re-detected on later loads.
- One-time data imports (e.g. pulling the old standalone `kpiScores` row into
  the document) run **only while `migrated === true`**, so the compatibility
  code is inert after the first upgrade.

To add a schema version: bump `SCHEMA_VERSION`, add a `MIGRATIONS[n]` entry. Done.

**When is a version bump needed?** Only when the **structure of existing data
changes** — renaming a field, reshaping a collection, splitting/merging keys.
Adding a new *optional* key under `data` (a whole new feature) does **not**
require a version bump or a migration; `ensureData()` defaults it and the app
just starts using it. Bump the version only when old documents need rewriting.

---

## 3. New features go under `workspace.data`

There is **no per-feature row, no seeding, no RLS change** for new features.
A new feature (Goals, Notes, Roadmaps, Risks, Settings…) is just another key
under `data`. `ensureData()` preserves unknown keys verbatim, so a feature added
in code simply starts being persisted — and an older app build won't drop a
newer build's keys.

Persistence should **never** be the thing that blocks shipping a feature.

### Adding a new feature

1. Add a key under `workspace.data` (e.g. `goals`).
2. Add its default in `ensureData()` (e.g. `goals: Array.isArray(d.goals) ? d.goals : []`).
3. Add React slice state + setter in `app.jsx`; wire it into `applyDoc()` and the
   save effect's `data` object.
4. Build the UI in a feature module.
5. **No database changes. No migration** — unless you reshaped existing data (§2).

---

## 4. Separate React state, unified persisted document

In React, each collection keeps its **own slice state** — `tasks`,
`deliverables`, `weeks`, `kpiScores` — with their existing setters.

This is intentional. Collapsing to a single `workspace` React state would touch
~30 `setTasks`/`setWeeks`/… call sites for no user-facing benefit. The
**persisted document is the single source of truth on disk**; the React slices
are just a working view of it. `applyDoc(doc)` fans a loaded document out into
the slices; one save effect (keyed on all four slices) reassembles and writes
the whole document back.

If a single canonical React state is ever wanted, wrap it in a `useWorkspace()`
hook later — but it is explicitly deferred for now.

---

## 5. Backup — export / import

Because everything is one document, backup is nearly free:

- **Export** — `dataService.exportWorkspace()` returns the current document as
  pretty JSON. Settings → *Data → Backup workspace → Export* downloads
  `fm-navigate-workspace-YYYY-MM-DD.json`.
- **Import** — `dataService.importWorkspace(json)` accepts a document of *any*
  version, upgrades it through the migration registry, validates it, and saves.
  Editor-only, behind a confirm. Malformed JSON is rejected gracefully.

This gives backup, restore, migration between environments, debugging, and
sharing for almost no extra code.

---

## 6. Persistence lives in `data-service.js`

All persistence logic — the document schema, validation (`ensureData`),
migration registry, load/save/subscribe, export/import, and the Supabase/
localStorage split — lives in **`fm-navigate/data-service.js`**. Feature
modules (`tasks.jsx`, `weekly.jsx`, `kpi.jsx`, …) and `app.jsx` work with plain
in-memory state and never talk to the backend shape directly.

**Rule:** persistence changes happen in `data-service.js`, not in individual
feature modules. Features read/write state; the data service decides how it's
stored, versioned, and synced.

### Supabase model (brief)
- One `main` row, RLS: any signed-in user can `SELECT`; only the editor account
  (`EDITOR_EMAIL`) can `UPDATE`. No `INSERT`/`DELETE` policy — the row already
  exists and is never created or removed via the client.
- Writes mirror to `localStorage` always; they push to Supabase only when the
  editor is signed in. Realtime keeps other sessions in sync, ignoring own echo.
- See `supabase/schema.sql` for the full setup.

---

## Non-goals

These are deliberately **out of scope**. Don't drift toward them without a
fundamental requirement change (see below):

- Per-feature database tables.
- Per-feature persistence services.
- Manual database seeding for new features.
- Persistence logic inside feature modules.
- Duplicate task data (features reference task ids instead).

---

## When to revisit this

This is a stable foundation for a single-user hub. Revisit only on a
**fundamental** change:

- Multiple users editing the same workspace concurrently.
- The document grows too large to load whole.
- Incremental / partial loading becomes necessary.
- Per-feature permissions are introduced.

Any of these would justify entity normalization, indexed/partial loads,
optimistic updates, or offline sync. Until then, build features on top; don't
refactor the persistence layer.

---

## Decision log

| Date    | Decision                              | Reason |
|---------|---------------------------------------|--------|
| 2026-06 | Single workspace document             | Eliminate per-collection rows + manual SQL seeding (RLS has no INSERT policy). |
| 2026-06 | Versioned doc `{ version, metadata, data }` | Make the schema extensible and self-describing for future debugging. |
| 2026-06 | Registry-based migrations             | Scale schema evolution without accumulating shape checks. |
| 2026-06 | Separate React slice state            | Keep persistence unified while avoiding a ~30-call-site refactor with no user value. |
| 2026-06 | Keep Supabase row id `main`           | Renaming needs a new row, but there's no INSERT policy — would reintroduce manual seeding. |
| 2026-06 | Export / import workspace             | Near-free backup, restore, environment migration, and debugging from one document. |
| 2026-06 | Weekly workspace references task ids  | Tasks stay the single source of truth; no duplicated task data. |
