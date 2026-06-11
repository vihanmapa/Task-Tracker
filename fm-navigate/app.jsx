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
  { key: 'deliverables', label: 'Deliverables', icon: 'target' },
  { key: 'tasks',        label: 'Tasks',     icon: 'list' },
  { key: 'summary',      label: 'Weekly Summary', icon: 'summary' },
  { key: 'ask',          label: 'Ask AI',    icon: 'spark' },
  { key: 'settings',     label: 'Settings',  icon: 'settings' },
];

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
  // Split a mixed remote blob back into tasks vs deliverables.
  const splitBlob = (arr) => ({
    tasks: (arr || []).filter(r => r.kind !== 'deliverable'),
    deliverables: (arr || []).filter(r => r.kind === 'deliverable'),
  });
  // When applying a remote (load/realtime) change we must NOT echo it back.
  const skipSaveRef = useRefA(true); // skip the very first effect run (hydration)

  // Persist: always mirror locally; push to Supabase only when editing is unlocked.
  useEffectA(() => {
    try { localStorage.setItem('fm_tasks', JSON.stringify(tasks)); } catch (_) {}
    try { localStorage.setItem('fm_deliverables', JSON.stringify(deliverables)); } catch (_) {}
    if (skipSaveRef.current) { skipSaveRef.current = false; return; }
    if (shared && editUnlocked) {
      const blob = [...tasks, ...deliverables.map(d => ({ ...d, kind: 'deliverable' }))];
      ds.saveTasks(blob).then(r => { if (!r.ok) console.warn('[app] remote save failed', r); });
    }
  }, [tasks, deliverables]);

  // ---- active persona (who is signed in) ----
  const [currentUser, setCurrentUser] = useStateA(() => {
    try { const s = localStorage.getItem('fm_user'); if (s === 'vihan' || s === 'richard') return s; } catch (_) {}
    return 'richard';
  });
  useEffectA(() => { try { localStorage.setItem('fm_user', currentUser); } catch (_) {} }, [currentUser]);

  // Editing is unlocked by the shared password (local backend = always allowed).
  const [editUnlocked, setEditUnlocked] = useStateA(() => !shared);
  const canEdit = editUnlocked && currentUser === 'vihan'; // PM can mutate; Founder is read-only

  // Initial remote load + realtime subscription (Supabase backend only).
  useEffectA(() => {
    if (!shared) return;
    let unsub = () => {};
    ds.loadTasks().then(remote => { const s = splitBlob(remote); skipSaveRef.current = true; setTasks(s.tasks); setDeliverables(s.deliverables); });
    unsub = ds.subscribe(incoming => { const s = splitBlob(incoming); skipSaveRef.current = true; setTasks(s.tasks); setDeliverables(s.deliverables); });
    return () => unsub();
  }, []);

  // Prompt for the shared password, verify server-side, then unlock PM mode.
  const unlockEdit = useCallbackA(async () => {
    if (!shared) { setEditUnlocked(true); setCurrentUser('vihan'); return; }
    const pw = window.prompt('Enter the edit password to unlock PM (edit) mode:');
    if (pw == null) return;
    const ok = await ds.verifyPassword(pw);
    if (ok) { ds.setPassword(pw); setEditUnlocked(true); setCurrentUser('vihan'); }
    else window.alert('Wrong password.');
  }, [shared]);

  // ---- routing ----
  const [route, setRoute] = useStateA('dashboard');
  const [taskView, setTaskView] = useStateA('list');
  const [selected, setSelected] = useStateA(null);
  const [dlvSelected, setDlvSelected] = useStateA(null);
  const [composer, setComposer] = useStateA(false);
  const [askQ, setAskQ] = useStateA(null);

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
      dueDate: data.dueDate || null, dependencies: data.dependencies || [],
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

  // log a progress update: status + % complete + note + evidence (link or attached file)
  const logProgress = useCallbackA((id, entry) => {
    if (!canEdit) return;
    const now = new Date().toISOString();
    setTasks(ts => ts.map(t => {
      if (t.id !== id) return t;
      // status: from the form if given, else keep current
      let status = entry.status || t.status;
      // Completed always means 100% and can't go lower while completed
      let pct = Math.max(0, Math.min(100, Math.round(entry.percent)));
      if (status === 'Completed') pct = 100;
      else if (pct >= 100) pct = 99; // not-completed can't sit at 100
      const files = entry.files || (entry.fileName ? [{ name: entry.fileName, data: entry.fileData, type: '' }] : []);
      const rec = { id: 'pl' + Date.now(), percent: pct, status, note: entry.note || '', links: entry.links || (entry.link ? [entry.link] : []), files, userId: currentUser, at: now };
      const log = [...(t.progressLog || []), rec];
      const act = [...(t.activity || [])];
      if (status !== t.status) act.push({ type: status === 'Completed' ? 'completed' : 'status', userId: currentUser, at: now, detail: `${t.status} → ${status}` });
      act.push({ type: 'progress', userId: currentUser, at: now, detail: `${pct}%` });
      return { ...t, progress: pct, progressLog: log, status, updatedAt: now,
        completedAt: status === 'Completed' ? now : (status !== 'Completed' ? null : t.completedAt),
        activity: act };
    }));
  }, [canEdit, currentUser]);

  // edit task fields — diff each field, log the change, keep it revertable
  const EDIT_LABELS = { title: 'Title', description: 'Description', successCriteria: 'Success criteria', dependencies: 'Dependencies', risk: 'Risk', priority: 'Priority', effort: 'Effort', category: 'Category' };
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
        act.push({ type: 'edit', userId: currentUser, at: now, detail: EDIT_LABELS[field] });
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
      ownerId: currentUser, status: data.status || 'Active',
      targetDate: data.targetDate || null, createdAt: now, updatedAt: now,
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
    setDeliverables(ds => ds.filter(d => d.id !== id));
    setTasks(ts => ts.map(t => t.deliverableId === id ? { ...t, deliverableId: null } : t));
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

  const goAsk = useCallbackA((q) => { if (typeof q === 'string') setAskQ(q); setRoute('ask'); }, []);

  const loadDemo = () => { if (confirm('Load the demo FM Navigate task set? This replaces your current tasks.')) { setTasks(window.SEED_TASKS); setDeliverables(window.SEED_DELIVERABLES); setSelected(null); setDlvSelected(null); setRoute('dashboard'); } };
  const clearAll = () => { if (confirm('Clear ALL tasks and start from a blank slate? This cannot be undone.')) { setTasks([]); setDeliverables([]); setSelected(null); setDlvSelected(null); setRoute('dashboard'); } };

  // ---- counts for nav ----
  const counts = useMemoA(() => ({
    tasks: tasks.filter(t => !['Completed','Cancelled'].includes(t.status)).length,
    blocked: tasks.filter(t => t.status === 'Blocked').length,
  }), [tasks]);

  const selectedTask = useMemoA(() => tasks.find(t => t.id === selected), [tasks, selected]);
  const selectedDeliverable = useMemoA(() => deliverables.find(d => d.id === dlvSelected), [deliverables, dlvSelected]);

  const titleMap = { dashboard: 'Dashboard', tasks: 'Tasks', deliverables: 'Deliverables', dlvDetail: 'Deliverable', summary: 'Weekly Summary', ask: 'Ask AI', settings: 'Settings', detail: 'Task' };

  return (
    <div className="app">
      {/* ---- sidebar ---- */}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><I.target size={18} /></div>
          <div>
            <div className="brand-name">FM Navigate</div>
            <div className="brand-sub">EXECUTION HUB</div>
          </div>
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

        <div className="sidebar-spacer" />

        <div className="nav-label">Signed in as</div>
        {['richard', 'vihan'].map(uid => {
          const u = window.USERS[uid];
          const me = currentUser === uid;
          return (
            <button key={uid} className="team-row" onClick={() => {
                setComposer(false);
                if (uid === 'vihan' && !canEdit) { unlockEdit(); }
                else { setCurrentUser(uid); }
              }}
              style={{ width: '100%', textAlign: 'left', border: me ? '1px solid var(--accent)' : '1px solid transparent', background: me ? 'var(--accent-soft)' : 'transparent' }}
              title={`View as ${u.name}`}>
              <window.Avatar user={uid} size={30} />
              <div className="grow"><div className="team-name">{u.name}</div><div className="team-role">{u.role}{me ? ' · You' : ''}</div></div>
              {me && <span className="nav-ico" style={{ color: 'var(--accent)' }}><I.check size={15} /></span>}
            </button>
          );
        })}
      </aside>

      {/* ---- main ---- */}
      <div className="main">
        <header className="topbar">
          <span className="topbar-title">{titleMap[route]}</span>
          {route === 'detail' && <span className="topbar-crumb">· {selectedTask?.id}</span>}
          <span className="grow" />
          {canEdit
            ? <button className="btn btn-primary btn-sm" onClick={() => setComposer(true)}><I.spark size={14} /> New task</button>
            : <span className="chip" title="Founder has read-only access">Read-only view</span>}
          <button className="icon-btn" onClick={() => setTweak('dark', !tweaks.dark)} title="Toggle theme">
            {tweaks.dark ? <I.sun size={18} /> : <I.moon size={18} />}
          </button>
          <button className="icon-btn" title="Notifications"><I.bell size={18} /></button>
          <window.Avatar user={currentUser} size={32} />
        </header>

        {route === 'dashboard' && (
          <div className="scroll-area">
            <window.Dashboard tasks={tasks} onOpen={openTask} onCompose={() => setComposer(true)} onAsk={goAsk} onNav={setRoute} density={tweaks.density} canEdit={canEdit} currentUser={currentUser} />
          </div>
        )}
        {route === 'tasks' && (
          <window.TasksScreen tasks={tasks} deliverables={deliverables} view={taskView} setView={setTaskView} onOpen={openTask}
            onCompose={() => setComposer(true)} onMove={moveTask} onToggleDone={toggleDone} canEdit={canEdit} />
        )}
        {route === 'deliverables' && (
          <window.DeliverablesScreen deliverables={deliverables} tasks={tasks} canEdit={canEdit}
            onOpen={openDeliverable} onCreate={createDeliverable} />
        )}
        {route === 'dlvDetail' && (
          <window.DeliverableDetail deliverable={selectedDeliverable} deliverables={deliverables} tasks={tasks} canEdit={canEdit}
            onBack={() => { setRoute('deliverables'); setDlvSelected(null); }} onOpenTask={openTask}
            onEdit={editDeliverable} onDelete={deleteDeliverable} onAssign={assignDeliverable} />
        )}
        {route === 'detail' && (
          <window.TaskDetail task={selectedTask} deliverables={deliverables} onClose={() => { setRoute('tasks'); setSelected(null); }}
            onAddComment={addComment} onToggleDone={toggleDone} onLogProgress={logProgress} onEditTask={editTask} onRevertEdit={revertEdit}
            onAssignDeliverable={assignDeliverable} onOpenDeliverable={openDeliverable} onUpdate={() => {}} canEdit={canEdit} currentUser={currentUser} />
        )}
        {route === 'summary' && <window.WeeklySummary tasks={tasks} onOpen={openTask} />}
        {route === 'ask' && <window.AskAI tasks={tasks} initialQuestion={askQ} clearInitial={() => setAskQ(null)} />}
        {route === 'settings' && <Settings tweaks={tweaks} setTweak={setTweak} onLoadDemo={loadDemo} onClearAll={clearAll} taskCount={tasks.length} />}
      </div>

      {composer && <window.AIComposer onClose={() => setComposer(false)} onCreate={createTask} onCreateMany={createTasks} />}

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
function Settings({ tweaks, setTweak, onLoadDemo, onClearAll, taskCount = 0 }) {
  const I = window.I;
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

        <div className="card card-pad mb16">
          <div className="section-eyebrow mb12">Team & roles</div>
          {[['richard','Founder — full visibility, dashboards, Ask AI'],['vihan','Product Manager — create, update & complete tasks'],['isuru','Eng Lead — referenced in dependencies']].map(([id, desc]) => (
            <div key={id} className="row gap10 center" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <window.Avatar user={id} size={32} />
              <div className="grow"><div style={{ fontWeight: 600, fontSize: 13.5 }}>{window.USERS[id].name}</div><div className="muted" style={{ fontSize: 12 }}>{desc}</div></div>
              <span className="chip">{window.USERS[id].role}</span>
            </div>
          ))}
        </div>

        <div className="card card-pad">
          <div className="section-eyebrow mb12">Data · {taskCount} task{taskCount === 1 ? '' : 's'}</div>
          <div className="row between center" style={{ paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
            <div><div style={{ fontWeight: 600, fontSize: 13.5 }}>Load demo data</div><div className="muted" style={{ fontSize: 12 }}>Replace current tasks with the sample FM Navigate set.</div></div>
            <button className="btn btn-ghost" onClick={onLoadDemo}><I.refresh size={14} /> Load demo</button>
          </div>
          <div className="row between center" style={{ paddingTop: 12 }}>
            <div><div style={{ fontWeight: 600, fontSize: 13.5 }}>Clear all tasks</div><div className="muted" style={{ fontSize: 12 }}>Wipe everything and start from a blank slate.</div></div>
            <button className="btn btn-ghost" onClick={onClearAll} style={{ color: 'var(--st-blocked)', borderColor: 'var(--st-blocked)' }}><I.x size={14} /> Clear all</button>
          </div>
        </div>
      </div>
    </div>
  );
}

window.App = App;
window.ACCENTS = ACCENTS;
