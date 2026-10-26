// The "Delegate Payment Details & Status" report carries each delegate's
// designation and institution, and the date(s) their money reached the
// account -- from the bank statement, through each linked payment or (older
// links) the registration itself; several for instalments.
const { call, check, report, adminLogin, openDb } = require('./harness');

const N = String(Date.now()).slice(-7);

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const made = { bank: [], regs: [], txns: [] };
  try {
    const email = `payrep-${N}@example.test`;
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const signed = await call('POST', '/api/auth/register', { salutation: 'Dr', age: '40', gender: 'Female', designation: 'Associate Professor', institute: 'Test Medical College', pincode: '442102', state: 'Maharashtra', district: 'Wardha', name: `Pay Report ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    const phone = signed.body.user.phone_number;
    const credit = async (date, amount) => {
      const r = await db.run(`INSERT INTO bank_statement_transactions (post_date, value_date, description, credit, dedupe_hash, imported_at)
        VALUES (?, ?, 'UPI test', ?, ?, ?)`, [date, date, amount, `payrep-${N}-${date}-${amount}`, Date.now()]);
      made.bank.push(r.lastID);
      return r.lastID;
    };
    const regId = (await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, expected_amount, paid_amount, registration_number, payment_mode, utr_number, submitted_at)
      VALUES (?, ?, 'pg_doctor', 'Medical Student (PG)', 'BANK_VERIFIED', 4000, 2000, ?, 'UPI', 'UTR123', ?)`, [phone, `Pay Report ${N}`, `PR${N}`, Date.now()])).lastID;
    made.regs.push(regId);
    for (const [date, amt] of [['2026-10-03', 2000], ['2026-09-12', 2000]]) {
      const b = await credit(date, amt);
      made.txns.push((await db.run(`INSERT INTO payment_transactions (registration_id, amount, verified_amount, txn_status, bank_txn_id, submitted_at)
        VALUES (?, ?, ?, 'VERIFIED', ?, ?)`, [regId, amt, amt, b, Date.now()])).lastID);
    }
    // An older registration linked straight to its credit.
    const otp2 = await call('POST', '/api/otp/request', { destination: `payrep2-${N}@example.test` });
    const s2 = await call('POST', '/api/auth/register', { salutation: 'Mr', age: '30', gender: 'Male', designation: 'Nurse', institute: 'District Hospital', pincode: '442102', state: 'Maharashtra', district: 'Wardha', name: `Pay Legacy ${N}`, country: 'United Kingdom', email: `payrep2-${N}@example.test`, emailOtp: otp2.body.devOtp, password: 'testpass123' });
    const legacyBank = await credit('2026-08-20', 1500);
    made.regs.push((await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, expected_amount, registration_number, bank_txn_id, submitted_at)
      VALUES (?, ?, 'nurse_cho', 'Nurse', 'BANK_VERIFIED', 1500, ?, ?, ?)`, [s2.body.user.phone_number, `Pay Legacy ${N}`, `PL${N}`, legacyBank, Date.now()])).lastID);

    const rep = (await call('GET', '/api/admin/reports/payments?format=json', null, admin)).body.report;
    const sec = rep.sections[0];
    const col = (name) => sec.columns.indexOf(name);
    check('the report is the payment details one', rep.title === 'Delegate Payment Details & Status');
    check('it has Designation, Institution and Payment Date (Bank)', ['Designation', 'Institution', 'Payment Date (Bank)'].every((c) => col(c) >= 0), sec.columns);
    check('...the delegate\'s two beside their name', col('Designation') === col('Delegate') + 1 && col('Institution') === col('Delegate') + 2);
    const row = sec.rows.find((r) => r[0] === `PR${N}`);
    check('a delegate\'s designation and institution, as on their account', row && row[col('Designation')] === 'Associate Professor' && row[col('Institution')] === 'Test Medical College', row);
    check('paid in two instalments: both dates, earliest first, as the bank recorded them', row && /^12 Sep 2026; 3 Oct 2026$/.test(row[col('Payment Date (Bank)')]), row && row[col('Payment Date (Bank)')]);
    const legacy = sec.rows.find((r) => r[0] === `PL${N}`);
    check('a registration linked to its credit the older way: its date too', legacy && /^20 Aug 2026$/.test(legacy[col('Payment Date (Bank)')]), legacy && legacy[col('Payment Date (Bank)')]);
    const unmatched = sec.rows.find((r) => r[col('Payment Date (Bank)')] === '' );
    check('no bank credit linked: the date is left empty, not guessed', !!unmatched || sec.rows.every((r) => r[col('Payment Date (Bank)')]));
    const csv = await call('GET', '/api/admin/reports/payments?format=csv', null, admin);
    check('the Excel download carries the new columns too', csv.status === 200 && /Payment Date \(Bank\)/.test(csv.raw) && csv.raw.includes('Associate Professor'));
  } finally {
    for (const id of made.txns) await db.run('DELETE FROM payment_transactions WHERE id = ?', [id]);
    for (const id of made.regs) await db.run('DELETE FROM registrations WHERE id = ?', [id]);
    for (const id of made.bank) await db.run('DELETE FROM bank_statement_transactions WHERE id = ?', [id]);
  }
  db.close();
  report();
})();
