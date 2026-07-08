/* ============================================================
   FM Navigate — Deliverables (nested tree)
   A Deliverable is a parent milestone. Deliverables nest to any
   depth via parentId. Tasks attach to ANY node via deliverableId.
   Rollups aggregate the whole subtree (descendants + their tasks).
   Stored in the shared blob tagged kind:'deliverable'.
   ============================================================ */
const { useState: useStateD, useMemo: useMemoD, useEffect: useEffectD } = React;

/* ---- tree helpers (also exported for the dashboard) ---- */
function childrenOf(id, deliverables) {
  return deliverables.filter(d => (d.parentId || null) === (id || null));
}
function subtreeIds(id, deliverables) {
  const out = [id];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    deliverables.forEach(d => { if ((d.parentId || null) === cur) { out.push(d.id); stack.push(d.id); } });
  }
  return out;
}
function pathOf(id, deliverables) {
  const map = {};
  deliverables.forEach(d => { map[d.id] = d; });
  const path = [];
  let cur = map[id];
  let guard = 0;
  while (cur && guard++ < 50) { path.unshift(cur); cur = cur.parentId ? map[cur.parentId] : null; }
  return path;
}
// rolled-up stats over the node's whole subtree
function rollup(id, tasks, deliverables) {
  const ids = new Set(subtreeIds(id, deliverables));
  const kids = tasks.filter(t => ids.has(t.deliverableId));
  const direct = tasks.filter(t => t.deliverableId === id);
  const live = kids.filter(t => t.status !== 'Cancelled');
  const done = kids.filter(t => t.status === 'Completed').length;
  const blocked = kids.filter(t => t.status === 'Blocked').length;
  const progress = live.length ? Math.round(live.reduce((s, t) => s + (t.progress || 0), 0) / live.length) : 0;
  return { kids, direct, total: kids.length, done, blocked, progress, subCount: childrenOf(id, deliverables).length };
}

const DLV_STATUS_META = {
  'Active':    { c: 'var(--accent)',       bg: 'var(--accent-soft)' },
  'On Hold':   { c: 'var(--st-waiting)',   bg: 'var(--st-waiting-bg)' },
  'Delivered': { c: 'var(--st-completed)', bg: 'var(--st-completed-bg)' },
  'Cancelled': { c: 'var(--muted)',        bg: 'var(--surface-2)' },
};
function DlvStatusPill({ status }) {
  const m = DLV_STATUS_META[status] || DLV_STATUS_META['Active'];
  return <span className="chip" style={{ color: m.c, background: m.bg, borderColor: 'transparent', fontWeight: 600 }}>{status}</span>;
}

