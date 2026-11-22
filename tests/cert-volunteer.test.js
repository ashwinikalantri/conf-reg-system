// Volunteers' certificate (owner, 22 Nov 2026): a registration in the
// Volunteer category gets the Volunteer certificate ("of Appreciation") in
// place of the delegates' participation certificate, on the same rule --
// checked in at the desk -- and never the delegates' one.
const { call, check, report, adminLogin, appFile, openDb } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-7);

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  let phone = null;
  try {
    const email = `volunteer-${N}@example.test`;
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { salutation: 'Ms', age: '22', gender: 'Female', designation: 'Student', institute: 'Test College', pincode: '442102',
      state: 'Maharashtra', district: 'Wardha', name: `Volunteer Test ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    phone = r.body.user.phone_number;
    await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, registration_number)
      VALUES (?, ?, 'volunteer', 'Volunteer', 'BANK_VERIFIED', ?)`, [phone, `Volunteer Test ${N}`, `VOL${N}`]);
    const me = async () => (await call('GET', '/api/admin/certificates/candidates', null, admin)).body.people.find((p) => p.phone === phone);

    const before = await me();
    check('not checked in: nothing due yet, for the same reason as anyone', before && before.volunteer === true && !before.conference.kind
      && /Not checked in/.test(before.conference.whyNot || ''), before && before.conference);
    await db.run('UPDATE registrations SET checked_in_at = ? WHERE phone_number = ?', [Date.now(), phone]);
    const after = await me();
    check('checked in: the Volunteer certificate is due, not participation', after.conference.kind === 'VOLUNTEER', after.conference);

    const prev = await call('GET', `/api/admin/certificates/person-preview.pdf?phone=${encodeURIComponent(phone)}&cert=VOLUNTEER`, null, admin);
    check('a preview of theirs', prev.status === 200 && (prev.buf || Buffer.from('')).slice(0, 4).toString() === '%PDF', prev.status);
    const spec = await call('GET', '/api/admin/certificates/preview.pdf?kind=VOLUNTEER', null, admin);
    check('...and a specimen, from the settings', (spec.buf || Buffer.from('')).slice(0, 4).toString() === '%PDF');
    check('the delegates\' certificate cannot be forced on a volunteer', (await call('POST', '/api/admin/certificates/force', { phone, cert: 'CONF', reason: 'x' }, admin)).status === 400);

    const iss = await call('POST', '/api/admin/certificates/issue', { scope: 'conference', phones: [phone] }, admin);
    check('issued with the conference certificates', iss.body.success && iss.body.issued.VOLUNTEER === 1 && !iss.body.issued.CONF, iss.body);
    const row = await db.get("SELECT cert_no, kind FROM certificates WHERE phone_number = ? AND revoked_at IS NULL", [phone]);
    check('...numbered V', row && row.kind === 'VOLUNTEER' && /\/V\/\d{4}$/.test(row.cert_no), row);
    const again = await me();
    check('...counted as their conference certificate: nothing more due', again.conference.issued && again.conference.issued.kind === 'VOLUNTEER');
    const mine = await db.get("SELECT COUNT(*) AS n FROM certificates WHERE phone_number = ? AND kind IN ('CONF', 'MMC', 'NURSING')", [phone]);
    check('...and never the delegates\' one as well', mine.n === 0);

    const src = fs.readFileSync(appFile('server.js'), 'utf8');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('its own wording: a Certificate of Appreciation, editable in Certificate settings', /VOLUNTEER: \{\n\s*title: 'Certificate', subtitle: 'of Appreciation'/.test(src)
      && /\['Conference', \['MMC', 'NURSING', 'CONF', 'VOLUNTEER'\]\]/.test(js));
    check('Ready to issue counts it with the conference ones', /Volunteer \$\{confDue\('VOLUNTEER'\)\}/.test(js));
  } finally {
    if (phone) {
      await db.run('DELETE FROM certificates WHERE phone_number = ?', [phone]);
      await db.run('DELETE FROM registrations WHERE phone_number = ?', [phone]);
    }
    db.close();
  }
  report();
})();
