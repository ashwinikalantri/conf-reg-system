// Force issue (owner, 21 Nov 2026): a super admin -- the role itself --
// issues one certificate to someone who does not qualify, with a reason
// kept on it and in the log; nobody else can.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-7);

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const db = openDb();
  let phone = null;
  try {
    const email = `force-${N}@example.test`;
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { salutation: 'Dr', age: '40', gender: 'Female', designation: 'Professor', institute: 'Test College', pincode: '442102',
      state: 'Maharashtra', district: 'Wardha', name: `Force Test ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    phone = r.body.user.phone_number;
    await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, registration_number)
      VALUES (?, ?, 'chw', 'Frontline Health Worker', 'BANK_VERIFIED', ?)`, [phone, `Force Test ${N}`, `FRC${N}`]);
    const me = async () => (await call('GET', '/api/admin/certificates/candidates', null, admin)).body.people.find((p) => p.phone === phone);
    const before = await me();
    check('not checked in: no conference certificate due', before && !before.conference.kind && /Not checked in/.test(before.conference.whyNot || ''), before && before.conference);
    const cand = (await call('GET', '/api/admin/certificates/candidates', null, admin)).body;
    check('the page is told who may force, and every workshop to offer', cand.superAdmin === true && Array.isArray(cand.workshops));

    // Preview (21 Nov 2026): theirs as it will be issued, marked, nothing stored.
    const prev = await call('GET', `/api/admin/certificates/person-preview.pdf?phone=${encodeURIComponent(phone)}&cert=CONF`, null, admin);
    const pbuf = prev.buf || Buffer.from(prev.raw || '', 'binary');
    check('a preview of the certificate they would get: a PDF, nothing issued', prev.status === 200 && pbuf.slice(0, 4).toString() === '%PDF'
      && !(await db.get('SELECT 1 AS y FROM certificates WHERE phone_number = ?', [phone])), prev.status);
    check('...a workshop\'s too; a certificate that is not one, refused', (await call('GET', `/api/admin/certificates/person-preview.pdf?phone=${encodeURIComponent(phone)}&cert=NOPE`, null, admin)).status === 400);
    check('...each certificate not yet issued has Preview in the person panel', /Not issued yet: see it as it will be issued/.test(fs.readFileSync(appFile('public', 'app.js'), 'utf8'))
      && /id="cert-force-preview"/.test(fs.readFileSync(appFile('views', 'admin', 'sections', 'certificates.ejs'), 'utf8')));
    const noReason = await call('POST', '/api/admin/certificates/force', { phone, cert: 'CONF', reason: ' ' }, admin);
    check('a reason is required', noReason.status === 400 && /reason/i.test(noReason.body.error));
    const other = await call('POST', '/api/admin/certificates/force', { phone, cert: 'CONF', reason: 'Test' }, desk);
    check('anyone but a super admin is refused', other.status === 403, other.status);

    const forced = await call('POST', '/api/admin/certificates/force', { phone, cert: 'CONF', reason: 'Attended; desk missed the check-in' }, admin);
    check('a super admin issues it now, though they do not qualify', forced.body.success && /\/P\/\d{4}$/.test(forced.body.certNo), forced.body);
    const row = await db.get('SELECT * FROM certificates WHERE cert_no = ?', [forced.body.certNo]);
    check('...marked forced, with the reason, and in the log', row && row.forced_reason === 'Attended; desk missed the check-in'
      && !!(await db.get("SELECT 1 AS y FROM audit_log WHERE action = 'CERTIFICATE_FORCED' AND entity_id = ?", [forced.body.certNo])));
    const after = await me();
    check('...the list shows it issued, and forced', after.conference.issued && after.conference.issued.forced_reason === 'Attended; desk missed the check-in');
    const again = await call('POST', '/api/admin/certificates/force', { phone, cert: 'CONF', reason: 'Again' }, admin);
    check('never a second of the same', again.status === 409 && /already/.test(again.body.error));
    const mmc = await call('POST', '/api/admin/certificates/force', { phone, cert: 'MMC', reason: 'x' }, admin);
    check('MMC without a council number: refused, and why', mmc.status !== 200 && !mmc.body.success);

    const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'certificates.ejs'), 'utf8');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('the page: Ready to issue, Not yet and why, People with Open, the person panel and the force dialog', ['id="cert-ready"', 'id="cert-why"', 'id="cert-list"', 'id="cert-person"', 'id="cert-force"', 'id="cert-issue-all"']
      .every((x) => view.includes(x)) && /classList\.toggle\('hidden', !\(certState\.superAdmin && mayIssue\)\)/.test(js));
  } finally {
    if (phone) {
      await db.run('DELETE FROM certificates WHERE phone_number = ?', [phone]);
      await db.run('DELETE FROM registrations WHERE phone_number = ?', [phone]);
    }
  }
  report();
})();
