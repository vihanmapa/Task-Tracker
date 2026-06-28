/* ============================================================
   FM Navigate — Shared primitives + helpers
   ============================================================ */
const { useState, useEffect, useRef, useMemo, useCallback } = React;

/* ---------- status / priority maps ---------- */
const STATUS_META = {
  'Not Started': { c: 'var(--st-notstarted)', bg: 'var(--st-notstarted-bg)' },
  'In Progress': { c: 'var(--st-inprogress)', bg: 'var(--st-inprogress-bg)' },
  'Waiting':     { c: 'var(--st-waiting)',    bg: 'var(--st-waiting-bg)' },
  'Blocked':     { c: 'var(--st-blocked)',    bg: 'var(--st-blocked-bg)' },
  'MD Review':   { c: 'var(--st-mdreview)',   bg: 'var(--st-mdreview-bg)' },
  'Completed':   { c: 'var(--st-completed)',  bg: 'var(--st-completed-bg)' },
  'Cancelled':   { c: 'var(--st-cancelled)',  bg: 'var(--st-cancelled-bg)' },
};
const PRIO_META = {
  Critical: { c: 'var(--pr-critical)', label: 'Critical' },
  High:     { c: 'var(--pr-high)',     label: 'High' },
  Medium:   { c: 'var(--pr-medium)',   label: 'Medium' },
  Low:      { c: 'var(--pr-low)',      label: 'Low' },
};

/* ---------- date helpers ---------- */
const TD = window.TODAY;
const startOfWeek = (base) => { const x = new Date(base); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); x.setHours(0,0,0,0); return x; };
const endOfWeek = (base) => { const s = startOfWeek(base); const e = new Date(s); e.setDate(e.getDate() + 6); e.setHours(23,59,59,999); return e; };
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

