# 0002 — Honest persistence via `.select()`

- Status: accepted
- Date: 2026-06-28

## Context
`saveWorkspace` did `update(...).eq('id','main')` and reported success when
`error === null`. But PostgREST returns `error: null` even when **zero rows** are
updated — e.g. RLS silently filtered the row (signed-in uid ≠ editor uid) or the
row is missing. The UI showed "saved" while nothing persisted.

## Decision
Append `.select('id')` to the update and treat an **empty returned rows array as a
failure**. Return a richer result `{ ok, persisted, rowsAffected, reason, error }`
with stable reason codes (`OK`, `RLS_BLOCKED`, `ROW_NOT_FOUND`, `UPDATE_ERROR`,
`NO_CLIENT`, `EXCEPTION`). On an empty write, a follow-up read distinguishes
`RLS_BLOCKED` (row exists, update filtered) from `ROW_NOT_FOUND` (row missing).
A header `SaveIndicator` surfaces Saving / Saved / the failure reason.

Also aligned the frontend `canEdit` to gate on auth **uid** (`EDITOR_UID`, the same
identity the RLS policy uses) with email fallback, so editable UI matches what the
database will actually allow.

## Alternatives considered
- **Trust `error === null`:** rejected — the source of the false-positive.
- **Count via a separate `select count`:** rejected — extra round trip; `.select()`
  on the update returns affected rows directly.

## Consequences
- Silent data loss becomes a visible failure with an actionable reason.
- One extra (small) follow-up read only on the failure path.
- This is exactly what later exposed the real backend timeout
  (`UPDATE_ERROR: canceling statement due to statement timeout`) instead of hiding it.
