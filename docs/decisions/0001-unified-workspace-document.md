# 0001 — Unified workspace document on one row

- Status: accepted
- Date: 2026-06-28

## Context
The Supabase backend originally used one row per collection (`main` for
tasks/deliverables, a separate `kpiScores` row, etc.). Each new feature needed a
new row, a one-time SEED insert, and — because there is no INSERT policy — manual
SQL to create it. Adding Weekly Planning under that model meant yet another row
and another seed step.

## Decision
Store the **entire workspace as one JSON document** on the existing `workspace.main`
row: `{ version, metadata, data: { tasks, deliverables, weeks, kpiScores, … } }`.
Every feature becomes a property under `data`. One save path, one row, one
subscription. Legacy per-collection rows are kept only so existing data migrates
on first load.

## Alternatives considered
- **Row per collection (status quo):** rejected — every feature needs a new row +
  seed + RLS consideration; no INSERT policy makes this manual.
- **Normalized tables (tasks, weeks, …) with FKs:** rejected for now — heavier
  schema/migration cost than this small, single-editor app needs.

## Consequences
- New features add a property, never a row/seed/RLS change.
- Backup/export/import are trivial (one document).
- Every save rewrites the whole document → write cost scales with total size.
  This became a real problem once attachments inflated the doc to ~5.9 MB
  (see [0004](0004-attachments-to-storage.md)).
- Last-write-wins on the single row; concurrent writers can clobber.
