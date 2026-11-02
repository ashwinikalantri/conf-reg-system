// Conference badge report (2 Nov 2026): Reg No, Name, Designation,
// Institution and the QR code the desks scan. On the page and in the PDF the
// QR is drawn; in the CSV it is the image's web address (for a mail merge or
// a bulk badge design), one column per field.
const { call, adminLogin, loginPassword, ADMIN_PW, check, report, openDb, appFile } = require('./harness');
const fs = require('fs');

(async () => {
  const admin = await adminLogin();
  const db = await openDb();
  const rep = (await call('GET', '/api/admin/reports/badges?format=json', null, admin)).body.report;
  const sec = rep.sections[0];
  check('named Conference Badge', rep.title === 'Conference Badge', rep.title);
  check('Reg No, Name, Designation, Institution, QR Code', JSON.stringify(sec.columns) === JSON.stringify(['Reg No', 'Name', 'Designation', 'Institution', 'QR Code']), sec.columns);
  const confirmed = (await db.all("SELECT registration_number FROM registrations WHERE bank_status = 'BANK_VERIFIED' ORDER BY registration_number")).map((r) => r.registration_number);
  check('confirmed registrations only, as Registered Delegates', JSON.stringify(sec.rows.map((r) => r[0])) === JSON.stringify(confirmed), { got: sec.rows.length, want: confirmed.length });
  const row = sec.rows.find((r) => r[0]);
  check('the QR cell is the address of that Reg No\'s QR image', row && new RegExp(`^https?://[^ ]+/api/qr/${row[0]}\\.png$`).test(row[4]), row && row[4]);
  check('...and the page and PDF are told to draw it', sec.qr && sec.qr.column === 4 && sec.qr.of === 0);
  const img = await call('GET', new URL(row[4]).pathname, null, null);
  check('...an address that answers with the image, no sign-in needed', img.status === 200 && /image\/png/.test(img.headers['content-type'] || ''), img.status);

  const csv = await call('GET', '/api/admin/reports/badges?format=csv', null, admin);
  const lines = csv.raw.split('\r\n');
  check('the CSV: one column per field, the QR address in its own', lines[0] === 'Reg No,Name,Designation,Institution,QR Code' && lines[1].endsWith(`/api/qr/${sec.rows[0][0]}.png`), lines.slice(0, 2));

  const pdf = await call('GET', '/api/admin/reports/badges?format=pdf', null, admin);
  check('the PDF downloads, with the QR images in it', pdf.status === 200 && /application\/pdf/.test(pdf.headers['content-type'] || '')
    && (String(pdf.raw).match(/\/Subtype \/Image/g) || []).length >= Math.min(sec.rows.length, 1), pdf.status);
  const html = await call('GET', '/api/admin/reports/badges', null, admin);
  check('the printable page draws the QR, not its address as text', /<img src="https?:\/\/[^"]+\/api\/qr\/[^"]+\.png" alt="QR code"/.test(html.raw));

  const desk = await loginPassword('9000000006', ADMIN_PW);
  const deskRes = await call('GET', '/api/admin/reports/badges?format=json', null, desk);
  check('it needs the Registered Delegates permission', deskRes.status === 403, deskRes.status);

  const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'reports.ejs'), 'utf8');
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  check('listed under People, after Registered delegates', view.indexOf('id="report-delegates"') < view.indexOf('id="report-badges"')
    && view.indexOf('id="report-badges"') < view.indexOf('id="report-delegate-programs"') && /<b>Conference badge<\/b>/.test(view));
  check('shown to whoever holds the Registered Delegates report', /'report-badges': 'reports\.delegates'/.test(js));
  db.close();
  report();
})();
