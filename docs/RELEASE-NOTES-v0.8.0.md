# Release Notes — Weekly Planning & Workspace Persistence

## Version
v0.8.0

## Summary
Introduces the new **Weekly Planning** workspace together with significant
improvements to workspace persistence, reliability, and data integrity. It also
lays the foundation for future attachment-storage improvements while keeping the
current data model fully compatible.

## New Features

### Weekly Planning
- Weekly Planning workspace ("This Week")
- Create new weeks on demand
- Complete weeks
- Carry unfinished tasks forward to future weeks
- Delete weeks (with confirmation)
- Weekly objectives
- Weekly notes
- Monday Plan and Friday Summary AI reports
- Week navigation (previous / next)
- Historical closed weeks

### Workspace Improvements
- Unified workspace document for tasks, deliverables, weeks, and KPI scores
- Automatic migration from the legacy workspace format
- Import and export support
- Improved duplicate-ID repair
- Improved reference validation
- Better workspace reset behavior

## Reliability Improvements
- Save status indicator (Saving / Saved / failed)
- Honest persistence verification (a write that changes no row is reported as a failure)
- Detailed save-failure reason codes
- Frontend permission checks aligned with database authorization (editor uid ↔ RLS)
- Debounced autosave for text editing
- Async report generation no longer overwrites newer edits

## Data Integrity Improvements
- Closed weeks preserved as historical records
- Closed-week tasks can be planned again
- Weekly history protected from reassignment
- Workspace reset clears weekly planning data and KPI scores
- Import path performs the same repair process as normal workspace loading

## Known Limitations
Attachments are still stored inside the workspace document. Large inline
attachments can significantly increase workspace size and may affect save
performance (measured ~5.9 MB on real data, ~99% attachments).

This will be addressed in the upcoming Attachment Storage project, which will
migrate attachments to Supabase Storage while remaining backward compatible.
See [ATTACHMENT-STORAGE-MIGRATION.md](ATTACHMENT-STORAGE-MIGRATION.md).

## Upgrade Notes
No manual migration is required. Existing workspaces are migrated automatically
when loaded.

## Next Planned Release — Attachment Storage Migration
Goals:
- Store attachments in Supabase Storage
- Reduce workspace document size dramatically (target < 100 KB)
- Improve save performance (target < 500 ms)
- Preserve compatibility with existing workspaces
- Provide a one-time migration utility
