// Fee waivers at the Front Desk (owner, 19 Nov 2026): part or all of what a
// delegate owes, with a reason. The Fee Waiver role (payments.waive_fee)
// waives directly, and approves or declines what the rest of the desk asks
// for. A registration left owing nothing, with nothing waiting to be
// verified, is confirmed at once; a waiver never reaches into an online
// payment still waiting to be verified.
const fs = require('fs');
const { call, check, report, ADMIN_PW, loginPassword, openDb, appFile } = require('./harness');
const perms = require('../permissions');

const DESK = '9000000006';      // Dez Counter, FRONT_DESK
const WAIVER = '9000000003';    // Rae Reviewer, given the Fee Waiver role here as an extra role

(async () => {
  const db = openDb();
  console.log('\n== The role ==');
  const role = perms.SYSTEM_ROLES.find((r) => r.key === 'FEE_WAIVER');
  check('a Fee Waiver role: the desk, and waiving fees', role && role.permissions.join() === 'desk.view,payments.waive_fee');
  check('...seeded into the roles', !!(await db.get("SELECT 1 FROM roles WHERE key = 'FEE_WAIVER'")));
  check('no other role but Super Admin may waive', perms.SYSTEM_ROLES.filter((r) => !r.all && (r.permissions || []).includes('payments.waive_fee')).map((r) => r.key).join() === 'FEE_WAIVER');

  // Two registrations owing money with no payment on file, made here for
  // two delegates who never registered, and removed after.
  const people = await db.all(`SELECT phone_number, full_name FROM users u WHERE role = 'DELEGATE'
      AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.phone_number = u.phone_number) ORDER BY phone_number LIMIT 2`);
  const madeIds = [];
  for (const [i, p] of people.entries()) {
    madeIds.push((await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, paid_amount, bank_status,
        registration_number, expected_amount, payment_mode, submitted_at) VALUES (?, ?, 'faculty_mo', 'Doctor', 0, 'PENDING', ?, 3000, 'UPI', ?)`,
      [p.phone_number, p.full_name || 'Waiver Test', `WAIVERTEST${i}`, Date.now()])).lastID);
  }
  const regs = madeIds.length ? await db.all(`SELECT * FROM registrations WHERE id IN (${madeIds.map(() => '?').join(',')}) ORDER BY id`, madeIds) : [];
  check('two registrations owing money, nothing paid', regs.length === 2, regs.length);
  const [A, B] = regs;
  await db.run("INSERT OR IGNORE INTO user_roles (phone_number, role_key) VALUES (?, 'FEE_WAIVER')", [WAIVER]);
  const desk = await loginPassword(DESK, ADMIN_PW);
  const approver = await loginPassword(WAIVER, ADMIN_PW);
  let txnId = null;
  try {
    console.log('\n== The desk asks ==');
    const reqBody = (reg, amount, reason) => ({ registrationId: reg.id, amount, reason });
    check('a desk without the role cannot waive directly', (await call('POST', '/api/desk/waive', reqBody(B, 500, 'Student volunteer, fee waived'), desk)).status === 403);
    check('...nor see the Waivers list', (await call('GET', '/api/desk/waivers', null, desk)).status === 403);
    const tooMuch = await call('POST', '/api/desk/waivers', reqBody(B, B.expected_amount + 1, 'More than they owe'), desk);
    check('no more than they owe', tooMuch.status === 400 && /At most ₹/.test(tooMuch.body.error || ''), tooMuch.body);
    check('a reason, in a sentence', (await call('POST', '/api/desk/waivers', reqBody(B, 500, 'ok'), desk)).status === 400);
    const asked = await call('POST', '/api/desk/waivers', reqBody(B, 500, 'Travelled from far, hardship case'), desk);
    check('the desk asks for ₹500 off', asked.status === 200 && asked.body.success && asked.body.id, asked.body);
    check('...one waiting at a time', (await call('POST', '/api/desk/waivers', reqBody(B, 300, 'Asking a second time over'), desk)).status === 409);
    check('...and nothing changes until it is approved', (await db.get('SELECT expected_amount FROM registrations WHERE id = ?', [B.id])).expected_amount === B.expected_amount);
    const onDesk = (await call('GET', `/api/desk/delegate/${B.phone_number}`, null, desk)).body;
    check('the desk record shows the request waiting', onDesk.waiver && onDesk.waiver.status === 'PENDING' && onDesk.waiver.amount === 500 && onDesk.waiver.requestedBy === 'Dez Counter', onDesk.waiver);
    check('a desk without the role cannot approve it', (await call('POST', `/api/desk/waivers/${asked.body.id}/approve`, {}, desk)).status === 403);

    console.log('\n== The Fee Waiver role decides ==');
    const list = (await call('GET', '/api/desk/waivers', null, approver)).body;
    check('the Waivers list has it waiting', list.success && list.pending.some((w) => w.id === asked.body.id && w.reason === 'Travelled from far, hardship case'));
    const ok = (await call('POST', `/api/desk/waivers/${asked.body.id}/approve`, {}, approver)).body;
    const rowB = await db.get('SELECT * FROM registrations WHERE id = ?', [B.id]);
    check('approved: they owe ₹500 less, recorded as a waiver with the reason', ok.success && ok.waived === 500 && rowB.expected_amount === B.expected_amount - 500
      && rowB.fee_adjustment_basis === 'WAIVER' && Number(rowB.fee_adjustment) === (Number(B.fee_adjustment) || 0) + 500
      && /Fee waived ₹500: Travelled from far/.test(rowB.fee_adjustment_reason) && rowB.fee_adjustment_by === 'Rae Reviewer', rowB);
    check('...still owing the rest, so not confirmed', ok.confirmed === false && rowB.bank_status === B.bank_status);
    check('...and decided once', (await call('POST', `/api/desk/waivers/${asked.body.id}/approve`, {}, approver)).status === 409);
    const second = (await call('POST', '/api/desk/waivers', reqBody(B, 200, 'Asked again, to be declined'), desk)).body;
    await call('POST', `/api/desk/waivers/${second.id}/decline`, { note: 'Already waived once' }, approver);
    const declined = (await call('GET', `/api/desk/delegate/${B.phone_number}`, null, desk)).body.waiver;
    check('a declined request says so on the record, and changes nothing', declined.status === 'DECLINED' && declined.note === 'Already waived once'
      && (await db.get('SELECT expected_amount FROM registrations WHERE id = ?', [B.id])).expected_amount === B.expected_amount - 500);

    console.log('\n== Waived in full: confirmed at once ==');
    const third = (await call('POST', '/api/desk/waivers', reqBody(A, 100, 'A small request, overtaken'), desk)).body;
    // An online payment waiting to be verified: the waiver stops short of it.
    txnId = (await db.run(`INSERT INTO payment_transactions (registration_id, phone_number, amount, payment_mode, txn_status, submitted_at)
      VALUES (?, ?, 400, 'UPI', 'PENDING', ?)`, [A.id, A.phone_number, Date.now()])).lastID;
    const over = await call('POST', '/api/desk/waive', reqBody(A, A.expected_amount, 'Whole fee, while a payment waits'), approver);
    check('not into an online payment still waiting to be verified', over.status === 400 && /paid online is still waiting/.test(over.body.error || ''), over.body);
    await db.run('DELETE FROM payment_transactions WHERE id = ?', [txnId]);
    txnId = null;
    const all = (await call('POST', '/api/desk/waive', reqBody(A, A.expected_amount, 'Organising committee guest, fee waived'), approver)).body;
    const rowA = await db.get('SELECT * FROM registrations WHERE id = ?', [A.id]);
    check('the whole fee waived directly: owes nothing, confirmed at once', all.success && all.confirmed === true && rowA.expected_amount === 0 && rowA.bank_status === 'BANK_VERIFIED', [all, rowA.bank_status]);
    check('...closing the request that was waiting', (await db.get('SELECT status FROM fee_waiver_requests WHERE id = ?', [third.id])).status === 'CLOSED');
    check('...and nothing left to waive', (await call('POST', '/api/desk/waive', reqBody(A, 1, 'Nothing left to waive here'), approver)).status === 409);
    check('every step is in the log', (await db.all(`SELECT action FROM audit_log WHERE action LIKE 'FEE_WAIVE%' AND entity_id IN (?, ?)`, [String(A.id), String(B.id)])).length >= 5);

    console.log('\n== The screens ==');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('the Payment card: Waive fee for the role, Request a waiver for the rest', /deskBtn\(canWaive \? 'Waive fee' : 'Request a waiver', 'deskOpenWaiver\(\)', 'plain'\)/.test(js));
    check('...a request waiting shows with Approve and Decline for the role', /Waiver of ₹\$\{inr\(pendingReq\.amount\)\} asked for/.test(js) && /deskDecideWaiver\(\$\{esc\(pendingReq\.id\)\}, true\)/.test(js));
    check('Front Desk › Waivers, with its badge, and on the Overview', /DESK_SUB_TABS = \['desk', 'attendance', 'meals', 'waivers'\]/.test(js) && /'badge-pending-waivers', 'badge-subtab-waivers'/.test(js) && /show\('ov-q-waivers'/.test(js));
  } finally {
    if (txnId) await db.run('DELETE FROM payment_transactions WHERE id = ?', [txnId]);
    for (const id of madeIds) {
      await db.run('DELETE FROM fee_waiver_requests WHERE registration_id = ?', [id]);
      await db.run('DELETE FROM payment_transactions WHERE registration_id = ?', [id]);
      await db.run('DELETE FROM registrations WHERE id = ?', [id]);
    }
    await db.run("DELETE FROM user_roles WHERE phone_number = ? AND role_key = 'FEE_WAIVER'", [WAIVER]);
    db.close();
  }
  report();
})();
