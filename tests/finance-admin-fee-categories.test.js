// Reported bug: "Finance Admin is not able to verify the ID. The ID
// Verification section is missing." -- confirmed to predate the roles
// migration (GET /api/admin/fees was SUPER_ADMIN-only in the original
// server.js, unrelated to any of this session's phases).
//
// The client's ensureReviewCategories() fetches that route to learn which
// categories require a student ID. Refused with a 403, .json() on the
// response still succeeds (Express returns a normal JSON error body), so
// `data.categories` is simply undefined and the client silently treats it as
// an empty list -- no throw, no console error, nothing to notice. Every
// category then reads as "not a student category", so the whole ID
// Verification section (and the category-correction picker, and both
// discount-scope pickers, which read the same list) renders as if it simply
// doesn't apply, for every registration, forever.
//
// Fixed by granting Finance Admin masters.fees_view -- read-only,
// masters.fees_manage (the actual edit controls) is untouched -- and this
// test drives the real client code against the real server response, not
// just the permission grant in isolation.
const { call, check, report, loginPassword, openDb, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

(async () => {
  const db = openDb();
  const financeCookie = await loginPassword('9000000002', 'harness-admin-pw');

  console.log('\n== The dependency itself is unblocked ==');
  const feesRes = await call('GET', '/api/admin/fees', null, financeCookie);
  check('Finance Admin can now read the fee category list', feesRes.status === 200, feesRes.status);
  check('...and it actually carries categories', (feesRes.body.categories || []).length > 0, feesRes.body);
  const studentCat = (feesRes.body.categories || []).find((c) => c.requires_student_id);
  check('...including one that requires a student ID', !!studentCat, feesRes.body.categories);

  console.log('\n== Finance Admin still cannot EDIT a fee ==');
  // masters.fees_manage is the actual write permission, and stays untouched
  // -- this is a read grant, not a policy change about who sets fees.
  if (studentCat) {
    const edit = await call('PUT', `/api/admin/fees/categories/${studentCat.id}`,
      { label: studentCat.label, earlyFee: 1, regularFee: 1, lateFee: 1, spotFee: 1 }, financeCookie);
    check('editing a fee category is still refused', edit.status === 403, edit.status);
  } else {
    check('(no student category in the fixture to test against)', true);
  }

  console.log('\n== The real bug: the ID Verification section, driven for real ==');
  // A genuine student registration from the shared fixture.
  const reg = await db.get(`
    SELECT r.id, r.category_key, r.id_verified FROM registrations r
    JOIN fee_categories c ON c.category_key = r.category_key
    WHERE c.requires_student_id = 1 LIMIT 1`);
  check('the fixture has a student registration to test with', !!reg, reg);

  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  const makeSandbox = () => {
    const els = {};
    const el = (id) => ({
      id, innerText: '', innerHTML: '', className: '', value: '', style: {}, dataset: {}, checked: false,
      classList: {
        c: new Set(),
        add(k) { this.c.add(k); }, remove(k) { this.c.delete(k); },
        toggle(k, on) { on === undefined ? (this.c.has(k) ? this.c.delete(k) : this.c.add(k)) : (on ? this.c.add(k) : this.c.delete(k)); },
        contains(k) { return this.c.has(k); },
      },
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
      setAttribute() {}, getAttribute() { return null; }, focus() {}, click() {}, appendChild() {},
    });
    const doc = {
      getElementById: (id) => els[id] || (els[id] = el(id)),
      querySelector: () => el('q'), querySelectorAll: () => [],
      addEventListener() {}, createElement: () => el('c'),
      body: el('body'), documentElement: el('html'), readyState: 'loading', cookie: '',
    };
    const sandbox = {
      document: doc,
      window: { addEventListener() {}, location: { href: '', pathname: '/admin', search: '' }, matchMedia: () => ({ matches: false, addEventListener() {} }) },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      navigator: { userAgent: 'node' },
      // The real fetch, hitting the real running server as Finance Admin --
      // this is the actual bug's failure mode, reproduced, not simulated.
      fetch: (url, opts) => new Promise((resolve, reject) => {
        const http = require('http');
        const { HOST, PORT } = require('./harness');
        const req = http.request({ host: HOST, port: PORT, path: url, method: (opts && opts.method) || 'GET',
          headers: { Cookie: financeCookie, ...(opts && opts.headers) } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
        });
        req.on('error', reject);
        if (opts && opts.body) req.write(opts.body);
        req.end();
      }),
      console: { log() {}, warn() {}, error() {}, info() {} },
      setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON,
      requestAnimationFrame: (f) => setTimeout(f, 0),
    };
    sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    return { sandbox, els };
  };

  const { sandbox, els } = makeSandbox();
  const driver = `var __RESULT__ = ensureReviewCategories().then(function(cats) {
    return { count: cats.length, isStudent: isStudentCategory(${JSON.stringify(reg.category_key)}) };
  });`;
  vm.runInContext(js + '\n' + driver, sandbox, { filename: 'app.js' });
  const result = await sandbox.__RESULT__;

  check('ensureReviewCategories() gets real data, not an empty list (this was the actual bug)',
    result.count > 0, result);
  check('isStudentCategory() correctly identifies this registration\'s category',
    result.isStudent === true, result);

  // renderReviewIdVerification itself, un-hiding the section.
  const driver2 = `renderReviewIdVerification({ category_key: ${JSON.stringify(reg.category_key)}, id_verified: ${!!reg.id_verified} });`;
  vm.runInContext(driver2, sandbox, { filename: 'app.js' });
  check('the ID Verification section is shown, not hidden',
    !els['review-idverify-wrap'].classList.contains('hidden'), els['review-idverify-wrap'].classList.c);

  console.log('\n== The other two screens fed by the same list ==');
  const driver3 = `var __CATS__ = ensureReviewCategories();`;
  const { sandbox: s2 } = makeSandbox();
  vm.runInContext(js + '\n' + driver3, s2, { filename: 'app.js' });
  const cats = await s2.__CATS__;
  check('the category list Discount Codes and Group Discount both read from is populated too',
    cats.length > 0, cats.length);

  db.close();
  report();
})();
