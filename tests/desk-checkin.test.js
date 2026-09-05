// Check-in is the one genuinely new capability in the front desk: nothing in
// the app recorded that a delegate had physically arrived -- no column, no
// table, no route. Everything else the desk does already existed somewhere
// under a wider permission.
//
// Two properties matter more than the happy path. It must be IDEMPOTENT,
// because at a counter the same person is scanned twice and the second scan
// must not overwrite who checked them in or when; and "not yet arrived" must
// be distinguishable from "arrived", which is why the columns are nullable
// rather than a flag defaulting to 0 -- on every day before the conference,
// every row is "not yet".
const { call, check, report, ADMIN_PW, adminLogin, loginPassword, openDb } = require('./harness');

const DESK = '9000000006';         // Dez Counter, FRONT_DESK
const REVIEWER = '9000000003';     // Rae Reviewer -- holds no desk permission
const D = '9000001003';

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword(DESK, ADMIN_PW);
  const reviewer = await loginPassword(REVIEWER, ADMIN_PW);

  // openDb returns a promise-based wrapper, not a raw sqlite3 handle: its
  // get/all/run take (sql, params) and RESOLVE, they do not take a callback.
  const db = openDb({ readOnly: true });
  const get = (q, p = []) => db.get(q, p);

  console.log('\n== Before anybody arrives, nobody has arrived ==');
  const fresh = await call('GET', `/api/desk/delegate/${D}`, null, desk);
  check('the delegate loads', fresh.status === 200 && fresh.body.success, fresh.body.error);
  check('and reads as not arrived -- null, not a zero that could mean anything',
    fresh.body.checkedIn === null, fresh.body.checkedIn);

  console.log('\n== Checking in records who and when ==');
  const done = await call('POST', '/api/desk/checkin', { identifier: D }, desk);
  check('the check-in succeeds', done.status === 200 && done.body.success, done.body.error);
  check('...and returns the moment', typeof done.body.at === 'number' && done.body.at > 0, done.body.at);
  check('...credited to the person at the counter', done.body.by === 'Dez Counter', done.body.by);

  const row = await get('SELECT checked_in_at, checked_in_by FROM registrations WHERE phone_number = ?', [D]);
  check('both columns are written', !!row.checked_in_at && !!row.checked_in_by, row);
  check('...with a plausible timestamp, not a stray zero or a date string',
    Math.abs(row.checked_in_at - Date.now()) < 60000, row.checked_in_at);

  const after = await call('GET', `/api/desk/delegate/${D}`, null, desk);
  check('the record now shows the arrival', !!after.body.checkedIn, after.body.checkedIn);
  check('...with both facts', after.body.checkedIn.at === row.checked_in_at
    && after.body.checkedIn.by === 'Dez Counter', after.body.checkedIn);

  console.log('\n== Scanning the same person twice does not rewrite history ==');
  // The failure this prevents: a second scan by somebody else silently
  // reassigning who checked the delegate in, and moving the arrival time to
  // whenever the duplicate happened.
  const again = await call('POST', '/api/desk/checkin', { identifier: D }, admin);
  check('the second attempt still succeeds -- it is not an error at a counter',
    again.status === 200 && again.body.success, again.status);
  check('...but says it was already done', again.body.alreadyCheckedIn === true, again.body);
  const row2 = await get('SELECT checked_in_at, checked_in_by FROM registrations WHERE phone_number = ?', [D]);
  check('the original time is kept', row2.checked_in_at === row.checked_in_at,
    [row.checked_in_at, row2.checked_in_at]);
  check('...and so is the original person, not the one who scanned second',
    row2.checked_in_by === 'Dez Counter', row2.checked_in_by);

  console.log('\n== It is audited, like every other thing done to a registration ==');
  // Read from audit_log directly rather than through /api/admin/activity-log:
  // that endpoint is the Settings "General Logs" feed and filters to
  // GENERAL_LOG_ENTITY_TYPES, which deliberately excludes 'registration' --
  // per-registration history is served by GET /api/registrations/:id/audit.
  const reg = await get('SELECT id FROM registrations WHERE phone_number = ?', [D]);
  const entry = await get(
    "SELECT action, actor_name FROM audit_log WHERE entity_type = 'registration' AND entity_id = ? AND action = 'DESK_CHECKIN'",
    [reg.id]);
  check('the check-in is in the audit log', !!entry, entry);
  check('...attributed to whoever did it', !!entry && !!entry.actor_name, entry && entry.actor_name);

  console.log('\n== Only a role that may check people in, may ==');
  const refused = await call('POST', '/api/desk/checkin', { identifier: '9000001004' }, reviewer);
  check('an academic reviewer is refused', refused.status === 403, refused.status);
  const stillClean = await get('SELECT checked_in_at FROM registrations WHERE phone_number = ?', ['9000001004']);
  check('...and nothing was written', !stillClean.checked_in_at, stillClean.checked_in_at);

  console.log('\n== Somebody with no registration cannot arrive ==');
  const noReg = await call('POST', '/api/desk/checkin', { identifier: '9000000002' }, desk);
  check('a staff account with no registration is refused', noReg.status === 404, noReg.status);
  check('...for a reason that names the problem',
    /no registration/i.test(noReg.body.error || ''), noReg.body.error);
  const nobody = await call('POST', '/api/desk/checkin', { identifier: 'not-a-person' }, desk);
  check('and an unknown identifier is a 404, not a crash', nobody.status === 404, nobody.status);

  db.close();
  report();
})();
