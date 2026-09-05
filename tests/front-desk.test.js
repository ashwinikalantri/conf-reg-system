// The Front Desk exists because every other admin screen is a worklist and a
// conference desk is not: there is one person at the counter and the question
// is what to do about them.
//
// Almost none of it is new capability -- the lookup composes the same helpers
// as the admin user-detail panel, the receipt is the same renderReceipt, and a
// programme change goes through the same capacity rules as the delegate's own
// form. What IS new is the grain of the permissions, and that is what this
// file is mostly about: a desk role assembled from the obvious existing
// grants would, in practice, be an administrator. Reprinting a receipt would
// need payments.view (the whole finance worklist), reading one delegate would
// need users.view (the Users & Roles tab), and moving somebody into a
// workshop would need masters.programs_manage -- which also confers deleting
// that workshop and wiping its roster.
//
// So the interesting assertions here are the REFUSALS.
const { call, check, report, ADMIN_PW, adminLogin, loginPassword, openDb } = require('./harness');

const DESK = '9000000006';         // Dez Counter, FRONT_DESK
const D1 = '9000001001';           // One Payment, faculty_mo, verified, 2 options

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword(DESK, ADMIN_PW);
  check('the front desk signs in', !!desk);
  if (!desk) return report();

  console.log('\n== The desk can do its own job ==');
  const one = await call('GET', `/api/desk/delegate/${D1}`, null, desk);
  check('a delegate looks up by mobile number', one.status === 200 && one.body.success, one.status);
  check('...and comes back whole, not as a row',
    !!(one.body.user && one.body.registration && one.body.payment && one.body.selections),
    Object.keys(one.body));
  check('...including the abstract state, which no other screen shows beside the payment',
    Array.isArray(one.body.abstracts));
  check('...and arrival, lifted out because the desk reads it as a fact about the person',
    Object.prototype.hasOwnProperty.call(one.body, 'checkedIn'));

  const prog = await call('GET', '/api/desk/programmes', null, desk);
  check('programmes load, with occupancy', prog.status === 200 && prog.body.groups.length > 0);
  const staff = await call('GET', '/api/desk/staff', null, desk);
  check('the collector list loads', staff.status === 200 && staff.body.staff.length > 0);
  const cash = await call('GET', '/api/desk/cash-in-hand', null, desk);
  check('its own cash float loads', cash.status === 200 && typeof cash.body.total === 'number');

  console.log('\n== It is found the way somebody at a counter can be found ==');
  const reg = one.body.registration;
  const byReg = await call('GET', `/api/desk/delegate/${encodeURIComponent(reg.registration_number)}`, null, desk);
  check('by registration number', byReg.status === 200 && byReg.body.user.phone_number === D1,
    byReg.body.error || byReg.body.user);
  // Read off a phone screen and typed back in by hand, so case must not matter.
  const byRegLower = await call('GET', `/api/desk/delegate/${encodeURIComponent(reg.registration_number.toLowerCase())}`, null, desk);
  check('...in either case', byRegLower.status === 200 && byRegLower.body.user.phone_number === D1);
  const byEmail = await call('GET', '/api/desk/delegate/one.payment@example.test', null, desk);
  check('by email', byEmail.status === 200 && byEmail.body.user.phone_number === D1);
  const byName = await call('GET', '/api/desk/delegate/One%20Payment', null, desk);
  check('by name', byName.status === 200 && (byName.body.user || byName.body.candidates));
  const nobody = await call('GET', '/api/desk/delegate/zzz-no-such-person', null, desk);
  check('and a miss says so plainly', nobody.status === 404 && /Nobody found/.test(nobody.body.error || ''),
    nobody.body.error);

  console.log('\n== A name that matches several people is not guessed at ==');
  // "Payment" appears in more than one fixture name. The desk is asked to
  // choose rather than handed whoever sorts first.
  const many = await call('GET', '/api/desk/delegate/Payment', null, desk);
  check('a shortlist comes back instead of a delegate',
    many.status === 200 && Array.isArray(many.body.candidates) && many.body.candidates.length > 1,
    many.body.candidates ? many.body.candidates.length : many.body.user && many.body.user.full_name);
  check('...and every candidate carries enough to tell them apart',
    (many.body.candidates || []).every((c) => c.phone_number && c.full_name));

  console.log('\n== What the desk is deliberately refused ==');
  // Each of these is a grant the desk would have picked up if its access had
  // been assembled out of the existing coarse permissions.
  const worklist = await call('GET', '/api/registrations', null, desk);
  check('the payments worklist -- every registration, ledger and audit trail', worklist.status === 403, worklist.status);
  const totals = await call('GET', '/api/admin/finance-summary', null, desk);
  check('conference-wide money', totals.status === 403, totals.status);
  const users = await call('GET', '/api/users', null, desk);
  check('the Users & Roles list', users.status === 403, users.status);
  const statement = await call('GET', '/api/admin/bank-statement', null, desk);
  check('the bank statement', statement.status === 403, statement.status);
  const abstracts = await call('GET', '/api/abstracts', null, desk);
  check('the abstract review desk', abstracts.status === 403, abstracts.status);
  const wideReceipt = await call('GET', `/api/registrations/${reg.id}/receipt`, null, desk);
  check('the payments-guarded receipt route', wideReceipt.status === 403, wideReceipt.status);
  // The one that matters most: the naive way to let a desk change a workshop.
  const groups = await call('GET', '/api/admin/program-groups', null, admin);
  const groupId = groups.body.groups[0].id;
  const kill = await call('DELETE', `/api/admin/program-groups/${groupId}`, null, desk);
  check('deleting a workshop and wiping its roster', kill.status === 403, kill.status);
  const rosterEnroll = await call('POST', `/api/admin/program-options/${groups.body.groups[0].options[0].id}/enroll`,
    { identifier: D1 }, desk);
  check('the master-data enrol route', rosterEnroll.status === 403, rosterEnroll.status);

  console.log('\n== But it CAN reprint the same receipt, through its own route ==');
  const deskReceipt = await call('GET', `/api/desk/registrations/${reg.id}/receipt`, null, desk);
  check('the desk receipt renders', deskReceipt.status === 200, deskReceipt.status);
  const adminReceipt = await call('GET', `/api/registrations/${reg.id}/receipt`, null, admin);
  check('...and it is the same document, not a lesser one',
    deskReceipt.status === 200 && adminReceipt.status === 200
    && String(deskReceipt.body).length === String(adminReceipt.body).length,
    [String(deskReceipt.body).length, String(adminReceipt.body).length]);

  console.log('\n== Occupancy is counted the way the app counts it ==');
  // Faculty are attached to an option so they appear on its roster, but they
  // do not occupy a delegate's seat -- fetchProgramOptions is the only source
  // that gets this right. Counting registration_options rows directly
  // overstates any workshop that has faculty on it, which is exactly the
  // mistake that makes a half-empty workshop look overbooked.
  // Writable, not read-only: this block flips a faculty flag to prove the
  // seat count ignores faculty, then puts it back. openDb's get/run are
  // promise-based and take (sql, params) -- no callback.
  const db = openDb();
  const get = (q, p = []) => db.get(q, p);
  const opt = prog.body.groups.flatMap((g) => g.options)[0];
  const raw = await get('SELECT COUNT(*) AS n FROM registration_options WHERE option_id = ?', [opt.id]);
  await db.run(
    'UPDATE registration_options SET is_faculty = 1 WHERE option_id = ? AND rowid = (SELECT MIN(rowid) FROM registration_options WHERE option_id = ?)',
    [opt.id, opt.id]);
  const after = await call('GET', '/api/desk/programmes', null, desk);
  const optAfter = after.body.groups.flatMap((g) => g.options).find((o) => o.id === opt.id);
  check('marking one enrolment as faculty lowers the seat count',
    raw.n > 0 ? optAfter.enrolled === opt.enrolled - 1 : true,
    { rawRows: raw.n, before: opt.enrolled, after: optAfter.enrolled });
  check('...and shows them separately rather than losing them',
    optAfter.faculty_count === opt.faculty_count + (raw.n > 0 ? 1 : 0),
    { before: opt.faculty_count, after: optAfter.faculty_count });
  // Put it back: later files share this database.
  await db.run('UPDATE registration_options SET is_faculty = 0 WHERE option_id = ?', [opt.id]);

  console.log('\n== A full option is not silently overfilled ==');
  const admin2 = admin;
  const gid = groups.body.groups[0].id;
  const run = (q, p = []) => db.run(q, p);
  // A capacity-1 option with its one seat taken -- the smallest honest way to
  // reach "full" without depending on fixture volumes.
  const tightId = (await run(
    `INSERT INTO program_options (type, name, capacity, active, created_at, group_id, fee)
     VALUES ('workshop', 'Tight Room', 1, 1, ?, ?, 0)`, [Date.now(), gid])).lastID;
  const seated = await call('POST', `/api/admin/program-options/${tightId}/enroll`, { identifier: '9000001002' }, admin2);
  check('one delegate takes the only seat', seated.status === 200, seated.body.error);

  const blocked = await call('POST', '/api/desk/enroll', { identifier: D1, optionId: tightId }, desk);
  check('the desk is stopped, not refused outright', blocked.status === 409 && blocked.body.needsReason === true,
    [blocked.status, blocked.body.error]);
  check('...and told which room and how big it is', /Tight Room/.test(blocked.body.error || '')
    && /1 seats/.test(blocked.body.error || ''), blocked.body.error);

  const forced = await call('POST', '/api/desk/enroll',
    { identifier: D1, optionId: tightId, reason: 'Presenter, room agreed with the convener' }, desk);
  check('with a reason it goes through', forced.status === 200 && forced.body.success, forced.body.error);
  check('...and is flagged as an override', forced.body.overCapacity === true);

  // Straight from audit_log: /api/admin/activity-log is the Settings "General
  // Logs" feed and filters to GENERAL_LOG_ENTITY_TYPES, which excludes
  // 'registration' on purpose.
  const entry = await get(
    "SELECT action, new_value FROM audit_log WHERE entity_type = 'registration' AND action = 'DESK_ENROLL_OVER_CAPACITY' ORDER BY id DESC LIMIT 1");
  check('the override is in the audit log', !!entry, entry);
  check('...carrying the reason that was typed, not just the fact',
    !!entry && /room agreed with the convener/.test(entry.new_value || ''), entry && entry.new_value);

  console.log('\n== An ordinary move is not treated as an override ==');
  const roomy = prog.body.groups[0].options.find((o) => o.enrolled < o.capacity - 1);
  const moved = await call('POST', '/api/desk/enroll', { identifier: D1, optionId: roomy.id }, desk);
  check('a move into a room with space succeeds', moved.status === 200 && moved.body.success, moved.body.error);
  check('...and is NOT recorded as over capacity', moved.body.overCapacity === false);

  console.log('\n== One choice per group, same as everywhere else ==');
  const afterMove = await call('GET', `/api/desk/delegate/${D1}`, null, desk);
  const inGroup = afterMove.body.selections.filter((s) => s.group_id === roomy.group_id);
  check('the old choice is replaced, not added to', inGroup.length === 1, inGroup);
  check('...and it is the new one', inGroup[0].option_id === roomy.id, inGroup[0]);

  console.log('\n== The desk can fix the things a delegate gets wrong about themselves ==');
  // Each of these is an existing fine-grained permission the desk holds
  // deliberately: none of them opens a tab, so holding them does not widen
  // what the desk can SEE, only what it can correct for the person in front
  // of it.
  const edited = await call('PUT', `/api/users/${D1}`, { designation: 'Professor of Paediatrics' }, desk);
  check('demography can be corrected', edited.status === 200 && edited.body.success, edited.body.error);
  const reread = await call('GET', `/api/desk/delegate/${D1}`, null, desk);
  check('...and the correction sticks', reread.body.user.designation === 'Professor of Paediatrics',
    reread.body.user.designation);

  // A student who turns out to be faculty: the category and fee change
  // together, which is exactly why this needs a permission at all.
  // 9000001006 is 'Unchecked Id', med_student at Rs1500 -- a genuinely
  // different category and fee from faculty_mo, so the change is observable.
  const student = await call('GET', '/api/desk/delegate/9000001006', null, desk);
  if (student.body.registration) {
    const before = student.body.registration.expected_amount;
    const changed = await call('PUT', `/api/registrations/${student.body.registration.id}/lock-category`,
      { categoryKey: 'faculty_mo' }, desk);
    check('a category can be corrected at the desk', changed.status === 200 && changed.body.success,
      changed.body.error);
    check('...and the fee moves with it', changed.body.expectedAmount !== before,
      [before, changed.body.expectedAmount]);
  }

  db.close();
  report();
})();
