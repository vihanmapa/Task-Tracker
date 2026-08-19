#!/usr/bin/env node
/* ============================================================
   Phase 3 — task authorization verification (REAL Postgres)

   Spins up a throwaway PostgreSQL cluster, loads

     supabase/tests/harness.sql   minimal auth/storage stand-ins
     supabase/schema.sql          the REAL, unmodified schema
     supabase/tests/rls-tests.sql the assertions

   and exits non-zero if any assertion fails. Because the schema file
   is loaded verbatim, the policies exercised here are exactly the ones
   deployed to Supabase — not a re-implementation of them.

   Run: npm run verify:rls

   SKIPS (exit 0, loudly) when no local PostgreSQL is installed, so the
   static suites still run on a machine without a server. CI installs
   one, so the skip never silently hides a regression there.
   ============================================================ */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.FM_TEST_PG_PORT || '55433';

function findBinDir() {
  // Debian/Ubuntu keep the server binaries out of PATH; pick the newest.
  const bases = ['/usr/lib/postgresql', '/usr/local/pgsql', '/opt/homebrew/opt'];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    const versions = readdirSync(base)
      .filter(v => existsSync(join(base, v, 'bin', 'initdb')))
      .sort((a, b) => parseFloat(b) - parseFloat(a));
    if (versions.length) return join(base, versions[0], 'bin');
  }
  const which = spawnSync('which', ['initdb'], { encoding: 'utf8' });
  if (which.status === 0) return dirname(which.stdout.trim());
  return null;
}

const bin = findBinDir();
if (!bin) {
  console.log('⚠ verify:rls SKIPPED — no local PostgreSQL server found.');
  console.log('  Install postgresql (e.g. `apt-get install postgresql`) to run the task');
  console.log('  authorization suite. The static suites (verify:rbac, verify:auth) still ran.');
  process.exit(0);
}

// initdb/postgres refuse to run as root, so when this is executed as root we
// drop to the unprivileged `postgres` account for the server-side commands.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const hasPostgresUser = asRoot && spawnSync('id', ['postgres']).status === 0;
if (asRoot && !hasPostgresUser) {
  console.log('⚠ verify:rls SKIPPED — running as root with no `postgres` user to drop to.');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'fm-rls-'));
const data = join(dir, 'data');
const sock = dir;
let started = false;

function run(cmd, args, opts = {}) {
  const real = asRoot
    ? ['su', ['postgres', '-c', [cmd, ...args].map(a => `'${a}'`).join(' ')]]
    : [cmd, args];
  return spawnSync(real[0], real[1], { encoding: 'utf8', ...opts });
}

function psql(args) {
  return spawnSync(join(bin, 'psql'), ['-h', sock, '-p', PORT, '-U', 'postgres', ...args],
    { encoding: 'utf8', env: { ...process.env, PGOPTIONS: '-c client_min_messages=warning' } });
}

function cleanup() {
  if (started) run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
  try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}
process.on('exit', cleanup);

try {
  if (asRoot) spawnSync('chmod', ['777', dir]);
  let r = run(join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust'], { stdio: 'ignore' });
  if (r.status !== 0) { console.error('initdb failed'); process.exit(1); }

  r = run(join(bin, 'pg_ctl'), ['-D', data, '-o', `-p ${PORT} -k ${sock}`, '-l', join(dir, 'pg.log'), 'start']);
  if (r.status !== 0) {
    console.error('pg_ctl start failed\n', r.stdout, r.stderr);
    try { console.error(readFileSync(join(dir, 'pg.log'), 'utf8')); } catch (_) {}
    process.exit(1);
  }
  started = true;

  r = psql(['-c', 'create database fmtest']);
  if (r.status !== 0) { console.error('createdb failed\n', r.stderr); process.exit(1); }

  // schema.sql is loaded TWICE on purpose. The runbook's first rollout step is
  // "apply supabase/schema.sql (idempotent)" (TDD §20, ADR 0008), so a second
  // apply must be a clean no-op. It was not: a policy rename dropped only its
  // old name, so the re-apply aborted partway and left the whole of §3
  // unapplied. ON_ERROR_STOP=1 turns any regression of that into a failure
  // here, and every assertion below then runs against a twice-applied schema.
  const files = ['supabase/tests/harness.sql', 'supabase/schema.sql',
                 'supabase/schema.sql', 'supabase/tests/rls-tests.sql'];
  const load = psql(['-d', 'fmtest', '-v', 'ON_ERROR_STOP=1', '-q',
    ...files.flatMap(f => ['-f', join(root, f)])]);

  // The report (and any failure line) comes out on stdout; errors on stderr.
  process.stdout.write(load.stdout || '');
  if (load.status !== 0) {
    process.stderr.write(load.stderr || '');
    console.error('\n✗ task authorization verification FAILED');
    process.exit(1);
  }
  // Warnings are fine (wal_level for the realtime publication, etc.).
  const noisy = (load.stderr || '').split('\n').filter(l => /ERROR|FATAL/.test(l));
  if (noisy.length) { console.error(noisy.join('\n')); process.exit(1); }

  console.log('\n✓ task authorization verified against real Postgres policies');
} finally {
  cleanup();
}
