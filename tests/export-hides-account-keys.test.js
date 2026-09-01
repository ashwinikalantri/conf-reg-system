const { call, check, report, adminLogin, openDb } = require('./harness');
// A synthetic account key (u_<hex>) is an internal identifier for accounts
// with no phone number. It must never leave the building -- not in an export,
// not in a report. This was a script that printed the CSV and asked the
// question in prose.
const db = openDb({ readOnly: true });

(async () => {
  const ac = await adminLogin();
  const csv = await call('GET', '/api/admin/reports/users?format=csv', null, ac);
  check('the CSV export is served', csv.status === 200, csv.status);
  check('it is actually CSV', /text\/csv|application\/octet-stream/.test(csv.type || ''), csv.type);

  const synthetic = await db.get(
    "SELECT phone_number FROM users WHERE phone_number LIKE 'u\\_%' ESCAPE '\\' LIMIT 1");
  check('the fixture has an account with a synthetic key', !!synthetic, synthetic);

  check('no synthetic key appears in the export', !/u_[0-9a-f]{18}/.test(csv.raw),
    (csv.raw.match(/u_[0-9a-f]{18}/) || [])[0]);
  check('that specific key is absent too', !csv.raw.includes(synthetic.phone_number));

  // The same must hold for the on-screen report, not just the CSV.
  const html = await call('GET', '/api/admin/reports/users', null, ac);
  check('nor in the on-screen report', !/u_[0-9a-f]{18}/.test(html.raw),
    (html.raw.match(/u_[0-9a-f]{18}/) || [])[0]);

  db.close();
  report();
})();
