#!/usr/bin/env node
/* ============================================================
   RBAC Phase 2 — seed ↔ client parity verification (TDD §10 M4)

   Asserts that the table-driven matrix seeded by supabase/schema.sql
   answers RBAC.can() EXACTLY like the Phase-1 hardcoded DEFAULTS for
   every legacy role × every UI-consumed permission check — i.e. the
   migration changes where the rules live, not what anyone can do.

   How: parses the actual seed tuples out of schema.sql (catalog keys,
   role → template mapping, per-template grant tuples), reconstructs
   each role's seeded grant set, then loads the real permissions.js
   twice — once answering from DEFAULTS (fallback mode), once from the
   reconstructed matrix via RBAC.load() with a stub dataService — and
   diffs the answers. Also checks every ALIASES target is a real
   catalog key (the "workspace.write class of bug" guard).

   The three seed statements that aren't plain tuples are mirrored
   here explicitly (marked ⇔ schema.sql):
     · 'everything' template = the whole catalog          (§2.2 first insert)
     · COMMON_READS to every template except 'everything' (§2.2 cross join)
     · comments.write to every template except read_only  (§2.2 third insert)

   Run: node scripts/verify-rbac-parity.mjs   (exit 0 = parity holds)
   ============================================================ */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sql = await readFile(join(root, 'supabase/schema.sql'), 'utf8');
const permissionsJs = await readFile(join(root, 'fm-navigate/permissions.js'), 'utf8');

const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
// The text between the first occurrence of `from` and the next `to` after it.
function section(src, from, to) {
  const i = src.indexOf(from);
  if (i === -1) fail(`schema.sql: expected to find "${from}"`);
  const j = src.indexOf(to, i);
  if (j === -1) fail(`schema.sql: expected "${to}" after "${from}"`);
  return src.slice(i, j);
}

/* ---------- 1. Reconstruct the seeded matrix from schema.sql ---------- */

const phase2 = sql.slice(sql.indexOf('PHASE 2 — TABLE-DRIVEN ROLES & PERMISSIONS'));
if (phase2.length < 1000) fail('Phase 2 section not found in schema.sql');

