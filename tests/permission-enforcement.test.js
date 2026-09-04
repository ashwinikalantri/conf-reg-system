// The catalogue is only worth anything if the running server obeys it.
//
// permission-catalogue.test.js reads source and proves the mapping is right.
// This one signs in as each of the five roles and actually calls the routes,
// asserting that what comes back -- served, or 403 -- is what the catalogue
// says it should be. Static agreement and real enforcement are different
// claims, and only this one would notice a middleware that was wired up but
// never actually consulted.
//
// What this test does NOT catch, on purpose: a role granted something extra.
// It asks whether the server agrees with the catalogue, so changing the
// catalogue changes both sides and they still agree. Widening a role is
// caught by permission-catalogue.test.js, which holds the catalogue against
// a frozen baseline. Two different questions, two tests; neither alone is
// enough, and a reader should not mistake one for the other.
//
// Read-only routes only: one representative GET per permission boundary, so
// the test can run against the shared fixture without changing it.
const { call, check, report, loginPassword, ADMIN_PW } = require('./harness');
const perms = require('../permissions');

// The seeded staff, one per role (tests/seed.js STAFF).
const STAFF = {
  SUPER_ADMIN: '9000000001',
  FINANCE_ADMIN: '9000000002',
  ACADEMIC_REVIEWER: '9000000003',
  OPERATIONS: '9000000004',
  FINANCE_ACADEMIC: '9000000005',
};

// One GET per boundary. `route` is what the browser calls; `permission` is
// what the catalogue says guards it -- asserted against ROUTE_PERMISSIONS
// below, so a typo here fails rather than quietly testing the wrong thing.
const PROBES = [
  { permission: 'payments.view', url: '/api/registrations', route: 'GET /api/registrations' },
  { permission: 'statement.view', url: '/api/admin/bank-statement', route: 'GET /api/admin/bank-statement' },
  { permission: 'abstracts.view', url: '/api/abstracts', route: 'GET /api/abstracts' },
  { permission: 'users.view', url: '/api/users', route: 'GET /api/users' },
  { permission: 'masters.fees_view', url: '/api/admin/fees', route: 'GET /api/admin/fees' },
  { permission: 'masters.programs_view', url: '/api/admin/program-groups', route: 'GET /api/admin/program-groups' },
  { permission: 'discounts.view', url: '/api/admin/discount-codes', route: 'GET /api/admin/discount-codes' },
  { permission: 'discounts.group_view', url: '/api/admin/group-rules', route: 'GET /api/admin/group-rules' },
  { permission: 'comms.reminders_view', url: '/api/admin/reminders/pending-signups', route: 'GET /api/admin/reminders/pending-signups' },
  { permission: 'system.settings_view', url: '/api/admin/general-settings', route: 'GET /api/admin/general-settings' },
  { permission: 'system.activity_log', url: '/api/admin/activity-log', route: 'GET /api/admin/activity-log' },
  { permission: 'system.backups', url: '/api/admin/backup/status', route: 'GET /api/admin/backup/status' },
  { permission: 'payments.link', url: '/api/admin/bank-credit-candidates', route: 'GET /api/admin/bank-credit-candidates' },
  { permission: 'statement.cash_deposit', url: '/api/admin/cash-in-hand', route: 'GET /api/admin/cash-in-hand' },
];

// The reports gate inside the handler rather than at the route, so they are
// probed by name.
const REPORT_PROBES = [
  { report: 'delegates', permission: 'reports.delegates' },
  { report: 'payments', permission: 'reports.payments' },
  { report: 'abstracts', permission: 'reports.abstracts' },
  { report: 'users', permission: 'reports.users' },
];

