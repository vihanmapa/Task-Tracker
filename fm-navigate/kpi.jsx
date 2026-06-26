/* ============================================================
   FM Navigate — KPI Scorecard
   ------------------------------------------------------------
   Monthly self-scoring scorecard: 22 KPIs (A–E), each scored
   0–5 with notes + evidence links. Auto rolls up to per-category
   averages and an overall score. Mirrors the management workbook
   "FM Navigate – Monthly KPI Self-Scoring Scorecard".

   Most KPIs are scored once a month. KPIs flagged `multi` (A1, A3)
   are scored once per sprint: they hold N ENTRIES, and the KPI's
   collective score = the AVERAGE of those entries.

   Data shape (kpiScores collection), per KPI per month:
     single : { score: 0..5|null, notes, links:[url] }
     multi  : { entries: [ { id, label, score, notes, links:[] } ] }

   Props:
     scores     the kpiScores object (whole)
     month      selected 'YYYY-MM'
     setMonth   (key) => void
     onSetKpi   (month, code, record) => void   (editor only; full record)
     canEdit    bool
   ============================================================ */
const { useState: useStateK, useMemo: useMemoK } = React;

// tone → palette (RAG)
const KPI_TONE = {
  red:    { fg: '#b42318', bg: 'rgba(217,45,32,.12)',  bar: '#f04438' },
  orange: { fg: '#b54708', bg: 'rgba(247,144,9,.14)',  bar: '#f79009' },
  yellow: { fg: '#854a0e', bg: 'rgba(234,179,8,.16)',  bar: '#eab308' },
  green:  { fg: '#067647', bg: 'rgba(18,183,106,.14)', bar: '#12b76a' },
  gray:   { fg: 'var(--text-3)', bg: 'var(--surface-2)', bar: 'var(--border)' },
};

// average score (0–5) → RAG tone (matches the band thresholds)
function avgTone(avg) {
  if (avg == null) return 'gray';
  if (avg >= 3.5) return 'green';
  if (avg >= 2.5) return 'yellow';
  if (avg >= 1.5) return 'orange';
  return 'red';
}

