// Certificates by email (owner, 21 Nov 2026): after Issue, Send or Cancel;
// Send emails each person their certificates as PDFs, once; a failure can
// be retried; a corrected one re-sent once, by a super admin; downloads
// stay in the portal.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-7);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const db = openDb();
  let phone = null;
  try {
    const email = `mail-${N}@example.test`;
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { salutation: 'Dr', age: '40', gender: 'Female', designation: 'Professor', institute: 'Test College', pincode: '442102',
      state: 'Maharashtra', district: 'Wardha', name: `Mail Test ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    phone = r.body.user.phone_number;
    await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, registration_number, checked_in_at)
      VALUES (?, ?, 'chw', 'Frontline Health Worker', 'BANK_VERIFIED', ?, ?)`, [phone, `Mail Test ${N}`, `MAIL${N}`, Date.now()]);

    const issued = await call('POST', '/api/admin/certificates/issue', { scope: 'conference', phones: [phone] }, admin);
    check('issuing says what was issued now, for the Send or Cancel', issued.body.success && issued.body.total === 1 && issued.body.ids.length === 1, issued.body);
    const id = issued.body.ids[0];
    const row = () => db.get('SELECT * FROM certificates WHERE id = ?', [id]);
    check('...not emailed until Send', !(await row()).email_status);

    check('Send needs which certificates', (await call('POST', '/api/admin/certificates/email', {}, admin)).status === 400);
    check('...and those who may issue', (await call('POST', '/api/admin/certificates/email', { ids: [id] }, desk)).status === 403);
    const sent = await call('POST', '/api/admin/certificates/email', { ids: [id] }, admin);
    check('Send queues it', sent.body.success && sent.body.queued === 1);
    let c;
    for (let i = 0; i < 30; i++) { c = await row(); if (c.email_status !== 'QUEUED') break; await wait(200); }
    check('...the sender takes it; with email off here it fails, saying why, to retry', c.email_status === 'FAILED' && /switched off|address/i.test(c.email_error || ''), c);
    const st = (await call('GET', '/api/admin/certificates/email-status', null, admin)).body;
    check('progress: the failed listed', st.success && st.failedList.some((f) => f.id === id));
    check('Email them (all) takes the failed again', (await call('POST', '/api/admin/certificates/email', { all: true }, admin)).body.queued >= 1);
    for (let i = 0; i < 30; i++) { c = await row(); if (c.email_status !== 'QUEUED') break; await wait(200); }

    // As if it had gone: never again.
    // Emailed after every change made so far, here and by the tests before
    // this one: nothing on it is corrected yet.
    await db.run("UPDATE certificates SET email_status = 'SENT', emailed_at = ?, emailed_to = ?, email_error = NULL WHERE id = ?", [Date.now(), email, id]);
    await wait(20);
    check('once emailed, never queued again', (await call('POST', '/api/admin/certificates/email', { ids: [id] }, admin)).body.queued === 0
      && (await row()).email_status === 'SENT');
    check('...nor on the "Certificate issued" reminder list', !((await call('GET', '/api/admin/reminders/audiences/certificates/recipients', null, admin)).body.recipients || []).some((x) => x.id === phone));
    const mine = (await call('GET', '/api/certificates/mine', null, r.cookie)).body.certificates;
    check('the portal: still to download, saying when it was emailed', mine.length === 1 && mine[0].emailed_at > 0);

    // The corrected one, re-sent once, by a super admin.
    check('re-send: not until it is corrected', (await call('POST', `/api/admin/certificates/${id}/resend`, null, admin)).status === 409);
    await call('PUT', `/api/admin/certificates/${id}`, { name: `Dr Mail Test Corrected ${N}` }, admin);
    check('...never by anyone but a super admin', (await call('POST', `/api/admin/certificates/${id}/resend`, null, desk)).status === 403);
    const re = await call('POST', `/api/admin/certificates/${id}/resend`, null, admin);
    check('...corrected: re-sent', re.body.success, re.body);
    for (let i = 0; i < 30; i++) { c = await row(); if (c.email_status !== 'QUEUED') break; await wait(200); }
    check('...a failed re-send leaves it emailed, the first one standing', c.email_status === 'SENT' && c.emailed_at > 0 && !c.resent_at, c);
    await db.run('UPDATE certificates SET resent_at = ? WHERE id = ?', [Date.now(), id]);
    check('...only once', (await call('POST', `/api/admin/certificates/${id}/resend`, null, admin)).status === 409);

    // A signature, the wording or the design changed after it was emailed
    // (22 Nov 2026: a wrong signature on the prize certificates): re-sendable.
    const at = Date.now() + 5000;
    await db.run("UPDATE certificates SET resent_at = NULL, email_status = 'SENT', emailed_at = ?, updated_at = ? WHERE id = ?", [at, at, id]);
    check('re-send: not while nothing has changed since', (await call('POST', `/api/admin/certificates/${id}/resend`, null, admin)).status === 409);
    await db.run(`INSERT INTO audit_log (entity_type, entity_id, action, old_value, new_value, actor_phone, actor_name, actor_role, created_at)
      VALUES ('certificate_signatory', '0', 'SIGNATORY_UPDATED', NULL, 'signature', 'cert-email-test', 'Test', 'SUPER_ADMIN', ?)`, [at + 1000]);
    const cand = (await call('GET', '/api/admin/certificates/candidates', null, admin)).body;
    check('...a signature changed after it was emailed: the page is told when', cand.designChangedAt === at + 1000, cand.designChangedAt);
    const re2 = await call('POST', `/api/admin/certificates/${id}/resend`, null, admin);
    check('...and it can be re-sent as corrected', re2.body.success, re2.body);
    await db.run("DELETE FROM audit_log WHERE actor_phone = 'cert-email-test'");

    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('the page: Send or Cancel after every issue; Email them; Retry; Re-send the corrected one', /await offerCertificateEmails\(data\.ids\);/.test(js) && /'Send', 'Cancel'\);\n  if \(!ok\)/.test(js)
      && /Email them<\/button>/.test(js) && /Re-send the corrected one/.test(js)
      && /Number\(certState\.designChangedAt\) > Number\(c\.emailed_at\)/.test(js));
  } finally {
    if (phone) {
      await db.run('DELETE FROM certificates WHERE phone_number = ?', [phone]);
      await db.run('DELETE FROM registrations WHERE phone_number = ?', [phone]);
    }
  }
  report();
})();
