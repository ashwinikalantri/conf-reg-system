// Phase 4: the role editor -- create, duplicate (client-side, reuses
// create), edit and delete a role, plus the guardrails the plan named up
// front: Super Admin uneditable, a role in use can't be deleted, and an
// admin can't remove their own ability to manage roles.
//
// Building this surfaced a real gap, fixed alongside it: POST /api/users,
// PUT /api/users/:phone/role and the /admin page's own gate all validated
// against the five built-in role names directly (ADMIN_ROLES), which meant
// a role created here could never actually be assigned to anyone, and if it
// somehow were, that person would be refused the admin page entirely. This
// file exercises that path end to end -- create a role, assign it to a real
// account, sign in as that account, use it -- not just the CRUD endpoints in
// isolation.
const { call, check, report, adminLogin, loginPassword, openDb, appFile } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-6);
const TEST_ROLE = `ZTESTROLE${N}`;
const TEST_PHONE = `9599${N}`;  // 4 + 6 digits = 10, a valid Indian mobile shape
const TEST_PASSWORD = 'role-editor-test-pw';

(async () => {
  const superCookie = await adminLogin();
  const db = openDb();

  console.log('\n== Reachability: the light list vs the full editor ==');
  const financeCookie = await loginPassword('9000000002', 'harness-admin-pw');
  const opsCookie = await loginPassword('9000000004', 'harness-admin-pw');
  const reviewerCookie = await loginPassword('9000000003', 'harness-admin-pw');

  const optsAsOps = await call('GET', '/api/admin/roles/options', null, opsCookie);
  check('Operations (holds users.assign_role) reaches the light list', optsAsOps.status === 200, optsAsOps.status);
  const optsAsReviewer = await call('GET', '/api/admin/roles/options', null, reviewerCookie);
  check('Academic Reviewer (does not) is refused', optsAsReviewer.status === 403, optsAsReviewer.status);

  const fullAsOps = await call('GET', '/api/admin/roles', null, opsCookie);
  check('Operations does NOT reach the full editor (no users.manage_roles)', fullAsOps.status === 403, fullAsOps.status);
  const fullAsSuper = await call('GET', '/api/admin/roles', null, superCookie);
  check('Super Admin reaches the full editor', fullAsSuper.status === 200, fullAsSuper.status);
  check('...carrying the catalogue', Array.isArray(fullAsSuper.body.catalogue && fullAsSuper.body.catalogue.permissions)
    && fullAsSuper.body.catalogue.permissions.length > 0);
  check('...and every seeded role, each with a user count',
    fullAsSuper.body.roles.every((r) => typeof r.userCount === 'number'), fullAsSuper.body.roles.map((r) => r.userCount));

  console.log('\n== Validation on create ==');
  const badKeys = [
    ['DELEGATE', 'reserved'],
    ['AB', 'too short'],
    ['HAS SPACE', 'contains a space'],
    ['1STARTSWITHDIGIT', 'starts with a digit'],
  ];
  for (const [key, why] of badKeys) {
    const r = await call('POST', '/api/admin/roles', { key, label: 'Test', permissions: [] }, superCookie);
    check(`create refuses "${key}" (${why})`, r.status === 400, r.body);
  }
  // Lowercase is not invalid, it's normalised -- the key is upper-cased
  // before validation, the same case-insensitive-in/canonical-out shape the
  // conference registration prefix already uses elsewhere in this app.
  const lowerKey = `zlower${N}`;
  const lowerCreate = await call('POST', '/api/admin/roles', { key: lowerKey, label: 'Lowercase test', permissions: [] }, superCookie);
  check('a lowercase key is accepted', lowerCreate.body.success === true, lowerCreate.body);
  const lowerStored = await db.get('SELECT key FROM roles WHERE key = ?', [lowerKey.toUpperCase()]);
  check('...stored upper-cased', !!lowerStored, lowerStored);
  await call('DELETE', `/api/admin/roles/${lowerKey.toUpperCase()}`, null, superCookie);
  const dupe = await call('POST', '/api/admin/roles', { key: 'FINANCE_ADMIN', label: 'Dupe', permissions: [] }, superCookie);
  check('create refuses an existing key', dupe.status === 409, dupe.body);
  const noLabel = await call('POST', '/api/admin/roles', { key: `${TEST_ROLE}X`, label: '', permissions: [] }, superCookie);
  check('create refuses an empty label', noLabel.status === 400, noLabel.body);
  const badPerm = await call('POST', '/api/admin/roles', { key: `${TEST_ROLE}Y`, label: 'Test', permissions: ['not.a.real.permission'] }, superCookie);
  check('create refuses an unknown permission', badPerm.status === 400, badPerm.body);

  console.log('\n== Creating a real role, with real permissions ==');
  const created = await call('POST', '/api/admin/roles',
    { key: TEST_ROLE, label: 'Role Manager (test)', description: 'A throwaway role for the test suite.',
      permissions: ['users.manage_roles', 'users.view', 'users.assign_role'] }, superCookie);
  check('the role is created', created.body.success === true, created.body);
  const stored = await db.get('SELECT key, label, is_system, grants_all FROM roles WHERE key = ?', [TEST_ROLE]);
  check('it lands in the database', !!stored, stored);
  check('as a non-system role', stored && stored.is_system === 0 && stored.grants_all === 0, stored);
  const storedPerms = (await db.all('SELECT permission FROM role_permissions WHERE role_key = ?', [TEST_ROLE])).map((r) => r.permission).sort();
  check('with exactly the permissions submitted',
    JSON.stringify(storedPerms) === JSON.stringify(['users.assign_role', 'users.manage_roles', 'users.view'].sort()), storedPerms);

  const auditRow = await db.get(
    "SELECT action FROM audit_log WHERE entity_type='role' AND entity_id=? AND action='ROLE_CREATED' ORDER BY id DESC LIMIT 1", [TEST_ROLE]);
  check('the creation is audited', !!auditRow, auditRow);

  console.log('\n== The fix: a custom role can actually be assigned and used ==');
  const newUser = await call('POST', '/api/users',
    { name: 'Role Editor Test User', phone: TEST_PHONE, email: `role-editor-test-${N}@example.test`,
      designation: 'Test', institute: 'Test', role: TEST_ROLE, password: TEST_PASSWORD }, superCookie);
  check('a user can be created holding the new role directly',
    newUser.body.success === true, newUser.body.error);
  const roleRow = await db.get('SELECT role FROM users WHERE phone_number = ?', [TEST_PHONE]);
  check('the account really holds it', roleRow && roleRow.role === TEST_ROLE, roleRow);

  const testUserCookie = await loginPassword(TEST_PHONE, TEST_PASSWORD);
  check('that account can sign in', !!testUserCookie);
  const adminPage = await call('GET', '/admin', null, testUserCookie);
  check('...and the /admin page accepts a custom role (this used to 403)',
    adminPage.status === 200, adminPage.status);
  const meAsCustom = await call('GET', '/api/auth/me', null, testUserCookie);
  check('...with the right permissions attached',
    (meAsCustom.body.permissions || []).includes('users.manage_roles'), meAsCustom.body.permissions);

  console.log('\n== Assigning a custom role through PUT .../role also works ==');
  const other = await db.get("SELECT phone_number, role FROM users WHERE role='DELEGATE' AND password_hash IS NOT NULL LIMIT 1");
  if (other) {
    const assign = await call('PUT', `/api/users/${encodeURIComponent(other.phone_number)}/role`, { role: TEST_ROLE }, superCookie);
    check('assigning a custom role via the role endpoint succeeds (used to be "Invalid role")',
      assign.body.success === true, assign.body.error);
    // Put it back -- this is a shared-fixture account.
    await call('PUT', `/api/users/${encodeURIComponent(other.phone_number)}/role`, { role: 'DELEGATE' }, superCookie);
    const restored = await db.get('SELECT role FROM users WHERE phone_number = ?', [other.phone_number]);
    check('restored to DELEGATE afterward', restored && restored.role === 'DELEGATE', restored);
  } else {
    check('(no delegate-with-password in the fixture to borrow)', true);
  }

  console.log('\n== The self-lockout guard ==');
  // The custom-role user tries to remove their OWN role's users.manage_roles.
  const selfLockout = await call('PUT', `/api/admin/roles/${TEST_ROLE}`,
    { label: 'Role Manager (test)', permissions: ['users.view', 'users.assign_role'] }, testUserCookie);
  check('refused', selfLockout.status === 409, selfLockout.body);
  check('with an explanatory message', /cannot remove your own/i.test(selfLockout.body.error || ''), selfLockout.body.error);
  const afterAttempt = (await db.all('SELECT permission FROM role_permissions WHERE role_key = ?', [TEST_ROLE])).map((r) => r.permission);
  check('the permission set is unchanged', afterAttempt.includes('users.manage_roles'), afterAttempt);

  // Isolating the grants_all guard from the self-lockout one, while
  // testUserCookie still holds users.manage_roles (the demotion below takes
  // it away): the custom-role account is definitely not logged in as
  // SUPER_ADMIN, so if THIS is refused it can only be because Super Admin
  // itself is protected.
  const editSuperAsOther = await call('PUT', '/api/admin/roles/SUPER_ADMIN',
    { label: 'Hacked', permissions: ['payments.view'] }, testUserCookie);
  check('Super Admin is refused editing by a different admin too', editSuperAsOther.status === 403, editSuperAsOther.body);
  check('with the grants_all-specific message', /Super Admin cannot be edited/i.test(editSuperAsOther.body.error || ''),
    editSuperAsOther.body.error);

  // The SAME edit, made by someone else (Super Admin), is allowed -- the
  // guard is "not your own role", not "users.manage_roles is untouchable".
  const otherEditsIt = await call('PUT', `/api/admin/roles/${TEST_ROLE}`,
    { label: 'Role Manager (demoted)', permissions: ['users.view'] }, superCookie);
  check('a DIFFERENT admin editing the same role is allowed', otherEditsIt.body.success === true, otherEditsIt.body);
  const demoted = (await db.all('SELECT permission FROM role_permissions WHERE role_key = ?', [TEST_ROLE])).map((r) => r.permission);
  check('users.manage_roles is really gone now', !demoted.includes('users.manage_roles'), demoted);

  console.log('\n== That takes effect immediately, no restart ==');
  const nowRefused = await call('GET', '/api/admin/roles', null, testUserCookie);
  check('the demoted user is now refused the editor', nowRefused.status === 403, nowRefused.status);

  console.log('\n== Super Admin cannot be touched, even by itself ==');
  const editSuperAsSelf = await call('PUT', '/api/admin/roles/SUPER_ADMIN', { label: 'Hacked', permissions: [] }, superCookie);
  check('editing it is refused', editSuperAsSelf.status === 403, editSuperAsSelf.body);
  const deleteSuper = await call('DELETE', '/api/admin/roles/SUPER_ADMIN', null, superCookie);
  check('deleting it is refused', deleteSuper.status === 403, deleteSuper.body);
  const deleteFinance = await call('DELETE', '/api/admin/roles/FINANCE_ADMIN', null, superCookie);
  check('deleting any built-in role is refused, not just Super Admin', deleteFinance.status === 403, deleteFinance.body);

  console.log('\n== A built-in role\'s PERMISSIONS stay editable, though ==');
  // That's the actual point of Phase 2/4 together: tune what Finance Admin
  // can do without a deploy. Add and remove a harmless permission, restore.
  const financeBefore = (await db.all("SELECT permission FROM role_permissions WHERE role_key='FINANCE_ADMIN'")).map((r) => r.permission);
  const financeEdit = await call('PUT', '/api/admin/roles/FINANCE_ADMIN',
    { label: 'Finance Admin', permissions: [...financeBefore, 'reports.abstracts'] }, superCookie);
  check('a built-in role\\u2019s permission set can be edited', financeEdit.body.success === true, financeEdit.body);
  const financeCanNow = await call('GET', '/api/admin/reports/abstracts?format=json', null, financeCookie);
  check('...and it takes effect for that role\\u2019s holders immediately', financeCanNow.status !== 403, financeCanNow.status);
  // Restore.
  await call('PUT', '/api/admin/roles/FINANCE_ADMIN', { label: 'Finance Admin', permissions: financeBefore }, superCookie);
  const financeRestored = (await db.all("SELECT permission FROM role_permissions WHERE role_key='FINANCE_ADMIN'")).map((r) => r.permission).sort();
  check('restored exactly', JSON.stringify(financeRestored) === JSON.stringify(financeBefore.slice().sort()), financeRestored);
  await call('POST', '/api/admin/roles/reload', null, superCookie);

  console.log('\n== Deletion ==');
  const stillHeld = await call('DELETE', `/api/admin/roles/${TEST_ROLE}`, null, superCookie);
  check('refused while a user still holds it', stillHeld.status === 409, stillHeld.body);
  check('...and says how many', /1 user/.test(stillHeld.body.error || ''), stillHeld.body.error);

  await call('PUT', `/api/users/${encodeURIComponent(TEST_PHONE)}/role`, { role: 'DELEGATE' }, superCookie);
  const nowUnheld = await call('DELETE', `/api/admin/roles/${TEST_ROLE}`, null, superCookie);
  check('succeeds once nobody holds it', nowUnheld.body.success === true, nowUnheld.body);
  const gone = await db.get('SELECT key FROM roles WHERE key = ?', [TEST_ROLE]);
  check('really gone from the database', !gone, gone);
  const permsGone = await db.get('SELECT COUNT(*) AS n FROM role_permissions WHERE role_key = ?', [TEST_ROLE]);
  check('its permission rows go with it', permsGone.n === 0, permsGone.n);

  const deleteAudit = await db.get(
    "SELECT action FROM audit_log WHERE entity_type='role' AND entity_id=? AND action='ROLE_DELETED' ORDER BY id DESC LIMIT 1", [TEST_ROLE]);
  check('the deletion is audited', !!deleteAudit, deleteAudit);

  console.log('\n== The delegate portal recognises a custom role as admin too ==');
  // Same class of gap as isKnownAdminRole() on the server: the "go to admin
  // panel" button on the delegate dashboard used to check a hardcoded list
  // of the five built-in role names. Driven for real, in the same
  // append-to-the-source vm technique tests/role-visibility-client.test.js
  // uses for exactly this reason -- isAdminUser() closes over a top-level
  // `let currentDelegate`, which a value poked onto the sandbox object from
  // outside would not actually be seen by (verified there; not re-derived
  // here).
  const vm = require('vm');
  const jsForVm = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  const driver = `currentDelegate = { role: '${TEST_ROLE}' }; var __IS_ADMIN__ = isAdminUser();
    currentDelegate = { role: 'DELEGATE' }; var __IS_DELEGATE__ = isAdminUser();
    currentDelegate = null; var __IS_NULL__ = isAdminUser();`;
  const sandbox = {
    window: { addEventListener() {}, location: { href: '', pathname: '/', search: '' }, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document: { getElementById: () => null, addEventListener() {}, readyState: 'loading', cookie: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, fetch: () => Promise.reject(new Error('no network in this sandbox')),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON,
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  sandbox.window.document = sandbox.document; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  let vmError = null;
  try { vm.runInContext(jsForVm + '\n' + driver, sandbox, { filename: 'app.js' }); } catch (e) { vmError = e; }
  check('the sandbox runs cleanly', !vmError, vmError && vmError.message);
  check('a custom role is recognised as admin (this used to be false)', sandbox.__IS_ADMIN__ === true, sandbox.__IS_ADMIN__);
  check('DELEGATE is still not admin', sandbox.__IS_DELEGATE__ === false, sandbox.__IS_DELEGATE__);
  check('no account at all is not admin', sandbox.__IS_NULL__ === false, sandbox.__IS_NULL__);

  console.log('\n== Client wiring ==');
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  check('the editor exists', /function openRoleEditor\(/.test(js));
  check('duplicate reuses create rather than a separate endpoint',
    /function duplicateRole\(/.test(js) && !/roles\/[^/]+\/duplicate/.test(js));
  check('the matrix is built from the server\\u2019s own catalogue, not a client copy',
    /function buildPermissionMatrix\(/.test(js) && /cachedRoleCatalogue/.test(js));
  check('role options are dynamic, not the old hardcoded ROLE_OPTIONS',
    !/const ROLE_OPTIONS = \[/.test(js) && /function roleSelectOptionsHtml\(/.test(js));
  const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'roles.ejs'), 'utf8');
  check('the section exists', /id="section-roles"/.test(view));
  const header = fs.readFileSync(appFile('views', 'admin', 'partials', 'header.ejs'), 'utf8');
  check('and has a menu item', /id="settings-item-roles"/.test(header));

  db.close();
  report();
})();
