/* ============================================================
   FM Navigate — Auth + RBAC context
   ------------------------------------------------------------
   The ONE place the client knows about identity and permissions.
   Owns the Supabase session, caches the user's profile (fetched once
   per sign-in, not per render), derives the role, and exposes can().

   Components call `const { can, canEdit } = useAuth()` — they never
   touch RBAC, the profile shape, or the data layer directly. That
   indirection means permissions can later come from the backend
   instead of permissions.js with NO change to any consumer.

   SECURITY: can()/canEdit only shape the UI (show/hide/disable). They
   are NOT authorization. Every write still passes through RLS, which
   is the real boundary. The client must never treat can() as proof an
   operation is allowed — only as a hint about what to render.
   ============================================================ */
const { createContext, useContext } = React;

const AuthContext = createContext(null);

/* ---------- identity helpers (profile → USERS entry) ----------
   Attribution is keyed off the REAL signed-in person, not their role. We
   register the profile into window.USERS under a stable key so every place
   that renders a USERS key (avatars, activity, comments) resolves to the
   actual user. profile.id is preferred; email is a temporary fallback for a
   profile that somehow lacks an id. */
function identityKey(profile) {
  if (!profile) return null;
  if (profile.id) return profile.id;
  if (profile.email) return 'email:' + String(profile.email).toLowerCase();
  return null;
}

function identityInitials(name, email) {
  const src = String(name || email || '').trim();
  if (!src) return '?';
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

// Deterministic hue from the key so a user keeps the same avatar colour.
function identityColor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return `oklch(0.55 0.15 ${h})`;
}

// Register (or refresh) the signed-in profile in the shared USERS map. Safe to
// call repeatedly; it just overwrites the same key with the latest profile.
function registerIdentity(profile) {
  const key = identityKey(profile);
  if (!key) return null;
  window.USERS[key] = {
    id: key,
    name: profile.name || profile.email || 'You',
    role: (window.RBAC.ROLE_LABELS && window.RBAC.ROLE_LABELS[profile.role]) || 'Member',
    color: identityColor(key),
    initials: identityInitials(profile.name, profile.email),
    avatar_url: profile.avatar_url || null,
    // Marks entries backed by a real Supabase profile (vs the legacy seed
    // trio) so pickers can offer the whole team; status lets them hide
    // disabled accounts while attribution on old records keeps resolving.
    profile: true,
    status: profile.status || 'enabled',
  };
  return key;
}

