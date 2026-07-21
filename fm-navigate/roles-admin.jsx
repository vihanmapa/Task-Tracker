/* ============================================================
   FM Navigate — Settings → Roles & Permissions (admin matrix)
   ------------------------------------------------------------
   Jira-style per-role permission editor (TDD §7.4). Owner-gated by
   can('admin','permissions'); everyone else (and local mode, and a
   deployment where the Phase-2 SQL hasn't run yet) sees nothing.

   Pick a role → grouped checkboxes for the whole catalog. Each toggle
   is ONE insert/delete on role_permissions (optimistic, revert on
   error). The DATABASE is the boundary: RLS restricts writes to
   admin.permissions holders, the owner role is immutable by trigger,
   and every change lands in the append-only activity log as
   permission_granted / permission_revoked.
   ============================================================ */
const { useState: useStateRA, useEffect: useEffectRA, useMemo: useMemoRA } = React;

function RolesPermissionsManager() {
  const I = window.I;
  const ds = window.dataService;
  const { shared, can } = useAuth();
  const canAdmin = shared && can('admin', 'permissions');

  const [roles, setRoles] = useStateRA(null);       // [{slug,label,...}]
  const [catalog, setCatalog] = useStateRA(null);   // [{key,grp,label,...}]
  const [grants, setGrants] = useStateRA(null);     // Set("role|key")
  const [selected, setSelected] = useStateRA('business_analyst');
  const [collapsed, setCollapsed] = useStateRA({});
  const [busy, setBusy] = useStateRA(false);
  const [err, setErr] = useStateRA('');
  const [unavailable, setUnavailable] = useStateRA(false);
  const [confirmReset, setConfirmReset] = useStateRA(false);

  const grantKey = (role, key) => role + '|' + key;

  const refetchGrants = () =>
    ds.listRolePermissions().then(rows => {
      setGrants(new Set(rows.map(r => grantKey(r.role_slug, r.permission_key))));
    }).catch(() => {});

  useEffectRA(() => {
    if (!canAdmin) return;
    let alive = true;
    Promise.all([ds.listRoles(), ds.listPermissionCatalog(), ds.listRolePermissions()])
      .then(([rs, cat, rp]) => {
        if (!alive) return;
        setRoles(rs);
        setCatalog(cat);
        setGrants(new Set(rp.map(r => grantKey(r.role_slug, r.permission_key))));
      })
      .catch(() => { if (alive) setUnavailable(true); });
    // Another admin may be editing concurrently — converge via realtime.
    const off = ds.subscribeRolePermissions ? ds.subscribeRolePermissions(refetchGrants) : null;
    return () => { alive = false; off && off(); };
  }, [canAdmin]);

  const groups = useMemoRA(() => {
    if (!catalog) return [];
    const by = new Map();
    catalog.forEach(p => {
      if (!by.has(p.grp)) by.set(p.grp, []);
      by.get(p.grp).push(p);
    });
    return [...by.entries()];
  }, [catalog]);

  if (!canAdmin || unavailable) return null;

  const ownerLocked = selected === 'owner';

  // A permission is editable only if it has a real end-to-end effect today
  // (permissions.enforced, set canonically in schema.sql). Planned keys stay
  // visible for transparency but their checkboxes are disabled — toggling them
  // would change nothing, so the UI must never pretend otherwise.
  const isEnforced = (p) => p.enforced === true;

  const toggle = (permKey, granted, enforced) => {
    if (ownerLocked || busy || !enforced) return;
    setErr('');
    const gk = grantKey(selected, permKey);
    const prev = grants;
    const next = new Set(prev);
    granted ? next.delete(gk) : next.add(gk);
    setGrants(next); // optimistic
    setBusy(true);
    const op = granted ? ds.revokePermission(selected, permKey) : ds.grantPermission(selected, permKey);
    op.then(res => {
      setBusy(false);
      if (!res.ok) { setGrants(prev); setErr(res.error || 'Change rejected.'); }
    });
  };

  const doReset = () => {
    setConfirmReset(false);
    setErr('');
    setBusy(true);
    ds.resetRoleToTemplate(selected).then(res => {
      setBusy(false);
      if (!res.ok) setErr(res.error || 'Reset failed.');
      else refetchGrants();
    });
  };

  const loading = !roles || !catalog || !grants;

  return (
    <div className="card card-pad mb16">
      <div className="row between center mb12" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="section-eyebrow" style={{ margin: 0 }}>Roles & permissions</div>
        {!loading && (
          <div className="row gap8 center">
            <select className="input" style={{ width: 'auto', fontSize: 12.5, padding: '5px 8px' }}
              value={selected} onChange={e => { setSelected(e.target.value); setErr(''); setConfirmReset(false); }}>
              {roles.map(r => <option key={r.slug} value={r.slug}>{r.label}</option>)}
            </select>
            {!ownerLocked && !confirmReset && (
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirmReset(true)}
                title="Replace this role's permissions with its template's factory settings">
                <I.refresh size={13} /> Reset to template
              </button>
            )}
            {confirmReset && (
              <span className="row gap8 center">
                <span className="muted" style={{ fontSize: 12 }}>Replace all custom grants?</span>
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={doReset}>Reset</button>
                <button className="btn btn-subtle btn-sm" onClick={() => setConfirmReset(false)}>Cancel</button>
              </span>
            )}
          </div>
        )}
      </div>

      {loading && <div className="muted" style={{ fontSize: 13, padding: '8px 0' }}>Loading permission matrix…</div>}

      {!loading && ownerLocked && (
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
          The Owner role always holds every permission — it can't be edited, so an owner can never lock the workspace out of administration.
        </div>
      )}

      {!loading && groups.map(([grp, perms]) => {
        const editable = perms.filter(isEnforced);
        const granted = editable.filter(p => grants.has(grantKey(selected, p.key))).length;
        const isCollapsed = collapsed[grp];
        return (
          <div key={grp} style={{ borderBottom: '1px solid var(--border)' }}>
            <button className="row between center" style={{ width: '100%', padding: '10px 0', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)' }}
              onClick={() => setCollapsed({ ...collapsed, [grp]: !isCollapsed })}>
              <span className="row gap8 center" style={{ fontWeight: 600, fontSize: 13 }}>
                <I.chevR size={14} style={{ transform: isCollapsed ? 'none' : 'rotate(90deg)', transition: 'transform 0.12s' }} />
                {grp}
              </span>
              <span className="muted" style={{ fontSize: 12 }}>{granted} of {editable.length}</span>
            </button>
            {!isCollapsed && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '2px 16px', paddingBottom: 10 }}>
                {perms.map(p => {
                  const on = grants.has(grantKey(selected, p.key));
                  const enforced = isEnforced(p);
                  const disabled = ownerLocked || busy || !enforced;
                  return (
                    <label key={p.key} className="row gap8 center"
                      title={enforced ? p.key : p.key + ' — planned; not enforced yet, so this switch has no effect'}
                      style={{ fontSize: 13, padding: '4px 0', cursor: disabled ? 'default' : 'pointer', opacity: enforced ? (ownerLocked && !on ? 0.5 : 1) : 0.55 }}>
                      <input type="checkbox" checked={on} disabled={disabled}
                        onChange={() => toggle(p.key, on, enforced)} />
                      <span style={{ minWidth: 0 }}>{p.label}</span>
                      {!enforced && (
                        <span className="chip" style={{ fontSize: 9.5, padding: '0 5px', flexShrink: 0, opacity: 0.8 }}
                          title="In the catalog as a future target; nothing enforces it yet">Planned</span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {err && <div style={{ color: 'var(--st-blocked)', fontSize: 12.5, marginTop: 10 }}>{err}</div>}
      {!loading && (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.5 }}>
          Editable permissions take effect on the next request and reach signed-in users live — no re-login — and every
          grant or revoke is recorded in the audit log. Permissions marked <b>Planned</b> are shown for transparency but
          are not wired to any control or rule yet, so their switches are disabled and toggling them would change nothing.
        </div>
      )}
    </div>
  );
}

window.RolesPermissionsManager = RolesPermissionsManager;
