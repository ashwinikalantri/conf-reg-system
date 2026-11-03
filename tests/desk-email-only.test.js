// The Front Desk and an account signed up by email (3 Nov 2026): its account
// key is an internal id (u_...), which is no phone, email, ID or name, so
// picking such a person from the search used to show nothing. A pick now
// goes by the Reg No, and the lookup also takes the key itself.
const fs = require('fs');
const { call, loginPassword, ADMIN_PW, check, report, openDb, appFile } = require('./harness');

(async () => {
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const db = await openDb();
  const u = await db.get("SELECT phone_number, registration_number FROM users WHERE email = 'email.only@example.test'");
  check('fixture: an email-only account with an internal key and a Reg No', u && /^u_/.test(u.phone_number) && !!u.registration_number, u);

  const found = (await call('GET', '/api/desk/search?q=Email%20Onl', null, desk)).body.results;
  const hit = found.find((r) => r.phone_number === u.phone_number);
  check('the search finds them, with their Reg No', hit && hit.registration_number === u.registration_number, found);

  const byReg = await call('GET', `/api/desk/delegate/${encodeURIComponent(hit.registration_number)}`, null, desk);
  check('opening them by Reg No shows their record', byReg.body.success && byReg.body.user && byReg.body.user.email === 'email.only@example.test', byReg.body);
  const byKey = await call('GET', `/api/desk/delegate/${encodeURIComponent(u.phone_number)}`, null, desk);
  check('...and by the account key too (it used to find nobody)', byKey.body.success && byKey.body.user && byKey.body.user.email === 'email.only@example.test', byKey.body);

  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  check('picking a suggestion looks them up by Reg No', /document\.getElementById\('desk-search'\)\.value = picked\.registration_number \|\| picked\.phone_number;/.test(js));
  check('...as does picking from the shortlist', /onclick="deskPick\('\$\{esc\(c\.registration_number \|\| c\.phone_number\)\}'\)"/.test(js));
  db.close();
  report();
})();
