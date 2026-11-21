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
    globalThis.__f = { renderAttendance, attendanceSignIn, renderBackendPrograms, loadAttendanceCard, saveCertificateDetails, renderCertificates, renderCertificateSettings, setCsView, renderProgramme, loadHallsCard,
      renderProgrammeSessions, fillProgrammeHallFilter, editProgrammeSession, loadProgrammeCard, renderBadge, showAbstractCard,
      openProgrammePage, renderHomeHero, applyRegistrationState, openProfilePage, openBadgeFullScreen, dashGo };
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
    check('the counts, session by session, for today', A.el('att-summary').innerHTML.includes(`Client Talk ${N}`) && /checked in: their conference certificate is due/.test(A.el('att-completed').textContent));
    check('who was present at the chosen session', /present/.test(A.el('att-roster-count').textContent));
    check('marking by hand is offered to a role that may', !A.el('att-manual').classList.contains('hidden'));
    const res = await A.f.attendanceSignIn('NO-SUCH-PERSON-1');
    check('a failed scan is shown, large', res.success === false && /✕/.test(A.el('att-result').innerHTML));
    const viewer = page(admin, ['attendance.view']);
    await viewer.f.renderAttendance();
    check('a role that only watches gets the counts, not the scanner', viewer.el('att-take').classList.contains('hidden') && !viewer.el('att-summary-card').classList.contains('hidden'));

    console.log('\n== The programme ==');
    await A.f.loadHallsCard(); // in Conference setup, for whoever may edit the programme
    check('the halls, each with its poster', A.el('prog-halls').innerHTML.includes(`Client Hall ${N}`) && new RegExp(`posters\\.pdf\\?hall=${hallId}`).test(A.el('prog-halls').innerHTML)
      && !A.el('gs-card-halls').classList.contains('hidden'));
    await A.f.renderProgramme(); // its own Settings page, no longer a view of Attendance
    A.el('prog-day').value = today;
    A.f.fillProgrammeHallFilter(); // the day's onchange
    A.f.renderProgrammeSessions();
    check('the day\'s sessions, a workshop\'s named', A.el('prog-sessions').innerHTML.includes(`Client Talk ${N}`) && A.el('prog-sessions').innerHTML.includes(`Workshop: ${option.name}`));
    check('a Hall filter beside the day: All halls, then the day\'s halls', /<option value="">All halls \(\d+\)<\/option>/.test(A.el('prog-hall').innerHTML)
      && A.el('prog-hall').innerHTML.includes(`>Client Hall ${N}</option>`));
    A.el('prog-hall').value = String(hallId);
    A.f.renderProgrammeSessions();
    check('...choosing one lists only its sessions', A.el('prog-sessions').innerHTML.includes(`Client Talk ${N}`)
      && !/class="text-\[10px\] bg-slate-100[^>]*>(?!Client Hall)/.test(A.el('prog-sessions').innerHTML));
    A.el('prog-hall').value = '';
    A.f.renderProgrammeSessions();
    A.f.editProgrammeSession(talk);
    check('editing one fills the form', A.el('ps-title').value === `Client Talk ${N}` && A.el('ps-label').value === 'Session 1' && A.el('ps-counts').checked === true
      && !A.el('prog-session-form').classList.contains('hidden'));

    console.log('\n== Certificates (their own tab) and their settings (a Settings page) ==');
    const C = page(admin, ['certificates.view', 'certificates.issue', 'certificates.manage']);
    await C.f.renderCertificates();
    // Redesigned 21 Nov 2026: Ready to issue, a row per kind; People with tabs.
    check('the certificates view: ready to issue by kind, Issue all due, the people with their tabs', /Conference/.test(C.el('cert-ready').innerHTML) && /MMC \d+/.test(C.el('cert-ready').innerHTML)
      && /Showing \d+ of \d+/.test(C.el('cert-count').textContent) && /Issue all due · \d+/.test(C.el('cert-issue-all').textContent)
      && /setCertTab\('all'\)/.test(C.el('cert-tabs').innerHTML));
    await C.f.renderCertificateSettings();
    // Redesigned 20 Nov 2026: a "Ready to issue?" line, the parts and the
    // eleven kinds on the left, one at a time on the right.
    const rail = C.el('cs-rail').innerHTML;
    check('the settings: Ready to issue?, the shared parts and the ten kinds on the left -- no Faculty (retired 20 Nov)', /Ready to issue\?/.test(C.el('cs-ready').innerHTML)
      && ['points', 'signatories', 'design', 'rules', 'MMC', 'NURSING', 'CONF', 'WORKSHOP', 'WORKSHOP_FACULTY', 'SPEAKER', 'CHAIR', 'MODERATOR', 'PANELIST', 'JUDGE']
        .every((v) => rail.includes(`setCsView('${v}')`)) && !rail.includes("setCsView('FACULTY')"), rail.slice(0, 300));
    check('...a certificate opens first: its wording, fill-ins by name, its signatories and the preview', /id="cs-t-body"/.test(C.el('cs-pane').innerHTML)
      && /csInsert\('mmc_points'\)/.test(C.el('cs-pane').innerHTML) && /MMC Observer/.test(C.el('cs-pane').innerHTML) && /id="cs-preview/.test(C.el('cs-pane').innerHTML));
    C.f.setCsView('points');
    check('...Points: the MMC details, and the categories as toggles', /id="cs-mmc-no" value="[^"]*X/.test(C.el('cs-pane').innerHTML)
      && /aria-pressed="true" onclick="csToggleCategory\('mmc', 'faculty_mo'\)"/.test(C.el('cs-pane').innerHTML));
    C.f.setCsView('signatories');
    check('...Signatories: a card each', /MMC Observer/.test(C.el('cs-pane').innerHTML) && /cs-sig-field/.test(C.el('cs-pane').innerHTML));
    C.f.setCsView('rules');
    check('...Who qualifies: the rules in words, and when marking opens and closes', /checked in at the registration desk/.test(C.el('cs-pane').innerHTML)
      && /id="cs-early" value="30"/.test(C.el('cs-pane').innerHTML) && /id="cs-late" value="120"/.test(C.el('cs-pane').innerHTML) && /id="cs-lunch" value="13:00"/.test(C.el('cs-pane').innerHTML));

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
    check('...before registering, it steps aside: the registration panel leads', P.el('home-hero').classList.contains('hidden'));
    P.el('balance-banner').classList.remove('hidden');
    P.sb.__setReg({ bank_status: 'PARTIAL_PAYMENT' });
    P.f.renderHomeHero();
    check('...and a balance due leads with its own banner instead', P.el('home-hero').classList.contains('hidden'));

    console.log('\n== The badge ==');
    P.f.renderBadge({ registration_number: `CH${N}`, delegate_name: `Dr Card Holder ${N}`, category_label: 'Doctor', is_faculty_member: true });
    P.f.openBadgeFullScreen();
    check('the badge, full screen: name, role, number and the desk pass QR', P.el('badge-full-name').textContent === `Dr Card Holder ${N}` && P.el('badge-full-role').textContent === 'FACULTY'
      && P.el('badge-full-reg').textContent === `CH${N}` && P.el('badge-full-qr').src === `/api/qr/CH${N}.png` && !P.el('badge-full').classList.contains('hidden'));
    P.f.renderBadge({ registration_number: `CH${N}`, delegate_name: 'X', is_faculty_member: false });
    P.f.openBadgeFullScreen();
    check('a delegate not on the faculty list: DELEGATE', P.el('badge-full-role').textContent === 'DELEGATE');

    console.log('\n== One registration panel, by stage ==');
    P.f.applyRegistrationState(null);
    check('not registered: "Register for the conference", with the button', P.el('reg-kicker').textContent === 'Next step' && P.el('reg-title').textContent === 'Register for the conference'
      && !P.el('payment-action-area').classList.contains('hidden') && P.el('confirmed-block').classList.contains('hidden'));
    P.f.applyRegistrationState({ bank_status: 'PENDING', registration_number: null, selections: [] });
    check('submitted: "being verified", no button', /being verified/.test(P.el('reg-title').textContent) && /Being verified/.test(P.el('payment-status-tag').innerText || P.el('payment-status-tag').textContent));
    P.f.applyRegistrationState({ bank_status: 'BANK_VERIFIED', registration_number: `CH${N}`, category_label: 'Doctor', verified_total: 3000, expected_amount: 3000, delegate_name: `Dr Card Holder ${N}`,
      selections: [{ group_name: 'Workshops', option_name: 'Psychology of Change' }] });
    check('confirmed: "You are registered", the number, category and what was paid, their choices', P.el('reg-kicker').textContent === 'You are registered'
      && P.el('reg-title').classList.contains('hidden') && P.el('reg-number-display').innerText === `CH${N}` && P.el('reg-category-line').textContent === 'Doctor · ₹3,000 paid'
      && /Workshops<\/span><span[^>]*>Psychology of Change/.test(P.el('conf-selections').innerHTML) && !P.el('confirmed-block').classList.contains('hidden'));

    console.log('\n== The menu and the Profile page ==');
    P.sb.__setDelegate({ salutation: 'Dr', full_name: `Card Holder ${N}`, designation: 'Professor', institution: 'Test College', email: email, email_verified: 1 });
    P.f.dashGo('profile');
    const prof = P.el('profile-details').innerHTML;
    check('Profile: their details as registered', !P.el('profile-page').classList.contains('hidden') && prof.includes(`Dr Card Holder ${N}`) && prof.includes('Professor') && /verified/.test(prof));
    check('...and the certificate card lives there', /id="attendance-card"/.test(require('fs').readFileSync(require('./harness').appFile('views', 'portal', 'sections', 'dashboard.ejs'), 'utf8').split('id="profile-page"')[1] || ''));
    P.f.dashGo('home');
    P.el('dashboard-page').classList.add('hidden');
    P.f.dashGo('home');
    check('Home from the menu', !P.el('dashboard-page').classList.contains('hidden'));

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
