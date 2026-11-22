// Certificates on the Front Desk (owner, 22 Nov 2026): the person's
// certificates in their desk record -- each issued one to download, the rest
// due, or not yet and why -- and the download open to the desk.
const { call, check, report, ADMIN_PW, adminLogin, loginPassword, appFile, openDb } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-7);

(async () => {
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const db = openDb();
  let phone = null;
  try {
    const email = `deskcert-${N}@example.test`;
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { salutation: 'Mr', age: '30', gender: 'Male', designation: 'Health worker', institute: 'Test College', pincode: '442102',
      state: 'Maharashtra', district: 'Wardha', name: `Desk Cert ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    phone = r.body.user.phone_number;
    await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, registration_number)
      VALUES (?, ?, 'chw', 'Frontline Health Worker', 'BANK_VERIFIED', ?)`, [phone, `Desk Cert ${N}`, `DSK${N}`]);
    const record = async () => (await call('GET', `/api/desk/delegate/${encodeURIComponent(`DSK${N}`)}`, null, desk)).body;

    const before = await record();
    const conf = (before.certificates || [])[0];
    check('the desk record lists their certificates', before.success && Array.isArray(before.certificates) && !!conf, before.certificates);
    check('...not yet, and why: not checked in', conf && conf.title === 'Conference · Participation' && conf.status === 'not' && /Not checked in/.test(conf.reason), conf);

    await db.run('UPDATE registrations SET checked_in_at = ? WHERE phone_number = ?', [Date.now(), phone]);
    const due = (await record()).certificates[0];
    check('checked in: due, going out with the next issue', due.status === 'due' && !due.reason, due);

    await call('POST', '/api/admin/certificates/issue', { scope: 'conference', phones: [phone] }, admin);
    const issued = (await record()).certificates[0];
    check('issued: its number, to download', issued.status === 'issued' && /\/P\/\d{4}$/.test(issued.certNo) && issued.id > 0, issued);
    const pdf = await call('GET', `/api/desk/certificates/${issued.id}.pdf`, null, desk);
    check('...the desk downloads it', pdf.status === 200 && (pdf.buf || Buffer.from('')).slice(0, 4).toString() === '%PDF', pdf.status);
    check('...not without the desk', (await call('GET', `/api/desk/certificates/${issued.id}.pdf`, null, null)).status >= 400);
    // The Certificates report (22 Nov 2026): every certificate, issued or not.
    const rep = (await call('GET', '/api/admin/reports/certificates?format=json', null, admin)).body.report;
    const every = rep && rep.sections.find((x) => x.name === 'Every certificate');
    const mine = every && every.rows.find((row) => row[0] === `DSK${N}`);
    check('the Certificates report: a row per certificate, with number, issuer and email', !!mine && mine[3] === 'Conference · Participation' && mine[4] === 'Issued'
      && mine[5] === issued.certNo && mine[8] === 'Not emailed', mine);
    const byType = rep.sections.find((x) => x.name === 'By certificate');
    const part = byType && byType.rows.find((row) => row[0] === 'Conference · Participation');
    check('...and the counts by certificate, each row adding up', !!part && part[1] >= 1 && part[5] === part[1] + part[2] + part[3] + part[4], part);
    check('...only for those who see the Certificates page', (await call('GET', '/api/admin/reports/certificates?format=json', null, desk)).status === 403);
    const issuedOnly = (await call('GET', '/api/admin/reports/certificates?format=json&status=issued', null, admin)).body.report;
    const listOnly = issuedOnly.sections[1];
    check('filtered to Issued: only issued ones listed, the counts whole', issuedOnly.title === 'Certificates: Issued' && listOnly.rows.length > 0
      && listOnly.rows.every((row) => /^Issued/.test(row[4])) && JSON.stringify(issuedOnly.sections[0]) === JSON.stringify(byType));
    const notOnly = (await call('GET', '/api/admin/reports/certificates?format=json&status=not', null, admin)).body.report.sections[1];
    check('...to Not yet: only those, each with its reason', notOnly.rows.every((row) => row[4] === 'Not yet' && row[9]));
    check('...an unknown filter lists everything', (await call('GET', '/api/admin/reports/certificates?format=json&status=bogus', null, admin)).body.report.sections[1].rows.length === every.rows.length);
    const partOnly = (await call('GET', `/api/admin/reports/certificates?format=json&certType=${encodeURIComponent('Conference · Participation')}`, null, admin)).body.report;
    check('by type: only that kind listed', partOnly.title === 'Certificates: Conference · Participation' && partOnly.sections[1].rows.length > 0
      && partOnly.sections[1].rows.every((row) => row[3] === 'Conference · Participation'));
    const both = (await call('GET', `/api/admin/reports/certificates?format=json&status=issued&certType=${encodeURIComponent('Conference · Participation')}`, null, admin)).body.report.sections[1];
    check('...type and status together', both.rows.length >= 1 && both.rows.every((row) => row[3] === 'Conference · Participation' && /^Issued/.test(row[4])) && both.rows.some((row) => row[0] === `DSK${N}`));
    check('...an unknown type lists every type', (await call('GET', '/api/admin/reports/certificates?format=json&certType=Nope', null, admin)).body.report.sections[1].rows.length === every.rows.length);
    check('the page: a Certificate type list beside the status chips', /function filterCertReport\(status, certType\)/.test(fs.readFileSync(appFile('public', 'app.js'), 'utf8')));
    const fpdf = await call('GET', '/api/admin/reports/certificates?format=pdf&status=due', null, admin);
    check('...and the PDF follows the filter', fpdf.status === 200 && (fpdf.buf || Buffer.from('')).slice(0, 4).toString() === '%PDF');
    check('the page: All, Issued, Due, Not yet, Excluded chips on this report', /type === 'certificates' \? certReportFilterHtml\(rep, extraQuery\)/.test(fs.readFileSync(appFile('public', 'app.js'), 'utf8')));
    const rpdf = await call('GET', '/api/admin/reports/certificates?format=pdf', null, admin);
    check('...as a PDF and Excel too', rpdf.status === 200 && (rpdf.buf || Buffer.from('')).slice(0, 4).toString() === '%PDF'
      && /Every certificate/.test((await call('GET', '/api/admin/reports/certificates?format=csv', null, admin)).raw || ''));
    await call('POST', `/api/admin/certificates/${issued.id}/revoke`, { reason: 'Test' }, admin);
    check('a withdrawn one is not handed out', (await call('GET', `/api/desk/certificates/${issued.id}.pdf`, null, desk)).status === 404);

    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('the record has a Certificates card, with Download for an issued one', /deskCertificatesCard\(d\.certificates\)/.test(js)
      && /\/api\/desk\/certificates\/\$\{encodeURIComponent\(c\.id\)\}\.pdf/.test(js));
  } finally {
    if (phone) {
      await db.run('DELETE FROM certificates WHERE phone_number = ?', [phone]);
      await db.run('DELETE FROM registrations WHERE phone_number = ?', [phone]);
    }
    db.close();
  }
  report();
})();
