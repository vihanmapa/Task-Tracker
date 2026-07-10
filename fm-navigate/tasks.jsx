/* ============================================================
   FM Navigate — Tasks (List + Kanban) + Task Detail
   ============================================================ */
const { useState: useStateT, useMemo: useMemoT, useRef: useRefT, useEffect: useEffectT } = React;

/* ---------------- Tasks screen ---------------- */
// Persisted toolbar prefs — last filters/group/showCompleted survive reloads (#7).
const TPREF_KEY = 'fm_tasks_prefs';
const loadTPrefs = () => { try { return JSON.parse(localStorage.getItem(TPREF_KEY)) || {}; } catch (_) { return {}; } };
const saveTPrefs = (p) => { try { localStorage.setItem(TPREF_KEY, JSON.stringify(p)); } catch (_) {} };

// Column registry — daily columns always visible (task), the rest toggled in View Settings.
// Each: { label, w (grid track), sort? (SORT_KEYS key), cell(t, ctx) }.
const _fmtD = (iso) => iso ? window.fmtDate(iso) : '—';
const _ell = (s, n = 60) => <span className="trow-sub ell" title={s || ''}>{s || '—'}</span>;
// Each column: { label, w, group, sort?, locked?, cell(t, ctx) }.
// locked columns can't be hidden — every layout stays usable.
const TASK_COLUMNS = {
  status:      { label: 'Status', w: '130px', group: 'Core', sort: 'status', locked: true, cell: (t) => <window.StatusPill status={t.status} /> },
  priority:    { label: 'Priority', w: '90px', group: 'Core', sort: 'priority', locked: true, cell: (t) => <window.PriorityTag priority={t.priority} /> },
  due:         { label: 'Due', w: '120px', group: 'Core', sort: 'due', locked: true, cell: (t) => <window.DueTag iso={t.dueDate} status={t.status} /> },
  owner:       { label: 'Owner', w: '70px', group: 'Core', sort: 'owner', cell: (t) => <window.Avatar user={t.ownerId} size={24} /> },
  deliverable: { label: 'Deliverable', w: '220px', group: 'Project', cell: (t, ctx) => {
                   const d = ctx.dlvById[t.deliverableId];
                   return _ell(d ? d.title : '—'); } },
  category:    { label: 'Category', w: '120px', group: 'Project', sort: 'category', cell: (t) => <window.CatChip category={t.category} /> },
  progress:    { label: 'Progress', w: '120px', group: 'Project', sort: 'progress', cell: (t) => (
                   <div className="row gap8 center" style={{ maxWidth: 120 }}>
                     <div className="grow"><window.Progress value={t.progress || 0} height={4} /></div>
                     <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', flexShrink: 0 }}>{t.progress || 0}%</span>
                   </div>) },
  created:     { label: 'Created', w: '100px', group: 'Dates', sort: 'created', cell: (t) => <span className="trow-sub mono">{_fmtD(t.createdAt)}</span> },
  modified:    { label: 'Modified', w: '100px', group: 'Dates', sort: 'updated', cell: (t) => <span className="trow-sub mono">{_fmtD(t.updatedAt || t.createdAt)}</span> },
  completed:   { label: 'Completed', w: '100px', group: 'Dates', cell: (t) => <span className="trow-sub mono">{_fmtD(t.completedAt)}</span> },
  risk:        { label: 'Risk', w: '170px', group: 'Planning', cell: (t) => _ell(t.risk) },
  effort:      { label: 'Effort', w: '72px', group: 'Planning', cell: (t) => <span className="trow-sub">{t.effort || '—'}</span> },
  deps:        { label: 'Dependencies', w: '90px', group: 'Planning', cell: (t) => {
                   const n = (t.dependencies || []).length + (t.depTaskIds || []).length;
                   return <span className="trow-sub mono">{n || '—'}</span>; } },
  success:     { label: 'Success criteria', w: '190px', group: 'Planning', cell: (t) => _ell(t.successCriteria) },
};
const ALL_COLS = Object.keys(TASK_COLUMNS);
const COL_GROUPS = ['Core', 'Project', 'Dates', 'Planning'];
const LOCKED_COLS = ALL_COLS.filter(k => TASK_COLUMNS[k].locked);
// Lean default: Task + Status/Priority/Due (locked) + Deliverable. Created/Modified/etc. opt-in.
const DEFAULT_COLS = ['status', 'priority', 'due', 'deliverable'];
// Ensure locked columns always present and lead the order.
const withLocked = (arr) => {
  const kept = arr.filter(k => ALL_COLS.includes(k));
  const lead = LOCKED_COLS.filter(k => !kept.includes(k));
  return [...lead, ...kept].filter((k, i, a) => a.indexOf(k) === i);
};
const SORT_LABELS = { priority: 'Priority', due: 'Due date', created: 'Created date', updated: 'Last modified', title: 'Task name', progress: 'Progress', status: 'Status', category: 'Category', owner: 'Owner' };

