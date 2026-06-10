# FM Navigate — Execution Hub

Lightweight task tracker for FM Navigate. Two roles: a **PM** who can edit, and a
**Founder** read-only view. Runs fully in the browser — no backend, no build step.

## Features

- **Tasks** — list (sortable columns) and kanban views, priority/status/category/owner.
- **Bulk paste** — paste tasks from plain text, numbered/bulleted lists, spreadsheets
  (TSV), or labeled blocks; the parser splits them into individual tasks.
- **Progress log** — per-task updates with %, status, notes, multiple evidence links,
  and image/file attachments (paste a screenshot with ⌘V). In-app image lightbox.
- **Dashboard** — KPIs incl. average progress and weekly activity.
- **Local AI assistant** — task extraction, Q&A, and weekly summary, all running
  locally via heuristics/templates (no cloud, no API keys). See "AI" below.
- **Roles** — persona switcher: PM (Vihan, edit) / Founder (Richard, read-only).
- **Themes** — light/dark, density and scale tweaks.

## Tech

- React 18 + ReactDOM + `@babel/standalone` (in-browser JSX, no bundler).
- Plain `.jsx` files attached to `window.*`, loaded in order from `index.html`.
- Persistence: `localStorage` (`fm_tasks`, `fm_user`). No server-side storage.

## Run locally

The app is static. Any static file server works. A tiny no-cache server is included:

```bash
cd fm-navigate
python3 serve.py        # serves on http://localhost:4173
```

Or use any static server (e.g. `python3 -m http.server` in `fm-navigate/`).

## AI

All three AI features run **locally** — no cloud, no keys:

- `extractTasks` — regex/heuristic parsing of pasted text into tasks.
- `askAssistant` — rule-based Q&A over the current task data.
- `generateWeeklySummary` — template-based narrative.

They live behind a single `window.aiService` abstraction (`ai-service.jsx`) with an
`AI_BACKEND` switch and `TODO(gemini)` seams, so a hosted model (Browser → Supabase
Edge Function → Gemini) can be dropped in later without touching the UI.

## Structure

```
fm-navigate/
  index.html        # loads scripts in order (cache-busted ?v=N)
  data.js           # seed data + constants (USERS, STATUSES, …)
  icons.jsx         # inline SVG icon set
  components.jsx    # shared primitives (Ring, StatusPill, …)
  ai-service.jsx    # local AI: extract / ask / summarize
  tweaks-panel.jsx  # theme/density/scale controls
  dashboard.jsx     # KPIs + greeting
  ai-compose.jsx    # paste-to-tasks composer
  tasks.jsx         # list / kanban / task detail / progress log
  screens.jsx       # weekly summary + ask-AI screens
  app.jsx           # root: state, roles, persistence
  serve.py          # local no-cache static server
```