/* ---- deliverable category (A–E functional buckets) ---- */
function dlvCat(code) {
  return (window.DELIVERABLE_CATEGORIES || []).find(c => c.code === code) || null;
}
function DlvCatBadge({ code, full }) {
  const c = dlvCat(code);
  if (!c) return null;
  return (
    <span className="chip" title={c.label}
      style={{ fontWeight: 700, gap: 5, maxWidth: full ? 'none' : 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      <span style={{ color: 'var(--accent)' }}>{c.code}</span>{full ? ` · ${c.label}` : ''}
    </span>
  );
}

/* ---- delivery model (one-time / recurring / target-based) ---- */
function deliveryType(code) {
  const list = window.DELIVERY_TYPES || [];
  return list.find(t => t.code === code) || list[0] || { code: 'one-time', label: 'One-Time' };
}
const DLV_TYPE_ICON = { 'one-time': 'target', 'recurring': 'refresh', 'target-based': 'trend' };
// progress for a target-based deliverable: current/target, capped at 100
function targetProgress(d) {
  const tv = Number(d.targetValue) || 0;
  const cv = Number(d.currentValue) || 0;
  if (tv <= 0) return 0;
  return Math.min(100, Math.round((cv / tv) * 100));
}
function DlvTypeBadge({ type }) {
  const I = window.I;
  const t = deliveryType(type);
  const Icon = I[DLV_TYPE_ICON[t.code] || 'target'];
  return (
    <span className="chip" title={t.hint || t.label} style={{ gap: 5, fontWeight: 600, color: 'var(--muted)' }}>
      <Icon size={12} /> {t.label}
    </span>
  );
}

/* ---- compact chip used on task rows / detail ---- */
function DeliverableChip({ deliverable, onClick }) {
  const I = window.I;
  if (!deliverable) return null;
  return (
    <span className="chip" onClick={onClick} title={deliverable.title}
      style={{ cursor: onClick ? 'pointer' : 'default', gap: 5, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      <I.flag size={12} /> {deliverable.title}
    </span>
  );
}

/* ---- dropdown picker (task edit / detail) — indents to show nesting ---- */
function DeliverablePicker({ value, deliverables, onChange }) {
  // ordered, depth-indented options
  const opts = [];
  const walk = (parentId, depth) => {
    childrenOf(parentId, deliverables).forEach(d => {
      opts.push({ id: d.id, label: `${'  '.repeat(depth)}${depth ? '└ ' : ''}${d.title}` });
      walk(d.id, depth + 1);
    });
  };
  walk(null, 0);
  return (
    <select className="input" value={value || ''} onChange={e => onChange(e.target.value || null)}>
      <option value="">— No deliverable —</option>
      {opts.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

/* ---- create form (top-level or sub) — adapts to the chosen delivery model ---- */
function DeliverableForm({ onCreate, onCancel, parentTitle }) {
  const I = window.I;
  const [f, setF] = useStateD({
    deliveryType: 'one-time',
    title: '', description: '', category: '', ownerId: '', status: 'Active',
    startDate: '', targetDate: '',
    recurrence: '', currentCycle: '',
    targetValue: '', currentValue: '', unit: '',
  });
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const iso = (v) => v ? new Date(v + 'T17:00:00').toISOString() : null;
  const dateLabel = { 'one-time': 'Due date', 'recurring': 'Next due date', 'target-based': 'Deadline' }[f.deliveryType];

  const submit = () => {
    if (!f.title.trim()) return;
    const base = {
      deliveryType: f.deliveryType,
      title: f.title.trim(),
      description: f.description.trim(),
      category: f.category || null,
      ownerId: f.ownerId || null,
      status: f.status,
      targetDate: iso(f.targetDate),
    };
    if (f.deliveryType === 'one-time') base.startDate = iso(f.startDate);
    if (f.deliveryType === 'recurring') {
      base.recurrence = f.recurrence.trim() || null;
      base.currentCycle = f.currentCycle.trim() || null;
      base.instances = [];
    }
    if (f.deliveryType === 'target-based') {
      base.targetValue = f.targetValue === '' ? null : Number(f.targetValue);
      base.currentValue = f.currentValue === '' ? 0 : Number(f.currentValue);
      base.unit = f.unit.trim() || null;
    }
    onCreate(base);
  };

  const Field = ({ label, children, minWidth = 160 }) => (
    <div style={{ flex: 1, minWidth }}>
      <label className="field-label" style={{ marginBottom: 5, display: 'block' }}>{label}</label>
      {children}
    </div>
  );

  return (
    <div className="card card-pad mb16">
      <div className="section-eyebrow mb12" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <I.target size={13} /> {parentTitle ? `New sub-deliverable under “${parentTitle}”` : 'New deliverable'}
      </div>

      {/* delivery model picker */}
      <label className="field-label" style={{ marginBottom: 6, display: 'block' }}>Delivery type</label>
      <div className="seg" style={{ marginBottom: 6, flexWrap: 'wrap' }}>
        {(window.DELIVERY_TYPES || []).map(t => {
          const Icon = I[DLV_TYPE_ICON[t.code] || 'target'];
          return (
            <button key={t.code} className={f.deliveryType === t.code ? 'active' : ''} onClick={() => set('deliveryType', t.code)}>
              <Icon size={13} /> {t.label}
            </button>
          );
        })}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>{deliveryType(f.deliveryType).hint}</div>

      <label className="field-label" style={{ marginBottom: 5, display: 'block' }}>Title</label>
      <input className="input" autoFocus value={f.title} placeholder="e.g. Architecture Assessment Scope & Engagement Package"
        onChange={e => set('title', e.target.value)} />

      <label className="field-label" style={{ marginBottom: 5, marginTop: 14, display: 'block' }}>Description</label>
      <textarea className="ai-textarea" style={{ minHeight: 80, fontSize: 13.5 }} value={f.description}
        placeholder="What this milestone delivers, and what 'done' means." onChange={e => set('description', e.target.value)} />

      <div className="row gap12 mt12" style={{ flexWrap: 'wrap' }}>
        <Field label="Category">
          <select className="input" value={f.category} onChange={e => set('category', e.target.value)}>
            <option value="">— Uncategorized —</option>
            {window.DELIVERABLE_CATEGORIES.map(c => <option key={c.code} value={c.code}>{c.code}. {c.label}</option>)}
          </select>
        </Field>
        <Field label="Owner">
          <select className="input" value={f.ownerId} onChange={e => set('ownerId', e.target.value)}>
            <option value="">— Me (default) —</option>
            {Object.values(window.USERS).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select className="input" value={f.status} onChange={e => set('status', e.target.value)}>
            {window.DELIVERABLE_STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
        </Field>
      </div>

      {/* one-time */}
      {f.deliveryType === 'one-time' && (
        <div className="row gap12 mt12" style={{ flexWrap: 'wrap' }}>
          <Field label="Start date"><input type="date" className="input" value={f.startDate} onChange={e => set('startDate', e.target.value)} /></Field>
          <Field label={dateLabel}><input type="date" className="input" value={f.targetDate} onChange={e => set('targetDate', e.target.value)} /></Field>
        </div>
      )}

      {/* recurring */}
      {f.deliveryType === 'recurring' && (
        <div className="row gap12 mt12" style={{ flexWrap: 'wrap' }}>
          <Field label="Recurrence"><input className="input" list="dlv-recurrence" placeholder="e.g. Every 2 weeks" value={f.recurrence} onChange={e => set('recurrence', e.target.value)} />
            <datalist id="dlv-recurrence"><option value="Weekly" /><option value="Every 2 weeks" /><option value="Monthly" /><option value="Quarterly" /></datalist>
          </Field>
          <Field label="Current cycle"><input className="input" placeholder="e.g. Sprint 59" value={f.currentCycle} onChange={e => set('currentCycle', e.target.value)} /></Field>
          <Field label={dateLabel}><input type="date" className="input" value={f.targetDate} onChange={e => set('targetDate', e.target.value)} /></Field>
        </div>
      )}

      {/* target-based */}
      {f.deliveryType === 'target-based' && (
        <div className="row gap12 mt12" style={{ flexWrap: 'wrap' }}>
          <Field label="Target" minWidth={100}><input type="number" className="input" placeholder="e.g. 3" value={f.targetValue} onChange={e => set('targetValue', e.target.value)} /></Field>
          <Field label="Current" minWidth={100}><input type="number" className="input" placeholder="e.g. 1" value={f.currentValue} onChange={e => set('currentValue', e.target.value)} /></Field>
          <Field label="Unit" minWidth={120}><input className="input" placeholder="e.g. clients" value={f.unit} onChange={e => set('unit', e.target.value)} /></Field>
          <Field label={dateLabel}><input type="date" className="input" value={f.targetDate} onChange={e => set('targetDate', e.target.value)} /></Field>
        </div>
      )}

      <div className="row gap8 mt16">
        <button className="btn btn-primary btn-sm" onClick={submit}><I.check size={13} /> Create</button>
        <button className="btn btn-subtle btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* ---- one row in the list / sub-deliverable list ---- */
function DlvCard({ d, tasks, deliverables, onOpen }) {
  const I = window.I;
  const r = rollup(d.id, tasks, deliverables);
  const type = d.deliveryType || 'one-time';
  const isTarget = type === 'target-based';
  const isRecurring = type === 'recurring';
  const progress = isTarget ? targetProgress(d) : r.progress;
  return (
    <button className="card card-pad" onClick={() => onOpen(d.id)}
      style={{ textAlign: 'left', cursor: 'pointer', width: '100%', display: 'block' }}>
      <div className="row between center" style={{ marginBottom: 8 }}>
        <div className="row gap8 center" style={{ minWidth: 0 }}>
          <span style={{ color: 'var(--accent)' }}><I.flag size={15} /></span>
          <span style={{ fontWeight: 700, fontSize: 15.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
        </div>
        <span className="row gap6 center" style={{ flexShrink: 0 }}>
          <DlvTypeBadge type={type} />
          {d.category && <DlvCatBadge code={d.category} />}
          <DlvStatusPill status={d.status} />
        </span>
      </div>
      {d.description && <div className="muted" style={{ fontSize: 12.5, marginBottom: 12, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{d.description}</div>}
      <div className="row gap12 center" style={{ marginBottom: 6 }}>
        <div className="grow"><window.Progress value={progress} height={6} /></div>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{progress}%</span>
      </div>
      <div className="row gap12 center" style={{ fontSize: 12, color: 'var(--muted)' }}>
        {isTarget
          ? <span>{(d.currentValue ?? 0)}/{d.targetValue ?? '—'}{d.unit ? ` ${d.unit}` : ''}</span>
          : isRecurring
            ? <span>{d.currentCycle || d.recurrence || 'Recurring'}{(d.instances || []).length ? ` · ${d.instances.length} cycles` : ''}</span>
            : <span>{r.done}/{r.total} done{r.subCount > 0 ? ` · ${r.subCount} sub` : ''}</span>}
        {!isTarget && !isRecurring && r.blocked > 0 && <span style={{ color: 'var(--st-blocked)' }}>· {r.blocked} blocked</span>}
        {d.targetDate && <span>· <window.DueTag iso={d.targetDate} /></span>}
      </div>
    </button>
  );
}

/* ---- list / index screen (top-level deliverables) ---- */
function DeliverablesScreen({ deliverables, tasks, canEdit, onOpen, onCreate }) {
  const I = window.I;
  const [creating, setCreating] = useStateD(false);
  const roots = childrenOf(null, deliverables);
  const unassigned = tasks.filter(t => !t.deliverableId && !['Completed', 'Cancelled'].includes(t.status)).length;

  // group top-level deliverables into the A–E functional buckets (+ Uncategorized)
  const cats = window.DELIVERABLE_CATEGORIES || [];
  const groups = [
    ...cats.map(c => ({ code: c.code, label: c.label, items: roots.filter(d => d.category === c.code) })),
    { code: null, label: 'Uncategorized', items: roots.filter(d => !d.category || !cats.some(c => c.code === d.category)) },
  ].filter(g => g.items.length > 0);

  return (
    <div className="scroll-area fade-in">
      <div className="page-pad" style={{ maxWidth: 920 }}>
        <div className="row between center mb4">
          <div>
            <div className="dash-greet" style={{ fontSize: 23 }}>Deliverables</div>
            <div className="dash-date">{deliverables.length} milestone{deliverables.length === 1 ? '' : 's'} · {unassigned} active task{unassigned === 1 ? '' : 's'} unassigned</div>
          </div>
          {canEdit && !creating && (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><I.plus size={14} /> New deliverable</button>
          )}
        </div>

        <div style={{ height: 14 }} />
        {creating && <DeliverableForm onCreate={(d) => { onCreate(d); setCreating(false); }} onCancel={() => setCreating(false)} />}

        {roots.length === 0 && !creating && (
          <div className="card card-pad" style={{ textAlign: 'center', padding: '40px 20px' }}>
            <div style={{ color: 'var(--muted)', marginBottom: 12 }}><I.target size={28} /></div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>No deliverables yet</div>
            <div className="muted" style={{ fontSize: 13 }}>Create a milestone, then nest sub-deliverables and assign tasks under it.</div>
          </div>
        )}

        <div className="col" style={{ gap: 24 }}>
          {groups.map(g => (
            <div key={g.code || 'none'} className="col gap12">
              <div className="row gap8 center" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                {g.code && <span className="chip" style={{ fontWeight: 800, color: 'var(--accent)' }}>{g.code}</span>}
                <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: '0.01em' }}>{g.label}</span>
                <span className="faint" style={{ fontSize: 12.5 }}>· {g.items.length}</span>
              </div>
              {g.items.map(d => <DlvCard key={d.id} d={d} tasks={tasks} deliverables={deliverables} onOpen={onOpen} />)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---- Resources (links + notes) on a task or deliverable ----
   One unified list. Each resource is either SHARED (everyone sees it; lives in
   the workspace blob; only the editor can change it) or PRIVATE (only you see
   it; lives in Supabase under per-user RLS). A per-item lock toggles between
   the two. parentType: 'task' | 'deliverable'.
   onAddPublic(res) / onDeletePublic(id) mutate the shared blob (editor only). */
function ResourceList({ parentType, parentId, publicItems = [], canEdit, onAddPublic, onDeletePublic }) {
  const I = window.I;
  const ds = window.dataService;
  const vault = ds && ds.authReady && ds.authReady(); // private storage available
  const [priv, setPriv] = useStateD([]);
  const [err, setErr] = useStateD('');
  const [adding, setAdding] = useStateD(false);
  const [busy, setBusy] = useStateD(false);
  const [f, setF] = useStateD({ kind: 'link', title: '', url: '', note: '', private: !canEdit });

  const refresh = () => {
    if (!vault) { setPriv([]); return; }
    ds.listResources(parentType, parentId).then(rows => setPriv((rows || []).map(r => ({ ...r, _private: true }))));
  };
  useEffectD(() => { refresh(); }, [parentType, parentId, vault]);

  const items = [
    ...publicItems.map(r => ({ ...r, _private: false })),
    ...priv,
  ];

  const resetForm = () => setF({ kind: 'link', title: '', url: '', note: '', private: !canEdit });

  const doAdd = async () => {
    setErr('');
    if (!f.title.trim() && !f.url.trim()) { setErr('Add a title or a link.'); return; }
    const payload = { kind: f.kind, title: f.title.trim(), url: f.url.trim(), note: f.note.trim() };
    if (f.private) {
      if (!vault) { setErr('Private storage unavailable.'); return; }
      setBusy(true);
      const r = await ds.addResource({ parentType, parentId, ...payload });
      setBusy(false);
      if (!r.ok) { setErr(r.error || 'Could not save.'); return; }
      refresh();
    } else {
      if (!canEdit) { setErr('Only the editor can add shared resources.'); return; }
      onAddPublic && onAddPublic(payload);
    }
    resetForm(); setAdding(false);
  };

  const doDelete = async (it) => {
    setErr('');
    if (it._private) {
      const r = await ds.deleteResource(it.id);
      if (r.ok) refresh(); else setErr(r.error || 'Could not delete.');
    } else {
      onDeletePublic && onDeletePublic(it.id);
    }
  };

  // flip an item between shared and private (touches the shared blob → editor only)
  const doToggle = async (it) => {
    setErr('');
    if (!canEdit || !vault) return;
    const base = { kind: it.kind, title: it.title || '', url: it.url || '', note: it.note || '' };
    setBusy(true);
    if (it._private) {
      // private → shared
      const r = await ds.deleteResource(it.id);
      if (r.ok) { onAddPublic && onAddPublic(base); refresh(); } else setErr(r.error || 'Could not move.');
    } else {
      // shared → private
      const r = await ds.addResource({ parentType, parentId, ...base });
      if (r.ok) { onDeletePublic && onDeletePublic(it.id); refresh(); } else setErr(r.error || 'Could not move.');
    }
    setBusy(false);
  };

  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };
  // clean display label for a bare link: host + path, query/hash dropped, length-capped.
  // keeps long SharePoint/query-string URLs from filling the row — full URL stays in href.
  const pretty = (u) => {
    try {
      const x = new URL(u);
      const path = decodeURIComponent(x.pathname).replace(/\/+$/, '');
      const s = x.hostname.replace(/^www\./, '') + path;
      return s.length > 64 ? s.slice(0, 63) + '…' : s;
    } catch (_) { return u; }
  };
  const canAdd = canEdit || vault; // editor can add shared; any signed-in user can add private

  return (
    <div className="card card-pad mt16">
      <div className="row between center mb8">
        <div className="section-eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <I.link size={13} /> Resources
        </div>
        {canAdd && !adding && <button className="btn btn-subtle btn-sm" onClick={() => { resetForm(); setAdding(true); }}><I.plus size={13} /> Add resource</button>}
      </div>

      {items.length === 0 && !adding && (
        <div className="muted" style={{ fontSize: 12.5 }}>No resources yet. Add links (ChatGPT, Gemini, NotebookLM…) or notes — keep them shared or mark them private to you.</div>
      )}

      <div className="col gap8">
        {items.map(it => (
          <div key={(it._private ? 'p' : 's') + it.id} className="row gap10 center" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <span className="faint" style={{ flexShrink: 0 }}>{it.kind === 'note' ? <I.edit size={14} /> : <I.link size={14} />}</span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row gap6 center" style={{ minWidth: 0 }}>
                {it.url
                  ? <a href={it.url} target="_blank" rel="noopener noreferrer" title={it.url} style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--accent)', display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title || pretty(it.url)}</a>
                  : <span style={{ fontSize: 13.5, fontWeight: 600, display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</span>}
                {it._private
                  ? <span className="chip" style={{ fontSize: 10, padding: '1px 6px', flexShrink: 0 }} title="Only you can see this"><I.lock size={10} /> only you</span>
                  : <span className="chip" style={{ fontSize: 10, padding: '1px 6px', flexShrink: 0, color: 'var(--muted)' }} title="Everyone in the workspace sees this">shared</span>}
                {it.url && it.title && host(it.url) && <span className="faint" style={{ fontSize: 11, flexShrink: 0 }}>{host(it.url)}</span>}
              </div>
              {it.note && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{it.note}</div>}
            </div>
            {canEdit && vault && (
              <button className="icon-btn" title={it._private ? 'Make shared' : 'Make private (only you)'} onClick={() => doToggle(it)} disabled={busy} style={{ flexShrink: 0 }}>
                {it._private ? <I.unlock size={14} /> : <I.lock size={14} />}
              </button>
            )}
            {(it._private || canEdit) && (
              <button className="icon-btn" title="Delete" onClick={() => doDelete(it)} style={{ flexShrink: 0 }}><I.x size={15} /></button>
            )}
          </div>
        ))}
      </div>

      {adding && (
        <div className="col gap8 mt12" style={{ maxWidth: 480 }}>
          <div className="row gap8 center">
            <select className="input" style={{ width: 110 }} value={f.kind} onChange={e => setF(s => ({ ...s, kind: e.target.value }))}>
              <option value="link">Link</option>
              <option value="note">Note</option>
            </select>
            <input className="input grow" placeholder="Title (e.g. ChatGPT — architecture chat)" value={f.title} onChange={e => setF(s => ({ ...s, title: e.target.value }))} />
          </div>
          {f.kind === 'link' && <input className="input" placeholder="https://chat.openai.com/…" value={f.url} onChange={e => setF(s => ({ ...s, url: e.target.value }))} />}
          <textarea className="ai-textarea" style={{ minHeight: 50, fontSize: 13 }} placeholder="Note (optional)" value={f.note} onChange={e => setF(s => ({ ...s, note: e.target.value }))} />
          {/* shared vs private */}
          {vault && (
            <div className="seg" style={{ alignSelf: 'flex-start' }}>
              <button className={!f.private ? 'active' : ''} disabled={!canEdit} title={canEdit ? '' : 'Only the editor can add shared resources'} onClick={() => setF(s => ({ ...s, private: false }))}><I.link size={13} /> Shared</button>
              <button className={f.private ? 'active' : ''} onClick={() => setF(s => ({ ...s, private: true }))}><I.lock size={13} /> Private (only me)</button>
            </div>
          )}
          <div className="row gap8">
            <button className="btn btn-primary btn-sm" onClick={doAdd} disabled={busy}><I.check size={13} /> Save</button>
            <button className="btn btn-subtle btn-sm" onClick={() => { setAdding(false); setErr(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {err && <div style={{ color: 'var(--st-blocked)', fontSize: 12, marginTop: 8 }}>{err}</div>}
    </div>
  );
}

/* ---- recurring: per-cycle instance log ---- */
const DLV_INSTANCE_STATUSES = ['Active', 'Completed', 'Skipped'];
function InstanceLog({ deliverable, canEdit, onEdit }) {
  const I = window.I;
  const instances = [...(deliverable.instances || [])].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const [adding, setAdding] = useStateD(false);
  const [f, setF] = useStateD({ label: '', date: '', status: 'Active' });

  const save = (next) => onEdit(deliverable.id, { instances: next });
  const add = () => {
    if (!f.label.trim()) return;
    const item = {
      id: 'in-' + Date.now().toString(36),
      label: f.label.trim(),
      date: f.date ? new Date(f.date + 'T17:00:00').toISOString() : null,
      status: f.status,
    };
    save([...(deliverable.instances || []), item]);
    setF({ label: '', date: '', status: 'Active' });
    setAdding(false);
  };
  const setStatus = (id, status) => save((deliverable.instances || []).map(i => i.id === id ? { ...i, status } : i));
  const remove = (id) => save((deliverable.instances || []).filter(i => i.id !== id));

  const stColor = { Active: 'var(--accent)', Completed: 'var(--st-completed)', Skipped: 'var(--muted)' };

  return (
    <div className="card card-pad mb16">
      <div className="row between center mb8">
        <div className="section-eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.refresh size={13} /> Cycle history</div>
        {canEdit && !adding && <button className="btn btn-subtle btn-sm" onClick={() => setAdding(true)}><I.plus size={13} /> Log a cycle</button>}
      </div>

      {instances.length === 0 && !adding && (
        <div className="muted" style={{ fontSize: 12.5 }}>No cycles logged yet. Log each occurrence as it runs.</div>
      )}

      <div className="col gap8">
        {instances.map(i => (
          <div key={i.id} className="row gap10 center" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: stColor[i.status] || 'var(--muted)', flexShrink: 0 }} />
            <span className="grow" style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.label}</span>
            {i.date && <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>{window.fmtDate(i.date)}</span>}
            {canEdit
              ? <select className="input" style={{ width: 'auto', padding: '3px 6px', fontSize: 12 }} value={i.status} onChange={e => setStatus(i.id, e.target.value)}>
                  {DLV_INSTANCE_STATUSES.map(s => <option key={s}>{s}</option>)}
                </select>
              : <span className="chip" style={{ fontSize: 11, color: stColor[i.status] }}>{i.status}</span>}
            {canEdit && <button className="icon-btn" title="Remove" onClick={() => remove(i.id)} style={{ flexShrink: 0 }}><I.x size={15} /></button>}
          </div>
        ))}
      </div>

      {adding && (
        <div className="row gap8 center mt12" style={{ flexWrap: 'wrap' }}>
          <input className="input" style={{ flex: 1, minWidth: 140 }} autoFocus placeholder="Cycle label (e.g. Sprint 60)" value={f.label} onChange={e => setF(s => ({ ...s, label: e.target.value }))} />
          <input type="date" className="input" style={{ width: 150 }} value={f.date} onChange={e => setF(s => ({ ...s, date: e.target.value }))} />
          <select className="input" style={{ width: 'auto' }} value={f.status} onChange={e => setF(s => ({ ...s, status: e.target.value }))}>
            {DLV_INSTANCE_STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
          <button className="btn btn-primary btn-sm" onClick={add}><I.check size={13} /> Add</button>
          <button className="btn btn-subtle btn-sm" onClick={() => { setAdding(false); setF({ label: '', date: '', status: 'Active' }); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

/* ---- detail: breadcrumb + rollup + sub-deliverables + tasks ---- */
function DeliverableDetail({ deliverable, deliverables, tasks, canEdit, currentUser, onBack, onOpen, onOpenTask, onCreate, onEdit, onDelete, onAssign, onAddResource, onDeleteResource }) {
  const I = window.I;
  const [picking, setPicking] = useStateD(false);
  const [addingSub, setAddingSub] = useStateD(false);
  const [editingHead, setEditingHead] = useStateD(false);
  const [head, setHead] = useStateD({ title: '', description: '' });
  if (!deliverable) return null;
  const r = rollup(deliverable.id, tasks, deliverables);
  const owner = window.USERS[deliverable.ownerId];
  const type = deliverable.deliveryType || 'one-time';
  const tProg = targetProgress(deliverable);

  // inline-edit helpers (editor only)
  const isoIn = (v) => v ? new Date(v + 'T17:00:00').toISOString() : null;
  const dval = (iso) => iso ? new Date(iso).toISOString().slice(0, 10) : '';
  const edit = (changes) => onEdit(deliverable.id, changes);
  const DateField = ({ label, field, due }) => (
    <div className="col" style={{ gap: 3 }}>
      <span className="muted" style={{ fontSize: 11.5 }}>{label}</span>
      {canEdit
        ? <input type="date" className="input" style={{ width: 150, padding: '4px 8px', fontSize: 12.5 }}
            value={dval(deliverable[field])} onChange={e => edit({ [field]: isoIn(e.target.value) })} />
        : <span style={{ fontSize: 13, fontWeight: 600 }}>{deliverable[field] ? (due ? <window.DueTag iso={deliverable[field]} /> : window.fmtDate(deliverable[field])) : '—'}</span>}
    </div>
  );
  const TextField = ({ label, field, placeholder, width = 150 }) => (
    <div className="col" style={{ gap: 3 }}>
      <span className="muted" style={{ fontSize: 11.5 }}>{label}</span>
      {canEdit
        ? <input className="input" style={{ width, padding: '4px 8px', fontSize: 12.5 }} placeholder={placeholder}
            value={deliverable[field] || ''} onChange={e => edit({ [field]: e.target.value })} />
        : <span style={{ fontSize: 13, fontWeight: 600 }}>{deliverable[field] || '—'}</span>}
    </div>
  );
  const path = pathOf(deliverable.id, deliverables);
  const subs = childrenOf(deliverable.id, deliverables);
  const directTasks = tasks.filter(t => t.deliverableId === deliverable.id)
    .sort((a, b) => (a.status === 'Completed' ? 1 : 0) - (b.status === 'Completed' ? 1 : 0));
  const candidates = useMemoD(
    () => tasks.filter(t => !t.deliverableId && t.status !== 'Cancelled'),
    [tasks]
  );

  const cycleStatus = () => {
    const order = window.DELIVERABLE_STATUSES;
    const i = order.indexOf(deliverable.status);
    onEdit(deliverable.id, { status: order[(i + 1) % order.length] });
  };

  return (
    <div className="scroll-area fade-in">
      <div style={{ padding: '16px 28px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-subtle btn-sm" onClick={onBack}><I.chevL size={15} /> Deliverables</button>
        {/* breadcrumb */}
        {path.map((p, i) => (
          <span key={p.id} className="row gap6 center" style={{ minWidth: 0 }}>
            <I.chevR size={13} className="faint" />
            {i < path.length - 1
              ? <button className="btn-link" onClick={() => onOpen(p.id)} style={{ background: 'none', border: 0, color: 'var(--muted)', cursor: 'pointer', fontSize: 12.5, padding: 0, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</button>
              : <span style={{ fontSize: 12.5, fontWeight: 600, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>}
          </span>
        ))}
        <span className="grow" />
        {canEdit
          ? <select className="input" style={{ width: 'auto' }} value={deliverable.deliveryType || 'one-time'}
              onChange={e => onEdit(deliverable.id, { deliveryType: e.target.value })} title="Delivery type">
              {window.DELIVERY_TYPES.map(t => <option key={t.code} value={t.code}>{t.label}</option>)}
            </select>
          : <DlvTypeBadge type={deliverable.deliveryType} />}
        {canEdit
          ? <select className="input" style={{ width: 'auto', maxWidth: 240 }} value={deliverable.category || ''}
              onChange={e => onEdit(deliverable.id, { category: e.target.value || null })} title="Category">
              <option value="">— Uncategorized —</option>
              {window.DELIVERABLE_CATEGORIES.map(c => <option key={c.code} value={c.code}>{c.code}. {c.label}</option>)}
            </select>
          : (deliverable.category && <DlvCatBadge code={deliverable.category} full />)}
        {canEdit
          ? <button className="btn btn-subtle btn-sm" onClick={cycleStatus} title="Click to change status"><DlvStatusPill status={deliverable.status} /></button>
          : <DlvStatusPill status={deliverable.status} />}
      </div>

      <div className="page-pad" style={{ paddingTop: 24, maxWidth: 920 }}>
        {editingHead ? (
          <div className="card card-pad mb16">
            <label className="field-label" style={{ marginBottom: 5, display: 'block' }}>Title</label>
            <input className="input" autoFocus value={head.title} onChange={e => setHead(s => ({ ...s, title: e.target.value }))} />
            <label className="field-label" style={{ marginBottom: 5, marginTop: 14, display: 'block' }}>Description</label>
            <textarea className="ai-textarea" style={{ minHeight: 80, fontSize: 13.5 }} value={head.description}
              placeholder="What this milestone delivers, and what 'done' means." onChange={e => setHead(s => ({ ...s, description: e.target.value }))} />
            <div className="row gap8 mt16">
              <button className="btn btn-primary btn-sm" disabled={!head.title.trim()}
                onClick={() => { if (!head.title.trim()) return; edit({ title: head.title.trim(), description: head.description.trim() }); setEditingHead(false); }}>
                <I.check size={13} /> Save
              </button>
              <button className="btn btn-subtle btn-sm" onClick={() => setEditingHead(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <div className="row gap10 center mb12">
              <span style={{ color: 'var(--accent)' }}><I.flag size={18} /></span>
              <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.2, margin: 0 }}>{deliverable.title}</h1>
              {canEdit && (
                <button className="icon-btn" title="Edit title & description"
                  onClick={() => { setHead({ title: deliverable.title || '', description: deliverable.description || '' }); setEditingHead(true); }}
                  style={{ flexShrink: 0 }}><I.edit size={15} /></button>
              )}
            </div>
            {deliverable.description && <div className="desc-block mb16">{deliverable.description}</div>}
          </>
        )}

        <div className="card card-pad mb16">
          <div className="row gap16 center" style={{ flexWrap: 'wrap' }}>
            {/* progress ring — target-based uses its metric, others use task rollup */}
            <div className="row gap12 center">
              <window.Ring value={type === 'target-based' ? tProg : r.progress} size={46} />
              <div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>{type === 'target-based' ? tProg : r.progress}%</div>
                <div className="muted" style={{ fontSize: 11.5 }}>{type === 'target-based' ? 'of target' : type === 'recurring' ? 'tasks this cycle' : 'rolled up'}</div>
              </div>
            </div>
            <span style={{ width: 1, height: 38, background: 'var(--border)' }} />

            {/* type-specific middle stats */}
            {type === 'target-based' && (
              <div className="col" style={{ gap: 3 }}>
                <span className="muted" style={{ fontSize: 11.5 }}>Progress</span>
                <div className="row gap6 center">
                  {canEdit
                    ? <input type="number" className="input" style={{ width: 64, padding: '4px 8px', fontSize: 13 }} value={deliverable.currentValue ?? ''} onChange={e => edit({ currentValue: e.target.value === '' ? 0 : Number(e.target.value) })} />
                    : <span style={{ fontSize: 18, fontWeight: 800 }}>{deliverable.currentValue ?? 0}</span>}
                  <span className="muted">/</span>
                  {canEdit
                    ? <input type="number" className="input" style={{ width: 64, padding: '4px 8px', fontSize: 13 }} value={deliverable.targetValue ?? ''} onChange={e => edit({ targetValue: e.target.value === '' ? null : Number(e.target.value) })} />
                    : <span style={{ fontSize: 18, fontWeight: 800 }}>{deliverable.targetValue ?? '—'}</span>}
                  {canEdit
                    ? <input className="input" style={{ width: 90, padding: '4px 8px', fontSize: 13 }} placeholder="unit" value={deliverable.unit || ''} onChange={e => edit({ unit: e.target.value })} />
                    : <span style={{ fontSize: 13, fontWeight: 600 }}>{deliverable.unit || ''}</span>}
                </div>
              </div>
            )}

            {type === 'recurring' && <>
              {TextField({ label: 'Current cycle', field: 'currentCycle', placeholder: 'e.g. Sprint 59', width: 130 })}
              {TextField({ label: 'Recurrence', field: 'recurrence', placeholder: 'e.g. Every 2 weeks', width: 130 })}
              <div><div style={{ fontSize: 18, fontWeight: 700 }}>{(deliverable.instances || []).filter(i => i.status === 'Completed').length}/{(deliverable.instances || []).length}</div><div className="muted" style={{ fontSize: 11.5 }}>cycles done</div></div>
            </>}

            {type === 'one-time' && <>
              <div><div style={{ fontSize: 18, fontWeight: 700 }}>{r.done}/{r.total}</div><div className="muted" style={{ fontSize: 11.5 }}>tasks done</div></div>
              {r.subCount > 0 && <div><div style={{ fontSize: 18, fontWeight: 700 }}>{r.subCount}</div><div className="muted" style={{ fontSize: 11.5 }}>sub-deliverables</div></div>}
              {r.blocked > 0 && <div><div style={{ fontSize: 18, fontWeight: 700, color: 'var(--st-blocked)' }}>{r.blocked}</div><div className="muted" style={{ fontSize: 11.5 }}>blocked</div></div>}
            </>}

            <span className="grow" />

            {/* dates + owner */}
            {type === 'one-time' && DateField({ label: 'Start', field: 'startDate' })}
            {DateField({ label: { 'one-time': 'Due', 'recurring': 'Next due', 'target-based': 'Deadline' }[type], field: 'targetDate', due: true })}
            <div className="col" style={{ gap: 4 }}>
              <span className="muted" style={{ fontSize: 11.5 }}>Owner</span>
              <span className="row gap6 center"><window.Avatar user={owner} size={20} /><span className="meta-v">{owner ? owner.name : '—'}</span></span>
            </div>
          </div>
        </div>

        {/* recurring — instance log */}
        {type === 'recurring' && (
          <InstanceLog deliverable={deliverable} canEdit={canEdit} onEdit={onEdit} />
        )}

        {/* sub-deliverables */}
        <div className="row between center mb12">
          <div className="section-eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.target size={13} /> Sub-deliverables</div>
          {canEdit && <button className="btn btn-subtle btn-sm" onClick={() => setAddingSub(s => !s)}><I.plus size={13} /> Add sub-deliverable</button>}
        </div>
        {addingSub && (
          <DeliverableForm parentTitle={deliverable.title}
            onCreate={(d) => { onCreate({ ...d, parentId: deliverable.id }); setAddingSub(false); }}
            onCancel={() => setAddingSub(false)} />
        )}
        {subs.length === 0 && !addingSub && (
          <div className="muted" style={{ fontSize: 13, marginBottom: 16 }}>No sub-deliverables. Break this milestone into smaller ones if useful.</div>
        )}
        <div className="col gap12 mb16">
          {subs.map(d => <DlvCard key={d.id} d={d} tasks={tasks} deliverables={deliverables} onOpen={onOpen} />)}
        </div>

        {/* tasks directly on this node */}
        <div className="row between center mb12">
          <div className="section-eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.list size={13} /> Tasks at this level</div>
          {canEdit && <button className="btn btn-subtle btn-sm" onClick={() => setPicking(p => !p)}><I.plus size={13} /> Assign tasks</button>}
        </div>

        {picking && (
          <div className="card card-pad mb16">
            <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>Pick existing tasks to attach here:</div>
            {candidates.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No unassigned tasks available.</div>}
            <div className="col gap8">
              {candidates.map(t => (
                <div key={t.id} className="row gap10 center" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <window.PriorityTag priority={t.priority} />
                  <span className="grow" style={{ fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                  <button className="btn btn-subtle btn-sm" onClick={() => onAssign(t.id, deliverable.id)}><I.plus size={12} /> Add</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {directTasks.length === 0 && !picking && (
          <div className="muted" style={{ fontSize: 13, marginBottom: 16 }}>No tasks at this level yet.</div>
        )}
        <div className="col gap8">
          {directTasks.map(t => (
            <div key={t.id} className="card card-pad row gap12 center" style={{ padding: '12px 16px' }}>
              <button onClick={() => onOpenTask(t.id)} className="row gap10 center grow" style={{ background: 'none', border: 0, textAlign: 'left', cursor: 'pointer', minWidth: 0 }}>
                <window.StatusPill status={t.status} />
                <span className="grow" style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>{t.progress || 0}%</span>
                <window.DueTag iso={t.dueDate} status={t.status} />
              </button>
              {canEdit && <button className="icon-btn" title="Remove from deliverable" onClick={() => onAssign(t.id, null)}><I.x size={15} /></button>}
            </div>
          ))}
        </div>

        {/* resources — shared + private, with a per-item lock toggle */}
        <ResourceList parentType="deliverable" parentId={deliverable.id} publicItems={deliverable.resources || []}
          canEdit={canEdit}
          onAddPublic={(res) => onAddResource && onAddResource('deliverable', deliverable.id, res)}
          onDeletePublic={(id) => onDeleteResource && onDeleteResource('deliverable', deliverable.id, id)} />

        {canEdit && (
          <div className="row mt16">
            <button className="btn btn-ghost btn-sm" onClick={() => onDelete(deliverable.id)}
              style={{ color: 'var(--st-blocked)', borderColor: 'var(--st-blocked)' }}><I.x size={13} /> Delete deliverable</button>
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, {
  DeliverablesScreen, DeliverableDetail, DeliverablePicker, DeliverableChip, ResourceList,
  dlvHelpers: { rollup, childrenOf, subtreeIds, pathOf },
});
