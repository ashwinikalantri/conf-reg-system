// The summary report: headline numbers, no line lists.
//
// Two properties carry it, and each is a way it could be built wrongly.
//
// It must not be a line list in disguise. Every other report is a table of
// people or payments; this one has counts and totals only, so no
// registration number, name, email or phone may appear in it in any format.
//
// And it must never reveal a figure the viewer could not already get. It
// opens for every role that can open some report, but each block is gated by
// the permission that governs its data -- and money totals by
// payments.view_totals, following the decision that conference-wide money is
// for finance roles only. So Operations, which may open the Payments line
// list, sees registration counts here but no rupee totals, and an Academic
// Reviewer sees the abstracts block and nothing else.
const { call, check, report, ADMIN_PW, adminLogin, loginPassword, openDb } = require('./harness');

const STAFF = {
  FINANCE_ADMIN: '9000000002',
  ACADEMIC_REVIEWER: '9000000003',
  OPERATIONS: '9000000004',
  FINANCE_ACADEMIC: '9000000005',
  FRONT_DESK: '9000000006',
};

const names = (rep) => rep.sections.map((s) => s.name);
const section = (rep, name) => rep.sections.find((s) => s.name === name);
const value = (rep, sectionName, measure, col = 1) => {
  const sec = section(rep, sectionName);
  const row = sec && sec.rows.find((r) => r[0] === measure);
  return row ? row[col] : undefined;
};
const rupeesToNumber = (s) => Number(String(s).replace(/[^\d]/g, ''));

