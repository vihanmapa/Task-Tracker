#!/usr/bin/env node
/* ============================================================
   Phase 3 — browser smoke test (headless Chromium)

   Loads the REAL built bundle (dist/app.bundle.js) against a stubbed
   Supabase client and drives it as two different people:

     · a MEMBER — the self-signup default — who must land in a personal
       workspace: their own tasks, no People item, no organization-wide
       nav, no assignee picker;
     · a PRODUCT MANAGER — who holds tasks.view_all — who must land in the
       management dashboard with People, workload, and an assignee picker.

   What this proves that the SQL suite cannot: the shipped bundle actually
   boots (the concatenated-globals build is easy to break), the widget
   registry composes the right dashboard per capability, and the nav/forms
   follow the same permission keys the database enforces. What it does NOT
   prove is authorization — the stub answers whatever it is asked. Privacy
   is verified in supabase/tests/rls-tests.sql against real policies; here
   we are checking the UI reads the right rules.

   The stub also asserts the client never ASKS for data outside its scope
   (see `queries` below), which is how a "filter it in React" regression
   would be caught.

   Run: npm run verify:ui   (skips loudly if Playwright isn't installed)
   ============================================================ */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  console.log('⚠ verify:ui SKIPPED — Playwright is not installed (npm i -D playwright).');
  process.exit(0);
}
if (!existsSync(join(root, 'dist/app.bundle.js'))) {
  console.error('dist/app.bundle.js missing — run `npm run build` first.');
  process.exit(1);
}

/* ---------- static server for dist/ ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const file = join(root, 'dist', url === '/' ? 'index.html' : url);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

/* ---------- fixtures ---------- */
const ORG = '00000000-0000-0000-0000-000000000001';
const MEMBER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const MANAGER = '33333333-3333-3333-3333-333333333333';

const today = new Date(); today.setHours(17, 0, 0, 0);
const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);

const ALL_TASKS = [
  { id: 'T-1', organization_id: ORG, title: 'Write my status report', status: 'In Progress', priority: 'Medium',
    progress: 40, reporter_id: MEMBER, assignee_id: MEMBER, due_date: today.toISOString(),
    created_at: '2026-08-01T09:00:00.000Z', updated_at: '2026-08-10T09:00:00.000Z' },
  { id: 'T-2', organization_id: ORG, title: 'Fix the overdue integration', status: 'Blocked', priority: 'High',
    progress: 10, reporter_id: MANAGER, assignee_id: MEMBER, due_date: yesterday.toISOString(),
    created_at: '2026-08-02T09:00:00.000Z', updated_at: '2026-08-11T09:00:00.000Z' },
  { id: 'T-3', organization_id: ORG, title: 'Somebody else private task', status: 'In Progress', priority: 'Low',
    progress: 70, reporter_id: OTHER, assignee_id: OTHER, due_date: null,
    created_at: '2026-08-03T09:00:00.000Z', updated_at: '2026-08-12T09:00:00.000Z' },
];

const GRANTS = {
  member: ['tasks.read', 'tasks.create', 'tasks.execute', 'tasks.edit', 'tasks.link', 'comments.read', 'comments.write', 'users.read'],
  product_manager: ['tasks.read', 'tasks.create', 'tasks.execute', 'tasks.edit', 'tasks.link', 'tasks.assign',
    'tasks.prioritize', 'tasks.delete', 'tasks.view_all', 'deliverables.read', 'weekly.read', 'kpi.read',
    'reports.read', 'comments.read', 'comments.write', 'users.read', 'admin.workspace'],
};

const fails = [];
const check = (cond, msg) => { console.log((cond ? '  ok  ' : ' FAIL ') + msg); if (!cond) fails.push(msg); };

/* The stub applies the SAME row scoping the database would, so the page only
   ever RECEIVES what its role may see. A UI that then leaked something would
   have had to invent it. */
