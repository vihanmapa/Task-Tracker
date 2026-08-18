// Build step for GitHub Pages.
//
// The source files in fm-navigate/ are plain <script>-tag globals (no ESM):
// they share one global scope and reference each other by bare identifier
// (e.g. STATUS_META / daysBetween / Avatar declared in components.jsx, used
// across tasks.jsx, dashboard.jsx, ...). So we DO NOT use
// esbuild --bundle (which module-wraps each file and breaks that shared scope).
//
// Instead: transform JSX -> JS per file, then concatenate in the exact order
// the original index.html loaded them, into one app.bundle.js. This is
// byte-for-byte the same execution model as today's many <script> tags, minus
// the in-browser Babel compile and minus 11 extra requests.
//
// minifyIdentifiers is OFF on purpose: renaming top-level names would break the
// cross-file bare references. We still get the size win from whitespace/syntax.

import { transform } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = 'fm-navigate';
const OUT = 'dist';

// Plain-JS globals, in load/scope order (config -> data layer -> seed data).
const PLAIN_JS = ['config.js', 'permissions.js', 'auth-bootstrap.js', 'data-service.js', 'task-store.js', 'kpi-data.js', 'data.js'];

// JSX files, in the same order index.html declared them.
const JSX = [
  'icons.jsx', 'components.jsx', 'auth-context.jsx', 'ai-service.jsx', 'tweaks-panel.jsx',
  'dashboard.jsx', 'ai-compose.jsx', 'tasks.jsx', 'deliverables.jsx',
  'kpi.jsx', 'weekly.jsx', 'monthly.jsx', 'people.jsx', 'screens.jsx', 'roles-admin.jsx', 'app.jsx',
];

// React bootstrap (was the inline text/babel block at the end of index.html).
const BOOTSTRAP = `
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<window.AuthProvider><window.App /></window.AuthProvider>);
`;

const JSX_OPTS = {
  loader: 'jsx',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  target: 'es2018',
  minify: true,
  minifyIdentifiers: false, // keep top-level names — shared global scope
};

const JS_OPTS = {
  loader: 'js',
  target: 'es2018',
  minify: true,
  minifyIdentifiers: false,
};

async function transformFile(name, opts) {
  const code = await readFile(join(SRC, name), 'utf8');
  const out = await transform(code, { ...opts, sourcefile: name });
  if (out.warnings.length) {
    for (const w of out.warnings) console.warn(`[${name}] ${w.text}`);
  }
  return `\n/* ${name} */\n${out.code}`;
}

async function build() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const parts = [];
  for (const f of PLAIN_JS) parts.push(await transformFile(f, JS_OPTS));
  for (const f of JSX) parts.push(await transformFile(f, JSX_OPTS));
  parts.push(`\n/* bootstrap */\n` + (await transform(BOOTSTRAP, JSX_OPTS)).code);

  const bundle = parts.join('\n');

  // Guard: the concatenation shares ONE global scope, so a top-level identifier
  // declared in two files is a fatal `Identifier 'x' has already been declared`.
  // Catch it here with a readable message instead of a cryptic runtime blank page.
  assertNoDuplicateTopLevel();

  await writeFile(join(OUT, 'app.bundle.js'), bundle, 'utf8');

  // cache-busting tag from content length + build time
  const v = Date.now().toString(36);

  await writeFile(join(OUT, 'index.html'), indexHtml(v), 'utf8');
  await writeFile(join(OUT, '404.html'), fourOhFourHtml(), 'utf8');
  await copyFile(join(SRC, 'styles.css'), join(OUT, 'styles.css'));
  await copyFile(join(SRC, 'serve.py'), join(OUT, 'serve.py'));

  const kb = (Buffer.byteLength(bundle) / 1024).toFixed(0);
  console.log(`Built ${OUT}/app.bundle.js  (${kb} kB, v=${v})  — ${JSX.length} jsx + ${PLAIN_JS.length} js`);
}

