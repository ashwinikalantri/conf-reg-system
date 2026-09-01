#!/usr/bin/env node
//
// Builds the fixture database the suite runs against.
//
//   node tests/seed.js [output.db]
//
// Why this exists: the tests used to run against a copy of production. They
// didn't seed anything -- they went looking ("a registration with two verified
// payments", "a category that requires a student ID") and used whatever they
// found. That made them hostage to live data: two broke the morning the copy
// was refreshed, and one broke the day early-bird pricing ended. It also meant
// ten assertions passed by doing nothing when the shape they wanted was absent.
//
// The schema is NOT written out here. It is obtained by booting the app itself
// against an empty directory and letting it create its own tables, so a fixture
// database can never drift from the real one. Only rows are written below.
//
// Everyone here is invented. No real delegate, number, or address appears.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'fixture.db'));

// --- helpers ---------------------------------------------------------------

// Same format the app writes: scrypt$<saltHex>$<hashHex>, 64-byte key. Kept in
// step with hashPassword() in server.js; if that ever changes format, the
// verify side rejects these and the login tests fail loudly rather than
// silently letting everyone in.
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(plain), salt, 64).toString('hex')}`;
}

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const ago = (days) => now - days * DAY;
// Calendar dates are written RELATIVE TO TODAY. The pricing-phase tests broke
// once already because a fixed early-bird date quietly went past.
const ymd = (offsetDays) => new Date(now + offsetDays * DAY).toISOString().slice(0, 10);

const ADMIN_PW = 'harness-admin-pw';
// Must match ADMIN_POOL_SIZE in harness.js.
const ADMIN_POOL_SIZE = 60;
const DELEGATE_PW = 'harness-delegate-pw';

// --- 1. schema, straight from the application ------------------------------

// An OS-assigned free port. A random one from a fixed range meant two seeds
// running at the same time could pick the same port; the second app then
// failed to listen, and because the wait below ended on a timeout rather than
// on readiness, it copied whatever the database looked like at that moment --
// occasionally missing a late migration, which surfaced as a single
// unexplained assertion failure much later.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const srv = require('net').createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

async function buildEmptySchema() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nqocn-seed-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: work,
    // DB_PATH, not cwd: the app resolves its database from its own directory
    // unless told otherwise, so without this the schema would be built in the
    // repository rather than the scratch workspace.
    env: { ...process.env, PORT: String(port), OTP_ECHO: '1', DB_PATH: path.join(work, 'conference.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  const deadline = Date.now() + 30000;
  const dbFile = path.join(work, 'conference.db');
  // Wait for the app to say it is up AND for the file to stop growing -- the
  // migrations run after the listen callback, and copying mid-migration would
  // capture a half-built schema.
  let lastSize = -1;
  let stableFor = 0;
  let ready = false;
  while (Date.now() < deadline) {
    await sleep(300);
    if (!out.includes('Server running')) continue;
    if (!fs.existsSync(dbFile)) continue;
    const size = fs.statSync(dbFile).size;
    stableFor = size === lastSize ? stableFor + 1 : 0;
    lastSize = size;
    if (stableFor >= 3) { ready = true; break; }
  }
  child.kill('SIGTERM');
  try {
    // Running out of time is a failure, not a result. Copying the database at
    // that point is how a half-migrated schema could escape into a fixture.
    if (!ready) {
      throw new Error(`The app never finished starting while seeding (port ${port}).\n${out}`);
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.copyFileSync(dbFile, OUT);
  } finally {
    // Cleared on the way out either way, so a failed seed leaves no litter.
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// --- 2. rows ---------------------------------------------------------------

function open(file) {
  const sqlite3 = require(path.join(ROOT, 'node_modules', 'sqlite3')).verbose();
  const db = new sqlite3.Database(file);
  return {
    run: (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { return e ? rej(e) : res(this); })),
    get: (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r)))),
    all: (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r)))),
    close: () => new Promise((res) => db.close(res)),
  };
}

// Every account the suite uses, in one place. Numbers are in a block that
// cannot belong to a real Indian mobile (those start 6-9 and these are 90000…
// reserved for this file by convention), and no name or address is a real
// person's.
const STAFF = [
  { phone: '9000000001', name: 'Ada Harness',      role: 'SUPER_ADMIN' },
  { phone: '9000000002', name: 'Finn Ledger',      role: 'FINANCE_ADMIN' },
  { phone: '9000000003', name: 'Rae Reviewer',     role: 'ACADEMIC_REVIEWER' },
  { phone: '9000000004', name: 'Ops Ostrom',       role: 'OPERATIONS' },
  { phone: '9000000005', name: 'Fay Both',         role: 'FINANCE_ACADEMIC' },
];

async function seedRows() {
  const db = open(OUT);

  // -- settings the suite depends on ---------------------------------------
  const meta = [
    ['conference_name', 'Fixture Conference on Quality & Safety 2099'],
    ['conference_acronym', 'FIXCON 2099'],
    ['conference_location', 'Fixture Hall, Testville'],
    ['conference_start_date', ymd(120)],
    ['conference_end_date', ymd(121)],
    ['conference_reg_prefix', 'FIXCON2099'],
    ['upi_id', 'fixture@examplebank'],
    ['upi_payee_name', 'FIXCON 2099'],
    ['bank_account_name', 'Fixture Conference Account'],
    ['bank_account_number', '000011112222'],
    ['bank_ifsc', 'FIXT0000001'],
    ['bank_branch', 'Testville Main'],
    ['email_from', 'fixcon@example.test'],
    ['email_from_name', 'FIXCON 2099'],
    ['otp_echo', '1'],
    ['notify_sms_enabled', '0'],
    ['notify_email_enabled', '0'],
    ['setup_completed', String(ago(200))],
  ];
  for (const [k, v] of meta) await db.run('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)', [k, v]);

  // Pricing phases relative to today: early bird is CURRENT, so a test that
  // asks what phase it is gets a stable answer whenever it runs.
  await db.run('INSERT OR REPLACE INTO fee_config (id, early_until, regular_until, late_until) VALUES (1, ?, ?, ?)',
    [ymd(30), ymd(60), ymd(90)]);

  // -- fee categories -------------------------------------------------------
  // Shapes rather than a copy of anyone's price list: two that require a
  // student ID, one free-ish, one with no gap between phases.
  const cats = [
    ['nursing_ug',  'Nursing Student (UG)', 500, 1000, 1500, 2000, 1, 'nursing', 'UG', 0],
    ['nursing_pg',  'Nursing Student (PG)', 750, 1500, 2000, 2500, 1, 'nursing', 'PG', 1],
    ['med_student', 'Medical Student (UG)', 1500, 2000, 2500, 3000, 1, 'medical', 'UG', 2],
    ['pg_doctor',   'Medical Student (PG)', 3000, 3500, 4000, 5000, 1, 'medical', 'PG', 3],
    ['nurse_cho',   'Nurse / CHO',          2000, 2500, 3000, 3500, 0, null, null, 4],
    ['faculty_mo',  'Doctor',               3000, 3500, 4000, 5000, 0, null, null, 5],
    ['chw',         'Frontline Health Worker', 200, 200, 200, 200, 0, null, null, 6],
  ];
  for (const [key, label, e, r, l, s, needsId, disc, lvl, sort] of cats) {
    await db.run(
      `INSERT INTO fee_categories (category_key, label, early_fee, regular_fee, late_fee, spot_fee,
         active, sort_order, subtitle, requires_student_id, id_discipline, id_level)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [key, label, e, r, l, s, sort, `${label} — fixture`, needsId, disc, lvl]);
  }

  // -- programme groups -----------------------------------------------------
  const wsGroup = (await db.run(
    `INSERT INTO program_groups (name, description, required, max_select, sort_order, active, created_at)
     VALUES ('Workshops', 'Fixture workshops', 0, 1, 0, 1, ?)`, [ago(180)])).lastID;
  const qiGroup = (await db.run(
    `INSERT INTO program_groups (name, description, required, max_select, sort_order, active, created_at)
     VALUES ('QI Practices', 'Fixture QI sessions', 0, 1, 1, 1, ?)`, [ago(180)])).lastID;
  const optIds = {};
  for (const [group, name, capacity, fee] of [
    [wsGroup, 'Quality Improvement Basics', 50, 0],
    [wsGroup, 'Leadership in Nursing Care', 40, 0],
    [wsGroup, 'Paid Pre-Conference Workshop', 20, 500],   // the only one with a fee
    [qiGroup, 'Student Parliament for QI', 100, 0],
    [qiGroup, 'Clinical Audit Clinic', 30, 0],
  ]) {
    optIds[name] = (await db.run(
      `INSERT INTO program_options (type, name, capacity, active, created_at, group_id, fee)
       VALUES ('workshop', ?, ?, 1, ?, ?, ?)`, [name, capacity, ago(180), group, fee])).lastID;
  }

  // -- discount codes and group rules --------------------------------------
  await db.run(
    `INSERT INTO discount_codes (code, discount_type, discount_value, scope_type, scope_value,
       max_uses, expires_at, active, created_at, created_by)
     VALUES ('FIXPROMO50', 'PERCENT', 50, 'ALL', NULL, 100, ?, 1, ?, ?)`,
    [ymd(45), ago(60), STAFF[0].phone]);
  await db.run(
    `INSERT INTO discount_codes (code, discount_type, discount_value, scope_type, scope_value,
       max_uses, expires_at, active, created_at, created_by)
     VALUES ('FIXEXPIRED', 'FLAT', 500, 'ALL', NULL, 100, ?, 1, ?, ?)`,
    [ymd(-5), ago(60), STAFF[0].phone]);   // already expired, on purpose

  // -- people ---------------------------------------------------------------
  const mkUser = async (u) => {
    await db.run(
      `INSERT INTO users (phone_number, full_name, salutation, designation, institution, pincode, state,
         district, post_office, role, age, gender, email, registration_number, created_at, password_hash,
         phone, phone_verified, email_verified, country)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [u.phone_number, u.full_name, u.salutation || 'Dr', u.designation || 'Consultant',
        u.institution || 'Fixture Institute of Medical Sciences', u.pincode || '442102',
        u.state || 'Maharashtra', u.district || 'Wardha', u.post_office || 'Testville S.O',
        u.role || 'DELEGATE', u.age || 35, u.gender || 'Female', u.email,
        u.registration_number || null, u.created_at || ago(90),
        u.password_hash === null ? null : hashPassword(u.password || DELEGATE_PW),
        u.phone === undefined ? `+91${u.phone_number}` : u.phone,
        u.phone_verified === undefined ? 1 : u.phone_verified,
        u.email_verified === undefined ? 1 : u.email_verified,
        u.country || 'India']);
  };

  for (const s of STAFF) {
    await mkUser({ phone_number: s.phone, full_name: s.name, role: s.role,
      email: `${s.name.split(' ')[0].toLowerCase()}@example.test`, password: ADMIN_PW,
      registration_number: null });
  }

  // A pool of interchangeable super admins. The OTP resend throttle is per
  // destination, so a suite where every file signs in as the same person
  // spends its time waiting -- or failing. The harness hands each test file
  // its own account out of this pool, deterministically, so they never
  // collide however the runner orders them.
  for (let i = 1; i <= ADMIN_POOL_SIZE; i += 1) {
    const phone = `90001${String(i).padStart(5, '0')}`;
    await mkUser({ phone_number: phone, full_name: `Pool Admin ${i}`, role: 'SUPER_ADMIN',
      email: `pool${i}@example.test`, password: ADMIN_PW, registration_number: null });
  }

  // -- registrations, one per shape the suite looks for --------------------
  let regCounter = 1000;
  const nextRegNo = () => `FIXCON2099${++regCounter}`;

  // Creates a user + registration + its payments in one go.
  const mkDelegate = async (d) => {
    await mkUser({
      phone_number: d.phone, full_name: d.name, email: d.email,
      email_verified: d.email_verified === undefined ? 1 : d.email_verified,
      phone_verified: d.phone_verified === undefined ? 1 : d.phone_verified,
      password: d.password, password_hash: d.password === null ? null : undefined,
      registration_number: d.regNo, phone: d.phone_field,
      country: d.country, designation: d.designation, institution: d.institution,
    });
    if (!d.category) return null;
    const cat = cats.find((c) => c[0] === d.category);
    const reg = await db.run(
      `INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, paid_amount,
         utr_number, screenshot, is_flagged, bank_status, registration_number, expected_amount,
         payment_mode, submitted_at, id_verified, discount_code, discount_amount, id_card,
         ocr_amount_match, ocr_utr_match, ocr_vpa_match)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.phone, d.name, d.category, cat[1], d.paid, d.utr || null,
        d.screenshot === false ? null : 'data:image/png;base64,iVBORw0KGgo=',
        d.flagged ? 1 : 0, d.status, d.regNo, d.expected, d.mode || 'UPI', d.submitted || ago(20),
        d.idVerified ? 1 : 0, d.discountCode || null, d.discountAmount || 0,
        cat[6] ? 'data:image/png;base64,iVBORw0KGgo=' : null,
        d.ocr === undefined ? 1 : d.ocr, d.ocr === undefined ? 1 : d.ocr, d.ocr === undefined ? 1 : d.ocr]);
    for (const opt of d.options || []) {
      const o = optIds[opt];
      const gid = ['Student Parliament for QI', 'Clinical Audit Clinic'].includes(opt) ? qiGroup : wsGroup;
      await db.run('INSERT INTO registration_options (registration_id, group_id, option_id, is_faculty) VALUES (?, ?, ?, 0)',
        [reg.lastID, gid, o]);
    }
    for (const t of d.payments || []) {
      await db.run(
        `INSERT INTO payment_transactions (registration_id, phone_number, amount, verified_amount, utr_number,
           screenshot, payment_mode, txn_status, bank_txn_id, submitted_at, reviewed_by, reviewed_at,
           is_flagged, rejection_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [reg.lastID, d.phone, t.amount, t.verified === undefined ? null : t.verified, t.utr,
          // Each slip is distinct: a delegate who paid twice has two different
          // images, and a test that checks each payment serves its OWN slip
          // needs them to differ.
          t.slip === false ? null : `data:image/png;base64,${Buffer.from(`slip-${t.utr}`).toString('base64')}`,
          t.mode || 'UPI', t.status, t.bankTxnId || null, t.at || ago(20),
          t.status === 'PENDING' ? null : 'Ada Harness', t.status === 'PENDING' ? null : (t.at || ago(20)),
          t.rejection || null]);
    }
    return reg.lastID;
  };

  // A bank credit for a payment to be reconciled against.
  let hashSeed = 0;
  const mkCredit = async ({ ref, amount, date, desc, debit }) => {
    hashSeed += 1;
    return (await db.run(
      `INSERT INTO bank_statement_transactions (post_date, value_date, description, debit, credit,
         balance, extracted_ref, dedupe_hash, source_file, imported_at, imported_by, is_non_registration)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fixture-statement.xlsx', ?, 'Ada Harness', 0)`,
      [date || ymd(-20), date || ymd(-20), desc, debit || null, amount || null, 100000 + hashSeed * 100,
        ref, `fixture-hash-${hashSeed}`, ago(19)])).lastID;
  };

  // 1. Straightforward: verified, one payment, reconciled.
  const c1 = await mkCredit({ ref: '100000000001', amount: 3000, desc: 'UPI/RRN 100000000001/UPI_ONE PAYMENT' });
  await mkDelegate({
    phone: '9000001001', name: 'One Payment', email: 'one.payment@example.test', regNo: nextRegNo(),
    category: 'faculty_mo', expected: 3000, paid: 3000, status: 'BANK_VERIFIED', utr: '100000000001',
    options: ['Quality Improvement Basics', 'Student Parliament for QI'],
    payments: [{ amount: 3000, verified: 3000, utr: '100000000001', status: 'VERIFIED', bankTxnId: c1 }],
  });

  // 2. Partial then top-up: two verified payments against two credits. The
  //    shape that exposed the reconciliation bug.
  const c2a = await mkCredit({ ref: '200000000001', amount: 750, desc: 'UPI/RRN 200000000001/UPI_TWO PAYMENTS' });
  const c2b = await mkCredit({ ref: '200000000002', amount: 1250, desc: 'UPI/RRN 200000000002/UPI_TWO PAYMENTS' });
  await mkDelegate({
    phone: '9000001002', name: 'Two Payments', email: 'two.payments@example.test', regNo: nextRegNo(),
    category: 'nurse_cho', expected: 2000, paid: 2000, status: 'BANK_VERIFIED', utr: '200000000002',
    options: ['Leadership in Nursing Care', 'Student Parliament for QI'],
    payments: [
      { amount: 2000, verified: 750, utr: '200000000001', status: 'VERIFIED', bankTxnId: c2a, at: ago(22) },
      { amount: 1250, verified: 1250, utr: '200000000002', status: 'VERIFIED', bankTxnId: c2b, mode: 'NEFT_RTGS', at: ago(20) },
    ],
  });

  // 3. Verified with a promo discount, so the receipt has something to break down.
  const c3 = await mkCredit({ ref: '300000000001', amount: 1000, desc: 'UPI/RRN 300000000001/UPI_DISCOUNTED' });
  await mkDelegate({
    phone: '9000001003', name: 'Half Price', email: 'half.price@example.test', regNo: nextRegNo(),
    category: 'nurse_cho', expected: 1000, paid: 1000, status: 'BANK_VERIFIED', utr: '300000000001',
    discountCode: 'FIXPROMO50', discountAmount: 1000,
    options: ['Quality Improvement Basics'],
    payments: [{ amount: 1000, verified: 1000, utr: '300000000001', status: 'VERIFIED', bankTxnId: c3 }],
  });

  // 4. A rejected payment alongside a verified one -- the rejected must stay
  //    off receipts and out of totals.
  const c4 = await mkCredit({ ref: '400000000001', amount: 750, desc: 'UPI/RRN 400000000001/UPI_HAD A REJECT' });
  await mkDelegate({
    phone: '9000001004', name: 'Had A Reject', email: 'had.reject@example.test', regNo: nextRegNo(),
    category: 'nursing_pg', expected: 750, paid: 750, status: 'BANK_VERIFIED', utr: '400000000001',
    idVerified: true, options: ['Clinical Audit Clinic'],
    payments: [
      { amount: 750, verified: null, utr: '400000000099', status: 'REJECTED', rejection: 'WRONG_DETAILS', at: ago(25) },
      { amount: 750, verified: 750, utr: '400000000001', status: 'VERIFIED', bankTxnId: c4, at: ago(23) },
    ],
  });

  // 5. Awaiting review: a payment claimed, nothing linked.
  await mkDelegate({
    phone: '9000001005', name: 'Still Pending', email: 'still.pending@example.test', regNo: nextRegNo(),
    category: 'faculty_mo', expected: 3000, paid: 3000, status: 'PENDING', utr: '500000000001',
    options: ['Quality Improvement Basics'],
    payments: [{ amount: 3000, utr: '500000000001', status: 'PENDING' }],
  });

  // 6. Student category, ID not yet confirmed -- the verify gate.
  const c6 = await mkCredit({ ref: '600000000001', amount: 1500, desc: 'UPI/RRN 600000000001/UPI_UNCHECKED ID' });
  await mkDelegate({
    phone: '9000001006', name: 'Unchecked Id', email: 'unchecked.id@example.test', regNo: nextRegNo(),
    category: 'med_student', expected: 1500, paid: 1500, status: 'PENDING', utr: '600000000001',
    idVerified: false, options: ['Student Parliament for QI'],
    payments: [{ amount: 1500, verified: 1500, utr: '600000000001', status: 'VERIFIED', bankTxnId: c6 }],
  });

  // 7. Student category, ID confirmed and fully verified.
  const c7 = await mkCredit({ ref: '700000000001', amount: 1500, desc: 'UPI/RRN 700000000001/UPI_CHECKED ID' });
  await mkDelegate({
    phone: '9000001007', name: 'Checked Id', email: 'checked.id@example.test', regNo: nextRegNo(),
    category: 'med_student', expected: 1500, paid: 1500, status: 'BANK_VERIFIED', utr: '700000000001',
    idVerified: true, options: ['Student Parliament for QI'],
    payments: [{ amount: 1500, verified: 1500, utr: '700000000001', status: 'VERIFIED', bankTxnId: c7 }],
  });

  // 8. Signed up, never registered -- the reminder audience.
  await mkDelegate({ phone: '9000001008', name: 'Never Paid', email: 'never.paid@example.test', regNo: nextRegNo() });

  // 9. Email not yet verified -- the verification prompt.
  await mkDelegate({ phone: '9000001009', name: 'Unverified Email', email: 'unverified.email@example.test',
    regNo: nextRegNo(), email_verified: 0 });

  // 10. No password set -- prompted to set one at next login.
  await mkDelegate({ phone: '9000001010', name: 'No Password', email: 'no.password@example.test',
    regNo: nextRegNo(), password: null });

  // 11. An email-only (international) account: the key is synthetic, there is
  //     no phone at all.
  await mkUser({
    phone_number: `u_${crypto.randomBytes(9).toString('hex')}`, full_name: 'Email Only',
    email: 'email.only@example.test', phone: null, phone_verified: 0, email_verified: 1,
    country: 'Nepal', state: null, district: null, pincode: null, post_office: null,
    registration_number: `FIXCON2099${++regCounter}`,
  });

  // Every confirmed registration needs the audit entry that records WHEN it was
  // confirmed -- the receipt reads it for "Verified on", and without it the
  // receipt shows a dash. Found because a receipt test asked for the timestamp
  // and the fixture had none.
  for (const r of await db.all("SELECT id, phone_number, submitted_at FROM registrations WHERE bank_status='BANK_VERIFIED'")) {
    await db.run(
      `INSERT INTO audit_log (entity_type, entity_id, action, old_value, new_value,
         actor_phone, actor_name, actor_role, created_at)
       VALUES ('registration', ?, 'BANK_STATUS_CHANGE', 'PENDING', 'BANK_VERIFIED', ?, 'Ada Harness', 'SUPER_ADMIN', ?)`,
      [String(r.id), STAFF[0].phone, Number(r.submitted_at) + 2 * 60 * 60 * 1000]);
  }

  // A credit nobody has claimed, and a debit to refund against.
  await mkCredit({ ref: '900000000001', amount: 2500, desc: 'UPI/RRN 900000000001/UPI_UNCLAIMED' });
  await mkCredit({ ref: '900000000002', debit: 500, amount: null, desc: 'NEFT OUT/REFUND FIXTURE' });

  // Keep registration numbers from colliding with anything issued later.
  await db.run('INSERT OR REPLACE INTO reg_seq (id) VALUES (?)', [regCounter + 100]);

  await db.close();
}

