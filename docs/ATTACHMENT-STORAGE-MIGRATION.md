# Attachment Storage Migration — Design

Status: **proposed** (design only, not implemented)
Author: investigation 2026-06-28

## Problem & evidence

The whole workspace is persisted as one JSONB document on `workspace.main`. Every
save (`ds.saveWorkspace`) rewrites the entire document. File attachments are
stored **inline as base64 data URLs** inside each task's `progressLog[].files[].data`
(created at [tasks.jsx:658](../fm-navigate/tasks.jsx) via `readAsDataURL`).

Measured against live production data (read-only, authenticated session):

| Metric | Value |
|--------|-------|
| Document total | **5,772 KB (5.77 MB)** |
| Inline attachments | 5 files, **5,729 KB (99.3% of doc)** |
| Largest single file | 1,809 KB (`T-109` image.png) |
| Actual business data (tasks/deliverables/weeks/kpi) | ~43 KB |
| Single read duration | ~3.7 s |

Consequence: each debounced Notes/objective save, and every structural action,
PATCHes ~5.9 MB. Postgres parses + WALs + TOASTs it, and Realtime republishes the
full row to subscribers. This trips `statement_timeout` → `UPDATE_ERROR`. Write
serialization cannot fix this — serialized 5.9 MB writes are still 5.9 MB.

**Goal:** move binary attachments out of the document into Supabase Storage,
leaving only a small reference in the JSON. Target document size ~43 KB.

## Target data shape

Legacy (today):
```json
{ "name": "image.png", "type": "image/png", "data": "data:image/png;base64,iVBORw0..." }
```

New:
```json
{
  "name": "image.png",
  "type": "image/png",
  "size": 1853021,
  "sha256": "<hex digest of the bytes>",
  "uploadedAt": "2026-06-28T16:30:55.474Z",
  "path": "tasks/T-109/pl7-image.png"
}
```

The reader treats an attachment with `data` as legacy (inline) and one with
`path` as Storage-backed. Both shapes coexist during migration.