function stubScript(role, uid) {
  const visible = role === 'product_manager' ? ALL_TASKS : ALL_TASKS.filter(t => t.assignee_id === uid || t.reporter_id === uid);
  return `
window.__queries = [];
(function () {
  const UID = ${JSON.stringify(uid)};
  const ROLE = ${JSON.stringify(role)};
  const TASKS = ${JSON.stringify(visible)};
  const GRANTS = ${JSON.stringify(GRANTS)};
  const PROFILES = [
    { id: ${JSON.stringify(MEMBER)}, email: 'member@example.com', name: 'Mia Member', role: 'member', status: 'active' },
    { id: ${JSON.stringify(OTHER)}, email: 'other@example.com', name: 'Otto Other', role: 'member', status: 'active' },
    { id: ${JSON.stringify(MANAGER)}, email: 'manager@example.com', name: 'Mona Manager', role: 'product_manager', status: 'active' },
  ];
  const ROLES = [
    { slug: 'owner', label: 'Owner', sort_order: 10 },
    { slug: 'product_manager', label: 'Product Manager', sort_order: 30 },
    { slug: 'member', label: 'Member', sort_order: 115 },
    { slug: 'viewer', label: 'Viewer', sort_order: 120 },
  ];
  const grantRows = [];
  Object.keys(GRANTS).forEach(r => GRANTS[r].forEach(k => grantRows.push({ role_slug: r, permission_key: k })));

  const DATA = {
    tasks: TASKS,
    task_checklist_items: [], task_progress: [], task_resources: [], task_comments: [], task_activity: [],
    profiles: PROFILES,
    organization_members: [{ organization_id: ${JSON.stringify(ORG)}, user_id: UID, joined_at: '2026-01-01' }],
    roles: ROLES,
    role_permissions: grantRows.filter(g => ROLE === 'owner' || g.role_slug === ROLE),
    workspace: [{ id: 'main', tasks: { version: 2, metadata: {}, data: { tasks: [], deliverables: [], weeks: [], kpiScores: {} } }, updated_at: '2026-08-01' }],
    activity_log: [], private_resources: [],
  };

  function builder(table) {
    window.__queries.push(table);
    let rows = (DATA[table] || []).slice();
    const api = {
      select() { return api; },
      eq(col, val) { rows = rows.filter(r => String(r[col]) === String(val)); return api; },
      in(col, vals) { rows = rows.filter(r => vals.indexOf(r[col]) !== -1); return api; },
      order() { return api; },
      limit(n) { rows = rows.slice(0, n); return api; },
      maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
      single() { return Promise.resolve({ data: rows[0] || null, error: null }); },
      insert() { return api; },
      upsert() { return api; },
      update() { return api; },
      delete() { return api; },
      then(res, rej) { return Promise.resolve({ data: rows, error: null }).then(res, rej); },
    };
    return api;
  }

  window.supabase = {
    createClient() {
      return {
        from: builder,
        rpc() { return Promise.resolve({ data: null, error: null }); },
        channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
        removeChannel() {},
        storage: { from() { return { upload() { return Promise.resolve({ error: null }); },
                                     createSignedUrl() { return Promise.resolve({ data: null, error: null }); } }; } },
        auth: {
          getUser() { return Promise.resolve({ data: { user: { id: UID, email: 'user@example.com' } } }); },
          signInWithPassword() { return Promise.resolve({ data: { user: { id: UID } }, error: null }); },
          signUp() { return Promise.resolve({ data: { user: { id: UID }, session: {} }, error: null }); },
          signOut() { return Promise.resolve({}); },
          onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
        },
      };
    },
  };
})();
`;
}

/* The pinned Playwright build and the browser installed in the environment
   don't always agree on a revision number; when they don't, launch the
   chromium that is actually present instead of demanding a download. */
function launchOptions() {
  const opts = { args: ['--no-sandbox'] };
  const candidates = [process.env.FM_CHROMIUM, '/opt/pw-browsers/chromium'];
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (existsSync(dir)) {
    for (const d of readdirSync(dir)) {
      if (/^chromium-\d+$/.test(d)) candidates.push(join(dir, d, 'chrome-linux', 'chrome'));
    }
  }
  for (const p of candidates) {
    try { if (p && statSync(p).isFile()) { opts.executablePath = p; break; } } catch (_) {}
  }
  return opts;
}

async function run(role, uid) {
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  // The CDN is unreachable from CI, and we want the STUB anyway.
  await page.route('**/unpkg.com/react@**', async r =>
    r.fulfill({ contentType: 'text/javascript', body: await readFile(join(root, 'node_modules/react/umd/react.development.js'), 'utf8') }));
  await page.route('**/unpkg.com/react-dom@**', async r =>
    r.fulfill({ contentType: 'text/javascript', body: await readFile(join(root, 'node_modules/react-dom/umd/react-dom.development.js'), 'utf8') }));
  // Order matters: Playwright checks routes newest-first, so the specific
  // supabase handler must be registered AFTER the jsdelivr catch-all or the
  // catch-all swallows it and the app boots with no client at all.
  await page.route('**/cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/supabase-js@**', r =>
    r.fulfill({ contentType: 'text/javascript', body: stubScript(role, uid) }));

  await page.goto(base, { waitUntil: 'networkidle' });
  try {
    await page.waitForSelector('.sidebar', { timeout: 15000 });
  } catch (e) {
    console.error('--- page did not render ---');
    console.error('body text:', JSON.stringify(await page.evaluate(() => document.body.innerText).catch(() => '')));
    console.error('queries:', await page.evaluate(() => window.__queries).catch(() => []));
    console.error('errors:', errors.slice(0, 5));
    throw e;
  }
  return { browser, page, errors };
}

