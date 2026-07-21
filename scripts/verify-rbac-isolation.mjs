#!/usr/bin/env node
/* ============================================================
   RBAC — permission cache / account isolation regression test

   Proves an admin account's fetched matrix (and its localStorage cache)
   can NOT be reused by a different account whose own fetch fails. This
   guards the account-isolation fix in permissions.js: the cache is keyed
   by uid and the in-memory matrix resets on account change, so account
   B always falls back to DEFAULTS-for-B — never account A's grants.

   Run: node scripts/verify-rbac-isolation.mjs   (exit 0 = isolated)
   ============================================================ */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = await readFile(join(root, 'fm-navigate/permissions.js'), 'utf8');

// A real-ish localStorage so per-uid keys are observable.
const store = {};
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
new Function(js)();
const RBAC = globalThis.RBAC;

const fails = [];
const check = (cond, msg) => { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) fails.push(msg); };

// Account A = an ADMIN who fetches the FULL matrix (every role, incl. its own
// admin.permissions grant). This is the dangerous cache to leak.
const A = 'uid-admin-A';
const adminRoles = [{ slug: 'owner', label: 'Owner' }, { slug: 'qa', label: 'QA Engineer' }];
const adminGrants = [
  { role_slug: 'owner', permission_key: 'admin.permissions' },
  { role_slug: 'owner', permission_key: 'tasks.execute' },
  { role_slug: 'qa', permission_key: 'tasks.execute' },
];
const dsAdmin = {
  backend: 'supabase',
  listRoles: () => Promise.resolve(adminRoles),
  listRolePermissions: () => Promise.resolve(adminGrants),
};

await RBAC.load(dsAdmin, A);
check(RBAC.isLive() && RBAC.can('owner', 'admin', 'permissions') === true,
  'account A (admin) loads full matrix and can admin.permissions');
check(store['fm_rbac_matrix:' + A] != null, "A's matrix cached under its own uid key");
check(store['fm_rbac_matrix'] == null, 'no global (unscoped) cache key is written');

// --- Account switch: A signs out, B signs in. ---
RBAC.reset();
check(!RBAC.isLive() && RBAC.matrixUid() === null, 'reset() clears in-memory matrix on sign-out');
// Even right after reset, before any B fetch, A's admin grant is not answerable
// from memory (DEFAULTS owner wildcard has no 'permissions' action).
check(RBAC.can('owner', 'admin', 'permissions') === false,
  'post-reset, admin.permissions is no longer answerable from the in-memory matrix');

// Account B = a NON-admin (qa) whose fetch FAILS (network / RLS hiccup).
const B = 'uid-user-B';
const dsDown = {
  backend: 'supabase',
  listRoles: () => Promise.reject(new Error('network down')),
  listRolePermissions: () => Promise.reject(new Error('network down')),
};
const live = await RBAC.load(dsDown, B);

check(live === false && !RBAC.isLive(),
  "B's failed fetch does NOT enter matrix mode (no cache to fall back to for B)");
check(RBAC.matrixUid() === null, "in-memory matrix is not attributed to B (nothing loaded)");
// THE core assertion: B must not gain A's admin capability from A's cache.
check(RBAC.can('qa', 'admin', 'permissions') === false,
  "B (qa) can NOT admin.permissions — A's cached matrix was not reused");
// B falls back to DEFAULTS for B's OWN role only.
check(RBAC.can('qa', 'tasks', 'read') === true, 'B falls back to DEFAULTS for its own role (qa reads)');
check(RBAC.can('qa', 'tasks', 'delete') === false, 'B (qa) has no governance in DEFAULTS');
// A's cache still exists under A's key, untouched — but is unreachable for B.
check(store['fm_rbac_matrix:' + A] != null && store['fm_rbac_matrix:' + B] == null,
  "A's cache remains under A's key; B has no cache key of its own");

// Belt-and-suspenders: if B LATER fetches successfully, it gets B's own matrix.
const dsB = {
  backend: 'supabase',
  listRoles: () => Promise.resolve([{ slug: 'qa', label: 'QA Engineer' }]),
  listRolePermissions: () => Promise.resolve([{ role_slug: 'qa', permission_key: 'tasks.execute' }]),
};
await RBAC.load(dsB, B);
check(RBAC.can('qa', 'tasks', 'write') === true && RBAC.can('qa', 'admin', 'permissions') === false,
  "B's own successful fetch yields B's grants, still no admin.permissions");

if (fails.length) { console.error(`\n✗ isolation FAILED — ${fails.length} assertion(s)`); process.exit(1); }
console.log('\n✓ account isolation holds: a failed second-account fetch never reuses the first account matrix or cache');
