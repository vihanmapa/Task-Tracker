/* ============================================================
   FM Navigate — AI Task Composer (hero flow)
   Paste ONE paragraph → structured task.
   Paste MANY (a list, or blank-line-separated paragraphs) →
   the assistant splits them and you create them all at once.
   ============================================================ */
const { useState: useStateC, useRef: useRefC, useEffect: useEffectC } = React;

const EXAMPLE_DESC = `Need to prepare Sprint 58 planning with the development team. The pilot is scheduled for next week so this is critical. Need effort estimates from Isuru before finalizing the sprint. Target completion by Friday. Success means the sprint backlog is approved and communicated.`;

const EXAMPLE_MULTI = `1. Prep Sprint 58 planning with the dev team — critical, due Friday. Waiting on estimates from Isuru.
2. Pull together the Q2 investor deck. High priority, due next Tuesday. Waiting on financial data from finance.
3. Quick fix the pricing page copy before the marketing launch. Low priority.`;

function FieldShimmer({ h = 38 }) {
  return <div className="shimmer" style={{ height: h, width: '100%' }} />;
}

const STATUSES4 = ['Not Started', 'In Progress', 'Waiting', 'Blocked'];
const toDateInput = (iso) => iso ? new Date(iso).toISOString().slice(0, 10) : '';
const fromDateInput = (v) => v ? new Date(v + 'T17:00:00').toISOString() : null;

