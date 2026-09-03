// Roles are rows now, not constants.
//
// What a role may DO is still the catalogue (permissions.js): the keys are
// code because each has to match a guard the server applies. WHICH of them a
// role holds is data, because that is the part worth editing without a
// deploy. This test covers the move: that the seed reproduces the catalogue
// exactly, that the running server answers from the tables rather than the
// constants, and that an edit is not quietly undone by the next restart --
// which is the failure nobody notices until a role has been wrong for a week.
const { call, check, report, loginPassword, ADMIN_PW, openDb, appFile } = require('./harness');
const fs = require('fs');
const perms = require('../permissions');

const FINANCE = '9000000002';

(async () => {
  const db = openDb();
  const src = fs.readFileSync(appFile('server.js'), 'utf8');

  console.log('\n== The tables exist and hold the catalogue ==');
  const roles = await db.all('SELECT key, is_system, grants_all FROM roles ORDER BY key');
  check('all five built-in roles are seeded', roles.length === perms.SYSTEM_ROLES.length,
    roles.map((r) => r.key));
  check('every one is marked as a system role', roles.every((r) => r.is_system === 1), roles);

  for (const role of perms.SYSTEM_ROLES) {
    const stored = await db.all('SELECT permission FROM role_permissions WHERE role_key = ? ORDER BY permission', [role.key]);
    const got = stored.map((r) => r.permission);
    if (role.all) {
      // Super Admin holds everything by a flag, not by 43 rows -- so a
      // permission added next year is covered without a migration.
      check('Super Admin stores no permission rows', got.length === 0, got.length);
      const row = roles.find((r) => r.key === role.key);
      check('...and carries grants_all instead', row && row.grants_all === 1, row);
    } else {
      const want = role.permissions.slice().sort();
      check(`${role.key} holds exactly its catalogued set`,
        got.length === want.length && got.every((p, i) => p === want[i]),
        { missing: want.filter((p) => !got.includes(p)), extra: got.filter((p) => !want.includes(p)) });
    }
  }

  console.log('\n== Every stored permission is a real one ==');
  const all = await db.all('SELECT DISTINCT permission FROM role_permissions');
  const unknown = all.map((r) => r.permission).filter((p) => !perms.PERMISSION_KEYS.includes(p));
  check('no row names a permission the catalogue does not define', unknown.length === 0, unknown);
  const orphanRoles = await db.all(
    'SELECT DISTINCT role_key FROM role_permissions WHERE role_key NOT IN (SELECT key FROM roles)');
  check('no row names a role that does not exist', orphanRoles.length === 0, orphanRoles);

  console.log('\n== The server answers from the tables, not the constants ==');
  // The proof: change a role in the DATABASE only -- the catalogue in code
  // still says Finance may view payments -- and the running server must
  // change its answer once it reloads. If it kept answering from
  // permissions.js, this phase would have achieved nothing.
  const cookie = await loginPassword(FINANCE, ADMIN_PW);
  const superCookie = await loginPassword('9000000001', ADMIN_PW);
  check('Finance signs in', !!cookie);
  check('Super Admin signs in', !!superCookie);
  const before = await call('GET', '/api/registrations', null, cookie);
  check('Finance may read payments to begin with', before.status !== 403, before.status);
  check('the code catalogue agrees', perms.roleCan('FINANCE_ADMIN', 'payments.view'));

  // This file is the only one that edits the shared fixture's roles, and the
  // whole suite runs against one server. Restoring in a finally, rather than
  // on the happy path, is what keeps a failure here from becoming a failure
  // in whatever runs next.
  try {
    await db.run("DELETE FROM role_permissions WHERE role_key = 'FINANCE_ADMIN' AND permission = 'payments.view'");
    const reload = await call('POST', '/api/admin/roles/reload', null, superCookie);
    check('the server can be told to re-read roles', reload.status === 200, reload.status);

    const after = await call('GET', '/api/registrations', null, cookie);
    check('the database decides, and Finance is now refused', after.status === 403, after.status);
    check('...even though the code catalogue still grants it',
      perms.roleCan('FINANCE_ADMIN', 'payments.view'));
  } finally {
    await db.run("INSERT OR IGNORE INTO role_permissions (role_key, permission) VALUES ('FINANCE_ADMIN', 'payments.view')");
    await call('POST', '/api/admin/roles/reload', null, superCookie);
  }
  const restored = await call('GET', '/api/registrations', null, cookie);
  check('granting it back restores access', restored.status !== 403, restored.status);

  console.log('\n== Super Admin cannot be locked out ==');
  // It holds everything by flag, so no row can be deleted to reduce it.
  const superRows = await db.all("SELECT permission FROM role_permissions WHERE role_key = 'SUPER_ADMIN'");
  check('there are no rows to delete', superRows.length === 0, superRows.length);
  const superSees = await call('GET', '/api/admin/general-settings', null, superCookie);
  check('and it still reaches everything', superSees.status !== 403, superSees.status);

  console.log('\n== The seed does not overwrite an edit ==');
  check('a role is only inserted when absent',
    /const existing = await dbGet\('SELECT key FROM roles WHERE key = \?'/.test(src)
    && /if \(existing\) continue;/.test(src));

  console.log('\n== A broken load falls back rather than locking everyone out ==');
  // An empty cache means the load failed or the tables are missing. Denying
  // everything then would take the admin panel down over a migration hiccup,
  // so it answers from the catalogue the app shipped with and says so loudly.
  // A role MISSING from a cache that did load is a different thing -- someone
  // deleted it -- and is denied.
  check('an empty cache falls back to the catalogue',
    /if \(!roleCache \|\| roleCache\.size === 0\)/.test(src) && /return roleCan\(roleKey, permission\)/.test(src));
  check('and says so in the log', /No roles loaded from the database/.test(src));
  check('a role absent from a loaded cache is denied', /if \(!role\) return false;/.test(src));

  console.log('\n== Ready for the multi-event work, not blocked by it ==');
  const cols = await db.all('PRAGMA table_info(roles)');
  check('roles carry a nullable event_id', cols.some((c) => c.name === 'event_id' && c.notnull === 0),
    cols.map((c) => c.name));
  const scoped = await db.get('SELECT COUNT(*) AS n FROM roles WHERE event_id IS NOT NULL');
  check('and nothing uses it yet', scoped.n === 0, scoped.n);

  db.close();
  report();
})();
