/* ============================================================
   FM Navigate — People (management drill-down)
   ------------------------------------------------------------
   People → a person → their work. Reachable only with tasks.view_all
   (the nav registry gates the item on exactly that capability), and the
   database independently refuses the underlying rows to anyone else — so
   a direct URL to this screen shows a management user their organization
   and everyone else an empty one. The screen cannot leak what RLS won't
   return.

   Deliberately NOT an analytics product: counts, load and what's stuck,
   enough to answer "who is overloaded, what is late, what is nobody's".
   ============================================================ */
const { useMemo: useMemoPeople } = React;

function PeopleScreen({ tasks = [], onOpenPerson, onOpenTask, currentUser }) {
  const I = window.I;
  const { canViewAll } = useAuth();

  const people = useMemoPeople(() => {
    const open = (t) => !['Completed', 'Cancelled'].includes(t.status);
    const overdue = (t) => open(t) && t.dueDate && window.daysBetween(window.TODAY, t.dueDate) < 0;

    const rows = new Map();
    const bucket = (key) => {
      if (!rows.has(key)) {
        rows.set(key, { key: key, total: 0, open: 0, inProgress: 0, blocked: 0, overdue: 0, done: 0, progressSum: 0 });
      }
      return rows.get(key);
    };
    // Everyone in the directory gets a row, even at zero — "nobody has picked
    // anything up" is information a manager needs, and an absent row hides it.
    Object.values(window.USERS || {}).forEach(u => { if (u.profile) bucket(u.id); });

    tasks.forEach(t => {
      const key = t.assigneeId || t.ownerId || '__unassigned';
      const r = bucket(key);
      r.total += 1;
      if (open(t)) { r.open += 1; r.progressSum += (t.progress || 0); }
      if (t.status === 'In Progress') r.inProgress += 1;
      if (t.status === 'Blocked') r.blocked += 1;
      if (overdue(t)) r.overdue += 1;
      if (t.status === 'Completed') r.done += 1;
    });

    const list = [...rows.values()].map(r => ({
      ...r,
      avgProgress: r.open ? Math.round(r.progressSum / r.open) : 0,
      user: r.key === '__unassigned' ? null : window.userOf(r.key),
    }));
    // Most loaded first, then most blocked — the order a manager reads in.
    list.sort((a, b) => (b.open - a.open) || (b.blocked - a.blocked) || (b.total - a.total));
    return { list, max: Math.max(1, ...list.map(r => r.open)) };
  }, [tasks]);

  const unassigned = people.list.find(r => r.key === '__unassigned');
  const members = people.list.filter(r => r.key !== '__unassigned');

  if (!canViewAll) {
    return (
      <div className="scroll-area fade-in">
        <div className="page-pad">
          <div className="empty">This view is for roles with organization-wide task visibility.</div>
        </div>
      </div>
    );
  }

  const Row = ({ r }) => (
    <div className="att-item" style={{ alignItems: 'center', cursor: 'pointer' }}
         onClick={() => onOpenPerson && onOpenPerson(r.key === '__unassigned' ? '__unassigned' : r.key)}>
      {r.user
        ? <window.Avatar user={r.user} size={30} />
        : <div style={{ width: 30, height: 30, borderRadius: 99, display: 'grid', placeItems: 'center',
                        background: 'var(--surface-2)', color: 'var(--text-3)', flexShrink: 0 }}><I.inbox size={15} /></div>}
      <div className="att-main">
        <div className="row between center gap12">
          <div className="att-title grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.user ? r.user.name : 'Unassigned'}
            {r.key === currentUser && <span className="chip" style={{ marginLeft: 8, fontSize: 10, padding: '1px 6px' }}>You</span>}
          </div>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{r.open} open</span>
        </div>
        <div style={{ marginTop: 8 }}>
          {/* Workload bar: this person's open work relative to the busiest
              person, so the comparison is visible at a glance. */}
          <window.Progress value={Math.round((r.open / people.max) * 100)}
            color={r.blocked ? 'var(--st-blocked)' : 'var(--accent)'} />
        </div>
        <div className="att-meta" style={{ marginTop: 8 }}>
          {r.user && <><span className="muted" style={{ fontSize: 11.5 }}>{r.user.role}</span><span className="faint">·</span></>}
          <span className="muted" style={{ fontSize: 11.5 }}>{r.inProgress} in progress</span>
          {r.blocked > 0 && <><span className="faint">·</span><span style={{ color: 'var(--st-blocked)', fontSize: 11.5, fontWeight: 600 }}>{r.blocked} blocked</span></>}
          {r.overdue > 0 && <><span className="faint">·</span><span style={{ color: 'var(--neg)', fontSize: 11.5, fontWeight: 600 }}>{r.overdue} overdue</span></>}
          <span className="faint">·</span>
          <span className="muted" style={{ fontSize: 11.5 }}>{r.avgProgress}% avg</span>
          <span className="faint">·</span>
          <span className="muted" style={{ fontSize: 11.5 }}>{r.done} completed</span>
        </div>
      </div>
      <I.chevR size={16} className="faint" />
    </div>
  );

  return (
    <div className="scroll-area fade-in">
      <div className="page-pad">
        <div className="dash-greet" style={{ fontSize: 23, marginBottom: 4 }}>People</div>
        <div className="dash-date mb16">
          {members.length} member{members.length === 1 ? '' : 's'} · {tasks.length} task{tasks.length === 1 ? '' : 's'} in your organization
        </div>

        <div className="card">
          <div className="card-head">
            <span style={{ color: 'var(--accent)', display: 'grid', placeItems: 'center' }}><I.users size={16} /></span>
            <span className="card-title">Workload by person</span>
            <span className="card-title-sub">open work, busiest first</span>
          </div>
          <div style={{ padding: '4px 0' }}>
            {members.map(r => <Row key={r.key} r={r} />)}
            {members.length === 0 && <div className="empty">No members yet.</div>}
          </div>
        </div>

        {unassigned && unassigned.total > 0 && (
          <div className="card mt16">
            <div className="card-head">
              <span style={{ color: 'var(--st-waiting)', display: 'grid', placeItems: 'center' }}><I.inbox size={16} /></span>
              <span className="card-title">Unassigned</span>
              <span className="card-title-sub">nobody is responsible for these yet</span>
            </div>
            <div style={{ padding: '4px 0' }}><Row r={unassigned} /></div>
          </div>
        )}
      </div>
    </div>
  );
}

window.PeopleScreen = PeopleScreen;
