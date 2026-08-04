/* ============================================================
   FM Navigate — This Month (Monthly Execution Report)
   ------------------------------------------------------------
   The monthly counterpart of This Week, built for one job: filling
   the Monthly Task Sheet that goes with the consultancy invoice.

   Nothing here is stored. A month is a *synthetic range* handed to
   deriveRangeActivity (weekly.jsx) — the same engine This Week uses —
   so what shows up is exactly what the dated progress logs say moved
   between the 1st and the last day of the month. No month objects, no
   schema, no manual assignment: log your work once, the sheet writes
   itself.

   Sheet mapping (2026_Task sheet-consultant.docx):
     Focus Area                     -> task category
     Key Deliverables & Activities  -> task title + in-month log notes
                                       + checklist items delivered
     Est. Effort                    -> LEFT BLANK. See the note below.
     Status                         -> completed / advanced mix per area

   ON EFFORT: the workspace records no time. Progress logs carry a timestamp,
   a percentage and a note — never a duration — so any "days spent" figure
   derived here would be a guess dressed up as data, on a document that backs
   an invoice. Counting the days a task was *logged on* is no better: it
   measures typing, not work. So nothing is invented. Each area reports the
   effort SIZING its tasks actually carry (S/M/L/XL, entered by hand), and the
   sheet's Est. Effort cell ships blank for a human to fill.
   ============================================================ */
const { useState: useStateM, useMemo: useMemoM } = React;

