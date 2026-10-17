// The Attendance tab, the workshop master's dates and the portal's
// Attendance & Certificate card, as drawn: app.js run whole against the real
// test server, with just enough of a page to draw into.
const { call, check, report, adminLogin, appFile, openDb } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const N = String(Date.now()).slice(-7);

function page(cookie, perms) {
  const els = new Map();
  const classList = () => ({
    _s: new Set(),
    add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
    toggle(c, on) { const want = on === undefined ? !this._s.has(c) : !!on; if (want) this._s.add(c); else this._s.delete(c); return want; },
    contains(c) { return this._s.has(c); },
  });
  const el = (id) => {
    if (!els.has(id)) {
      const e = { id, value: '', innerHTML: '', textContent: '', src: '', dataset: {}, style: {}, disabled: false, checked: false,
        setAttribute() {}, getAttribute: () => null, addEventListener() {}, focus() {}, querySelectorAll: () => [], querySelector: () => null };
      e.classList = classList();
      els.set(id, e);
    }
    return els.get(id);
  };
  const toasts = [];
  const sandbox = {
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: () => el(`tmp${Math.random()}`), body: el('body'), documentElement: el('html'), readyState: 'loading', cookie: '' },
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '', origin: 'https://portal.example' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: async (url, opts = {}) => {
      const r = await call(opts.method || 'GET', url, opts.body ? JSON.parse(opts.body) : null, cookie);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval, URL, URLSearchParams, Intl, Date, Math, JSON, Promise, requestAnimationFrame: () => 0,
    __toasts: toasts,
  };
  sandbox.window.document = sandbox.document; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${js}
    myPermissions = new Set(${JSON.stringify(perms)});
    conferenceInfo = { name: 'Fixture Conference', acronym: 'FIXCON', location: 'Sevagram', startDate: '2026-11-21', endDate: '2026-11-22' };
    showToast = (m, t) => globalThis.__toasts.push([m, t]);
    globalThis.__f = { renderAttendance, attendanceSignIn, renderBackendPrograms, loadAttendanceCard, saveCertificateDetails, switchAttendanceView };`, sandbox);
  return { el, f: sandbox.__f, toasts };
}

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const option = await db.get(`SELECT o.id, o.name, o.session_date, o.start_time, o.end_time FROM program_options o JOIN program_groups g ON g.id = o.group_id
    WHERE g.name = 'Workshops' AND o.active = 1 LIMIT 1`);
  let phone = null;
  let regId = null;
  try {
    await db.run("UPDATE program_options SET session_date = ?, start_time = '00:00', end_time = '23:59' WHERE id = ?", [today, option.id]);

    console.log('\n== The Attendance tab ==');
    const A = page(admin, ['attendance.mark', 'attendance.view', 'attendance.manage']);
    await A.f.renderAttendance();
    check('the picker lists the workshop, open now, and starts on it', A.el('att-event').innerHTML.includes(`${option.name}`) && A.el('att-event').value === `ws:${option.id}:IN`
      && /open now/.test(A.el('att-event').innerHTML));
    check('...saying it is open', /Open now/.test(A.el('att-window').textContent));
    check('the counts are drawn', A.el('att-summary').innerHTML.includes(option.name) && /have completed the conference/.test(A.el('att-completed').textContent));
    check('the roster is drawn for the chosen event', /expected are in/.test(A.el('att-roster-count').textContent));
    check('scanning and the screen are offered to someone who takes attendance', !A.el('att-take').classList.contains('hidden') && !A.el('att-screen-btn').classList.contains('hidden'));
    const res = await A.f.attendanceSignIn('NO-SUCH-PERSON-1');
    check('a failed sign-in is shown, large', res.success === false && /✕/.test(A.el('att-result').innerHTML));
    const viewer = page(admin, ['attendance.view']);
    await viewer.f.renderAttendance();
    check('a role that only watches gets the counts, not the scanner', viewer.el('att-take').classList.contains('hidden') && !viewer.el('att-summary-card').classList.contains('hidden'));

    console.log('\n== Certificates and their settings ==');
    const C = page(admin, ['certificates.view', 'certificates.issue', 'certificates.manage']);
    await C.f.switchAttendanceView('certificates');
    check('the certificates view: the counts, the list, the issue buttons', /MMC points/.test(C.el('cert-stats').innerHTML)
      && /Showing \d+ of \d+/.test(C.el('cert-count').textContent) && /Issue conference certificates \(\d+ due\)/.test(C.el('cert-issue-conf').textContent));
    await C.f.switchAttendanceView('settings');
    check('the settings view: MMC details, categories, signatories and each kind\'s wording', /X/.test(C.el('cs-mmc-no').value)
      && /class="cs-category" value="faculty_mo" checked/.test(C.el('cs-categories').innerHTML)
      && /MMC Observer/.test(C.el('cs-signatories').innerHTML) && (C.el('cs-templates').innerHTML.match(/Preview specimen/g) || []).length === 3);
    check('...and the attendance hours', C.el('cs-day-start').value === '08:00' && C.el('cs-out-until').value === '18:00');

    console.log('\n== Programs: when each workshop runs ==');
    await A.f.renderBackendPrograms();
    const prog = A.el('program-groups-admin-container').innerHTML;
    check('a workshop row has its date and times to set', new RegExp(`class="prog-date[^"]*" data-id="${option.id}"`).test(prog) && prog.includes(`value="${today}"`));
    check('...and the group its attendance switch, on', /class="group-attendance" data-id="\d+" checked/.test(prog));
    check('a QI practice has no times to set (its group takes no attendance)', (prog.match(/class="prog-date/g) || []).length === (await db.get(
      `SELECT COUNT(*) AS n FROM program_options o JOIN program_groups g ON g.id = o.group_id WHERE g.name LIKE '%Workshop%'`)).n);

    console.log('\n== The portal card ==');
    const email = `att-card-${N}@example.test`;
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const signed = await call('POST', '/api/auth/register', { salutation: 'Dr', age: '40', gender: 'Male', designation: 'Professor', institute: 'Test College', pincode: '442102', state: 'Maharashtra', district: 'Wardha', name: `Card Holder ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    phone = signed.body.user.phone_number;
    const P0 = page(signed.cookie, []);
    await P0.f.loadAttendanceCard();
    check('not registered: no card', P0.el('attendance-card').classList.contains('hidden'));
    regId = (await db.run("INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status) VALUES (?, ?, 'faculty_mo', 'Doctor', 'BANK_VERIFIED')", [phone, `Card Holder ${N}`])).lastID;
    const P = page(signed.cookie, []);
    await P.f.loadAttendanceCard();
    check('registered: the card, with the days to sign into', !P.el('attendance-card').classList.contains('hidden') && /○/.test(P.el('attendance-list').innerHTML) && /Attendance in progress/.test(P.el('attendance-status').textContent));
    check('...their name filled in, ready to correct', P.el('cert-name').value === `Dr Card Holder ${N}`);
    check('...and, a doctor, asked for their council number', !P.el('cert-council-wrap').classList.contains('hidden'));
    P.el('cert-council').value = 'Maharashtra Medical Council';
    P.el('cert-council-no').value = '2015/04/5678';
    await P.f.saveCertificateDetails({ preventDefault() {} });
    const u = await db.get('SELECT certificate_name, council_name, council_reg_no FROM users WHERE phone_number = ?', [phone]);
    check('saving an unchanged name keeps following their profile, not a copy', u.certificate_name === null && u.council_reg_no === '2015/04/5678', u);
    check('...and says it saved', P.toasts.some(([m]) => /saved/.test(m)));
  } finally {
    await db.run('UPDATE program_options SET session_date = ?, start_time = ?, end_time = ? WHERE id = ?', [option.session_date, option.start_time, option.end_time, option.id]);
    if (regId) await db.run('DELETE FROM registrations WHERE id = ?', [regId]);
  }
  db.close();
  report();
})().catch((e) => { console.error(e); process.exit(1); });
