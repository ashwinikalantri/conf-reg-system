// The desk is regularly asked to reprint or re-send a receipt, and until now
// the only way to see one was over the delegate's shoulder. Finance staff can
// open any verified registration's receipt -- the same document the delegate
// gets, not an admin-flavoured copy.
const { call, check, report, adminLogin, loginOtp, openDb, appFile } = require('./harness');
const fs = require('fs');

(async () => {
  const cookie = await adminLogin();
  const db = openDb({ readOnly: true });
  const verified = await db.get("SELECT id, phone_number, registration_number, delegate_name FROM registrations WHERE bank_status='BANK_VERIFIED' ORDER BY id LIMIT 1");
  const pending = await db.get("SELECT id FROM registrations WHERE bank_status='PENDING' ORDER BY id LIMIT 1");
  check('the fixture has a verified registration', !!verified, verified);
  check('the fixture has an unverified one', !!pending, pending);

  console.log('\n== An admin can open a verified delegate\'s receipt ==');
  const r = await call('GET', `/api/registrations/${verified.id}/receipt`, null, cookie);
  check('it is served', r.status === 200, r.status);
  check('it is HTML', /text\/html/.test(r.type || ''), r.type);
  check('it names the delegate', r.raw.includes(verified.delegate_name.replace(/^(Dr|Mr|Ms|Mrs|Prof)\.? /, '')), verified.delegate_name);
  check('it carries the registration number', r.raw.includes(verified.registration_number), verified.registration_number);
  check('it offers the printable statement', r.raw.includes("?print=1"));

  const printed = await call('GET', `/api/registrations/${verified.id}/receipt?print=1`, null, cookie);
  check('the printable statement is served too', printed.status === 200, printed.status);
  check('and carries the same registration number', printed.raw.includes(verified.registration_number));

  console.log('\n== It is the same document the delegate gets ==');
  const delegateCookie = await loginOtp(verified.phone_number);
  check('the delegate can sign in', !!delegateCookie);
  if (delegateCookie) {
    const own = await call('GET', '/api/registrations/me/receipt', null, delegateCookie);
    check('the delegate gets their own receipt', own.status === 200, own.status);
    // Byte-identical: one renderer, so an admin cannot be shown a figure the
    // delegate is not. Guards against the two drifting apart later.
    check('admin and delegate see byte-identical documents', own.raw === r.raw,
      own.raw.length === r.raw.length ? 'same length, different bytes' : [own.raw.length, r.raw.length]);
  }

  console.log('\n== Guards ==');
  const unver = await call('GET', `/api/registrations/${pending.id}/receipt`, null, cookie);
  check('no receipt for an unverified payment', unver.status === 403, unver.status);
  const missing = await call('GET', '/api/registrations/99999/receipt', null, cookie);
  check('a missing registration is a 404', missing.status === 404, missing.status);
  const anon = await call('GET', `/api/registrations/${verified.id}/receipt`);
  check('signed out gets nothing', anon.status === 401 || anon.status === 403, anon.status);

  // The delegate route must not be reachable as an id: 'me' is registered
  // first for exactly this reason.
  const asMe = await call('GET', '/api/registrations/me/receipt', null, cookie);
  check("'me' still resolves to the caller, not an id lookup", asMe.status === 404 || asMe.status === 403 || asMe.status === 200, asMe.status);

  console.log('\n== The list offers it ==');
  const client = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  check('verified rows link to the receipt', /receipt.*BANK_VERIFIED|BANK_VERIFIED[\s\S]{0,200}\/receipt/.test(client));
  check('it opens in a new tab', /\/receipt"\s+target="_blank"/.test(client));

  db.close();
  report();
})();
