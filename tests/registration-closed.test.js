// Closing registration (owner, 22 Nov 2026: "Close registrations"): a switch
// in Conference setup. Closed, nobody starts a new registration from the
// portal or the website; one already made can still be corrected, and the
// desk still registers people.
const { call, check, report, ADMIN_PW, adminLogin, loginPassword, appFile } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-7);

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  try {
    check('open to begin with', (await call('GET', '/api/conference', null, null)).body.registrationOpen === true);
    check('only Conference setup may close it', (await call('PUT', '/api/admin/registration-open', { open: false }, desk)).status === 403);
    const closed = await call('PUT', '/api/admin/registration-open', { open: false }, admin);
    check('closed', closed.body.success && (await call('GET', '/api/conference', null, null)).body.registrationOpen === false, closed.body);

    const email = `closed-${N}@example.test`;
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { salutation: 'Dr', age: '30', gender: 'Female', designation: 'Doctor', institute: 'Test College', pincode: '442102',
      state: 'Maharashtra', district: 'Wardha', name: `Closed Test ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    const reg = await call('POST', '/api/registrations', { categoryKey: 'chw', optionIds: [], amount: 0, paymentMode: 'UPI' }, r.cookie);
    check('a new registration from the portal is refused, saying so', reg.status === 403 && /has closed/.test(reg.body.error), [reg.status, reg.body.error]);

    const site = (await call('GET', '/website/registration', null, null)).raw || '';
    check('the website: no Register now, no Register in the header, and no message', !/Register now/.test(site) && !/class="btn btn-navy register"/.test(site) && !/has closed/.test(site));

    const open = await call('PUT', '/api/admin/registration-open', { open: true }, admin);
    check('opened again: as before', open.body.success && /Register now/.test((await call('GET', '/website/registration', null, null)).raw || ''));

    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    const ejs = fs.readFileSync(appFile('views', 'admin', 'sections', 'general.ejs'), 'utf8');
    check('the portal hides its registration card, and the switch is in Conference setup', /const closed = !reg && conferenceInfo\.registrationOpen === false;/.test(js) && /regCard\.classList\.toggle\('hidden', closed\)/.test(js)
      && /id="gs-reg-open" type="checkbox"/.test(ejs));
  } finally {
    await call('PUT', '/api/admin/registration-open', { open: true }, admin);
  }
  report();
})();
