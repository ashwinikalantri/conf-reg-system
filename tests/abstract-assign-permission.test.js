// Abstract review is two steps in the UI -- Step 1 Approval (accept, reject,
// request corrections) and Step 2 Assignment (oral vs poster) -- but both were
// guarded by one permission, abstracts.review, whose own description admitted
// it: "Accept, reject or allocate an abstract."
//
// Assignment is now abstracts.assign, held by Super Admin only and INDEPENDENT
// of review: a role may hold either without the other, so an assign-only
// programme chair is expressible. This deliberately narrows ACADEMIC_REVIEWER
// and FINANCE_ACADEMIC, which is recorded in permission-catalogue's
// NARROWED_SINCE_BASELINE.
//
// Worth knowing while reading this: the allocation route is also what emails
// the author. Accepting an abstract tells them nothing; the decision reaches
// them when a format is set. So this permission controls the notification as
// well as the format.
const { call, check, report, appFile, loginPassword, ADMIN_PW, openDb } = require('./harness');
const fs = require('fs');
const vm = require('vm');
const perms = require('../permissions');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');

(async () => {
  console.log('\n== The permission exists and is its own thing ==');
  // PERMISSIONS is exported as objects, not the raw [key, section, ...] rows
  // the file is written as.
  const byKey = (k) => perms.PERMISSIONS.find((x) => x.key === k);
  const entry = byKey('abstracts.assign');
  check('abstracts.assign is catalogued', !!entry, perms.PERMISSION_KEYS.filter((k) => k.startsWith('abstracts')));
  check('...in the abstracts section', entry && entry.section === 'abstracts', entry && entry.section);
  check('...with a label and a real description',
    entry && entry.label.length > 0 && entry.description.length > 20, entry && entry.description);
  check('review no longer claims to allocate',
    !/allocate/i.test((byKey('abstracts.review') || {}).description || ''),
    (byKey('abstracts.review') || {}).description);

  console.log('\n== The two writes are guarded separately ==');
  check('accept/reject stays on abstracts.review',
    perms.permissionForRoute('PUT /api/abstracts/:id/status') === 'abstracts.review');
  check('assignment moved to abstracts.assign',
    perms.permissionForRoute('PUT /api/abstracts/:id/allocation') === 'abstracts.assign');
  check('reading is unaffected',
    perms.permissionForRoute('GET /api/abstracts') === 'abstracts.view');

  console.log('\n== Who holds it ==');
  check('Super Admin does', perms.roleCan('SUPER_ADMIN', 'abstracts.assign'));
  check('Academic Reviewer does not', !perms.roleCan('ACADEMIC_REVIEWER', 'abstracts.assign'));
  check('...but keeps accept/reject', perms.roleCan('ACADEMIC_REVIEWER', 'abstracts.review'));
  check('Finance & Academic follows Academic Reviewer, being their union',
    !perms.roleCan('FINANCE_ACADEMIC', 'abstracts.assign')
    && perms.roleCan('FINANCE_ACADEMIC', 'abstracts.review'));
  // The two keys must not be welded together by accident: nothing should
  // require holding review in order to assign.
  check('neither key implies the other in the catalogue',
    perms.PERMISSION_KEYS.includes('abstracts.assign') && perms.PERMISSION_KEYS.includes('abstracts.review'));

  console.log('\n== The running app enforces it, not just the catalogue ==');
  const db = openDb({ readOnly: true });
  const pending = await db.get("SELECT id FROM abstracts WHERE status='ACCEPTED' AND allocation IS NULL LIMIT 1");
  const anyAbs = await db.get('SELECT id FROM abstracts LIMIT 1');
  db.close();
  check('the fixture has an accepted, unassigned abstract to work with', !!pending, pending);

  const reviewer = await loginPassword('9000000003', ADMIN_PW);   // ACADEMIC_REVIEWER
  const superAdmin = await loginPassword('9000000001', ADMIN_PW); // SUPER_ADMIN
  check('the Academic Reviewer signs in', !!reviewer);
  check('the Super Admin signs in', !!superAdmin);

  if (reviewer && anyAbs) {
    const st = await call('PUT', `/api/abstracts/${anyAbs.id}/status`, { status: 'UNDER_REVIEW' }, reviewer);
    check('a reviewer may still set status', st.status !== 403, st.status);
    const al = await call('PUT', `/api/abstracts/${anyAbs.id}/allocation`, { allocation: 'ORAL' }, reviewer);
    check('...but is refused the format', al.status === 403, al.status);
  }

  if (superAdmin && pending) {
    // Put it back to ACCEPTED first: the probe above may have reset it, and
    // the route refuses to assign a format to anything not accepted.
    await call('PUT', `/api/abstracts/${pending.id}/status`, { status: 'ACCEPTED' }, superAdmin);
    const al = await call('PUT', `/api/abstracts/${pending.id}/allocation`, { allocation: 'POSTER' }, superAdmin);
    check('a Super Admin may assign', al.status === 200 && al.body.success === true, al.body);

    const db2 = openDb({ readOnly: true });
    const row = await db2.get('SELECT allocation FROM abstracts WHERE id = ?', [pending.id]);
    const audit = await db2.get(
      "SELECT action FROM audit_log WHERE entity_type='abstract' AND entity_id=? AND action='ABSTRACT_ALLOCATION' ORDER BY id DESC LIMIT 1",
      [String(pending.id)]);
    db2.close();
    check('...and it lands on the record', row && row.allocation === 'POSTER', row);
    check('...and is audited', !!audit, audit);
  }

  console.log('\n== The Assignment step is hidden from anyone who cannot use it ==');
  // Before this, the abstracts UI had no button-level gating at all: anyone
  // with abstracts.view saw live Oral/Poster buttons, and the click handler
  // never read the response -- so a refusal did nothing visible.
  function visibilityFor(permissions) {
    const els = {};
    const mk = (id) => (els[id] = els[id] || {
      id, className: '', textContent: '', innerHTML: '', value: '',
      classList: { c: new Set(), add(k) { this.c.add(k); }, remove(k) { this.c.delete(k); },
        toggle(k, on) { on ? this.c.add(k) : this.c.delete(k); }, contains(k) { return this.c.has(k); } },
      dataset: {}, style: {}, setAttribute() {}, getAttribute: () => null,
      appendChild() {}, remove() {}, addEventListener() {}, focus() {}, select() {},
      querySelector: () => null, querySelectorAll: () => [],
    });
    const doc = {
      getElementById: (id) => mk(id),
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, createElement: () => mk('c'),
      body: mk('body'), documentElement: mk('html'), readyState: 'loading', cookie: '',
    };
    const sandbox = {
      document: doc,
      window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
        matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      navigator: { userAgent: 'node' },
      fetch: () => Promise.reject(new Error('no network')),
      console: { log() {}, warn() {}, error() {}, info() {} },
      setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON, Promise,
      requestAnimationFrame: (f) => setTimeout(f, 0),
    };
    sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    // myPermissions/mySections are top-level `let`s, so they have to be set
    // from inside the same script -- assigning them on the sandbox object
    // would make unrelated globals and leave the real bindings empty.
    sandbox.__PERMS__ = permissions;
    vm.runInContext(
      `${js}\nmyPermissions = new Set(__PERMS__);\nmySections = { abstracts: true };\napplyRoleVisibility();\n`,
      sandbox, { filename: 'app.js+driver' });
    mk('abstracts-assignment-block');
    return els;
  }

  const withAssign = visibilityFor(['abstracts.view', 'abstracts.review', 'abstracts.assign']);
  check('a Super Admin sees Step 2',
    !withAssign['abstracts-assignment-block'].classList.contains('hidden'));

  const reviewOnly = visibilityFor(['abstracts.view', 'abstracts.review']);
  check('a reviewer without the permission does not',
    reviewOnly['abstracts-assignment-block'].classList.contains('hidden'));
  check('...and still gets the Abstracts tab itself',
    !reviewOnly['nav-tab-abstracts'].classList.contains('hidden'));

  // The independence claim, from the other side: assignment alone is enough
  // to see the step.
  const assignOnly = visibilityFor(['abstracts.view', 'abstracts.assign']);
  check('an assign-only role sees Step 2 without holding review',
    !assignOnly['abstracts-assignment-block'].classList.contains('hidden'));

  report();
})();
