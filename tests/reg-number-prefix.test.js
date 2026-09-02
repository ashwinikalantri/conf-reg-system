// Two delegates were issued the numbers '1274' and '1275' -- the sequence
// with no prefix in front of it. A deploy had blanked the hardcoded
// conference defaults expecting first-run setup to refill them, and on an
// already-running instance nothing had ever written the prefix to
// schema_meta, so an empty string was concatenated for four hours until
// Settings was saved. The numbers looked assigned, reached receipts and
// confirmation emails, and the boot-time backfills skipped them because they
// were not empty.
const { call, check, report, adminLogin, openDb, appFile } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-6);
const base = { salutation: 'Dr', name: 'prefix tester', age: '41', gender: 'Female', designation: 'Consultant', institute: 'X' };

(async () => {
  await adminLogin();  // the suite's per-file admin; keeps the login path exercised
  const db = openDb();

  console.log('\n== The fixture is configured, so numbering is normal ==');
  const cfg = await db.get("SELECT value FROM schema_meta WHERE key='conference_reg_prefix'");
  check('a prefix is configured', !!(cfg && cfg.value), cfg);
  const prefix = cfg.value;

  // An Indian delegate signs up with a mobile; the account key is the phone.
  const mkDelegate = async (tag) => {
    const phone = `9${N}01${tag}`; // 10 digits: 9 + 6 + 2 + 1
    const mail = `prefix-${tag}-${N}@example.com`;
    const otp = await call('POST', '/api/otp/request', { destination: phone });
    const res = await call('POST', '/api/auth/register',
      { ...base, country: 'India', phone, phoneOtp: otp.body.devOtp, email: mail, password: 'testpass123',
        district: 'Wardha', state: 'Maharashtra', pincode: '442102' });
    return { ok: !!(res.body && res.body.success), phone, error: res.body && res.body.error };
  };

  const first = await mkDelegate('1');
  check('a delegate can sign up', first.ok, first.error);
  let row = await db.get('SELECT registration_number FROM users WHERE phone_number = ?', [first.phone]);
  check('they get a prefixed number', !!(row && String(row.registration_number).startsWith(prefix)), row);
  check('and it is not a bare sequence', !/^\d+$/.test(String(row && row.registration_number)), row);

  console.log('\n== With no prefix, no number is issued at all ==');
  // The guard is driven directly rather than by blanking the live setting:
  // the broken state is a process that BOOTED without a stored prefix, which
  // a running server cannot be pushed back into, and half-testing it against
  // a reload endpoint would assert nothing.
  const src = fs.readFileSync(appFile('server.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function assignUserRegNumber(phone) {'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  const calls = [];
  // Stateful, so the function's own read-back after the UPDATE sees what it
  // just wrote -- exactly as the real one does.
  let stored = null;
  const sandbox = {
    dbGet: async () => ({ registration_number: stored }),
    dbRun: async (sql, params) => {
      calls.push(sql);
      if (/UPDATE users SET registration_number/.test(sql)) stored = params[0];
      return { lastID: 1274 };
    },
    CONFERENCE: { regPrefix: '' },
    console: { error: (m) => calls.push(`LOG ${m}`) },
  };
  const assign = new Function('dbGet', 'dbRun', 'CONFERENCE', 'console',
    `${body}; return assignUserRegNumber;`)(sandbox.dbGet, sandbox.dbRun, sandbox.CONFERENCE, sandbox.console);

  const blank = await assign('9000009999');
  check('a blank prefix yields no number, not a bare one', blank === null, blank);
  check('the sequence is not consumed', !calls.some((c) => /INSERT INTO reg_seq/.test(c)), calls);
  check('and it says so loudly', calls.some((c) => /^LOG .*prefix/i.test(c)), calls);

  console.log('\n== A configured prefix is used, and used exactly ==');
  sandbox.CONFERENCE.regPrefix = 'TESTCON2099';
  calls.length = 0;
  stored = null;
  const good = await assign('9000009999');
  check('the number carries the prefix', good === 'TESTCON20991274', good);
  check('the sequence is consumed only then', calls.some((c) => /INSERT INTO reg_seq/.test(c)), calls);
  sandbox.CONFERENCE.regPrefix = '   ';
  stored = null;
  check('whitespace is not a prefix', (await assign('9000009999')) === null);

  console.log('\n== Callers never stamp a null over a real number ==');
  const stamps = src.match(/UPDATE registrations SET registration_number = \? WHERE phone_number = \?/g) || [];
  check('every stamping call site is guarded',
    (src.match(/if \(regNo\) await dbRun\('UPDATE registrations SET registration_number/g) || []).length === stamps.length,
    stamps.length);

  db.close();
  report();
})();
