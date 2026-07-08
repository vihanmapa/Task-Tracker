/* ============================================================
   FM Navigate — App shell, routing, state, tweaks
   ============================================================ */
const { useState: useStateA, useEffect: useEffectA, useMemo: useMemoA, useCallback: useCallbackA, useRef: useRefA } = React;

const ACCENTS = {
  Blue:   { a: 'oklch(0.50 0.20 264)', h: 'oklch(0.45 0.21 264)', soft: 'oklch(0.95 0.04 264)', ring: 'oklch(0.50 0.20 264 / 0.35)',
            da: 'oklch(0.64 0.17 264)', dh: 'oklch(0.70 0.16 264)', dsoft: 'oklch(0.32 0.08 264)', dring: 'oklch(0.64 0.17 264 / 0.40)' },
  Teal:   { a: 'oklch(0.55 0.12 195)', h: 'oklch(0.50 0.13 195)', soft: 'oklch(0.95 0.03 195)', ring: 'oklch(0.55 0.12 195 / 0.35)',
            da: 'oklch(0.68 0.12 195)', dh: 'oklch(0.74 0.12 195)', dsoft: 'oklch(0.32 0.06 195)', dring: 'oklch(0.68 0.12 195 / 0.40)' },
  Violet: { a: 'oklch(0.52 0.20 300)', h: 'oklch(0.47 0.21 300)', soft: 'oklch(0.95 0.04 300)', ring: 'oklch(0.52 0.20 300 / 0.35)',
            da: 'oklch(0.66 0.17 300)', dh: 'oklch(0.72 0.16 300)', dsoft: 'oklch(0.33 0.09 300)', dring: 'oklch(0.66 0.17 300 / 0.40)' },
};

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "Blue",
  "density": "regular",
  "uiScale": 100,
  "sparklines": true,
  "dark": false
}/*EDITMODE-END*/;

const NAV = [
  { key: 'dashboard',    label: 'Dashboard', icon: 'grid' },
  { key: 'week',         label: 'This Week', icon: 'calendar' },
  { key: 'kpi',          label: 'KPI Scorecard', icon: 'trend' },
  { key: 'deliverables', label: 'Deliverables', icon: 'target' },
  { key: 'tasks',        label: 'Tasks',     icon: 'list' },
  { key: 'summary',      label: 'Weekly Summary', icon: 'summary' },
  { key: 'ask',          label: 'Ask AI',    icon: 'spark' },
  { key: 'settings',     label: 'Settings',  icon: 'settings' },
];

// ---- path routing ----
// Clean URLs via the History API (no '#'). On static GitHub Pages this needs
// a 404.html fallback (see build.mjs) that redirects deep links back through
// the app; locally serve.py serves index.html for unknown paths. BASE is the
// directory the app is mounted at — "/Task-Tracker/" on Pages, "/" locally.
//   <base>tasks            -> tasks list
//   <base>tasks/T-123      -> task detail
//   <base>deliverables/D-1 -> deliverable detail
const ROUTE_KEYS = NAV.map(n => n.key);
const APP_BASE = (window.__BASE__ || '/');
function pathToState() {
  let p = window.location.pathname;
  if (p.indexOf(APP_BASE) === 0) p = p.slice(APP_BASE.length);
  const [seg, id] = p.replace(/^\/+/, '').split('/');
  if (seg === 'tasks' && id) return { route: 'detail', selected: decodeURIComponent(id), dlvSelected: null };
  if (seg === 'deliverables' && id) return { route: 'dlvDetail', selected: null, dlvSelected: decodeURIComponent(id) };
  if (ROUTE_KEYS.includes(seg)) return { route: seg, selected: null, dlvSelected: null };
  return { route: 'dashboard', selected: null, dlvSelected: null };
}
function stateToPath(route, selected, dlvSelected) {
  if (route === 'detail' && selected) return APP_BASE + 'tasks/' + encodeURIComponent(selected);
  if (route === 'dlvDetail' && dlvSelected) return APP_BASE + 'deliverables/' + encodeURIComponent(dlvSelected);
  return APP_BASE + route;
}