// format a 0–5 number: integers plain, otherwise one decimal
function fmtScore(n) {
  if (n == null) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function newEntryId() { return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// Normalise a stored record into the list of scored entries.
// Single-score records collapse to one entry; legacy records migrate.
function toEntries(rec) {
  if (!rec) return [];
  if (Array.isArray(rec.entries)) return rec.entries;
  if (rec.score != null && rec.score !== '') return [{ id: 'e0', label: '', score: rec.score, notes: rec.notes || '', links: rec.links || [] }];
  if (rec.notes || (rec.links && rec.links.length)) return [{ id: 'e0', label: '', score: null, notes: rec.notes || '', links: rec.links || [] }];
  return [];
}

// Collective KPI score = mean of entries that have a numeric score.
function collective(entries) {
  const xs = entries.filter(e => e.score != null && e.score !== '').map(e => Number(e.score));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// The single 0–5 number a KPI contributes to the rollups.
function kpiScoreOf(def, rec) {
  if (def.multi) return collective(toEntries(rec));
  return rec && rec.score != null && rec.score !== '' ? Number(rec.score) : null;
}

// Build the selectable month list: Mar 2026 → 2 months ahead of today,
// unioned with any month that already has data, newest first.
function buildMonthList(scores) {
  const set = new Set(Object.keys(scores || {}));
  const start = new Date(2026, 2, 1); // Mar 2026
  const end = new Date(); end.setMonth(end.getMonth() + 2);
  const d = new Date(start);
  while (d <= end) { set.add(window.kpiMonthKey(d)); d.setMonth(d.getMonth() + 1); }
  return Array.from(set).sort().reverse();
}

function KpiBars({ cats }) {
  return (
    <div className="kpi-cat-bars">
      {window.KPI_CATEGORY_ORDER.map(code => {
        const c = cats[code];
        const t = KPI_TONE[avgTone(c.avg)];
        const pct = c.avg == null ? 0 : (c.avg / 5) * 100;
        return (
          <div className="kpi-catbar" key={code} title={window.KPI_CATEGORIES[code].name}>
            <div className="kpi-catbar-top">
              <span className="kpi-catbar-code">{code}</span>
              <span className="kpi-catbar-name">{window.KPI_CATEGORIES[code].short}</span>
              <span className="kpi-catbar-val" style={{ color: t.fg }}>
                {c.avg == null ? '—' : c.avg.toFixed(1)}
              </span>
            </div>
            <div className="kpi-catbar-track">
              <div className="kpi-catbar-fill" style={{ width: pct + '%', background: t.bar }} />
            </div>
            <div className="kpi-catbar-foot">{c.scored}/{c.total} scored</div>
          </div>
        );
      })}
    </div>
  );
}

// 0–5 dropdown that colours itself by band; renders a static pill when disabled.
function ScoreSelect({ value, onChange, disabled, size }) {
  const band = window.kpiScoreBand(value);
  const t = KPI_TONE[band ? band.tone : 'gray'];
  if (disabled) {
    return (
      <span className={'kpi-score-pill' + (size === 'sm' ? ' sm' : '')} style={{ color: t.fg, background: t.bg }}>
        {value == null || value === '' ? '—' : value}
      </span>
    );
  }
  return (
    <select
      className={'kpi-score-input' + (size === 'sm' ? ' sm' : '')}
      style={{ color: t.fg, background: t.bg, borderColor: t.bar }}
      value={value == null ? '' : String(value)}
      onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}
    >
      <option value="">—</option>
      {[0, 1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
    </select>
  );
}

function BandTag({ score }) {
  const band = window.kpiScoreBand(score == null ? null : Math.round(score));
  const t = KPI_TONE[band ? band.tone : 'gray'];
  return band
    ? <span className="kpi-band" style={{ color: t.fg, background: t.bg }}>{band.label}</span>
    : <span className="kpi-band kpi-band-empty">Not scored</span>;
}

// Inline editable list of evidence link URLs.
function EvidenceLinks({ links, canEdit, onChange }) {
  const I = window.I;
  return (
    <div className="kpi-ev-links">
      {links.map((url, i) => (
        <div className="kpi-ev-item" key={i}>
          <a href={url} target="_blank" rel="noopener noreferrer" className="kpi-ev-link">{url}</a>
          {canEdit && (
            <button className="kpi-ev-x" title="Remove"
              onClick={() => onChange(links.filter((_, j) => j !== i))}><I.x size={13} /></button>
          )}
        </div>
      ))}
      {canEdit && (
        <form className="kpi-ev-add" onSubmit={e => {
          e.preventDefault();
          const inp = e.target.elements.u;
          const v = (inp.value || '').trim();
          if (!v) return;
          onChange([...links, v]); inp.value = '';
        }}>
          <input name="u" className="kpi-ev-input" placeholder="Paste evidence link (URL)…" />
          <button className="btn sm" type="submit">Add</button>
        </form>
      )}
    </div>
  );
}

// ---- one KPI row ----
function KpiRow({ def, rec, canEdit, onSet }) {
  const I = window.I;
  const [open, setOpen] = useStateK(false);
  const entries = useMemoK(() => toEntries(rec), [rec]);

  if (def.multi) {
    // collective = average of sprint entries
    const avg = collective(entries);
    const setEntries = (next) => onSet({ entries: next });
    const patchEntry = (id, patch) => setEntries(entries.map(e => e.id === id ? { ...e, ...patch } : e));
    const addEntry = () => setEntries([...entries, { id: newEntryId(), label: '', score: null, notes: '', links: [] }]);
    const removeEntry = (id) => setEntries(entries.filter(e => e.id !== id));

    return (
      <>
        <tr className="kpi-row kpi-row-multi" onClick={() => setOpen(o => !o)}>
          <td className="kpi-c-code">{def.code}</td>
          <td className="kpi-c-name">
            <div className="kpi-name-main">{def.name} <span className="kpi-multi-tag">{def.unit || 'Entry'}s · avg</span></div>
            <div className="kpi-name-target">{def.target}</div>
          </td>
          <td className="kpi-c-score">
            <span className="kpi-score-pill" style={{
              color: KPI_TONE[avgTone(avg)].fg, background: KPI_TONE[avgTone(avg)].bg }}>{fmtScore(avg)}</span>
          </td>
          <td className="kpi-c-band"><BandTag score={avg} /></td>
          <td className="kpi-c-notes">
            <span className="kpi-notes-read">
              {entries.length ? `${entries.length} ${(def.unit || 'entry').toLowerCase()}${entries.length > 1 ? 's' : ''}` : 'No entries'}
              <span className="kpi-expand-hint"> · {open ? 'hide' : 'edit'}</span>
            </span>
          </td>
          <td className="kpi-c-ev"><span className={'kpi-chev' + (open ? ' open' : '')}><I.dots size={16} /></span></td>
        </tr>
        {open && (
          <tr className="kpi-ev-row">
            <td />
            <td colSpan={5}>
              <div className="kpi-entries">
                <div className="kpi-ev-title">{def.unit || 'Entry'} scores — collective average {fmtScore(avg)}{avg != null && '/5'}</div>
                {entries.length === 0 && <div className="kpi-ev-empty">No {(def.unit || 'entry').toLowerCase()} scores yet.</div>}
                {entries.map((e, i) => (
                  <div className="kpi-entry" key={e.id}>
                    <div className="kpi-entry-head">
                      {canEdit
                        ? <input className="kpi-entry-label" value={e.label || ''}
                            placeholder={`${def.unit || 'Entry'} ${i + 1} (e.g. Sprint 58)`}
                            onChange={ev => patchEntry(e.id, { label: ev.target.value })} />
                        : <span className="kpi-entry-label-read">{e.label || `${def.unit || 'Entry'} ${i + 1}`}</span>}
                      <ScoreSelect value={e.score} disabled={!canEdit} size="sm"
                        onChange={v => patchEntry(e.id, { score: v })} />
                      <BandTag score={e.score} />
                      {canEdit && <button className="kpi-entry-rm" title="Remove" onClick={() => removeEntry(e.id)}><I.trash size={15} /></button>}
                    </div>
                    {canEdit
                      ? <input className="kpi-notes-input" value={e.notes || ''} placeholder="Notes…"
                          onChange={ev => patchEntry(e.id, { notes: ev.target.value })} />
                      : (e.notes ? <div className="kpi-notes-read">{e.notes}</div> : null)}
                    <EvidenceLinks links={e.links || []} canEdit={canEdit}
                      onChange={links => patchEntry(e.id, { links })} />
                  </div>
                ))}
                {canEdit && <button className="btn sm kpi-add-entry" onClick={addEntry}>+ Add {(def.unit || 'entry').toLowerCase()}</button>}
              </div>
            </td>
          </tr>
        )}
      </>
    );
  }

  // ---- single-score KPI (unchanged behaviour) ----
  const r = rec || {};
  const links = r.links || [];
  const setLinks = (next) => onSet({ ...r, links: next });
  return (
    <>
      <tr className="kpi-row">
        <td className="kpi-c-code">{def.code}</td>
        <td className="kpi-c-name">
          <div className="kpi-name-main">{def.name}</div>
          <div className="kpi-name-target">{def.target}</div>
        </td>
        <td className="kpi-c-score">
          <ScoreSelect value={r.score} disabled={!canEdit} onChange={v => onSet({ ...r, score: v })} />
        </td>
        <td className="kpi-c-band"><BandTag score={r.score} /></td>
        <td className="kpi-c-notes">
          {canEdit
            ? <input className="kpi-notes-input" value={r.notes || ''} placeholder="Notes…"
                onChange={e => onSet({ ...r, notes: e.target.value })} />
            : <span className="kpi-notes-read">{r.notes || '—'}</span>}
        </td>
        <td className="kpi-c-ev">
          <button className="kpi-ev-btn" onClick={() => setOpen(o => !o)}>
            <span className="kpi-link-ico"><I.link size={14} /></span>
            {links.length > 0 && <span className="kpi-ev-count">{links.length}</span>}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="kpi-ev-row">
          <td />
          <td colSpan={5}>
            <div className="kpi-ev-panel">
              <div className="kpi-ev-title">Evidence — {def.type === 'auto' ? 'auto-scorable' : 'manual'}</div>
              {links.length === 0 && <div className="kpi-ev-empty">No evidence links yet.</div>}
              <EvidenceLinks links={links} canEdit={canEdit} onChange={setLinks} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function KpiScorecard({ scores = {}, month, setMonth, onSetKpi, canEdit = false }) {
  const monthList = useMemoK(() => buildMonthList(scores), [scores]);
  const monthData = scores[month] || {};

  const roll = useMemoK(() => {
    const cats = {};
    window.KPI_CATEGORY_ORDER.forEach(code => { cats[code] = { sum: 0, scored: 0, total: 0 }; });
    let sum = 0, scored = 0;
    window.KPI_DEFS.forEach(def => {
      const cat = cats[def.category];
      cat.total += 1;
      const s = kpiScoreOf(def, monthData[def.code]);
      if (s != null) {
        cat.sum += s; cat.scored += 1;
        sum += s; scored += 1;
      }
    });
    window.KPI_CATEGORY_ORDER.forEach(code => {
      const c = cats[code];
      c.avg = c.scored ? c.sum / c.scored : null;
    });
    return { cats, overall: scored ? sum / scored : null, scored, total: window.KPI_DEFS.length };
  }, [monthData]);

  const oTone = KPI_TONE[avgTone(roll.overall)];

  return (
    <div className="kpi-screen">
      {/* ---- header: month + overall ---- */}
      <div className="kpi-head">
        <div className="kpi-head-left">
          <label className="kpi-month-label">Month</label>
          <select className="kpi-month-select" value={month} onChange={e => setMonth(e.target.value)}>
            {monthList.map(k => <option key={k} value={k}>{window.kpiMonthLabel(k)}</option>)}
          </select>
          {!canEdit && <span className="chip kpi-read-chip">Read-only</span>}
        </div>
        <div className="kpi-overall" style={{ borderColor: oTone.bar }}>
          <div className="kpi-overall-val" style={{ color: oTone.fg }}>
            {roll.overall == null ? '—' : roll.overall.toFixed(1)}
            <span className="kpi-overall-max">/5</span>
          </div>
          <div className="kpi-overall-foot">Overall · {roll.scored}/{roll.total} scored</div>
        </div>
      </div>

      {/* ---- per-category rollup bars ---- */}
      <KpiBars cats={roll.cats} />

      {/* ---- score guide ---- */}
      <div className="kpi-guide">
        <b>Score guide:</b> 0 = No progress · 1 = Significant slippage · 2 = Below ·
        3 = Meets · 4 = Exceeds · 5 = Outstanding
      </div>

      {/* ---- category sections ---- */}
      {window.KPI_CATEGORY_ORDER.map(code => {
        const cat = window.KPI_CATEGORIES[code];
        const c = roll.cats[code];
        const t = KPI_TONE[avgTone(c.avg)];
        return (
          <div className="kpi-cat" key={code}>
            <div className="kpi-cat-head">
              <span className="kpi-cat-code">{code}</span>
              <span className="kpi-cat-title">{cat.name}</span>
              <span className="kpi-cat-avg" style={{ color: t.fg, background: t.bg }}>
                avg {c.avg == null ? '—' : c.avg.toFixed(1)}
              </span>
            </div>
            <table className="kpi-table">
              <thead>
                <tr>
                  <th className="kpi-c-code">#</th>
                  <th className="kpi-c-name">KPI / Target</th>
                  <th className="kpi-c-score">Score</th>
                  <th className="kpi-c-band">Status</th>
                  <th className="kpi-c-notes">Notes</th>
                  <th className="kpi-c-ev">Ev.</th>
                </tr>
              </thead>
              <tbody>
                {window.KPI_DEFS.filter(d => d.category === code).map(def => (
                  <KpiRow key={def.code} def={def} rec={monthData[def.code]}
                    canEdit={canEdit} onSet={record => onSetKpi(month, def.code, record)} />
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

window.KpiScorecard = KpiScorecard;
