# Architecture Decision Records

Short, append-only records of significant design decisions. One file per decision,
numbered. Each captures: **Context** (what forced a choice), **Decision** (what we
chose), **Alternatives** (what we rejected and why), **Consequences** (what we now
live with). Keep them brief — the goal is to answer "why is it like this?" six
months later, not to document the code.

Status values: `proposed` · `accepted` · `superseded by NNNN` · `deprecated`.

| # | Title | Status |
|---|-------|--------|
| [0001](0001-unified-workspace-document.md) | Unified workspace document on one row | accepted |
| [0002](0002-honest-persistence-select.md) | Honest persistence via `.select()` | accepted |
| [0003](0003-debounced-text-autosave.md) | Debounced autosave for free-text fields | accepted |
| [0004](0004-attachments-to-storage.md) | Move attachments to Supabase Storage | proposed |
