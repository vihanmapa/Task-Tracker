/* ============================================================
   FM Navigate — This Week (Weekly Workspace)
   ------------------------------------------------------------
   The command center for running the week. Daily-use content
   (Today's Focus, Objectives, Selected Tasks) dominates; generated
   reports stay as collapsed artifacts you open on demand.
   Tasks stay the single source of truth — a week only REFERENCES
   them by id and stores what can't be derived.
   ============================================================ */
const { useState: useStateW, useMemo: useMemoW, useRef: useRefW, useEffect: useEffectW } = React;

/* ISO week number + a stable, sortable week id (W-YYYY-WW). */
function isoWeekNum(dt) {
  const date = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThu = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return { week, year: date.getUTCFullYear() };
}
function weekIdFor(dt) { const { week, year } = isoWeekNum(dt); return `W-${year}-${String(week).padStart(2, '0')}`; }
function makeWeek(forDate, carriedFrom = null) {
  const s = window.startOfWeek(forDate), e = window.endOfWeek(forDate);
  const { week } = isoWeekNum(forDate);
  const now = new Date().toISOString();
  return {
    id: weekIdFor(forDate), weekNumber: week,
    startDate: s.toISOString(), endDate: e.toISOString(),
    objectives: [], notes: '', taskIds: [],
    mondayReport: '', mondayReportAt: null,
    fridaySummary: '', fridaySummaryAt: null,
    status: 'active', carriedFrom, createdAt: now, updatedAt: now,
  };
}
const PRANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };
function fmtStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/* ---------------- task picker modal ---------------- */
function TaskPicker({ tasks, selectedIds, excludeIds, onToggle, onClose }) {
  const I = window.I;
  const [q, setQ] = useStateW('');
  const ql = q.trim().toLowerCase();
  const ex = excludeIds || new Set();
  const list = tasks
    .filter(t => t.status !== 'Cancelled')           // completed allowed; cancelled hidden
    .filter(t => !ex.has(t.id) || selectedIds.includes(t.id)) // not already in another week
    .filter(t => !ql || t.title.toLowerCase().includes(ql) || t.id.toLowerCase().includes(ql))
    .sort((a, b) => (a.status === 'Completed') - (b.status === 'Completed') // completed sink to bottom
      || (PRANK[a.priority] ?? 9) - (PRANK[b.priority] ?? 9));
  return (
    <window.Modal onClose={onClose} width={620}>
      <div className="modal-head">
        <div className="card-title">Select tasks for this week</div>
        <button className="icon-btn" onClick={onClose}><I.x size={18} /></button>
      </div>
      <div style={{ padding: '0 18px 14px' }}>
        <div className="search mb12" style={{ width: '100%' }}>
          <I.search size={15} className="faint" />
          <input autoFocus placeholder="Search backlog…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="col" style={{ gap: 4, maxHeight: 360, overflowY: 'auto' }}>
          {list.length === 0 && <div className="muted" style={{ fontSize: 13, padding: 8 }}>No open tasks match.</div>}
          {list.map(t => {
            const on = selectedIds.includes(t.id);
            return (
              <button key={t.id} className="ws-item" onClick={() => onToggle(t.id)}
                style={{ cursor: 'pointer', border: on ? '1px solid var(--accent)' : '1px solid transparent', background: on ? 'var(--accent-soft)' : 'transparent', width: '100%', textAlign: 'left' }}>
                <span style={{ width: 18, height: 18, borderRadius: 5, border: '1.5px solid ' + (on ? 'var(--accent)' : 'var(--border)'), background: on ? 'var(--accent)' : 'transparent', color: 'var(--accent-fg)', display: 'grid', placeItems: 'center', flexShrink: 0, marginTop: 2 }}>
                  {on && <I.check size={12} />}
                </span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t.title}</div>
                  <div className="att-meta">
                    <window.PriorityTag priority={t.priority} />
                    <span className="faint">·</span><window.StatusPill status={t.status} />
                    {t.dueDate && <><span className="faint">·</span><window.DueTag iso={t.dueDate} /></>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn btn-primary" onClick={onClose}>Done · {selectedIds.length} selected</button>
      </div>
    </window.Modal>
  );
}

/* ---------------- complete-week modal ---------------- */
function CompleteWeek({ week, incomplete, onComplete, onClose }) {
  const I = window.I;
  const [picked, setPicked] = useStateW(incomplete.map(t => t.id));
  const toggle = (id) => setPicked(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  return (
    <window.Modal onClose={onClose} width={560}>
      <div className="modal-head">
        <div className="card-title">Complete Week {week.weekNumber}</div>
        <button className="icon-btn" onClick={onClose}><I.x size={18} /></button>
      </div>
      <div style={{ padding: '0 18px 14px' }}>
        <p style={{ fontSize: 14, fontWeight: 600, marginTop: 4, marginBottom: 4 }}>
          {incomplete.length === 0 ? 'All planned tasks are done. 🎉' : 'Carry unfinished tasks into next week?'}
        </p>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
          {incomplete.length === 0
            ? 'Completing the week archives it. Tasks are never duplicated or deleted.'
            : 'Checked tasks move into next week. Unchecked ones simply stay in your backlog.'}
        </p>
        <div className="col" style={{ gap: 4, maxHeight: 300, overflowY: 'auto' }}>
          {incomplete.map(t => {
            const on = picked.includes(t.id);
            return (
              <button key={t.id} className="ws-item" onClick={() => toggle(t.id)}
                style={{ cursor: 'pointer', background: on ? 'var(--accent-soft)' : 'transparent', width: '100%', textAlign: 'left' }}>
                <span style={{ width: 18, height: 18, borderRadius: 5, border: '1.5px solid ' + (on ? 'var(--accent)' : 'var(--border)'), background: on ? 'var(--accent)' : 'transparent', color: 'var(--accent-fg)', display: 'grid', placeItems: 'center', flexShrink: 0, marginTop: 2 }}>
                  {on && <I.check size={12} />}
                </span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t.title}</div>
                  <div className="att-meta"><window.StatusPill status={t.status} />{t.dueDate && <><span className="faint">·</span><window.DueTag iso={t.dueDate} /></>}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        {incomplete.length > 0 && <button className="btn btn-subtle" onClick={() => onComplete([])}>Complete only</button>}
        <button className="btn btn-primary" onClick={() => onComplete(picked)}>
          {incomplete.length > 0 && picked.length ? `Carry ${picked.length} & complete` : 'Complete week'}
        </button>
      </div>
    </window.Modal>
  );
}

/* ---------------- report viewer / editor modal ---------------- */
function ReportModal({ title, text, at, canEdit, busy, onSave, onGenerate, onClose }) {
  const I = window.I;
  const [editing, setEditing] = useStateW(false);
  const [draft, setDraft] = useStateW(text || '');
  const copy = () => { try { navigator.clipboard.writeText(text || ''); } catch (_) {} };
  return (
    <window.Modal onClose={onClose} width={760}>
      <div className="modal-head">
        <div>
          <div className="card-title">{title}</div>
          {at && <div className="att-meta" style={{ marginTop: 2 }}>Generated {fmtStamp(at)}</div>}
        </div>
        <button className="icon-btn" onClick={onClose}><I.x size={18} /></button>
      </div>
      <div style={{ padding: '0 18px 6px', maxHeight: '60vh', overflowY: 'auto' }}>
        {busy
          ? <div className="col" style={{ gap: 6 }}><div className="shimmer" style={{ height: 13, width: '92%' }} /><div className="shimmer" style={{ height: 13, width: '85%' }} /><div className="shimmer" style={{ height: 13, width: '70%' }} /></div>
          : editing
            ? <textarea className="input" rows={18} value={draft} onChange={e => setDraft(e.target.value)} style={{ fontFamily: 'inherit', lineHeight: 1.6, width: '100%' }} />
            : text
              ? <window.Markdown text={text} />
              : <div className="muted" style={{ fontSize: 13, padding: '8px 0' }}>{canEdit ? 'Not generated yet — click Generate.' : 'Not generated yet.'}</div>}
      </div>
      <div className="modal-foot" style={{ flexWrap: 'wrap', gap: 8 }}>
        {editing
          ? <>
              <button className="btn btn-ghost" onClick={() => { setDraft(text || ''); setEditing(false); }}>Cancel</button>
              <button className="btn btn-primary" onClick={() => { onSave(draft); setEditing(false); }}>Save</button>
            </>
          : <>
              {text && <button className="btn btn-ghost" onClick={copy}><I.link size={13} /> Copy</button>}
              {canEdit && text && <button className="btn btn-ghost" onClick={() => { setDraft(text); setEditing(true); }}><I.edit size={13} /> Edit</button>}
              {canEdit && <button className="btn btn-primary" onClick={onGenerate} disabled={busy}><I.refresh size={13} /> {text ? 'Regenerate' : 'Generate'}</button>}
            </>}
      </div>
    </window.Modal>
  );
}

/* ---------------- collapsed report artifact card ---------------- */
function ReportArtifact({ title, eyebrow, text, at, onView }) {
  const I = window.I;
  const preview = (text || '').split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 1)[0] || '';
  return (
    <button className="ws-item" onClick={onView} style={{ cursor: 'pointer', width: '100%', textAlign: 'left', alignItems: 'center', padding: '12px 14px' }}>
      <span style={{ color: 'var(--accent)', display: 'grid', placeItems: 'center', width: 34, height: 34, borderRadius: 9, background: 'var(--accent-soft)', flexShrink: 0 }}><I.summary size={17} /></span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row center" style={{ gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
          {text
            ? <span className="att-meta" style={{ margin: 0 }}>· generated {fmtStamp(at)}</span>
            : <span className="chip" style={{ fontSize: 10 }}>Not generated</span>}
        </div>
        <div className="muted" style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {text ? preview : eyebrow}
        </div>
      </div>
      <span className="btn btn-subtle btn-sm" style={{ flexShrink: 0 }}>{text ? 'View' : 'Open'} <I.chevR size={13} /></span>
    </button>
  );
}

/* ---------------- main workspace ---------------- */
function WeeklyWorkspace({ weeks, onSaveWeek, onPatchWeek, onDeleteWeek, tasks, deliverables, canEdit, onOpenTask }) {
  const I = window.I;
  const currentId = weekIdFor(window.TODAY);
  const sortedAsc = useMemoW(() => [...(weeks || [])].sort((a, b) => (a.id < b.id ? -1 : 1)), [weeks]);
  const [selId, setSelId] = useStateW(null);
  const [picker, setPicker] = useStateW(false);
  const [complete, setComplete] = useStateW(false);
  const [viewer, setViewer] = useStateW(null); // 'monday' | 'friday' | null
  const [editObj, setEditObj] = useStateW(false);
  const [busyM, setBusyM] = useStateW(false);
  const [busyF, setBusyF] = useStateW(false);
  const [confirmDel, setConfirmDel] = useStateW(false);

  const week = useMemoW(() => {
    if (selId) return (weeks || []).find(w => w.id === selId) || null;
    return (weeks || []).find(w => w.id === currentId) || sortedAsc[sortedAsc.length - 1] || null;
  }, [weeks, selId, sortedAsc, currentId]);

  // ---- debounced autosave for FREE-TEXT fields only (objectives + notes) ----
  // Typing updates local draft instantly (responsive UI) but persistence is
  // delayed ~1s after the last keystroke, so a paragraph is one save, not one
  // save per character. Every OTHER action (task select, new/delete/complete
  // week, carry forward, report generation, import/export) still persists
  // immediately — they never go through this path.
  // NOTE: these hooks live ABOVE the empty-state early return so hook order is
  // unconditional (Rules of Hooks). They are null-safe when `week` is null.
  const wid = week && week.id;
  const [notesDraft, setNotesDraft] = useStateW((week && week.notes) || '');
  const [objDraft, setObjDraft] = useStateW((week && week.objectives) || []);
  const timerRef = useRefW(null);
  const pendingRef = useRefW(null); // { wid, patch }

  const flushText = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    const p = pendingRef.current; pendingRef.current = null;
    if (p && onPatchWeek) onPatchWeek(p.wid, p.patch);
    else if (p && week) onSaveWeek({ ...week, ...p.patch, updatedAt: new Date().toISOString() });
  };
  const scheduleText = (partial) => {
    pendingRef.current = { wid, patch: { ...(pendingRef.current && pendingRef.current.patch), ...partial } };
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flushText, 1000);
  };

  // Resync drafts when the viewed week changes; flush any pending edit to the
  // PREVIOUS week first so switching weeks never drops an in-flight save.
  useEffectW(() => {
    flushText();
    setNotesDraft((week && week.notes) || '');
    setObjDraft((week && week.objectives) || []);
    // eslint-disable-next-line
  }, [wid]);
  // Flush on unmount (navigate away from This Week, sign out, etc.).
  useEffectW(() => () => flushText(), []); // eslint-disable-line

  const commitNow = (p) => (onPatchWeek ? onPatchWeek(wid, p) : patch(p));
  const setNotes = (v) => { setNotesDraft(v); scheduleText({ notes: v }); };
  const setObjective = (i, v) => { const o = [...objDraft]; o[i] = v; setObjDraft(o); scheduleText({ objectives: o }); };
  // Add/remove are STRUCTURAL — commit immediately (and flush any pending text).
  const addObjective = () => { flushText(); const o = [...objDraft, '']; setObjDraft(o); commitNow({ objectives: o }); };
  const removeObjective = (i) => { flushText(); const o = objDraft.filter((_, x) => x !== i); setObjDraft(o); commitNow({ objectives: o }); };

  const patch = (p) => onSaveWeek({ ...week, ...p, updatedAt: new Date().toISOString() });
  const startWeek = () => { flushText(); const w = makeWeek(window.TODAY); onSaveWeek(w); setSelId(w.id); };

  // Create the next week on demand (independent of the Complete-Week carry-over
  // flow). Target = the current ISO week if it isn't created yet, otherwise the
  // week right after the newest one. If that week already exists, just navigate.
  const startNextWeek = () => {
    flushText();
    const all = sortedAsc;
    const hasCurrent = all.some(w => w.id === currentId);
    let target;
    if (!hasCurrent) {
      target = window.TODAY;
    } else {
      const newest = all[all.length - 1];
      const d = new Date(newest.endDate); d.setDate(d.getDate() + 1); // Monday after newest
      target = d;
    }
    const id = weekIdFor(target);
    if (all.some(w => w.id === id)) { setSelId(id); return; }
    onSaveWeek(makeWeek(target));
    setSelId(id);
  };

  // Delete the week being viewed. Falls back to current/latest after removal.
  // Cancel any pending text save — no point writing to a week we're deleting.
  const removeWeek = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    pendingRef.current = null;
    if (onDeleteWeek) onDeleteWeek(week.id);
    setConfirmDel(false);
    setSelId(null);
  };

  // ---- empty state: no weeks at all ----
  if (!week) {
    return (
      <div className="scroll-area fade-in">
        <div className="page-pad" style={{ maxWidth: 720 }}>
          <div className="empty" style={{ marginTop: 40 }}>
            <div style={{ color: 'var(--accent)', display: 'grid', placeItems: 'center', width: 56, height: 56, borderRadius: 14, background: 'var(--accent-soft)', margin: '0 auto 14px' }}><I.calendar size={28} /></div>
            <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text)' }}>No week planned yet</div>
            <div style={{ fontSize: 13.5, maxWidth: 420, margin: '6px auto 0' }}>Start this week, pick a few tasks from the backlog, set your objectives, and generate a Monday plan in under five minutes.</div>
            {canEdit && <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={startWeek}><I.plus size={15} /> Start this week</button>}
          </div>
        </div>
      </div>
    );
  }

  // ---- derived state (tasks are the source of truth) ----
  const sel = (week.taskIds || []).map(id => tasks.find(t => t.id === id)).filter(Boolean);
  const completed = sel.filter(t => t.status === 'Completed');
  const incomplete = sel.filter(t => !['Completed', 'Cancelled'].includes(t.status));
  const blockedOnly = sel.filter(t => t.status === 'Blocked');
  const inProg = sel.filter(t => t.status === 'In Progress');
  const overdue = incomplete.filter(t => t.dueDate && window.daysBetween(window.TODAY, t.dueDate) < 0);
  const dueToday = incomplete.filter(t => t.dueDate && window.daysBetween(window.TODAY, t.dueDate) === 0);
  const highPrio = incomplete.filter(t => t.priority === 'Critical' || t.priority === 'High');
  const pct = sel.length ? Math.round((completed.length / sel.length) * 100) : 0;
  const range = `${window.fmtDate(week.startDate)} – ${window.fmtDate(week.endDate)}`;
  const isCurrent = week.id === currentId;

  // "What should I work on next?" — high priority / due today first, blocked sinks.
  const focusList = [...incomplete]
    .sort((a, b) => {
      const dt = (t) => t.dueDate && window.daysBetween(window.TODAY, t.dueDate) <= 0 ? 0 : 1;
      const bl = (t) => t.status === 'Blocked' ? 1 : 0;
      return bl(a) - bl(b) || dt(a) - dt(b) || (PRANK[a.priority] ?? 9) - (PRANK[b.priority] ?? 9);
    })
    .slice(0, 3);

  // ---- week navigation ----
  const idx = sortedAsc.findIndex(w => w.id === week.id);
  const prevW = idx > 0 ? sortedAsc[idx - 1] : null;
  const nextW = idx >= 0 && idx < sortedAsc.length - 1 ? sortedAsc[idx + 1] : null;

  const cards = [
    { label: 'Planned', val: sel.length, color: 'var(--accent)' },
    { label: 'Completed', val: completed.length, color: 'var(--st-completed)' },
    { label: 'Remaining', val: incomplete.length, color: 'var(--st-inprogress)' },
    { label: 'Blocked', val: blockedOnly.length, color: 'var(--st-blocked)' },
    { label: 'Overdue', val: overdue.length, color: 'var(--neg)' },
  ];
  const focusChips = [
    { label: 'High priority', val: highPrio.length, color: 'var(--pr-high)' },
    { label: 'Due today', val: dueToday.length, color: 'var(--st-waiting)' },
    { label: 'Blocked', val: blockedOnly.length, color: 'var(--st-blocked)' },
    { label: 'In progress', val: inProg.length, color: 'var(--st-inprogress)' },
  ];

  const toggleTask = (id) => {
    const has = (week.taskIds || []).includes(id);
    patch({ taskIds: has ? week.taskIds.filter(x => x !== id) : [...(week.taskIds || []), id] });
  };

  // Generators patch ONLY the report field by week id. The whole-object spread
  // ({ ...week }) captured here would be stale by the time the AI returns, so it
  // would silently wipe any objectives/notes the user edited during the request.
  // patchWeek merges against the latest stored week instead.
  const savePartial = (wid, p) => (onPatchWeek ? onPatchWeek(wid, p) : onSaveWeek({ ...week, ...p, updatedAt: new Date().toISOString() }));
  const genMonday = async () => {
    flushText();
    setBusyM(true);
    const wid = week.id;
    const txt = await window.aiService.generateMondayReport(week, tasks, deliverables);
    savePartial(wid, { mondayReport: txt, mondayReportAt: new Date().toISOString() });
    setBusyM(false);
  };
  const genFriday = async () => {
    flushText();
    setBusyF(true);
    const wid = week.id;
    const txt = await window.aiService.generateFridaySummary(week, tasks, deliverables);
    savePartial(wid, { fridaySummary: txt, fridaySummaryAt: new Date().toISOString() });
    setBusyF(false);
  };

  const completeWeek = (carryIds) => {
    flushText();
    const now = new Date().toISOString();
    if (carryIds && carryIds.length) {
      const next = new Date(week.endDate); next.setDate(next.getDate() + 1); // Monday after this week
      const nextId = weekIdFor(next);
      const existing = (weeks || []).find(w => w.id === nextId);
      const base = existing || makeWeek(next, week.id);
      const merged = [...new Set([...(base.taskIds || []), ...carryIds])];
      onSaveWeek({ ...base, taskIds: merged, status: 'active', carriedFrom: week.id, updatedAt: now });
      onSaveWeek({ ...week, status: 'closed', updatedAt: now });
      setSelId(nextId);
    } else {
      onSaveWeek({ ...week, status: 'closed', updatedAt: now });
    }
    setComplete(false);
  };

  const sectionHead = (icon, title, badge, action) => (
    <div className="ws-head">
      <span style={{ color: 'var(--accent)', display: 'grid', placeItems: 'center' }}>{icon}</span>
      <span className="card-title">{title}</span>
      {badge != null && <span className="ws-badge mono">{badge}</span>}
      <span className="grow" />
      {action}
    </div>
  );

  return (
    <div className="scroll-area fade-in">
      <div className="page-pad" style={{ maxWidth: 960 }}>
        {/* ---- header: week nav + complete ---- */}
        <div className="row between center mb16" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="row center" style={{ gap: 6 }}>
            <button className="icon-btn" title="Previous week" disabled={!prevW} onClick={() => prevW && setSelId(prevW.id)}><I.chevL size={18} /></button>
            <div style={{ textAlign: 'center', minWidth: 150 }}>
              <div className="dash-greet" style={{ fontSize: 22 }}>
                Week {week.weekNumber}
                {isCurrent && <span className="chip" style={{ marginLeft: 8, background: 'var(--accent-soft)', color: 'var(--accent)' }}>This week</span>}
                {week.status === 'closed' && <span className="chip" style={{ marginLeft: 8 }}>Completed</span>}
              </div>
              <div className="dash-date">{range}{week.carriedFrom ? ' · carried forward' : ''}</div>
            </div>
            <button className="icon-btn" title="Next week" disabled={!nextW} onClick={() => nextW && setSelId(nextW.id)}><I.chevR size={18} /></button>
          </div>
          <div className="row center" style={{ gap: 8 }}>
            {canEdit && (
              <button className="btn btn-ghost btn-sm" onClick={startNextWeek} title="Create the next week"><I.plus size={14} /> New week</button>
            )}
            {canEdit && week.status !== 'closed' && (
              <button className="btn btn-primary btn-sm" onClick={() => setComplete(true)}><I.check size={14} /> Complete Week</button>
            )}
            {canEdit && (
              <button className="icon-btn" title="Delete this week" onClick={() => setConfirmDel(true)}><I.trash size={16} /></button>
            )}
          </div>
        </div>

        {/* ---- summary cards ---- */}
        <div className="row center mb16" style={{ gap: 18, flexWrap: 'wrap' }}>
          <div className="row center" style={{ gap: 12 }}>
            <div style={{ position: 'relative', width: 56, height: 56 }}>
              <window.Ring value={pct} size={56} sw={6} color="var(--st-completed)" />
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 14 }}>{pct}%</div>
            </div>
            <div><div style={{ fontWeight: 700, fontSize: 15 }}>{completed.length}/{sel.length} done</div><div className="muted" style={{ fontSize: 12.5 }}>weekly completion</div></div>
          </div>
          <div className="kpi-grid grow" style={{ gridTemplateColumns: 'repeat(5, 1fr)', minWidth: 320 }}>
            {cards.map(s => (
              <div key={s.label} className="kpi" style={{ cursor: 'default', padding: '10px 12px' }}>
                <div className="kpi-val" style={{ color: s.color, fontSize: 24 }}>{s.val}</div>
                <div className="kpi-foot">{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ---- today's focus: what to work on next ---- */}
        <div className="ws-section" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent)' }}>
          {sectionHead(<I.flame size={16} />, "Today's Focus", null, null)}
          <div className="row wrap" style={{ gap: 8, marginBottom: focusList.length ? 10 : 0 }}>
            {focusChips.map(c => (
              <span key={c.label} className="chip" style={{ background: 'var(--surface)', fontWeight: 600 }}>
                <span style={{ color: c.color, fontWeight: 800, marginRight: 5 }}>{c.val}</span>{c.label}
              </span>
            ))}
          </div>
          {focusList.length > 0
            ? focusList.map(t => (
              <div key={t.id} className="ws-item" onClick={() => onOpenTask(t.id)} style={{ cursor: 'pointer', background: 'var(--surface)', borderRadius: 8, marginBottom: 4 }}>
                <span className="dot" style={{ background: (window.STATUS_META[t.status] || {}).c || 'var(--accent)', marginTop: 6 }} />
                <div className="grow"><div style={{ fontWeight: 600, fontSize: 13.5 }}>{t.title}</div>
                  <div className="att-meta"><window.PriorityTag priority={t.priority} />{t.dueDate && <><span className="faint">·</span><window.DueTag iso={t.dueDate} /></>}</div>
                </div><I.chevR size={16} className="faint" />
              </div>))
            : <div className="muted" style={{ fontSize: 13 }}>Nothing outstanding — pick tasks below to plan your week.</div>}
        </div>

        {/* ---- objectives ---- */}
        <div className="ws-section">
          {sectionHead(<I.flag size={16} />, 'Weekly Objectives', null,
            canEdit && <button className="btn btn-subtle btn-sm" onClick={() => { if (editObj) flushText(); setEditObj(e => !e); }}><I.edit size={13} /> {editObj ? 'Done' : 'Edit'}</button>)}
          {editObj
            ? <>
                {objDraft.map((o, i) => (
                  <div key={i} className="row center" style={{ gap: 8, marginBottom: 6 }}>
                    <span className="dot" style={{ background: 'var(--accent)' }} />
                    <input className="input grow" value={o} placeholder="Objective…" onChange={e => setObjective(i, e.target.value)} onBlur={flushText} />
                    <button className="icon-btn" onClick={() => removeObjective(i)}><I.trash size={15} /></button>
                  </div>
                ))}
                <button className="btn btn-subtle btn-sm" onClick={addObjective}><I.plus size={13} /> Add objective</button>
              </>
            : (week.objectives || []).filter(o => (o || '').trim()).length
              ? <ul style={{ margin: 0, paddingLeft: 4, listStyle: 'none' }}>
                  {week.objectives.filter(o => (o || '').trim()).map((o, i) => (
                    <li key={i} className="row" style={{ gap: 8, marginBottom: 6, alignItems: 'flex-start' }}>
                      <span className="dot" style={{ background: 'var(--accent)', marginTop: 7 }} />
                      <span style={{ fontSize: 14, lineHeight: 1.5 }}>{o}</span>
                    </li>
                  ))}
                </ul>
              : <div className="muted" style={{ fontSize: 13 }}>No objectives yet.{canEdit ? ' Click Edit to set this week’s goals.' : ''}</div>}
        </div>

        {/* ---- selected tasks (the focus of the page) ---- */}
        <div className="ws-section">
          {sectionHead(<I.list size={16} />, 'Selected Tasks', sel.length,
            canEdit && <button className="btn btn-primary btn-sm" onClick={() => setPicker(true)}><I.plus size={13} /> Add Task</button>)}
          {sel.length === 0
            ? <div className="muted" style={{ fontSize: 13, padding: '6px 0' }}>No tasks selected. Pick from the backlog to commit to this week.</div>
            : sel.map(t => (
              <div key={t.id} className="ws-item" style={{ cursor: 'pointer' }}>
                <span className="dot" style={{ background: (window.STATUS_META[t.status] || {}).c || 'var(--accent)', marginTop: 6 }} />
                <div className="grow" onClick={() => onOpenTask(t.id)}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t.title}</div>
                  <div className="att-meta">
                    <window.StatusPill status={t.status} /><span className="faint">·</span>
                    <window.PriorityTag priority={t.priority} />
                    {t.dueDate && <><span className="faint">·</span><window.DueTag iso={t.dueDate} /></>}
                  </div>
                </div>
                {canEdit && <button className="icon-btn" title="Remove from week" onClick={() => toggleTask(t.id)}><I.x size={15} /></button>}
              </div>
            ))}
        </div>

        {/* ---- generated reports (collapsed artifacts) ---- */}
        <div className="ws-section">
          {sectionHead(<I.summary size={16} />, 'Reports', null, null)}
          <ReportArtifact title="Monday Plan" eyebrow="Objectives, deliverables, planned work & risks" text={week.mondayReport} at={week.mondayReportAt} onView={() => setViewer('monday')} />
          <div style={{ height: 6 }} />
          <ReportArtifact title="Friday Summary" eyebrow="Executive summary of the week's progress" text={week.fridaySummary} at={week.fridaySummaryAt} onView={() => setViewer('friday')} />
        </div>

        {/* ---- notes (scratchpad, lowest priority) ---- */}
        <div className="ws-section">
          {sectionHead(<I.edit size={16} />, 'Notes', null, null)}
          <textarea className="input" rows={3} placeholder="Scratchpad — context, decisions, anything worth remembering this week…" value={notesDraft} disabled={!canEdit} onChange={e => setNotes(e.target.value)} onBlur={flushText} style={{ fontFamily: 'inherit' }} />
        </div>
      </div>

      {picker && <TaskPicker tasks={tasks} selectedIds={week.taskIds || []}
        excludeIds={new Set((weeks || []).filter(w => w.id !== week.id && w.status !== 'closed').flatMap(w => w.taskIds || []))}
        onToggle={toggleTask} onClose={() => setPicker(false)} />}
      {complete && <CompleteWeek week={week} incomplete={incomplete} onComplete={completeWeek} onClose={() => setComplete(false)} />}
      {viewer === 'monday' && <ReportModal title="Monday Plan" text={week.mondayReport} at={week.mondayReportAt} canEdit={canEdit} busy={busyM}
        onSave={(t) => patch({ mondayReport: t })} onGenerate={genMonday} onClose={() => setViewer(null)} />}
      {viewer === 'friday' && <ReportModal title="Friday Summary" text={week.fridaySummary} at={week.fridaySummaryAt} canEdit={canEdit} busy={busyF}
        onSave={(t) => patch({ fridaySummary: t })} onGenerate={genFriday} onClose={() => setViewer(null)} />}
      {confirmDel && (
        <window.Modal onClose={() => setConfirmDel(false)} width={440}>
          <div className="card-title">Delete Week {week.weekNumber}?</div>
          <p style={{ fontSize: 13.5, color: 'var(--text-2)', margin: '8px 0 4px' }}>
            This removes the week’s plan ({(week.taskIds || []).length} selected task{(week.taskIds || []).length === 1 ? '' : 's'}, objectives, notes & reports).
            Your tasks are <b>not</b> deleted — a week only references them.
          </p>
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDel(false)}>Cancel</button>
            <button className="btn btn-ghost btn-sm" onClick={removeWeek} style={{ color: 'var(--st-blocked)', borderColor: 'var(--st-blocked)' }}><I.trash size={14} /> Delete week</button>
          </div>
        </window.Modal>
      )}
    </div>
  );
}

window.WeeklyWorkspace = WeeklyWorkspace;
