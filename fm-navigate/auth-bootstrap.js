/* ============================================================
   FM Navigate — auth bootstrap state machine
   ------------------------------------------------------------
   Signing in resolves FOUR things, and they do not arrive together:

     1. the Supabase session      (ds.getUser / onAuth)
     2. the profile row           (ds.getMyProfile)
     3. the security role         (a field of the profile)
     4. the RBAC permission matrix (RBAC.load)

   Before this module the app rendered as soon as (1) landed, with the
   role defaulting to 'viewer' while (2)–(4) were still in flight. So a
   real Owner saw a full Viewer UI for one paint and, on a slow profile
   fetch, long enough to notice — the "Viewer on first login until you
   refresh" defect.

   The rule is now: while ANY stage is pending, the app renders a loading
   state and NOTHING else. There is no provisional role. A user is either
   signed out (login screen), fully resolved (app), or loading.

   Extracted as a pure function on purpose: the race is a logic bug, not a
   rendering bug, so it is unit-tested in Node
   (scripts/verify-auth-bootstrap.mjs) rather than left to a manual retry.
   ============================================================ */
(function () {
  'use strict';

  var PENDING = 'pending';
  var SETTLED = 'settled';

  /* Is the app safe to render?

       shared        false = local-only mode (no backend, no roles) → always ready
       authUser      undefined = session still resolving · null = signed out ·
                     object = signed in
       profileState  'pending' | 'settled'  — settled means the fetch FINISHED,
                     whether or not it found a row (a signed-in user with no
                     profile row is a resolved state, not a pending one)
       rbacState     'pending' | 'settled'  — settled means RBAC.load() resolved,
                     in matrix mode or in documented fallback

     Signed OUT is ready: the login screen needs no profile and no matrix. */
  function computeReady(s) {
    s = s || {};
    if (!s.shared) return true;
    if (s.authUser === undefined) return false;   // session unknown
    if (!s.authUser) return true;                 // signed out → login screen
    return s.profileState === SETTLED && s.rbacState === SETTLED;
  }

  /* What to tell the user while we wait. Purely cosmetic, but it makes a
     slow stage diagnosable instead of an anonymous spinner. */
  function stageLabel(s) {
    s = s || {};
    if (!s.shared || computeReady(s)) return null;
    if (s.authUser === undefined) return 'Signing in…';
    if (s.profileState !== SETTLED) return 'Loading your profile…';
    return 'Loading permissions…';
  }

  /* The effective role. NEVER falls back to 'viewer' (or anything else) for a
     signed-in user whose profile hasn't arrived: an unresolved role is null,
     and null is not renderable — computeReady() is false in that window, so
     the app never asks. A signed-in user whose profile genuinely has no role
     is a real (fail-closed) 'no access' state, not a race. */
  function roleOf(s) {
    s = s || {};
    if (!s.shared) return 'owner';                    // local-only: full access
    if (!s.authUser) return null;                     // signed out
    return (s.profile && s.profile.role) || null;
  }

  window.authBootstrap = {
    PENDING: PENDING,
    SETTLED: SETTLED,
    computeReady: computeReady,
    stageLabel: stageLabel,
    roleOf: roleOf,
  };
})();