(async () => {
  const admin = await adminLogin();
  const db = openDb({ readOnly: true });
  const get = async (cookie, format = 'json') =>
    call('GET', `/api/admin/reports/summary${format === 'json' ? '?format=json' : format === 'csv' ? '?format=csv' : ''}`, null, cookie);

  console.log('\n== A Super Admin sees every block ==');
  const full = await get(admin);
  check('the report responds', full.status === 200 && full.body.success, full.status);
  const rep = full.body.report;
  check('...marked as a summary, not a record list', rep.kind === 'summary', rep.kind);
  for (const n of ['Registrations', 'Money', 'Collected by payment method', 'Confirmed delegates',
    'Confirmed delegates by state', 'Programme occupancy', 'Abstracts', 'Accounts']) {
    check(`it has a "${n}" block`, names(rep).includes(n), names(rep));
  }

  console.log('\n== It is not a line list in disguise ==');
  // Real identifying values from the fixture, checked across every format:
  // none of them may appear anywhere in the summary.
  const people = await db.all(
    `SELECT r.registration_number AS reg, r.delegate_name AS name, u.email, u.phone, r.phone_number AS key
       FROM registrations r LEFT JOIN users u ON u.phone_number = r.phone_number LIMIT 40`);
  const idents = people.flatMap((p) => [p.reg, p.name, p.email, p.phone, p.key])
    .filter((v) => v && String(v).length >= 6).map(String);
  check('fixture: there are identifying values to look for', idents.length > 20, idents.length);
  const csv = await get(admin, 'csv');
  const html = await get(admin, 'html');
  const formats = { json: JSON.stringify(rep), csv: String(csv.body), pdf: String(html.body) };
  for (const [fmt, text] of Object.entries(formats)) {
    const leaked = idents.filter((v) => text.includes(v));
    check(`the ${fmt} holds no registration number, name, email or phone`, leaked.length === 0, leaked.slice(0, 4));
  }
  // Every block is short: counts, not rows per person.
  const longest = Math.max(...rep.sections.filter((s) => s.name !== 'Programme occupancy').map((s) => s.rows.length));
  check('no block is a list of people', longest <= 12, longest);

  console.log('\n== The numbers are the database\'s ==');
  const regs = await db.get('SELECT COUNT(*) AS n FROM registrations');
  const confirmed = await db.get("SELECT COUNT(*) AS n FROM registrations WHERE bank_status = 'BANK_VERIFIED'");
  check('registrations submitted', value(rep, 'Registrations', 'Registrations submitted') === regs.n,
    [value(rep, 'Registrations', 'Registrations submitted'), regs.n]);
  check('confirmed', value(rep, 'Registrations', 'Confirmed — paid and verified') === confirmed.n,
    [value(rep, 'Registrations', 'Confirmed — paid and verified'), confirmed.n]);
  check('the by-category table adds up to the confirmed count',
    value(rep, 'Confirmed registrations by category', 'Total confirmed') === confirmed.n);
  const g = await db.all(
    `SELECT u.gender AS g, COUNT(*) AS n FROM registrations r LEFT JOIN users u ON u.phone_number = r.phone_number
      WHERE r.bank_status = 'BANK_VERIFIED' GROUP BY u.gender`);
  const gc = Object.fromEntries(g.map((x) => [x.g, x.n]));
  check('female delegates', value(rep, 'Confirmed delegates', 'Female') === (gc.Female || 0));
  check('male delegates', value(rep, 'Confirmed delegates', 'Male') === (gc.Male || 0));
  const abs = await db.get('SELECT COUNT(*) AS n FROM abstracts');
  check('abstracts submitted', value(rep, 'Abstracts', 'Abstracts submitted') === abs.n,
    [value(rep, 'Abstracts', 'Abstracts submitted'), abs.n]);

  console.log('\n== ...and match the Overview exactly ==');
  // One helper computes both, so they cannot drift; this proves it.
  const overview = await call('GET', '/api/admin/finance-summary', null, admin);
  check('collected matches the Overview card',
    rupeesToNumber(value(rep, 'Money', 'Collected — verified payments', 2)) === Math.round(overview.body.collected),
    [value(rep, 'Money', 'Collected — verified payments', 2), overview.body.collected]);
  check('outstanding matches the Overview card',
    rupeesToNumber(value(rep, 'Money', 'Outstanding — balances due', 2)) === Math.round(overview.body.outstanding),
    [value(rep, 'Money', 'Outstanding — balances due', 2), overview.body.outstanding]);
  check('...and so does the number of registrations owing',
    value(rep, 'Money', 'Outstanding — balances due', 1) === overview.body.owingCount);

  console.log('\n== Programme occupancy counts seats the way the app does ==');
  // Faculty hold a place on a roster without taking a delegate's seat.
  const groups = await call('GET', '/api/admin/program-groups', null, admin);
  const opts = (groups.body.groups || []).flatMap((gr) => (gr.options || []).map((o) => ({ ...o, group: gr.name })));
  const occ = section(rep, 'Programme occupancy');
  const sample = opts.find((o) => o.active !== 0);
  if (sample && occ) {
    const row = occ.rows.find((r) => r[0] === sample.group && r[1] === sample.name);
    check('an option\'s enrolled count is the app\'s, faculty excluded',
      !!row && row[2] === Number(sample.enrolled || 0), [row, sample.enrolled]);
    check('...and seats left is capacity minus enrolled',
      !!row && row[4] === Math.max(0, Number(sample.capacity) - Number(sample.enrolled || 0)), row);
  }

  console.log('\n== Each role sees only what it may already see ==');
  const as = {};
  for (const [role, phone] of Object.entries(STAFF)) as[role] = await loginPassword(phone, ADMIN_PW);

  const desk = await get(as.FRONT_DESK);
  check('the Front Desk, which holds no report key, is refused', desk.status === 403, desk.status);

  const fin = (await get(as.FINANCE_ADMIN)).body.report;
  check('Finance Admin sees money', names(fin).includes('Money'), names(fin));
  check('...and registrations, delegates and programmes', ['Registrations', 'Confirmed delegates', 'Programme occupancy']
    .every((n) => names(fin).includes(n)), names(fin));
  check('...but not abstracts, which it has no report for', !names(fin).includes('Abstracts'));
  check('...nor accounts', !names(fin).includes('Accounts'));

  const ops = (await get(as.OPERATIONS)).body.report;
  // The decision this test exists to hold: conference-wide money is for
  // finance roles. Operations may open the Payments line list, but does not
  // hold payments.view_totals, so it gets no totals here.
  check('Operations sees NO money block', !names(ops).includes('Money'), names(ops));
  check('...nor the collected-by-method table', !names(ops).includes('Collected by payment method'));
  check('...and no rupee figure anywhere', !JSON.stringify(ops).includes('₹'));
  check('...but does see registrations, delegates, programmes, abstracts and accounts',
    ['Registrations', 'Confirmed delegates', 'Programme occupancy', 'Abstracts', 'Accounts']
      .every((n) => names(ops).includes(n)), names(ops));

  const rev = (await get(as.ACADEMIC_REVIEWER)).body.report;
  check('an Academic Reviewer sees the abstracts block', names(rev).includes('Abstracts'), names(rev));
  check('...and nothing else', names(rev).length === 1, names(rev));
  check('...so no money and no registration counts', !JSON.stringify(rev).includes('₹')
    && !names(rev).includes('Registrations'));

  const both = (await get(as.FINANCE_ACADEMIC)).body.report;
  check('Finance & Academic sees money and abstracts, as the union of the two',
    names(both).includes('Money') && names(both).includes('Abstracts'), names(both));
  check('...but not accounts', !names(both).includes('Accounts'));

  console.log('\n== Every format says what it is ==');
  check('the Excel download is CSV', /text\/csv/.test(csv.headers['content-type'] || ''), csv.headers['content-type']);
  check('...carrying the blocks', /Registrations/.test(String(csv.body)) && /Money/.test(String(csv.body)));
  check('the printable page says these are summary figures',
    /Summary figures — no individual records/.test(String(html.body)));
  check('...and does not claim to hold records', !/\d+ record\(s\)/.test(String(html.body)));
  check('...nor count lines beside each heading', !/<h2>Money <span class="count">/.test(String(html.body)));
  check('...and keeps the print setup every report has', /@page\{size:A4 landscape;margin:12mm;\}/.test(String(html.body)));

  console.log('\n== A share never states something false at the edges ==');
  // One rejection in 240 rounds to "0%" and reads as none; 239 confirmed of
  // 240 rounds to "100%" and reads as all. Both happened on the live data the
  // first time this report was rendered. The function is lifted from the
  // server source and run as it is, so this is the code that ships.
  const src = require('fs').readFileSync(require('./harness').appFile('server.js'), 'utf8');
  const fnSrc = src.slice(src.indexOf('function summaryShare'), src.indexOf('async function computeFinanceTotals'));
  // eslint-disable-next-line no-new-func
  const summaryShare = new Function(`${fnSrc}; return summaryShare;`)();
  check('a small but real count is "<1%", not "0%"', summaryShare(1, 240) === '<1%', summaryShare(1, 240));
  check('nearly all is ">99%", not "100%"', summaryShare(239, 240) === '>99%', summaryShare(239, 240));
  check('none is still "0%"', summaryShare(0, 240) === '0%', summaryShare(0, 240));
  check('all is still "100%"', summaryShare(240, 240) === '100%', summaryShare(240, 240));
  check('ordinary shares round normally', summaryShare(120, 240) === '50%' && summaryShare(2, 3) === '67%',
    [summaryShare(120, 240), summaryShare(2, 3)]);
  check('an empty whole is a dash, not "NaN%"', summaryShare(5, 0) === '—', summaryShare(5, 0));
  check('the report uses it, not a rounding of its own', /const share = summaryShare;/.test(src));
  // And across the report actually served: no nonzero count beside "0%".
  const falseZero = rep.sections.filter((sec) => sec.columns[2] === 'Share')
    .flatMap((sec) => sec.rows.filter((r) => Number(r[1]) > 0 && r[2] === '0%').map((r) => `${sec.name}: ${r[0]}`));
  check('no nonzero count anywhere is shown as "0%"', falseZero.length === 0, falseZero);

  db.close();
  report();
})();
