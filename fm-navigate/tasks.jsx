/* ============================================================
   FM Navigate — Tasks (List + Kanban) + Task Detail
   ============================================================ */
const { useState: useStateT, useMemo: useMemoT, useRef: useRefT } = React;

/* ---------------- Tasks screen ---------------- */
function TasksScreen({ tasks, view, setView, onOpen, onCompose, onMove, onToggleDone, canEdit = true }) {
  const I = window.I;
  const [q, setQ] = useStateT('');
  const [fStatus, setFStatus] = useStateT('All');
  const [fPrio, setFPrio] = useStateT('All');

  const filtered = useMemoT(() => {
    return tasks.filter(t => {
      if (q && !(`${t.title} ${t.description} ${t.category}`.toLowerCase().includes(q.toLowerCase()))) return false;
      if (fStatus !== 'All' && t.status !== fStatus) return false;
      if (fPrio !== 'All' && t.priority !== fPrio) return false;
      return true;
    });
  }, [tasks, q, fStatus, fPrio]);

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
        <select className="select" style={{ width: 'auto' }} value={fStatus} onChange={e => setFStatus(e.target.value)}>
          <option>All</option>{window.STATUSES.map(s => <option key={s}>{s}</option>)}
        </select>
        <select className="select" style={{ width: 'auto' }} value={fPrio} onChange={e => setFPrio(e.target.value)}>
          <option value="All">All priorities</option>{window.PRIORITIES.map(p => <option key={p}>{p}</option>)}
        </select>
        <span className="grow" />
        <span className="muted mono" style={{ fontSize: 12 }}>{filtered.length} tasks</span>
        {canEdit && <button className="btn btn-primary btn-sm" onClick={onCompose}><I.spark size={14} /> New task</button>}
      </div>

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
          ? <ListView tasks={filtered} onOpen={onOpen} onToggleDone={onToggleDone} canEdit={canEdit} />
          : <KanbanView tasks={filtered} onOpen={onOpen} onMove={onMove} canEdit={canEdit} />}
    </div>
  );
}

/* ---------------- List view ---------------- */
const PRIO_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const STATUS_ORDER = { 'Not Started': 0, 'In Progress': 1, 'Waiting': 2, 'Blocked': 3, 'Completed': 4, 'Cancelled': 5 };
const SORT_KEYS = {
  // key: [comparator(a,b), defaultDir]
  title:    [(a, b) => a.title.localeCompare(b.title), 'asc'],
  status:   [(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status], 'asc'],
  priority: [(a, b) => (PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority]) || (new Date(a.dueDate || 8.64e15) - new Date(b.dueDate || 8.64e15)), 'asc'],
  due:      [(a, b) => new Date(a.dueDate || 8.64e15) - new Date(b.dueDate || 8.64e15), 'asc'],
  category: [(a, b) => a.category.localeCompare(b.category), 'asc'],
  owner:    [(a, b) => ((window.USERS[a.ownerId]?.name || '').localeCompare(window.USERS[b.ownerId]?.name || '')), 'asc'],
  progress: [(a, b) => (a.progress || 0) - (b.progress || 0), 'desc'],
};