async function assertNoDuplicateTopLevel() {
  const seen = new Map(); // name -> first file
  const dups = [];
  for (const f of [...PLAIN_JS, ...JSX]) {
    const code = await readFile(join(SRC, f), 'utf8');
    const names = new Set();
    for (const m of code.matchAll(/^(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
    // destructured React aliases, e.g. const { useState: useStateD } = React;
    for (const m of code.matchAll(/^const\s*\{([^}]*)\}\s*=\s*React/gm)) {
      for (const pair of m[1].split(',')) {
        const id = pair.split(':').pop().trim();
        if (id) names.add(id);
      }
    }
    for (const n of names) {
      if (seen.has(n)) dups.push(`${n}  (in ${seen.get(n)} and ${f})`);
      else seen.set(n, f);
    }
  }
  if (dups.length) {
    throw new Error('Duplicate top-level identifiers across files (shared scope clash):\n  ' + dups.join('\n  '));
  }
}

// Runs before the app: sets the mount base and restores a clean URL after a
// 404.html redirect (see fourOhFourHtml). Kept inline + tiny so it executes
// before anything paints.
//
// The document.write(<base>) MUST happen before history.replaceState: every
// tag after this script (styles.css, app.bundle.js) has a relative href/src,
// which the browser resolves against the CURRENT document URL at parse time.
// Once replaceState rewrites that URL to a deep link like "/tasks/T-123",
// resolution drops the wrong number of path segments for any route with more
// than one segment ("/tasks/T-123" -> "tasks/app.bundle.js", 404) — single-
// segment routes ("/dashboard") happened to survive by coincidence, masking
// this for a long time. A <base> tag fixes resolution regardless of what the
// URL bar says afterward.
const ROUTER_BOOTSTRAP = `  <script>
    // Mount base: "/<repo>/" on GitHub Pages project sites, "/" otherwise.
    window.__BASE__ = location.hostname.endsWith('github.io')
      ? '/' + location.pathname.split('/')[1] + '/' : '/';
    document.write('<base href="' + window.__BASE__ + '">');
    // 404.html redirects deep links to "<base>?/path"; turn that back into a
    // clean URL before the app boots so routing sees the real path.
    (function (l) {
      if (l.search && l.search.charAt(1) === '/') {
        var decoded = l.search.slice(1).split('&').map(function (s) {
          return s.replace(/~and~/g, '&');
        }).join('?');
        history.replaceState(null, null, l.pathname.replace(/\\/$/, '') + '/' + decoded.replace(/^\\//, '') + l.hash);
      }
    })(window.location);
  </script>`;

function indexHtml(v) {
  return `<!DOCTYPE html>
<html lang="en" data-theme="light" data-density="regular">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>FM Navigate — Execution Hub</title>
${ROUTER_BOOTSTRAP}
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />
  <link rel="preconnect" href="https://unpkg.com" crossorigin />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232563eb'/%3E%3Cg fill='none' stroke='white' stroke-width='2'%3E%3Ccircle cx='16' cy='16' r='9'/%3E%3Ccircle cx='16' cy='16' r='5'/%3E%3C/g%3E%3Ccircle cx='16' cy='16' r='1.8' fill='white'/%3E%3C/svg%3E" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap" />
  <link rel="stylesheet" href="styles.css?v=${v}" />
</head>
<body>
  <div id="root"></div>

  <!-- third-party globals: must load before app.bundle.js (referenced as globals) -->
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>
  <script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js" crossorigin="anonymous"></script>
  <script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js" crossorigin="anonymous"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js"></script>

  <!-- precompiled app: all config + data layer + JSX, one file, no in-browser Babel -->
  <script src="app.bundle.js?v=${v}"></script>
</body>
</html>
`;
}

// GitHub Pages serves this for any path it can't find (deep links / refresh
// on a clean route). It rewrites the path into a "?/"-encoded query and
// redirects to the app root, where ROUTER_BOOTSTRAP restores the real URL.
// pathSegmentsToKeep = 1 keeps the project-page prefix ("/Task-Tracker/").
function fourOhFourHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>FM Navigate</title>
  <script>
    (function (l) {
      var pathSegmentsToKeep = 1;
      l.replace(
        l.protocol + '//' + l.hostname + (l.port ? ':' + l.port : '') +
        l.pathname.split('/').slice(0, 1 + pathSegmentsToKeep).join('/') + '/?/' +
        l.pathname.slice(1).split('/').slice(pathSegmentsToKeep).join('/').replace(/&/g, '~and~') +
        (l.search ? '&' + l.search.slice(1).replace(/&/g, '~and~') : '') +
        l.hash
      );
    })(window.location);
  </script>
</head>
<body></body>
</html>
`;
}

build().catch((e) => { console.error(e); process.exit(1); });