/* ---------------- Summary bar (instant health check) ---------------- */
function SummaryBar({ tasks, onPick, activeStatus }) {
  const stats = useMemoT(() => {
    let active = 0, overdue = 0, today = 0, blocked = 0, waiting = 0, completed = 0;
    tasks.forEach(t => {
      const done = t.status === 'Completed', cx = t.status === 'Cancelled';
      if (done) { completed++; return; }
      if (cx) return;
      active++;
      if (t.status === 'Blocked') blocked++;
      if (t.status === 'Waiting') waiting++;
      if (t.dueDate) { const d = window.daysBetween(new Date(), t.dueDate); if (d < 0) overdue++; else if (d === 0) today++; }
    });
    return { active, overdue, today, blocked, waiting, completed };
  }, [tasks]);

  // status chips filter the list; overdue/today are read-only health signals.
  const Chip = ({ label, n, tone, status, info }) => (
    <button className={`sum-chip ${tone || ''} ${status && activeStatus === status ? 'on' : ''}`}
      onClick={info ? undefined : () => onPick(status || null)}
      style={info ? { cursor: 'default' } : null}
      title={info ? `${n} ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}>
      <b>{n}</b> {label}
    </button>
  );

  if (!tasks.length) return null;
  return (
    <div className="sum-bar">
      <Chip label="Active" n={stats.active} status={null} />
      <Chip label="Overdue" n={stats.overdue} tone={stats.overdue ? 'neg' : ''} info />
      <Chip label="Due today" n={stats.today} tone={stats.today ? 'warn' : ''} info />
      <Chip label="Blocked" n={stats.blocked} tone={stats.blocked ? 'neg' : ''} status="Blocked" />
      <Chip label="Waiting" n={stats.waiting} tone={stats.waiting ? 'warn' : ''} status="Waiting" />
      <Chip label="Completed" n={stats.completed} status="Completed" />
    </div>
  );
}

function TasksScreen({ tasks, deliverables = [], view, setView, onOpen, onOpenDeliverable, onCompose, onMove, onToggleDone, canEdit = true }) {
  const I = window.I;
  const P0 = loadTPrefs();
  const rememberF = P0.rememberFilters !== false;
  const rememberS = P0.rememberSorting !== false;
  const [q, setQ] = useStateT('');
  // Filters restored only when "remember filters" was on.
  const [fStatus, setFStatus] = useStateT(rememberF && P0.fStatus || 'All');
  const [fPrio, setFPrio]     = useStateT(rememberF && P0.fPrio || 'All');
  const [fCat, setFCat]       = useStateT(rememberF && P0.fCat || 'All');
  const [fDlv, setFDlv]       = useStateT(rememberF && P0.fDlv || 'All');
  const [fOwner, setFOwner]   = useStateT(rememberF && P0.fOwner || 'All');
  const [groupBy, setGroupBy] = useStateT(P0.groupBy || 'none');
  const [showDone, setShowDone] = useStateT(P0.showDone || false);
  // Sorting (lifted from ListView so View Settings can set the default).
  const [sortKey, setSortKey] = useStateT(rememberS && P0.sortKey || 'priority');
  const [sortDir, setSortDir] = useStateT(rememberS && P0.sortDir || 'asc');
  // Columns: ordered list of visible keys (drag-reorderable). Locked cols always present.
  const [cols, setCols] = useStateT(() => {
    const stored = Array.isArray(P0.cols) ? P0.cols.filter(k => ALL_COLS.includes(k)) : null;
    return withLocked(stored && stored.length ? stored : DEFAULT_COLS.slice());
  });
  const [rememberFilters, setRememberFilters] = useStateT(rememberF);
  const [rememberSorting, setRememberSorting] = useStateT(rememberS);
  const [showSettings, setShowSettings] = useStateT(false);
  const [showFilters, setShowFilters] = useStateT(false);

  // Persist. Filters/sorting honoured only when their remember toggle is on.
  useMemoT(() => {
    saveTPrefs({
      groupBy, showDone, cols, rememberFilters, rememberSorting,
      ...(rememberFilters ? { fStatus, fPrio, fCat, fDlv, fOwner } : {}),
      ...(rememberSorting ? { sortKey, sortDir } : {}),
    });
  }, [fStatus, fPrio, fCat, fDlv, fOwner, groupBy, showDone, sortKey, sortDir, cols, rememberFilters, rememberSorting]);

  const setSort = (key) => {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(SORT_KEYS[key][1]); }
  };

  const filtered = useMemoT(() => {
    return tasks.filter(t => {
      if (q && !(`${t.title} ${t.description} ${t.category}`.toLowerCase().includes(q.toLowerCase()))) return false;
      if (fStatus !== 'All' && t.status !== fStatus) return false;
      if (fPrio !== 'All' && t.priority !== fPrio) return false;
      if (fCat !== 'All' && t.category !== fCat) return false;
      if (fDlv !== 'All' && (t.deliverableId || '_none') !== fDlv) return false;
      if (fOwner !== 'All' && t.ownerId !== fOwner) return false;
      // Hide completed by default unless explicitly shown or the status filter targets them.
      if (!showDone && fStatus === 'All' && t.status === 'Completed') return false;
      return true;
    });
  }, [tasks, q, fStatus, fPrio, fCat, fDlv, fOwner, showDone]);

  const activeFilters = [fStatus, fPrio, fDlv, fCat, fOwner].filter(v => v !== 'All').length;
  const clearFilters = () => { setFStatus('All'); setFPrio('All'); setFDlv('All'); setFCat('All'); setFOwner('All'); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="toolbar">
        <div className="seg">
          <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><I.list size={14} /> List</button>
          <button className={view === 'kanban' ? 'active' : ''} onClick={() => setView('kanban')}><I.board size={14} /> Board</button>
        </div>
        <div className="search" style={{ width: 220 }}>
          <I.search size={15} />
          <input placeholder="Search tasks…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        {/* Filters — consolidated into one popover */}
        <div className="pop-anchor">
          <button className={`btn btn-sm ${activeFilters > 0 ? 'btn-primary' : ''}`} onClick={() => setShowFilters(s => !s)} title="Filter tasks">
            <I.filter size={14} /> Filter{activeFilters > 0 && <span className="kcol-count mono" style={{ marginLeft: 4 }}>{activeFilters}</span>}
          </button>
          {showFilters && (
            <FilterPopover
              deliverables={deliverables}
              fStatus={fStatus} setFStatus={setFStatus} fPrio={fPrio} setFPrio={setFPrio}
              fDlv={fDlv} setFDlv={setFDlv} fCat={fCat} setFCat={setFCat} fOwner={fOwner} setFOwner={setFOwner}
              activeFilters={activeFilters} onClear={clearFilters} onClose={() => setShowFilters(false)} />
          )}
        </div>
        {/* Sort (operational control — stays in toolbar) */}
        {view === 'list' && (
          <div className="row gap4 center">
            <select className="select" style={{ width: 'auto' }} value={sortKey}
              onChange={e => { setSortKey(e.target.value); setSortDir(SORT_KEYS[e.target.value][1]); }} title="Sort by">
              {['priority', 'due', 'created', 'updated', 'title', 'progress'].map(k => <option key={k} value={k}>Sort: {SORT_LABELS[k]}</option>)}
            </select>
            <button className="btn btn-sm" onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}
              title={sortDir === 'asc' ? 'Ascending' : 'Descending'} style={{ padding: '0 8px' }}>
              <I.arrowUp size={14} style={{ transform: sortDir === 'asc' ? 'none' : 'rotate(180deg)', transition: 'transform .12s' }} />
            </button>
          </div>
        )}
        {/* Group */}
        {view === 'list' && (
          <select className="select" style={{ width: 'auto' }} value={groupBy} onChange={e => setGroupBy(e.target.value)} title="Group tasks">
            <option value="none">No grouping</option>
            <option value="deliverable">Group: Deliverable</option>
            <option value="status">Group: Status</option>
            <option value="category">Group: Category</option>
          </select>
        )}
        <span className="grow" />
        <span className="muted mono" style={{ fontSize: 12 }}>
          {activeFilters > 0 || q ? `${filtered.length} of ${tasks.length} tasks` : `${filtered.length} tasks`}
        </span>
        {view === 'list' && (
          <button className="btn btn-sm" onClick={() => setShowSettings(true)} title="Columns, sorting & display">
            <I.settings size={15} /> Columns
          </button>
        )}
        {canEdit && <button className="btn btn-primary btn-sm" onClick={onCompose}><I.spark size={14} /> New task</button>}
      </div>

      <SummaryBar tasks={tasks} onPick={(s) => { clearFilters(); if (s) setFStatus(s); }} activeStatus={fStatus} />

      {showSettings && (
        <ViewSettings
          cols={cols} setCols={setCols}
          groupBy={groupBy} setGroupBy={setGroupBy}
          showDone={showDone} setShowDone={setShowDone}
          sortKey={sortKey} setSortKey={setSortKey} sortDir={sortDir} setSortDir={setSortDir}
          rememberFilters={rememberFilters} setRememberFilters={setRememberFilters}
          rememberSorting={rememberSorting} setRememberSorting={setRememberSorting}
          onClose={() => setShowSettings(false)} />
      )}

      {tasks.length === 0
        ? (
          <div className="scroll-area fade-in">
            <div className="empty" style={{ padding: '72px 20px' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>No tasks yet</div>
              <div style={{ marginBottom: 18 }}>Start from a blank slate — describe the work and the assistant structures it for you.</div>
              {canEdit
                ? <button className="btn btn-primary" onClick={onCompose} style={{ display: 'inline-flex' }}><I.spark size={15} /> Create your first task</button>
                : <div className="muted" style={{ fontSize: 12.5 }}>Sign in as the editor (Vihan) to add tasks. Or load the demo set from Settings → Data.</div>}
            </div>
          </div>
        )
        : view === 'list'
          ? <ListView tasks={filtered} deliverables={deliverables} groupBy={groupBy} cols={cols}
              sortKey={sortKey} sortDir={sortDir} onSort={setSort}
              onOpen={onOpen} onOpenDeliverable={onOpenDeliverable} onToggleDone={onToggleDone} canEdit={canEdit} />
          : <KanbanView tasks={filtered} onOpen={onOpen} onMove={onMove} canEdit={canEdit} />}
    </div>
  );
}

/* ---------------- Filter popover ---------------- */
function FilterPopover({ deliverables, fStatus, setFStatus, fPrio, setFPrio, fDlv, setFDlv, fCat, setFCat, fOwner, setFOwner, activeFilters, onClear, onClose }) {
  // Close on outside click / Escape.
  useEffectT(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    const onDoc = (e) => { if (!e.target.closest('.pop-anchor')) onClose(); };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDoc);
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDoc); };
  }, [onClose]);

  const Field = ({ label, children }) => (
    <label className="col gap4" style={{ marginBottom: 12 }}>
      <span className="field-label">{label}</span>{children}
    </label>
  );

  return (
    <div className="popover" style={{ width: 250 }}>
      <Field label="Status">
        <select className="select" value={fStatus} onChange={e => setFStatus(e.target.value)}>
          <option>All</option>{window.STATUSES.map(s => <option key={s}>{s}</option>)}
        </select>
      </Field>
      <Field label="Priority">
        <select className="select" value={fPrio} onChange={e => setFPrio(e.target.value)}>
          <option value="All">All priorities</option>{window.PRIORITIES.map(p => <option key={p}>{p}</option>)}
        </select>
      </Field>
      <div className="vs-divider" />
      <Field label="Deliverable">
        <select className="select" value={fDlv} onChange={e => setFDlv(e.target.value)}>
          <option value="All">All deliverables</option>
          {deliverables.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
          <option value="_none">Unassigned</option>
        </select>
      </Field>
      <Field label="Category">
        <select className="select" value={fCat} onChange={e => setFCat(e.target.value)}>
          <option value="All">All categories</option>{window.CATEGORIES.map(c => <option key={c}>{c}</option>)}
        </select>
      </Field>
      <Field label="Owner">
        <select className="select" value={fOwner} onChange={e => setFOwner(e.target.value)}>
          <option value="All">All owners</option>{Object.values(window.USERS).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </Field>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
        <button className="btn btn-sm" onClick={onClear} disabled={activeFilters === 0}>Clear all</button>
        <button className="btn btn-primary btn-sm" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/* ---------------- View Settings panel ---------------- */
function ViewSettings({ cols, setCols, groupBy, setGroupBy, showDone, setShowDone,
  sortKey, setSortKey, sortDir, setSortDir, rememberFilters, setRememberFilters, rememberSorting, setRememberSorting, onClose }) {
  const I = window.I;
  const [dragKey, setDragKey] = useStateT(null);

  const toggle = (k) => {
    if (TASK_COLUMNS[k].locked) return; // locked columns can't be hidden
    setCols(cs => cs.includes(k) ? cs.filter(x => x !== k) : withLocked([...cs, k]));
  };
  const onDrop = (targetKey) => {
    if (!dragKey || dragKey === targetKey) { setDragKey(null); return; }
    setCols(cs => {
      const next = cs.filter(k => k !== dragKey);
      const at = next.indexOf(targetKey);
      next.splice(at, 0, dragKey);
      return withLocked(next);
    });
    setDragKey(null);
  };

  const Section = ({ title, children }) => (
    <div style={{ marginBottom: 20 }}>
      <div className="field-label" style={{ marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );

  // One row per column; visible rows are draggable for reorder.
  const ColRow = (k) => {
    const c = TASK_COLUMNS[k];
    const on = cols.includes(k);
    return (
      <div key={k} className="vs-col-row" draggable={on}
        onDragStart={on ? () => setDragKey(k) : undefined}
        onDragOver={e => e.preventDefault()}
        onDrop={() => onDrop(k)}
        style={{ opacity: dragKey === k ? 0.4 : on ? 1 : 0.6 }}>
        {on ? <I.drag size={14} style={{ cursor: 'grab', color: 'var(--text-faint)' }} /> : <span style={{ width: 14 }} />}
        <input type="checkbox" checked={on} disabled={c.locked} onChange={() => toggle(k)} />
        <span style={{ flex: 1 }}>{c.label}</span>
        {c.locked && <span className="muted" style={{ fontSize: 10.5 }}>always</span>}
      </div>
    );
  };

  return (
    <window.Modal onClose={onClose} width={460}>
      <div className="modal-head row center" style={{ justifyContent: 'space-between' }}>
        <b>View settings</b>
        <button className="icon-btn" onClick={onClose}><I.x size={16} /></button>
      </div>
      <div className="modal-body" style={{ maxHeight: '70vh', overflow: 'auto' }}>
        <Section title="Columns — drag to reorder, toggle to show/hide">
          {COL_GROUPS.map(g => {
            const keys = ALL_COLS.filter(k => TASK_COLUMNS[k].group === g);
            return (
              <div key={g} style={{ marginBottom: 10 }}>
                <div className="vs-group-label">{g}</div>
                <div className="col gap4">{keys.map(ColRow)}</div>
              </div>
            );
          })}
          <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>Task, Status, Priority and Due stay visible in every layout.</div>
        </Section>

        <Section title="Default sorting">
          <div className="row gap8 center">
            <select className="select" value={sortKey} onChange={e => { setSortKey(e.target.value); setSortDir(SORT_KEYS[e.target.value][1]); }}>
              {['priority', 'due', 'created', 'updated', 'title', 'progress'].map(k => <option key={k} value={k}>{SORT_LABELS[k]}</option>)}
            </select>
            <select className="select" value={sortDir} onChange={e => setSortDir(e.target.value)}>
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </div>
        </Section>

        <Section title="Default grouping">
          <select className="select" value={groupBy} onChange={e => setGroupBy(e.target.value)} style={{ width: '100%' }}>
            <option value="none">None</option>
            <option value="deliverable">Deliverable</option>
            <option value="status">Status</option>
            <option value="category">Category</option>
          </select>
        </Section>

        <Section title="Display">
          <label className="vs-check"><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} /> Show completed tasks</label>
          <label className="vs-check"><input type="checkbox" checked={rememberFilters} onChange={e => setRememberFilters(e.target.checked)} /> Remember my filters</label>
          <label className="vs-check"><input type="checkbox" checked={rememberSorting} onChange={e => setRememberSorting(e.target.checked)} /> Remember my sorting</label>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>Row density lives in Settings → Appearance.</div>
        </Section>
      </div>
      <div className="modal-foot row" style={{ justifyContent: 'space-between' }}>
        <button className="btn btn-sm" onClick={() => { setCols(withLocked(DEFAULT_COLS.slice())); setGroupBy('none'); setSortKey('priority'); setSortDir('asc'); }}>Restore recommended layout</button>
        <button className="btn btn-primary btn-sm" onClick={onClose}>Done</button>
      </div>
    </window.Modal>
  );
}

/* ---------------- List view ---------------- */
const PRIO_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const STATUS_ORDER = { 'Not Started': 0, 'In Progress': 1, 'Waiting': 2, 'Blocked': 3, 'MD Review': 4, 'Completed': 5, 'Cancelled': 6 };
const SORT_KEYS = {
  // key: [comparator(a,b), defaultDir]
  title:    [(a, b) => a.title.localeCompare(b.title), 'asc'],
  status:   [(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status], 'asc'],
  priority: [(a, b) => (PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority]) || (new Date(a.dueDate || 8.64e15) - new Date(b.dueDate || 8.64e15)), 'asc'],
  due:      [(a, b) => new Date(a.dueDate || 8.64e15) - new Date(b.dueDate || 8.64e15), 'asc'],
  created:  [(a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0), 'desc'],
  updated:  [(a, b) => new Date(a.updatedAt || a.createdAt || 0) - new Date(b.updatedAt || b.createdAt || 0), 'desc'],
  category: [(a, b) => a.category.localeCompare(b.category), 'asc'],
  owner:    [(a, b) => ((window.USERS[a.ownerId]?.name || '').localeCompare(window.USERS[b.ownerId]?.name || '')), 'asc'],
  progress: [(a, b) => (a.progress || 0) - (b.progress || 0), 'desc'],
};

function ListView({ tasks, deliverables = [], groupBy = 'none', cols = DEFAULT_COLS,
  sortKey = 'priority', sortDir = 'asc', onSort, onOpen, onOpenDeliverable, onToggleDone, canEdit = true }) {
  const grouped = groupBy !== 'none';
  const I = window.I;

  // Only render registered columns; build the grid track string (checkbox + task + visible cols).
  const visCols = cols.filter(k => TASK_COLUMNS[k]);
  const dlvById = useMemoT(() => { const m = {}; deliverables.forEach(d => { m[d.id] = d; }); return m; }, [deliverables]);
  const ctx = { dlvById };
  const gridCols = `26px minmax(0,1fr) ${visCols.map(k => TASK_COLUMNS[k].w).join(' ')}`;
  // Floor the flexible task column: when fixed columns exceed the viewport the row
  // gets a min-width so the list scrolls horizontally instead of collapsing Task to 0.
  const TASK_MIN = 240, GAP = 14, PADX = 28;
  const fixedSum = visCols.reduce((s, k) => s + parseInt(TASK_COLUMNS[k].w, 10), 0);
  const trackCount = 2 + visCols.length;
  const rowMinW = PADX * 2 + 26 + TASK_MIN + fixedSum + GAP * (trackCount - 1);
  const gridStyle = { gridTemplateColumns: gridCols, minWidth: rowMinW };

  const sortTasks = (arr) => [...arr].sort((a, b) => {
    const cmp = SORT_KEYS[sortKey][0](a, b);
    return sortDir === 'asc' ? cmp : -cmp;
  });
  const sorted = sortTasks(tasks);

  const Th = ({ k, children, style }) => (
    <button className="tlist-th" onClick={() => onSort && onSort(k)} style={style}>
      {children}
      <span className="tlist-sort" style={{ opacity: sortKey === k ? 1 : 0.25 }}>
        <I.chevD size={12} style={{ transform: sortKey === k && sortDir === 'asc' ? 'rotate(180deg)' : 'none', transition: 'transform .12s' }} />
      </span>
    </button>
  );

  const Row = (t) => {
    const done = t.status === 'Completed';
    const cancelled = t.status === 'Cancelled';
    return (
      <div key={t.id} className="trow" onClick={() => onOpen(t.id)} style={gridStyle}>
        <button className={`check ${done ? 'done' : ''}`} disabled={!canEdit}
          style={canEdit ? null : { cursor: 'default', opacity: done ? 1 : 0.5 }}
          onClick={e => { e.stopPropagation(); if (canEdit) onToggleDone(t.id); }}
          title={canEdit ? 'Toggle complete' : 'Read-only — sign in as Vihan to edit'}>
          {done && <I.check size={13} />}
        </button>
        <div style={{ minWidth: 0 }}>
          <div className="trow-title" style={{ textDecoration: done || cancelled ? 'line-through' : 'none', color: done || cancelled ? 'var(--text-3)' : 'var(--text)' }}>
            {t.title}
          </div>
          <div className="trow-sub mono">{t.id} · {t.successCriteria || t.description.slice(0, 70)}</div>
          {t.progress > 0 && !done && !cancelled && !visCols.includes('progress') && (
            <div className="row gap8 center mt4" style={{ maxWidth: 220 }}>
              <div className="grow"><window.Progress value={t.progress} height={4} /></div>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', flexShrink: 0 }}>{t.progress}%</span>
            </div>
          )}
        </div>
        {visCols.map(k => <div key={k} style={{ minWidth: 0 }}>{TASK_COLUMNS[k].cell(t, ctx)}</div>)}
      </div>
    );
  };

  // Build grouped sections per groupBy mode. Each: { key, title, deliverable?, rows }.
  const groups = useMemoT(() => {
    if (!grouped) return null;
    const out = [];
    if (groupBy === 'deliverable') {
      const byId = {};
      tasks.forEach(t => { const k = t.deliverableId || '_none'; (byId[k] = byId[k] || []).push(t); });
      deliverables.forEach(d => { if (byId[d.id]) out.push({ key: d.id, title: d.title, deliverable: d, rows: sortTasks(byId[d.id]) }); });
      if (byId._none) out.push({ key: '_none', title: 'Unassigned', deliverable: null, rows: sortTasks(byId._none) });
    } else {
      const order = groupBy === 'status' ? window.STATUSES : window.CATEGORIES;
      const field = groupBy === 'status' ? 'status' : 'category';
      const byKey = {};
      tasks.forEach(t => { const k = t[field] || '—'; (byKey[k] = byKey[k] || []).push(t); });
      order.forEach(k => { if (byKey[k]) out.push({ key: k, title: k, deliverable: null, rows: sortTasks(byKey[k]) }); });
      Object.keys(byKey).forEach(k => { if (!order.includes(k)) out.push({ key: k, title: k, deliverable: null, rows: sortTasks(byKey[k]) }); });
    }
    return out;
  }, [grouped, groupBy, tasks, deliverables, sortKey, sortDir]);

  return (
    <div className="scroll-area scroll-x fade-in">
      <div className="tlist">
        <div className="tlist-head" style={gridStyle}>
          <span></span>
          <Th k="title">Task</Th>
          {visCols.map(k => {
            const c = TASK_COLUMNS[k];
            return c.sort
              ? <Th key={k} k={c.sort}>{c.label}</Th>
              : <span key={k} className="tlist-th" style={{ cursor: 'default' }}>{c.label}</span>;
          })}
        </div>
        {grouped
          ? groups.map(g => {
              const d = g.deliverable;
              return (
                <React.Fragment key={g.key}>
                  <div className="tlist-group"
                    onClick={() => d && onOpenDeliverable && onOpenDeliverable(d.id)}
                    style={{ cursor: d && onOpenDeliverable ? 'pointer' : 'default', minWidth: rowMinW }}>
                    {groupBy === 'deliverable'
                      ? <I.flag size={13} />
                      : groupBy === 'status'
                        ? <window.StatusPill status={g.title} />
                        : <I.list size={13} />}
                    {groupBy !== 'status' && <span className="tlist-group-title">{g.title}</span>}
                    <span className="muted" style={{ fontSize: 11.5, fontWeight: 600 }}>
                      {g.rows.length} {g.rows.length === 1 ? 'task' : 'tasks'}
                    </span>
                  </div>
                  {g.rows.map(Row)}
                </React.Fragment>
              );
            })
          : sorted.map(Row)}
        {((grouped ? groups.length : sorted.length) === 0) && <div className="empty">No tasks match your filters.</div>}
      </div>
    </div>
  );
}

/* ---------------- Kanban view (drag + drop) ---------------- */
function KanbanView({ tasks, onOpen, onMove, canEdit = true }) {
  const I = window.I;
  const [dragId, setDragId] = useStateT(null);
  const [overCol, setOverCol] = useStateT(null);

  const cols = window.KANBAN_COLS;
  const byCol = {};
  cols.forEach(c => byCol[c] = tasks.filter(t => t.status === c));

  const onDrop = (col) => {
    if (dragId) onMove(dragId, col);
    setDragId(null); setOverCol(null);
  };

  return (
    <div className="kanban fade-in">
      {cols.map(col => {
        const meta = window.STATUS_META[col];
        return (
          <div key={col}
            className={`kcol ${overCol === col ? 'drag-over' : ''}`}
            onDragOver={e => { e.preventDefault(); setOverCol(col); }}
            onDragLeave={e => { if (e.currentTarget === e.target) setOverCol(null); }}
            onDrop={() => onDrop(col)}>
            <div className="kcol-head">
              <span className="dot" style={{ background: meta.c }} />
              <span className="kcol-title">{col}</span>
              <span className="kcol-count mono">{byCol[col].length}</span>
            </div>
            <div className="kcol-body">
              {byCol[col].map(t => (
                <div key={t.id} className={`kcard ${dragId === t.id ? 'dragging' : ''}`}
                  draggable={canEdit}
                  style={canEdit ? null : { cursor: 'pointer' }}
                  onDragStart={() => canEdit && setDragId(t.id)}
                  onDragEnd={() => { setDragId(null); setOverCol(null); }}
                  onClick={() => onOpen(t.id)}>
                  <div className="row between" style={{ alignItems: 'flex-start', gap: 8 }}>
                    <div className="kcard-title grow">{t.title}</div>
                    <span style={{ width: 3, height: 30, borderRadius: 2, background: window.PRIO_META[t.priority].c, flexShrink: 0 }} />
                  </div>
                  <div className="kcard-meta">
                    <window.CatChip category={t.category} />
                  </div>
                  {t.progress > 0 && t.status !== 'Completed' && (
                    <div className="row gap8 center" style={{ marginTop: 10 }}>
                      <div className="grow"><window.Progress value={t.progress} height={4} /></div>
                      <span className="mono" style={{ fontSize: 10, color: 'var(--text-3)', flexShrink: 0 }}>{t.progress}%</span>
                    </div>
                  )}
                  {t.status === 'Blocked' && t.dependencies?.[0] && (
                    <div className="row gap6 center" style={{ marginTop: 9, fontSize: 11.5, color: 'var(--st-blocked)', fontWeight: 600 }}>
                      <I.block size={13} /> {t.dependencies[0]}
                    </div>
                  )}
                  <div className="kcard-foot">
                    <window.DueTag iso={t.dueDate} status={t.status} />
                    <window.Avatar user={t.ownerId} size={22} />
                  </div>
                </div>
              ))}
              {byCol[col].length === 0 && <div className="faint" style={{ fontSize: 12, textAlign: 'center', padding: '18px 0' }}>Drop tasks here</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- Progress log ----------------
   Log a % complete + a note + evidence (a link or an attached document).
   Attachments live in Supabase Storage (see [[fm-navigate-save-timeout-2026-07-01]]
   — inline base64 previously ballooned the workspace document to ~11MB and
   caused save timeouts). A file object is { name, type, path } once uploaded;
   `path` resolves to a fresh signed URL (1hr) at render time via useSignedUrl —
   never persist the URL itself, only the path. `data` (base64) is kept as a
   read fallback only, for any legacy entries not yet run through the one-time
   migration. */
const MAX_FILE_BYTES = 1.5 * 1024 * 1024; // 1.5MB — per-file cap before upload
const _signedUrlCache = {}; // path -> { url, expiresAt }

function useSignedUrl(path) {
  const [url, setUrl] = useStateT(() => {
    const c = path && _signedUrlCache[path];
    return (c && c.expiresAt > Date.now()) ? c.url : null;
  });
  useEffectT(() => {
    if (!path) { setUrl(null); return; }
    const cached = _signedUrlCache[path];
    if (cached && cached.expiresAt > Date.now()) { setUrl(cached.url); return; }
    let cancelled = false;
    window.dataService.getAttachmentUrl(path).then(r => {
      if (cancelled || !r.ok) return;
      _signedUrlCache[path] = { url: r.url, expiresAt: Date.now() + 55 * 60 * 1000 };
      setUrl(r.url);
    });
    return () => { cancelled = true; };
  }, [path]);
  return url;
}

// Resolves data (legacy inline base64) || a freshly-signed Storage URL. `size`
// renders an image thumbnail; omit it to render a download/file chip instead.
function AttachmentView({ f, size, onOpen }) {
  const I = window.I;
  const url = useSignedUrl(f.path);
  const src = f.data || url;
  const isImg = (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name || '');
  if (isImg) {
    if (!src) return <div style={{ width: size, height: size, borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--bg-sunken)' }} />;
    return <img src={src} alt={f.name} onClick={onOpen ? () => onOpen(src) : undefined}
      style={{ width: size, height: size, objectFit: 'cover', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', cursor: onOpen ? 'zoom-in' : 'default' }} />;
  }
  return src
    ? <a className="chip" href={src} download={f.name} target="_blank" rel="noopener noreferrer"><I.edit size={11} /> {f.name}</a>
    : <span className="chip"><I.edit size={11} /> {f.name}</span>;
}

function ProgressLog({ task, onLog, onEdit, onDelete, onCreateLinked, canEdit, currentUser, seed }) {
  const I = window.I;
  const log = [...(task.progressLog || [])].sort((a, b) => new Date(b.at) - new Date(a.at));
  const [open, setOpen] = useStateT(false);
  const [editingId, setEditingId] = useStateT(null); // null = logging new; else the entry id being edited
  const [status, setStatus] = useStateT(task.status);
  const [pct, setPct] = useStateT(task.progress || 0);
  const [note, setNote] = useStateT('');
  const [links, setLinks] = useStateT(['']);
  const [files, setFiles] = useStateT([]); // [{ name, data, type }]
  // checklist items delivered in this update. The dialog never lists the raw
  // checklist — completion happens on the checklist itself. clSel arrives
  // from a seed ("Create Progress Update" on an item) plus an optional
  // "also include" list of completed-but-unlinked items captured at open.
  const [clSel, setClSel] = useStateT([]); // delivered checklist item ids
  const [awaiting, setAwaiting] = useStateT([]); // completed, unreported items offered at open
  const [pendSel, setPendSel] = useStateT([]); // review-list ticks not yet promoted to clSel
  const [err, setErr] = useStateT('');
  const [preview, setPreview] = useStateT(null); // { src, name } — in-app lightbox
  const fileRef = useRefT(null);

  // local yyyy-mm-dd (no UTC day-shift); `date` lets the update be back-dated
  const dayStr = (iso) => { const d = iso ? new Date(iso) : new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const today = dayStr();
  const [date, setDate] = useStateT(today);

  const openForm = (seedIds) => {
    setEditingId(null); setStatus(task.status); setPct(task.progress || 0); setNote(''); setLinks(['']); setFiles([]); setDate(dayStr()); setErr('');
    const ids = Array.isArray(seedIds) ? seedIds : [];
    setClSel(ids);
    setPendSel([]);
    setAwaiting((task.checklist || []).filter(c => c.done && !c.completedInLogId && !ids.includes(c.id)));
    setOpen(true);
  };

  // "Create Progress Update" on a checklist item opens this form pre-seeded
  // with that item as Work delivered (the checklist lives below the log, so
  // scroll the form into view)
  const formRef = useRefT(null);
  useEffectT(() => {
    if (seed && seed.token) {
      openForm(seed.ids);
      setTimeout(() => formRef.current && formRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    }
  }, [seed && seed.token]);

  // open the same form pre-filled to edit an existing entry
  const openEditForm = (e) => {
    setEditingId(e.id);
    setStatus(e.status || task.status);
    setPct(e.percent || 0);
    setNote(e.note || '');
    const ls = (e.links && e.links.length ? e.links : (e.link ? [e.link] : []));
    setLinks(ls.length ? ls : ['']);
    const fs = (e.files && e.files.length ? e.files : (e.fileName ? [{ name: e.fileName, data: e.fileData, type: '' }] : []));
    setFiles(fs);
    // Work delivered is read-only when editing — linking/unlinking happens on
    // the checklist item itself. clSel carries the ids through unchanged so a
    // note/percent edit never disturbs the links.
    setClSel(e.checklistIds || []);
    setPendSel([]);
    setAwaiting([]);
    setDate(dayStr(e.at));
    setErr(''); setOpen(true);
  };

  const setLinkAt = (i, v) => setLinks(ls => ls.map((l, j) => j === i ? v : l));
  const addLink = () => setLinks(ls => [...ls, '']);
  const rmLink = (i) => setLinks(ls => ls.length === 1 ? [''] : ls.filter((_, j) => j !== i));

  // Uploads straight to Storage (no base64) — a placeholder shows immediately
  // via a local blob: URL while the upload is in flight, then swaps to the
  // real `path` once it settles. See useSignedUrl/AttachmentView above.
  const addFiles = (fileList) => {
    [...fileList].forEach((f, i) => {
      if (f.size > MAX_FILE_BYTES) { setErr(`"${f.name}" is too large (max ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(1)}MB). Use a link instead.`); return; }
      const name = f.name || 'pasted-image.png';
      const placeholder = { name, type: f.type || '', data: URL.createObjectURL(f), uploading: true };
      setFiles(fs => [...fs, placeholder]);
      const key = 'u' + Date.now() + Math.random().toString(36).slice(2, 7) + i;
      window.dataService.uploadAttachment(f, { taskId: task.id, entryId: key, index: i, name })
        .then(r => {
          try { URL.revokeObjectURL(placeholder.data); } catch (_) {}
          if (!r.ok) setErr(`"${name}" failed to upload${r.error ? ': ' + r.error : ''}.`);
          setFiles(fs => fs.map(x => x !== placeholder ? x
            : r.ok ? { name, type: f.type || '', path: r.path }
                   : { name, type: f.type || '', error: r.error || 'Upload failed' }));
        });
    });
    setErr('');
  };
  const rmFile = (i) => setFiles(fs => {
    const f = fs[i];
    if (f && f.uploading) { try { URL.revokeObjectURL(f.data); } catch (_) {} }
    return fs.filter((_, j) => j !== i);
  });
  // Cmd/Ctrl+V a screenshot anywhere in the form → attach it
  const onPaste = (e) => {
    const imgs = [...(e.clipboardData?.items || [])].filter(it => it.type.startsWith('image/')).map(it => it.getAsFile()).filter(Boolean);
    if (imgs.length) { e.preventDefault(); addFiles(imgs); }
  };

  // Completed forces 100%; a non-completed status can't sit at 100.
  const pctLocked = status === 'Completed';
  const effPct = pctLocked ? 100 : Math.min(pct, 99);

  const onStatusChange = (s) => {
    setStatus(s);
    if (s === 'Completed') setPct(100);
    else if (pct >= 100) setPct(95); // reopening from completed
  };

  const anyUploading = files.some(f => f.uploading);

  const submit = () => {
    if (anyUploading) { setErr('Still uploading — wait a moment and try again.'); return; }
    const cleanLinks = links.map(l => l.trim()).filter(Boolean);
    // only persist path-backed (or, for legacy entries being re-saved unchanged, data-backed) files —
    // never a transient blob: preview URL
    const cleanFiles = files.filter(f => f.path || f.data).map(f => f.path ? { name: f.name, type: f.type, path: f.path } : f);
    // fold still-staged review-list ticks into the delivery so a save without
    // "Include selected" never silently drops them
    const delivered = [...clSel, ...pendSel.filter(id => !clSel.includes(id))];
    if (!note.trim() && !cleanLinks.length && !cleanFiles.length && !delivered.length) { setErr('Add a note, a link, evidence, or a completed checklist item before saving.'); return; }
    // back-dated entries land at local noon; today keeps the precise current time
    const at = (date && date < today) ? new Date(date + 'T12:00:00').toISOString() : new Date().toISOString();
    const payload = { status, percent: effPct, note: note.trim(), links: cleanLinks, files: cleanFiles, checklistIds: delivered, at };
    if (editingId) onEdit(task.id, editingId, payload);
    else onLog(task.id, payload);
    setNote(''); setLinks(['']); setFiles([]); setErr(''); setOpen(false); setEditingId(null);
    if (fileRef.current) fileRef.current.value = '';
  };
  const isImg = (f) => (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name || '');

  return (
    <>
      <div className="section-eyebrow mt24 mb8" style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.trend size={13} /> Progress · {task.progress || 0}%</span>
        {canEdit && !open && (
          <span className="row gap8 center">
            {onCreateLinked && <button className="btn btn-ghost btn-sm" onClick={onCreateLinked} title="Create a follow-up task linked to this one"><I.link size={13} /> New linked task</button>}
            <button className="btn btn-ghost btn-sm" onClick={() => openForm()}><I.plus size={13} /> Log progress</button>
          </span>
        )}
      </div>

      <div className="mb12"><window.Progress value={task.progress || 0} height={8} /></div>

      {open && (
        <div ref={formRef} className="card card-pad mb12 fade-in" style={{ background: 'var(--bg-sunken)' }} onPaste={onPaste}>
          <div className="row between center mb8">
            <span className="field-label" style={{ margin: 0 }}>{editingId ? 'Edit update' : 'Update'} — {effPct}% complete</span>
            <button className="icon-btn" onClick={() => { setOpen(false); setErr(''); setEditingId(null); }}><I.x size={15} /></button>
          </div>
          <div className="row gap12" style={{ flexWrap: 'wrap' }}>
            <div className="field mb8" style={{ flex: 1, minWidth: 160 }}>
              <label className="field-label">Status</label>
              <select className="select" value={status} onChange={e => onStatusChange(e.target.value)}>
                {window.STATUSES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="field mb8" style={{ flex: 1, minWidth: 160 }}>
              <label className="field-label">Date {date < today && <span className="faint" style={{ fontWeight: 400, textTransform: 'none' }}>· back-dated</span>}</label>
              <input className="input" type="date" max={today} value={date} onChange={e => setDate(e.target.value || today)} />
            </div>
          </div>
          <label className="field-label" style={{ marginBottom: 4 }}>% complete {pctLocked && <span className="faint" style={{ fontWeight: 400, textTransform: 'none' }}>· locked at 100% while Completed</span>}</label>
          <input type="range" min="0" max="100" step="5" value={effPct} disabled={pctLocked}
            onChange={e => setPct(+e.target.value)} style={{ width: '100%', accentColor: 'var(--accent)', opacity: pctLocked ? 0.5 : 1 }} />
          <textarea className="ai-textarea" style={{ minHeight: 64, marginTop: 10, fontSize: 13.5 }} placeholder="What progressed? (note)" value={note} onChange={e => setNote(e.target.value)} />
          {/* Work delivered — read-only; items arrive from the checklist
              ("Create Progress Update" / "Link Existing"), never picked here */}
          {clSel.length > 0 && (
            <div className="field mt8">
              <label className="field-label"><I.check size={12} /> Work delivered</label>
              {clSel.map(cid => {
                const c = (task.checklist || []).find(x => x.id === cid);
                if (!c) return null;
                return (
                  <div key={cid} className="row gap8 center" style={{ padding: '2px 0', fontSize: 13.5 }}>
                    <span style={{ color: 'var(--st-completed)', fontWeight: 700 }}>✓</span>
                    <span>{c.title}</span>
                    {!editingId && <button className="icon-btn" style={{ width: 18, height: 18 }} title="Remove from this update" onClick={() => { setClSel(sel => sel.filter(x => x !== cid)); setAwaiting(a => a.some(x => x.id === cid) ? a : [...a, c]); }}><I.x size={11} /></button>}
                  </div>
                );
              })}
              {editingId && <span className="faint" style={{ fontSize: 11 }}>Manage links from the checklist item itself.</span>}
            </div>
          )}
          {/* review list: completed-but-unreported work can be swept into this
              update — never the raw (incomplete) checklist. Ticks are staged
              in pendSel; "Include selected" promotes them to Work delivered,
              and submit() folds in any still-staged ticks so nothing silently
              drops if the user saves without clicking the button. */}
          {!editingId && awaiting.filter(c => !clSel.includes(c.id)).length > 0 && (
            <div className="field mt8">
              <label className="field-label">Unreported completed work</label>
              <div className="faint" style={{ fontSize: 11.5, marginBottom: 4 }}>The following completed work has not yet been reported in a progress update.</div>
              {awaiting.filter(c => !clSel.includes(c.id)).map(c => {
                const on = pendSel.includes(c.id);
                return (
                  <label key={c.id} className="row gap8 center" style={{ padding: '3px 0', cursor: 'pointer', fontSize: 13.5 }}>
                    <input type="checkbox" checked={on} onChange={() => setPendSel(sel => on ? sel.filter(x => x !== c.id) : [...sel, c.id])} />
                    <span style={{ color: on ? 'var(--text)' : 'var(--text-2)' }}>{c.title}</span>
                  </label>
                );
              })}
              <button className="btn btn-subtle btn-sm mt4" disabled={!pendSel.length} onClick={() => { setClSel(sel => [...sel, ...pendSel.filter(id => !sel.includes(id))]); setPendSel([]); }} style={{ alignSelf: 'flex-start' }}>
                <I.check size={12} /> Include selected{pendSel.length ? ` (${pendSel.length})` : ''}
              </button>
            </div>
          )}
          <div className="field mt8">
            <label className="field-label"><I.link size={12} /> Evidence links (optional)</label>
            {links.map((l, i) => (
              <div key={i} className="row gap8 center" style={{ marginBottom: 6 }}>
                <input className="input" placeholder="https://…" value={l} onChange={e => setLinkAt(i, e.target.value)} />
                {(links.length > 1 || l) && <button className="icon-btn" onClick={() => rmLink(i)} title="Remove link" style={{ flexShrink: 0 }}><I.x size={15} /></button>}
              </div>
            ))}
            <button className="btn btn-subtle btn-sm" onClick={addLink} style={{ alignSelf: 'flex-start' }}><I.plus size={13} /> Add another link</button>
          </div>
          {/* attachment thumbnails / chips */}
          {files.length > 0 && (
            <div className="row gap8 mt8" style={{ flexWrap: 'wrap' }}>
              {files.map((f, i) => (
                isImg(f)
                  ? <div key={i} style={{ position: 'relative', opacity: f.uploading ? 0.5 : 1 }}>
                      <AttachmentView f={f} size={60} onOpen={src => setPreview({ src, name: f.name })} />
                      <button className="icon-btn" onClick={() => rmFile(i)} style={{ position: 'absolute', top: -7, right: -7, width: 20, height: 20, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 99 }}><I.x size={12} /></button>
                      {f.uploading && <span className="faint" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9 }}>Uploading…</span>}
                    </div>
                  : <span key={i} className="chip" style={{ opacity: f.uploading ? 0.5 : 1 }}><I.edit size={11} /> {f.name}{f.uploading ? ' · uploading…' : f.error ? ' · failed' : ''} <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => rmFile(i)}><I.x size={12} /></button></span>
              ))}
            </div>
          )}
          <div className="row between center mt8" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div className="row gap8 center" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}><I.plus size={13} /> Attach image / file</button>
              <input ref={fileRef} type="file" multiple accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.csv" style={{ display: 'none' }} onChange={e => { addFiles(e.target.files); if (fileRef.current) fileRef.current.value = ''; }} />
              <span className="faint" style={{ fontSize: 11 }}>or paste a screenshot (⌘V)</span>
            </div>
            <button className="btn btn-primary btn-sm" onClick={submit} disabled={anyUploading} title={anyUploading ? 'Waiting for uploads to finish' : undefined}><I.check size={13} /> {anyUploading ? 'Uploading…' : (editingId ? 'Save changes' : 'Save update')}</button>
          </div>
          {err && <div style={{ color: 'var(--st-blocked)', fontSize: 12, marginTop: 8 }}>{err}</div>}
        </div>
      )}

      {log.length === 0
        ? <div className="muted" style={{ fontSize: 13, padding: '4px 0 8px' }}>No progress logged yet.</div>
        : (
          <div className="mb8">
            {log.map(e => {
              const u = window.USERS[e.userId];
              return (
                <div key={e.id} id={'pl-' + e.id} className="comment" style={{ alignItems: 'flex-start' }}>
                  <window.Ring value={e.percent} size={34} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="comment-meta row gap8 center" style={{ flexWrap: 'wrap' }}><b style={{ color: 'var(--text)' }}>{e.percent}%</b>{e.status && <window.StatusPill status={e.status} />}<span>· {u?.name || 'Someone'} · {window.fmtRelTime(e.at)}{e.editedAt && ' · edited'}</span>
                      {canEdit && (
                        <span className="row gap8 center" style={{ marginLeft: 'auto' }}>
                          <button className="icon-btn" title="Edit update" onClick={() => openEditForm(e)}><I.edit size={14} /></button>
                          <button className="icon-btn" title="Delete update" onClick={() => onDelete(task.id, e.id)}><I.trash size={14} /></button>
                        </span>
                      )}
                    </div>
                    {e.note && <window.Markdown className="comment-body" text={e.note} />}
                    {(() => {
                      // checklist items delivered in this update — resolved by
                      // id at render time so renames stay current and deleted
                      // items drop out
                      const items = (e.checklistIds || []).map(cid => (task.checklist || []).find(c => c.id === cid)).filter(Boolean);
                      if (!items.length) return null;
                      return (
                        <div className="mt4">
                          <div className="faint" style={{ fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>Work delivered</div>
                          {items.map(c => (
                            <div key={c.id} style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                              <span style={{ color: 'var(--st-completed)', fontWeight: 700 }}>✓</span> <span className="muted">{c.title}</span>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                    {(() => {
                      // links: `links` (array) or legacy `link` (string)
                      const ls = (e.links && e.links.length ? e.links : (e.link ? [e.link] : []));
                      // files: `files` (array) or legacy single fileName/fileData
                      const fs = (e.files && e.files.length ? e.files : (e.fileName ? [{ name: e.fileName, data: e.fileData, type: '' }] : []));
                      if (!ls.length && !fs.length) return null;
                      const host = (u2) => { try { return new URL(u2).hostname.replace(/^www\./, ''); } catch (_) { return 'Link'; } };
                      const isImg = (f) => (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name || '');
                      return (
                        <div className="row gap8 center mt4" style={{ flexWrap: 'wrap' }}>
                          {ls.map((l, i) => <a key={'l' + i} className="chip" href={l} target="_blank" rel="noopener noreferrer"><I.link size={11} /> {host(l)}</a>)}
                          {fs.map((f, i) => isImg(f)
                            ? <div key={'f' + i} style={{ display: 'inline-block' }}><AttachmentView f={f} size={52} onOpen={src => setPreview({ src, name: f.name })} /></div>
                            : <AttachmentView key={'f' + i} f={f} />
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        )}

      {preview && (
        <div onClick={() => setPreview(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.78)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out', padding: 24 }}>
          <div className="row between center" style={{ width: '92vw', maxWidth: 1100, marginBottom: 10 }} onClick={e => e.stopPropagation()}>
            <span style={{ color: '#fff', fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview.name}</span>
            <div className="row gap8 center">
              <a className="btn btn-subtle btn-sm" href={preview.src} download={preview.name}><I.edit size={13} /> Download</a>
              <button className="btn btn-subtle btn-sm" onClick={() => setPreview(null)}><I.x size={14} /> Close</button>
            </div>
          </div>
          <img src={preview.src} alt={preview.name} onClick={e => e.stopPropagation()} style={{ maxWidth: '92vw', maxHeight: '82vh', objectFit: 'contain', borderRadius: 'var(--r-lg)', boxShadow: '0 20px 60px rgba(0,0,0,0.5)', background: 'var(--surface)' }} />
        </div>
      )}
    </>
  );
}

/* ---------------- Editable details panel ---------------- */
function TaskEditPanel({ task, allTasks = [], onSave, onCancel }) {
  const I = window.I;
  const [f, setF] = useStateT({
    title: task.title || '',
    description: task.description || '',
    successCriteria: task.successCriteria || '',
    dependencies: (task.dependencies || []).join('\n'),
    risk: task.risk || '',
    priority: task.priority || 'Medium',
    effort: task.effort || 'M',
    category: task.category || 'Technical',
  });
  const [depTaskIds, setDepTaskIds] = useStateT(task.depTaskIds || []);
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const Lbl = ({ children }) => <label className="field-label" style={{ marginBottom: 5, marginTop: 14, display: 'block' }}>{children}</label>;

  // tasks selectable as dependencies: everything except this task and ones already added
  const depOptions = allTasks.filter(t => t.id !== task.id && !depTaskIds.includes(t.id));
  const addDep = (id) => { if (id) setDepTaskIds(ids => ids.includes(id) ? ids : [...ids, id]); };
  const rmDep = (id) => setDepTaskIds(ids => ids.filter(x => x !== id));

  const save = () => {
    onSave({
      title: f.title.trim(),
      description: f.description.trim(),
      successCriteria: f.successCriteria.trim(),
      dependencies: f.dependencies.split('\n').map(s => s.trim()).filter(Boolean),
      depTaskIds,
      risk: f.risk.trim(),
      priority: f.priority,
      effort: f.effort,
      category: f.category,
    });
  };

  return (
    <div className="card card-pad mb16">
      <div className="row between center mb4">
        <div className="section-eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.edit size={13} /> Edit details</div>
      </div>
      <Lbl>Title</Lbl>
      <input className="input" value={f.title} onChange={e => set('title', e.target.value)} />
      <Lbl>Description</Lbl>
      <textarea className="ai-textarea" style={{ minHeight: 90, fontSize: 13.5 }} value={f.description} onChange={e => set('description', e.target.value)} />
      <Lbl>Success criteria</Lbl>
      <textarea className="ai-textarea" style={{ minHeight: 60, fontSize: 13.5 }} value={f.successCriteria} onChange={e => set('successCriteria', e.target.value)} />
      <Lbl>Dependency tasks <span className="faint" style={{ fontWeight: 400, textTransform: 'none' }}>· link other tasks</span></Lbl>
      {depTaskIds.length > 0 && (
        <div className="row gap8 mb8" style={{ flexWrap: 'wrap' }}>
          {depTaskIds.map(id => {
            const dt = allTasks.find(x => x.id === id);
            return (
              <span key={id} className="chip">
                <span style={{ width: 7, height: 7, borderRadius: 99, flexShrink: 0, background: dt ? ((window.STATUS_META[dt.status] || {}).c || 'var(--muted)') : 'var(--muted)' }} />
                <span style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dt ? dt.title : id}</span>
                <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => rmDep(id)} title="Remove"><I.x size={12} /></button>
              </span>
            );
          })}
        </div>
      )}
      <select className="input" value="" onChange={e => { addDep(e.target.value); e.target.value = ''; }} disabled={!depOptions.length}>
        <option value="">{depOptions.length ? '+ Add a dependency task…' : 'No other tasks to link'}</option>
        {depOptions.map(t => <option key={t.id} value={t.id}>{t.id} · {t.title}</option>)}
      </select>
      <Lbl>Dependencies <span className="faint" style={{ fontWeight: 400, textTransform: 'none' }}>· free text, one per line</span></Lbl>
      <textarea className="ai-textarea" style={{ minHeight: 70, fontSize: 13.5 }} value={f.dependencies} onChange={e => set('dependencies', e.target.value)} />
      <Lbl>Risk</Lbl>
      <textarea className="ai-textarea" style={{ minHeight: 60, fontSize: 13.5 }} value={f.risk} onChange={e => set('risk', e.target.value)} />
      <div className="row gap12" style={{ flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 140 }}>
          <Lbl>Priority</Lbl>
          <select className="input" value={f.priority} onChange={e => set('priority', e.target.value)}>
            {window.PRIORITIES.map(p => <option key={p}>{p}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <Lbl>Effort</Lbl>
          <select className="input" value={f.effort} onChange={e => set('effort', e.target.value)}>
            {Object.keys(window.EFFORT_LABEL).map(k => <option key={k} value={k}>{window.EFFORT_LABEL[k]}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <Lbl>Category</Lbl>
          <select className="input" value={f.category} onChange={e => set('category', e.target.value)}>
            {window.CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div className="row gap8 mt16">
        <button className="btn btn-primary btn-sm" onClick={save}><I.check size={13} /> Save changes</button>
        <button className="btn btn-subtle btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* ---------------- Task detail ---------------- */
// per-item links + file attachments (real Storage uploads, same bucket/flow as progress-log evidence)
function ChecklistItemAttachments({ task, item, canEdit, onAddLink, onDeleteLink, onAddFile, onDeleteFile }) {
  const I = window.I;
  const [linkDraft, setLinkDraft] = useStateT('');
  const [err, setErr] = useStateT('');
  const fileRef = useRefT(null);
  const links = item.links || [];
  const files = item.files || [];

  const submitLink = () => {
    if (!linkDraft.trim()) return;
    onAddLink(task.id, item.id, linkDraft);
    setLinkDraft('');
  };

  const addFiles = (fileList) => {
    [...fileList].forEach((f, i) => {
      if (f.size > MAX_FILE_BYTES) { setErr(`"${f.name}" is too large (max ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(1)}MB). Use a link instead.`); return; }
      const name = f.name || 'file';
      const key = 'u' + Date.now() + Math.random().toString(36).slice(2, 7) + i;
      window.dataService.uploadAttachment(f, { taskId: task.id, entryId: item.id + '-' + key, index: i, name })
        .then(r => {
          if (!r.ok) { setErr(`"${name}" failed to upload${r.error ? ': ' + r.error : ''}.`); return; }
          onAddFile(task.id, item.id, { name, type: f.type || '', path: r.path });
        });
    });
    setErr('');
  };

  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return 'Link'; } };
  const isImg = (f) => (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name || '');

  return (
    <div className="col gap8" style={{ padding: 0 }}>
      {(links.length > 0 || files.length > 0) && (
        <div className="row gap8" style={{ flexWrap: 'wrap' }}>
          {links.map((l, i) => (
            <span key={'l' + i} className="row gap4 center">
              <a className="chip" href={l} target="_blank" rel="noopener noreferrer"><I.link size={11} /> {host(l)}</a>
              {canEdit && <button className="icon-btn" style={{ width: 16, height: 16 }} onClick={() => onDeleteLink(task.id, item.id, i)}><I.x size={10} /></button>}
            </span>
          ))}
          {files.map((f, i) => (
            <span key={'f' + i} className="row gap4 center">
              <AttachmentView f={f} size={isImg(f) ? 44 : undefined} />
              {canEdit && <button className="icon-btn" style={{ width: 16, height: 16 }} onClick={() => onDeleteFile(task.id, item.id, i)}><I.x size={10} /></button>}
            </span>
          ))}
        </div>
      )}
      {canEdit && (
        <div className="row gap8 center" style={{ flexWrap: 'wrap' }}>
          <input className="input" placeholder="https://…" value={linkDraft} onChange={e => setLinkDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitLink(); }}
            style={{ flex: 1, minWidth: 140, fontSize: 12.5, padding: '4px 8px' }} />
          <button className="btn btn-subtle btn-sm" onClick={submitLink}><I.plus size={12} /> Add link</button>
          <button className="btn btn-subtle btn-sm" onClick={() => fileRef.current?.click()}><I.plus size={12} /> Attach file</button>
          <input ref={fileRef} type="file" multiple accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.csv" style={{ display: 'none' }}
            onChange={e => { addFiles(e.target.files); if (fileRef.current) fileRef.current.value = ''; }} />
        </div>
      )}
      {err && <div style={{ color: 'var(--st-blocked)', fontSize: 11.5 }}>{err}</div>}
    </div>
  );
}

/* Expanded checklist item — the item is where execution happens: notes,
   evidence, completion meta, and the link to the progress update that
   reported it. The progress-log dialog never shows the raw checklist. */
function ChecklistItemPanel({ task, item, canEdit, onSetNote, onAddLink, onDeleteLink, onAddFile, onDeleteFile, onCreateUpdate, onLinkToLog, onUnlink }) {
  const I = window.I;
  const [noteDraft, setNoteDraft] = useStateT(item.note || '');
  const [picking, setPicking] = useStateT(false); // "Link Existing" chooser open
  useEffectT(() => { setNoteDraft(item.note || ''); }, [item.id, item.note]);

  const linkedLog = item.completedInLogId && (task.progressLog || []).find(e => e.id === item.completedInLogId);
  const logs = [...(task.progressLog || [])].sort((a, b) => new Date(b.at) - new Date(a.at));
  const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
  const viewLog = (id) => {
    const el = document.getElementById('pl-' + id);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.transition = 'background .3s'; el.style.background = 'var(--accent-soft)'; setTimeout(() => { el.style.background = ''; }, 1400); }
  };
  const saveNote = () => { if ((item.note || '') !== noteDraft.trim()) onSetNote(task.id, item.id, noteDraft); };

  return (
    <div className="col gap8" style={{ padding: '4px 0 12px 30px' }}>
      {item.done && (
        <div className="row gap8 center" style={{ flexWrap: 'wrap', fontSize: 12 }}>
          <span className="chip" style={{ color: 'var(--st-completed)', fontWeight: 600 }}><I.check size={11} /> Completed {item.completedAt ? fmtDay(item.completedAt) : ''}</span>
          {item.completedBy && window.USERS[item.completedBy] && <span className="faint">by {window.USERS[item.completedBy].name}</span>}
        </div>
      )}
      {/* link to the progress update that reported this work */}
      {item.done && (linkedLog ? (
        <div className="row gap8 center" style={{ flexWrap: 'wrap', fontSize: 12 }}>
          <span className="faint">Linked to progress update ·</span>
          <span className="chip mono">{fmtDay(linkedLog.at)} · {linkedLog.percent}%</span>
          <button className="btn btn-subtle btn-sm" onClick={() => viewLog(linkedLog.id)}>View →</button>
          {canEdit && <button className="btn btn-subtle btn-sm" title="Detach from this update — the item stays completed but leaves weekly reporting" onClick={() => onUnlink(task.id, item.id)}>Unlink</button>}
        </div>
      ) : (
        <div className="row gap8 center" style={{ flexWrap: 'wrap' }}>
          <span className="chip" style={{ color: 'var(--st-waiting)', fontWeight: 600 }}><I.alert size={11} /> Pending progress update</span>
          {canEdit && <>
            <button className="btn btn-subtle btn-sm" onClick={() => onCreateUpdate(item.id)}><I.plus size={12} /> Create Progress Update</button>
            <button className="btn btn-subtle btn-sm" onClick={() => setPicking(p => !p)} disabled={!logs.length} title={logs.length ? undefined : 'No progress updates on this task yet'}><I.link size={12} /> Link Existing</button>
          </>}
        </div>
      ))}
      {picking && !linkedLog && (
        <div className="col" style={{ gap: 4, maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 6 }}>
          {logs.map(e => (
            <button key={e.id} className="ws-item" style={{ cursor: 'pointer', width: '100%', textAlign: 'left', padding: '5px 8px' }}
              onClick={() => { onLinkToLog(task.id, item.id, e.id); setPicking(false); }}>
              <span className="mono" style={{ fontSize: 11.5, flexShrink: 0 }}>{fmtDay(e.at)} · {e.percent}%</span>
              <span className="muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.note || '(no note)'}</span>
            </button>
          ))}
        </div>
      )}
      {/* working note — belongs to the work item, not the progress log */}
      {(canEdit || item.note) && (
        <div className="field" style={{ margin: 0 }}>
          <label className="field-label" style={{ marginBottom: 3 }}><I.msg size={11} /> Notes</label>
          {canEdit
            ? <textarea className="ai-textarea" style={{ minHeight: 44, fontSize: 12.5 }} placeholder="e.g. Updated Clause 4 after Richard's review."
                value={noteDraft} onChange={e => setNoteDraft(e.target.value)} onBlur={saveNote} />
            : <div className="muted" style={{ fontSize: 12.5 }}>{item.note}</div>}
        </div>
      )}
      <ChecklistItemAttachments task={task} item={item} canEdit={canEdit}
        onAddLink={onAddLink} onDeleteLink={onDeleteLink} onAddFile={onAddFile} onDeleteFile={onDeleteFile} />
    </div>
  );
}

function Checklist({ task, onAdd, onToggle, onEdit, onDelete, onAddLink, onDeleteLink, onAddFile, onDeleteFile, onSetNote, onCreateUpdate, onLinkToLog, onUnlink, canEdit }) {
  const I = window.I;
  const [draft, setDraft] = useStateT('');
  const [adding, setAdding] = useStateT(false);
  const [editingId, setEditingId] = useStateT(null);
  const [editVal, setEditVal] = useStateT('');
  const [expandedId, setExpandedId] = useStateT(null);
  const items = task.checklist || [];
  const doneCount = items.filter(c => c.done).length;
  const pct = items.length ? Math.round((doneCount / items.length) * 100) : 0;

  const submitAdd = () => {
    const lines = draft.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) { setAdding(false); return; }
    lines.forEach(line => onAdd(task.id, line));
    setDraft('');
  };
  const handlePaste = (e) => {
    const text = e.clipboardData.getData('text');
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      e.preventDefault();
      lines.forEach(line => onAdd(task.id, line));
      setDraft('');
    }
  };
  const startEdit = (it) => { setEditingId(it.id); setEditVal(it.title); };
  const submitEdit = () => {
    if (editVal.trim()) onEdit(task.id, editingId, editVal);
    setEditingId(null);
  };

  return (
    <div className="mt24">
      <div className="section-eyebrow mb8" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <I.check size={13} /> Checklist {items.length > 0 && <span className="faint" style={{ fontWeight: 400, textTransform: 'none' }}>· {doneCount}/{items.length}</span>}
      </div>
      {items.length > 0 && (
        <div style={{ height: 6, borderRadius: 99, background: 'var(--border)', overflow: 'hidden', marginBottom: 10 }}>
          <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? 'var(--st-completed)' : 'var(--accent)', transition: 'width .2s' }} />
        </div>
      )}
      {items.map(it => {
        const nFiles = (it.files || []).length, nLinks = (it.links || []).length, nNotes = it.note ? 1 : 0;
        const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
        const counter = (n, icon, label) => n > 0 && (
          <button className="faint" title={`${n} ${label} — click to view`} onClick={() => setExpandedId(id => id === it.id ? null : it.id)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', flexShrink: 0 }}>
            {icon} {n}
          </button>
        );
        return (
        <div key={it.id}>
          <div className="row gap8 center" style={{ padding: '5px 0' }}>
            {/* ticking = completing the work; auto-expand so notes/evidence and
                the progress-update link are one gesture away */}
            <input type="checkbox" checked={!!it.done} disabled={!canEdit}
              onChange={() => { if (!it.done) setExpandedId(it.id); onToggle(task.id, it.id); }} />
            {editingId === it.id ? (
              <input className="input" autoFocus value={editVal} onChange={e => setEditVal(e.target.value)}
                onBlur={submitEdit}
                onKeyDown={e => { if (e.key === 'Enter') submitEdit(); if (e.key === 'Escape') setEditingId(null); }}
                style={{ flex: 1, fontSize: 13, padding: '3px 8px' }} />
            ) : (
              <span onClick={() => canEdit && startEdit(it)}
                title={it.done && it.completedAt ? `Completed ${window.fmtRelTime(it.completedAt)}${it.completedBy && window.USERS[it.completedBy] ? ' by ' + window.USERS[it.completedBy].name : ''}` : undefined}
                style={{ flex: 1, minWidth: 0, fontSize: 13.5, cursor: canEdit ? 'text' : 'default', textDecoration: it.done ? 'line-through' : 'none', color: it.done ? 'var(--muted)' : 'var(--text)' }}>
                {it.title}
              </span>
            )}
            {counter(nFiles, <I.edit size={11} />, 'file' + (nFiles === 1 ? '' : 's'))}
            {counter(nLinks, <I.link size={11} />, 'link' + (nLinks === 1 ? '' : 's'))}
            {counter(nNotes, <I.msg size={11} />, 'note')}
            {it.done && (it.completedInLogId
              ? <span className="chip" title="Reported in a progress update" style={{ fontSize: 10, color: 'var(--st-completed)', flexShrink: 0 }}>{it.completedAt ? fmtDay(it.completedAt) : 'Done'}</span>
              : <span className="chip" title="The work is done — reporting is pending. Link it to a progress update so it counts in Weekly reporting" style={{ fontSize: 10, color: 'var(--st-waiting)', flexShrink: 0, cursor: 'help' }}>⚠ Pending report</span>)}
            <button className="icon-btn" title={expandedId === it.id ? 'Collapse' : 'Expand'} onClick={() => setExpandedId(id => id === it.id ? null : it.id)} style={{ width: 22, height: 22, flexShrink: 0 }}>
              {expandedId === it.id ? <I.chevD size={13} /> : <I.chevR size={13} />}
            </button>
            {canEdit && (
              <button className="btn btn-subtle btn-sm" onClick={() => onDelete(task.id, it.id)} style={{ padding: '2px 6px', flexShrink: 0 }}><I.x size={12} /></button>
            )}
          </div>
          {expandedId === it.id && (
            <ChecklistItemPanel task={task} item={it} canEdit={canEdit}
              onSetNote={onSetNote} onAddLink={onAddLink} onDeleteLink={onDeleteLink} onAddFile={onAddFile} onDeleteFile={onDeleteFile}
              onCreateUpdate={onCreateUpdate} onLinkToLog={onLinkToLog} onUnlink={onUnlink} />
          )}
        </div>
        );
      })}
      {!items.length && !adding && <div className="muted" style={{ fontSize: 12.5 }}>No checklist items yet.</div>}
      {canEdit && (adding ? (
        <div className="row gap8 center mt8">
          <input className="input" autoFocus placeholder="Add an item… (paste a list to add multiple)" value={draft} onChange={e => setDraft(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={e => { if (e.key === 'Enter') submitAdd(); if (e.key === 'Escape') { setAdding(false); setDraft(''); } }}
            style={{ flex: 1, fontSize: 13, padding: '5px 10px' }} />
          <button className="btn btn-primary btn-sm" onClick={submitAdd}>Add</button>
          <button className="btn btn-subtle btn-sm" onClick={() => { setAdding(false); setDraft(''); }}>Cancel</button>
        </div>
      ) : (
        <button className="btn btn-subtle btn-sm mt8" onClick={() => setAdding(true)}><I.plus size={13} /> Add item</button>
      ))}
    </div>
  );
}

function TaskDetail({ task, deliverables = [], allTasks = [], weeks = [], onClose, onUpdate, onAddComment, onToggleDone, onLogProgress, onEditProgress, onDeleteProgress, onEditTask, onRevertEdit, onAssignDeliverable, onOpenDeliverable, onOpenTask, onCreateLinked, onAddResource, onDeleteResource, onEditResource, onAddChecklistItem, onToggleChecklistItem, onEditChecklistItem, onDeleteChecklistItem, onAddChecklistLink, onDeleteChecklistLink, onAddChecklistFile, onDeleteChecklistFile, onSetChecklistNote, onLinkChecklistToLog, onUnlinkChecklistFromLog, onDeleteTask, canEdit = true, currentUser = 'richard' }) {
  // "Create Progress Update" from a checklist item — seeds the progress form
  // with that item as Work delivered; token forces the form open each click
  const [logSeed, setLogSeed] = useStateT(null);
  const I = window.I;
  const [comment, setComment] = useStateT('');
  const [editing, setEditing] = useStateT(false);
  const [histOpen, setHistOpen] = useStateT(false);
  if (!task) return null;
  const owner = window.userOf(task.ownerId);
  const dlv = deliverables.find(d => d.id === task.deliverableId);

  const taskTitle = (id) => { const t = allTasks.find(x => x.id === id); return t ? `${t.id} ${t.title}` : id; };
  const fmtVal = (field, v) => {
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return '—';
    if (field === 'depTaskIds' && Array.isArray(v)) return v.map(taskTitle).join('; ');
    if (Array.isArray(v)) return v.join('; ');
    if (field === 'effort') return window.EFFORT_LABEL[v] || v;
    if (field === 'ownerId') return window.USERS[v]?.name || v;
    if (field === 'dueDate') return window.fmtDate(v);
    return String(v);
  };
  const toDateInput = (iso) => {
    if (!iso) return '';
    const dt = new Date(iso);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  };
  const edits = [...(task.edits || [])].sort((a, b) => new Date(b.at) - new Date(a.at));

  const submitComment = () => {
    if (!comment.trim()) return;
    onAddComment(task.id, comment.trim());
    setComment('');
  };

  const activity = [...(task.activity || [])].sort((a, b) => new Date(b.at) - new Date(a.at));
  const actLabel = (a) => {
    if (a.type === 'created') return 'created this task';
    if (a.type === 'completed') return 'marked it Completed';
    if (a.type === 'comment') return 'commented';
    if (a.type === 'progress') return `logged progress · ${a.detail}`;
    if (a.type === 'status') return `changed status · ${a.detail}`;
    if (a.type === 'edit') return `edited ${a.detail}`;
    if (a.type === 'revert') return `reverted ${a.detail}`;
    if (a.type === 'deliverable') return a.detail || 'changed deliverable';
    return a.type;
  };

  return (
    <div className="scroll-area fade-in">
      <div style={{ padding: '16px 28px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn btn-subtle btn-sm" onClick={onClose}><I.chevL size={15} /> Tasks</button>
        <span className="muted mono" style={{ fontSize: 12 }}>{task.id}</span>
        <span className="grow" />
        <window.StatusPill status={task.status} />
      </div>

      <div className="page-pad" style={{ paddingTop: 24 }}>
        <div className="detail-grid">
          {/* main */}
          <div>
            <div className="row gap10 center mb12" style={{ flexWrap: 'wrap' }}>
              <window.StatusPill status={task.status} />
              <window.PriorityTag priority={task.priority} />
              <window.CatChip category={task.category} />
              <span className="grow" />
              {canEdit && !editing && (
                <button className="btn btn-subtle btn-sm" onClick={() => setEditing(true)}><I.edit size={13} /> Edit</button>
              )}
            </div>

            {editing ? (
              <TaskEditPanel task={task} allTasks={allTasks}
                onSave={(changes) => { onEditTask && onEditTask(task.id, changes); setEditing(false); }}
                onCancel={() => setEditing(false)} />
            ) : (
              <>
                <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.2, marginBottom: 18 }}>{task.title}</h1>

                <div className="section-eyebrow mb8" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.edit size={13} /> Description</div>
                <window.Markdown className="desc-block mb16" text={task.description} />

                {task.successCriteria && (
                  <>
                    <div className="section-eyebrow mb8" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.target size={13} /> Success criteria</div>
                    <div className="crit-item" style={{ background: 'var(--st-completed-bg)', borderRadius: 'var(--r-md)', padding: '11px 14px', marginBottom: 16 }}>
                      <span style={{ color: 'var(--st-completed)', marginTop: 1 }}><I.check size={16} /></span>
                      <span style={{ whiteSpace: 'pre-wrap' }}>{task.successCriteria}</span>
                    </div>
                  </>
                )}

                {task.depTaskIds?.length > 0 && (
                  <>
                    <div className="section-eyebrow mb8" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.link size={13} /> Dependency tasks</div>
                    <div className="row gap8 mb16" style={{ flexWrap: 'wrap' }}>
                      {task.depTaskIds.map(id => {
                        const dt = allTasks.find(x => x.id === id);
                        if (!dt) return <span key={id} className="chip faint">{id} (deleted)</span>;
                        return (
                          <button key={id} type="button" className="chip" onClick={() => onOpenTask && onOpenTask(id)}
                            title={dt.title} style={{ cursor: 'pointer', maxWidth: 320 }}>
                            <span style={{ width: 7, height: 7, borderRadius: 99, flexShrink: 0, background: (window.STATUS_META[dt.status] || {}).c || 'var(--muted)' }} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dt.title}</span>
                            <span className="faint mono" style={{ fontSize: 11 }}>{dt.id}</span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}

                {(() => {
                  // incoming links: tasks that point at this one (e.g. follow-ups created from it)
                  const linkedFrom = allTasks.filter(t => t.id !== task.id && (t.depTaskIds || []).includes(task.id));
                  if (!linkedFrom.length) return null;
                  return (
                    <>
                      <div className="section-eyebrow mb8" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.link size={13} /> Linked tasks <span className="faint" style={{ fontWeight: 400, textTransform: 'none' }}>· follow-ups & tasks that link here</span></div>
                      <div className="row gap8 mb16" style={{ flexWrap: 'wrap' }}>
                        {linkedFrom.map(dt => (
                          <button key={dt.id} type="button" className="chip" onClick={() => onOpenTask && onOpenTask(dt.id)}
                            title={dt.title} style={{ cursor: 'pointer', maxWidth: 320 }}>
                            <span style={{ width: 7, height: 7, borderRadius: 99, flexShrink: 0, background: (window.STATUS_META[dt.status] || {}).c || 'var(--muted)' }} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dt.title}</span>
                            <span className="faint mono" style={{ fontSize: 11 }}>{dt.id}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  );
                })()}

                {task.dependencies?.length > 0 && (
                  <>
                    <div className="section-eyebrow mb8" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.link size={13} /> Dependencies</div>
                    <div className="mb16">
                      {task.dependencies.map((dep, i) => (
                        <div key={i} className="crit-item">
                          <span className="faint" style={{ marginTop: 2 }}><I.arrowR size={14} /></span>
                          <span>{dep}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {task.risk && (
                  <>
                    <div className="section-eyebrow mb8" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.alert size={13} /> Risk</div>
                    <div className="crit-item" style={{ background: 'var(--st-blocked-bg)', borderRadius: 'var(--r-md)', padding: '11px 14px', marginBottom: 16 }}>
                      <span style={{ color: 'var(--st-blocked)', marginTop: 1 }}><I.alert size={16} /></span>
                      <span style={{ whiteSpace: 'pre-wrap' }}>{task.risk}</span>
                    </div>
                  </>
                )}
              </>
            )}

            {/* change history */}
            {edits.length > 0 && (
              <>
                <div className="section-eyebrow mt24 mb8" onClick={() => setHistOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', userSelect: 'none' }}>
                  <I.clock size={13} /> Change history · {edits.length}
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', transform: histOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}><I.chevR size={14} /></span>
                </div>
                {histOpen && <div className="mb8">
                  {edits.map(e => {
                    const u = window.USERS[e.userId];
                    return (
                      <div key={e.id} className="comment" style={{ alignItems: 'flex-start' }}>
                        <div className="grow" style={{ minWidth: 0 }}>
                          <div className="comment-meta row gap8 center" style={{ flexWrap: 'wrap' }}>
                            <b style={{ color: 'var(--text)' }}>{e.label}</b>
                            {e.isRevert && <span className="chip">revert</span>}
                            {e.reverted && <span className="chip">reverted</span>}
                            <span>· {u?.name || 'Someone'} · {window.fmtRelTime(e.at)}</span>
                          </div>
                          <div className="comment-body" style={{ fontSize: 13, wordBreak: 'break-word' }}>
                            <span style={{ textDecoration: 'line-through', color: 'var(--muted)' }}>{fmtVal(e.field, e.from)}</span>
                            <span className="faint" style={{ margin: '0 6px' }}>→</span>
                            <span>{fmtVal(e.field, e.to)}</span>
                          </div>
                        </div>
                        {canEdit && !e.reverted && (
                          <button className="btn btn-subtle btn-sm" onClick={() => onRevertEdit && onRevertEdit(task.id, e.id)} title="Revert this change" style={{ flexShrink: 0 }}><I.refresh size={12} /> Revert</button>
                        )}
                      </div>
                    );
                  })}
                </div>}
              </>
            )}

            {/* progress log — describes work; the checklist manages it */}
            <ProgressLog task={task} onLog={onLogProgress} onEdit={onEditProgress} onDelete={onDeleteProgress} onCreateLinked={onCreateLinked && (() => onCreateLinked(task))} canEdit={canEdit} currentUser={currentUser} seed={logSeed} />

            {/* checklist — where work is executed, evidenced and completed */}
            <Checklist task={task} canEdit={canEdit}
              onAdd={onAddChecklistItem} onToggle={onToggleChecklistItem} onEdit={onEditChecklistItem} onDelete={onDeleteChecklistItem}
              onAddLink={onAddChecklistLink} onDeleteLink={onDeleteChecklistLink} onAddFile={onAddChecklistFile} onDeleteFile={onDeleteChecklistFile}
              onSetNote={onSetChecklistNote} onLinkToLog={onLinkChecklistToLog} onUnlink={onUnlinkChecklistFromLog}
              onCreateUpdate={(itemId) => setLogSeed({ ids: [itemId], token: Date.now() })} />

            {/* resources — shared + private (per-item lock toggle) */}
            <div className="mt24">
              <window.ResourceList parentType="task" parentId={task.id} publicItems={task.resources || []}
                canEdit={canEdit}
                onAddPublic={(res) => onAddResource && onAddResource('task', task.id, res)}
                onDeletePublic={(id) => onDeleteResource && onDeleteResource('task', task.id, id)}
                onEditPublic={(id, patch) => onEditResource && onEditResource('task', task.id, id, patch)} />
            </div>

            {/* comments */}
            <div className="section-eyebrow mt24 mb8" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.msg size={13} /> Comments · {task.comments?.length || 0}</div>
            <div>
              {(task.comments || []).map(c => {
                const u = window.userOf(c.userId);
                return (
                  <div key={c.id} className="comment">
                    <window.Avatar user={u} size={30} />
                    <div className="grow">
                      <div className="comment-meta"><b style={{ color: 'var(--text)' }}>{u.name}</b> · {window.fmtRelTime(c.createdAt)}</div>
                      <div className="comment-body">{c.comment}</div>
                    </div>
                  </div>
                );
              })}
              {(!task.comments || task.comments.length === 0) && <div className="muted" style={{ fontSize: 13, padding: '8px 0' }}>No comments yet.</div>}
            </div>
            <div className="row gap8 mt12" style={{ alignItems: 'flex-end' }}>
              <window.Avatar user={currentUser} size={30} />
              <div className="chat-inputbar" style={{ flex: 1, padding: '6px 8px 6px 14px' }}>
                <textarea rows={1} placeholder="Add a comment…" value={comment}
                  onChange={e => setComment(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment(); } }} />
                <button className="btn btn-primary btn-sm" onClick={submitComment} disabled={!comment.trim()}><I.send size={14} /></button>
              </div>
            </div>

            {/* danger zone — permanent delete */}
            {canEdit && onDeleteTask && (
              <div className="row mt24" style={{ paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => onDeleteTask(task.id)}
                  style={{ color: 'var(--st-blocked)', borderColor: 'var(--st-blocked)' }}><I.x size={13} /> Delete task</button>
              </div>
            )}
          </div>

          {/* sidebar meta */}
          <div>
            <div className="card card-pad">
              {task.progress > 0 && (
                <div className="row gap12 center mb16" style={{ paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
                  <window.Ring value={task.progress} size={46} />
                  <div>
                    <div style={{ fontSize: 20, fontWeight: 800 }}>{task.progress}%</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>complete</div>
                  </div>
                </div>
              )}
              <div className="meta-row"><span className="meta-k">Deliverable</span>
                {canEdit
                  ? <span style={{ flex: '0 1 210px', minWidth: 0 }}>
                      <window.DeliverablePicker value={task.deliverableId} deliverables={deliverables}
                        onChange={(v) => onAssignDeliverable && onAssignDeliverable(task.id, v)} />
                    </span>
                  : (dlv
                      ? <window.DeliverableChip deliverable={dlv} onClick={() => onOpenDeliverable && onOpenDeliverable(dlv.id)} />
                      : <span className="meta-v">—</span>)}
              </div>
              {/* Weeks are DERIVED, never assigned here. Planned = the week's
                  own taskIds (edited on the This Week page); Activity = dated
                  progress logs / status changes / completion falling in the
                  week's range. A task has no week field — see weekly.jsx. */}
              <div className="meta-row"><span className="meta-k">Appears in</span>
                {(() => {
                  const within = (iso, w) => iso && new Date(iso) >= new Date(w.startDate) && new Date(iso) <= new Date(w.endDate);
                  const rows = [...(weeks || [])].sort((a, b) => (a.id < b.id ? 1 : -1)).map(w => {
                    const planned = (w.taskIds || []).includes(task.id);
                    const activity = (task.progressLog || []).some(l => within(l.at, w))
                      || within(task.completedAt, w)
                      || (task.activity || []).some(a => (a.type === 'status' || a.type === 'completed') && within(a.at, w));
                    return { w, planned, activity };
                  }).filter(r => r.planned || r.activity);
                  if (!rows.length) return <span className="meta-v" title="Commit this task to a week from the This Week page">—</span>;
                  return (
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end', flex: '0 1 210px' }}>
                      {rows.slice(0, 4).map(({ w, planned, activity }) => (
                        <span key={w.id} className="chip" style={{ fontSize: 11 }}
                          title={`Week ${w.weekNumber} · ${window.fmtDate(w.startDate)} – ${window.fmtDate(w.endDate)}`}>
                          W{w.weekNumber} · {planned && activity ? 'Planned + Activity' : planned ? 'Planned' : 'Activity'}
                        </span>
                      ))}
                      {rows.length > 4 && <span className="chip" style={{ fontSize: 11 }}>+{rows.length - 4} more</span>}
                    </span>
                  );
                })()}
              </div>
              <div className="meta-row"><span className="meta-k">Status</span>
                {canEdit
                  ? <select className="select meta-edit" value={task.status} onChange={e => onEditTask && onEditTask(task.id, { status: e.target.value })}>
                      {window.STATUSES.map(s => <option key={s}>{s}</option>)}
                    </select>
                  : <window.StatusPill status={task.status} />}
              </div>
              <div className="meta-row"><span className="meta-k">Priority</span>
                {canEdit
                  ? <select className="select meta-edit" value={task.priority} onChange={e => onEditTask && onEditTask(task.id, { priority: e.target.value })}>
                      {window.PRIORITIES.map(p => <option key={p}>{p}</option>)}
                    </select>
                  : <window.PriorityTag priority={task.priority} />}
              </div>
              <div className="meta-row"><span className="meta-k">Owner</span>
                {canEdit
                  ? <select className="select meta-edit" value={task.ownerId} onChange={e => onEditTask && onEditTask(task.id, { ownerId: e.target.value })}>
                      {Object.values(window.USERS).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  : <span className="row gap6 center"><window.Avatar user={owner} size={22} /><span className="meta-v">{owner.name}</span></span>}
              </div>
              <div className="meta-row"><span className="meta-k">Due date</span>
                {canEdit
                  ? <input type="date" className="select meta-edit" value={toDateInput(task.dueDate)}
                      onChange={e => onEditTask && onEditTask(task.id, { dueDate: e.target.value ? new Date(e.target.value + 'T17:00:00').toISOString() : null })} />
                  : <span className="meta-v"><window.DueTag iso={task.dueDate} status={task.status} /></span>}
              </div>
              <div className="meta-row"><span className="meta-k">Effort</span>
                {canEdit
                  ? <select className="select meta-edit" value={task.effort} onChange={e => onEditTask && onEditTask(task.id, { effort: e.target.value })}>
                      {Object.keys(window.EFFORT_LABEL).map(k => <option key={k} value={k}>{window.EFFORT_LABEL[k]}</option>)}
                    </select>
                  : <span className="meta-v">{window.EFFORT_LABEL[task.effort] || task.effort}</span>}
              </div>
              <div className="meta-row"><span className="meta-k">Category</span>
                {canEdit
                  ? <select className="select meta-edit" value={task.category} onChange={e => onEditTask && onEditTask(task.id, { category: e.target.value })}>
                      {window.CATEGORIES.map(c => <option key={c}>{c}</option>)}
                    </select>
                  : <window.CatChip category={task.category} />}
              </div>
              <div className="meta-row"><span className="meta-k">Created</span><span className="meta-v">{window.fmtDate(task.createdAt)}</span></div>
              <div className="meta-row"><span className="meta-k">Last updated</span><span className="meta-v">{window.fmtRelTime(task.updatedAt)}</span></div>
            </div>

            <div className="card card-pad mt16">
              <div className="section-eyebrow mb12" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.clock size={13} /> Activity</div>
              <div style={{ position: 'relative' }}>
                {activity.map((a, i) => {
                  const u = window.userOf(a.userId);
                  return (
                    <div key={i} className="row gap10" style={{ paddingBottom: i < activity.length - 1 ? 14 : 0, alignItems: 'flex-start' }}>
                      <div className="col center" style={{ alignItems: 'center' }}>
                        <span className="feed-dot" style={{ background: a.type === 'completed' ? 'var(--st-completed)' : a.type === 'status' ? 'var(--st-waiting)' : 'var(--accent)', marginTop: 4 }} />
                        {i < activity.length - 1 && <span style={{ width: 1.5, flex: 1, background: 'var(--border)', minHeight: 18, marginTop: 2 }} />}
                      </div>
                      <div style={{ fontSize: 12.5, paddingBottom: 2 }}>
                        <b>{u.name.split(' ')[0]}</b> <span className="muted">{actLabel(a)}</span>
                        <div className="feed-time">{window.fmtRelTime(a.at)}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { TasksScreen, TaskDetail });
