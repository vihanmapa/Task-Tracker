/* ============================================================
   FM Navigate — Dashboard (widget composition engine)
   ------------------------------------------------------------
   TDD §7.3: dashboards are neither permissions nor fixed layouts —
   they are COMPOSITIONS of widgets, and every widget declares the
   permissions it `requires`. Rendered dashboard = composition minus
   the widgets the signed-in role fails. So a role that loses
   deliverables.read loses the Deliverables widget automatically —
   dashboard visibility can never drift from data visibility.

   Phase 2 ships the engine with one composition (the current layout)
   as the every-role default; per-role compositions become data in
   Phase 3 — configuration, not a rewrite.
   ============================================================ */
const { useState: useStateDash, useMemo: useMemoDash, useEffect: useEffectDash } = React;

function KpiTile({ label, value, foot, footTone, accent, icon, spark, onClick }) {
  return (
    <div className="kpi" onClick={onClick}>
      <div className="kpi-accent" style={{ background: accent }} />
      <div className="kpi-label">{icon}{label}</div>
      <div className="row between center">
        <div className="kpi-val" style={{ color: accent }}>{value}</div>
        {spark && <div style={{ opacity: 0.8 }}>{spark}</div>}
      </div>
      {foot && <div className="kpi-foot" style={footTone ? { color: footTone } : null}>{foot}</div>}
    </div>
  );
}

/* composition slot -> ordered widget keys.

   Phase 3 defines two, chosen by CAPABILITY rather than by role name:

     personal    the default. A user's own work: My Tasks, what's due, what's
                 stuck, what they finished. No organization-wide screens.
     management  selected when the user holds tasks.view_all. The
                 organization's work: everyone's load, what's unassigned,
                 what's overdue across people.

   Selecting on the capability (not on `role === 'product_manager'`) is what
   makes management scope runtime-configurable: granting tasks.view_all in
   Settings → Roles & Permissions moves that role onto the management
   dashboard, with no deployment. The `requires` gate on each widget then
   holds the line independently — a widget whose permission the user lacks
   simply doesn't render. */
const DASH_COMPOSITIONS = {
  personal: {
    top:   ['my_kpis'],
    left:  ['my_tasks', 'my_attention', 'my_week'],
    right: ['ask_ai', 'due_today', 'my_recent'],
  },
  management: {
    top:   ['kpi_row'],
    left:  ['deliverables', 'attention', 'by_person'],
    right: ['ask_ai', 'unassigned', 'due_soon', 'recent'],
  },
};

