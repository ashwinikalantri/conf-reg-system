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
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} }, scrollTo() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: async (url, opts = {}) => {
      const r = await call(opts.method || 'GET', url, opts.body ? JSON.parse(opts.body) : null, cookie);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval, URL, URLSearchParams, Intl, Date, Math, JSON, Promise, requestAnimationFrame: () => 0,
    scrollTo() {}, __toasts: toasts,
  };
  sandbox.window.document = sandbox.document; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${js}
    myPermissions = new Set(${JSON.stringify(perms)});
    conferenceInfo = { name: 'Fixture Conference', acronym: 'FIXCON', location: 'Sevagram', startDate: '2026-11-21', endDate: '2026-11-22' };
    showToast = (m, t) => globalThis.__toasts.push([m, t]);
    globalThis.__f = { renderAttendance, attendanceSignIn, renderBackendPrograms, loadAttendanceCard, saveCertificateDetails, switchAttendanceView, renderProgramme,
      renderProgrammeSessions, editProgrammeSession, loadProgrammeCard, renderBadge, showAbstractCard,
      openProgrammePage, renderHomeHero };
    globalThis.__setReg = (r) => { currentRegistration = r; };
    globalThis.__setDelegate = (d) => { currentDelegate = d; };`, sandbox);
  return { el, f: sandbox.__f, toasts, sb: sandbox };
}

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const option = await db.get(`SELECT o.id, o.name FROM program_options o JOIN program_groups g ON g.id = o.group_id
    WHERE g.name = 'Workshops' AND o.active = 1 LIMIT 1`);
  let phone = null;
  let regId = null;
  const hallId = (await db.run("INSERT INTO halls (name, code, sort_order, active, created_at) VALUES (?, ?, 0, 1, ?)", [`Client Hall ${N}`, `CL${N}`.slice(0, 9), Date.now()])).lastID;
  const roomId = (await db.run("INSERT INTO halls (name, code, sort_order, active, created_at) VALUES (?, ?, 1, 1, ?)", [`Client Room ${N}`, `CR${N}`.slice(0, 9), Date.now()])).lastID;
  const ins = (title, extra = {}) => db.run(`INSERT INTO programme_sessions (hall_id, session_date, start_time, end_time, label, title, speakers, chairs, counts, option_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [extra.hall || hallId, extra.date || today, extra.start || '00:00', extra.end || '23:59', extra.label || null, title,
    extra.speakers || null, null, extra.counts === 0 ? 0 : 1, extra.optionId || null, Date.now()]).then((r) => r.lastID);
  const talk = await ins(`Client Talk ${N}`, { label: 'Session 1', speakers: 'Dr Speaker' });
  const ws = await ins(`Client Workshop ${N}`, { optionId: option.id, hall: roomId });
  try {
    console.log('\n== The Attendance tab ==');
    const A = page(admin, ['attendance.mark', 'attendance.view', 'attendance.manage', 'programme.manage']);
    await A.f.renderAttendance();
    check('the hall picker lists the hall, with something on now', A.el('att-hall').innerHTML.includes(`Client Hall ${N} — on now`));
    A.el('att-hall').value = String(hallId);
    await A.f.renderAttendance();
    check('...and says what is on there', A.el('att-now').innerHTML.includes(`Client Talk ${N}`) && /On now/.test(A.el('att-now').innerHTML));
    check('the counts, session by session, for today', A.el('att-summary').innerHTML.includes(`Client Talk ${N}`) && /have completed the conference/.test(A.el('att-completed').textContent));
    check('who was present at the chosen session', /present/.test(A.el('att-roster-count').textContent));
    check('marking by hand is offered to a role that may', !A.el('att-manual').classList.contains('hidden'));
    const res = await A.f.attendanceSignIn('NO-SUCH-PERSON-1');
    check('a failed scan is shown, large', res.success === false && /✕/.test(A.el('att-result').innerHTML));
    const viewer = page(admin, ['attendance.view']);
    await viewer.f.renderAttendance();
    check('a role that only watches gets the counts, not the scanner', viewer.el('att-take').classList.contains('hidden') && !viewer.el('att-summary-card').classList.contains('hidden'));

    console.log('\n== The programme ==');
    await A.f.renderProgramme(); // its own Settings page, no longer a view of Attendance
    check('the halls, each with its poster', A.el('prog-halls').innerHTML.includes(`Client Hall ${N}`) && new RegExp(`posters\\.pdf\\?hall=${hallId}`).test(A.el('prog-halls').innerHTML));
    A.el('prog-day').value = today;
    A.f.renderProgrammeSessions();
    check('the day\'s sessions, a workshop\'s named', A.el('prog-sessions').innerHTML.includes(`Client Talk ${N}`) && A.el('prog-sessions').innerHTML.includes(`Workshop: ${option.name}`));
    A.f.editProgrammeSession(talk);
    check('editing one fills the form', A.el('ps-title').value === `Client Talk ${N}` && A.el('ps-label').value === 'Session 1' && A.el('ps-counts').checked === true
      && !A.el('prog-session-form').classList.contains('hidden'));

    console.log('\n== Certificates and their settings ==');
    const C = page(admin, ['certificates.view', 'certificates.issue', 'certificates.manage']);
    await C.f.switchAttendanceView('certificates');
    check('the certificates view: the counts, the list, the issue buttons', /MMC points/.test(C.el('cert-stats').innerHTML)
      && /Showing \d+ of \d+/.test(C.el('cert-count').textContent) && /Issue conference certificates \(\d+ due\)/.test(C.el('cert-issue-conf').textContent));
    await C.f.switchAttendanceView('settings');
    check('the settings view: MMC details, categories, signatories and each kind\'s wording', /X/.test(C.el('cs-mmc-no').value)
      && /class="cs-category" value="faculty_mo" checked/.test(C.el('cs-categories').innerHTML)
      && /MMC Observer/.test(C.el('cs-signatories').innerHTML) && (C.el('cs-templates').innerHTML.match(/Preview specimen/g) || []).length === 3);
    check('...and when lunch starts and marking opens', C.el('cs-lunch').value === '13:00' && Number(C.el('cs-early').value) === 15);

    console.log('\n== Programs ==');
    await A.f.renderBackendPrograms();
    const prog = A.el('program-groups-admin-container').innerHTML;
    check('no dates in Programs any more -- they are in the programme', !/class="prog-date/.test(prog));
    check('the Workshops group\'s switch, on', /class="group-attendance" data-id="\d+" checked/.test(prog));

    console.log('\n== The delegate page ==');
    const email = `att-card-${N}@example.test`;
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const signed = await call('POST', '/api/auth/register', { salutation: 'Dr', age: '40', gender: 'Male', designation: 'Professor', institute: 'Test College', pincode: '442102', state: 'Maharashtra', district: 'Wardha', name: `Card Holder ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    phone = signed.body.user.phone_number;
    const P0 = page(signed.cookie, []);
    await P0.f.loadAttendanceCard();
    check('not registered: no attendance card', P0.el('attendance-card').classList.contains('hidden'));
    regId = (await db.run("INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, registration_number) VALUES (?, ?, 'faculty_mo', 'Doctor', 'BANK_VERIFIED', ?)", [phone, `Dr Card Holder ${N}`, `CH${N}`])).lastID;
    await db.run("INSERT INTO attendance (phone_number, event_key, at, method) VALUES (?, ?, ?, 'SELF')", [phone, `s:${talk}`, Date.now()]);
    const P = page(signed.cookie, []);
    await P.f.loadAttendanceCard();
    check('weeks before the conference: the card is the certificate details alone', !P.el('attendance-card').classList.contains('hidden')
      && P.el('attendance-list').classList.contains('hidden') && P.el('attendance-intro').classList.contains('hidden') && P.el('attendance-title').textContent === 'Certificate');
    await call('PUT', '/api/admin/certificates/settings', { attendance: { showFrom: '2020-01-01' } }, admin);
    await P.f.loadAttendanceCard();
    check('from the day set, attendance shows: part by part towards the certificate', !P.el('attendance-list').classList.contains('hidden')
      && /Conference: /.test(P.el('attendance-list').innerHTML) && P.el('attendance-title').textContent === 'Attendance & certificate');
    check('...the sessions they were present at', P.el('attendance-session-list').innerHTML.includes(`Client Talk ${N}`) && !P.el('attendance-sessions').classList.contains('hidden'));
    check('...their name filled in, ready to correct', P.el('cert-name').value === `Dr Card Holder ${N}`);
    check('...and, a doctor, asked for their council number', !P.el('cert-council-wrap').classList.contains('hidden'));
    P.el('cert-council').value = 'Maharashtra Medical Council';
    P.el('cert-council-no').value = '2015/04/5678';
    await P.f.saveCertificateDetails({ preventDefault() {} });
    const u = await db.get('SELECT certificate_name, council_name, council_reg_no FROM users WHERE phone_number = ?', [phone]);
    check('saving an unchanged name keeps following their profile, not a copy', u.certificate_name === null && u.council_reg_no === '2015/04/5678', u);
    await P.f.loadProgrammeCard();
    check('the home screen\'s programme panel: what is on now', !P.el('programme-card').classList.contains('hidden')
      && P.el('programme-now').innerHTML.includes(`Client Talk ${N}`) && /On now/.test(P.el('programme-now').innerHTML));
    P.f.openProgrammePage();
    const pageHtml = P.el('prog-page-list').innerHTML;
    check('the programme page: the day\'s talks, on now ringed, and where they were present', !P.el('programme-page').classList.contains('hidden')
      && pageHtml.includes(`Client Talk ${N}`) && /data-now="1"/.test(pageHtml) && /you are marked present/.test(pageHtml) && /Day 1/.test(P.el('prog-page-days').innerHTML));
    // As the page ships them: the action banners hidden until they apply.
    ['reverify-banner', 'balance-banner'].forEach((id) => P.el(id).classList.add('hidden'));
    P.sb.__setReg({ bank_status: 'BANK_VERIFIED', registration_number: `CH${N}` });
    P.f.renderHomeHero();
    check('the home screen leads with what matters now: on the day, what is on and the badge', !P.el('home-hero').classList.contains('hidden')
      && P.el('home-hero').innerHTML.includes(`Client Talk ${N}`) && /Show my badge/.test(P.el('home-hero').innerHTML));
    P.sb.__setReg(null);
    P.f.renderHomeHero();
    check('...before registering, the way to register', /Register and pay/.test(P.el('home-hero').innerHTML));
    P.el('balance-banner').classList.remove('hidden');
    P.sb.__setReg({ bank_status: 'PARTIAL_PAYMENT' });
    P.f.renderHomeHero();
    check('...and a balance due leads with its own banner instead', P.el('home-hero').classList.contains('hidden'));

    console.log('\n== The badge ==');
    P.f.renderBadge({ registration_number: `CH${N}`, delegate_name: `Dr Card Holder ${N}`, category_label: 'Doctor', is_faculty_member: true });
    check('the badge: name, role, number and the desk pass QR', P.el('badge-name').textContent === `Dr Card Holder ${N}` && P.el('badge-role').textContent === 'FACULTY'
      && P.el('badge-reg').textContent === `CH${N}` && P.el('desk-pass-qr').src === `/api/qr/CH${N}.png` && !P.el('desk-pass').classList.contains('hidden'));
    check('...the conference across its top', P.el('badge-acronym').textContent === 'FIXCON' && /21 - 22 Nov 2026/.test(P.el('badge-when').textContent));
    P.f.renderBadge({ registration_number: `CH${N}`, delegate_name: 'X', is_faculty_member: false });
    check('a delegate not on the faculty list: DELEGATE', P.el('badge-role').textContent === 'DELEGATE');

    console.log('\n== The abstract card ==');
    P.f.showAbstractCard(false);
    check('closed and nothing submitted: the card goes, registration takes the width', P.el('abstract-card').classList.contains('hidden') && P.el('registration-card').classList.contains('md:col-span-2'));
    P.f.showAbstractCard(true);
    check('...open again: it comes back', !P.el('abstract-card').classList.contains('hidden') && !P.el('registration-card').classList.contains('md:col-span-2'));
  } finally {
    await call('PUT', '/api/admin/certificates/settings', { attendance: { showFrom: '' } }, admin);
    if (phone) await db.run('DELETE FROM attendance WHERE phone_number = ?', [phone]);
    if (regId) await db.run('DELETE FROM registrations WHERE id = ?', [regId]);
    await db.run('DELETE FROM programme_sessions WHERE hall_id IN (?, ?)', [hallId, roomId]);
    await db.run('DELETE FROM halls WHERE id IN (?, ?)', [hallId, roomId]);
  }
  db.close();
  report();
})().catch((e) => { console.error(e); process.exit(1); });
