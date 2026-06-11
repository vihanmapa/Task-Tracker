/* ============================================================
   FM Navigate — Deliverables
   A Deliverable is a parent milestone (the "main deliverable").
   Tasks hang under it via task.deliverableId. Deliverables are
   stored in the same shared blob, tagged kind:'deliverable'.
   ============================================================ */
const { useState: useStateD, useMemo: useMemoD } = React;

/* ---- helpers ---- */
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

// child tasks of a deliverable + rolled-up stats
function rollup(deliverableId, tasks) {
  const kids = tasks.filter(t => t.deliverableId === deliverableId);
  const live = kids.filter(t => t.status !== 'Cancelled');
  const done = kids.filter(t => t.status === 'Completed').length;
  const blocked = kids.filter(t => t.status === 'Blocked').length;
  const progress = live.length ? Math.round(live.reduce((s, t) => s + (t.progress || 0), 0) / live.length) : 0;
  return { kids, total: kids.length, done, blocked, progress };
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

/* ---- dropdown picker (task edit / detail) ---- */
function DeliverablePicker({ value, deliverables, onChange }) {
  return (
    <select className="input" value={value || ''} onChange={e => onChange(e.target.value || null)}>
      <option value="">— No deliverable —</option>
      {deliverables.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
    </select>
  );
}

/* ---- create form ---- */
function DeliverableForm({ onCreate, onCancel }) {
  const I = window.I;
  const [f, setF] = useStateD({ title: '', description: '', targetDate: '', status: 'Active' });
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const submit = () => {
    if (!f.title.trim()) return;
    onCreate({
      title: f.title.trim(),
      description: f.description.trim(),
      targetDate: f.targetDate ? new Date(f.targetDate + 'T17:00:00').toISOString() : null,
      status: f.status,
    });
  };
  return (
    <div className="card card-pad mb16">
      <div className="section-eyebrow mb12" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.target size={13} /> New deliverable</div>
      <label className="field-label" style={{ marginBottom: 5, display: 'block' }}>Title</label>
      <input className="input" autoFocus value={f.title} placeholder="e.g. Architecture Assessment Scope & Engagement Package"
        onChange={e => set('title', e.target.value)} />
      <label className="field-label" style={{ marginBottom: 5, marginTop: 14, display: 'block' }}>Description</label>
      <textarea className="ai-textarea" style={{ minHeight: 80, fontSize: 13.5 }} value={f.description}
        placeholder="What this milestone delivers, and what 'done' means." onChange={e => set('description', e.target.value)} />
      <div className="row gap12 mt12" style={{ flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <label className="field-label" style={{ marginBottom: 5, display: 'block' }}>Target date</label>
          <input type="date" className="input" value={f.targetDate} onChange={e => set('targetDate', e.target.value)} />
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <label className="field-label" style={{ marginBottom: 5, display: 'block' }}>Status</label>
          <select className="input" value={f.status} onChange={e => set('status', e.target.value)}>
            {window.DELIVERABLE_STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <div className="row gap8 mt16">
        <button className="btn btn-primary btn-sm" onClick={submit}><I.check size={13} /> Create deliverable</button>
        <button className="btn btn-subtle btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* ---- list / index screen ---- */
function DeliverablesScreen({ deliverables, tasks, canEdit, onOpen, onCreate }) {
  const I = window.I;
  const [creating, setCreating] = useStateD(false);
  const unassigned = tasks.filter(t => !t.deliverableId && !['Completed', 'Cancelled'].includes(t.status)).length;

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

        {deliverables.length === 0 && !creating && (
          <div className="card card-pad" style={{ textAlign: 'center', padding: '40px 20px' }}>
            <div style={{ color: 'var(--muted)', marginBottom: 12 }}><I.target size={28} /></div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>No deliverables yet</div>
            <div className="muted" style={{ fontSize: 13 }}>Create a milestone, then assign the tasks that roll up to it.</div>
          </div>
        )}

        <div className="col gap12">
          {deliverables.map(d => {
            const r = rollup(d.id, tasks);
            return (
              <button key={d.id} className="card card-pad" onClick={() => onOpen(d.id)}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', display: 'block' }}>
                <div className="row between center" style={{ marginBottom: 8 }}>
                  <div className="row gap8 center" style={{ minWidth: 0 }}>
                    <span style={{ color: 'var(--accent)' }}><I.flag size={15} /></span>
                    <span style={{ fontWeight: 700, fontSize: 15.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                  </div>
                  <DlvStatusPill status={d.status} />
                </div>
                {d.description && <div className="muted" style={{ fontSize: 12.5, marginBottom: 12, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{d.description}</div>}
                <div className="row gap12 center" style={{ marginBottom: 6 }}>
                  <div className="grow"><window.Progress value={r.progress} height={6} /></div>
                  <span style={{ fontSize: 12.5, fontWeight: 700 }}>{r.progress}%</span>
                </div>
                <div className="row gap12 center" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  <span>{r.done}/{r.total} done</span>
                  {r.blocked > 0 && <span style={{ color: 'var(--st-blocked)' }}>· {r.blocked} blocked</span>}
                  {d.targetDate && <span>· <window.DueTag iso={d.targetDate} /></span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ---- detail: parent + its tasks + assignment ---- */
function DeliverableDetail({ deliverable, deliverables, tasks, canEdit, onBack, onOpenTask, onEdit, onDelete, onAssign }) {
  const I = window.I;
  const [picking, setPicking] = useStateD(false);
  if (!deliverable) return null;
  const r = rollup(deliverable.id, tasks);
  const owner = window.USERS[deliverable.ownerId];

  // tasks not yet under any deliverable — candidates to add here
  const candidates = useMemoD(
    () => tasks.filter(t => !t.deliverableId && !['Cancelled'].includes(t.status)),
    [tasks]
  );

  const kids = [...r.kids].sort((a, b) => {
    const done = (t) => t.status === 'Completed' ? 1 : 0;
    return done(a) - done(b);
  });

  const cycleStatus = () => {
    const order = window.DELIVERABLE_STATUSES;
    const i = order.indexOf(deliverable.status);
    onEdit(deliverable.id, { status: order[(i + 1) % order.length] });
  };

  return (
    <div className="scroll-area fade-in">
      <div style={{ padding: '16px 28px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn btn-subtle btn-sm" onClick={onBack}><I.chevL size={15} /> Deliverables</button>
        <span className="muted mono" style={{ fontSize: 12 }}>{deliverable.id}</span>
        <span className="grow" />
        {canEdit
          ? <button className="btn btn-subtle btn-sm" onClick={cycleStatus} title="Click to change status"><DlvStatusPill status={deliverable.status} /></button>
          : <DlvStatusPill status={deliverable.status} />}
      </div>

      <div className="page-pad" style={{ paddingTop: 24, maxWidth: 920 }}>
        <div className="row gap10 center mb12">
          <span style={{ color: 'var(--accent)' }}><I.flag size={18} /></span>
          <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.2, margin: 0 }}>{deliverable.title}</h1>
        </div>
        {deliverable.description && <div className="desc-block mb16">{deliverable.description}</div>}

        <div className="card card-pad mb16">
          <div className="row gap16 center" style={{ flexWrap: 'wrap' }}>
            <div className="row gap12 center">
              <window.Ring value={r.progress} size={46} />
              <div><div style={{ fontSize: 20, fontWeight: 800 }}>{r.progress}%</div><div className="muted" style={{ fontSize: 11.5 }}>rolled up</div></div>
            </div>
            <span style={{ width: 1, height: 38, background: 'var(--border)' }} />
            <div><div style={{ fontSize: 18, fontWeight: 700 }}>{r.done}/{r.total}</div><div className="muted" style={{ fontSize: 11.5 }}>tasks done</div></div>
            {r.blocked > 0 && <div><div style={{ fontSize: 18, fontWeight: 700, color: 'var(--st-blocked)' }}>{r.blocked}</div><div className="muted" style={{ fontSize: 11.5 }}>blocked</div></div>}
            <span className="grow" />
            <div className="col" style={{ textAlign: 'right' }}>
              <span className="row gap6 center" style={{ justifyContent: 'flex-end' }}><window.Avatar user={owner} size={20} /><span className="meta-v">{owner ? owner.name : '—'}</span></span>
              {deliverable.targetDate && <span className="muted" style={{ fontSize: 12, marginTop: 4 }}>Target <window.DueTag iso={deliverable.targetDate} /></span>}
            </div>
          </div>
        </div>

        <div className="row between center mb12">
          <div className="section-eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.list size={13} /> Tasks under this deliverable</div>
          {canEdit && <button className="btn btn-subtle btn-sm" onClick={() => setPicking(p => !p)}><I.plus size={13} /> Assign tasks</button>}
        </div>

        {picking && (
          <div className="card card-pad mb16">
            <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>Pick existing tasks to roll up here:</div>
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

        {kids.length === 0 && !picking && (
          <div className="card card-pad" style={{ textAlign: 'center', padding: '28px 20px' }}>
            <div className="muted" style={{ fontSize: 13 }}>No tasks assigned yet. Use “Assign tasks” to add them.</div>
          </div>
        )}

        <div className="col gap8">
          {kids.map(t => (
            <div key={t.id} className="card card-pad row gap12 center" style={{ padding: '12px 16px' }}>
              <button onClick={() => onOpenTask(t.id)} className="row gap10 center grow" style={{ background: 'none', border: 0, textAlign: 'left', cursor: 'pointer', minWidth: 0 }}>
                <window.StatusPill status={t.status} />
                <span className="grow" style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>{t.progress || 0}%</span>
                <window.DueTag iso={t.dueDate} />
              </button>
              {canEdit && <button className="icon-btn" title="Remove from deliverable" onClick={() => onAssign(t.id, null)}><I.x size={15} /></button>}
            </div>
          ))}
        </div>

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

Object.assign(window, { DeliverablesScreen, DeliverableDetail, DeliverablePicker, DeliverableChip });
