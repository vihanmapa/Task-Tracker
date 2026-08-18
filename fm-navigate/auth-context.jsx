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
    // Display line under a person's name: their JOB TITLE (organizational,
    // display-only — grants nothing), falling back to the role label.
    role: profile.job_title || (window.RBAC.ROLE_LABELS && window.RBAC.ROLE_LABELS[profile.role]) || 'Member',
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
  // BOOTSTRAP STAGES (see auth-bootstrap.js). 'pending' until the fetch has
  // FINISHED — not until it succeeded: a signed-in user with no profile row is
  // a resolved state, and rendering must not wait forever on it. While either
  // is pending the app shows a loading state and no role is derived at all,
  // which is what removes the "Viewer until you refresh" race.
  const [profileState, setProfileState] = useState(window.authBootstrap.PENDING);
  const [rbacState, setRbacState] = useState(window.authBootstrap.PENDING);
  // The signed-in user's organization — every task carries it, so the client
  // needs it to create one. null until resolved (or when there is no backend).
  const [organizationId, setOrganizationId] = useState(null);
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
    if (!authUser) {
      // Signed out: nothing to resolve, and the previous account's profile
      // must not linger into the next one.
      setProfile(null); setOrganizationId(null);
      setProfileState(window.authBootstrap.SETTLED);
      return;
    }
    let alive = true;
    setProfile(null);
    setProfileState(window.authBootstrap.PENDING);
    Promise.all([ds.getMyProfile(), ds.myOrganizationId ? ds.myOrganizationId() : Promise.resolve(null)])
      .then(([p, org]) => {
        if (!alive) return;
        setProfile(p);
        setOrganizationId(org);
        setProfileState(window.authBootstrap.SETTLED);
      })
      .catch(() => { if (alive) setProfileState(window.authBootstrap.SETTLED); });
    return () => { alive = false; };
  }, [shared, authUser && authUser.id]);

  // Register the signed-in profile in window.USERS so avatars/attribution
  // resolve to the real person. Done as a side effect (not in render) and
  // re-run whenever the identity-bearing fields change.
  useEffect(() => {
    if (!shared || !profile) return;
    registerIdentity(profile);
  }, [shared, profile && profile.id, profile && profile.name,
      profile && profile.avatar_url, profile && profile.role,
      profile && profile.job_title]);

  // Load the table-driven permission matrix (Phase 2) once per sign-in, and
  // refetch on live grant changes so an owner's toggle reaches this user
  // within seconds — no re-login. RBAC.load() falls back to the hardcoded
  // Phase-1 DEFAULTS when the tables aren't available, so this is safe in
  // every deploy order; rbacVersion re-renders the tree either way so every
  // canEdit/canExecute consumer picks up the new answers.
  const [rbacVersion, setRbacVersion] = useState(0);
  useEffect(() => {
    if (!shared) return;
    // Signed out (or between accounts): drop any in-memory matrix so the next
    // account can't inherit it, then stop — can() falls back to DEFAULTS.
    if (!authUser) {
      window.RBAC.reset();
      setRbacVersion(v => v + 1);
      setRbacState(window.authBootstrap.SETTLED);
      return;
    }
    let alive = true;
    setRbacState(window.authBootstrap.PENDING);
    // New identity: clear the previous account's matrix before the first fetch
    // so nothing stale is served while this account's grants are in flight.
    window.RBAC.reset();
    const uid = authUser.id;
    const refresh = () => window.RBAC.load(ds, uid).then(() => {
      if (!alive) return;
      setRbacVersion(v => v + 1);
      // Settled whether we entered matrix mode or fell back to DEFAULTS —
      // both are resolved answers, and load() never rejects.
      setRbacState(window.authBootstrap.SETTLED);
    });
    refresh();
    const off = ds.subscribeRolePermissions ? ds.subscribeRolePermissions(refresh) : null;
    return () => { alive = false; off && off(); };
  }, [shared, authUser && authUser.id]);

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

  const signOut = useCallback(() => ds.signOut().then(() => {
    window.RBAC.reset();
    setAuthUser(null); setProfile(null); setOrganizationId(null);
    setProfileState(window.authBootstrap.SETTLED);
    setRbacState(window.authBootstrap.SETTLED);
  }), []);

  const value = useMemo(() => {
    const bootstrap = { shared, authUser, profile, profileState, rbacState };
    // Ready = session AND profile AND permission matrix all resolved. Until
    // then App renders a loading state; there is NO provisional role, so a
    // real Owner can never be shown a Viewer UI for a frame (or a second).
    const ready = window.authBootstrap.computeReady(bootstrap);
    // Local-only mode has no backend/roles → full-access owner. Shared mode:
    // strictly the profile's role, or null while unresolved / signed out.
    const role = window.authBootstrap.roleOf(bootstrap);
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
    // Phase 3 capabilities. canViewAll is MANAGEMENT SCOPE — the single switch
    // between "my personal workspace" and "the organization's work". It is a
    // permission, so an owner can grant it to another role from Settings →
    // Roles & Permissions without a deployment; it is never inferred from a
    // job title or a role name anywhere in this codebase.
    const canViewAll = !shared || can('tasks', 'view_all');
    const canCreateTask = !shared || can('tasks', 'create');
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
    // The context window.taskScope evaluates against — a mirror of the SQL
    // predicates, built once here so every consumer asks the same question.
    const scopeCtx = {
      userId: currentUser,
      organizationId,
      canRead: !shared || can('tasks', 'read'),
      canExecute,
      canCreate: canCreateTask,
      canViewAll,
      canAssign,
      canPrioritize,
      canDelete: canDeleteTask,
      canGovern: canEdit,
    };
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
      canViewAll,
      canCreateTask,
      organizationId,
      scopeCtx,
      currentUser,
      signOut,
      ready,
      bootstrapStage: window.authBootstrap.stageLabel(bootstrap),
      // Consumers don't read this directly — it's in the memo deps so the tree
      // re-renders (and pickers re-enumerate window.USERS) once the team loads.
      peopleVersion,
      setAuthUser, // for LoginScreen to push the user immediately on sign-in
    };
  }, [shared, authUser, profile, profileState, rbacState, organizationId, signOut, peopleVersion, rbacVersion]);

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
