/* ============================================================
   FM Navigate — Weekly Summary + Ask AI
   ============================================================ */
const { useState: useStateS, useEffect: useEffectS, useRef: useRefS, useMemo: useMemoS } = React;

/* ---------------- Weekly Summary ---------------- */
function WeeklySummary({ tasks, onOpen }) {
  const I = window.I;
  const wkStart = window.startOfWeek(window.TODAY), wkEnd = window.endOfWeek(window.TODAY);
  const inWeek = (iso) => iso && new Date(iso) >= wkStart && new Date(iso) <= wkEnd;

  const buckets = useMemoS(() => ({
    completed: tasks.filter(t => t.status === 'Completed' && inWeek(t.completedAt)),
    inProgress: tasks.filter(t => t.status === 'In Progress'),
    blocked: tasks.filter(t => t.status === 'Blocked' || t.status === 'Waiting'),
    upcoming: tasks.filter(t => !['Completed','Cancelled'].includes(t.status) && t.dueDate && window.daysBetween(window.TODAY, t.dueDate) >= 0 && window.daysBetween(window.TODAY, t.dueDate) <= 9)
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate)),
  }), [tasks]);

  const [narrative, setNarrative] = useStateS('');
  const [loadingN, setLoadingN] = useStateS(true);
  useEffectS(() => {
    let live = true;
    setLoadingN(true);
    window.aiService.generateWeeklySummary(buckets).then(txt => { if (live) { setNarrative(txt); setLoadingN(false); } });
    return () => { live = false; };
  }, []);

  const sections = [
    { key: 'completed', title: 'Completed', icon: <I.check size={16} />, color: 'var(--st-completed)', items: buckets.completed, sub: 'shipped this week' },
    { key: 'inProgress', title: 'In Progress', icon: <I.spark size={16} />, color: 'var(--st-inprogress)', items: buckets.inProgress, sub: 'actively moving' },
    { key: 'blocked', title: 'Blocked & Waiting', icon: <I.block size={16} />, color: 'var(--st-blocked)', items: buckets.blocked, sub: 'needs unblocking' },
    { key: 'upcoming', title: 'Upcoming', icon: <I.calendar size={16} />, color: 'var(--st-waiting)', items: buckets.upcoming, sub: 'due in the next 10 days' },
  ];

  const weekLabel = `${wkStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${wkEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  return (
    <div className="scroll-area fade-in">
      <div className="page-pad" style={{ maxWidth: 920 }}>
        <div className="row between center mb16" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="dash-greet" style={{ fontSize: 23 }}>Weekly Summary</div>
            <div className="dash-date">Week of {weekLabel}</div>
          </div>
          <button className="btn btn-ghost"><I.send size={14} /> Send to Richard</button>
        </div>

        {/* AI narrative */}
        <div className="ai-status mb16" style={{ alignItems: 'flex-start' }}>
          <div style={{ color: 'var(--accent)', flexShrink: 0, display: 'grid', placeItems: 'center', width: 30, height: 30, borderRadius: 8, background: 'var(--surface)', boxShadow: 'var(--shadow-sm)' }}>
            <I.spark size={17} />
          </div>
          <div className="grow">
            <div className="ai-tag mb8"><I.spark size={12} /> AI executive summary</div>
            {loadingN
              ? <div className="col" style={{ gap: 6 }}><div className="shimmer" style={{ height: 13, width: '92%' }} /><div className="shimmer" style={{ height: 13, width: '80%' }} /></div>
              : <div className="ai-status-text" style={{ lineHeight: 1.6 }}>{narrative || `${buckets.completed.length} tasks completed this week with ${buckets.inProgress.length} in progress. ${buckets.blocked.length} items are blocked or waiting — most notably the investor pack, gated on the Q2 financial close.`}</div>}
          </div>
        </div>

        {/* metric strip */}
        <div className="kpi-grid mb16" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          {sections.map(s => (
            <div key={s.key} className="kpi" style={{ cursor: 'default' }}>
              <div className="kpi-accent" style={{ background: s.color }} />
              <div className="kpi-label">{s.icon}{s.title}</div>
              <div className="kpi-val" style={{ color: s.color, fontSize: 28 }}>{s.items.length}</div>
              <div className="kpi-foot">{s.sub}</div>
            </div>
          ))}
        </div>

        {/* sections */}
        {sections.map(s => (
          <div key={s.key} className="ws-section">
            <div className="ws-head">
              <span style={{ color: s.color, display: 'grid', placeItems: 'center' }}>{s.icon}</span>
              <span className="card-title">{s.title}</span>
              <span className="ws-badge mono">{s.items.length}</span>
            </div>
            {s.items.length === 0
              ? <div className="muted" style={{ fontSize: 13, padding: '4px 0 14px' }}>Nothing here this week.</div>
              : s.items.map(t => (
                <div key={t.id} className="ws-item" onClick={() => onOpen(t.id)} style={{ cursor: 'pointer' }}>
                  <span className="dot" style={{ background: s.color, marginTop: 6 }} />
                  <div className="grow">
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t.title}</div>
                    <div className="att-meta">
                      <window.PriorityTag priority={t.priority} />
                      <span className="faint">·</span>
                      <window.CatChip category={t.category} />
                      {t.dueDate && s.key !== 'completed' && <><span className="faint">·</span><window.DueTag iso={t.dueDate} /></>}
                      {s.key === 'blocked' && t.dependencies?.[0] && <><span className="faint">·</span><span style={{ color: 'var(--st-blocked)', fontSize: 12, fontWeight: 600 }}>{t.dependencies[0]}</span></>}
                      {s.key === 'completed' && <><span className="faint">·</span><span className="muted" style={{ fontSize: 12 }}>{window.fmtRelTime(t.completedAt)}</span></>}
                    </div>
                  </div>
                  <I.chevR size={16} className="faint" />
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Ask AI chat ---------------- */
function renderMd(text) {
  // minimal: **bold**, "- " bullets, paragraphs
  const lines = text.split('\n');
  const out = [];
  let list = null;
  const inline = (s) => {
    const parts = s.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((p, i) => p.startsWith('**') && p.endsWith('**')
      ? <strong key={i}>{p.slice(2, -2)}</strong> : <React.Fragment key={i}>{p}</React.Fragment>);
  };
  lines.forEach((ln, i) => {
    const t = ln.trim();
    if (/^[-*•]\s+/.test(t)) {
      if (!list) list = [];
      list.push(<li key={`li${i}`}>{inline(t.replace(/^[-*•]\s+/, ''))}</li>);
    } else {
      if (list) { out.push(<ul key={`ul${i}`}>{list}</ul>); list = null; }
      if (t) out.push(<p key={`p${i}`}>{inline(t)}</p>);
    }
  });
  if (list) out.push(<ul key="ul-final">{list}</ul>);
  return out;
}

function AskAI({ tasks, initialQuestion, clearInitial }) {
  const I = window.I;
  const { currentUser } = window.useAuth();
  const me = window.USERS[currentUser];
  const firstName = ((me && me.name) || '').trim().split(/\s+/)[0] || 'there';
  const [messages, setMessages] = useStateS([
    { role: 'ai', text: `Hi ${firstName} — I'm your execution assistant. Ask me anything about what's in motion, what's blocked, or what's due. I answer only from your live task data.` },
  ]);
  const [input, setInput] = useStateS('');
  const [busy, setBusy] = useStateS(false);
  const scrollRef = useRefS(null);

  const suggestions = ['What is Vihan working on?', 'What is blocked and why?', "What's due this week?", 'Show me the critical tasks', 'Summarize project status', 'What did we complete this week?'];

  const send = async (text) => {
    const q = (text || input).trim();
    if (!q || busy) return;
    setInput('');
    const next = [...messages, { role: 'user', text: q }];
    setMessages(next);
    setBusy(true);
    const answer = await window.aiService.askAssistant(q, tasks, next);
    setMessages(m => [...m, { role: 'ai', text: answer }]);
    setBusy(false);
  };

  useEffectS(() => {
    if (initialQuestion) { send(initialQuestion); clearInitial(); }
    // eslint-disable-next-line
  }, [initialQuestion]);

  useEffectS(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  return (
    <div className="chat-wrap fade-in">
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-inner">
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.role === 'ai'
                ? <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent)', color: 'var(--accent-fg)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><I.spark size={16} /></span>
                : <window.Avatar user={currentUser} size={30} />}
              <div className="msg-bubble">{m.role === 'ai' ? renderMd(m.text) : m.text}</div>
            </div>
          ))}
          {busy && (
            <div className="msg ai">
              <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent)', color: 'var(--accent-fg)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><I.spark size={16} /></span>
              <div className="msg-bubble row gap6 center" style={{ padding: '14px 16px' }}>
                <span className="typing-dot" /><span className="typing-dot" style={{ animationDelay: '.2s' }} /><span className="typing-dot" style={{ animationDelay: '.4s' }} />
              </div>
            </div>
          )}
          {messages.length === 1 && !busy && (
            <div className="fade-in" style={{ marginTop: 4 }}>
              <div className="section-eyebrow mb8">Try asking</div>
              <div className="row wrap gap8">
                {suggestions.map(s => (
                  <button key={s} className="filter-pill" onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="chat-compose">
        <div className="chat-inputbar">
          <textarea rows={1} placeholder="Ask about your tasks…" value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <button className="btn btn-primary" onClick={() => send()} disabled={busy || !input.trim()} style={{ padding: '9px 12px' }}><I.send size={16} /></button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { WeeklySummary, AskAI });
