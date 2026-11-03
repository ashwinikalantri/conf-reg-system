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
  // Role (3 Nov 2026): what the badge says -- Delegate, Faculty or Volunteer.
  check('Reg No, Name, Designation, Institution, Role, QR Code', JSON.stringify(sec.columns) === JSON.stringify(['Reg No', 'Name', 'Designation', 'Institution', 'Role', 'QR Code']), sec.columns);
  check('...every role one of the three', sec.rows.every((r) => ['Delegate', 'Faculty', 'Volunteer'].includes(r[4])));
  const confirmed = (await db.all("SELECT registration_number FROM registrations WHERE bank_status = 'BANK_VERIFIED' ORDER BY registration_number")).map((r) => r.registration_number);
  check('confirmed registrations only, as Registered Delegates', JSON.stringify(sec.rows.map((r) => r[0]).sort()) === JSON.stringify(confirmed.sort()), { got: sec.rows.length, want: confirmed.length });
  const row = sec.rows.find((r) => r[0]);
  check('the QR cell is the address of that Reg No\'s QR image', row && new RegExp(`^https?://[^ ]+/api/qr/${row[0]}\\.png$`).test(row[5]), row && row[5]);
  check('...and the page and PDF are told to draw it', sec.qr && sec.qr.column === 5 && sec.qr.of === 0);
  check('...at the conference\'s own address (3 Nov 2026)', sec.rows.every((r) => !r[5] || r[5].startsWith('https://nqocn2026.mgims.ac.in/api/qr/')), row && row[5]);

  // In the order they were confirmed: the last verified payment's day, or
  // the day a free one was made free; the same day, by Reg No.
  const N = Date.now() % 100000;
  const made = [];
  const at = (d) => Date.UTC(2026, 9, d, 6, 0);
  const add = async (no, extra) => {
    const r = await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, expected_amount, paid_amount, registration_number, payment_mode, submitted_at, discount_applied_at)
      VALUES (?, ?, 'doctor', 'Doctor', 'BANK_VERIFIED', ?, ?, ?, ?, ?, ?)`, [`bd${no}${N}`, `Badge ${no}`, extra.fee, extra.fee, `BD${no}${N}`, extra.mode || 'UPI', extra.submitted, extra.applied || null]);
    made.push(r.lastID);
    return r.lastID;
  };
  const txns = [];
  try {
    const late = await add('A', { fee: 2000, submitted: at(1) });          // paid in two parts, the last on 20 Oct
    txns.push((await db.run("INSERT INTO payment_transactions (registration_id, amount, verified_amount, txn_status, submitted_at) VALUES (?, 1000, 1000, 'VERIFIED', ?)", [late, at(2)])).lastID);
    txns.push((await db.run("INSERT INTO payment_transactions (registration_id, amount, verified_amount, txn_status, submitted_at) VALUES (?, 1000, 1000, 'VERIFIED', ?)", [late, at(20)])).lastID);
    const early = await add('B', { fee: 2000, submitted: at(5) });          // paid once, 6 Oct
    txns.push((await db.run("INSERT INTO payment_transactions (registration_id, amount, verified_amount, txn_status, submitted_at) VALUES (?, 2000, 2000, 'VERIFIED', ?)", [early, at(6)])).lastID);
    txns.push((await db.run("INSERT INTO payment_transactions (registration_id, amount, verified_amount, txn_status, submitted_at) VALUES (?, 500, 0, 'REJECTED', ?)", [early, at(25)])).lastID);
    await add('C', { fee: 0, mode: 'COMPLIMENTARY', submitted: at(1), applied: at(12) }); // made free on 12 Oct
    const order = (await call('GET', '/api/admin/reports/badges?format=json', null, admin)).body.report.sections[0].rows
      .map((r) => r[0]).filter((no) => /^BD[ABC]/.test(no));
    check('sorted by the day each was confirmed, a rejected payment not counted', JSON.stringify(order) === JSON.stringify([`BDB${N}`, `BDC${N}`, `BDA${N}`]), order);
  } finally {
    for (const id of txns) await db.run('DELETE FROM payment_transactions WHERE id = ?', [id]);
    for (const id of made) await db.run('DELETE FROM registrations WHERE id = ?', [id]);
  }
  const img = await call('GET', new URL(row[5]).pathname, null, null);
  check('...an address that answers with the image, no sign-in needed', img.status === 200 && /image\/png/.test(img.headers['content-type'] || ''), img.status);

  const csv = await call('GET', '/api/admin/reports/badges?format=csv', null, admin);
  const lines = csv.raw.split('\r\n');
  check('the CSV: one column per field, the QR address in its own', lines[0] === 'Reg No,Name,Designation,Institution,Role,QR Code' && lines[1].endsWith(`/api/qr/${sec.rows[0][0]}.png`), lines.slice(0, 2));

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
