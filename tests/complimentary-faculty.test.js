// Registering faculty free, from the admin panel.
//
// The owner's decisions (2026-10-30): only someone on the Faculty list; in
// their own category, with the fee waived; one person at a time, from the
// Faculty tab -- not every faculty member is complimentary, so nobody is
// registered free by any bulk step. Those who already paid are left alone.
// What must hold:
//
//   * POST /api/admin/registrations/complimentary needs payments.complimentary
//     (Super Admin only, to begin with); the front desk, which registers
//     walk-ins, cannot reach it;
//   * it refuses anyone not on the Faculty list, a cancelled one, someone
//     already registered, and an account already on the list as someone else;
//   * the registration is confirmed at once: expected and paid ₹0, the
//     whole fee -- category and workshops -- as the discount, recorded as
//     COMPLIMENTARY, no ledger row, and the conference's money unchanged;
//   * a faculty member not signed up gets an account, linked to their entry;
//   * the Faculty tab says who is complimentary; the audit names it.
const { call, check, report, appFile, adminLogin, loginPassword, ADMIN_PW, openDb } = require('./harness');
const fs = require('fs');

const N = String(Date.now() % 100000000).padStart(8, '0');
const phones = { linked: `76${N}`, fresh: `75${N}`, other: `74${N}` };

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const made = { guests: [], phones: Object.values(phones) };
  try {
    const fees = (await call('GET', '/api/fees', null, admin)).body.categories || [];
    const cat = fees.find((c) => !c.requiresStudentId && Number(c.fee) > 0);
    check('fixture: a paid category without a student ID', !!cat, fees.map((c) => c.key));
    const money = async () => (await call('GET', '/api/admin/finance-summary', null, admin)).body;
    const before = await money();

    // A faculty member with an account, one not signed up, and a delegate
    // who is not on the Faculty list at all.
    await call('POST', '/api/users', { phone: phones.linked, name: `Comp Linked ${N}`, email: `comp-linked-${N}@example.test`, role: 'DELEGATE' }, admin);
    await call('POST', '/api/users', { phone: phones.other, name: `Comp Other ${N}`, email: `comp-other-${N}@example.test`, role: 'DELEGATE' }, admin);
    const linked = (await call('POST', '/api/guests', { phone: phones.linked }, admin)).body;
    const fresh = (await call('POST', '/api/guests', { guest: { name: `Comp Fresh ${N}`, phone: phones.fresh, email: `comp-fresh-${N}@example.test`, designation: 'Professor' } }, admin)).body;
    made.guests.push(linked.id, fresh.id);
    check('fixture: two faculty, one linked and one not signed up', linked.success && fresh.success && fresh.linked === false, [linked, fresh]);

    const comp = (body, cookie = admin) => call('POST', '/api/admin/registrations/complimentary', { categoryKey: cat.key, optionIds: [], ...body }, cookie);

    console.log('\n== Who may, and for whom ==');
    const desk = await loginPassword('9000000006', ADMIN_PW);
    check('the front desk cannot register anyone free', [401, 403].includes((await comp({ guestId: linked.id }, desk)).status));
    check('someone not on the Faculty list is refused', (await comp({ accountKey: phones.other })).status === 400);
    await db.run("UPDATE guests SET overall_status = 'Cancelled' WHERE id = ?", [linked.id]);
    check('a cancelled faculty member is refused', (await comp({ guestId: linked.id })).status === 409);
    await db.run("UPDATE guests SET overall_status = 'Invited' WHERE id = ?", [linked.id]);
    const elsewhere = await comp({ guestId: fresh.id, accountKey: phones.linked });
    check('an account on the list as someone else is not linked to another entry', elsewhere.status === 409, elsewhere.body);

    console.log('\n== A linked faculty member, registered free ==');
    const r1 = await comp({ guestId: linked.id, accountKey: phones.other, discountCode: 'ANY', paymentMode: 'CASH', amount: 999 });
    check('registered and confirmed', r1.body.success === true && r1.body.bankStatus === 'BANK_VERIFIED', r1.body);
    check('...nothing due, nothing paid, the fee waived', r1.body.expectedAmount === 0 && r1.body.paidAmount === 0 && r1.body.waivedAmount === Number(cat.fee), r1.body);
    const reg = await db.get('SELECT * FROM registrations WHERE id = ?', [r1.body.registrationId]);
    check('on their own account, whatever else was sent', reg.phone_number === phones.linked);
    check('in the category chosen', reg.category_key === cat.key);
    check('recorded as complimentary', reg.payment_mode === 'COMPLIMENTARY' && reg.discount_code === 'COMPLIMENTARY' && reg.discount_amount === Number(cat.fee), reg);
    check('with a registration number', !!reg.registration_number);
    const txns = await db.get('SELECT COUNT(*) AS n FROM payment_transactions WHERE registration_id = ?', [reg.id]);
    check('no ledger row: there is no money to reconcile', txns.n === 0, txns.n);
    const audit = await db.get("SELECT action, new_value FROM audit_log WHERE entity_type = 'registration' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(reg.id)]);
    check('the activity log says complimentary, and how much was waived', audit && audit.action === 'COMPLIMENTARY_REGISTERED' && /complimentary \(faculty\)/.test(audit.new_value), audit);
    check('registering them again is refused', (await comp({ guestId: linked.id })).status === 409);

    console.log('\n== A faculty member not signed up ==');
    const r2 = await comp({ guestId: fresh.id, phone: phones.fresh, name: `Comp Fresh ${N}`, email: `comp-fresh-${N}@example.test` });
    check('registered, with an account made for them', r2.body.success === true && !!r2.body.tempPassword, r2.body);
    const g2 = await db.get('SELECT phone_number FROM guests WHERE id = ?', [fresh.id]);
    check('...and their faculty entry linked to it', g2.phone_number === phones.fresh, g2);

    console.log('\n== What the rest of the app sees ==');
    const after = await money();
    check('the conference\'s money is unchanged', JSON.stringify(before) === JSON.stringify(after), [before, after]);
    const board = (await call('GET', '/api/guests', null, admin)).body;
    const row = board.guests.find((g) => g.id === linked.id);
    check('the Faculty tab marks them registered and complimentary', row && Number(row.registered) === 1 && Number(row.complimentary) === 1, row && [row.registered, row.complimentary]);

    console.log('\n== The screens ==');
    const js = fs.readFileSync(appFile('public/app.js'), 'utf8');
    const src = fs.readFileSync(appFile('server.js'), 'utf8');
    const page = (await call('GET', '/admin', null, admin)).raw || '';
    check('the Register form has a Complimentary option and the faculty panel', /id="rd-mode-comp-btn"/.test(page) && /id="rd-faculty"/.test(page) && /id="rd-mode-comp"/.test(page));
    check('...offered only when opened on a faculty member, to a holder of the permission',
      /rdFaculty && can\('payments\.complimentary'\)/.test(js) && /function registerFacultyFree\(/.test(js));
    check('the faculty editor offers "Register free" to an unregistered faculty member', /!g\.registered && !g\.cancelled && can\('payments\.complimentary'\)/.test(js));
    check('receipts call the discount complimentary', /'COMPLIMENTARY' \? 'Complimentary \(faculty\)'/.test(src));
    check('nothing registers faculty in bulk', !/registrations\/complimentary\/bulk|registerAllFaculty/.test(js + src));
  } finally {
    for (const p of made.phones) {
      const regs = await db.all('SELECT id FROM registrations WHERE phone_number = ?', [p]);
      for (const r of regs) {
        await db.run('DELETE FROM registration_options WHERE registration_id = ?', [r.id]);
        await db.run("DELETE FROM audit_log WHERE entity_type = 'registration' AND entity_id = ?", [String(r.id)]);
      }
      await db.run('DELETE FROM registrations WHERE phone_number = ?', [p]);
      await db.run('DELETE FROM user_roles WHERE phone_number = ?', [p]);
      await db.run('DELETE FROM users WHERE phone_number = ?', [p]);
    }
    for (const id of made.guests.filter(Boolean)) {
      await db.run("DELETE FROM audit_log WHERE entity_type = 'guest' AND entity_id = ?", [String(id)]);
      await db.run('DELETE FROM guests WHERE id = ?', [id]);
    }
  }
  const left = await db.get('SELECT COUNT(*) AS n FROM registrations WHERE phone_number IN (?, ?, ?)', made.phones);
  check('nothing this file made is left in the fixture', left.n === 0, left.n);
  db.close();
  report();
})();