function ListView({ tasks, onOpen, onToggleDone, canEdit = true }) {
  const I = window.I;
  const [sortKey, setSortKey] = useStateT('priority');
  const [sortDir, setSortDir] = useStateT('asc');

  const setSort = (key) => {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(SORT_KEYS[key][1]); }
  };

  const sorted = [...tasks].sort((a, b) => {
    const cmp = SORT_KEYS[sortKey][0](a, b);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const Th = ({ k, children, style }) => (
    <button className="tlist-th" onClick={() => setSort(k)} style={style}>
      {children}
      <span className="tlist-sort" style={{ opacity: sortKey === k ? 1 : 0.25 }}>
        <I.chevD size={12} style={{ transform: sortKey === k && sortDir === 'asc' ? 'rotate(180deg)' : 'none', transition: 'transform .12s' }} />
      </span>
    </button>
  );

  return (
    <div className="scroll-area fade-in">
      <div className="tlist">
        <div className="tlist-head">
          <span></span>
          <Th k="title">Task</Th>
          <Th k="status">Status</Th>
          <Th k="priority">Priority · Due</Th>
          <Th k="category">Category</Th>
          <Th k="owner">Owner</Th>
        </div>
        {sorted.map(t => {
          const done = t.status === 'Completed';
          const cancelled = t.status === 'Cancelled';
          return (
            <div key={t.id} className="trow" onClick={() => onOpen(t.id)}>
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
                {t.progress > 0 && !done && !cancelled && (
                  <div className="row gap8 center mt4" style={{ maxWidth: 220 }}>
                    <div className="grow"><window.Progress value={t.progress} height={4} /></div>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', flexShrink: 0 }}>{t.progress}%</span>
                  </div>
                )}
              </div>
              <div><window.StatusPill status={t.status} /></div>
              <div className="col" style={{ gap: 3 }}>
                <window.PriorityTag priority={t.priority} />
                <window.DueTag iso={t.dueDate} />
              </div>
              <div><window.CatChip category={t.category} /></div>
              <div className="row gap6 center">
                <window.Avatar user={t.ownerId} size={24} />
              </div>
            </div>
          );
        })}
        {sorted.length === 0 && <div className="empty">No tasks match your filters.</div>}
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
                    <window.DueTag iso={t.dueDate} />
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
   Log a % complete + a note + evidence (a link or an attached document). */
const MAX_FILE_BYTES = 1.5 * 1024 * 1024; // 1.5MB — kept small for localStorage

function ProgressLog({ task, onLog, canEdit, currentUser }) {
  const I = window.I;
  const log = [...(task.progressLog || [])].sort((a, b) => new Date(b.at) - new Date(a.at));
  const [open, setOpen] = useStateT(false);
  const [status, setStatus] = useStateT(task.status);
  const [pct, setPct] = useStateT(task.progress || 0);
  const [note, setNote] = useStateT('');
  const [links, setLinks] = useStateT(['']);
  const [files, setFiles] = useStateT([]); // [{ name, data, type }]
  const [err, setErr] = useStateT('');
  const [preview, setPreview] = useStateT(null); // { src, name } — in-app lightbox
  const fileRef = useRefT(null);

  const openForm = () => { setStatus(task.status); setPct(task.progress || 0); setNote(''); setLinks(['']); setFiles([]); setErr(''); setOpen(true); };

  const setLinkAt = (i, v) => setLinks(ls => ls.map((l, j) => j === i ? v : l));
  const addLink = () => setLinks(ls => [...ls, '']);
  const rmLink = (i) => setLinks(ls => ls.length === 1 ? [''] : ls.filter((_, j) => j !== i));

  const addFiles = (fileList) => {
    [...fileList].forEach(f => {
      if (f.size > MAX_FILE_BYTES) { setErr(`"${f.name}" is too large (max ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(1)}MB). Use a link instead.`); return; }
      const reader = new FileReader();
      reader.onload = () => setFiles(fs => [...fs, { name: f.name || 'pasted-image.png', data: reader.result, type: f.type || '' }]);
      reader.readAsDataURL(f);
    });
    setErr('');
  };
  const rmFile = (i) => setFiles(fs => fs.filter((_, j) => j !== i));
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

  const submit = () => {
    const cleanLinks = links.map(l => l.trim()).filter(Boolean);
    if (!note.trim() && !cleanLinks.length && !files.length) { setErr('Add a note, a link, or evidence before saving.'); return; }
    onLog(task.id, { status, percent: effPct, note: note.trim(), links: cleanLinks, files });
    setNote(''); setLinks(['']); setFiles([]); setErr(''); setOpen(false);
    if (fileRef.current) fileRef.current.value = '';
  };
  const isImg = (f) => (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name || '');

  return (
    <>
      <div className="section-eyebrow mt24 mb8" style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.trend size={13} /> Progress · {task.progress || 0}%</span>
        {canEdit && !open && <button className="btn btn-ghost btn-sm" onClick={openForm}><I.plus size={13} /> Log progress</button>}
      </div>

      <div className="mb12"><window.Progress value={task.progress || 0} height={8} /></div>

      {open && (
        <div className="card card-pad mb12 fade-in" style={{ background: 'var(--bg-sunken)' }} onPaste={onPaste}>
          <div className="row between center mb8">
            <span className="field-label" style={{ margin: 0 }}>Update — {effPct}% complete</span>
            <button className="icon-btn" onClick={() => { setOpen(false); setErr(''); }}><I.x size={15} /></button>
          </div>
          <div className="field mb8">
            <label className="field-label">Status</label>
            <select className="select" value={status} onChange={e => onStatusChange(e.target.value)}>
              {window.STATUSES.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <label className="field-label" style={{ marginBottom: 4 }}>% complete {pctLocked && <span className="faint" style={{ fontWeight: 400, textTransform: 'none' }}>· locked at 100% while Completed</span>}</label>
          <input type="range" min="0" max="100" step="5" value={effPct} disabled={pctLocked}
            onChange={e => setPct(+e.target.value)} style={{ width: '100%', accentColor: 'var(--accent)', opacity: pctLocked ? 0.5 : 1 }} />
          <textarea className="ai-textarea" style={{ minHeight: 64, marginTop: 10, fontSize: 13.5 }} placeholder="What progressed? (note)" value={note} onChange={e => setNote(e.target.value)} />
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
                  ? <div key={i} style={{ position: 'relative' }}>
                      <img src={f.data} alt={f.name} onClick={() => setPreview({ src: f.data, name: f.name })} style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', cursor: 'zoom-in' }} />
                      <button className="icon-btn" onClick={() => rmFile(i)} style={{ position: 'absolute', top: -7, right: -7, width: 20, height: 20, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 99 }}><I.x size={12} /></button>
                    </div>
                  : <span key={i} className="chip"><I.edit size={11} /> {f.name} <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => rmFile(i)}><I.x size={12} /></button></span>
              ))}
            </div>
          )}
          <div className="row between center mt8" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div className="row gap8 center" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}><I.plus size={13} /> Attach image / file</button>
              <input ref={fileRef} type="file" multiple accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.csv" style={{ display: 'none' }} onChange={e => { addFiles(e.target.files); if (fileRef.current) fileRef.current.value = ''; }} />
              <span className="faint" style={{ fontSize: 11 }}>or paste a screenshot (⌘V)</span>
            </div>
            <button className="btn btn-primary btn-sm" onClick={submit}><I.check size={13} /> Save update</button>
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
                <div key={e.id} className="comment" style={{ alignItems: 'flex-start' }}>
                  <window.Ring value={e.percent} size={34} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="comment-meta row gap8 center" style={{ flexWrap: 'wrap' }}><b style={{ color: 'var(--text)' }}>{e.percent}%</b>{e.status && <window.StatusPill status={e.status} />}<span>· {u?.name || 'Someone'} · {window.fmtRelTime(e.at)}</span></div>
                    {e.note && <div className="comment-body">{e.note}</div>}
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
                          {fs.map((f, i) => (
                            isImg(f) && f.data
                              ? <button key={'f' + i} type="button" onClick={() => setPreview({ src: f.data, name: f.name })} title={f.name} style={{ padding: 0, border: 'none', background: 'none', cursor: 'zoom-in' }}>
                                  <img src={f.data} alt={f.name} style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', display: 'block' }} />
                                </button>
                              : (f.data
                                ? <a key={'f' + i} className="chip" href={f.data} download={f.name} target="_blank" rel="noopener noreferrer"><I.edit size={11} /> {f.name}</a>
                                : <span key={'f' + i} className="chip"><I.edit size={11} /> {f.name}</span>)
                          ))}
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
function TaskEditPanel({ task, onSave, onCancel }) {
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
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const Lbl = ({ children }) => <label className="field-label" style={{ marginBottom: 5, marginTop: 14, display: 'block' }}>{children}</label>;

  const save = () => {
    onSave({
      title: f.title.trim(),
      description: f.description.trim(),
      successCriteria: f.successCriteria.trim(),
      dependencies: f.dependencies.split('\n').map(s => s.trim()).filter(Boolean),
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
      <Lbl>Dependencies <span className="faint" style={{ fontWeight: 400, textTransform: 'none' }}>· one per line</span></Lbl>
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
function TaskDetail({ task, deliverables = [], onClose, onUpdate, onAddComment, onToggleDone, onLogProgress, onEditTask, onRevertEdit, onAssignDeliverable, onOpenDeliverable, onAddResource, onDeleteResource, onDeleteTask, canEdit = true, currentUser = 'richard' }) {
  const I = window.I;
  const [comment, setComment] = useStateT('');
  const [editing, setEditing] = useStateT(false);
  if (!task) return null;
  const owner = window.USERS[task.ownerId];
  const dlv = deliverables.find(d => d.id === task.deliverableId);

  const fmtVal = (field, v) => {
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return '—';
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
              <TaskEditPanel task={task}
                onSave={(changes) => { onEditTask && onEditTask(task.id, changes); setEditing(false); }}
                onCancel={() => setEditing(false)} />
            ) : (
              <>
                <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.2, marginBottom: 18 }}>{task.title}</h1>

                <div className="section-eyebrow mb8" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.edit size={13} /> Description</div>
                <div className="desc-block mb16">{task.description}</div>

                {task.successCriteria && (
                  <>
                    <div className="section-eyebrow mb8" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.target size={13} /> Success criteria</div>
                    <div className="crit-item" style={{ background: 'var(--st-completed-bg)', borderRadius: 'var(--r-md)', padding: '11px 14px', marginBottom: 16 }}>
                      <span style={{ color: 'var(--st-completed)', marginTop: 1 }}><I.check size={16} /></span>
                      <span>{task.successCriteria}</span>
                    </div>
                  </>
                )}

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
                      <span>{task.risk}</span>
                    </div>
                  </>
                )}
              </>
            )}

            {/* change history */}
            {edits.length > 0 && (
              <>
                <div className="section-eyebrow mt24 mb8" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.clock size={13} /> Change history · {edits.length}</div>
                <div className="mb8">
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
                </div>
              </>
            )}

            {/* progress log */}
            <ProgressLog task={task} onLog={onLogProgress} canEdit={canEdit} currentUser={currentUser} />

            {/* resources — shared + private (per-item lock toggle) */}
            <div className="mt24">
              <window.ResourceList parentType="task" parentId={task.id} publicItems={task.resources || []}
                canEdit={canEdit}
                onAddPublic={(res) => onAddResource && onAddResource('task', task.id, res)}
                onDeletePublic={(id) => onDeleteResource && onDeleteResource('task', task.id, id)} />
            </div>

            {/* comments */}
            <div className="section-eyebrow mt24 mb8" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.msg size={13} /> Comments · {task.comments?.length || 0}</div>
            <div>
              {(task.comments || []).map(c => {
                const u = window.USERS[c.userId];
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
                  : <span className="meta-v"><window.DueTag iso={task.dueDate} /></span>}
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
                  const u = window.USERS[a.userId];
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
