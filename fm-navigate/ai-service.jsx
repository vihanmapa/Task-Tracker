/* ============================================================
   FM Navigate — AI service (LOCAL ONLY)
   Runs entirely in the browser. No cloud, no Supabase, no API
   keys, no network calls. UI talks to window.aiService.
   Cloud (Supabase Edge Function → Gemini) is a future drop-in;
   see the TODO(gemini) markers and AI_BACKEND switch below.
   ============================================================ */

/* ---------- heuristic task extractor ---------- */
function heuristicParse(desc) {
  const lc = desc.toLowerCase();
  const firstSentence = (desc.split(/[.\n]/)[0] || desc).trim();
  let title = firstSentence.replace(/^(need to|i need to|we need to|please|let's|have to)\s+/i, '');
  title = title.charAt(0).toUpperCase() + title.slice(1);
  if (title.length > 70) title = title.slice(0, 67) + '…';

  let priority = 'Medium';
  if (/\b(critical|urgent|asap|blocker|immediately)\b/.test(lc)) priority = 'Critical';
  else if (/\b(important|high priority|key|crucial|soon)\b/.test(lc)) priority = 'High';
  else if (/\b(low priority|whenever|nice to have|eventually)\b/.test(lc)) priority = 'Low';

  let category = 'Operations';
  const catMap = [
    [/\b(sprint|backlog|release|ship|deploy|delivery)\b/, 'Delivery'],
    [/\b(feature|design|prototype|onboarding|product|ux|redesign)\b/, 'Product Development'],
    [/\b(api|infra|database|bug|code|technical|rate.?limit|webhook|migration)\b/, 'Technical'],
    [/\b(soc 2|gdpr|policy|audit|compliance|security)\b/, 'Compliance'],
    [/\b(demo|deal|prospect|customer|pilot|sales|partner)\b/, 'Sales'],
    [/\b(marketing|launch|copy|campaign|website|pricing page)\b/, 'Marketing'],
    [/\b(investor|board|finance|budget|legal|hr|admin)\b/, 'Administration'],
    [/\b(hire|recruit|vendor|ops|process)\b/, 'Operations'],
  ];
  for (const [re, c] of catMap) if (re.test(lc)) { category = c; break; }

  // due date
  let dueDate = null;
  const wd = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const wdRe = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
  // Explicit due markers win over incidental phrases (e.g. "by Friday" beats a
  // stray "next week" that refers to something else in the text).
  const explicitDow = lc.match(new RegExp('\\b(?:by|on|before|due|target(?:ing)?|deadline|complete[d]? by)\\s+(?:next\\s+)?' + wdRe));
  const dm = lc.match(/\b(today|tomorrow|next week|end of week|eow|this week|next month|end of month|eom)\b/);
  const bareDow = lc.match(new RegExp('\\bnext\\s+' + wdRe)) || lc.match(new RegExp('\\b' + wdRe));
  const base = new Date(window.TODAY);
  const toWeekday = (name) => { const target = wd.indexOf(name); let add = (target - base.getDay() + 7) % 7; if (add === 0) add = 7; base.setDate(base.getDate() + add); return base.toISOString(); };
  if (explicitDow) {
    dueDate = toWeekday(explicitDow[1]);
  } else if (dm) {
    const m = dm[1];
    if (m === 'today') dueDate = base.toISOString();
    else if (m === 'tomorrow') { base.setDate(base.getDate() + 1); dueDate = base.toISOString(); }
    else if (m === 'next month' || m === 'eom' || m === 'end of month') { base.setDate(base.getDate() + 30); dueDate = base.toISOString(); }
    else { const add = (5 - base.getDay() + 7) % 7 || (m === 'next week' ? 7 : 0); base.setDate(base.getDate() + (m === 'next week' ? 7 + (5 - base.getDay()) : add)); dueDate = base.toISOString(); }
  } else if (bareDow) {
    dueDate = toWeekday(bareDow[1]);
  }

  // ---- dependencies ----
  // Split into sentences; first sentence usually feeds the title, so only
  // accept a strong dependency marker there, broader markers elsewhere.
  const sentences = desc.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  const cleanDep = (s) => {
    let d = s.replace(/^(?:we['’]?re|we|i|there['’]?s|there is|it['’]?s)\s+/i, '')
             .replace(/^(?:need to|needs to|need|require|requires|have to|must|please|will|should)\s+/i, '')
             // cut trailing clauses so a dependency stays a single crisp phrase
             .split(/\s*(?:;|,\s+(?:and|but|so|plus|which|where|because|though)\b|—|--)\s*/i)[0]
             .replace(/\s*[.;,]$/, '').trim();
    return d ? d.charAt(0).toUpperCase() + d.slice(1) : '';
  };
  const strongDepRe = /\b(waiting on|waiting for|depends on|dependent on|blocked by|estimates? from|input from|sign.?off from|approval from|once .+ (?:is|are) (?:ready|done|approved)|after .+ (?:is|are) (?:ready|done|approved))\b/i;
  const broadDepRe  = /\b(waiting on|waiting for|depends on|dependent on|blocked by|need[s]?\b[^.\n]*\bfrom\b|require[s]?\b[^.\n]*\bfrom\b|estimates? from|input from|sign.?off|approval|before (?:we can|finalizing|finalising|starting))\b/i;
  const deps = [];
  sentences.forEach((s, idx) => {
    const re = idx === 0 ? strongDepRe : broadDepRe;
    if (re.test(s)) { const d = cleanDep(s); if (d && !deps.includes(d)) deps.push(d); }
  });
  const depsOut = deps.slice(0, 4);

  const scMatch = desc.match(/success (?:means|is|will be|looks like|criteria)[^.\n]*/i)
              || desc.match(/(?:done when|complete when|definition of done[:\s])[^.\n]*/i);
  const successCriteria = scMatch
    ? scMatch[0].replace(/^success (?:means|is|will be|looks like|criteria)\s*:?\s*/i, '')
                .replace(/^(?:done when|complete when|definition of done)\s*:?\s*/i, '').trim()
    : '';

  const riskKw = /\b(risk|risky|concern|concerned|worried|might (?:slip|miss|fail|not)|could (?:slip|fail|delay|miss)|may (?:slip|fail|miss)|at risk|tight (?:deadline|timeline|turnaround)|behind schedule|blocker|bottleneck)\b/i;
  const riskMatch = desc.match(new RegExp('[^.\\n]*' + riskKw.source + '[^.\\n]*', 'i'));
  let risk = '';
  if (riskMatch) {
    // keep only the clause that holds the risk keyword, then strip framing
    const clause = riskMatch[0].split(/\s*(?:;|,\s+(?:and|but|so)\b|—|--)\s*/i).find(p => riskKw.test(p)) || riskMatch[0];
    risk = clause
      .replace(/^.*?\bthere'?s a risk (?:that |of )?/i, '')
      .replace(/^.*?\b(?:the )?risk (?:is|that|of)\s+/i, '')
      .replace(/^(?:we['’]?re|we|i|it['’]?s|there is)\s+/i, '')
      .replace(/^[,;\-\s]+/, '')
      .trim();
    risk = risk ? risk.charAt(0).toUpperCase() + risk.slice(1) : '';
  }

  let status = /\b(blocked|stuck)\b/.test(lc) ? 'Blocked' : /\b(waiting on|waiting for|pending|awaiting)\b/.test(lc) ? 'Waiting' : 'Not Started';

  let effort = 'M';
  if (/\b(quick|small|minor|simple)\b/.test(lc)) effort = 'S';
  else if (/\b(large|big|major|complex|significant)\b/.test(lc)) effort = 'L';

  return { title, priority, category, dueDate, status, dependencies: depsOut, successCriteria, risk, effort };
}

/* ============================================================
   LOCAL AI SERVICE  (no cloud, no API keys, no network)
   ------------------------------------------------------------
   Single abstraction the UI talks to:
     window.aiService.extractTasks(desc)
     window.aiService.askAssistant(question, tasks, history)
     window.aiService.generateWeeklySummary(buckets)

   Today these run on local heuristics + templates. The shapes of
   the inputs/outputs are the contract — keep them stable and the
   UI never has to change when we move to the cloud.

   ┌──────────────── FUTURE CLOUD PATH (not wired yet) ─────────────┐
   │  Browser → Supabase Edge Function (gemini-proxy) → Gemini      │
   │                                                                │
   │  To switch later: implement each method below to POST to the   │
   │  proxy and return the SAME shape. Flip AI_BACKEND to 'gemini'. │
   │  See the TODO(gemini) markers in each method.                  │
   └────────────────────────────────────────────────────────────────┘
   ============================================================ */

// 'local' today. Future: 'gemini' once the Edge Function is deployed.
const AI_BACKEND = 'local';

// Small delay so local logic still feels like a working assistant
// (keeps the shimmer / typing indicators meaningful).
const think = (ms = 480) => new Promise(r => setTimeout(r, ms));

/* ---------- helpers for local Q&A ---------- */
const ownerName = (t) => (window.USERS[t.ownerId] && window.USERS[t.ownerId].name) || 'Unassigned';
const firstName = (t) => ownerName(t).split(' ')[0];
function duePhrase(t) {
  if (!t.dueDate) return 'no due date';
  return window.relDue(t.dueDate).text;
}
function taskLine(t) {
  const bits = [`status ${t.status}`, duePhrase(t)];
  if (t.dependencies && t.dependencies.length) bits.push(`waiting on ${t.dependencies[0]}`);
  return `- **${t.title}** — ${bits.join(' · ')}`;
}
const isActive = (t) => !['Completed', 'Cancelled'].includes(t.status);
function inThisWeek(iso) {
  if (!iso) return false;
  const s = window.startOfWeek(window.TODAY), e = window.endOfWeek(window.TODAY);
  const d = new Date(iso);
  return d >= s && d <= e;
}

/* ---------- local rule-based assistant ----------
   Classifies the question by keyword and answers ONLY from task data,
   formatted as markdown (the chat renders **bold** + "- " bullets). */
function answerLocally(question, tasks) {
  const q = (question || '').toLowerCase();
  const blocked = tasks.filter(t => t.status === 'Blocked' || t.status === 'Waiting');
  const inProgress = tasks.filter(t => t.status === 'In Progress');
  const critical = tasks.filter(t => isActive(t) && t.priority === 'Critical');
  const high = tasks.filter(t => isActive(t) && t.priority === 'High');
  const dueWeek = tasks.filter(t => isActive(t) && t.dueDate && inThisWeek(t.dueDate))
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  const overdue = tasks.filter(t => isActive(t) && t.dueDate && window.daysBetween(window.TODAY, t.dueDate) < 0);
  const completedWeek = tasks.filter(t => t.status === 'Completed' && inThisWeek(t.completedAt));
  const active = tasks.filter(isActive);

  const list = (arr) => arr.map(taskLine).join('\n');
  const none = (s) => `Nothing ${s} right now.`;

  // What is X working on? / in progress
  if (/\b(working on|in progress|doing|focus|underway)\b/.test(q) || /\bvihan\b/.test(q)) {
    if (!inProgress.length) return none('actively in progress');
    const who = firstName(inProgress[0]);
    return `${who} has **${inProgress.length}** task${inProgress.length > 1 ? 's' : ''} in progress:\n${list(inProgress)}`;
  }
  // Blocked / stuck
  if (/\b(block|blocked|stuck|waiting|gated|holding)\b/.test(q)) {
    if (!blocked.length) return 'Nothing is blocked or waiting right now.';
    return `**${blocked.length}** item${blocked.length > 1 ? 's' : ''} blocked or waiting:\n${list(blocked)}`;
  }
  // Due this week / soon
  if (/\b(due|deadline|this week|soon|upcoming)\b/.test(q)) {
    if (!dueWeek.length) return 'Nothing is due this week.';
    return `**${dueWeek.length}** due this week:\n${list(dueWeek)}`;
  }
  // Overdue / late
  if (/\b(overdue|late|past due|missed)\b/.test(q)) {
    if (!overdue.length) return 'No overdue tasks — everything active is on or ahead of schedule.';
    return `**${overdue.length}** overdue:\n${list(overdue)}`;
  }
  // Critical / high priority
  if (/\b(critical|urgent|high priority|important|risk|attention)\b/.test(q)) {
    const top = critical.concat(high);
    if (!top.length) return 'No critical or high-priority items open.';
    return `**${critical.length}** critical and **${high.length}** high-priority open:\n${list(top)}`;
  }
  // Completed this week
  if (/\b(complete|completed|done|finished|shipped)\b/.test(q)) {
    if (!completedWeek.length) return 'Nothing has been marked complete this week yet.';
    return `**${completedWeek.length}** completed this week:\n${list(completedWeek)}`;
  }
  // Summary / status / overview
  if (/\b(summary|summarize|status|overview|how are|where|progress|standup)\b/.test(q)) {
    const lines = [
      `Here's where execution stands:`,
      `- **${active.length}** active · **${inProgress.length}** in progress · **${blocked.length}** blocked/waiting`,
      `- **${dueWeek.length}** due this week · **${completedWeek.length}** completed this week`,
    ];
    if (critical.length) lines.push(`- **${critical.length}** critical: ${critical.map(t => t.title).join('; ')}`);
    if (blocked.length) lines.push(`- Top blocker: **${blocked[0].title}**${blocked[0].dependencies && blocked[0].dependencies.length ? ` — waiting on ${blocked[0].dependencies[0]}` : ''}`);
    return lines.join('\n');
  }
  // Fallback — general snapshot
  return [
    `I answer from your live task data. Here's a quick snapshot:`,
    `- **${active.length}** active tasks, **${blocked.length}** blocked/waiting, **${dueWeek.length}** due this week.`,
    `Try asking: "what's blocked?", "what's due this week?", "show critical tasks", or "summarize status".`,
  ].join('\n');
}

/* ---------- local template weekly summary ---------- */
function summarizeLocally(buckets) {
  const names = (arr, n = 2) => arr.slice(0, n).map(t => t.title).join(', ');
  const c = buckets.completed.length, p = buckets.inProgress.length, b = buckets.blocked.length, u = buckets.upcoming.length;
  const parts = [];
  parts.push(c
    ? `${c} task${c > 1 ? 's' : ''} shipped this week (${names(buckets.completed)}).`
    : `No tasks were marked complete this week.`);
  if (p) {
    const avg = Math.round(buckets.inProgress.reduce((s, t) => s + (t.progress || 0), 0) / p);
    parts.push(`${p} ${p > 1 ? 'are' : 'is'} actively in progress (avg ${avg}% complete) — led by ${names(buckets.inProgress)}.`);
  }
  if (b) {
    const dep = buckets.blocked.find(t => t.dependencies && t.dependencies.length);
    parts.push(`${b} item${b > 1 ? 's are' : ' is'} blocked or waiting${dep ? `, most notably ${dep.title} (waiting on ${dep.dependencies[0]})` : ''}.`);
  }
  if (u) parts.push(`${u} ${u > 1 ? 'tasks are' : 'task is'} coming due soon (${names(buckets.upcoming)}).`);
  return parts.join(' ');
}

/* ---------- tabular (spreadsheet / TSV) paste support ----------
   A paste copied from a spreadsheet or table comes in tab-separated:
   one row per task, columns = fields. Each row → one task. */
function tabularRows(text) {
  const lines = (text || '').replace(/\r/g, '').split('\n').filter(l => l.trim());
  const tabbed = lines.filter(l => l.includes('\t'));
  // treat as a table only if most non-empty lines carry tabs
  if (tabbed.length >= 1 && tabbed.length >= Math.ceil(lines.length * 0.6)) {
    return tabbed.map(l => l.split('\t'));
  }
  return null;
}

const _PRIOS = ['Critical', 'High', 'Medium', 'Low'];
const _STATS = ['Not Started', 'In Progress', 'Waiting', 'Blocked', 'Completed', 'Cancelled'];
const titleCase = (s) => s.replace(/\b\w/g, m => m.toUpperCase());
function hoursToEffort(h) { return h <= 2 ? 'S' : h <= 6 ? 'M' : h <= 16 ? 'L' : 'XL'; }
function mapCategory(s) {
  const lc = (s || '').toLowerCase();
  const m = [
    [/complian|\biso\b|gdpr|audit|\bpolicy\b|soc\s?2|regulat/, 'Compliance'],
    [/technical|infra|devops|architectur|\bapi\b|migration|backend|database/, 'Technical'],
    [/product|strategy|design|\bux\b|prototype|feature|roadmap/, 'Product Development'],
    [/deliver|sprint|release|ship|deploy|pilot env/, 'Delivery'],
    [/sales|deal|prospect|customer|pilot|partner/, 'Sales'],
    [/marketing|launch|campaign|pricing page|website/, 'Marketing'],
    [/operation|process|vendor|hiring|recruit/, 'Operations'],
    [/admin|finance|budget|\bhr\b|legal|investor|board/, 'Administration'],
    [/personal/, 'Personal'],
  ];
  for (const [re, c] of m) if (re.test(lc)) return c;
  return 'Operations';
}

/* One spreadsheet row → one structured task.
   Column ORDER is not assumed. We take cell[0] as Title, cell[1] as the
   Description, then classify the remaining cells by content (the first
   priority/status/effort/due/category match wins). Extra long text cells
   become Dependencies / Success criteria. */
function parseTabularRow(cells) {
  const C = cells.map(s => (s || '').trim());
  const title = C[0] || '(untitled task)';
  const desc = C[1] || C[0] || '';
  const base = { ...heuristicParse([title, desc].filter(Boolean).join('. ')) };

  const consumed = new Set([0, 1]); // title, description
  let prioSet = false, statSet = false, effSet = false, dueSet = false, catSet = false;
  for (let i = 1; i < C.length; i++) {
    const cell = C[i], cl = cell.toLowerCase();
    if (!prioSet && _PRIOS.some(p => p.toLowerCase() === cl)) { base.priority = titleCase(cl); prioSet = true; consumed.add(i); continue; }
    if (!statSet && _STATS.some(s => s.toLowerCase() === cl)) { base.status = titleCase(cl); statSet = true; consumed.add(i); continue; }
    if (!effSet && /^\d+\s*h(ours?|rs?)?$/.test(cl)) { base.effort = hoursToEffort(parseInt(cl, 10)); effSet = true; consumed.add(i); continue; }
    if (!effSet && /^(s|m|l|xl)$/.test(cl)) { base.effort = cl.toUpperCase(); effSet = true; consumed.add(i); continue; }
    if (!dueSet && (/^(today|tomorrow|eow|end of week|next week|next month)$/.test(cl) || /^(by |on |before )?(next\s+)?(sun|mon|tue|wed|thu|fri|sat)/.test(cl) || /\d{4}-\d{2}-\d{2}/.test(cl))) {
      const d = heuristicParse('due ' + cell).dueDate; if (d) { base.dueDate = d; dueSet = true; consumed.add(i); continue; }
    }
    // category cells are short-ish ("X / Y Governance"); don't swallow long prose cells
    if (!catSet && cell.length <= 60 && /governance|complian|technical|deliver|product|strateg|sales|marketing|operation|admin|personal|\biso\b/i.test(cl)) { base.category = mapCategory(cell); catSet = true; consumed.add(i); continue; }
  }

  // Unconsumed long text cells → dependencies (first) / success criteria (last).
  const longCells = C.map((c, i) => ({ c, i })).filter(({ c, i }) => i >= 2 && !consumed.has(i) && c.length > 20).map(x => x.c);
  if (longCells.length >= 1) base.dependencies = longCells[0].split(/\s*[;,]\s*/).map(s => s.trim()).filter(Boolean);
  if (longCells.length >= 2) base.successCriteria = longCells[longCells.length - 1];

  base.title = title.length > 80 ? title.slice(0, 77) + '…' : title;
  base.description = desc;
  base._source = 'local';
  return base;
}

/* ---------- labeled single-task block ----------
   A paste where each FIELD is on its own line as a label followed by value(s),
   sections separated by blank lines:
     title
     Develop ...
     priority
     High
     ...
   This is ONE task, not many. Detect it and map the labels to fields. */
const _LABELS = ['title', 'description', 'priority', 'category', 'due date', 'due', 'status', 'dependencies', 'dependency', 'success criteria', 'success', 'risk', 'effort', 'owner', 'notes'];
const _labelKey = (s) => {
  let k = s.toLowerCase().replace(/:$/, '').trim();
  if (k === 'dependency') k = 'dependencies';
  if (k === 'success') k = 'success criteria';
  if (k === 'due') k = 'due date';
  return k;
};
function isLabeledBlock(text) {
  const lines = (text || '').split(/\r?\n/).map(l => l.trim());
  const hits = new Set();
  for (const l of lines) { const k = _labelKey(l); if (_LABELS.includes(l.toLowerCase().replace(/:$/, '').trim())) hits.add(k); }
  return hits.has('title') && hits.size >= 3;
}
function parseLabeledBlock(text) {
  const lines = (text || '').split(/\r?\n/);
  const vals = {};
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    const norm = line.toLowerCase().replace(/:$/, '').trim();
    if (_LABELS.includes(norm)) { cur = _labelKey(line); vals[cur] = vals[cur] || []; continue; }
    if (cur && line) vals[cur].push(line);
  }
  const j = (k) => (vals[k] || []).join(' ').trim();
  const arr = (k) => (vals[k] || []).filter(Boolean);

  const title = j('title');
  const desc = j('description') || title;
  const base = { ...heuristicParse([title, desc].filter(Boolean).join('. ')) };
  base.title = title || base.title;
  base.description = desc;

  const pr = j('priority');
  if (_PRIOS.some(p => p.toLowerCase() === pr.toLowerCase())) base.priority = titleCase(pr.toLowerCase());
  const st = j('status');
  if (_STATS.some(s => s.toLowerCase() === st.toLowerCase())) base.status = titleCase(st.toLowerCase());
  if (vals['category']) base.category = mapCategory(j('category'));
  const dueRaw = j('due date');
  if (dueRaw) { const d = heuristicParse('due ' + dueRaw).dueDate; if (d) base.dueDate = d; }
  const ef = j('effort');
  if (/^\d+\s*h/i.test(ef)) base.effort = hoursToEffort(parseInt(ef, 10));
  else if (/^(s|m|l|xl)$/i.test(ef)) base.effort = ef.toUpperCase();
  if (arr('dependencies').length) base.dependencies = arr('dependencies');
  if (arr('success criteria').length) base.successCriteria = arr('success criteria').join('; ');
  if (j('risk')) base.risk = j('risk');
  base._source = 'local';
  return base;
}

/* ---------- split a pasted block into separate task descriptions ----------
   Detects, in order: numbered/bulleted lists → blank-line paragraphs → single. */
function splitDescriptions(text) {
  const t = (text || '').trim();
  if (!t) return [];
  const lines = t.split(/\r?\n/);
  const markerRe = /^\s*(?:\d{1,2}[.)]\s+|[-*•·]\s+)/;
  const markerCount = lines.filter(l => markerRe.test(l)).length;

  // 1. List items — each marker line starts a task; continuation lines append.
  if (markerCount >= 2) {
    const items = [];
    let cur = null;
    for (const ln of lines) {
      if (markerRe.test(ln)) { if (cur != null) items.push(cur); cur = ln.replace(markerRe, '').trim(); }
      else if (cur != null) { cur += (ln.trim() ? ' ' + ln.trim() : ''); }
      else if (ln.trim()) { cur = ln.trim(); }
    }
    if (cur != null) items.push(cur);
    const out = items.map(s => s.trim()).filter(Boolean);
    if (out.length >= 2) return out;
  }

  // 2. Blank-line separated paragraphs.
  const paras = t.split(/\n\s*\n+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (paras.length >= 2) return paras;

  // 3. Single task.
  return [t];
}

/* ============================================================
   PUBLIC API — the only thing UI components should call.
   ============================================================ */
const aiService = {
  /* Paste-to-task extraction. Returns the structured task fields. */
  async extractTasks(desc) {
    // TODO(gemini): replace the local branch with a proxy call —
    //   POST {contents, config:{responseSchema}} → gemini-proxy → parse JSON.
    //   Must return the SAME object shape below so ai-compose.jsx is untouched.
    if (AI_BACKEND === 'gemini') { /* return await remoteExtract(desc) */ }
    await think(520);
    // labeled single-task block (title / priority / ... on their own lines)
    if (isLabeledBlock(desc)) return parseLabeledBlock(desc);
    // single spreadsheet row → map its columns
    const rows = tabularRows(desc);
    if (rows && rows.length === 1) return parseTabularRow(rows[0]);
    return { ...heuristicParse(desc), description: desc, _source: 'local' };
  },

  /* Split a pasted block into MANY tasks. Returns an array of task objects,
     each carrying its own `description`. Handles spreadsheet/TSV paste
     (one row per task, columns → fields) as well as lists/paragraphs. */
  async extractMultiple(text) {
    // TODO(gemini): a cloud version could ask the model to segment + extract
    //   in one call. Local version splits, then runs the heuristic per chunk.
    if (isLabeledBlock(text)) { await think(520); return [parseLabeledBlock(text)]; }
    const rows = tabularRows(text);
    if (rows) {
      await think(Math.min(1100, 360 + rows.length * 120));
      return rows.map(parseTabularRow);
    }
    const chunks = splitDescriptions(text);
    await think(Math.min(1100, 360 + chunks.length * 120));
    return chunks.map(c => ({ ...heuristicParse(c), description: c, _source: 'local' }));
  },

  /* How many tasks a pasted block would produce (no extraction). */
  countTasks(text) {
    if (isLabeledBlock(text)) return 1;
    const rows = tabularRows(text);
    return rows ? rows.length : splitDescriptions(text).length;
  },

  /* Grounded Q&A over the current task list. Returns markdown text. */
  async askAssistant(question, tasks, history = []) {
    // TODO(gemini): replace with a proxy call that sends the question +
    //   a compact task context (see buildContext) and returns the model's text.
    if (AI_BACKEND === 'gemini') { /* return await remoteAsk(question, tasks, history) */ }
    await think(420);
    return answerLocally(question, tasks);
  },

  /* One-paragraph executive weekly summary. Returns plain text. */
  async generateWeeklySummary(buckets) {
    // TODO(gemini): replace with a proxy call that summarizes the buckets.
    if (AI_BACKEND === 'gemini') { /* return await remoteSummary(buckets) */ }
    await think(500);
    return summarizeLocally(buckets);
  },
};

/* ---------- compact context builder (kept for the future cloud path) ---------- */
function buildContext(tasks) {
  return tasks.map(t => {
    const owner = ownerName(t);
    const due = t.dueDate ? window.fmtDate(t.dueDate) : 'no date';
    const r = t.dueDate ? window.relDue(t.dueDate).text : '';
    return `- [${t.id}] "${t.title}" | status=${t.status} | priority=${t.priority} | category=${t.category} | owner=${owner} | due=${due} (${r})${t.dependencies && t.dependencies.length ? ` | deps: ${t.dependencies.join('; ')}` : ''}${t.risk ? ` | risk: ${t.risk}` : ''}`;
  }).join('\n');
}

/* ---------- exports ----------
   Primary: window.aiService. Legacy aliases kept so existing components
   keep working; they delegate to the same local logic. */
Object.assign(window, {
  aiService,
  heuristicParse,
  buildContext,
  // legacy aliases (delegate to aiService) —
  parseTaskDescription: (desc) => aiService.extractTasks(desc),
  askAI: (q, tasks, history) => aiService.askAssistant(q, tasks, history),
  generateWeeklyNarrative: (buckets) => aiService.generateWeeklySummary(buckets),
});