function Dashboard({ tasks, deliverables = [], onOpen, onOpenDeliverable, onCompose, onAsk, onNav, density, canEdit = true, currentUser = 'richard', scopeCtx = null, onOpenPerson }) {
  const I = window.I;
  const H = window.dlvHelpers;
  const { can, canViewAll } = useAuth();
  const wkStart = window.startOfWeek(window.TODAY), wkEnd = window.endOfWeek(window.TODAY);
  const inWeek = (iso) => iso && new Date(iso) >= wkStart && new Date(iso) <= wkEnd;

  const m = useMemoDash(() => {
    const active = tasks.filter(t => !['Completed', 'Cancelled'].includes(t.status));
    const blocked = tasks.filter(t => t.status === 'Blocked');
    const waiting = tasks.filter(t => t.status === 'Waiting');
    const dueWeek = active.filter(t => inWeek(t.dueDate));
    const completedWeek = tasks.filter(t => t.status === 'Completed' && inWeek(t.completedAt));
    const critical = active.filter(t => t.priority === 'Critical');
    const overdue = active.filter(t => t.dueDate && window.daysBetween(window.TODAY, t.dueDate) < 0);
    const inProgress = tasks.filter(t => t.status === 'In Progress')
      .sort((a, b) => new Date(a.dueDate || 0) - new Date(b.dueDate || 0));

    // attention = blocked + overdue + critical-due-soon, deduped, ranked
    const attMap = new Map();
    const addAtt = (t, reason, sev) => {
      const cur = attMap.get(t.id);
      if (!cur || sev > cur.sev) attMap.set(t.id, { task: t, reason, sev });
    };
    blocked.forEach(t => addAtt(t, t.dependencies?.[0] ? `Blocked — ${t.dependencies[0]}` : 'Blocked', 3));
    overdue.forEach(t => addAtt(t, `Overdue · ${window.relDue(t.dueDate).text}`, 3));
    critical.filter(t => t.dueDate && window.daysBetween(window.TODAY, t.dueDate) <= 3)
      .forEach(t => addAtt(t, `Critical · ${window.relDue(t.dueDate).text}`, 2));
    waiting.filter(t => t.priority === 'High' || t.priority === 'Critical')
      .forEach(t => addAtt(t, t.dependencies?.[0] ? `Waiting on ${t.dependencies[0]}` : 'Waiting', 1));
    const attention = [...attMap.values()].sort((a, b) => b.sev - a.sev || new Date(a.task.dueDate || 0) - new Date(b.task.dueDate || 0));

    const dueSoon = active.filter(t => t.dueDate)
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
      .slice(0, 6);

    const recent = tasks.filter(t => t.status === 'Completed')
      .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt)).slice(0, 5);

    // average % complete across active tasks
    const avgProgress = active.length ? Math.round(active.reduce((s, t) => s + (t.progress || 0), 0) / active.length) : 0;
    // progress updates logged this week
    const updatesWeek = tasks.reduce((s, t) => s + (t.progressLog || []).filter(p => inWeek(p.at)).length, 0);

    return { active, blocked, dueWeek, completedWeek, critical, overdue, inProgress, attention, dueSoon, recent, avgProgress, updatesWeek };
  }, [tasks]);

  // deliverable insights (top-level milestones, subtree rollups)
  const dlv = useMemoDash(() => {
    if (!H || !deliverables.length) return { roots: [], avg: 0, atRisk: 0, delivered: 0 };
    const roots = H.childrenOf(null, deliverables).map(d => {
      const r = H.rollup(d.id, tasks, deliverables);
      const overdue = d.targetDate && window.daysBetween(window.TODAY, d.targetDate) < 0 && r.progress < 100;
      const atRisk = d.status !== 'Delivered' && (r.blocked > 0 || overdue);
      return { d, r, atRisk, overdue };
    });
    const scored = roots.filter(x => x.d.status !== 'Cancelled');
    const avg = scored.length ? Math.round(scored.reduce((s, x) => s + x.r.progress, 0) / scored.length) : 0;
    return {
      roots: roots.sort((a, b) => (b.atRisk - a.atRisk) || (a.r.progress - b.r.progress)),
      avg, atRisk: roots.filter(x => x.atRisk).length,
      delivered: deliverables.filter(d => d.status === 'Delivered').length,
    };
  }, [deliverables, tasks]);

  // AI status line
  /* ---- personal metrics ----
     "Mine" is what is ASSIGNED to me. For a standard user the database has
     already returned nothing else, so this is presentation; for a management
     user it is the difference between their own work and the organization's,
     which is exactly the distinction the personal dashboard exists to make. */
  const p = useMemoDash(() => {
    const S = window.taskScope;
    const mine = S ? S.mine(tasks, scopeCtx || { userId: currentUser }) : [];
    const open = mine.filter(t => !['Completed', 'Cancelled'].includes(t.status));
    const isToday = (iso) => {
      if (!iso) return false;
      const d = new Date(iso), n = window.TODAY;
      return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    };
    const overdue = open.filter(t => t.dueDate && window.daysBetween(window.TODAY, t.dueDate) < 0);
    const dueToday = open.filter(t => isToday(t.dueDate));
    const inProgress = open.filter(t => t.status === 'In Progress');
    const blocked = open.filter(t => t.status === 'Blocked');
    const waiting = open.filter(t => t.status === 'Waiting' || t.status === 'MD Review');
    const completedWeek = mine.filter(t => t.status === 'Completed' && inWeek(t.completedAt));
    const updatesWeek = mine.reduce((n, t) => n + (t.progressLog || []).filter(e => inWeek(e.at)).length, 0);
    const checklistWeek = mine.reduce((n, t) => n + (t.checklist || []).filter(c => c.done && inWeek(c.completedAt)).length, 0);
    const avgProgress = open.length ? Math.round(open.reduce((sum, t) => sum + (t.progress || 0), 0) / open.length) : 0;

    // What needs me first: overdue, then blocked, then waiting, then due today.
    const rank = { over: 3, blocked: 3, waiting: 2, today: 2 };
    const att = new Map();
    const add = (t, reason, sev) => { const c = att.get(t.id); if (!c || sev > c.sev) att.set(t.id, { task: t, reason, sev }); };
    overdue.forEach(t => add(t, `Overdue · ${window.relDue(t.dueDate).text}`, rank.over));
    blocked.forEach(t => add(t, t.dependencies && t.dependencies[0] ? `Blocked — ${t.dependencies[0]}` : 'Blocked', rank.blocked));
    waiting.forEach(t => add(t, t.status === 'MD Review' ? 'Waiting on review' : 'Waiting', rank.waiting));
    dueToday.forEach(t => add(t, 'Due today', rank.today));

    return {
      mine, open, overdue, dueToday, inProgress, blocked, waiting, completedWeek,
      updatesWeek, checklistWeek, avgProgress,
      attention: [...att.values()].sort((a, b) => b.sev - a.sev || new Date(a.task.dueDate || 0) - new Date(b.task.dueDate || 0)),
      // Sorted the way a person actually works: soonest deadline first, then
      // by priority, with undated work last rather than first.
      next: open.slice().sort((a, b) => {
        const ad = a.dueDate ? new Date(a.dueDate) : Infinity, bd = b.dueDate ? new Date(b.dueDate) : Infinity;
        if (ad !== bd) return ad - bd;
        const order = { Critical: 0, High: 1, Medium: 2, Low: 3 };
        return (order[a.priority] ?? 9) - (order[b.priority] ?? 9);
      }),
      recentlyUpdated: mine.slice().sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)).slice(0, 5),
      recentlyDone: mine.filter(t => t.status === 'Completed')
        .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0)).slice(0, 5),
    };
  }, [tasks, scopeCtx, currentUser]);

  // Organization workload, for the management dashboard only.
  const byPerson = useMemoDash(() => {
    if (!canViewAll) return { rows: [], max: 1, unassigned: [] };
    const open = tasks.filter(t => !['Completed', 'Cancelled'].includes(t.status));
    const rows = new Map();
    open.forEach(t => {
      const key = t.assigneeId || t.ownerId;
      if (!key) return;
      const r = rows.get(key) || { key, open: 0, blocked: 0, overdue: 0 };
      r.open += 1;
      if (t.status === 'Blocked') r.blocked += 1;
      if (t.dueDate && window.daysBetween(window.TODAY, t.dueDate) < 0) r.overdue += 1;
      rows.set(key, r);
    });
    const list = [...rows.values()].sort((a, b) => b.open - a.open || b.blocked - a.blocked);
    return { rows: list, max: Math.max(1, ...list.map(r => r.open)), unassigned: open.filter(t => !t.assigneeId && !t.ownerId) };
  }, [tasks, canViewAll]);

  // The line speaks about the work the reader is actually responsible for.
  // Telling a standard user "12 tasks in motion" when 11 are other people's
  // would be both wrong and, after Phase 3, a claim about data they cannot see.
  const statusLine = useMemoDash(() => {
    if (!canViewAll) {
      if (p.mine.length === 0)
        return <span><b>Your workspace is empty.</b> {canEdit ? 'Create your first task to start tracking your work.' : 'Nothing has been assigned to you yet.'}</span>;
      if (p.overdue.length === 0 && p.blocked.length === 0)
        return <span><b>You're on track.</b> {p.open.length} open, {p.inProgress.length} in progress, {p.completedWeek.length} completed this week.</span>;
      return <span><b>{p.attention.length} item{p.attention.length !== 1 ? 's' : ''} need you.</b> {p.overdue.length ? `${p.overdue.length} overdue` : ''}{p.overdue.length && p.blocked.length ? ' · ' : ''}{p.blocked.length ? `${p.blocked.length} blocked` : ''}.</span>;
    }
    const n = m.attention.filter(a => a.sev >= 2).length;
    if (tasks.length === 0)
      return <span><b>No tasks yet.</b> Create the first task to start tracking execution{canEdit ? '' : ' — your role is read-only'}.</span>;
    if (m.blocked.length === 0 && m.overdue.length === 0)
      return <span><b>Execution is on track.</b> {m.inProgress.length} tasks in motion, {m.completedWeek.length} shipped this week. Nothing blocked.</span>;
    return <span><b>{n} item{n !== 1 ? 's' : ''} need attention.</b> {m.blocked.length} blocked{m.overdue.length ? `, ${m.overdue.length} overdue` : ''}.</span>;
  }, [m, p, tasks.length, canEdit, canViewAll]);

  const hour = window.TODAY.getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = (window.USERS[currentUser]?.name || 'there').split(' ')[0];

  /* ---- widget registry ----
     key -> { requires: [[resource, action], …], node }. A widget renders
     only when the role holds EVERY required permission. */
  const TaskRow = ({ t, reason, tone }) => (
    <div className="att-item" onClick={() => onOpen(t.id)} style={{ alignItems: 'center', cursor: 'pointer' }}>
      {tone && <div className="att-flag" style={{ background: tone }} />}
      <div className="att-main">
        <div className="row between center gap12">
          <div className="att-title grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{t.progress || 0}%</span>
        </div>
        <div style={{ marginTop: 8 }}><window.Progress value={t.progress || 0} /></div>
        <div className="att-meta" style={{ marginTop: 8 }}>
          {reason
            ? <span style={{ color: tone || 'var(--text-3)', fontSize: 11.5, fontWeight: 600 }}>{reason}</span>
            : <window.StatusPill status={t.status} dot={false} />}
          <span className="faint">·</span>
          <window.DueTag iso={t.dueDate} />
          <span className="faint">·</span>
          <window.PriorityTag priority={t.priority} />
        </div>
      </div>
      <I.chevR size={16} className="faint" />
    </div>
  );

  const WIDGETS = {
    /* ---------- personal workspace ---------- */
    my_kpis: {
      requires: [['tasks', 'read']],
      node: (
        <div className="kpi-grid">
          <KpiTile label={<>{<I.inbox size={13} />}My open tasks</>} value={p.open.length} accent="var(--accent)"
            foot={`${p.mine.length} assigned to me in total`} onClick={() => onNav('tasks')} />
          <KpiTile label={<>{<I.calendar size={13} />}Due today</>} value={p.dueToday.length} accent="var(--st-waiting)"
            foot={p.overdue.length ? `${p.overdue.length} overdue` : 'nothing overdue'}
            footTone={p.overdue.length ? 'var(--neg)' : null} onClick={() => onNav('tasks')} />
          <KpiTile label={<>{<I.alert size={13} />}Overdue</>} value={p.overdue.length} accent="var(--neg)"
            foot={p.overdue.length ? 'needs a new date or a push' : 'all on time'} onClick={() => onNav('tasks')} />
          <KpiTile label={<>{<I.spark size={13} />}In progress</>} value={p.inProgress.length} accent="var(--st-inprogress)"
            foot={`${p.avgProgress}% average completion`} onClick={() => onNav('tasks')} />
          <KpiTile label={<>{<I.block size={13} />}Blocked / waiting</>} value={p.blocked.length + p.waiting.length}
            accent="var(--st-blocked)"
            foot={p.blocked.length ? `${p.blocked.length} blocked` : 'nothing blocked'} onClick={() => onNav('tasks')} />
          <KpiTile label={<>{<I.check size={13} />}Completed</>} value={p.completedWeek.length} accent="var(--st-completed)"
            foot="this week" onClick={() => onNav('tasks')} />
        </div>
      ),
    },

    my_tasks: {
      requires: [['tasks', 'read']],
      node: (
        <div className="card">
          <div className="card-head">
            <span style={{ color: 'var(--accent)', display: 'grid', placeItems: 'center' }}><I.list size={16} /></span>
            <span className="card-title">My tasks</span>
            <span className="card-title-sub">{p.open.length} open · soonest first</span>
            <span className="grow" />
            <button className="btn btn-subtle btn-sm" onClick={() => onNav('tasks')}>View all</button>
          </div>
          <div style={{ padding: '4px 0' }}>
            {p.next.slice(0, 6).map(t => <TaskRow key={t.id} t={t} />)}
            {p.open.length === 0 && (
              <div className="empty">
                Nothing assigned to you right now.{canEdit ? ' Create a task to start tracking your work.' : ''}
              </div>
            )}
          </div>
        </div>
      ),
    },

    my_attention: {
      requires: [['tasks', 'read']],
      node: (
        <div className="card">
          <div className="card-head">
            <span style={{ color: 'var(--neg)', display: 'grid', placeItems: 'center' }}><I.alert size={17} /></span>
            <span className="card-title">Needs your attention</span>
            <span className="card-title-sub">{p.attention.length} item{p.attention.length === 1 ? '' : 's'}</span>
          </div>
          <div>
            {p.attention.length === 0 && <div className="empty">Nothing overdue, blocked or waiting. You're clear.</div>}
            {p.attention.slice(0, 5).map(({ task, reason, sev }) => (
              <TaskRow key={task.id} t={task} reason={reason} tone={sev >= 3 ? 'var(--neg)' : 'var(--st-waiting)'} />
            ))}
          </div>
        </div>
      ),
    },

    my_week: {
      requires: [['tasks', 'read']],
      node: (
        <div className="card card-pad">
          <div className="section-eyebrow mb12">My week</div>
          <div className="row gap12" style={{ flexWrap: 'wrap' }}>
            <div className="grow" style={{ minWidth: 120 }}>
              <div className="kpi-val" style={{ color: 'var(--st-completed)' }}>{p.completedWeek.length}</div>
              <div className="kpi-foot">tasks completed</div>
            </div>
            <div className="grow" style={{ minWidth: 120 }}>
              <div className="kpi-val" style={{ color: 'var(--accent)' }}>{p.updatesWeek}</div>
              <div className="kpi-foot">progress updates logged</div>
            </div>
            <div className="grow" style={{ minWidth: 120 }}>
              <div className="kpi-val" style={{ color: 'var(--st-inprogress)' }}>{p.checklistWeek}</div>
              <div className="kpi-foot">checklist items done</div>
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <div className="row between center" style={{ marginBottom: 6 }}>
              <span className="muted" style={{ fontSize: 12 }}>Average completion across your open work</span>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{p.avgProgress}%</span>
            </div>
            <window.Progress value={p.avgProgress} />
          </div>
        </div>
      ),
    },

    due_today: {
      requires: [['tasks', 'read']],
      node: (
        <div className="card">
          <div className="card-head">
            <span style={{ color: 'var(--st-waiting)', display: 'grid', placeItems: 'center' }}><I.calendar size={16} /></span>
            <span className="card-title">Due today &amp; overdue</span>
          </div>
          <div>
            {[...p.overdue, ...p.dueToday.filter(t => !p.overdue.includes(t))].slice(0, 6).map(t => {
              const r = window.relDue(t.dueDate);
              const tone = r.tone === 'over' ? 'var(--neg)' : 'var(--st-waiting)';
              return (
                <div key={t.id} className="feed-item" onClick={() => onOpen(t.id)} style={{ cursor: 'pointer' }}>
                  <div style={{ width: 44, flexShrink: 0, textAlign: 'center' }}>
                    <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: tone, lineHeight: 1 }}>{new Date(t.dueDate).getDate()}</div>
                    <div className="faint mono" style={{ fontSize: 9.5, textTransform: 'uppercase' }}>{new Date(t.dueDate).toLocaleDateString('en-US', { month: 'short' })}</div>
                  </div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                    <div className="row gap8 center mt4">
                      <span style={{ color: tone, fontSize: 11.5, fontWeight: 600 }}>{r.text}</span>
                      <window.StatusPill status={t.status} dot={false} />
                    </div>
                  </div>
                </div>
              );
            })}
            {p.overdue.length + p.dueToday.length === 0 &&
              <div className="empty" style={{ padding: '20px 16px', fontSize: 12.5 }}>Nothing due today.</div>}
          </div>
        </div>
      ),
    },

    my_recent: {
      requires: [['tasks', 'read']],
      node: (
        <div className="card">
          <div className="card-head">
            <span style={{ color: 'var(--st-completed)', display: 'grid', placeItems: 'center' }}><I.check size={16} /></span>
            <span className="card-title">Recently completed</span>
            <span className="grow" />
          </div>
          <div>
            {p.recentlyDone.map(t => (
              <div key={t.id} className="feed-item" onClick={() => onOpen(t.id)} style={{ cursor: 'pointer' }}>
                <div className="feed-dot" style={{ background: 'var(--st-completed)' }} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="feed-text" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                  <div className="feed-time">Completed {window.fmtRelTime(t.completedAt)}</div>
                </div>
              </div>
            ))}
            {p.recentlyDone.length === 0 && <div className="empty" style={{ padding: '20px 16px', fontSize: 12.5 }}>Nothing completed yet.</div>}
            {p.recentlyUpdated.length > 0 && (
              <>
                <div className="section-eyebrow" style={{ padding: '10px 16px 4px' }}>Recently updated</div>
                {p.recentlyUpdated.slice(0, 3).map(t => (
                  <div key={'u' + t.id} className="feed-item" onClick={() => onOpen(t.id)} style={{ cursor: 'pointer' }}>
                    <div className="feed-dot" style={{ background: 'var(--accent)' }} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="feed-text" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                      <div className="feed-time">Updated {window.fmtRelTime(t.updatedAt)}</div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      ),
    },

    /* ---------- management oversight ----------
       Both of these declare tasks.view_all, so they cannot render for a user
       whose database scope is personal — the widget gate and the RLS policy
       are driven by the SAME permission key. */
    by_person: {
      requires: [['tasks', 'read'], ['tasks', 'view_all']],
      node: (
        <div className="card">
          <div className="card-head">
            <span style={{ color: 'var(--accent)', display: 'grid', placeItems: 'center' }}><I.users size={16} /></span>
            <span className="card-title">Work by person</span>
            <span className="card-title-sub">{byPerson.rows.length} with open work</span>
            <span className="grow" />
            <button className="btn btn-subtle btn-sm" onClick={() => onNav('people')}>People</button>
          </div>
          <div style={{ padding: '4px 0' }}>
            {byPerson.rows.slice(0, 6).map(r => {
              const u = window.userOf(r.key);
              return (
                <div key={r.key} className="att-item" style={{ alignItems: 'center', cursor: 'pointer' }}
                     onClick={() => onOpenPerson && onOpenPerson(r.key)}>
                  <window.Avatar user={u} size={26} />
                  <div className="att-main">
                    <div className="row between center gap12">
                      <div className="att-title grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</div>
                      <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{r.open}</span>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <window.Progress value={Math.round((r.open / byPerson.max) * 100)}
                        color={r.blocked ? 'var(--st-blocked)' : 'var(--accent)'} />
                    </div>
                    {(r.blocked > 0 || r.overdue > 0) && (
                      <div className="att-meta" style={{ marginTop: 8 }}>
                        {r.blocked > 0 && <span style={{ color: 'var(--st-blocked)', fontSize: 11.5, fontWeight: 600 }}>{r.blocked} blocked</span>}
                        {r.blocked > 0 && r.overdue > 0 && <span className="faint">·</span>}
                        {r.overdue > 0 && <span style={{ color: 'var(--neg)', fontSize: 11.5, fontWeight: 600 }}>{r.overdue} overdue</span>}
                      </div>
                    )}
                  </div>
                  <I.chevR size={16} className="faint" />
                </div>
              );
            })}
            {byPerson.rows.length === 0 && <div className="empty">Nobody has open work right now.</div>}
          </div>
        </div>
      ),
    },

    unassigned: {
      requires: [['tasks', 'read'], ['tasks', 'view_all']],
      node: byPerson.unassigned.length > 0 && (
        <div className="card">
          <div className="card-head">
            <span style={{ color: 'var(--st-waiting)', display: 'grid', placeItems: 'center' }}><I.inbox size={16} /></span>
            <span className="card-title">Unassigned</span>
            <span className="card-title-sub">{byPerson.unassigned.length} waiting for an owner</span>
          </div>
          <div>
            {byPerson.unassigned.slice(0, 5).map(t => (
              <div key={t.id} className="feed-item" onClick={() => onOpen(t.id)} style={{ cursor: 'pointer' }}>
                <div className="feed-dot" style={{ background: 'var(--st-waiting)' }} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="feed-text" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                  <div className="feed-time">{t.legacyOwner ? `was ${t.legacyOwner}` : 'nobody is responsible yet'}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ),
    },

    kpi_row: {
      requires: [['tasks', 'read']],
      node: (
        <div className="kpi-grid">
          <KpiTile label={<>{<I.inbox size={13} />}Active tasks</>} value={m.active.length} accent="var(--accent)"
            foot={<><I.trend size={13} className="trend-up" /><span className="trend-up">+2</span> vs last week</>}
            spark={<window.Spark data={[8,9,10,11,10,12,m.active.length]} />} onClick={() => onNav('tasks')} />
          <KpiTile label={<>{<I.block size={13} />}Blocked</>} value={m.blocked.length} accent="var(--st-blocked)"
            foot={m.blocked.length ? <span style={{ color: 'var(--neg)' }}>Needs unblocking</span> : 'All clear'}
            spark={<window.Spark data={[1,1,2,2,3,2,m.blocked.length]} color="var(--st-blocked)" />} onClick={() => onNav('tasks')} />
          <KpiTile label={<>{<I.calendar size={13} />}Due this week</>} value={m.dueWeek.length} accent="var(--st-waiting)"
            foot={`${m.overdue.length} overdue`} footTone={m.overdue.length ? 'var(--neg)' : null}
            spark={<window.Spark data={[3,4,5,4,5,6,m.dueWeek.length]} color="var(--st-waiting)" />} onClick={() => onNav('tasks')} />
          <KpiTile label={<>{<I.check size={13} />}Completed</>} value={m.completedWeek.length} accent="var(--st-completed)"
            foot="this week" spark={<window.Spark data={[2,3,3,5,4,6,m.completedWeek.length]} color="var(--st-completed)" />} onClick={() => onNav('summary')} />
          <KpiTile label={<>{<I.flame size={13} />}Critical</>} value={m.critical.length} accent="var(--pr-critical)"
            foot="open · high stakes" spark={<window.Spark data={[1,2,2,2,3,2,m.critical.length]} color="var(--pr-critical)" />} onClick={() => onNav('tasks')} />
          <KpiTile label={<>{<I.trend size={13} />}Avg progress</>} value={`${m.avgProgress}%`} accent="var(--st-inprogress)"
            foot={`${m.updatesWeek} update${m.updatesWeek === 1 ? '' : 's'} this week`}
            spark={<window.Spark data={[20,35,40,52,58,65,m.avgProgress]} color="var(--st-inprogress)" />} onClick={() => onNav('tasks')} />
        </div>
      ),
    },

    deliverables: {
      requires: [['deliverables', 'read']],
      node: dlv.roots.length > 0 && (
        <div className="card">
          <div className="card-head">
            <span style={{ color: 'var(--accent)', display: 'grid', placeItems: 'center' }}><I.flag size={16} /></span>
            <span className="card-title">Deliverables</span>
            <span className="card-title-sub">{dlv.avg}% avg · {dlv.atRisk} at risk</span>
            <span className="grow" />
            <button className="btn btn-subtle btn-sm" onClick={() => onNav('deliverables')}>View all</button>
          </div>
          <div style={{ padding: '4px 0' }}>
            {dlv.roots.slice(0, 5).map(({ d, r, atRisk, overdue }) => (
              <div key={d.id} className="att-item" onClick={() => onOpenDeliverable && onOpenDeliverable(d.id)} style={{ alignItems: 'center' }}>
                <div className="att-main">
                  <div className="row between center gap12">
                    <div className="att-title grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</div>
                    <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{r.progress}%</span>
                  </div>
                  <div style={{ marginTop: 8 }}><window.Progress value={r.progress} /></div>
                  <div className="att-meta" style={{ marginTop: 8 }}>
                    <span className="muted" style={{ fontSize: 11.5 }}>{r.done}/{r.total} tasks</span>
                    {r.subCount > 0 && <><span className="faint">·</span><span className="muted" style={{ fontSize: 11.5 }}>{r.subCount} sub</span></>}
                    {r.blocked > 0 && <><span className="faint">·</span><span style={{ color: 'var(--st-blocked)', fontSize: 11.5, fontWeight: 600 }}>{r.blocked} blocked</span></>}
                    {overdue && <><span className="faint">·</span><span style={{ color: 'var(--neg)', fontSize: 11.5, fontWeight: 600 }}>overdue</span></>}
                    {!atRisk && d.status === 'Delivered' && <><span className="faint">·</span><span style={{ color: 'var(--st-completed)', fontSize: 11.5, fontWeight: 600 }}>delivered</span></>}
                  </div>
                </div>
                <I.chevR size={16} className="faint" />
              </div>
            ))}
          </div>
        </div>
      ),
    },

    attention: {
      requires: [['tasks', 'read']],
      node: (
        <div className="card">
          <div className="card-head">
            <span style={{ color: 'var(--neg)', display: 'grid', placeItems: 'center' }}><I.alert size={17} /></span>
            <span className="card-title">Needs your attention</span>
            <span className="card-title-sub">{m.attention.length} items</span>
            <span className="grow" />
            <button className="btn btn-subtle btn-sm" onClick={() => onNav('tasks')}>View all</button>
          </div>
          <div>
            {m.attention.length === 0 && <div className="empty">Nothing needs attention. Everything is moving.</div>}
            {m.attention.slice(0, 5).map(({ task, reason, sev }) => {
              const flag = sev >= 3 ? 'var(--neg)' : sev === 2 ? 'var(--pr-critical)' : 'var(--st-waiting)';
              return (
                <div key={task.id} className="att-item" onClick={() => onOpen(task.id)}>
                  <div className="att-flag" style={{ background: flag }} />
                  <div className="att-main">
                    <div className="att-title">{task.title}</div>
                    <div className="att-meta">
                      <span className="att-reason" style={{ color: flag, fontWeight: 600 }}>{reason}</span>
                      <span className="faint">·</span>
                      <window.CatChip category={task.category} />
                    </div>
                  </div>
                  <window.PriorityTag priority={task.priority} />
                  <I.chevR size={16} className="faint" />
                </div>
              );
            })}
          </div>
        </div>
      ),
    },

    in_progress: {
      requires: [['tasks', 'read']],
      node: (
        <div className="card">
          <div className="card-head">
            <span style={{ color: 'var(--st-inprogress)', display: 'grid', placeItems: 'center' }}><I.spark size={16} /></span>
            <span className="card-title">In progress now</span>
            <span className="card-title-sub">across the organization</span>
            <span className="grow" />
          </div>
          <div style={{ padding: '6px 0' }}>
            {m.inProgress.map(t => (
              <div key={t.id} className="att-item" onClick={() => onOpen(t.id)} style={{ alignItems: 'center' }}>
                <div className="att-main">
                  <div className="row between center gap12">
                    <div className="att-title grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                    <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{t.progress}%</span>
                  </div>
                  <div style={{ marginTop: 8 }}><window.Progress value={t.progress} /></div>
                  <div className="att-meta" style={{ marginTop: 8 }}>
                    <window.PriorityTag priority={t.priority} />
                    <span className="faint">·</span>
                    <window.DueTag iso={t.dueDate} />
                    <span className="faint">·</span>
                    <window.CatChip category={t.category} />
                  </div>
                </div>
              </div>
            ))}
            {m.inProgress.length === 0 && <div className="empty">Nothing actively in progress.</div>}
          </div>
        </div>
      ),
    },

    ask_ai: {
      requires: [['tasks', 'read']],
      node: (
        <div className="rail-ai">
          <div className="row gap8 center mb12">
            <span style={{ color: 'var(--accent)' }}><I.spark size={17} /></span>
            <span className="card-title">Ask the assistant</span>
          </div>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>Answers grounded only in your live task data.</div>
          {['What is Vihan working on?', 'What is blocked and why?', "What's due this week?", 'Summarize project status'].map(q => (
            <button key={q} className="rail-suggest" onClick={() => onAsk(q)}>{q}</button>
          ))}
        </div>
      ),
    },

    due_soon: {
      requires: [['tasks', 'read']],
      node: (
        <div className="card">
          <div className="card-head">
            <span style={{ color: 'var(--st-waiting)', display: 'grid', placeItems: 'center' }}><I.calendar size={16} /></span>
            <span className="card-title">Due soon</span>
          </div>
          <div>
            {m.dueSoon.map(t => {
              const r = window.relDue(t.dueDate);
              const tone = r.tone === 'over' ? 'var(--neg)' : r.tone === 'soon' ? 'var(--st-waiting)' : 'var(--text-3)';
              return (
                <div key={t.id} className="feed-item" onClick={() => onOpen(t.id)} style={{ cursor: 'pointer' }}>
                  <div style={{ width: 44, flexShrink: 0, textAlign: 'center' }}>
                    <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: tone, lineHeight: 1 }}>{new Date(t.dueDate).getDate()}</div>
                    <div className="faint mono" style={{ fontSize: 9.5, textTransform: 'uppercase' }}>{new Date(t.dueDate).toLocaleDateString('en-US', { month: 'short' })}</div>
                  </div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                    <div className="row gap8 center mt4">
                      <span style={{ color: tone, fontSize: 11.5, fontWeight: 600 }}>{r.text}</span>
                      <window.StatusPill status={t.status} dot={false} />
                    </div>
                  </div>
                </div>
              );
            })}
            {m.dueSoon.length === 0 && <div className="empty" style={{ padding: '20px 16px', fontSize: 12.5 }}>Nothing due soon.</div>}
          </div>
        </div>
      ),
    },

    recent: {
      requires: [['tasks', 'read']],
      node: (
        <div className="card">
          <div className="card-head">
            <span style={{ color: 'var(--st-completed)', display: 'grid', placeItems: 'center' }}><I.check size={16} /></span>
            <span className="card-title">Recently completed</span>
          </div>
          <div>
            {m.recent.map(t => (
              <div key={t.id} className="feed-item" onClick={() => onOpen(t.id)} style={{ cursor: 'pointer' }}>
                <div className="feed-dot" style={{ background: 'var(--st-completed)' }} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="feed-text" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                  <div className="feed-time">Completed {window.fmtRelTime(t.completedAt)}</div>
                </div>
              </div>
            ))}
            {m.recent.length === 0 && <div className="empty" style={{ padding: '20px 16px', fontSize: 12.5 }}>Nothing completed yet.</div>}
          </div>
        </div>
      ),
    },
  };

  // Capability, not role name — see the note on DASH_COMPOSITIONS.
  const composition = canViewAll ? DASH_COMPOSITIONS.management : DASH_COMPOSITIONS.personal;
  const allowed = (key) => {
    const w = WIDGETS[key];
    return !!w && w.requires.every(([resource, action]) => can(resource, action));
  };
  const renderSlot = (keys) => keys.filter(allowed).map(k => (
    <React.Fragment key={k}>{WIDGETS[k].node}</React.Fragment>
  ));

  return (
    <div className="page-pad fade-in">
      {/* hello */}
      <div className="dash-hello">
        <div>
          <div className="dash-greet">{greet}, {firstName}</div>
          <div className="dash-date">{window.fmtDateFull(window.TODAY)} · {canViewAll ? 'Execution overview' : 'Your work'}</div>
        </div>
        <div className="row gap8">
          <button className="btn btn-ghost" onClick={() => onNav('summary')}><I.summary size={15} />Weekly summary</button>
          {canEdit && <button className="btn btn-primary" onClick={onCompose}><I.spark size={15} />New task</button>}
        </div>
      </div>

      {/* AI status banner */}
      <div className="ai-status">
        <div style={{ color: 'var(--accent)', flexShrink: 0, display: 'grid', placeItems: 'center', width: 30, height: 30, borderRadius: 8, background: 'var(--surface)', boxShadow: 'var(--shadow-sm)' }}>
          <I.spark size={17} />
        </div>
        <div className="ai-status-text grow">{statusLine}</div>
        <button className="btn btn-subtle btn-sm" onClick={onAsk} style={{ flexShrink: 0 }}>Ask AI <I.arrowR size={14} /></button>
      </div>

      {renderSlot(composition.top)}

      {/* main grid */}
      <div className="dash-grid">
        <div className="dash-col">{renderSlot(composition.left)}</div>
        <div className="dash-col">{renderSlot(composition.right)}</div>
      </div>
    </div>
  );
}

window.Dashboard = Dashboard;