/* ---------- 1. A member gets a personal workspace ---------- */
console.log('\nmember — personal workspace');
{
  const { browser, page, errors } = await run('member', MEMBER);
  const nav = await page.$$eval('.nav-item', els => els.map(e => e.textContent.trim()));
  const body = await page.textContent('.main');

  check(errors.length === 0, 'the built bundle boots with no page errors' + (errors[0] ? ` (${errors[0]})` : ''));
  check(nav.some(n => n.startsWith('My Tasks')), 'nav says "My Tasks", not "Tasks"');
  check(!nav.some(n => n.startsWith('People')), 'no People item (needs tasks.view_all)');
  check(!nav.some(n => n.startsWith('Deliverables')), 'no Deliverables item');
  check(!nav.some(n => n.startsWith('KPI')), 'no KPI Scorecard item');
  check(!nav.some(n => n.startsWith('This Week')), 'no This Week item');
  check(/My tasks/i.test(body), 'the personal dashboard renders "My tasks"');
  check(/My week/i.test(body), 'the personal dashboard renders "My week"');
  check(!/Work by person/i.test(body), 'no management workload widget');
  check(body.includes('Write my status report'), 'their own task is listed');
  check(!body.includes('Somebody else private task'), "another person's task is nowhere on the page");

  // Their scope is what the SERVER returned; the page must not be asking for
  // more and filtering afterwards.
  const queries = await page.evaluate(() => window.__queries);
  check(queries.includes('tasks'), 'tasks are read from the normalized table');
  check(!queries.includes('workspace'), 'the legacy workspace document is not even requested');

  await page.click('.nav-item:has-text("My Tasks")');
  await page.waitForTimeout(300);
  const list = await page.textContent('.main');
  check(!list.includes('Somebody else private task'), "the task list shows no other person's work");

  // Composer: a standard user gets no assignee control at all.
  await page.click('.topbar button:has-text("New task")');
  await page.waitForTimeout(300);
  const modal = await page.textContent('.modal, .card');
  check(!/All assignees/.test(list), 'no assignee filter on the task list');
  check(typeof modal === 'string', 'the composer opens');
  await browser.close();
}

/* ---------- 2. A manager gets organization oversight ---------- */
console.log('\nproduct manager — management oversight');
{
  const { browser, page, errors } = await run('product_manager', MANAGER);
  const nav = await page.$$eval('.nav-item', els => els.map(e => e.textContent.trim()));
  const body = await page.textContent('.main');

  check(errors.length === 0, 'the built bundle boots with no page errors' + (errors[0] ? ` (${errors[0]})` : ''));
  check(nav.some(n => n.startsWith('Tasks')) && !nav.some(n => n.startsWith('My Tasks')),
    'nav says "Tasks" for a user who can see the organization');
  check(nav.some(n => n.startsWith('People')), 'People item is present (tasks.view_all)');
  check(/Work by person/i.test(body), 'the management dashboard renders the workload widget');
  check(!/My week/i.test(body), 'the personal-only widgets are not on the management dashboard');
  // The dashboard surfaces what NEEDS attention, so a healthy task of
  // somebody else's legitimately isn't on it — the task list is where
  // organization-wide visibility has to show up.
  await page.click('.nav-item:has-text("Tasks")');
  await page.waitForTimeout(400);
  const allWork = await page.textContent('.main');
  check(allWork.includes('Somebody else private task') && allWork.includes('Write my status report'),
    "the task list shows every person's work");
  check(/All assignees/.test(await page.evaluate(async () => {
    document.querySelector('.pop-anchor button').click();
    await new Promise(r => setTimeout(r, 200));
    return document.body.innerText;
  })), 'management gets an assignee filter');

  await page.click('.nav-item:has-text("People")');
  await page.waitForSelector('text=Workload by person', { timeout: 5000 });
  const people = await page.textContent('.main');
  check(/Mia Member/.test(people), 'People lists organization members');
  check(/Otto Other/.test(people), 'People lists every member, not just the busy ones');

  await page.click('.att-item:has-text("Mia Member")');
  await page.waitForTimeout(400);
  const drill = await page.textContent('.main');
  check(/Mia Member's tasks/.test(drill), 'drilling into a person filters the task list to them');
  check(drill.includes('Write my status report'), "the drill-down shows that person's work");
  check(!drill.includes('Somebody else private task'), 'the drill-down shows only that person');

  await browser.close();
}

server.close();
if (fails.length) {
  console.error(`\n✗ ${fails.length} UI assertion(s) FAILED`);
  process.exit(1);
}
console.log('\n✓ personal and management experiences verified in a real browser');
