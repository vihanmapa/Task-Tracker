# 0004 — Move attachments to Supabase Storage

- Status: proposed
- Date: 2026-06-28

## Context
Task attachments are stored **inline as base64 data URLs** inside
`progressLog[].files[].data`, which lives in the unified workspace document
([0001](0001-unified-workspace-document.md)). Measured on real production data:
document ~5.9 MB, of which ~99% (5 files, biggest 1.8 MB) is attachment bytes;
actual business data is ~43 KB. Because every save rewrites the whole document,
each save PATCHes ~5.9 MB — Postgres parses/WALs/TOASTs it and Realtime republishes
the full row — which trips `statement_timeout`. A plain read alone takes ~3.7 s.

## Decision (proposed)
Move binary attachments **out of the document into Supabase Storage**, keeping only
a reference `{ name, type, size, sha256, uploadedAt, path }` in the JSON. New
uploads go to a private `workspace-attachments` bucket; readers support both legacy
`data` (base64) and new `path` (Storage) for backward compatibility; a one-time,
idempotent, verify-before-replace migration moves the existing 5 files. Full design,
phasing, success metrics, rollback, and failure handling in
[../ATTACHMENT-STORAGE-MIGRATION.md](../ATTACHMENT-STORAGE-MIGRATION.md).

## Alternatives considered
- **Keep base64 + just serialize/debounce saves:** rejected — serialized 5.9 MB
  writes are still 5.9 MB; doesn't address the root cause.
- **Compress base64 in the document:** rejected — modest, fragile gains; doesn't
  remove the rewrite-whole-blob-per-save problem.
- **Split attachments into a separate DB table/row:** rejected — Storage is the
  purpose-built place for binary blobs and gives signed-URL access control.

## Consequences
- Document shrinks ~5.9 MB → target <100 KB; saves become fast; timeout resolved.
- Adds a Storage bucket + RLS, signed-URL reads, an upload flow, and a migration
  tool — a distinct project on `feat/storage-attachments`, not part of v0.8.0.
- Temporary dual-format complexity until base64 support is removed (final sprint).
- Deliberately **not started** until v0.8.0 is confirmed stable in production.
