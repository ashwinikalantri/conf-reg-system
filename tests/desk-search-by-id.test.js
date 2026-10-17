// The Front Desk finds anyone by their ID -- registered or not.
//
// Every account is given an ID (users.registration_number) at signup. The
// desk only looked at the registration's own copy, so somebody who had
// signed up but not registered could not be found by the ID on their screen.
// Both ways in -- the lookup and the type-ahead -- now read the account's ID.
const { call, check, report, ADMIN_PW, loginPassword, adminLogin, openDb } = require('./harness');

const N = String(Date.now() % 100000000).padStart(8, '0');
const phone = `95${N}`;

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);   // FRONT_DESK
  const db = openDb();
  try {
    await call('POST', '/api/users', { phone, name: 'Signed Up Only', email: `idsearch-${N}@example.test`, role: 'DELEGATE' }, admin);
    let u = await db.get('SELECT registration_number FROM users WHERE phone_number = ?', [phone]);
    if (!u.registration_number) {
      await db.run('UPDATE users SET registration_number = ? WHERE phone_number = ?', [`IDQ${N}`, phone]);
      u = await db.get('SELECT registration_number FROM users WHERE phone_number = ?', [phone]);
    }
    const id = u.registration_number;
    check('fixture: an account with an ID', !!id, id);
    check('fixture: and no registration',
      (await db.get('SELECT COUNT(*) AS n FROM registrations WHERE phone_number = ?', [phone])).n === 0);

    console.log('\n== The lookup ==');
    const found = (await call('GET', `/api/desk/delegate/${encodeURIComponent(id)}`, null, desk)).body;
    check('the desk finds them by their ID', found.success === true && found.user && found.user.phone_number === phone, found.error || found.user);
    check('...shown as not registered', found.registration === null);
    const lower = (await call('GET', `/api/desk/delegate/${encodeURIComponent(id.toLowerCase())}`, null, desk)).body;
    check('...typed in lower case too', lower.user && lower.user.phone_number === phone);
    const nobody = await call('GET', `/api/desk/delegate/NOSUCHID${N}`, null, desk);
    check('an ID nobody has is still "nobody found", naming ID', nobody.status === 404 && /ID/.test(nobody.body.error), nobody.body.error);

    // A registered delegate is still found by theirs.
    const reg = await db.get(`SELECT r.registration_number, r.phone_number FROM registrations r
                               WHERE COALESCE(r.registration_number, '') != '' LIMIT 1`);
    const regFound = (await call('GET', `/api/desk/delegate/${encodeURIComponent(reg.registration_number)}`, null, desk)).body;
    check('a registered delegate is still found by their ID', regFound.user && regFound.user.phone_number === reg.phone_number);

    console.log('\n== The type-ahead ==');
    // The whole ID, letters and all, so it cannot be matching a phone number
    // instead; and without its last character, as someone still typing.
    const search = async (q) => (await call('GET', `/api/desk/search?q=${encodeURIComponent(q)}`, null, desk)).body.results || [];
    check('fixture: the ID has letters, so no phone number contains it', /[A-Z]/i.test(id), id);
    const typed = await search(id);
    const hit = typed.find((r) => r.phone_number === phone);
    check('their ID finds them', !!hit, typed.map((r) => r.phone_number));
    check('...so does the start of it', (await search(id.slice(0, -1))).some((r) => r.phone_number === phone));
    check('...and the row shows the ID', hit && hit.registration_number === id, hit);
    check('...with no category, being unregistered', hit && !hit.category_label, hit);
  } finally {
    await db.run('DELETE FROM users WHERE phone_number = ?', [phone]);
  }
  db.close();
  report();
})();
