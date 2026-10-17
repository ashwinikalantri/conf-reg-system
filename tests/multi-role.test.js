// More than one role per person.
//
// A staff member keeps one main role (users.role) and may hold additional
// roles (user_roles); what they may do is everything any of their roles
// allows -- on every route, in /api/auth/me, and in the "who could do this"
// lists. What must hold:
//
//   * the union, and only the union: an additional role opens its sections
//     and routes; taking it away closes them again;
//   * staff only: a delegate holds none, Super Admin is never an additional
//     role, and a Super Admin needs none;
//   * changing the main role to Delegate or Super Admin clears them, and the
//     main role is never also an additional one;
//   * a role held only as an additional role still counts as held: on the
//     Roles page, and when deleting a role;
//   * each change is in the activity log.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const N = String(Date.now() % 100000000).padStart(8, '0');
const P = { staff: `71${N}`, delegate: `72${N}` };
const CUSTOM = `TEMPROLE${N.slice(-4)}`;

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const signIn = async (phone) => {
    const r = await call('POST', `/api/users/${phone}/reset-password`, {}, admin);
    const l = await call('POST', '/api/auth/login-password', { identifier: phone, password: r.body.tempPassword });
    await call('POST', '/api/auth/set-password', { password: `own-${N}-pw` }, l.cookie);
    return l.cookie;
  };
  const setExtra = (phone, roles, c = admin) => call('PUT', `/api/users/${phone}/roles`, { roles }, c);
  const me = async (c) => (await call('GET', '/api/auth/me', null, c)).body;

  try {
    await call('POST', '/api/users', { phone: P.staff, name: 'Multi Role', email: `mr-${P.staff}@example.test`, role: 'FRONT_DESK' }, admin);
    await call('POST', '/api/users', { phone: P.delegate, name: 'Plain Delegate', email: `mr-${P.delegate}@example.test`, role: 'DELEGATE' }, admin);
    const staff = await signIn(P.staff);

    console.log('\n== One role: the Front Desk, nothing else ==');
    const before = await me(staff);
    check('main role only', JSON.stringify(before.roles) === '["FRONT_DESK"]', before.roles);
    check('the desk opens, the Guests tab does not', before.sections.desk === true && !before.sections.faculty);
    check('...and the server agrees', (await call('GET', '/api/guests', null, staff)).status === 403);

    console.log('\n== Adding a role ==');
    const add = await setExtra(P.staff, ['TRANSPORT_COORDINATOR']);
    check('an admin gives them Transport Coordinator as well', add.body.success === true && JSON.stringify(add.body.roles) === '["FRONT_DESK","TRANSPORT_COORDINATOR"]', add.body);
    const after = await me(staff);
    check('they now hold both, main role first', JSON.stringify(after.roles) === '["FRONT_DESK","TRANSPORT_COORDINATOR"]', after.roles);
    check('...with both sets of permissions', after.permissions.includes('desk.view') && after.permissions.includes('guests.travel'));
    check('...and both sections', after.sections.desk === true && after.sections.faculty === true);
    check('the Guests tab opens for them, without signing in again', (await call('GET', '/api/guests', null, staff)).status === 200);
    check('the desk still does', (await call('GET', '/api/desk/staff', null, staff)).status === 200);
    check('...but nothing neither role grants', (await call('GET', '/api/registrations', null, staff)).status === 403
      && !after.permissions.includes('guests.stay'));
    const board = (await call('GET', '/api/guests', null, admin)).body;
    check('holding a coordinator role alone does not put them in the volunteer dropdown', !board.coordinators.transport.some((p) => p.phone === P.staff));
    check('the change is in the activity log', (await db.get(
      "SELECT 1 FROM audit_log WHERE action = 'USER_ROLES_CHANGED' AND entity_id = ? AND new_value = 'TRANSPORT_COORDINATOR' AND old_value = 'none'", [P.staff])) !== undefined);

    await setExtra(P.staff, ['TRANSPORT_COORDINATOR', 'VOLUNTEER_TRANSPORT']);
    check('...a Volunteer – Transport role, added, does', (await call('GET', '/api/guests', null, admin)).body.coordinators.transport.some((p) => p.phone === P.staff));
    await setExtra(P.staff, ['TRANSPORT_COORDINATOR']);

    console.log('\n== Where it shows ==');
    const list = (await call('GET', '/api/users', null, admin)).body;
    const row = (list.users || list).find((u) => u.phone_number === P.staff);
    check('the users list carries the additional roles', JSON.stringify(row.extra_roles) === '["TRANSPORT_COORDINATOR"]', row.extra_roles);
    const detail = (await call('GET', `/api/users/${P.staff}/detail`, null, admin)).body;
    check('...and so does their detail', JSON.stringify(detail.extraRoles) === '["TRANSPORT_COORDINATOR"]');
    const roles = (await call('GET', '/api/admin/roles', null, admin)).body.roles || [];
    const tcount = roles.find((r) => r.key === 'TRANSPORT_COORDINATOR');
    check('the Roles page counts them as holding it', tcount && tcount.userCount >= 1, tcount && tcount.userCount);

    console.log('\n== What is refused ==');
    check('a delegate holds no staff roles', (await setExtra(P.delegate, ['TRANSPORT_COORDINATOR'])).status === 400);
    check('Super Admin is never an additional role', (await setExtra(P.staff, ['SUPER_ADMIN'])).status === 400);
    check('...nor Delegate', (await setExtra(P.staff, ['DELEGATE'])).status === 400);
    check('...nor a role that does not exist', (await setExtra(P.staff, ['NO_SUCH_ROLE'])).status === 400);
    check('a Super Admin needs none', (await setExtra('9000000001', ['FRONT_DESK'])).status === 400);
    check('the front desk cannot hand out roles', (await setExtra(P.staff, ['OPERATIONS'], staff)).status === 403);
    check('nothing refused was saved', JSON.stringify((await me(staff)).roles) === '["FRONT_DESK","TRANSPORT_COORDINATOR"]');
    const ops = await loginPassword('9000000004', ADMIN_PW);   // OPERATIONS holds users.assign_role
    check('Operations, who assign roles, can', (await setExtra(P.staff, ['TRANSPORT_COORDINATOR', 'ACCOMMODATION_COORDINATOR'], ops)).body.success === true);
    check('the main role is never also an additional one', JSON.stringify((await setExtra(P.staff, ['FRONT_DESK', 'TRANSPORT_COORDINATOR'])).body.roles) === '["FRONT_DESK","TRANSPORT_COORDINATOR"]');

    console.log('\n== A role held only as an additional role ==');
    await call('POST', '/api/admin/roles', { key: CUSTOM, label: 'Temp Role', permissions: ['reports.summary'] }, admin);
    await setExtra(P.staff, ['TRANSPORT_COORDINATOR', CUSTOM]);
    check('...gives its permissions', (await me(staff)).permissions.includes('reports.summary'));
    const del = await call('DELETE', `/api/admin/roles/${CUSTOM}`, null, admin);
    check('...and cannot be deleted while someone holds it', del.status === 409, [del.status, del.body.error]);

    console.log('\n== Taking roles away ==');
    await setExtra(P.staff, []);
    const none = await me(staff);
    check('with none, they are back to their main role', JSON.stringify(none.roles) === '["FRONT_DESK"]' && !none.sections.faculty);
    check('...and the Guests tab is refused again', (await call('GET', '/api/guests', null, staff)).status === 403);
    check('the custom role can now be deleted', (await call('DELETE', `/api/admin/roles/${CUSTOM}`, null, admin)).body.success === true);
    await setExtra(P.staff, ['TRANSPORT_COORDINATOR', 'ACCOMMODATION_COORDINATOR']);
    await call('PUT', `/api/users/${P.staff}/role`, { role: 'TRANSPORT_COORDINATOR' }, admin);
    check('making an additional role the main one drops the duplicate', JSON.stringify((await me(staff)).roles) === '["TRANSPORT_COORDINATOR","ACCOMMODATION_COORDINATOR"]', (await me(staff)).roles);
    await call('PUT', `/api/users/${P.staff}/role`, { role: 'DELEGATE' }, admin);
    check('turning them into a delegate clears every staff role', JSON.stringify((await me(staff)).roles) === '["DELEGATE"]'
      && (await db.get('SELECT COUNT(*) AS n FROM user_roles WHERE phone_number = ?', [P.staff])).n === 0);
    check('a change of main role is in the activity log', !!(await db.get(
      "SELECT 1 FROM audit_log WHERE action = 'USER_ROLE_CHANGED' AND entity_id = ? AND old_value = 'TRANSPORT_COORDINATOR' AND new_value = 'DELEGATE'", [P.staff])));

    console.log('\n== The detail panel ==');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    const grab = (n) => { const i = js.indexOf(`function ${n}(`); return js.slice(i, js.indexOf('\n}', i) + 2); };
    const sb = { String };
    vm.createContext(sb);
    vm.runInContext(`const ROLE_LABELS = {};
      let userDetailData = { extraRoles: ['TRANSPORT_COORDINATOR'] };
      let cachedRoleOptions = [{ key: 'SUPER_ADMIN', label: 'Super Admin' }, { key: 'FRONT_DESK', label: 'Front Desk' },
        { key: 'TRANSPORT_COORDINATOR', label: 'Transport Coordinator' }, { key: 'OPERATIONS', label: 'Operations' }];
      ${grab('esc')}\n${grab('roleLabel')}\n${grab('userDetailExtraRolesHtml')}
      globalThis.panel = userDetailExtraRolesHtml;`, sb);
    const html = sb.panel({ role: 'FRONT_DESK' }, true);
    check('offers every role but Super Admin and the main one', /value="TRANSPORT_COORDINATOR" checked/.test(html) && /value="OPERATIONS" >/.test(html)
      && !/value="SUPER_ADMIN"/.test(html) && !/value="FRONT_DESK"/.test(html));
    check('nothing for a delegate or a Super Admin', sb.panel({ role: 'DELEGATE' }, true) === '' && sb.panel({ role: 'SUPER_ADMIN' }, true) === '');
    check('read-only for someone who cannot assign roles', /Additional roles: Transport Coordinator/.test(sb.panel({ role: 'FRONT_DESK' }, false)));
    check('the users filter finds additional roles too', /u\.role !== roleFilter && !\(u\.extra_roles \|\| \[\]\)\.includes\(roleFilter\)/.test(js));
  } finally {
    await db.run('DELETE FROM user_roles WHERE phone_number IN (?, ?)', [P.staff, P.delegate]);
    await db.run('DELETE FROM users WHERE phone_number IN (?, ?)', [P.staff, P.delegate]);
    await db.run('DELETE FROM role_permissions WHERE role_key = ?', [CUSTOM]);
    await db.run('DELETE FROM roles WHERE key = ?', [CUSTOM]);
  }
  db.close();
  report();
})();