// Catalog keys: first column of the permissions insert tuples.
const catalogSection = section(phase2, 'insert into public.permissions', 'on conflict (key)');
const CATALOG = new Set([...catalogSection.matchAll(/\(\s*'([a-z_]+\.[a-z_]+)'/g)].map(m => m[1]));

// ENFORCED set: the key list in `update public.permissions set enforced = key in (...)`.
const enforcedSection = section(phase2, 'update public.permissions set enforced = key in', ');');
const ENFORCED = new Set([...enforcedSection.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map(m => m[1]));

// The keys RLS actually gates (authorize('<key>') calls anywhere in schema.sql).
const RLS_ENFORCED = new Set([...sql.matchAll(/authorize\('([a-z_]+\.[a-z_]+)'\)/g)].map(m => m[1]));

// roles: (slug, label, template, is_system, sort)
const rolesSection = section(phase2, 'insert into public.roles', 'on conflict (slug)');
const ROLE_TEMPLATE = {};
for (const m of rolesSection.matchAll(/\(\s*'([a-z_]+)',\s*'[^']+',\s*'([a-z_]+)'/g)) {
  ROLE_TEMPLATE[m[1]] = m[2];
}

// Plain (template, permission) tuples across all template_permissions inserts.
const tmplGrants = {};
const addTmpl = (t, k) => ((tmplGrants[t] = tmplGrants[t] || new Set()).add(k));
for (const m of phase2.matchAll(/\(\s*'([a-z_]+)',\s*'([a-z_]+\.[a-z_]+)'\s*\)/g)) {
  addTmpl(m[1], m[2]);
}
// The execution/development/testing cross join (§2.2): values-tuple templates
// crossed with values-tuple keys.
for (const t of ['execution', 'development', 'testing']) {
  for (const k of ['tasks.create', 'tasks.execute', 'tasks.edit', 'tasks.link']) addTmpl(t, k);
}
// ⇔ schema.sql §2.2: reads every template gets.
const COMMON_READS = ['tasks.read', 'deliverables.read', 'weekly.read',
  'kpi.read', 'reports.read', 'comments.read', 'users.read'];

function seededGrants(role) {
  const template = ROLE_TEMPLATE[role];
  if (!template) fail(`role '${role}' missing from schema.sql roles seed`);
  if (template === 'everything') return new Set(CATALOG);
  const s = new Set(COMMON_READS);
  if (template !== 'read_only') s.add('comments.write');
  for (const k of tmplGrants[template] || []) s.add(k);
  return s;
}

/* ---------- 2. Load the real permissions.js (Node shims) ---------- */

const store = {};
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
new Function(permissionsJs)(); // executes the IIFE → window.RBAC
const RBAC = globalThis.RBAC;

/* ---------- 3. Structural checks ---------- */

const failures = [];

// Every alias target must be a real catalog key.
for (const [from, to] of Object.entries(RBAC.ALIASES)) {
  if (!CATALOG.has(to)) failures.push(`ALIASES['${from}'] → '${to}' is not in the seeded catalog`);
}

// ---- Enforcement-boundary integrity (Phase 2 honest-set guarantees) ----
// Every enforced key is a real catalog key.
for (const k of ENFORCED) if (!CATALOG.has(k)) failures.push(`enforced key '${k}' is not in the catalog`);
// Every alias target is enforced — aliases exist only for LIVE can() call
// sites, so an alias pointing at a Planned key would be an editable-but-dead
// (or worse, a live-but-Planned-labelled) switch.
for (const [from, to] of Object.entries(RBAC.ALIASES)) {
  if (!ENFORCED.has(to)) failures.push(`ALIASES['${from}'] → '${to}' targets a non-enforced key (should be in the enforced set)`);
}
// Every key RLS gates must be enforced — an authorize()'d key the admin UI
// showed as Planned would let an owner think a live rule is inert.
for (const k of RLS_ENFORCED) if (!ENFORCED.has(k)) failures.push(`RLS gates '${k}' but it is not marked enforced`);
// The documented Phase-2 wired set, as an independent cross-check that the SQL
// enforced list didn't drift. Keep in sync with TDD §2.1.
const EXPECTED_ENFORCED = [
  'tasks.read', 'tasks.execute', 'tasks.assign', 'tasks.prioritize', 'tasks.delete',
  'deliverables.read', 'weekly.read', 'kpi.read', 'reports.read',
  'admin.workspace', 'admin.permissions', 'users.assign_roles',
  'comments.write', 'comments.moderate',
];
const expSet = new Set(EXPECTED_ENFORCED);
for (const k of EXPECTED_ENFORCED) if (!ENFORCED.has(k)) failures.push(`expected enforced key '${k}' missing from schema.sql enforced set`);
for (const k of ENFORCED) if (!expSet.has(k)) failures.push(`schema.sql marks '${k}' enforced but it is not in the documented wired set (TDD §2.1)`);
// Every seeded grant must reference a catalog key (FK would catch in-DB;
// this catches it before anyone runs the SQL).
for (const [t, keys] of Object.entries(tmplGrants)) {
  for (const k of keys) if (!CATALOG.has(k)) failures.push(`template '${t}' grants unknown key '${k}'`);
}

/* ---------- 4. Behavioural parity: DEFAULTS vs seeded matrix ---------- */

// Every (resource, action) the UI consumes: the six audited legacy call
// sites + the nav-registry reads + admin/self-gating checks (TDD §4, §7.2).
const UI_CHECKS = [
  ['workspace', 'write'],   // canEdit — governance surfaces
  ['tasks', 'write'],       // canExecute
  ['tasks', 'assign'], ['tasks', 'prioritize'], ['tasks', 'delete'],
  ['users', 'write'],       // Users admin card
  ['tasks', 'read'], ['deliverables', 'read'], ['weekly', 'read'],
  ['kpi', 'read'], ['reports', 'read'], ['workspace', 'read'],
  ['users', 'invite'],
  ['comments', 'write'],
];
// Phase-2-only capabilities: intentionally FALSE in fallback mode for
// everyone (the admin card self-hides until the SQL is applied — the legacy
// wildcard's action list never contained these). Matrix mode: owner only.
const PHASE2_ONLY = [['admin', 'permissions'], ['admin', 'settings']];
const LEGACY_ROLES = Object.keys(RBAC.DEFAULTS);

// Pass 1: fallback mode (matrix not loaded).
const defaultsAnswers = {};
for (const role of LEGACY_ROLES) {
  defaultsAnswers[role] = UI_CHECKS.map(([r, a]) => RBAC.can(role, r, a));
}

// Pass 2: matrix mode via the real load() with a stub dataService.
const rolesRows = Object.keys(ROLE_TEMPLATE).map(slug => ({ slug, label: slug }));
const grantRows = [];
for (const slug of Object.keys(ROLE_TEMPLATE)) {
  for (const key of seededGrants(slug)) grantRows.push({ role_slug: slug, permission_key: key });
}
const ok = await RBAC.load({
  backend: 'supabase',
  listRoles: () => Promise.resolve(rolesRows),
  listRolePermissions: () => Promise.resolve(grantRows),
});
if (!ok || !RBAC.isLive()) fail('RBAC.load() did not enter matrix mode with stub data');

for (const role of LEGACY_ROLES) {
  UI_CHECKS.forEach(([r, a], i) => {
    const viaMatrix = RBAC.can(role, r, a);
    const viaDefaults = defaultsAnswers[role][i];
    if (viaMatrix !== viaDefaults) {
      failures.push(`can('${role}', '${r}', '${a}'): DEFAULTS=${viaDefaults} but seeded matrix=${viaMatrix}`);
    }
  });
}

// Phase-2-only keys: owner-only in matrix mode, false for everyone in
// fallback mode (checked from the pass-1 snapshot: not in UI_CHECKS, so
// assert directly against DEFAULTS semantics — the legacy wildcard's action
// list must not contain them).
for (const [r, a] of PHASE2_ONLY) {
  for (const role of LEGACY_ROLES) {
    const expect = role === 'owner';
    if (RBAC.can(role, r, a) !== expect) {
      failures.push(`can('${role}', '${r}', '${a}') should be ${expect} in seeded matrix`);
    }
  }
  if ((RBAC.DEFAULTS.owner['*'] || []).includes(a)) {
    failures.push(`DEFAULTS owner wildcard unexpectedly contains action '${a}' — fallback would show the admin card pre-migration`);
  }
}

// Owner must hold the entire catalog in matrix mode (Rule 6 precondition).
for (const key of CATALOG) {
  const [r, ...rest] = key.split('.');
  if (!RBAC.can('owner', r, rest.join('.'))) failures.push(`owner missing '${key}' in seeded matrix`);
}

/* ---------- 5. Report ---------- */

if (failures.length) {
  console.error(`✗ RBAC parity FAILED — ${failures.length} mismatch(es):`);
  for (const f of failures) console.error('  · ' + f);
  process.exit(1);
}
console.log(`✓ RBAC parity holds: ${LEGACY_ROLES.length} legacy roles × ${UI_CHECKS.length} UI checks identical in fallback and matrix mode`);
console.log(`  catalog ${CATALOG.size} keys · ${ENFORCED.size} enforced (${CATALOG.size - ENFORCED.size} Planned) · ${Object.keys(ROLE_TEMPLATE).length} seeded roles · ${grantRows.length} seeded grants · aliases + RLS keys enforced`);