// --- 3. prove the fixtures are actually there ------------------------------
//
// A missing shape used to turn a test green ("(no such registration in data)").
// The seed asserts its own completeness instead, so an incomplete fixture fails
// here -- loudly, once -- rather than quietly hollowing out the suite.

const REQUIRED = [
  ['a super admin', "SELECT 1 FROM users WHERE role='SUPER_ADMIN' AND password_hash IS NOT NULL"],
  ['the full admin pool', `SELECT 1 FROM users WHERE phone_number LIKE '90001%' GROUP BY 1 HAVING COUNT(*)=${ADMIN_POOL_SIZE}`],
  ['all five staff roles', "SELECT 1 FROM users WHERE role IN ('SUPER_ADMIN','FINANCE_ADMIN','ACADEMIC_REVIEWER','OPERATIONS','FINANCE_ACADEMIC') GROUP BY 1 HAVING COUNT(DISTINCT role)=5"],
  ['a verified single-payment registration', "SELECT 1 FROM registrations r JOIN payment_transactions p ON p.registration_id=r.id WHERE r.bank_status='BANK_VERIFIED' GROUP BY r.id HAVING COUNT(*)=1"],
  ['a verified registration with two verified payments', "SELECT 1 FROM registrations r JOIN payment_transactions p ON p.registration_id=r.id WHERE r.bank_status='BANK_VERIFIED' AND p.txn_status='VERIFIED' GROUP BY r.id HAVING COUNT(*)>1"],
  ['a registration with a discount', "SELECT 1 FROM registrations WHERE discount_amount>0 AND bank_status='BANK_VERIFIED'"],
  ['a rejected payment beside a verified one', "SELECT 1 FROM payment_transactions a JOIN payment_transactions b ON a.registration_id=b.registration_id WHERE a.txn_status='REJECTED' AND b.txn_status='VERIFIED'"],
  ['a pending registration', "SELECT 1 FROM registrations WHERE bank_status='PENDING'"],
  ['a student registration with an unverified ID', "SELECT 1 FROM registrations r JOIN fee_categories c ON c.category_key=r.category_key WHERE c.requires_student_id=1 AND r.id_verified=0"],
  ['a student registration with a verified ID', "SELECT 1 FROM registrations r JOIN fee_categories c ON c.category_key=r.category_key WHERE c.requires_student_id=1 AND r.id_verified=1"],
  ['a user who never registered', "SELECT 1 FROM users u WHERE NOT EXISTS(SELECT 1 FROM registrations r WHERE r.phone_number=u.phone_number) AND u.role='DELEGATE'"],
  ['a user with an unverified email', "SELECT 1 FROM users WHERE email_verified=0 AND email IS NOT NULL"],
  ['a user with no password', "SELECT 1 FROM users WHERE password_hash IS NULL"],
  ['an email-only account', "SELECT 1 FROM users WHERE phone_number LIKE 'u\\_%' ESCAPE '\\' AND email IS NOT NULL"],
  ['a payment with a slip', "SELECT 1 FROM payment_transactions WHERE screenshot IS NOT NULL"],
  ['two payments of one registration with DIFFERENT slips', "SELECT 1 FROM payment_transactions a JOIN payment_transactions b ON a.registration_id=b.registration_id AND a.id<b.id WHERE a.screenshot IS NOT NULL AND b.screenshot IS NOT NULL AND a.screenshot<>b.screenshot"],
  ['a category that requires a student ID', "SELECT 1 FROM fee_categories WHERE requires_student_id=1 AND active=1"],
  ['an unclaimed bank credit', "SELECT 1 FROM bank_statement_transactions WHERE credit>0 AND id NOT IN (SELECT bank_txn_id FROM payment_transactions WHERE bank_txn_id IS NOT NULL)"],
  ['a bank debit to refund against', "SELECT 1 FROM bank_statement_transactions WHERE debit>0"],
  ['programme groups with options', "SELECT 1 FROM program_groups g JOIN program_options o ON o.group_id=g.id GROUP BY g.id HAVING COUNT(*)>1"],
  ['a paid programme option', "SELECT 1 FROM program_options WHERE fee>0"],
  ['an active promo code', "SELECT 1 FROM discount_codes WHERE active=1 AND expires_at >= date('now')"],
  ['an expired promo code', "SELECT 1 FROM discount_codes WHERE expires_at < date('now')"],
  ['early-bird pricing in effect today', "SELECT 1 FROM fee_config WHERE early_until >= date('now')"],
  ['a confirmation timestamp for the receipt', "SELECT 1 FROM audit_log WHERE action='BANK_STATUS_CHANGE' AND new_value='BANK_VERIFIED'"],
];

async function verify() {
  const db = open(OUT);
  const missing = [];
  for (const [label, sql] of REQUIRED) {
    const row = await db.get(`${sql} LIMIT 1`);
    if (!row) missing.push(label);
  }
  const counts = await db.get(`SELECT
      (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM registrations) r,
      (SELECT COUNT(*) FROM payment_transactions) p, (SELECT COUNT(*) FROM bank_statement_transactions) b`);
  await db.close();
  if (missing.length) {
    console.error('\nThe fixture database is missing shapes the suite needs:');
    missing.forEach((m) => console.error(`  - ${m}`));
    process.exit(1);
  }
  console.log(`Seeded ${OUT}`);
  console.log(`  ${counts.u} users, ${counts.r} registrations, ${counts.p} payments, ${counts.b} bank rows`);
  console.log(`  ${REQUIRED.length}/${REQUIRED.length} required shapes present`);
}

(async () => {
  fs.rmSync(OUT, { force: true });
  await buildEmptySchema();
  await seedRows();
  await verify();
})().catch((err) => { console.error(err); process.exit(1); });
