// Registered Delegates' Payment Date for a registration a discount code made
// free: there is no bank credit, so it is the day the code was applied --
// recorded from now on in discount_applied_at; rows from before that fall
// back to the day they registered. A complimentary (faculty) registration
// takes the day it was added.
const { call, check, report, adminLogin, openDb } = require('./harness');

const N = String(Date.now()).slice(-7);
const base = { salutation: 'Dr', age: '35', gender: 'Female', designation: 'Consultant',
  institute: 'Test Hospital', pincode: '442102', state: 'Maharashtra', district: 'Wardha' };
const IST = 5.5 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "31 Oct 2026" in IST, without leaning on the machine's ICU data.
const fmt = (ms) => { const d = new Date(ms + IST); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const codes = [];
  const regs = [];
  const signUp = async (email, name) => {
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { ...base, name, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    return { key: r.body.user && r.body.user.phone_number, cookie: r.cookie };
  };
  try {
    const A = await signUp(`pdcode-a-${N}@example.test`, `PD Code A ${N}`);
    const B = await signUp(`pdcode-b-${N}@example.test`, `PD Code B ${N}`);
    const C = await signUp(`pdcode-c-${N}@example.test`, `PD Code C ${N}`);
    const D = await signUp(`pdcode-d-${N}@example.test`, `PD Code D ${N}`);
    check('fixture: four delegates', !!(A.key && B.key && C.key && D.key));

    const issued = await call('POST', '/api/admin/discount-codes', { code: `PDFREE${N}`, discountType: 'PERCENT', discountValue: 100, scopeType: 'INDIVIDUAL', scopeValue: A.key }, admin);
    if (issued.body.success) codes.push(`PDFREE${N}`);
    const before = Date.now();
    const reg = await call('POST', '/api/registrations', { categoryKey: 'chw', optionIds: [], discountCode: `PDFREE${N}`, acknowledged: true, paymentMode: 'UPI' }, A.cookie);
    check('fixture: free with their 100% code', reg.body.success === true && reg.body.expectedAmount === 0, reg.body);
    const aRow = await db.get('SELECT id, registration_number, discount_applied_at FROM registrations WHERE phone_number = ?', [A.key]);
    if (aRow) regs.push(aRow.id);
    check('the day the code was applied is saved', aRow && aRow.discount_applied_at >= before && aRow.discount_applied_at <= Date.now(), aRow);

    // Registered before the date was recorded: falls back to registration.
    const oct17 = Date.UTC(2026, 9, 17, 4, 10);
    regs.push((await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, expected_amount, paid_amount, registration_number, payment_mode, submitted_at, discount_code, discount_amount)
      VALUES (?, ?, 'faculty_mo', 'Doctor', 'BANK_VERIFIED', 0, 0, ?, NULL, ?, 'OLDCODE', 4000)`, [B.key, `PD Code B ${N}`, `PDB${N}`, oct17])).lastID);
    // A code that only took part of the fee, with no credit linked yet: no date.
    regs.push((await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, expected_amount, paid_amount, registration_number, payment_mode, submitted_at, discount_code, discount_amount, discount_applied_at)
      VALUES (?, ?, 'faculty_mo', 'Doctor', 'BANK_VERIFIED', 2000, 2000, ?, 'UPI', ?, 'HALF', 2000, ?)`, [C.key, `PD Code C ${N}`, `PDC${N}`, oct17, oct17])).lastID);

    const oct20 = Date.UTC(2026, 9, 20, 6, 0);
    regs.push((await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, expected_amount, paid_amount, registration_number, payment_mode, submitted_at, discount_code, discount_amount, discount_applied_at)
      VALUES (?, ?, 'faculty_mo', 'Doctor', 'BANK_VERIFIED', 0, 0, ?, 'COMPLIMENTARY', ?, 'COMPLIMENTARY', 4000, ?)`, [D.key, `PD Code D ${N}`, `PDD${N}`, oct20, oct20])).lastID);

    const sec = (await call('GET', '/api/admin/reports/delegates?format=json', null, admin)).body.report.sections[0];
    const col = sec.columns.indexOf('Payment Date');
    const cell = (no) => { const r = sec.rows.find((x) => x[0] === no); return r && r[col]; };
    check('a code-free registration shows the day the code was applied', cell(aRow && aRow.registration_number) === fmt(aRow.discount_applied_at), cell(aRow && aRow.registration_number));
    check('an older one shows the day they registered', cell(`PDB${N}`) === '17 Oct 2026', cell(`PDB${N}`));
    check('a complimentary registration shows the day it was added', cell(`PDD${N}`) === '20 Oct 2026', cell(`PDD${N}`));
    check('a part-discount with fee still to reach the bank stays blank', cell(`PDC${N}`) === '', cell(`PDC${N}`));
  } finally {
    for (const id of regs) {
      await db.run('DELETE FROM payment_transactions WHERE registration_id = ?', [id]);
      await db.run('DELETE FROM registration_options WHERE registration_id = ?', [id]).catch(() => {});
      await db.run('DELETE FROM registrations WHERE id = ?', [id]);
    }
    for (const code of codes) await db.run('DELETE FROM discount_codes WHERE code = ?', [code]);
  }
  db.close();
  report();
})();
