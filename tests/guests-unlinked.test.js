// Faculty who have not signed up: added by name, linked to their account later.
//
//   * A coordinator adds a guest with a name (required) and, optionally,
//     designation, phone and email -- kept as typed.
//   * The same person is not entered twice: a typed phone/email that belongs
//     to an account is turned back with that account to mark instead; one
//     already typed in for another guest is pointed to; and marking an
//     account whose phone a typed-in guest already has is refused too.
//   * Who they are is edited only until they are linked; once linked, the
//     account supplies it.
//   * Linking: suggested when an account matches, done by a coordinator,
//     once, to an account not already on the list.
const { call, check, report, ADMIN_PW, adminLogin, loginPassword, openDb } = require('./harness');

const N = String(Date.now() % 100000000).padStart(8, '0');
const typedPhone = `+91 77${N}`;          // as a coordinator might type it
const accountPhone = `77${N}`;            // the same number, as an account key
const P = { tc: `86${N}`, existing: `87${N}` };

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const signIn = async (phone) => {
    const r = await call('POST', `/api/users/${phone}/reset-password`, {}, admin);
    const l = await call('POST', '/api/auth/login-password', { identifier: phone, password: r.body.tempPassword });
    await call('POST', '/api/auth/set-password', { password: `own-${N}-pw` }, l.cookie);
    return l.cookie;
  };
  const add = (guest, c) => call('POST', '/api/guests', { guest }, c);
  const board = async (c) => (await call('GET', '/api/guests', null, c)).body;
  const made = [];

  try {
    await call('POST', '/api/users', { phone: P.tc, name: 'Tara Transport', email: `gu-${P.tc}@example.test`, role: 'TRANSPORT_COORDINATOR' }, admin);
    await call('POST', '/api/users', { phone: P.existing, name: 'Esha Existing', email: `esha-${N}@example.test`, role: 'DELEGATE' }, admin);
    const tc = await signIn(P.tc);

    console.log('\n== Adding someone without an account ==');
    check('a name is required', (await add({ designation: 'Professor' }, tc)).status === 400);
    check('a phone that is not one is refused', (await add({ name: 'X', phone: 'ask reception' }, tc)).status === 400);
    const a = await add({ name: 'Nalini New', designation: 'Professor of Medicine', phone: typedPhone, email: `nalini-${N}@example.test` }, tc);
    check('a coordinator adds them', a.body.success === true && a.body.linked === false, a.body);
    made.push(a.body.id);
    const b1 = await board(tc);
    const g = b1.guests.find((x) => x.id === a.body.id);
    check('they are listed by the name typed in', g.name === 'Nalini New' && g.designation === 'Professor of Medicine');
    check('...with the phone exactly as typed', g.phone === typedPhone, g.phone);
    check('...flagged as not signed up', g.flags.notSignedUp === true && g.linked === false);
    check('...and as Invited, like anyone marked', g.overall_status === 'Invited');
    check('no account matches yet', g.possible_account === null);
    check('the front desk cannot add one', (await add({ name: 'Y' }, await loginPassword('9000000006', ADMIN_PW))).status === 403);

    console.log('\n== Not twice ==');
    const twice = await add({ name: 'Nalini N.', phone: `0${accountPhone}` }, tc);
    check('the same phone, typed differently, is pointed to the guest already listed', twice.status === 409 && twice.body.code === 'GUEST_EXISTS' && twice.body.guestId === a.body.id, twice.body);
    const viaEmail = await add({ name: 'Nalini', email: `NALINI-${N}@example.test` }, tc);
    check('...so is the same email', viaEmail.status === 409 && viaEmail.body.code === 'GUEST_EXISTS');
    const hasAccount = await add({ name: 'Esha', email: `esha-${N}@example.test` }, tc);
    check('someone who has an account is turned back, with the account to mark instead',
      hasAccount.status === 409 && hasAccount.body.code === 'ACCOUNT_EXISTS' && hasAccount.body.account.phone_number === P.existing && hasAccount.body.account.guestId === null, hasAccount.body);

    console.log('\n== Editing who they are ==');
    check('their details can be corrected', (await call('PUT', `/api/guests/${a.body.id}`, { fields: { guest_designation: 'Professor & Head' } }, tc)).body.success === true);
    check('...but the name cannot be emptied', (await call('PUT', `/api/guests/${a.body.id}`, { fields: { guest_name: ' ' } }, tc)).status === 400);
    check('travel works as for anyone', (await call('PUT', `/api/guests/${a.body.id}`, { fields: { arrival_date: '2026-11-20' } }, tc)).body.success === true);

    console.log('\n== They sign up; the account is suggested ==');
    await call('POST', '/api/users', { phone: accountPhone, name: 'Nalini Newcomer', email: `nalini.s-${N}@example.test`, role: 'DELEGATE' }, admin);
    const b2 = await board(tc);
    const g2 = b2.guests.find((x) => x.id === a.body.id);
    check('the account with their phone is offered', g2.possible_account && g2.possible_account.phone_number === accountPhone && g2.possible_account.taken === false, g2.possible_account);
    check('...but not linked by itself', g2.linked === false);
    const markInstead = await call('POST', '/api/guests', { phone: accountPhone }, tc);
    check('marking that account as faculty is refused: they are already listed, to be linked', markInstead.status === 409 && markInstead.body.code === 'GUEST_EXISTS' && markInstead.body.guestId === a.body.id, markInstead.body);

    console.log('\n== Linking ==');
    check('the front desk cannot link', (await call('PUT', `/api/guests/${a.body.id}/link`, { phone: accountPhone }, await loginPassword('9000000006', ADMIN_PW))).status === 403);
    check('staff accounts cannot be linked', (await call('PUT', `/api/guests/${a.body.id}/link`, { phone: P.tc }, tc)).status === 404);
    const linked = await call('PUT', `/api/guests/${a.body.id}/link`, { phone: accountPhone }, tc);
    check('a coordinator links them', linked.body.success === true && linked.body.registered === false, linked.body);
    const g3 = (await board(tc)).guests.find((x) => x.id === a.body.id);
    check('the account now says who they are', g3.linked === true && g3.name === 'Nalini Newcomer' && g3.flags.notSignedUp === false, g3.name);
    check('...still not registered, so still flagged for that', g3.flags.notRegistered === true);
    check('...their travel is untouched', g3.arrival_date === '2026-11-20');
    check('...and what was typed in is kept on the row', (await db.get('SELECT guest_name FROM guests WHERE id = ?', [a.body.id])).guest_name === 'Nalini New');
    check('who they are can no longer be edited here', (await call('PUT', `/api/guests/${a.body.id}`, { fields: { guest_name: 'Someone Else' } }, tc)).status === 400);
    check('linking twice is refused', (await call('PUT', `/api/guests/${a.body.id}/link`, { phone: P.existing }, tc)).status === 409);
    const other = await add({ name: 'Second Person' }, tc);
    made.push(other.body.id);
    check('an account already on the list cannot be linked to another guest', (await call('PUT', `/api/guests/${other.body.id}/link`, { phone: accountPhone }, tc)).status === 409);
    check('the link is in the activity log', !!(await db.get("SELECT 1 FROM audit_log WHERE action = 'GUEST_LINKED' AND entity_id = ?", [String(a.body.id)])));
    const desk = (await call('GET', `/api/desk/delegate/${accountPhone}`, null, admin)).body;
    check('the Front Desk now shows them as faculty', desk.guest && desk.guest.id === a.body.id);
  } finally {
    for (const id of made) await db.run('DELETE FROM guests WHERE id = ?', [id]);
    await db.run('DELETE FROM users WHERE phone_number IN (?, ?, ?)', [P.tc, P.existing, accountPhone]);
  }
  db.close();
  report();
})();