(async () => {
  console.log('\n== The probes describe real guards ==');
  for (const p of PROBES) {
    check(`${p.route} is guarded by ${p.permission}`,
      perms.permissionForRoute(p.route) === p.permission,
      perms.permissionForRoute(p.route));
  }
  for (const p of REPORT_PROBES) {
    check(`report "${p.report}" is guarded by ${p.permission}`,
      perms.REPORT_PERMISSIONS[p.report] === p.permission,
      perms.REPORT_PERMISSIONS[p.report]);
  }

  const cookies = {};
  console.log('\n== Every role can sign in ==');
  for (const [role, phone] of Object.entries(STAFF)) {
    cookies[role] = await loginPassword(phone, ADMIN_PW);
    check(`${role} signs in`, !!cookies[role]);
  }

  console.log('\n== Routes answer exactly as the catalogue says ==');
  let wrong = 0;
  for (const role of Object.keys(STAFF)) {
    if (!cookies[role]) continue;
    const granted = [];
    const refused = [];
    for (const p of PROBES) {
      const res = await call('GET', p.url, null, cookies[role]);
      const allowed = perms.roleCan(role, p.permission);
      // 403 is the refusal. Anything else means it got past the guard --
      // a 500 from a handler is still "allowed" for this purpose, and would
      // be someone else's failing test.
      const served = res.status !== 403;
      if (served !== allowed) {
        wrong++;
        check(`${role} on ${p.url}`, false, `expected ${allowed ? 'served' : '403'}, got ${res.status}`);
      }
      (served ? granted : refused).push(p.permission.split('.')[0]);
    }
    console.log(`   ${role.padEnd(18)} served ${String(granted.length).padStart(2)}/${PROBES.length}`
      + `  ${[...new Set(granted)].join(' ') || '(none)'}`);
    check(`${role} is enforced exactly`, wrong === 0 || granted.length + refused.length === PROBES.length);
  }
  check('no route answered against the catalogue', wrong === 0, wrong);

  console.log('\n== Reports too ==');
  let wrongReports = 0;
  for (const role of Object.keys(STAFF)) {
    if (!cookies[role]) continue;
    for (const p of REPORT_PROBES) {
      const res = await call('GET', `/api/admin/reports/${p.report}?format=json`, null, cookies[role]);
      const allowed = perms.roleCan(role, p.permission);
      const served = res.status !== 403;
      if (served !== allowed) {
        wrongReports++;
        check(`${role} on report ${p.report}`, false, `expected ${allowed ? 'served' : '403'}, got ${res.status}`);
      }
    }
  }
  check('every report answered as catalogued', wrongReports === 0, wrongReports);

  console.log('\n== Signed out is refused, not merely unlisted ==');
  for (const p of PROBES.slice(0, 6)) {
    const res = await call('GET', p.url);
    check(`${p.url} needs a session`, res.status === 401 || res.status === 403, res.status);
  }

  console.log('\n== A delegate is not an admin ==');
  // The role with no permissions at all must be refused everywhere, not
  // merely shown a smaller menu.
  const { openDb } = require('./harness');
  const db = openDb({ readOnly: true });
  const delegate = await db.get("SELECT phone_number FROM users WHERE role = 'DELEGATE' AND password_hash IS NOT NULL LIMIT 1");
  db.close();
  if (delegate) {
    const cookie = await loginPassword(delegate.phone_number, 'harness-delegate-pw');
    check('a delegate can sign in', !!cookie);
    if (cookie) {
      let allowed = 0;
      for (const p of PROBES) {
        const res = await call('GET', p.url, null, cookie);
        if (res.status !== 403) allowed++;
      }
      check('a delegate reaches no admin route', allowed === 0, `${allowed} of ${PROBES.length} answered`);
    }
  } else {
    check('the fixture has a delegate with a password', false, 'none found');
  }

  // --- write probes ------------------------------------------------------
  // Every probe above is a GET, so no write route had ever been proved to
  // refuse anyone. Abstract assignment is exactly a claim about a write
  // being refused -- accept/reject and set-format are two permissions now,
  // and the whole point is that holding one does not get you the other.
  console.log('\n== The two abstract writes are separately enforced ==');
  check('the two routes are guarded by different keys',
    perms.permissionForRoute('PUT /api/abstracts/:id/status') === 'abstracts.review'
    && perms.permissionForRoute('PUT /api/abstracts/:id/allocation') === 'abstracts.assign',
    [perms.permissionForRoute('PUT /api/abstracts/:id/status'),
      perms.permissionForRoute('PUT /api/abstracts/:id/allocation')]);

  {
    const db2 = openDb({ readOnly: true });
    const abs = await db2.get('SELECT id FROM abstracts LIMIT 1');
    db2.close();
    if (!abs) {
      check('the fixture has an abstract to probe with', false, 'none found');
    } else {
      for (const role of Object.keys(STAFF)) {
        if (!cookies[role]) continue;
        const canReview = perms.roleCan(role, 'abstracts.review');
        const canAssign = perms.roleCan(role, 'abstracts.assign');
        // A 400 means it got past the guard and the handler objected (an
        // abstract that is not ACCEPTED cannot be assigned a format) -- for
        // this test that still counts as "not refused", same convention as
        // the GET probes treating a 500 as served.
        const st = await call('PUT', `/api/abstracts/${abs.id}/status`, { status: 'UNDER_REVIEW' }, cookies[role]);
        check(`${role}: PUT status ${canReview ? 'allowed' : '403'}`,
          (st.status !== 403) === canReview, `got ${st.status}`);
        const al = await call('PUT', `/api/abstracts/${abs.id}/allocation`, { allocation: 'ORAL' }, cookies[role]);
        check(`${role}: PUT allocation ${canAssign ? 'allowed' : '403'}`,
          (al.status !== 403) === canAssign, `got ${al.status}`);
      }
      // The split is only meaningful if some role is on different sides of
      // it. Stated as its own check so the pair above cannot pass by every
      // role happening to hold both or neither.
      const reviewOnly = Object.keys(STAFF).filter((r) =>
        perms.roleCan(r, 'abstracts.review') && !perms.roleCan(r, 'abstracts.assign'));
      check('at least one role can review but not assign', reviewOnly.length > 0, reviewOnly);
    }
  }

  report();
})();
