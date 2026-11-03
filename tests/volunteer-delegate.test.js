// A delegate who volunteers (3 Nov 2026): given one or more volunteer roles
// in Settings > Users, they stay a delegate -- registered, on the delegate
// lists -- and also open the admin page for those areas. Only volunteer
// roles go on a delegate; a staff role still means changing the main role.
const { call, adminLogin, loginOtp, check, report, openDb } = require('./harness');

(async () => {
  const admin = await adminLogin();
  const db = await openDb();
  // A seeded delegate with no extra roles. Signed in by one-time code:
  // other suites change passwords.
  const d = await db.get(`SELECT u.phone_number FROM users u WHERE u.role = 'DELEGATE' AND u.phone_verified = 1
      AND NOT EXISTS (SELECT 1 FROM user_roles x WHERE x.phone_number = u.phone_number) ORDER BY u.phone_number LIMIT 1`);
  check('fixture: a delegate who can sign in', !!d);
  const phone = d.phone_number;
  const setRoles = (roles, as = admin) => call('PUT', `/api/users/${encodeURIComponent(phone)}/roles`, { roles }, as);

  try {
    console.log('\n== Before ==');
    let me = await loginOtp(phone);
    check('fixture: they can sign in', !!me);
    let who = (await call('GET', '/api/auth/me', null, me)).body;
    check('a delegate alone has no admin access', who.user.admin_access === false);
    check('...and the admin page is closed to them', (await call('GET', '/admin', null, me)).status === 403);

    console.log('\n== Made a volunteer ==');
    check('a staff role cannot go on a delegate as an extra', (await setRoles(['FINANCE_ADMIN'])).status === 400);
    const ok = await setRoles(['VOLUNTEER_MEALS', 'VOLUNTEER_TRANSPORT']);
    check('volunteer roles can', ok.status === 200 && ok.body.success, ok.body);
    check('...and they are still a delegate', (await db.get('SELECT role FROM users WHERE phone_number = ?', [phone])).role === 'DELEGATE');
    const audit = await db.get(`SELECT new_value FROM audit_log WHERE action = 'USER_ROLES_CHANGED' AND entity_id = ? ORDER BY id DESC LIMIT 1`, [phone]);
    check('...recorded in the activity log', audit && /VOLUNTEER_MEALS/.test(audit.new_value), audit);

    who = (await call('GET', '/api/auth/me', null, me)).body;
    check('their session holds Delegate and both volunteer roles', JSON.stringify(who.roles) === JSON.stringify(['DELEGATE', 'VOLUNTEER_MEALS', 'VOLUNTEER_TRANSPORT']), who.roles);
    check('...so the portal shows them the Admin link', who.user.admin_access === true);
    check('...and the meal counter and Faculty screens open', who.sections.meals === true && who.sections.faculty === true && !who.sections.payments, who.sections);
    check('the admin page opens', (await call('GET', '/admin', null, me)).status === 200);
    check('...the meal counter answers them', (await call('GET', '/api/meals', null, me)).status === 200);
    check('...but not what no volunteer role gives', (await call('GET', '/api/registrations', null, me)).status === 403);
    const pool = (await call('GET', '/api/guests', null, admin)).body.coordinators;
    check('a transport volunteer is offered for faculty pickups, not for stays', pool.transport.some((p) => p.phone === phone) && !pool.accommodation.some((p) => p.phone === phone));
    const users = (await call('GET', '/api/users', null, admin)).body;
    const row = (users.users || users).find((u) => u.phone_number === phone);
    check('the Users list shows the volunteer roles beside Delegate', row && row.role === 'DELEGATE' && row.extra_roles.join() === 'VOLUNTEER_MEALS,VOLUNTEER_TRANSPORT', row && row.extra_roles);
    const asked = await call('POST', '/api/auth/login-otp', { identifier: phone });
    const login = await call('POST', '/api/auth/login', { identifier: phone, otp: asked.body.devOtp });
    check('signing in tells the portal too', login.body.user && login.body.user.admin_access === true, login.body);
    me = login.cookie;

    console.log('\n== Back to a plain delegate ==');
    await setRoles([]);
    who = (await call('GET', '/api/auth/me', null, me)).body;
    check('no volunteer roles, no admin access', who.user.admin_access === false && JSON.stringify(who.roles) === '["DELEGATE"]', who.roles);
    check('...the admin page is closed again', (await call('GET', '/admin', null, me)).status === 403);

    console.log('\n== Staff made a delegate keep their volunteer roles ==');
    await call('PUT', `/api/users/${encodeURIComponent(phone)}/role`, { role: 'OPERATIONS' }, admin);
    await setRoles(['VOLUNTEER_MEALS', 'FINANCE_ADMIN']);
    await call('PUT', `/api/users/${encodeURIComponent(phone)}/role`, { role: 'DELEGATE' }, admin);
    const kept = (await db.all('SELECT role_key FROM user_roles WHERE phone_number = ? ORDER BY role_key', [phone])).map((r) => r.role_key);
    check('the volunteer role stays, the staff one goes', kept.join() === 'VOLUNTEER_MEALS', kept);
  } finally {
    await db.run('DELETE FROM user_roles WHERE phone_number = ?', [phone]);
    await db.run("UPDATE users SET role = 'DELEGATE' WHERE phone_number = ?", [phone]);
    db.close();
  }
  report();
})();
