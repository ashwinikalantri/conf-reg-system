// Abstract submission closes after its last date.
//
// The date is a setting (Settings -> General -> Conference), not a constant,
// because deadlines get extended. Three properties carry it, each a way it
// could be built wrongly:
//
//   * The lock is the server's. The dashboard hides the button, but a
//     delegate with the form already open -- or anyone with curl -- posts
//     straight to /api/abstracts, so that is where it must be refused.
//   * "Last date 15 Sept" means all of the 15th, in India. The server clock
//     is UTC; comparing UTC dates would close submission at 05:30 IST.
//   * A resubmission the committee asked for is not a new submission. The
//     reviewer reopened it; locking it would strand an abstract the
//     committee is still waiting on.
//
// The suite runs files one at a time against one server, so this file moves
// the shared deadline -- and puts it back in `finally`, pass or fail.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const IST = 5.5 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const istDay = (offset) => new Date(Date.now() + IST + offset * DAY).toISOString().slice(0, 10);
const N = String(Date.now() % 100000000).padStart(8, '0');

const ABSTRACT = {
  format: 'Oral Paper', title: 'Deadline fixture abstract',
  background: 'Some background.', aim: 'An aim.', methods: 'A method.', results: 'A result.',
  conclusion: 'A conclusion.', keywords: 'quality, safety',
};

// A delegate who can sign in: created by the admin, given a one-time password
// by the admin, then choosing their own so nothing about the session is
// provisional.
async function makeDelegate(admin, phone, name) {
  const made = await call('POST', '/api/users', { phone, name, email: `ad-${phone}@example.test`, role: 'DELEGATE' }, admin);
  const key = made.body.user ? made.body.user.phone_number : phone;
  const reset = await call('POST', `/api/users/${key}/reset-password`, {}, admin);
  const login = await call('POST', '/api/auth/login-password', { identifier: key, password: reset.body.tempPassword });
  await call('POST', '/api/auth/set-password', { password: `own-choice-${N}` }, login.cookie);
  return { key, cookie: login.cookie, ok: (made.status === 200 || made.status === 201) && login.body.success === true };
}