function App() {
  const I = window.I;
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);

  // ---- data ----
  // Starts EMPTY (blank slate). Saved tasks load if present.
  // The demo seed is restorable on demand from Settings → "Load demo data".
  const ds = window.dataService;
  const shared = ds && ds.backend === 'supabase';

  const [tasks, setTasks] = useStateA(() => {
    try { const s = localStorage.getItem('fm_tasks'); if (s) return JSON.parse(s); } catch (_) {}
    return [];
  });
  // Deliverables = parent milestones tasks roll up to. Stored in the same
  // shared blob, tagged kind:'deliverable', so no backend schema change.
  const [deliverables, setDeliverables] = useStateA(() => {
    try { const s = localStorage.getItem('fm_deliverables'); if (s) return JSON.parse(s); } catch (_) {}
    return [];
  });
  // When applying a remote (load/realtime) change we must NOT echo it back.
  // One ref guards the single workspace-document save effect below.
  const skipSaveRef = useRefA(true); // skip the very first effect run (hydration)
  const metaRef = useRefA(null);     // workspace document metadata (createdAt, etc.)

  // Save status for the header indicator: { state: 'idle'|'saving'|'saved'|'error', at?, error? }
  // Driven by the real result of ds.saveWorkspace (which now reports honest
  // persistence — empty write => error, not a false-positive success).
  const [saveStatus, setSaveStatus] = useStateA({ state: 'idle' });

  // ---- KPI scorecard (a property of the workspace document) ----
  // Shape: { 'YYYY-MM': { 'A1': { score, notes, links:[] }, ... } }
  const [kpiScores, setKpiScores] = useStateA(() => {
    try { const s = localStorage.getItem('fm_col_kpiScores'); if (s) return JSON.parse(s); } catch (_) {}
    return {};
  });
  const [kpiMonth, setKpiMonth] = useStateA(() => window.kpiMonthKey(new Date()));

  // ---- weekly workspaces (a property of the workspace document) ----
  // Each week REFERENCES tasks by id; everything else is derived from tasks.
  const [weeks, setWeeks] = useStateA(() => {
    try { const s = localStorage.getItem('fm_col_weeks'); if (s) return JSON.parse(s); } catch (_) {}
    return [];
  });

  // ---- auth + permissions (centralised in AuthContext) ----
  // App is just a consumer now: identity, role, can()/canEdit, currentUser and
  // signOut all come from one place. The provider owns the Supabase session and
  // the cached profile (see auth-context.jsx).
  const { authUser, profile, can, canEdit, currentUser, roleLabel, signOut } = useAuth();

  // Apply a loaded/realtime workspace document (v2: { metadata, data }) to state.
  const applyDoc = useCallbackA((doc) => {
    metaRef.current = doc.metadata || metaRef.current;
    const d = doc.data || {};
    setTasks(Array.isArray(d.tasks) ? d.tasks : []);
    setDeliverables(Array.isArray(d.deliverables) ? d.deliverables : []);
    setWeeks(Array.isArray(d.weeks) ? d.weeks : []);
    setKpiScores(d.kpiScores && typeof d.kpiScores === 'object' ? d.kpiScores : {});
  }, []);

  // Persist the WHOLE workspace as one versioned document. Every feature is a
  // key under `data`, so there is one save path, one row, no per-collection
  // seeding. Mirrors locally always; pushes to Supabase only for the editor.
  //
  // Saves are debounced and single-flighted: rapid edits (typing, drag-reorder)
  // collapse into one save, and a save already in flight is never joined by a
  // second one — if state changes again mid-save, the latest snapshot is sent
  // right after the current save settles (see runSaveRef below).
  const latestDocRef = useRefA(null);
  const savingRef = useRefA(false);
  const resaveNeededRef = useRefA(false);
  const debounceRef = useRefA(null);
  const runSaveRef = useRefA(null);
  runSaveRef.current = () => {
    if (savingRef.current) { resaveNeededRef.current = true; return; }
    savingRef.current = true;
    setSaveStatus({ state: 'saving' });
    ds.saveWorkspace(latestDocRef.current, attempt => setSaveStatus({ state: 'saving', retry: attempt }))
      .then(r => {
        savingRef.current = false;
        if (r.ok) { setSaveStatus({ state: 'saved', at: Date.now() }); }
        else { console.warn('[app] workspace save failed', r.reason, r.error); setSaveStatus({ state: 'error', reason: r.reason, error: r.error }); }
        if (resaveNeededRef.current) { resaveNeededRef.current = false; runSaveRef.current(); }
      });
  };

  useEffectA(() => {
    try {
      localStorage.setItem('fm_tasks', JSON.stringify(tasks));
      localStorage.setItem('fm_deliverables', JSON.stringify(deliverables));
      localStorage.setItem('fm_col_kpiScores', JSON.stringify(kpiScores));
      localStorage.setItem('fm_col_weeks', JSON.stringify(weeks));
    } catch (_) {}
    if (skipSaveRef.current) { skipSaveRef.current = false; return; }
    if (shared && canEdit) {
      latestDocRef.current = { metadata: metaRef.current, data: { tasks, deliverables, weeks, kpiScores } };
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => runSaveRef.current(), 400);
    }
  }, [tasks, deliverables, weeks, kpiScores]);

  // Upsert one week by id (editor only).
  const saveWeek = useCallbackA((week) => {
    if (!canEdit) return;
    setWeeks(prev => {
      const i = prev.findIndex(w => w.id === week.id);
      if (i < 0) return [...prev, week];
      const n = [...prev]; n[i] = week; return n;
    });
  }, [canEdit]);

  // Delete one week by id (editor only). Tasks are untouched — a week only
  // references them, so removing the week just drops the plan, never the work.
  const deleteWeek = useCallbackA((weekId) => {
    if (!canEdit) return;
    setWeeks(prev => prev.filter(w => w.id !== weekId));
  }, [canEdit]);

  // Assign a task to a week from the task itself (editor only). A task lives in
  // at most one ACTIVE week, so adding to one removes it from any other active
  // week. Closed weeks are historical records and are never mutated — a task
  // that was worked in a past week stays recorded there even if re-planned
  // later. weekId='' clears the active assignment.
  const assignWeek = useCallbackA((taskId, weekId) => {
    if (!canEdit) return;
    const now = new Date().toISOString();
    setWeeks(prev => prev.map(w => {
      if (w.status === 'closed') return w; // immutable history
      const has = (w.taskIds || []).includes(taskId);
      if (w.id === weekId) return has ? w : { ...w, taskIds: [...(w.taskIds || []), taskId], updatedAt: now };
      return has ? { ...w, taskIds: w.taskIds.filter(x => x !== taskId), updatedAt: now } : w;
    }));
  }, [canEdit]);

  // Merge a partial patch into one week by id (editor only). Unlike replacing
  // the whole object, this merges against the LATEST stored week, so an async
  // writer (e.g. AI report generation) can't clobber edits the user made while
  // the request was in flight.
  const patchWeek = useCallbackA((weekId, partial) => {
    if (!canEdit) return;
    setWeeks(prev => prev.map(w => w.id === weekId
      ? { ...w, ...partial, updatedAt: new Date().toISOString() }
      : w));
  }, [canEdit]);

  // Replace one KPI's record for one month (editor only). The KPI screen
  // builds the full record (single-score or multi-entry), we just store it.
  const setKpi = useCallbackA((month, code, record) => {
    if (!canEdit) return;
    setKpiScores(prev => ({ ...prev, [month]: { ...(prev[month] || {}), [code]: record } }));
  }, [canEdit]);

  // Initial remote load + realtime subscription — runs once signed in
  // (reads require an authenticated session). One document, one subscription.
  useEffectA(() => {
    if (!shared || !authUser) return;
    ds.loadWorkspace().then(doc => {
      // A failed read must NEVER be treated as real (empty) data — applying it
      // would flip skipSaveRef and the very next tick would autosave a blank
      // document over whatever's actually on the server. Leave existing state
      // untouched and surface it; the user can reload to retry.
      // See [[fm-navigate-workspace-wipe-2026-07-01]].
      if (doc.loadFailed) {
        console.warn('[app] workspace load failed — not applying (would risk overwriting real data)');
        setSaveStatus({ state: 'error', reason: 'LOAD_FAILED', error: 'Could not load the shared workspace. Reload to retry — nothing was overwritten.' });
        return;
      }
      const fixed = window.repairData(doc.data.tasks, doc.data.deliverables, doc.data.weeks);
      // Persist immediately if we upgraded the schema or cleaned duplicates;
      // otherwise stay quiet so a plain load never rewrites the row.
      skipSaveRef.current = !(doc.migrated || fixed.changed);
      applyDoc({ ...doc, data: { ...doc.data, tasks: fixed.tasks, deliverables: fixed.deliverables, weeks: fixed.weeks } });
    });
    const unsub = ds.subscribeWorkspace(incoming => {
      const fixed = window.repairData(incoming.data.tasks, incoming.data.deliverables, incoming.data.weeks);
      skipSaveRef.current = true; // realtime echo: apply locally, don't re-persist
      applyDoc({ ...incoming, data: { ...incoming.data, tasks: fixed.tasks, deliverables: fixed.deliverables, weeks: fixed.weeks } });
    });
    return () => { unsub(); };
  }, [shared, authUser && authUser.id]);

  // ---- routing ----
  const [route, setRoute] = useStateA(() => pathToState().route);
  const [taskView, setTaskView] = useStateA('list');
  const [selected, setSelected] = useStateA(() => pathToState().selected);
  const [dlvSelected, setDlvSelected] = useStateA(() => pathToState().dlvSelected);
  const [composer, setComposer] = useStateA(false);
  const [askQ, setAskQ] = useStateA(null);
  const [mobileNavOpen, setMobileNavOpen] = useStateA(false);
  const sidebarRef = useRefA(null);
  const hamburgerRef = useRefA(null);

  // ---- mobile nav drawer: close on Escape, trap Tab focus inside while open ----
  useEffectA(() => {
    if (!mobileNavOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { setMobileNavOpen(false); return; }
      if (e.key !== 'Tab' || !sidebarRef.current) return;
      const focusables = sidebarRef.current.querySelectorAll('button, a, input, [tabindex]:not([tabindex="-1"])');
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavOpen]);
  // Move focus into the drawer on open, back to the hamburger on close.
  // Skips the initial mount so the hamburger doesn't steal focus on page load.
  const navSkipFocusRef = useRefA(true);
  useEffectA(() => {
    if (navSkipFocusRef.current) { navSkipFocusRef.current = false; return; }
    if (mobileNavOpen) {
      const closeBtn = sidebarRef.current && sidebarRef.current.querySelector('.sidebar-close');
      if (closeBtn) closeBtn.focus();
    } else if (hamburgerRef.current) {
      hamburgerRef.current.focus();
    }
  }, [mobileNavOpen]);
  useEffectA(() => { setMobileNavOpen(false); }, [route]);
  useEffectA(() => {
    document.body.style.overflow = mobileNavOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [mobileNavOpen]);

  // ---- url <-> state sync ----
  // React to browser back/forward (popstate fires on history navigation).
  useEffectA(() => {
    const apply = () => { const s = pathToState(); setRoute(s.route); setSelected(s.selected); setDlvSelected(s.dlvSelected); };
    window.addEventListener('popstate', apply);
    return () => window.removeEventListener('popstate', apply);
  }, []);
  // Write state into the URL. pushState adds a history entry so back/forward
  // navigates between screens; popstate above handles the reverse direction.
  // Guarded so re-renders that don't change the path don't stack duplicate
  // history entries.
  useEffectA(() => {
    const want = stateToPath(route, selected, dlvSelected);
    if (window.location.pathname !== want) window.history.pushState(null, '', want);
  }, [route, selected, dlvSelected]);

  // ---- theme ----
  useEffectA(() => {
    document.documentElement.setAttribute('data-theme', tweaks.dark ? 'dark' : 'light');
  }, [tweaks.dark]);

  // ---- accent + density + scale ----
  useEffectA(() => {
    const root = document.documentElement;
    const c = ACCENTS[tweaks.accent] || ACCENTS.Blue;
    const dark = tweaks.dark;
    root.style.setProperty('--accent', dark ? c.da : c.a);
    root.style.setProperty('--accent-hover', dark ? c.dh : c.h);
    root.style.setProperty('--accent-soft', dark ? c.dsoft : c.soft);
    root.style.setProperty('--accent-ring', dark ? c.dring : c.ring);
    root.setAttribute('data-density', tweaks.density);
    root.style.fontSize = (14 * tweaks.uiScale / 100) + 'px';
  }, [tweaks.accent, tweaks.density, tweaks.uiScale, tweaks.dark]);

  // ---- actions ----
  const openTask = useCallbackA((id) => { setSelected(id); setRoute('detail'); }, []);
  const openDeliverable = useCallbackA((id) => { setDlvSelected(id); setRoute('dlvDetail'); }, []);

  const moveTask = useCallbackA((id, status) => {
    if (!canEdit) return;
    setTasks(ts => ts.map(t => {
      if (t.id !== id || t.status === status) return t;
      const act = [...(t.activity || []), { type: status === 'Completed' ? 'completed' : 'status', userId: currentUser, at: new Date().toISOString(), detail: `${t.status} → ${status}` }];
      return { ...t, status, updatedAt: new Date().toISOString(),
        completedAt: status === 'Completed' ? new Date().toISOString() : t.completedAt,
        progress: status === 'Completed' ? 100 : t.progress, activity: act };
    }));
  }, [canEdit, currentUser]);

  const toggleDone = useCallbackA((id) => {
    if (!canEdit) return;
    setTasks(ts => ts.map(t => {
      if (t.id !== id) return t;
      const done = t.status === 'Completed';
      const status = done ? 'In Progress' : 'Completed';
      const act = [...(t.activity || []), { type: done ? 'status' : 'completed', userId: currentUser, at: new Date().toISOString(), detail: done ? 'Completed → In Progress' : undefined }];
      return { ...t, status, updatedAt: new Date().toISOString(), completedAt: done ? null : new Date().toISOString(), progress: done ? 75 : 100, activity: act };
    }));
  }, [canEdit, currentUser]);

  const addComment = useCallbackA((id, text) => {
    if (!canEdit) return;
    setTasks(ts => ts.map(t => t.id === id ? {
      ...t,
      comments: [...(t.comments || []), { id: 'c' + Date.now(), userId: currentUser, comment: text, createdAt: new Date().toISOString() }],
      activity: [...(t.activity || []), { type: 'comment', userId: currentUser, at: new Date().toISOString() }],
      updatedAt: new Date().toISOString(),
    } : t));
  }, [currentUser]);

  // shared: build a full task record from extracted/edited fields
  const buildTask = useCallbackA((data) => {
    const now = new Date().toISOString();
    return {
      id: window.nid(),
      title: data.title, description: data.description,
      priority: data.priority, category: data.category, status: data.status || 'Not Started',
      dueDate: data.dueDate || null, dependencies: data.dependencies || [], depTaskIds: data.depTaskIds || [],
      successCriteria: data.successCriteria || '', risk: data.risk || '', effort: data.effort || 'M',
      deliverableId: data.deliverableId || null,
      ownerId: currentUser, progress: data.status === 'Completed' ? 100 : data.status === 'In Progress' ? 10 : 0,
      createdAt: now, updatedAt: now, completedAt: null,
      comments: [], progressLog: [], activity: [{ type: 'created', userId: currentUser, at: now }],
    };
  }, [currentUser]);

  const createTask = useCallbackA((data) => {
    if (!canEdit) return;
    const task = buildTask(data);
    setTasks(ts => [task, ...ts]);
    setComposer(false);
    setSelected(task.id); setRoute('detail');
  }, [canEdit, buildTask]);

  // batch create — add many tasks at once, then land on the Tasks list
  const createTasks = useCallbackA((rows) => {
    if (!canEdit || !rows || !rows.length) return;
    const built = rows.map(buildTask);
    setTasks(ts => [...built, ...ts]);
    setComposer(false);
    setSelected(null); setRoute('tasks');
  }, [canEdit, buildTask]);

  // permanently remove a task (editor only); land back on the Tasks list
  const deleteTask = useCallbackA((id) => {
    if (!canEdit) return;
    const t = tasks.find(x => x.id === id);
    if (!confirm(`Delete "${t ? t.title : id}"? This permanently removes the task and its history. This cannot be undone.`)) return;
    setTasks(ts => ts.filter(x => x.id !== id));
    // purge private resources so they don't orphan and resurface on a reused id
    const ds = window.dataService;
    if (ds && ds.authReady && ds.authReady()) ds.deleteResourcesFor('task', id);
    if (selected === id) setSelected(null);
    setRoute('tasks');
  }, [canEdit, tasks, selected]);

  // log a progress update: status + % complete + note + evidence (link or attached file)
  const logProgress = useCallbackA((id, entry) => {
    if (!canEdit) return;
    const now = new Date().toISOString();
    // when the update happened — back-datable from the form; never in the future
    const at = entry.at && new Date(entry.at) <= new Date(now) ? entry.at : now;
    setTasks(ts => ts.map(t => {
      if (t.id !== id) return t;
      // status: from the form if given, else keep current
      let status = entry.status || t.status;
      // Completed always means 100% and can't go lower while completed
      let pct = Math.max(0, Math.min(100, Math.round(entry.percent)));
      if (status === 'Completed') pct = 100;
      else if (pct >= 100) pct = 99; // not-completed can't sit at 100
      const files = entry.files || (entry.fileName ? [{ name: entry.fileName, data: entry.fileData, type: '' }] : []);
      const rec = { id: 'pl' + Date.now(), percent: pct, status, note: entry.note || '', links: entry.links || (entry.link ? [entry.link] : []), files, userId: currentUser, at };
      const log = [...(t.progressLog || []), rec];
      const act = [...(t.activity || [])];
      if (status !== t.status) act.push({ type: status === 'Completed' ? 'completed' : 'status', userId: currentUser, at, detail: `${t.status} → ${status}` });
      act.push({ type: 'progress', userId: currentUser, at, detail: `${pct}%` });
      return { ...t, progress: pct, progressLog: log, status, updatedAt: now,
        completedAt: status === 'Completed' ? at : (status !== 'Completed' ? null : t.completedAt),
        activity: act };
    }));
  }, [canEdit, currentUser]);

  // task.progress/status mirror the most recent progress entry; recompute it
  // after a log entry is edited or removed
  const syncFromLatest = (t, now) => {
    const log = t.progressLog || [];
    if (!log.length) return { ...t, progress: 0, updatedAt: now };
    const latest = log.reduce((a, b) => new Date(b.at) > new Date(a.at) ? b : a);
    return { ...t, progress: latest.percent, status: latest.status || t.status,
      completedAt: latest.status === 'Completed' ? latest.at : null, updatedAt: now };
  };

  // edit an existing progress entry in place, then re-derive task progress/status
  const editProgress = useCallbackA((id, entryId, entry) => {
    if (!canEdit) return;
    const now = new Date().toISOString();
    const at = entry.at && new Date(entry.at) <= new Date(now) ? entry.at : now;
    setTasks(ts => ts.map(t => {
      if (t.id !== id) return t;
      let status = entry.status || t.status;
      let pct = Math.max(0, Math.min(100, Math.round(entry.percent)));
      if (status === 'Completed') pct = 100;
      else if (pct >= 100) pct = 99;
      const files = entry.files || (entry.fileName ? [{ name: entry.fileName, data: entry.fileData, type: '' }] : []);
      const log = (t.progressLog || []).map(e => e.id === entryId
        ? { ...e, percent: pct, status, note: entry.note || '', links: entry.links || (entry.link ? [entry.link] : []), files, at, editedAt: now }
        : e);
      const act = [...(t.activity || []), { type: 'edit', userId: currentUser, at: now, detail: 'Progress update' }];
      return syncFromLatest({ ...t, progressLog: log, activity: act }, now);
    }));
  }, [canEdit, currentUser]);

  // permanently remove a single progress entry, then re-derive task progress/status
  const deleteProgress = useCallbackA((id, entryId) => {
    if (!canEdit) return;
    if (!confirm('Delete this progress update? This cannot be undone.')) return;
    const now = new Date().toISOString();
    setTasks(ts => ts.map(t => {
      if (t.id !== id) return t;
      const log = (t.progressLog || []).filter(e => e.id !== entryId);
      const act = [...(t.activity || []), { type: 'edit', userId: currentUser, at: now, detail: 'Removed a progress update' }];
      return syncFromLatest({ ...t, progressLog: log, activity: act }, now);
    }));
  }, [canEdit, currentUser]);

  // edit task fields — diff each field, log the change, keep it revertable
  const EDIT_LABELS = { title: 'Title', description: 'Description', successCriteria: 'Success criteria', dependencies: 'Dependencies', depTaskIds: 'Dependency tasks', risk: 'Risk', priority: 'Priority', effort: 'Effort', category: 'Category', status: 'Status', ownerId: 'Owner', dueDate: 'Due date' };
  const sameVal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  const editTask = useCallbackA((id, changes) => {
    if (!canEdit) return;
    const now = new Date().toISOString();
    setTasks(ts => ts.map(t => {
      if (t.id !== id) return t;
      const next = { ...t };
      const edits = [...(t.edits || [])];
      const act = [...(t.activity || [])];
      let changed = false;
      Object.keys(changes).forEach(field => {
        if (!(field in EDIT_LABELS)) return;
        const from = t[field];
        const to = changes[field];
        if (sameVal(from, to)) return;
        changed = true;
        const eid = 'ed' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        edits.push({ id: eid, field, label: EDIT_LABELS[field], from: from ?? null, to: to ?? null, userId: currentUser, at: now, reverted: false });
        if (field === 'status') {
          act.push({ type: to === 'Completed' ? 'completed' : 'status', userId: currentUser, at: now, detail: `${from} → ${to}` });
          if (to === 'Completed') { next.progress = 100; next.completedAt = now; }
          else if (from === 'Completed') { next.completedAt = null; }
        } else {
          act.push({ type: 'edit', userId: currentUser, at: now, detail: EDIT_LABELS[field] });
        }
        next[field] = to;
      });
      if (!changed) return t;
      return { ...next, edits, activity: act, updatedAt: now };
    }));
  }, [canEdit, currentUser]);

  // revert one logged change back to its previous value (the revert is itself logged)
  const revertEdit = useCallbackA((id, editId) => {
    if (!canEdit) return;
    const now = new Date().toISOString();
    setTasks(ts => ts.map(t => {
      if (t.id !== id) return t;
      const target = (t.edits || []).find(e => e.id === editId);
      if (!target || target.reverted) return t;
      const edits = (t.edits || []).map(e => e.id === editId ? { ...e, reverted: true } : e);
      const revId = 'ed' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      edits.push({ id: revId, field: target.field, label: target.label, from: t[target.field] ?? null, to: target.from ?? null, userId: currentUser, at: now, reverted: false, isRevert: true });
      const act = [...(t.activity || []), { type: 'revert', userId: currentUser, at: now, detail: target.label }];
      return { ...t, [target.field]: target.from, edits, activity: act, updatedAt: now };
    }));
  }, [canEdit, currentUser]);

  // ---- deliverables (parent milestones) ----
  const createDeliverable = useCallbackA((data) => {
    if (!canEdit) return null;
    const now = new Date().toISOString();
    const dv = {
      id: window.did(), kind: 'deliverable',
      title: data.title, description: data.description || '',
      parentId: data.parentId || null,
      category: data.category || null,
      ownerId: data.ownerId || currentUser, status: data.status || 'Active',
      deliveryType: data.deliveryType || 'one-time',
      startDate: data.startDate || null,
      targetDate: data.targetDate || null,
      // recurring
      recurrence: data.recurrence || null,
      currentCycle: data.currentCycle || null,
      instances: data.instances || [],
      // target-based
      targetValue: (data.targetValue ?? null),
      currentValue: (data.currentValue ?? null),
      unit: data.unit || null,
      createdAt: now, updatedAt: now,
    };
    setDeliverables(ds => [dv, ...ds]);
    return dv.id;
  }, [canEdit, currentUser]);

  const editDeliverable = useCallbackA((id, changes) => {
    if (!canEdit) return;
    setDeliverables(ds => ds.map(d => d.id === id ? { ...d, ...changes, updatedAt: new Date().toISOString() } : d));
  }, [canEdit]);

  const deleteDeliverable = useCallbackA((id) => {
    if (!canEdit) return;
    setDeliverables(ds => {
      const gone = ds.find(d => d.id === id);
      const newParent = gone ? (gone.parentId || null) : null;
      // reparent children up one level, then drop the node
      return ds.filter(d => d.id !== id).map(d => d.parentId === id ? { ...d, parentId: newParent } : d);
    });
    setTasks(ts => ts.map(t => t.deliverableId === id ? { ...t, deliverableId: null } : t));
    const ds = window.dataService;
    if (ds && ds.authReady && ds.authReady()) ds.deleteResourcesFor('deliverable', id);
    setRoute('deliverables'); setDlvSelected(null);
  }, [canEdit]);

  const assignDeliverable = useCallbackA((taskId, deliverableId) => {
    if (!canEdit) return;
    const now = new Date().toISOString();
    setTasks(ts => ts.map(t => {
      if (t.id !== taskId || (t.deliverableId || null) === (deliverableId || null)) return t;
      const act = [...(t.activity || []), { type: 'deliverable', userId: currentUser, at: now, detail: deliverableId ? 'assigned to a deliverable' : 'removed from deliverable' }];
      return { ...t, deliverableId: deliverableId || null, updatedAt: now, activity: act };
    }));
  }, [canEdit, currentUser]);

  // ---- shared (public) resources attached to a task or deliverable ----
  // Private resources live in Supabase (per-user RLS); these public ones live
  // in the shared blob so everyone sees them — only the editor can change them.
  const rrid = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const addEntityResource = useCallbackA((parentType, parentId, res) => {
    if (!canEdit) return;
    const item = { id: rrid(), kind: res.kind || 'link', title: res.title || '', url: res.url || '', note: res.note || '' };
    if (parentType === 'task') setTasks(ts => ts.map(t => t.id === parentId ? { ...t, resources: [...(t.resources || []), item] } : t));
    else setDeliverables(ds2 => ds2.map(d => d.id === parentId ? { ...d, resources: [...(d.resources || []), item] } : d));
  }, [canEdit]);
  const deleteEntityResource = useCallbackA((parentType, parentId, resId) => {
    if (!canEdit) return;
    if (parentType === 'task') setTasks(ts => ts.map(t => t.id === parentId ? { ...t, resources: (t.resources || []).filter(r => r.id !== resId) } : t));
    else setDeliverables(ds2 => ds2.map(d => d.id === parentId ? { ...d, resources: (d.resources || []).filter(r => r.id !== resId) } : d));
  }, [canEdit]);
  const editEntityResource = useCallbackA((parentType, parentId, resId, patch) => {
    if (!canEdit) return;
    const apply = (r) => r.id === resId ? { ...r, ...patch } : r;
    if (parentType === 'task') setTasks(ts => ts.map(t => t.id === parentId ? { ...t, resources: (t.resources || []).map(apply) } : t));
    else setDeliverables(ds2 => ds2.map(d => d.id === parentId ? { ...d, resources: (d.resources || []).map(apply) } : d));
  }, [canEdit]);

  const goAsk = useCallbackA((q) => { if (typeof q === 'string') setAskQ(q); setRoute('ask'); }, []);

  const loadDemo = () => { if (!canEdit) return; if (confirm('Load the demo FM Navigate task set? This replaces your current workspace.')) { setTasks(window.SEED_TASKS); setDeliverables(window.SEED_DELIVERABLES); setWeeks([]); setSelected(null); setDlvSelected(null); setRoute('dashboard'); } };
  // Full workspace reset: tasks, deliverables, weekly plans AND KPI scores.
  // Weeks reference task ids, so leaving them behind would orphan; KPI scores
  // are part of the same unified document, so a "blank slate" must clear them.
  const clearAll = () => { if (!canEdit) return; if (confirm('Clear the ENTIRE workspace — tasks, deliverables, weekly plans and KPI scores — and start from a blank slate? This cannot be undone.')) { setTasks([]); setDeliverables([]); setWeeks([]); setKpiScores({}); setSelected(null); setDlvSelected(null); setRoute('dashboard'); } };

  // ---- one-time attachment migration (base64 -> Storage) ----
  // Progress-log evidence used to be inline base64 in the workspace document,
  // ballooning it to ~11MB and causing save timeouts — see
  // [[fm-navigate-save-timeout-2026-07-01]]. This walks every legacy `data:`
  // file, uploads it, and rewrites the record to a Storage `path`. The final
  // setTasks feeds the normal debounced/retried save effect above — no
  // separate save call needed. Idempotent: count is 0 and the button hides
  // itself once nothing legacy remains.
  const legacyAttachmentCount = useMemoA(() => tasks.reduce((n, t) =>
    n + (t.progressLog || []).reduce((n2, pl) => n2 + (pl.files || []).filter(f => f.data).length, 0), 0), [tasks]);
  const [migrateStatus, setMigrateStatus] = useStateA(null); // { running, total, completed, freedBytes } | null
  const migrateAttachments = useCallbackA(async () => {
    if (!canEdit || migrateStatus?.running) return;
    const jobs = [];
    tasks.forEach(t => (t.progressLog || []).forEach(pl => (pl.files || []).forEach((f, i) => {
      if (f.data) jobs.push({ taskId: t.id, entryId: pl.id, index: i, file: f });
    })));
    if (!jobs.length) return;
    setMigrateStatus({ running: true, total: jobs.length, completed: 0, freedBytes: 0 });
    const newPathByFile = new Map();
    let freedBytes = 0;
    for (const job of jobs) {
      try {
        const blob = await (await fetch(job.file.data)).blob();
        freedBytes += blob.size;
        const r = await ds.uploadAttachment(blob, { taskId: job.taskId, entryId: job.entryId, index: job.index, name: job.file.name });
        if (r.ok) newPathByFile.set(job.file, r.path);
      } catch (_) { /* leave this one as-is; safe to re-run */ }
      setMigrateStatus(s => ({ ...s, completed: s.completed + 1 }));
    }
    setTasks(ts => ts.map(t => ({
      ...t,
      progressLog: (t.progressLog || []).map(pl => ({
        ...pl,
        files: (pl.files || []).map(f => newPathByFile.has(f) ? { name: f.name, type: f.type, path: newPathByFile.get(f) } : f),
      })),
    })));
    setMigrateStatus({ running: false, total: jobs.length, completed: jobs.length, freedBytes });
  }, [canEdit, tasks, migrateStatus]);

  // ---- backup: export / import the whole workspace document ----
  const exportWorkspace = () => {
    const json = ds.exportWorkspace();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `fm-navigate-workspace-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };
  const importWorkspace = (file) => {
    if (!canEdit) { alert('Read-only — sign in as the editor to import.'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      if (!confirm('Replace the ENTIRE workspace with this file? Current data will be overwritten.')) return;
      ds.importWorkspace(reader.result).then(r => {
        if (!r.ok) { alert('Import failed: ' + (r.error || 'unknown error')); return; }
        // ds.importWorkspace already persisted the repaired doc, so skip the
        // re-save the persistence effect would otherwise fire on applyDoc.
        skipSaveRef.current = true;
        applyDoc(r.doc);
        setSelected(null); setDlvSelected(null); setRoute('dashboard');
      });
    };
    reader.readAsText(file);
  };

  // ---- counts for nav ----
  const counts = useMemoA(() => ({
    tasks: tasks.filter(t => !['Completed','Cancelled'].includes(t.status)).length,
    blocked: tasks.filter(t => t.status === 'Blocked').length,
  }), [tasks]);

  const selectedTask = useMemoA(() => tasks.find(t => t.id === selected), [tasks, selected]);
  const selectedDeliverable = useMemoA(() => deliverables.find(d => d.id === dlvSelected), [deliverables, dlvSelected]);

  const titleMap = { dashboard: 'Dashboard', week: 'This Week', kpi: 'KPI Scorecard', tasks: 'Tasks', deliverables: 'Deliverables', dlvDetail: 'Deliverable', summary: 'Weekly Summary', ask: 'Ask AI', settings: 'Settings', detail: 'Task' };

  // ---- auth gate: login is required before anything renders ----
  if (shared && authUser === undefined) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 14 }}>
        Loading…
      </div>
    );
  }
  if (shared && !authUser) {
    return <LoginScreen />;
  }

  return (
    <div className="app">
      {/* ---- mobile drawer backdrop ---- */}
      <div className={`sidebar-backdrop ${mobileNavOpen ? 'show' : ''}`} onClick={() => setMobileNavOpen(false)} aria-hidden="true" />

      {/* ---- sidebar ---- */}
      <aside id="mobile-sidebar" ref={sidebarRef} className={`sidebar ${mobileNavOpen ? 'open' : ''}`} aria-hidden={!mobileNavOpen && window.innerWidth <= 760}>
        <div className="brand">
          <div className="brand-mark"><I.target size={18} /></div>
          <div>
            <div className="brand-name">FM Navigate</div>
            <div className="brand-sub">EXECUTION HUB</div>
          </div>
          <span className="grow" />
          <button className="icon-btn sidebar-close" onClick={() => setMobileNavOpen(false)} title="Close menu" aria-label="Close navigation">
            <I.x size={18} />
          </button>
        </div>

        {NAV.map(n => {
          const Icon = I[n.icon];
          const active = route === n.key || (route === 'detail' && n.key === 'tasks') || (route === 'dlvDetail' && n.key === 'deliverables');
          const count = n.key === 'tasks' ? counts.tasks : null;
          return (
            <button key={n.key} className={`nav-item ${active ? 'active' : ''}`} onClick={() => { setRoute(n.key); setSelected(null); }}>
              <span className="nav-ico"><Icon size={17} /></span>
              {n.label}
              {count != null && <span className={`nav-count ${counts.blocked && n.key === 'tasks' ? 'alert' : ''}`}>{count}</span>}
            </button>
          );
        })}

        <div className="sidebar-mobile-actions">
          {canEdit
            ? <button className="btn btn-primary btn-sm" onClick={() => { setComposer(true); setMobileNavOpen(false); }}><I.spark size={14} /> New task</button>
            : <span className="chip" title="Founder has read-only access">Read-only view</span>}
          <button className="icon-btn" onClick={() => setTweak('dark', !tweaks.dark)} title="Toggle theme">
            {tweaks.dark ? <I.sun size={18} /> : <I.moon size={18} />} <span>Theme</span>
          </button>
          <button className="icon-btn" title="Notifications"><I.bell size={18} /> <span>Notifications</span></button>
        </div>

        <div className="sidebar-spacer" />

        <div className="nav-label">Signed in as</div>
        <div className="team-row" style={{ width: '100%', textAlign: 'left', border: '1px solid var(--accent)', background: 'var(--accent-soft)' }}>
          <window.Avatar user={currentUser} size={30} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="team-name">{shared ? ((profile && (profile.name || profile.email)) || (authUser && authUser.email) || '…') : window.USERS[currentUser].name}</div>
            <div className="team-role" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {shared && authUser ? authUser.email : window.USERS[currentUser].role}
            </div>
          </div>
          <span className="chip" style={{ fontSize: 10, padding: '1px 6px', flexShrink: 0 }}>{roleLabel}</span>
        </div>
        {shared && authUser && (
          <button className="btn btn-subtle btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={signOut}>
            <I.x size={13} /> Sign out
          </button>
        )}
      </aside>

      {/* ---- main ---- */}
      <div className="main">
        <header className="topbar">
          <button ref={hamburgerRef} className="icon-btn hamburger-btn" onClick={() => setMobileNavOpen(true)} title="Open menu"
                  aria-label="Open navigation" aria-expanded={mobileNavOpen} aria-controls="mobile-sidebar">
            <I.menu size={20} />
          </button>
          <span className="topbar-title">{titleMap[route]}</span>
          {route === 'detail' && <span className="topbar-crumb">· {selectedTask?.id}</span>}
          <span className="grow" />
          <span className="topbar-actions">
            {shared && canEdit && <window.SaveIndicator status={saveStatus} />}
            {canEdit
              ? <button className="btn btn-primary btn-sm" onClick={() => setComposer(true)}><I.spark size={14} /> New task</button>
              : <span className="chip" title="Founder has read-only access">Read-only view</span>}
            <button className="icon-btn" onClick={() => setTweak('dark', !tweaks.dark)} title="Toggle theme">
              {tweaks.dark ? <I.sun size={18} /> : <I.moon size={18} />}
            </button>
            <button className="icon-btn" title="Notifications"><I.bell size={18} /></button>
          </span>
          <window.Avatar user={currentUser} size={32} />
        </header>

        {route === 'kpi' && (
          <div className="scroll-area">
            <window.KpiScorecard scores={kpiScores} month={kpiMonth} setMonth={setKpiMonth} onSetKpi={setKpi} canEdit={canEdit} />
          </div>
        )}

        {route === 'dashboard' && (
          <div className="scroll-area">
            <window.Dashboard tasks={tasks} deliverables={deliverables} onOpen={openTask} onOpenDeliverable={openDeliverable} onCompose={() => setComposer(true)} onAsk={goAsk} onNav={setRoute} density={tweaks.density} canEdit={canEdit} currentUser={currentUser} />
          </div>
        )}
        {route === 'tasks' && (
          <window.TasksScreen tasks={tasks} deliverables={deliverables} view={taskView} setView={setTaskView} onOpen={openTask}
            onOpenDeliverable={openDeliverable} onCompose={() => setComposer(true)} onMove={moveTask} onToggleDone={toggleDone} canEdit={canEdit} />
        )}
        {route === 'deliverables' && (
          <window.DeliverablesScreen deliverables={deliverables} tasks={tasks} canEdit={canEdit}
            onOpen={openDeliverable} onCreate={createDeliverable} />
        )}
        {route === 'dlvDetail' && (
          <window.DeliverableDetail deliverable={selectedDeliverable} deliverables={deliverables} tasks={tasks} canEdit={canEdit} currentUser={currentUser}
            onBack={() => { setRoute('deliverables'); setDlvSelected(null); }} onOpen={openDeliverable} onOpenTask={openTask}
            onCreate={createDeliverable} onEdit={editDeliverable} onDelete={deleteDeliverable} onAssign={assignDeliverable}
            onAddResource={addEntityResource} onDeleteResource={deleteEntityResource} onEditResource={editEntityResource} />
        )}
        {route === 'detail' && (
          <window.TaskDetail task={selectedTask} deliverables={deliverables} allTasks={tasks} onClose={() => { setRoute('tasks'); setSelected(null); }}
            onAddComment={addComment} onToggleDone={toggleDone} onLogProgress={logProgress} onEditProgress={editProgress} onDeleteProgress={deleteProgress} onEditTask={editTask} onRevertEdit={revertEdit}
            onAssignDeliverable={assignDeliverable} onOpenDeliverable={openDeliverable} onOpenTask={openTask} onUpdate={() => {}} onDeleteTask={deleteTask} canEdit={canEdit} currentUser={currentUser}
            weeks={weeks} onAssignWeek={assignWeek}
            onCreateLinked={(t) => setComposer({ linkTo: { taskId: t.id, title: t.title, deliverableId: t.deliverableId } })}
            onAddResource={addEntityResource} onDeleteResource={deleteEntityResource} onEditResource={editEntityResource} />
        )}
        {route === 'week' && (
          <window.WeeklyWorkspace weeks={weeks} onSaveWeek={saveWeek} onPatchWeek={patchWeek} onDeleteWeek={deleteWeek} tasks={tasks} deliverables={deliverables} canEdit={canEdit} onOpenTask={openTask} />
        )}
        {route === 'summary' && <window.WeeklySummary tasks={tasks} onOpen={openTask} />}
        {route === 'ask' && <window.AskAI tasks={tasks} initialQuestion={askQ} clearInitial={() => setAskQ(null)} />}
        {route === 'settings' && <Settings tweaks={tweaks} setTweak={setTweak} onLoadDemo={loadDemo} onClearAll={clearAll} onExport={exportWorkspace} onImport={importWorkspace} canEdit={canEdit} taskCount={tasks.length}
          legacyAttachmentCount={legacyAttachmentCount} migrateStatus={migrateStatus} onMigrateAttachments={migrateAttachments} />}
      </div>

      {composer && <window.AIComposer onClose={() => setComposer(false)} onCreate={createTask} onCreateMany={createTasks} linkTo={composer && composer.linkTo} />}

      {/* ---- Tweaks panel ---- */}
      <window.TweaksPanel>
        <window.TweakSection label="Brand" />
        <window.TweakColor label="Accent" value={ACCENTS[tweaks.accent].a}
          options={[ACCENTS.Blue.a, ACCENTS.Teal.a, ACCENTS.Violet.a]}
          onChange={(v) => setTweak('accent', v === ACCENTS.Teal.a ? 'Teal' : v === ACCENTS.Violet.a ? 'Violet' : 'Blue')} />
        <window.TweakToggle label="Dark mode" value={tweaks.dark} onChange={(v) => setTweak('dark', v)} />
        <window.TweakSection label="Layout" />
        <window.TweakRadio label="Density" value={tweaks.density} options={['compact', 'regular', 'comfy']} onChange={(v) => setTweak('density', v)} />
        <window.TweakSlider label="UI scale" value={tweaks.uiScale} min={90} max={115} step={5} unit="%" onChange={(v) => setTweak('uiScale', v)} />
        <window.TweakToggle label="KPI sparklines" value={tweaks.sparklines} onChange={(v) => setTweak('sparklines', v)} />
      </window.TweaksPanel>
    </div>
  );
}

/* ---------------- Settings ---------------- */
/* ---------------- Users & roles (Settings) ----------------
   Lists the team from `profiles`. An owner (can('users','write')) can change
   each person's role and active/disabled status inline; everyone else with
   read access sees it read-only. Role/status writes are enforced by RLS + the
   privilege trigger — the UI just mirrors that. Inviting users is not here yet
   (creating accounts needs the server-side admin API). */
function UsersManager() {
  const I = window.I;
  const ds = window.dataService;
  const { shared, can, roles, roleLabelOf } = useAuth();
  const [rows, setRows] = useStateA(null);   // null = loading
  const [savingId, setSavingId] = useStateA(null);
  const [err, setErr] = useStateA('');

  // User administration is OWNER-only (can('users','write')). Nobody else — not
  // even a PM — sees this card; the DB enforces the same via RLS.
  const canManage = can('users', 'write');

  useEffectA(() => {
    if (!shared || !canManage) return;
    let alive = true;
    ds.listProfiles().then(list => { if (alive) setRows(list); });
    return () => { alive = false; };
  }, [shared, canManage]);

  // Local-only mode (no backend) or not an owner → don't render the card.
  if (!shared || !canManage) return null;

  const patch = (id, field, value) => {
    const prev = rows;
    setErr('');
    setSavingId(id);
    setRows(rows.map(r => r.id === id ? { ...r, [field]: value } : r)); // optimistic
    ds.updateProfile(id, { [field]: value }).then(res => {
      setSavingId(null);
      if (!res.ok) { setRows(prev); setErr(res.error || 'Update failed.'); }
    });
  };

  const initials = (p) => (p.name || p.email || '?').trim().split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase();

  return (
    <div className="card card-pad mb16">
      <div className="row between center mb12">
        <div className="section-eyebrow" style={{ margin: 0 }}>Users & roles{rows ? ` · ${rows.length}` : ''}</div>
      </div>

      {rows === null && <div className="muted" style={{ fontSize: 13, padding: '8px 0' }}>Loading team…</div>}
      {rows && rows.length === 0 && <div className="muted" style={{ fontSize: 13, padding: '8px 0' }}>No profiles yet. Users appear here after they first sign in.</div>}

      {rows && rows.map(p => (
        <div key={p.id} className="row gap10 center" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', opacity: p.status === 'disabled' ? 0.55 : 1 }}>
          <div style={{ width: 32, height: 32, borderRadius: 99, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 12, fontWeight: 700 }}>{initials(p)}</div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name || p.email || p.id}</div>
            <div className="muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.email}</div>
          </div>
          <select className="input" style={{ width: 'auto', fontSize: 12.5, padding: '5px 8px' }}
            value={p.role} disabled={savingId === p.id}
            onChange={e => patch(p.id, 'role', e.target.value)}>
            {roles.map(r => <option key={r} value={r}>{roleLabelOf(r)}</option>)}
          </select>
          <button className="btn btn-ghost btn-sm" disabled={savingId === p.id}
            onClick={() => patch(p.id, 'status', p.status === 'disabled' ? 'active' : 'disabled')}
            title={p.status === 'disabled' ? 'Re-enable this user' : 'Disable this user'}>
            {p.status === 'disabled' ? <><I.refresh size={13} /> Enable</> : <><I.x size={13} /> Disable</>}
          </button>
        </div>
      ))}

      {err && <div style={{ color: 'var(--st-blocked)', fontSize: 12.5, marginTop: 10 }}>{err}</div>}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.5 }}>
        To add someone: create their account in Supabase (Authentication → Users); they appear here on first sign-in, then set their role. Role changes take effect after the user re-authenticates.
      </div>
    </div>
  );
}

function Settings({ tweaks, setTweak, onLoadDemo, onClearAll, onExport, onImport, canEdit = true, taskCount = 0, legacyAttachmentCount = 0, migrateStatus, onMigrateAttachments }) {
  const I = window.I;
  const fileRef = React.useRef(null);
  const Row = ({ k, children }) => (
    <div className="meta-row" style={{ padding: '14px 0' }}><span className="meta-k" style={{ fontSize: 13 }}>{k}</span>{children}</div>
  );
  return (
    <div className="scroll-area fade-in">
      <div className="page-pad" style={{ maxWidth: 720 }}>
        <div className="dash-greet" style={{ fontSize: 23, marginBottom: 4 }}>Settings</div>
        <div className="dash-date mb16">Workspace · FM Navigate Execution Hub</div>

        <div className="card card-pad mb16">
          <div className="section-eyebrow mb12">Appearance</div>
          <Row k="Theme">
            <div className="seg">
              <button className={!tweaks.dark ? 'active' : ''} onClick={() => setTweak('dark', false)}><I.sun size={14} /> Light</button>
              <button className={tweaks.dark ? 'active' : ''} onClick={() => setTweak('dark', true)}><I.moon size={14} /> Dark</button>
            </div>
          </Row>
          <Row k="Accent color">
            <div className="row gap8">
              {Object.entries(ACCENTS).map(([name, c]) => (
                <button key={name} onClick={() => setTweak('accent', name)}
                  style={{ width: 26, height: 26, borderRadius: 99, background: c.a, border: tweaks.accent === name ? '2px solid var(--text)' : '2px solid transparent', outline: '1px solid var(--border)' }} title={name} />
              ))}
            </div>
          </Row>
          <Row k="Density">
            <div className="seg">
              {['compact', 'regular', 'comfy'].map(dn => (
                <button key={dn} className={tweaks.density === dn ? 'active' : ''} onClick={() => setTweak('density', dn)} style={{ textTransform: 'capitalize' }}>{dn}</button>
              ))}
            </div>
          </Row>
        </div>

        <UsersManager />

        <div className="card card-pad">
          <div className="section-eyebrow mb12">Data · {taskCount} task{taskCount === 1 ? '' : 's'}</div>
          <div className="row between center" style={{ paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
            <div><div style={{ fontWeight: 600, fontSize: 13.5 }}>Backup workspace</div><div className="muted" style={{ fontSize: 12 }}>Export everything to a JSON file, or restore from one.</div></div>
            <div className="row gap8">
              <button className="btn btn-ghost" onClick={onExport}><I.arrowUp size={14} /> Export</button>
              {canEdit && <button className="btn btn-ghost" onClick={() => fileRef.current && fileRef.current.click()}><I.inbox size={14} /> Import</button>}
              <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files && e.target.files[0]; if (f) onImport(f); e.target.value = ''; }} />
            </div>
          </div>
          <div className="row between center" style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
            <div><div style={{ fontWeight: 600, fontSize: 13.5 }}>Load demo data</div><div className="muted" style={{ fontSize: 12 }}>Replace current tasks with the sample FM Navigate set.</div></div>
            <button className="btn btn-ghost" onClick={onLoadDemo}><I.refresh size={14} /> Load demo</button>
          </div>
          <div className="row between center" style={{ paddingTop: 12 }}>
            <div><div style={{ fontWeight: 600, fontSize: 13.5 }}>Clear all tasks</div><div className="muted" style={{ fontSize: 12 }}>Wipe everything and start from a blank slate.</div></div>
            <button className="btn btn-ghost" onClick={onClearAll} style={{ color: 'var(--st-blocked)', borderColor: 'var(--st-blocked)' }}><I.x size={14} /> Clear all</button>
          </div>
        </div>

        {canEdit && legacyAttachmentCount > 0 && (
          <div className="card card-pad mt16">
            <div className="section-eyebrow mb12">Maintenance</div>
            <div className="row between center">
              <div>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>Migrate attachments to Storage</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {legacyAttachmentCount} progress-log file{legacyAttachmentCount === 1 ? '' : 's'} still stored inline — this bloats every save and can cause timeouts. Moves them to Supabase Storage; one-time, safe to re-run.
                </div>
              </div>
              <button className="btn btn-ghost" onClick={onMigrateAttachments} disabled={migrateStatus?.running}>
                <I.refresh size={14} /> {migrateStatus?.running ? `Migrating ${migrateStatus.completed} of ${migrateStatus.total}…` : 'Migrate now'}
              </button>
            </div>
            {migrateStatus && !migrateStatus.running && migrateStatus.total > 0 && (
              <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                Done — moved {migrateStatus.total} file{migrateStatus.total === 1 ? '' : 's'}, freed ~{(migrateStatus.freedBytes / 1024 / 1024).toFixed(1)}MB from the workspace document.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Login landing ----------------
   Required gate: the whole app is hidden until a user signs in with their
   Supabase account. The editor account unlocks editing; any other account
   gets a read-only view. */
function LoginScreen() {
  const I = window.I;
  const ds = window.dataService;
  const { setAuthUser } = useAuth();
  const [email, setEmail] = useStateA('');
  const [pw, setPw] = useStateA('');
  const [busy, setBusy] = useStateA(false);
  const [err, setErr] = useStateA('');

  const submit = async () => {
    if (busy) return;
    setErr('');
    if (!email.trim() || !pw) { setErr('Enter your email and password.'); return; }
    setBusy(true);
    const r = await ds.signIn(email.trim(), pw);
    setBusy(false);
    if (r.ok) { setPw(''); setAuthUser(r.user || null); }
    else setErr(r.error || 'Sign-in failed.');
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'var(--bg)' }}>
      <div className="card card-pad fade-in" style={{ width: '100%', maxWidth: 380 }}>
        <div className="brand" style={{ marginBottom: 20 }}>
          <div className="brand-mark"><I.target size={18} /></div>
          <div>
            <div className="brand-name">FM Navigate</div>
            <div className="brand-sub">EXECUTION HUB</div>
          </div>
        </div>
        <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 4 }}>Sign in</div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 18 }}>Sign in to view and manage the workspace.</div>
        <div className="col gap10">
          <input className="input" type="email" placeholder="Email" autoFocus value={email}
            onChange={e => setEmail(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
          <input className="input" type="password" placeholder="Password" value={pw}
            onChange={e => setPw(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={submit} disabled={busy}>
            {busy ? 'Signing in…' : <><I.user size={14} /> Sign in</>}
          </button>
        </div>
        {err && <div style={{ color: 'var(--st-blocked)', fontSize: 12.5, marginTop: 12 }}>{err}</div>}
        <div className="muted" style={{ fontSize: 11.5, marginTop: 16, lineHeight: 1.5 }}>
          Accounts are managed in Supabase. Ask the workspace owner for access.
        </div>
      </div>
    </div>
  );
}

window.App = App;
window.LoginScreen = LoginScreen;
window.ACCENTS = ACCENTS;