function AuthProvider({ children }) {
  const ds = window.dataService;
  const shared = ds && ds.backend === 'supabase';

  // undefined = still checking · null = signed out · object = signed in
  const [authUser, setAuthUser] = useState(shared ? undefined : null);
  // Cached profile { id, email, name, avatar_url, role, status }. Fetched once
  // when the signed-in user id changes — never on every render/refresh.
  const [profile, setProfile] = useState(null);
  // Bumped when the team directory lands in window.USERS so pickers re-render.
  const [peopleVersion, setPeopleVersion] = useState(0);

  // Resolve the Supabase session, then keep it in sync.
  useEffect(() => {
    if (!shared) return;
    let alive = true;
    // If the backend is unreachable (e.g. 522), getUser() can hang; force the
    // login screen after a few seconds so the app stays usable.
    const timer = setTimeout(() => { if (alive) setAuthUser(u => (u === undefined ? null : u)); }, 8000);
    ds.getUser().then(u => { if (alive) { clearTimeout(timer); setAuthUser(u || null); } });
    const off = ds.onAuth(u => { if (alive) { clearTimeout(timer); setAuthUser(u || null); } });
    return () => { alive = false; clearTimeout(timer); off && off(); };
  }, []);

  // Load the profile (name/avatar + role) once per signed-in identity.
  useEffect(() => {
    if (!shared) return;
    if (!authUser) { setProfile(null); return; }
    let alive = true;
    ds.getMyProfile().then(p => { if (alive) setProfile(p); });
    return () => { alive = false; };
  }, [shared, authUser && authUser.id]);

  // Register the signed-in profile in window.USERS so avatars/attribution
  // resolve to the real person. Done as a side effect (not in render) and
  // re-run whenever the identity-bearing fields change.
  useEffect(() => {
    if (!shared || !profile) return;
    registerIdentity(profile);
  }, [shared, profile && profile.id, profile && profile.name,
      profile && profile.avatar_url, profile && profile.role]);

  // Register EVERY team profile (RLS lets any signed-in user read the
  // directory) so owner pickers can assign anyone — not just the legacy seed
  // trio plus whoever is signed in — and attribution by teammates resolves
  // to real names instead of the avatarFallback placeholder.
  useEffect(() => {
    if (!shared || !authUser) return;
    let alive = true;
    ds.listProfiles().then(list => {
      if (!alive || !Array.isArray(list) || !list.length) return;
      list.forEach(registerIdentity);
      setPeopleVersion(v => v + 1);
    });
    return () => { alive = false; };
  }, [shared, authUser && authUser.id]);

  const signOut = useCallback(() => ds.signOut().then(() => { setAuthUser(null); setProfile(null); }), []);

  const value = useMemo(() => {
    // Local-only mode has no backend/roles → full-access owner. Shared mode:
    // the profile's role; a signed-in user with no profile yet is a viewer.
    const role = !shared ? 'owner' : ((profile && profile.role) || (authUser ? 'viewer' : null));
    const can = (resource, action) => window.RBAC.can(role, resource, action);
    // GOVERNANCE gate: full workspace control (deliverables, weeks, KPI,
    // import/clear/migrate, unrestricted task edits). Owner + PM.
    const canEdit = !shared || can('workspace', 'write');
    // EXECUTION gates (Jira-style): every delivery role can work tasks;
    // owner/priority changes and deletes stay with lead/governance roles.
    // The DB still enforces only the coarse blob write (see schema.sql) —
    // these flags shape the UI and are re-checked at the app.jsx handlers.
    const canExecute = !shared || can('tasks', 'write');
    const canAssign = !shared || can('tasks', 'assign');
    const canPrioritize = !shared || can('tasks', 'prioritize');
    const canDeleteTask = !shared || can('tasks', 'delete');
    // Attribution is the REAL signed-in person: a stable profile key registered
    // in window.USERS (see registerIdentity). The role→person map below is kept
    // ONLY as a compatibility fallback — for local-only mode and for the brief
    // window after sign-in before the profile has loaded. Historical activity
    // records that still carry legacy ids (richard/vihan/isuru) keep resolving
    // because those entries remain in USERS.
    const legacyUser = (!shared || role === 'product_manager') ? 'vihan'
      : role === 'owner' ? 'richard'
      : role === 'tech_lead' ? 'isuru'
      : canEdit ? 'vihan' : 'richard';
    const currentUser = (shared && profile && identityKey(profile)) || legacyUser;
    return {
      shared,
      authUser,
      profile,
      role,
      roleLabel: (window.RBAC.ROLE_LABELS && window.RBAC.ROLE_LABELS[role]) || 'No access',
      // The full role catalogue, for UI that assigns roles (Users page). Exposed
      // here so consumers never import RBAC directly.
      roles: window.RBAC.ROLES,
      roleLabelOf: function (r) { return (window.RBAC.ROLE_LABELS && window.RBAC.ROLE_LABELS[r]) || r; },
      can,
      canEdit,
      canExecute,
      canAssign,
      canPrioritize,
      canDeleteTask,
      currentUser,
      signOut,
      ready: !shared || authUser !== undefined,
      // Consumers don't read this directly — it's in the memo deps so the tree
      // re-renders (and pickers re-enumerate window.USERS) once the team loads.
      peopleVersion,
      setAuthUser, // for LoginScreen to push the user immediately on sign-in
    };
  }, [shared, authUser, profile, signOut, peopleVersion]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// The single accessor. Throws if used outside the provider so misuse is loud.
function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

window.AuthProvider = AuthProvider;
window.useAuth = useAuth;
