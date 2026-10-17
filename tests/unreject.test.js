// Un-rejecting a registration.
//
// The mirror of un-approve: a rejected registration goes back to pending
// review. What it must get right:
//
//   * Super Admin only -- the same key as un-approve (payments.unapprove),
//     not payments.decide, so the Finance Admin who rejects cannot quietly
//     un-reject;
//   * no email: the delegate is not told;
//   * the payments that one rejection turned down go back to pending -- and
//     only those: an older rejection stays rejected;
//   * the rejection reason is cleared, the registration number kept;
//   * with no payment to review it goes to what the money says -- a balance
//     still due -- rather than to a pending review of nothing;
//   * it is in the activity log, and only a rejected registration qualifies.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');

const stamp = Date.now();
const N = String(stamp % 100000000).padStart(8, '0');

(async () => {
  const admin = await adminLogin();
  const finance = await loginPassword('9000000002', ADMIN_PW);   // FINANCE_ADMIN
  const desk = await loginPassword('9000000006', ADMIN_PW);      // FRONT_DESK
  const db = openDb();
  const cat = await db.get('SELECT category_key, label FROM fee_categories WHERE active = 1 ORDER BY sort_order, id LIMIT 1');
  const made = [];

  const mkReg = async (suffix, status = 'PENDING', expected = 1000) => {
    const phone = `9${suffix}${N}`.slice(0, 10);
    const r = await db.run(
      `INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, expected_amount, paid_amount,
         utr_number, bank_status, submitted_at, registration_number)
       VALUES (?, 'Unreject Fixture', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [phone, cat.category_key, cat.label, expected, expected, `UR${suffix}${N}`, status, stamp, `UNREJ${suffix}${N}`]);
    made.push(r.lastID);
    return { id: r.lastID, phone };
  };
  const mkTxn = (reg, txnStatus, extra = {}) => db.run(
    `INSERT INTO payment_transactions (registration_id, phone_number, amount, verified_amount, utr_number, payment_mode,
       txn_status, submitted_at, reviewed_by, reviewed_at, rejection_reason)
     VALUES (?, ?, ?, ?, ?, 'UPI', ?, ?, ?, ?, ?)`,
    [reg.id, reg.phone, extra.amount || 1000, txnStatus === 'VERIFIED' ? (extra.amount || 1000) : null,
      `T${Math.random().toString().slice(2, 12)}`, txnStatus, stamp, extra.reviewedBy || null, extra.reviewedAt || null, extra.reason || null]);
  const regRow = (id) => db.get('SELECT bank_status, rejection_reason, rejection_note, registration_number FROM registrations WHERE id = ?', [id]);
  const unreject = (id, cookie = admin) => call('PUT', `/api/registrations/${id}/unreject`, {}, cookie);

  try {
    console.log('\n== A rejected registration goes back to pending ==');
    const a = await mkReg('1');
    await mkTxn(a, 'PENDING');
    const rej = await call('PUT', `/api/registrations/${a.id}/status`, { bankStatus: 'REJECTED', rejectionReason: 'OTHER', rejectionNote: 'Fixture rejection' }, finance);
    check('fixture: finance rejects it', rej.body.success === true, rej.body);
    check('fixture: it is rejected, with its reason', (await regRow(a.id)).bank_status === 'REJECTED' && (await regRow(a.id)).rejection_reason === 'OTHER');

    console.log('\n== Super Admin only ==');
    check('finance, who rejected it, cannot un-reject', (await unreject(a.id, finance)).status === 403);
    check('nor the front desk', (await unreject(a.id, desk)).status === 403);
    check('nor anyone signed out', (await unreject(a.id, null)).status === 401);
    check('still rejected after those', (await regRow(a.id)).bank_status === 'REJECTED');

    const done = await unreject(a.id);
    check('a Super Admin can', done.body.success === true, done.body);
    check('...it is pending review again', done.body.status === 'PENDING' && (await regRow(a.id)).bank_status === 'PENDING', done.body);
    const after = await regRow(a.id);
    check('the rejection reason and note are cleared', after.rejection_reason === null && after.rejection_note === null, after);
    check('the registration number is kept', after.registration_number === `UNREJ1${N}`, after.registration_number);
    const txns = await db.all('SELECT txn_status, rejection_reason, reviewed_by, reviewed_at FROM payment_transactions WHERE registration_id = ?', [a.id]);
    check('its payment is back to pending, unreviewed', txns.length === 1 && txns[0].txn_status === 'PENDING'
      && txns[0].rejection_reason === null && txns[0].reviewed_by === null && txns[0].reviewed_at === null, txns);
    check('...and the response says one payment was restored', done.body.paymentsRestored === 1, done.body);
    const log = await db.get(
      "SELECT old_value, new_value, actor_role FROM audit_log WHERE entity_type = 'registration' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(a.id)]);
    check('it is in the activity log, credited to the Super Admin',
      log && log.old_value === 'REJECTED (OTHER)' && log.new_value === 'PENDING (un-rejected)' && log.actor_role === 'SUPER_ADMIN', log);
    const again = await unreject(a.id);
    check('a registration that is not rejected cannot be un-rejected', again.status === 400, [again.status, again.body.error]);
    check('nor one that does not exist', (await unreject(99999999)).status === 404);

    console.log('\n== Only the latest rejection is undone ==');
    const b = await mkReg('2');
    await mkTxn(b, 'REJECTED', { reviewedAt: stamp - 86400000, reviewedBy: 'Earlier', reason: 'WRONG_SCREENSHOT' });
    await mkTxn(b, 'REJECTED', { reviewedAt: stamp, reviewedBy: 'Latest', reason: 'WRONG_DETAILS' });
    await db.run("UPDATE registrations SET bank_status = 'REJECTED', rejection_reason = 'WRONG_DETAILS' WHERE id = ?", [b.id]);
    const bDone = await unreject(b.id);
    check('it succeeds', bDone.body.success === true && bDone.body.paymentsRestored === 1, bDone.body);
    const bTxns = await db.all('SELECT txn_status, rejection_reason FROM payment_transactions WHERE registration_id = ? ORDER BY id', [b.id]);
    check('the payment the latest rejection turned down is pending again', bTxns[1].txn_status === 'PENDING', bTxns);
    check('...and the older rejection stays rejected', bTxns[0].txn_status === 'REJECTED' && bTxns[0].rejection_reason === 'WRONG_SCREENSHOT', bTxns);

    console.log('\n== With nothing to review, it follows the money ==');
    const c = await mkReg('3', 'REJECTED');
    await mkTxn(c, 'VERIFIED', { amount: 400 });
    await db.run("UPDATE registrations SET rejection_reason = 'WRONG_CATEGORY' WHERE id = ?", [c.id]);
    const cDone = await unreject(c.id);
    check('part paid, nothing pending: back to awaiting its balance', cDone.body.status === 'PARTIAL_PAYMENT'
      && (await regRow(c.id)).bank_status === 'PARTIAL_PAYMENT', cDone.body);
    check('the payment already accepted is untouched',
      (await db.get('SELECT txn_status FROM payment_transactions WHERE registration_id = ?', [c.id])).txn_status === 'VERIFIED');

    console.log('\n== No email ==');
    const src = fs.readFileSync(appFile('server.js'), 'utf8');
    const i = src.indexOf("app.put('/api/registrations/:id/unreject'");
    const route = src.slice(i, src.indexOf('\n});', i));
    check('the route sends nothing', i > 0 && !/notifyDelegate\(|sendEmail\(/.test(route));
    check('...and is guarded by the un-approve key', /requirePermission\('payments\.unapprove'\)/.test(route.split('\n')[0]));
    const perms = require('../permissions');
    check('which no built-in role but Super Admin holds',
      ['FINANCE_ADMIN', 'ACADEMIC_REVIEWER', 'FINANCE_ACADEMIC', 'FRONT_DESK', 'OPERATIONS'].every((r) => !perms.roleCan(r, 'payments.unapprove')));

    console.log('\n== The review window offers it ==');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    const ejs = fs.readFileSync(appFile('views', 'admin', 'modals', 'review.ejs'), 'utf8');
    check('an Un-reject button, hidden until it applies', /id="review-unreject-btn" onclick="reviewUnreject\(\)" class="hidden /.test(ejs));
    check('...shown only for a rejected registration, to a Super Admin',
      /unrejectBtn\.classList\.toggle\('hidden', !\(can\('payments\.unapprove'\) && p\.bank_status === 'REJECTED'\)\)/.test(js));
    check('...which asks first, and says no email is sent',
      /async function reviewUnreject\(\) \{\n\s*if \(!\(await showConfirm\('[^']*The delegate is not emailed\.'\)\)\) return;/.test(js));
  } finally {
    for (const id of made) {
      await db.run('DELETE FROM payment_transactions WHERE registration_id = ?', [id]);
      await db.run('DELETE FROM registrations WHERE id = ?', [id]);
    }
  }
  db.close();
  report();
})();
