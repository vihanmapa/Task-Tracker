# 0003 — Debounced autosave for free-text fields

- Status: accepted
- Date: 2026-06-28

## Context
Weekly objectives and notes called the save path on every `onChange`. Because the
whole workspace persists as one document ([0001](0001-unified-workspace-document.md)),
each keystroke triggered a full-document write to Supabase — write amplification,
realtime echo storms, and a flickering save indicator.

## Decision
Free-text fields (**objectives, notes**) update a local draft instantly for a
responsive UI, but persistence is **debounced ~1s** after the last keystroke
(`patchWeek` by id, merging against the latest stored week). Every **structural**
action (create/delete/complete week, carry forward, task select, report generation,
import/export) still persists **immediately**. Pending text flushes on blur, week
switch, unmount, and before any structural op; delete cancels pending.

## Alternatives considered
- **Debounce the entire persistence effect:** rejected — would delay structural
  actions (new/delete/complete week) too, hurting perceived reliability.
- **Save on blur only:** rejected — loses edits if the tab closes mid-edit; debounce
  + flush-on-blur covers both.

## Consequences
- A paragraph of notes = one save, not one per character.
- Slightly more state (local drafts) and flush bookkeeping.
- NOTE: this reduces write *frequency*, not write *size*. It does not fix the
  large-document timeout — that is [0004](0004-attachments-to-storage.md). Save
  serialization remains a separate, independent improvement.
