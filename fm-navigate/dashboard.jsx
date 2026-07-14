/* ============================================================
   FM Navigate — Founder Dashboard (hero screen)
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

function Dashboard({ tasks, deliverables = [], onOpen, onOpenDeliverable, onCompose, onAsk, onNav, density, canEdit = true, currentUser = 'richard' }) {
  const I = window.I;
  const H = window.dlvHelpers;
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
  const statusLine = useMemoDash(() => {
    const n = m.attention.filter(a => a.sev >= 2).length;
    if (tasks.length === 0)
      return <span><b>No tasks yet.</b> Create your first task to start tracking execution{canEdit ? '' : ' — your role is read-only'}.</span>;
    if (m.blocked.length === 0 && m.overdue.length === 0)
      return <span><b>Execution is on track.</b> {m.inProgress.length} tasks in motion, {m.completedWeek.length} shipped this week. Nothing blocked.</span>;
    return <span><b>{n} item{n !== 1 ? 's' : ''} need your attention.</b> {m.blocked.length} blocked{m.overdue.length ? `, ${m.overdue.length} overdue` : ''}.</span>;
  }, [m, tasks.length, canEdit]);

  const hour = window.TODAY.getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = (window.USERS[currentUser]?.name || 'there').split(' ')[0];

  return (
    <div className="page-pad fade-in">
      {/* hello */}
      <div className="dash-hello">
        <div>
          <div className="dash-greet">{greet}, {firstName}</div>
          <div className="dash-date">{window.fmtDateFull(window.TODAY)} · Execution overview</div>
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

      {/* KPI row */}
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

      {/* main grid */}
      <div className="dash-grid">
        <div className="dash-col">
          {/* deliverables */}
          {dlv.roots.length > 0 && (
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
          )}

          {/* needs attention */}
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

          {/* in progress now */}
          <div className="card">
            <div className="card-head">
              <span style={{ color: 'var(--st-inprogress)', display: 'grid', placeItems: 'center' }}><I.spark size={16} /></span>
              <span className="card-title">In progress now</span>
              <span className="card-title-sub">What Vihan is working on</span>
              <span className="grow" />
              <window.Avatar user="vihan" size={24} />
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
        </div>

        {/* right rail */}
        <div className="dash-col">
          {/* ask ai */}
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

          {/* due soon */}
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

          {/* recently completed */}
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
        </div>
      </div>
    </div>
  );
}

window.Dashboard = Dashboard;