(async () => {
  const admin = await adminLogin();
  const db = openDb({ readOnly: true });
  const settings = async () => (await call('GET', '/api/admin/general-settings', null, admin)).body.conference;
  const setDeadline = (d) => call('PUT', '/api/admin/general-settings', { conference: { abstractDeadline: d } }, admin);
  const original = (await settings()).abstractDeadline;

  try {
    console.log('\n== It is a setting, shown where the conference details are ==');
    check('fixture: the seeded deadline is in the future', original > istDay(0), original);
    const conf = await settings();
    check('Settings reports the deadline', conf.abstractDeadline === original, conf.abstractDeadline);
    check('...and whether submission is open right now', conf.abstractSubmissionOpen === true, conf.abstractSubmissionOpen);
    const pub = (await call('GET', '/api/conference')).body;
    check('the public conference info carries it too, for the delegate portal',
      pub.abstractDeadline === original && pub.abstractSubmissionOpen === true, pub);

    console.log('\n== Only a date is accepted, and only from whoever may edit settings ==');
    const bad = await setDeadline('15/09/2026');
    check('a malformed date is refused', bad.status === 400, [bad.status, bad.body.error]);
    check('...and nothing changed', (await settings()).abstractDeadline === original);
    const fin = await loginPassword('9000000002', ADMIN_PW);
    const byFinance = await call('PUT', '/api/admin/general-settings', { conference: { abstractDeadline: istDay(-1) } }, fin);
    check('a Finance Admin cannot move it', byFinance.status === 403, byFinance.status);
    check('...and nothing changed', (await settings()).abstractDeadline === original);

    const early = await makeDelegate(admin, `95${N}`, 'Early Author');
    const late = await makeDelegate(admin, `94${N}`, 'Late Author');
    check('fixture: two delegates who can sign in', early.ok && late.ok, [early.ok, late.ok]);

    console.log('\n== The deadline day itself is still open, to midnight IST ==');
    await setDeadline(istDay(0));
    check('with the deadline set to today (IST), submission reads as open',
      (await call('GET', '/api/conference')).body.abstractSubmissionOpen === true);
    const onTheDay = await call('POST', '/api/abstracts', ABSTRACT, early.cookie);
    check('a delegate can submit on the last date', onTheDay.status === 200 && onTheDay.body.success, [onTheDay.status, onTheDay.body.error]);

    // The committee sends it back for corrections -- before the deadline passes.
    const mine = (await call('GET', '/api/abstracts/me', null, early.cookie)).body;
    const back = await call('PUT', `/api/abstracts/${mine.abstract.id}/status`,
      { status: 'REVISION_REQUESTED', note: 'Please shorten the methods.' }, admin);
    check('fixture: the committee requests corrections', back.body.success === true, back.body.error);

    console.log('\n== After the last date, a new abstract is refused ==');
    const closedOn = istDay(-1);
    const saved = await setDeadline(closedOn);
    check('the deadline can be set in the past, which is how it closes early', saved.body.success === true, saved.body.error);
    const pubClosed = (await call('GET', '/api/conference')).body;
    check('the portal is told submission is closed', pubClosed.abstractSubmissionOpen === false, pubClosed);
    const lateView = (await call('GET', '/api/abstracts/me', null, late.cookie)).body;
    check('...and so is the delegate\'s own dashboard call',
      lateView.submission && lateView.submission.open === false && lateView.submission.deadline === closedOn, lateView.submission);

    const refused = await call('POST', '/api/abstracts', ABSTRACT, late.cookie);
    check('the server refuses the submission', refused.status === 403, refused.status);
    check('...with a code the client can recognise', refused.body.code === 'ABSTRACT_SUBMISSION_CLOSED', refused.body.code);
    const [y, m, d] = closedOn.split('-').map(Number);
    const shortDate = `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
    check('...saying when it closed', refused.body.error === `Abstract submission closed on ${shortDate}.`, refused.body.error);
    const row = await db.get('SELECT COUNT(*) AS n FROM abstracts WHERE phone_number = ?', [late.key]);
    check('...and nothing was stored', row.n === 0, row.n);
    const refusedBlank = await call('POST', '/api/abstracts', {}, late.cookie);
    check('an empty form is told it is closed, not walked through validation errors',
      refusedBlank.status === 403 && refusedBlank.body.code === 'ABSTRACT_SUBMISSION_CLOSED', refusedBlank.body);

    console.log('\n== ...but corrections the committee asked for still go in ==');
    const resub = await call('POST', '/api/abstracts', { ...ABSTRACT, methods: 'A shorter method.' }, early.cookie);
    check('a REVISION_REQUESTED abstract can be resubmitted after the deadline',
      resub.status === 200 && resub.body.success, [resub.status, resub.body.error]);
    const after = await db.get('SELECT status, methods FROM abstracts WHERE phone_number = ?', [early.key]);
    check('...and it goes back under review with the correction',
      after.status === 'UNDER_REVIEW' && after.methods.includes('shorter'), after);
    const again = await call('POST', '/api/abstracts', ABSTRACT, early.cookie);
    check('that exception is spent once it is resubmitted', again.status === 403, again.status);

    console.log('\n== Changing it is audited ==');
    const entry = await db.get(
      "SELECT new_value FROM audit_log WHERE action = 'GENERAL_SETTINGS_UPDATE' AND new_value LIKE '%conference_abstract_deadline%' ORDER BY id DESC LIMIT 1");
    check('the change is in the log, old and new', !!entry && entry.new_value.includes(closedOn), entry && entry.new_value);

    console.log('\n== Clearing it reopens submission ==');
    await setDeadline('');
    check('blank means no deadline', (await settings()).abstractDeadline === '');
    check('...so submission is open', (await call('GET', '/api/conference')).body.abstractSubmissionOpen === true);
    const reopened = await call('POST', '/api/abstracts', ABSTRACT, late.cookie);
    check('...and the late delegate can now submit', reopened.status === 200 && reopened.body.success, [reopened.status, reopened.body.error]);
  } finally {
    await setDeadline(original);
  }
  check('the shared deadline is put back for the files after this one', (await settings()).abstractDeadline === original);

  console.log('\n== The boot default is the announced date, and never overrides an admin ==');
  const src = fs.readFileSync(appFile('server.js'), 'utf8');
  check('a deployment without the setting starts with 15 September 2026',
    /INSERT OR IGNORE INTO schema_meta \(key, value\) VALUES \('conference_abstract_deadline', '2026-09-15'\)/.test(src));
  check('...written before the settings are read, so it applies on that same boot',
    src.indexOf("'conference_abstract_deadline', '2026-09-15'") > src.indexOf('async function loadGeneralSettings')
    && src.indexOf("'conference_abstract_deadline', '2026-09-15'") < src.indexOf('const targets = { SMS, EMAIL, UPI, BANK, CONFERENCE }'));

  console.log('\n== The day ends at midnight in India, not in UTC ==');
  // The live checks above run at whatever hour the suite does, so a UTC-date
  // comparison would pass them for 18.5 hours a day. This runs the shipped
  // function at fixed instants either side of the IST midnight instead.
  const lift = (name, until) => src.slice(src.indexOf(`function ${name}`), src.indexOf(until));
  // eslint-disable-next-line no-new-func
  const open = new Function('CONFERENCE', `const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    ${lift('istDateString', '// Which pricing phase')}
    ${lift('abstractSubmissionOpen', '// --- .ENV FILE HELPERS')}
    return abstractSubmissionOpen;`)({ abstractDeadline: '2026-09-15' });
  const at = (iso) => open(Date.parse(iso));
  check('open at 00:30 IST on the last date (still the 14th in UTC)', at('2026-09-14T19:00:00Z') === true);
  check('open at 23:59 IST on the last date', at('2026-09-15T18:29:00Z') === true);
  check('closed at 00:00 IST the day after', at('2026-09-15T18:30:00Z') === false);
  check('closed at 01:30 IST the day after (still the 15th in UTC)', at('2026-09-15T20:00:00Z') === false);

  console.log('\n== What the delegate and the desk see ==');
  // Driven for real in a sandbox: app.js's top-level `let`s (conferenceInfo,
  // the abstract caches) only take values from inside the same script, so
  // the functions under test are handed out from inside it.
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  const els = {};
  const mkEl = (id) => {
    const cls = new Set();
    return { id, value: '', innerHTML: '', innerText: '', textContent: '', className: '', disabled: false, style: {}, dataset: {},
      classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)),
        toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)),
        contains: (c) => cls.has(c) },
      addEventListener() {}, setAttribute() {}, getAttribute: () => null, focus() {}, appendChild() {}, remove() {},
      querySelector: () => null, querySelectorAll: () => [] };
  };
  const doc = { getElementById: (id) => (els[id] = els[id] || mkEl(id)), querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: mkEl, body: mkEl('body'), documentElement: mkEl('html'), readyState: 'loading', cookie: '' };
  let reply = null;
  const toasts = [];
  const sandbox = {
    document: doc,
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: async () => ({ json: async () => reply }),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON, Promise,
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${js}
    showToast = (msg) => { globalThis.__toasts.push(msg); };
    globalThis.__t = { loadAbstractStatus, openModal, deskAbstractCard, renderAbstractDeadlineState,
      setConference: (c) => { conferenceInfo = { ...conferenceInfo, ...c }; } };
  `, Object.assign(sandbox, { __toasts: toasts }), { filename: 'app.js+driver' });
  const t = sandbox.__t;

  reply = { abstract: null, submission: { open: false, deadline: '2026-09-15' } };
  await t.loadAbstractStatus();
  check('closed: the dashboard button is disabled', els['abstract-action-btn'].disabled === true);
  check('...and says why', els['abstract-action-btn'].innerText === 'Submission Closed', els['abstract-action-btn'].innerText);
  check('...the status pill says closed, not "Not Submitted"', els['abstract-status-tag'].innerText === 'Submission Closed');
  check('...and the card names the day it closed, weekday included',
    els['abstract-desc'].innerHTML.includes('Tuesday, 15 September 2026'), els['abstract-desc'].innerHTML);
  check('...where the "last date" line gives way to that, rather than repeating it',
    els['abstract-deadline-note'].classList.contains('hidden'));
  els['modal-abstract'] = mkEl('modal-abstract');
  els['modal-abstract'].classList.add('hidden');
  t.openModal('modal-abstract');
  check('...and the form will not open onto a submission that would be refused',
    els['modal-abstract'].classList.contains('hidden') && toasts.includes('Abstract submission has closed.'), toasts);

  reply = { abstract: null, submission: { open: true, deadline: '2026-09-15' } };
  await t.loadAbstractStatus();
  check('open: the button is live', els['abstract-action-btn'].disabled === false && els['abstract-action-btn'].innerText === 'Submit Abstract');
  const note = els['abstract-deadline-note'];
  check('...the card shows the last date on its own line',
    !note.classList.contains('hidden') && note.innerHTML.includes('Last date for submission: Tuesday, 15 September 2026'), note.innerHTML);
  const formNote = els['abstract-modal-deadline'];
  check('...and so does the submission form',
    !formNote.classList.contains('hidden') && formNote.innerHTML.includes('Last date for submission: Tuesday, 15 September 2026'), formNote.innerHTML);
  check('...while the paragraph above it stays the plain description', !els['abstract-desc'].innerHTML.includes('Last date'));
  t.openModal('modal-abstract');
  check('...and the form opens', !els['modal-abstract'].classList.contains('hidden'));

  reply = { abstract: { id: 1, status: 'REVISION_REQUESTED', title: 'x', revision_note: 'Fix it' }, submission: { open: false, deadline: '2026-09-15' } };
  await t.loadAbstractStatus();
  check('closed, but corrections requested: the button still offers to resubmit',
    els['abstract-action-btn'].disabled === false && els['abstract-action-btn'].innerText === 'Revise & Resubmit');
  check('...without a last date, which a requested correction is not held to',
    els['abstract-deadline-note'].classList.contains('hidden') && els['abstract-modal-deadline'].classList.contains('hidden'));

  reply = { abstract: { id: 1, status: 'UNDER_REVIEW', title: 'x' }, submission: { open: true, deadline: '2026-09-15' } };
  await t.loadAbstractStatus();
  check('already submitted: the date no longer concerns them, so it is not shown',
    els['abstract-deadline-note'].classList.contains('hidden'));

  t.setConference({ abstractDeadline: '2026-09-15', abstractSubmissionOpen: false });
  check('the desk says "none" is now final', t.deskAbstractCard([]).includes('No abstract submitted. Submission closed on 15 September 2026.'));
  t.setConference({ abstractSubmissionOpen: true });
  check('...and says nothing extra while it is open', !t.deskAbstractCard([]).includes('closed'));

  t.renderAbstractDeadlineState({ abstractDeadline: '2026-09-15', abstractSubmissionOpen: true });
  check('Settings: open, with when it closes', els['gs-conf-abstract-state'].textContent === 'Open — closes at the end of Tuesday, 15 September 2026 (IST).',
    els['gs-conf-abstract-state'].textContent);
  t.renderAbstractDeadlineState({ abstractDeadline: '2026-09-15', abstractSubmissionOpen: false });
  check('Settings: closed', /^Closed — the last date was Tuesday, 15 September 2026/.test(els['gs-conf-abstract-state'].textContent));
  t.renderAbstractDeadlineState({ abstractDeadline: '', abstractSubmissionOpen: true });
  check('Settings: no deadline', els['gs-conf-abstract-state'].textContent === 'Open — no deadline set.');

  const dash = fs.readFileSync(appFile('views', 'portal', 'sections', 'dashboard.ejs'), 'utf8');
  const modal = fs.readFileSync(appFile('views', 'portal', 'modals', 'abstract.ejs'), 'utf8');
  check('the portal has a place for the date on the card and in the form',
    /id="abstract-deadline-note"/.test(dash) && /id="abstract-modal-deadline"/.test(modal));
  const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'general.ejs'), 'utf8');
  check('the field sits in the Conference card and is saved with it',
    /id="gs-conf-abstractdeadline" type="date"/.test(view) && /abstractDeadline: document\.getElementById\('gs-conf-abstractdeadline'\)\.value/.test(js));

  db.close();
  report();
})();