function AIComposer({ onClose, onCreate, onCreateMany, linkTo }) {
  const I = window.I;
  const [desc, setDesc] = useStateC('');
  const [phase, setPhase] = useStateC('input'); // input | parsing | review | batch
  const [fields, setFields] = useStateC(null);   // single-task review
  const [batch, setBatch] = useStateC([]);        // multi-task review
  const [source, setSource] = useStateC('ai');
  const taRef = useRefC(null);

  useEffectC(() => { taRef.current?.focus(); }, []);

  // live count of how many tasks the current text would produce
  const detected = desc.trim() ? window.aiService.countTasks(desc) : 0;

  const manual = () => {
    setSource('manual');
    setFields({
      title: desc.trim().split(/[.\n]/)[0].slice(0, 70),
      description: desc.trim(),
      priority: 'Medium',
      category: window.CATEGORIES[0],
      dueDate: null,
      status: 'Not Started',
      dependencies: [],
      successCriteria: '',
      risk: '',
      effort: 'M',
      ownerId: '',
    });
    setPhase('review');
  };

  const run = async () => {
    if (!desc.trim()) return;
    setPhase('parsing');
    if (window.aiService.countTasks(desc) >= 2) {
      const rows = await window.aiService.extractMultiple(desc.trim());
      setSource(rows[0]?._source || 'local');
      setBatch(rows);
      setPhase('batch');
    } else {
      const result = await window.aiService.extractTasks(desc.trim());
      setSource(result._source);
      // keep the parser's cleaned description (labeled/tabular pastes strip the
      // label lines); fall back to the raw paste for plain text.
      setFields({ ...result, description: result.description || desc.trim() });
      setPhase('review');
    }
  };

  /* single-task editors */
  const set = (k, v) => setFields(f => ({ ...f, [k]: v }));
  const setDep = (i, v) => setFields(f => { const d = [...f.dependencies]; d[i] = v; return { ...f, dependencies: d }; });
  const addDep = () => setFields(f => ({ ...f, dependencies: [...f.dependencies, ''] }));
  const rmDep = (i) => setFields(f => ({ ...f, dependencies: f.dependencies.filter((_, j) => j !== i) }));
  // when launched as a follow-up, link the new task back to its origin and
  // inherit the origin's deliverable so both sit under the same group.
  const withLink = (t) => linkTo
    ? { ...t, depTaskIds: [...(t.depTaskIds || []), linkTo.taskId], deliverableId: t.deliverableId || linkTo.deliverableId || null }
    : t;
  const save = () => {
    const clean = { ...fields, dependencies: (fields.dependencies || []).filter(s => s.trim()) };
    onCreate(withLink({ ...clean, description: (fields.description || '').trim() || desc.trim() }));
  };

  /* batch editors */
  const setRow = (i, k, v) => setBatch(b => b.map((r, j) => j === i ? { ...r, [k]: v } : r));
  const rmRow = (i) => setBatch(b => b.filter((_, j) => j !== i));
  const saveBatch = () => {
    const rows = batch
      .filter(r => r.title.trim())
      .map(r => withLink({ ...r, dependencies: (r.dependencies || []).filter(s => s.trim()) }));
    onCreateMany(rows);
  };

  const dueInput = toDateInput(fields?.dueDate);

  return (
    <window.Modal onClose={onClose} width={phase === 'batch' ? 720 : 680}>
      <div className="modal-head">
        <span style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--accent)', color: 'var(--accent-fg)', display: 'grid', placeItems: 'center' }}><I.spark size={18} /></span>
        <div className="grow">
          <div style={{ fontWeight: 700, fontSize: 15 }}>{phase === 'batch' ? `New tasks · ${batch.length}` : 'New task'}</div>
          <div className="muted" style={{ fontSize: 12 }}>Describe the work — or paste a list to add several at once.</div>
        </div>
        <button className="icon-btn" onClick={onClose}><I.x size={18} /></button>
      </div>

      <div className="modal-body">
        {linkTo && (
          <div className="row gap8 center mb16" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '8px 11px', fontSize: 12.5 }}>
            <I.link size={13} style={{ flexShrink: 0, color: 'var(--accent)' }} />
            <span className="muted">Linking back to</span>
            <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{linkTo.title}</b>
          </div>
        )}
        {/* description — shown in input/parsing only */}
        {(phase === 'input' || phase === 'parsing') && (
          <div className="field mb16">
            <div className="row between center">
              <label className="field-label"><I.edit size={13} /> Describe the work</label>
              {phase === 'input' && !desc && (
                <div className="row gap8">
                  <button className="btn btn-subtle btn-sm" onClick={() => setDesc(EXAMPLE_DESC)}>One task</button>
                  <button className="btn btn-subtle btn-sm" onClick={() => setDesc(EXAMPLE_MULTI)}>A list</button>
                </div>
              )}
            </div>
            <textarea ref={taRef} className="ai-textarea" value={desc} onChange={e => setDesc(e.target.value)}
              placeholder={"Paste one paragraph for a single task — or a numbered/bulleted list (or blank-line-separated paragraphs) to add several at once.\n\n1. Prep Sprint 58 — critical, due Friday, waiting on Isuru.\n2. Q2 investor deck — high priority, due next Tuesday.\n3. Fix pricing page copy — low priority."}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run(); }} />
            {phase === 'input' && (
              <div className="row between center mt8">
                <span className="faint" style={{ fontSize: 11.5 }}>
                  {detected >= 2
                    ? <><b style={{ color: 'var(--accent)' }}>{detected} tasks detected</b> — each saved with its own description.</>
                    : 'The original description is always saved with the task.'}
                </span>
                <div className="row gap8">
                  <button className="btn btn-subtle" onClick={manual}><I.edit size={13} /> Enter manually</button>
                  <button className="btn btn-primary" disabled={!desc.trim()} onClick={run} style={{ opacity: desc.trim() ? 1 : 0.5 }}>
                    <I.wand size={15} /> {detected >= 2 ? `Generate ${detected} tasks` : 'Generate with AI'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* parsing */}
        {phase === 'parsing' && (
          <div className="fade-in">
            <div className="row gap8 center mb12" style={{ color: 'var(--accent)' }}>
              <span className="typing-dot" style={{ background: 'var(--accent)' }} />
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{detected >= 2 ? `Splitting and structuring ${detected} tasks…` : 'Reading your description, extracting fields…'}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <FieldShimmer /><FieldShimmer /><FieldShimmer /><FieldShimmer />
              <div style={{ gridColumn: '1 / -1' }}><FieldShimmer h={48} /></div>
            </div>
          </div>
        )}

        {/* single review */}
        {phase === 'review' && fields && (
          <div className="fade-in">
            <div className="row between center mb12" style={{ paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
              <span className="ai-tag"><I.spark size={12} /> {source === 'manual' ? 'Manual entry' : source === 'ai' ? 'AI-extracted — review & edit' : 'Auto-extracted — review & edit'}</span>
              <button className="btn btn-subtle btn-sm" onClick={() => setPhase('input')}>
                {source === 'manual' ? <><I.chevL size={13} /> Back</> : <><I.refresh size={13} /> Re-parse</>}
              </button>
            </div>

            <div className="field mb16 ai-filled">
              <label className="field-label">Title</label>
              <input className="input" style={{ fontSize: 15, fontWeight: 600 }} value={fields.title} onChange={e => set('title', e.target.value)} />
            </div>

            <div className="field mb16 ai-filled">
              <label className="field-label"><I.edit size={13} /> Description</label>
              <textarea className="input" style={{ minHeight: 84, resize: 'vertical' }} value={fields.description || ''} onChange={e => set('description', e.target.value)} placeholder="What the task involves…" />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
              <div className="field ai-filled">
                <label className="field-label">Priority</label>
                <select className="select" value={fields.priority} onChange={e => set('priority', e.target.value)}>
                  {window.PRIORITIES.map(p => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div className="field ai-filled">
                <label className="field-label">Category</label>
                <select className="select" value={fields.category} onChange={e => set('category', e.target.value)}>
                  {window.CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="field ai-filled">
                <label className="field-label">Due date</label>
                <input type="date" className="input" value={dueInput}
                  onChange={e => set('dueDate', fromDateInput(e.target.value))} />
              </div>
              <div className="field ai-filled">
                <label className="field-label">Status</label>
                <select className="select" value={fields.status} onChange={e => set('status', e.target.value)}>
                  {STATUSES4.map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div className="field ai-filled">
                <label className="field-label">Owner</label>
                <select className="select" value={fields.ownerId || ''} onChange={e => set('ownerId', e.target.value)}>
                  <option value="">— Me (default) —</option>
                  {window.peopleOptions(fields.ownerId || null).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            </div>

            <div className="field mb16 ai-filled">
              <label className="field-label"><I.link size={13} /> Dependencies</label>
              {fields.dependencies.map((dep, i) => (
                <div key={i} className="row gap8 center" style={{ marginBottom: 6 }}>
                  <input className="input" value={dep} onChange={e => setDep(i, e.target.value)} placeholder="What must happen first…" />
                  <button className="icon-btn" onClick={() => rmDep(i)} style={{ flexShrink: 0 }}><I.x size={15} /></button>
                </div>
              ))}
              <button className="btn btn-subtle btn-sm" onClick={addDep} style={{ alignSelf: 'flex-start' }}><I.plus size={13} /> Add dependency</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 96px', gap: 14, marginBottom: 16 }}>
              <div className="field ai-filled">
                <label className="field-label"><I.target size={13} /> Success criteria</label>
                <input className="input" value={fields.successCriteria} onChange={e => set('successCriteria', e.target.value)} placeholder="Definition of done…" />
              </div>
              <div className="field ai-filled">
                <label className="field-label">Effort</label>
                <select className="select" value={fields.effort} onChange={e => set('effort', e.target.value)}>
                  {['S','M','L','XL'].map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
            </div>

            <div className="field ai-filled">
              <label className="field-label"><I.alert size={13} /> Risk</label>
              <input className="input" value={fields.risk} onChange={e => set('risk', e.target.value)} placeholder="Main risk, if any…" />
            </div>
          </div>
        )}

        {/* batch review */}
        {phase === 'batch' && (
          <div className="fade-in">
            <div className="row between center mb12" style={{ paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
              <span className="ai-tag"><I.spark size={12} /> {batch.length} tasks extracted — review & edit</span>
              <button className="btn btn-subtle btn-sm" onClick={() => setPhase('input')}><I.refresh size={13} /> Re-parse</button>
            </div>

            <div className="col" style={{ gap: 12 }}>
              {batch.map((r, i) => (
                <div key={i} className="card card-pad ai-filled" style={{ padding: 14 }}>
                  <div className="row gap8 center mb8">
                    <span className="mono faint" style={{ fontSize: 11, flexShrink: 0 }}>{String(i + 1).padStart(2, '0')}</span>
                    <input className="input" style={{ fontWeight: 600 }} value={r.title} onChange={e => setRow(i, 'title', e.target.value)} placeholder="Task title" />
                    <button className="icon-btn" onClick={() => rmRow(i)} title="Remove" style={{ flexShrink: 0 }}><I.x size={15} /></button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 8 }}>
                    <select className="select" value={r.priority} onChange={e => setRow(i, 'priority', e.target.value)} title="Priority">
                      {window.PRIORITIES.map(p => <option key={p}>{p}</option>)}
                    </select>
                    <select className="select" value={r.category} onChange={e => setRow(i, 'category', e.target.value)} title="Category">
                      {window.CATEGORIES.map(c => <option key={c}>{c}</option>)}
                    </select>
                    <input type="date" className="input" value={toDateInput(r.dueDate)} onChange={e => setRow(i, 'dueDate', fromDateInput(e.target.value))} title="Due date" />
                    <select className="select" value={r.status} onChange={e => setRow(i, 'status', e.target.value)} title="Status">
                      {STATUSES4.map(s => <option key={s}>{s}</option>)}
                    </select>
                    <select className="select" value={r.ownerId || ''} onChange={e => setRow(i, 'ownerId', e.target.value)} title="Owner">
                      <option value="">— Me —</option>
                      {window.peopleOptions(r.ownerId || null).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </div>
                  {(r.dependencies?.length > 0 || r.risk) && (
                    <div className="muted" style={{ fontSize: 11.5, marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      {r.dependencies?.length > 0 && <span><I.link size={11} /> {r.dependencies.join('; ')}</span>}
                      {r.risk && <span style={{ color: 'var(--st-blocked)' }}><I.alert size={11} /> {r.risk}</span>}
                    </div>
                  )}
                </div>
              ))}
              {batch.length === 0 && <div className="empty">No tasks left — go back and paste again.</div>}
            </div>
          </div>
        )}
      </div>

      {phase === 'review' && (
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={!fields.title.trim()}><I.check size={15} /> Create task</button>
        </div>
      )}
      {phase === 'batch' && (
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={saveBatch} disabled={!batch.some(r => r.title.trim())}>
            <I.check size={15} /> Create {batch.filter(r => r.title.trim()).length} task{batch.filter(r => r.title.trim()).length === 1 ? '' : 's'}
          </button>
        </div>
      )}
    </window.Modal>
  );
}

window.AIComposer = AIComposer;