`sha256` + `size` are integrity metadata, computed from the raw bytes at upload
time (Web Crypto `crypto.subtle.digest('SHA-256', ...)`). They let us:
- verify an upload landed uncorrupted (compare digest after upload),
- make the migration idempotent and self-checking (skip if `path` exists AND the
  stored object's digest matches),
- run future integrity audits (detect a Storage object that drifted from its ref).
`uploadedAt` aids debugging and orphan cleanup.

## Storage bucket layout

- Bucket: `workspace-attachments` (single bucket, **private**).
- Path convention: `tasks/<taskId>/<progressLogId>-<sanitizedFilename>`
  - `progressLogId` keeps multiple files per log entry unique.
  - If no stable id is available, prefix a short uuid.
  - Sanitize filename (strip path separators, collapse spaces).
- Deliverable/other attachments (if added later): `deliverables/<id>/...`.

## Access control

Workspace data is already auth-gated (read = authenticated, write = editor uid).
Mirror that on Storage with bucket policies:

- **Read:** `authenticated` may read objects in `workspace-attachments`
  (Founder + editor both view). Serve via **signed URLs** (short TTL) created by
  the client; do not make the bucket public — attachments may be sensitive.
- **Write/delete:** only the editor (`auth.uid() = EDITOR_UID`) may upload/delete,
  matching the workspace UPDATE policy.

Storage RLS lives on `storage.objects`; policies filter by `bucket_id` and the
same `EDITOR_UID` literal used in `supabase/schema.sql`.

## Upload flow (new attachments)

In `addFiles` ([tasks.jsx:654](../fm-navigate/tasks.jsx)):

1. Validate size (raise cap — Storage isn't bound by the localStorage-era 1.5 MB
   limit; pick a sane max, e.g. 10–25 MB).
2. Upload the raw `File` to `workspace-attachments` at the computed path
   **before** the attachment is added to state.
3. On upload success, push `{ name, type, size, path }` (no `data`) into the
   progress-log entry.
4. On upload failure, surface an error and do **not** add the attachment.

Ordering rule: **file lands in Storage first, reference enters the document
second.** The document never contains a `path` that doesn't exist in Storage.

## Read / render flow

`fileChip`/thumbnail rendering ([tasks.jsx:739](../fm-navigate/tasks.jsx)) and the
download/normalize helpers ([app.jsx:371](../fm-navigate/app.jsx), [app.jsx:404](../fm-navigate/app.jsx)):

- If attachment has `data` → use it directly (legacy).
- If attachment has `path` → create a signed URL on demand and use that for
  the `<img src>` / download link. Cache signed URLs briefly to avoid refetching.

## Backward compatibility

- Readers support both `data` and `path` indefinitely until migration completes.
- `repairData` / migration registry: no schema-version bump strictly required,
  but add a normalizer that tolerates both shapes.
- No write path should ever re-introduce `data` for new files once Storage is on.

## One-time migration

A guarded, idempotent routine (run by the editor, or a settings button):

```
for each task:
  for each progressLog entry:
    for each file with `data` (and no `path`):
      decode base64 -> Blob
      upload Blob to workspace-attachments at tasks/<taskId>/<plId>-<name>
      verify upload succeeded (HEAD / list)
      replace file with { name, type, size, path }   # drop `data`
save workspace ONCE at the end
```

Properties:
- **Idempotent:** files already having `path` are skipped; re-running is safe.
- **Verify-before-replace:** never drop base64 until the upload is confirmed.
- **Atomic-ish save:** collect all replacements, then a single `saveWorkspace`.
  After migration the document drops from ~5.77 MB to ~43 KB, so the final save
  is small and won't time out.

## Failure handling

| Failure | Behavior |
|---------|----------|
| Upload succeeds, workspace save fails | Uploaded object is orphaned in Storage; base64 still in (unsaved) doc. Re-run migration — idempotent skip won't help since `path` wasn't persisted, so it re-uploads (overwrite same path) and retries the save. Orphans are harmless; optional cleanup job later. |
| Upload fails mid-migration | Stop, report which task/file failed; already-migrated files keep their `path`. Re-run continues from where it left off (idempotent). |
| Signed URL fetch fails at render | Show a "couldn't load attachment" placeholder + retry; never crash the view. |
| Storage write blocked by RLS (non-editor) | Migration/upload only offered to editor; UI hides it for read-only users. |

## Rollback plan

- Code is backward compatible (reads both shapes), so reverting the *code* leaves
  already-migrated `path` attachments unreadable by old code. Therefore:
- Keep the migration **opt-in** and reversible until validated: a reverse routine
  can download each `path`, re-inline as `data`, and remove `path` (only needed if
  abandoning Storage — unlikely).
- Do not delete Storage objects or drop base64 from the canonical copy until a
  backup export (`exportWorkspace`) of the pre-migration document is saved.

## Phasing

1. **Storage uploads for new attachments** (write path) + signed-URL reader.
2. **Backward-compatible readers** everywhere `data`/`fileData` is consumed.
3. **One-time migration tool** (editor-triggered), after a full export backup.
4. **Save serialization** (single in-flight + trailing coalesced re-save) —
   **independent of this migration**, not the timeout fix. Worth doing regardless
   for deterministic write ordering, fewer concurrent writes, simpler reasoning,
   and lower last-write-wins risk. Can ship before, during, or after the
   migration; it just no longer carries the burden of "fixing" the timeout.
5. **Remove base64 support** once all workspaces are migrated and verified.

## Out of scope / follow-ups

- Carry-forward reopening an already-closed future week ([weekly.jsx](../fm-navigate/weekly.jsx)).
- Dangling `selId` after a realtime delete.
- Attachment de-duplication by content hash (optional optimization).