function relDue(iso) {
  if (!iso) return { text: 'No date', tone: 'faint' };
  const diff = daysBetween(TD, iso);
  if (diff < 0) return { text: `${Math.abs(diff)}d overdue`, tone: 'over' };
  if (diff === 0) return { text: 'Due today', tone: 'soon' };
  if (diff === 1) return { text: 'Due tomorrow', tone: 'soon' };
  if (diff <= 6) return { text: `Due in ${diff}d`, tone: diff <= 2 ? 'soon' : 'norm' };
  return { text: fmtDate(iso), tone: 'norm' };
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtDateFull(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtRelTime(iso) {
  if (!iso) return '—';
  // use live "now" (not the load-time anchor) so fresh events read correctly
  const diff = daysBetween(iso, new Date());
  if (diff <= 0) return 'just now';
  if (diff === 1) return 'yesterday';
  if (diff < 7) return `${diff}d ago`;
  if (diff < 14) return 'last week';
  return fmtDate(iso);
}

/* ---------- primitives ---------- */
function Avatar({ user, size = 26 }) {
  const u = typeof user === 'string' ? window.USERS[user] : user;
  if (!u) return null;
  return (
    <div className="avatar" title={`${u.name} · ${u.role}`}
      style={{ width: size, height: size, background: u.color, fontSize: size * 0.4 }}>
      {u.initials}
    </div>
  );
}

function StatusPill({ status, dot = true }) {
  const m = STATUS_META[status] || STATUS_META['Not Started'];
  return (
    <span className="pill" style={{ background: m.bg, color: m.c }}>
      {dot && <span className="dot" style={{ background: m.c }} />}
      {status}
    </span>
  );
}

function PriorityTag({ priority, bar = true }) {
  const m = PRIO_META[priority] || PRIO_META.Medium;
  return (
    <span className="prio" style={{ color: m.c }}>
      {bar && <span className="prio-bar" style={{ background: m.c }} />}
      {m.label}
    </span>
  );
}

function DueTag({ iso, icon = true }) {
  const r = relDue(iso);
  const color = r.tone === 'over' ? 'var(--neg)' : r.tone === 'soon' ? 'var(--st-waiting)' : 'var(--text-3)';
  return (
    <span style={{ color, fontSize: 12, fontWeight: r.tone === 'over' || r.tone === 'soon' ? 600 : 500, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      {icon && <I.clock size={13} />}{r.text}
    </span>
  );
}

function CatChip({ category }) {
  return <span className="chip">{category}</span>;
}

function Progress({ value, color = 'var(--accent)', height = 6 }) {
  return (
    <div className="prog-track" style={{ height }}>
      <div className="prog-fill" style={{ width: `${value}%`, background: color }} />
    </div>
  );
}

function Ring({ value, size = 40, sw = 4, color = 'var(--accent)' }) {
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={sw} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={sw}
        strokeDasharray={c} strokeDashoffset={c - (c * value) / 100} strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset .5s ease' }} />
    </svg>
  );
}

/* tiny inline sparkline */
function Spark({ data, color = 'var(--accent)', w = 64, h = 22 }) {
  const max = Math.max(...data, 1), min = Math.min(...data, 0);
  const rng = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / rng) * (h - 3) - 1.5}`).join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Modal({ children, onClose, width = 640 }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="modal" style={{ maxWidth: width }} onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

/* effort label */
const EFFORT_LABEL = { S: 'Small', M: 'Medium', L: 'Large', XL: 'X-Large' };

/* Markdown — renders pasted markdown (headings, bold, lists, tables) as HTML.
   Sanitized with DOMPurify since notes are shared/multi-user. Falls back to
   plain text if the CDN libs failed to load. */
function Markdown({ text, className }) {
  const html = useMemo(() => {
    const src = text == null ? '' : String(text);
    if (!src.trim()) return '';
    if (!window.marked) return null; // signal plaintext fallback
    const raw = window.marked.parse(src, { gfm: true, breaks: true });
    return window.DOMPurify ? window.DOMPurify.sanitize(raw) : raw;
  }, [text]);
  if (text == null || !String(text).trim()) return null;
  const cls = ('md ' + (className || '')).trim();
  if (html === null) return <div className={cls} style={{ whiteSpace: 'pre-wrap' }}>{String(text)}</div>;
  return <div className={cls} dangerouslySetInnerHTML={{ __html: html }} />;
}

// Header save indicator — reflects the REAL result of the workspace write.
// 'saved' only shows after Supabase confirmed a row was actually written
// (see ds.saveWorkspace .select() check), so it is honest persistence, not a
// fire-and-forget guess. 'error' surfaces silent RLS blocks the user would
// otherwise never see.
function SaveIndicator({ status }) {
  const s = status || { state: 'idle' };
  if (s.state === 'idle') return null;
  if (s.state === 'saving') {
    return <span className="save-ind save-ind-busy" title="Saving to Supabase"><I.refresh size={13} /> Saving…</span>;
  }
  if (s.state === 'saved') {
    const t = new Date(s.at || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return <span className="save-ind save-ind-ok" title="Confirmed written to Supabase"><I.check size={13} /> Saved {t}</span>;
  }
  // Short label per failure reason; full detail in the tooltip.
  const REASON_LABEL = {
    RLS_BLOCKED: 'No write access',
    ROW_NOT_FOUND: 'Not seeded',
    NO_CLIENT: 'Offline',
    UPDATE_ERROR: 'Save failed',
    EXCEPTION: 'Save failed',
  };
  const label = REASON_LABEL[s.reason] || 'Save failed';
  return <span className="save-ind save-ind-err" title={s.error || 'Save failed'}><I.alert size={13} /> {label}</span>;
}

Object.assign(window, {
  STATUS_META, PRIO_META, EFFORT_LABEL,
  startOfWeek, endOfWeek, daysBetween, relDue, fmtDate, fmtDateFull, fmtRelTime,
  Avatar, StatusPill, PriorityTag, DueTag, CatChip, Progress, Ring, Spark, Modal, Markdown,
  SaveIndicator,
});