/* 'YYYY-MM' — sortable, timezone-free month key. */
function monthKeyOf(dt) { return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`; }
function monthShift(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKeyOf(d);
}
/* A calendar month as a range object deriveRangeActivity understands.
   taskIds is empty on purpose: a month has no plan, so every row that comes
   back is "unplanned" and we simply ignore that flag. */
function monthRangeOf(key) {
  const [y, m] = key.split('-').map(Number);
  const s = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const e = new Date(y, m, 0, 23, 59, 59, 999);
  return {
    startDate: s.toISOString(), endDate: e.toISOString(), taskIds: [],
    label: s.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    short: s.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
    // year included on purpose — this line ends up on an invoice document
    span: `${window.fmtDate(s.toISOString())} – ${window.fmtDate(e.toISOString())}, ${y}`,
  };
}
const monthDay = (iso) => new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });

/* Effort sizing tally for a set of rows, biggest first: "1 L · 2 M".
   Straight count of the sizes on the tasks — no conversion to time. */
const EFFORT_ORDER = ['XL', 'L', 'M', 'S'];
function effortMix(rows) {
  const n = {};
  for (const r of rows) { const k = r.task.effort || 'M'; n[k] = (n[k] || 0) + 1; }
  return EFFORT_ORDER.filter(k => n[k]).map(k => `${n[k]} ${k}`).join(' · ');
}

/* Group derived rows into the sheet's focus areas (task category), completed
   work first inside each area, biggest areas first. */
function monthFocusAreas(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = r.task.category || 'Uncategorised';
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  return [...by.entries()].map(([category, rs]) => {
    const completed = rs.filter(r => r.completedInRange);
    // Status describes the MONTH, not today: a task finished in a later month
    // was still work-in-flight during this one, so its current "Completed"
    // must not leak into this area's status.
    const statusMix = [...new Set(rs.filter(r => !r.completedInRange)
      .map(r => (r.task.status === 'Completed' ? 'In Progress' : r.task.status)))];
    return {
      category, rows: rs,
      completed: completed.length,
      advanced: rs.length - completed.length,
      effort: effortMix(rs),
      statusMix,
      status: completed.length === rs.length ? 'Completed'
        : completed.length ? `${completed.length} completed · ${rs.length - completed.length} in progress`
        : (statusMix.length === 1 ? statusMix[0] : 'In progress'),
    };
  }).sort((a, b) => (b.completed - a.completed) || (b.rows.length - a.rows.length));
}

/* ---------------- sheet export ----------------
   Two shapes of the same content: a readable block that maps 1:1 onto the
   Word template's numbered sections, and a tab-separated table for Word's
   "Convert Text to Table". Both are plain text — paste, don't import. */
function monthActivityLines(r) {
  const out = [];
  for (const n of r.notes) out.push(n);
  for (const d of (r.delivered || [])) out.push(`Delivered: ${d}`);
  if (!out.length) out.push(r.completedInRange ? 'Completed' : `Progressed ${r.delta > 0 ? '+' : ''}${r.delta}%`);
  return out;
}
function monthSheetText(range, areas, derived) {
  const L = [];
  L.push(`MONTHLY TASK SHEET — ${range.label}`);
  L.push(`Period: ${range.span}`);
  L.push(`${derived.tasksCompleted} completed · ${derived.rows.length} tasks advanced`);
  L.push('');
  areas.forEach((a, i) => {
    L.push(`${i + 1}. ${a.category}`);
    for (const r of a.rows) {
      const when = r.completedInRange && r.task.completedAt ? ` (completed ${monthDay(r.task.completedAt)})` : '';
      L.push(`   - ${r.task.title}${when}`);
      for (const line of monthActivityLines(r)) L.push(`     • ${line}`);
    }
    // deliberately unfilled: nothing in the tracker measures time
    L.push(`   Est. Effort: ______________   [sizing: ${a.effort}]`);
    L.push(`   Status: ${a.status}`);
    L.push('');
  });
  L.push('Est. Effort is yours to fill — the bracketed figure is the effort');
  L.push('sizing on those tasks (S/M/L/XL), not a measure of time spent.');
  return L.join('\n');
}
function monthSheetTsv(areas) {
  const rows = [['Focus Area', 'Key Deliverables & Activities', 'Est. Effort', 'Status']];
  areas.forEach((a, i) => {
    const activities = a.rows.map(r => {
      const when = r.completedInRange && r.task.completedAt ? ` (completed ${monthDay(r.task.completedAt)})` : '';
      return `• ${r.task.title}${when}: ${monthActivityLines(r).join('; ')}`;
    }).join('  ');
    rows.push([`${i + 1}. ${a.category}`, activities, `[sizing: ${a.effort}]`, a.status]);
  });
  return rows.map(r => r.join('\t')).join('\n');
}

/* Preview + copy. Deliberately read-only: the sheet is generated from logs,
   so edits belong on the tasks, not here. */
function MonthSheetModal({ range, areas, derived, onClose }) {
  const I = window.I;
  const [tab, setTab] = useStateM('sheet');
  const [copied, setCopied] = useStateM(false);
  const text = tab === 'sheet' ? monthSheetText(range, areas, derived) : monthSheetTsv(areas);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      // clipboard API unavailable (e.g. insecure context) — textarea fallback
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <window.Modal onClose={onClose} width={760}>
      <div className="modal-head">
        <div>
          <div className="card-title">Monthly Task Sheet — {range.label}</div>
          <div className="att-meta">{range.span} · {areas.length} focus area{areas.length === 1 ? '' : 's'}</div>
        </div>
        <button className="icon-btn" onClick={onClose}><I.x size={18} /></button>
      </div>
      <div style={{ padding: '0 18px 16px' }}>
        <div className="row center mb12" style={{ gap: 8 }}>
          <button className={'btn btn-sm ' + (tab === 'sheet' ? 'btn-primary' : 'btn-ghost')} onClick={() => setTab('sheet')}>Sheet layout</button>
          <button className={'btn btn-sm ' + (tab === 'tsv' ? 'btn-primary' : 'btn-ghost')} onClick={() => setTab('tsv')}>Table (tab-separated)</button>
          <span className="grow" />
          <button className="btn btn-primary btn-sm" onClick={copy}>
            {copied ? <><I.check size={14} /> Copied</> : <><I.copy size={14} /> Copy</>}
          </button>
        </div>
        <textarea className="input mono" readOnly value={text} rows={18} style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre', overflowX: 'auto' }} />
        <div className="att-meta" style={{ marginTop: 8 }}>
          {tab === 'sheet'
            ? 'Paste into the Word template — one numbered block per Focus Area row. Est. Effort ships blank; the bracketed sizing is the tasks’ S/M/L, not time.'
            : 'Paste into Word, select it, then Insert → Table → Convert Text to Table (tabs as separator). Replace the bracketed sizing in Est. Effort with your own figure.'}
        </div>
      </div>
    </window.Modal>
  );
}

/* One task inside a focus area: what moved, what was delivered, effort, status. */
function MonthRow({ r, onOpenTask }) {
  const t = r.task;
  const lines = monthActivityLines(r);
  return (
    <div className="ws-item" onClick={() => onOpenTask(t.id)} style={{ cursor: 'pointer' }}>
      <span className="dot" style={{ background: (window.STATUS_META[t.status] || {}).c || 'var(--accent)', marginTop: 6 }} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row center" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 13.5 }}>{t.title}</span>
          {r.completedInRange && t.completedAt && (
            <span className="chip" style={{ fontSize: 10, background: 'var(--accent-soft)', color: 'var(--st-completed)', fontWeight: 700 }}>
              Completed {monthDay(t.completedAt)}
            </span>
          )}
          {/* finished outside the month being viewed — in-flight back then */}
          {!r.completedInRange && t.completedAt && (
            <span className="chip" style={{ fontSize: 10 }}>Completed {monthDay(t.completedAt)}</span>
          )}
        </div>
        {lines.length > 0 && (
          <ul style={{ margin: '4px 0 0', paddingLeft: 16, listStyle: 'disc' }}>
            {lines.slice(0, 4).map((n, i) => <li key={i} className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>{n}</li>)}
            {lines.length > 4 && <li className="faint" style={{ fontSize: 12 }}>+{lines.length - 4} more</li>}
          </ul>
        )}
        <div className="att-meta">
          <window.StatusPill status={t.status} /><span className="faint">·</span>
          <span>{(window.EFFORT_LABEL[t.effort] || 'Medium')} effort</span>
        </div>
      </div>
      <span className="chip mono" style={{ fontWeight: 700, color: r.delta > 0 ? 'var(--st-completed)' : 'var(--muted)' }}>
        {r.delta ? `${r.delta > 0 ? '+' : ''}${r.delta}%` : 'updated'}
      </span>
    </div>
  );
}

/* ---------------- screen ---------------- */
function MonthlyWorkspace({ tasks, deliverables, onOpenTask }) {
  const I = window.I;
  const [key, setKey] = useStateM(() => monthKeyOf(window.TODAY));
  const [sheet, setSheet] = useStateM(false);

  const range = useMemoM(() => monthRangeOf(key), [key]);
  const derived = useMemoM(
    () => window.deriveRangeActivity(range, tasks, deliverables),
    [range, tasks, deliverables]
  );
  const areas = useMemoM(() => monthFocusAreas(derived.rows), [derived]);

  const thisMonth = key === monthKeyOf(window.TODAY);
  const completedRows = derived.rows.filter(r => r.completedInRange);

  const sectionHead = (icon, title, badge, action) => (
    <div className="ws-head">
      <span style={{ color: 'var(--accent)', display: 'grid', placeItems: 'center' }}>{icon}</span>
      <span className="card-title">{title}</span>
      {badge != null && <span className="ws-badge mono">{badge}</span>}
      <span className="grow" />
      {action}
    </div>
  );

  const cards = [
    { label: 'Completed', val: derived.tasksCompleted, color: 'var(--st-completed)' },
    { label: 'Tasks advanced', val: derived.rows.length, color: 'var(--accent)' },
    { label: 'Focus areas', val: areas.length, color: 'var(--st-inprogress)' },
    { label: 'Deliverables', val: derived.dlvRows.length, color: 'var(--st-waiting)' },
    { label: 'Overall progress', val: `${derived.overallDelta > 0 ? '+' : ''}${derived.overallDelta}%`, color: derived.overallDelta > 0 ? 'var(--st-completed)' : 'var(--muted)' },
  ];

  return (
    <div className="scroll-area fade-in">
      <div className="page-pad" style={{ maxWidth: 960 }}>
        {/* ---- header: month nav + sheet export ---- */}
        <div className="row between center mb16" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="row center" style={{ gap: 6 }}>
            <button className="icon-btn" title="Previous month" onClick={() => setKey(monthShift(key, -1))}><I.chevL size={18} /></button>
            <div style={{ textAlign: 'center', minWidth: 190 }}>
              <div className="dash-greet" style={{ fontSize: 22 }}>
                {range.label}
                {thisMonth && <span className="chip" style={{ marginLeft: 8, background: 'var(--accent-soft)', color: 'var(--accent)' }}>This month</span>}
              </div>
              <div className="dash-date">{range.span}</div>
            </div>
            <button className="icon-btn" title="Next month" onClick={() => setKey(monthShift(key, 1))}><I.chevR size={18} /></button>
          </div>
          <button className="btn btn-primary btn-sm" disabled={!derived.rows.length} onClick={() => setSheet(true)}>
            <I.copy size={14} /> Copy for task sheet
          </button>
        </div>

        {/* ---- month in five numbers ---- */}
        <div className="kpi-grid mb16" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
          {cards.map(s => (
            <div key={s.label} className="kpi" style={{ cursor: 'default', padding: '10px 12px' }}>
              <div className="kpi-val" style={{ color: s.color, fontSize: 24 }}>{s.val}</div>
              <div className="kpi-foot">{s.label}</div>
            </div>
          ))}
        </div>

        {derived.rows.length === 0 && (
          <div className="empty" style={{ marginTop: 40 }}>
            <div style={{ color: 'var(--accent)', display: 'grid', placeItems: 'center', width: 56, height: 56, borderRadius: 14, background: 'var(--accent-soft)', margin: '0 auto 14px' }}><I.calendar size={28} /></div>
            <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text)' }}>Nothing logged in {range.label}</div>
            <div style={{ fontSize: 13.5, maxWidth: 440, margin: '6px auto 0' }}>
              This view is derived from dated progress logs and completion dates — log an update on any task in this range and it appears here automatically.
            </div>
          </div>
        )}

        {/* ---- completed this month: the headline list for the sheet ---- */}
        {completedRows.length > 0 && (
          <div className="ws-section">
            {sectionHead(<I.check size={16} />, 'Completed This Month', completedRows.length,
              <span className="chip" style={{ fontSize: 10 }}>Derived from progress logs</span>)}
            {completedRows.map(r => (
              <div key={r.task.id} className="ws-item" onClick={() => onOpenTask(r.task.id)} style={{ cursor: 'pointer' }}>
                <span className="dot" style={{ background: 'var(--st-completed)', marginTop: 6 }} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{r.task.title}</div>
                  <div className="att-meta">
                    <window.CatChip category={r.task.category || 'Uncategorised'} /><span className="faint">·</span>
                    {r.task.completedAt ? <span>completed {monthDay(r.task.completedAt)}</span> : <span>completed</span>}
                  </div>
                </div>
                <I.chevR size={16} className="faint" />
              </div>
            ))}
          </div>
        )}

        {/* ---- focus areas: exactly the sheet's rows ---- */}
        {areas.map((a, i) => (
          <div key={a.category} className="ws-section">
            {sectionHead(<I.target size={16} />, `${i + 1}. ${a.category}`, a.rows.length,
              <span className="row center" style={{ gap: 8 }}>
                <span className="chip mono" style={{ fontSize: 10 }} title="Effort sizing on the tasks in this area">{a.effort}</span>
                <span className="chip" style={{ fontSize: 10, color: a.completed === a.rows.length ? 'var(--st-completed)' : 'var(--text-2)' }}>{a.status}</span>
              </span>)}
            {a.rows.map(r => <MonthRow key={r.task.id} r={r} onOpenTask={onOpenTask} />)}
          </div>
        ))}

        {/* ---- deliverable rollup ---- */}
        {derived.dlvRows.length > 0 && (
          <div className="ws-section">
            {sectionHead(<I.inbox size={16} />, 'Deliverable Progress', derived.dlvRows.length,
              <span className="chip" style={{ fontSize: 10 }}>Derived</span>)}
            {derived.dlvRows.map(dr => (
              <div key={dr.id} className="ws-item" style={{ alignItems: 'center' }}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{dr.title}</div>
                  <div className="row center" style={{ gap: 8, marginTop: 4 }}>
                    <div className="grow" style={{ maxWidth: 220 }}><window.Progress value={dr.overall} height={6} /></div>
                    <span style={{ fontSize: 12.5, fontWeight: 700 }}>{dr.overall}%</span>
                    <span className="att-meta" style={{ margin: 0 }}>overall · {dr.tasksAdvanced} task{dr.tasksAdvanced === 1 ? '' : 's'} advanced</span>
                  </div>
                </div>
                <span className="chip mono" style={{ fontWeight: 700, color: dr.delta > 0 ? 'var(--st-completed)' : 'var(--muted)' }}>
                  {dr.delta ? `${dr.delta > 0 ? '+' : ''}${dr.delta}%` : 'updated'}
                </span>
              </div>
            ))}
          </div>
        )}

        {derived.rows.length > 0 && (
          <div className="att-meta" style={{ marginTop: 12 }}>
            Effort shown is the S/M/L/XL sizing carried on each task — nothing here measures time,
            so the sheet's Est. Effort column is left blank for you to fill.
          </div>
        )}
      </div>

      {sheet && <MonthSheetModal range={range} areas={areas} derived={derived} onClose={() => setSheet(false)} />}
    </div>
  );
}

window.MonthlyWorkspace = MonthlyWorkspace;
