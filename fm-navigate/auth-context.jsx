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

function AuthProvider({ children }) {
  const ds = window.dataService;
  const shared = ds && ds.backend === 'supabase';

  // undefined = still checking · null = signed out · object = signed in
  const [authUser, setAuthUser] = useState(shared ? undefined : null);
  // Cached profile { id, email, name, avatar_url, role, status }. Fetched once
  // when the signed-in user id changes — never on every render/refresh.
  const [profile, setProfile] = useState(null);

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

  const signOut = useCallback(() => ds.signOut().then(() => { setAuthUser(null); setProfile(null); }), []);

  const value = useMemo(() => {
    // Local-only mode has no backend/roles → full-access owner. Shared mode:
    // the profile's role; a signed-in user with no profile yet is a viewer.
    const role = !shared ? 'owner' : ((profile && profile.role) || (authUser ? 'viewer' : null));
    const can = (resource, action) => window.RBAC.can(role, resource, action);
    // PHASE 1: one workspace document, so the only DB-enforced write is the
    // `workspace` resource (owner + product_manager). canEdit stays the single
    // gate the mutation callsites read; finer per-resource rules live in can().
    const canEdit = !shared || can('workspace', 'write');
    // Attribution shim: activity/comments still store a USERS key. Map role back
    // to the known accounts until attribution moves to profile ids (Group B).
    const currentUser = (!shared || role === 'product_manager') ? 'vihan'
      : role === 'owner' ? 'richard'
      : role === 'tech_lead' ? 'isuru'
      : canEdit ? 'vihan' : 'richard';
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
      currentUser,
      signOut,
      ready: !shared || authUser !== undefined,
      setAuthUser, // for LoginScreen to push the user immediately on sign-in
    };
  }, [shared, authUser, profile, signOut]);

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
