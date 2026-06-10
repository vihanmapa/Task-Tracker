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

## Shared data (Supabase) — optional

By default `DATA_BACKEND` is `local`: tasks live in each browser. To share one
task list across everyone (live-synced), switch to the Supabase backend:

1. **Create the table** — Supabase → SQL Editor → run [`supabase/schema.sql`](supabase/schema.sql).
   Makes a `workspace` table (anon can *read*, not write) and turns on realtime.
2. **Deploy the write function**
   ```bash
   supabase functions deploy tasks-mutate --no-verify-jwt
   supabase secrets set EDIT_PASSWORD='your-shared-passphrase'
   ```
   (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)
3. **Point the client at the project** — in [`fm-navigate/config.js`](fm-navigate/config.js):
   - `DATA_BACKEND: 'supabase'`
   - `SUPABASE_URL` + `SUPABASE_ANON_KEY` from Project Settings → API
   (The anon key is public by design — safe to commit. Never put the
   service_role key or the password here.)
4. **Push** — Pages redeploys; everyone now sees the same tasks.

**How editing is gated:** reads use the public anon key. Every write goes
through the `tasks-mutate` Edge Function, which checks `EDIT_PASSWORD`
server-side before touching the DB. In the app, switching to the PM (Vihan)
persona prompts for that password to unlock editing. Founder/read-only never
needs it. Anyone with the link can *view* tasks; only the password unlocks edits.

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
