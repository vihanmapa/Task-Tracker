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

/* ---- create form (top-level or sub) ---- */
function DeliverableForm({ onCreate, onCancel, parentTitle }) {
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
      <div className="section-eyebrow mb12" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <I.target size={13} /> {parentTitle ? `New sub-deliverable under “${parentTitle}”` : 'New deliverable'}
      </div>
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
  return (
    <button className="card card-pad" onClick={() => onOpen(d.id)}
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
        {r.subCount > 0 && <span>· {r.subCount} sub</span>}
        {r.blocked > 0 && <span style={{ color: 'var(--st-blocked)' }}>· {r.blocked} blocked</span>}
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

        <div className="col gap12">
          {roots.map(d => <DlvCard key={d.id} d={d} tasks={tasks} deliverables={deliverables} onOpen={onOpen} />)}
        </div>
      </div>
    </div>
  );
}

/* ---- PRIVATE resources vault (per-deliverable, per-user) ----
   Real privacy via Supabase Auth + RLS: only the signed-in owner can
   read/write their rows. Self-contained — manages its own auth. ---- */
function ResourcesPanel({ deliverableId }) {
  const I = window.I;
  const ds = window.dataService;
  const supported = ds && ds.authReady && ds.authReady();
  const [user, setUser] = useStateD(null);
  const [items, setItems] = useStateD([]);
  const [loading, setLoading] = useStateD(false);
  const [err, setErr] = useStateD('');
  // sign-in form
  const [showSignIn, setShowSignIn] = useStateD(false);
  const [email, setEmail] = useStateD('');
  const [pw, setPw] = useStateD('');
  // add-resource form
  const [adding, setAdding] = useStateD(false);
  const [f, setF] = useStateD({ kind: 'link', title: '', url: '', note: '' });

  useEffectD(() => {
    if (!supported) return;
    let alive = true;
    ds.getUser().then(u => { if (alive) setUser(u); });
    const off = ds.onAuth(u => { if (alive) setUser(u); });
    return () => { alive = false; off && off(); };
  }, [supported]);

  const refresh = () => {
    if (!user) { setItems([]); return; }
    setLoading(true);
    ds.listResources(deliverableId).then(rows => { setItems(rows); setLoading(false); });
  };
  useEffectD(() => { refresh(); }, [user, deliverableId]);

  if (!supported) {
    return (
      <div className="card card-pad mt16">
        <div className="section-eyebrow mb8" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><I.link size={13} /> Private resources</div>
        <div className="muted" style={{ fontSize: 12.5 }}>Requires the shared (Supabase) backend with Auth enabled. See docs/PRIVATE-VAULT-SETUP.md.</div>
      </div>
    );
  }

  const doSignIn = async () => {
    setErr('');
    const r = await ds.signIn(email.trim(), pw);
    if (r.ok) { setShowSignIn(false); setEmail(''); setPw(''); }
    else setErr(r.error || 'Sign-in failed.');
  };
  const doSignOut = async () => { await ds.signOut(); setItems([]); };
  const doAdd = async () => {
    setErr('');
    if (!f.title.trim() && !f.url.trim()) { setErr('Add a title or a link.'); return; }
    const r = await ds.addResource({ deliverableId, kind: f.kind, title: f.title.trim(), url: f.url.trim(), note: f.note.trim() });
    if (r.ok) { setF({ kind: 'link', title: '', url: '', note: '' }); setAdding(false); refresh(); }
    else setErr(r.error || 'Could not save.');
  };
  const doDelete = async (id) => {
    const r = await ds.deleteResource(id);
    if (r.ok) refresh(); else setErr(r.error || 'Could not delete.');
  };

  return (
    <div className="card card-pad mt16">
      <div className="row between center mb8">
        <div className="section-eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <I.link size={13} /> Private resources
          <span className="chip" style={{ fontSize: 10.5, padding: '1px 6px' }}>only you</span>
        </div>
        {user
          ? <span className="row gap8 center"><span className="muted" style={{ fontSize: 11.5 }}>{user.email}</span><button className="btn btn-subtle btn-sm" onClick={doSignOut}>Sign out</button></span>
          : <button className="btn btn-subtle btn-sm" onClick={() => setShowSignIn(s => !s)}><I.user size={13} /> Sign in</button>}
      </div>

      {!user && (
        <>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: showSignIn ? 12 : 0 }}>
            Save chat links (ChatGPT, Gemini, NotebookLM) and notes only you can see. Richard and third parties never receive them.
          </div>
          {showSignIn && (
            <div className="col gap8" style={{ maxWidth: 320 }}>
              <input className="input" type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
              <input className="input" type="password" placeholder="Password" value={pw} onChange={e => setPw(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') doSignIn(); }} />
              <div className="row gap8"><button className="btn btn-primary btn-sm" onClick={doSignIn}>Sign in</button></div>
            </div>
          )}
        </>
      )}

      {user && (
        <>
          {loading && <div className="muted" style={{ fontSize: 12.5 }}>Loading…</div>}
          {!loading && items.length === 0 && <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>No private resources yet.</div>}
          <div className="col gap8">
            {items.map(it => (
              <div key={it.id} className="row gap10 center" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <span className="faint" style={{ flexShrink: 0 }}>{it.kind === 'note' ? <I.edit size={14} /> : <I.link size={14} />}</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  {it.url
                    ? <a href={it.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{it.title || it.url}</a>
                    : <div style={{ fontSize: 13.5, fontWeight: 600 }}>{it.title}</div>}
                  {it.note && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{it.note}</div>}
                </div>
                <button className="icon-btn" title="Delete" onClick={() => doDelete(it.id)} style={{ flexShrink: 0 }}><I.x size={15} /></button>
              </div>
            ))}
          </div>

          {adding ? (
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
              <div className="row gap8"><button className="btn btn-primary btn-sm" onClick={doAdd}><I.check size={13} /> Save</button><button className="btn btn-subtle btn-sm" onClick={() => setAdding(false)}>Cancel</button></div>
            </div>
          ) : (
            <button className="btn btn-subtle btn-sm mt12" onClick={() => setAdding(true)}><I.plus size={13} /> Add resource</button>
          )}
        </>
      )}

      {err && <div style={{ color: 'var(--st-blocked)', fontSize: 12, marginTop: 8 }}>{err}</div>}
    </div>
  );
}

/* ---- detail: breadcrumb + rollup + sub-deliverables + tasks ---- */
function DeliverableDetail({ deliverable, deliverables, tasks, canEdit, onBack, onOpen, onOpenTask, onCreate, onEdit, onDelete, onAssign }) {
  const I = window.I;
  const [picking, setPicking] = useStateD(false);
  const [addingSub, setAddingSub] = useStateD(false);
  if (!deliverable) return null;
  const r = rollup(deliverable.id, tasks, deliverables);
  const owner = window.USERS[deliverable.ownerId];
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
            {r.subCount > 0 && <div><div style={{ fontSize: 18, fontWeight: 700 }}>{r.subCount}</div><div className="muted" style={{ fontSize: 11.5 }}>sub-deliverables</div></div>}
            {r.blocked > 0 && <div><div style={{ fontSize: 18, fontWeight: 700, color: 'var(--st-blocked)' }}>{r.blocked}</div><div className="muted" style={{ fontSize: 11.5 }}>blocked</div></div>}
            <span className="grow" />
            <div className="col" style={{ textAlign: 'right' }}>
              <span className="row gap6 center" style={{ justifyContent: 'flex-end' }}><window.Avatar user={owner} size={20} /><span className="meta-v">{owner ? owner.name : '—'}</span></span>
              {deliverable.targetDate && <span className="muted" style={{ fontSize: 12, marginTop: 4 }}>Target <window.DueTag iso={deliverable.targetDate} /></span>}
            </div>
          </div>
        </div>

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
                <window.DueTag iso={t.dueDate} />
              </button>
              {canEdit && <button className="icon-btn" title="Remove from deliverable" onClick={() => onAssign(t.id, null)}><I.x size={15} /></button>}
            </div>
          ))}
        </div>

        {/* private, per-user resource vault */}
        <ResourcesPanel deliverableId={deliverable.id} />

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
  DeliverablesScreen, DeliverableDetail, DeliverablePicker, DeliverableChip,
  dlvHelpers: { rollup, childrenOf, subtreeIds, pathOf },
});
