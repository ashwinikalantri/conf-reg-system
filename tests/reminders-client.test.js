// The Reminders composer as drawn: app.js run whole against the real test
// server, with just enough of a page to draw into. No email leaves (it is
// off in the fixture, and every confirm is answered No).
const { call, check, report, adminLogin } = require('./harness');
const fs = require('fs');
const vm = require('vm');
const { appFile } = require('./harness');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
// The preview is a real round trip to the server, a moment after a change.
const settle = async () => { for (let i = 0; i < 40; i++) await tick(); await new Promise((r) => setTimeout(r, 250)); };

(async () => {
  const cookie = await adminLogin();
  const els = new Map();
  const classList = () => ({
    _s: new Set(),
    add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
    toggle(c, on) { const want = on === undefined ? !this._s.has(c) : !!on; if (want) this._s.add(c); else this._s.delete(c); return want; },
    contains(c) { return this._s.has(c); },
  });
  const el = (id) => {
    if (!els.has(id)) {
      const e = { id, value: '', innerHTML: '', textContent: '', srcdoc: '', dataset: {}, style: {}, disabled: false, checked: false, title: '',
        selectionStart: null, selectionEnd: null,
        setAttribute() {}, getAttribute: () => null, addEventListener() {}, focus() {}, querySelectorAll: () => [], querySelector: () => null };
      e.classList = classList();
      els.set(id, e);
    }
    return els.get(id);
  };
  const toasts = [];
  const requests = [];
  const sandbox = {
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: () => el(`tmp${Math.random()}`), body: el('body'), documentElement: el('html'), readyState: 'loading', cookie: '', activeElement: null },
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/admin', search: '', origin: 'https://portal.example' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    // fetch, answered by the real server as the signed-in Super Admin.
    fetch: async (url, opts = {}) => {
      requests.push(`${opts.method || 'GET'} ${url}`);
      const r = await call(opts.method || 'GET', url, opts.body ? JSON.parse(opts.body) : null, cookie);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval, URL, URLSearchParams, Intl, Date, Math, JSON, Promise, requestAnimationFrame: () => 0,
  };
  sandbox.window.document = sandbox.document; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${js}
    myPermissions = new Set(['comms.reminders_view', 'comms.reminders_test', 'comms.reminders_send', 'comms.custom_send']);
    conferenceInfo = { name: 'Fixture Conference', acronym: 'FIXCON', location: 'Sevagram', startDate: '2026-11-21', endDate: '2026-11-22' };
    showToast = (m) => globalThis.__toasts.push(m);
    showConfirm = async () => false;
    openModal = (id) => document.getElementById(id).classList.remove('hidden');
    globalThis.__r = { renderReminders, selectReminderAudience, applyReminderTemplate, toggleAllReminderRecipients, toggleReminderRecipient,
      renderReminderPreview, switchReminderView, openReminderSend, insertReminderPlaceholder, applyReminderFilters, sendReminders, remState };`, Object.assign(sandbox, { __toasts: toasts }));
  const R = sandbox.__r;

  console.log('\n== It opens ready to write ==');
  await R.renderReminders();
  await settle();
  const chips = el('rem-audiences').innerHTML;
  check('every audience is offered, grouped', ['Signed up, not registered', 'Faculty, not registered', 'By email domain', 'Email not verified',
    'Abstract submitted, not registered', 'Unused personal codes', 'Registered delegates', 'Balance payment due', 'Pasted addresses'].every((l) => chips.includes(l))
    && chips.includes('Not registered yet') && chips.includes('Anyone'));
  check('it starts on "Signed up, not registered", with its email written', R.remState.key === 'signups'
    && /Complete your registration/.test(el('rem-subject').value) && /Dear \{\{name\}\}/.test(el('rem-body').value));
  check('the sidebar count is that audience\'s', el('badge-pending-signups').textContent === String(R.remState.audiences.find((a) => a.key === 'signups').count));
  check('the preview is drawn, filled in', /Dear /.test(el('rem-preview').srcdoc) && !/\{\{name\}\}/.test(el('rem-preview').srcdoc), el('rem-preview').srcdoc.slice(0, 80));
  check('...for someone named', /will see it|example/.test(el('rem-preview-to').textContent), el('rem-preview-to').textContent);
  check('its placeholder is offered to insert', /\{\{name\}\}/.test(el('rem-placeholders').innerHTML) && !/\{\{amount\}\}/.test(el('rem-placeholders').innerHTML));
  check('nothing is selected to start with, so Send is off', R.remState.selected.size === 0 && el('rem-send-btn').disabled === true);

  console.log('\n== Choosing people ==');
  R.toggleAllReminderRecipients(true);
  const selectable = R.remState.recipients.filter((r) => r.email && !(r.last_reminder_sent_at && Date.now() - r.last_reminder_sent_at < 864e5));
  check('"Select all" chooses everyone who can be written to', R.remState.selected.size === selectable.length && selectable.length > 0, [R.remState.selected.size, selectable.length]);
  check('...and Send says how many', el('rem-send-count').textContent === `${selectable.length} ${selectable.length === 1 ? 'Person' : 'People'}` && el('rem-send-btn').disabled === false);
  R.toggleAllReminderRecipients(false);
  check('...and clears them', R.remState.selected.size === 0);

  console.log('\n== Another audience ==');
  await R.selectReminderAudience('balance');
  await settle();
  check('an untouched email is swapped for the new audience\'s', /Balance payment pending/.test(el('rem-subject').value) && /\{\{amount\}\}/.test(el('rem-body').value));
  check('its templates are the ones that fit it', /balance-due/.test(el('rem-template').innerHTML) && !/early-bird-ending/.test(el('rem-template').innerHTML));
  el('rem-body').value += '\n<p>Typed by hand.</p>';
  await R.selectReminderAudience('registered');
  await settle();
  check('a typed email is kept when the audience changes', /Typed by hand/.test(el('rem-body').value));
  check('...and the one placeholder it cannot fill is pointed out, and Send held',
    /\{\{amount\}\} cannot be filled in for &quot;Registered delegates&quot;/.test(el('rem-problems').innerHTML) && !el('rem-problems').classList.contains('hidden')
    && el('rem-send-btn').disabled === true);
  check('its filters are shown, with every category and status', !el('rem-filter-registered').classList.contains('hidden')
    && /Every category/.test(el('rem-category').innerHTML) && /Partial Payment/.test(el('rem-status').innerHTML));
  check('a template over typed content asks first (answered No: nothing replaced)', await (async () => {
    await R.applyReminderTemplate('abstract-deadline-extended'); return /Typed by hand/.test(el('rem-body').value);
  })());

  console.log('\n== Pasted addresses ==');
  await R.selectReminderAudience('paste');
  await settle();
  check('the list gives way to an address box', el('rem-recipients-wrap').classList.contains('hidden') && !el('rem-paste-wrap').classList.contains('hidden'));
  check('nothing to insert here', /Nothing is filled in/.test(el('rem-placeholders').innerHTML));
  check('the typed email, with {{name}} in it, is held back', /\{\{name\}\} cannot be filled in for &quot;Pasted addresses&quot;/.test(el('rem-problems').innerHTML));
  el('rem-subject').value = 'Plain announcement';
  el('rem-body').value = '<p>Dear Colleague,</p>';
  await R.renderReminderPreview();
  el('rem-paste').value = 'a@x.test, b@x.test\nc@x.test';
  sandbox.updateReminderSendState();
  check('three pasted addresses: Send to 3', el('rem-send-count').textContent === '3 Addresses' && el('rem-send-btn').disabled === false && el('rem-problems').classList.contains('hidden'));
  const before = requests.length;
  await R.sendReminders();
  check('sending asks first -- and, told No, sends nothing', !requests.slice(before).some((r) => /send$/.test(r)));

  console.log('\n== By email domain ==');
  await R.selectReminderAudience('domain');
  await settle();
  check('it asks for a domain first', !el('rem-filter-domain').classList.contains('hidden') && /Enter an email domain/.test(el('rem-recipients').innerHTML));
  el('rem-domain').value = '@Example.TEST';
  R.applyReminderFilters();
  await settle();
  check('the domain is read however typed, and the list follows it', R.remState.filters.domain === 'example.test'
    && requests.some((r) => r.includes('/audiences/domain/recipients?domain=example.test')));

  console.log('\n== Sent ==');
  R.switchReminderView('sent');
  await settle();
  check('Sent shows the history in place of the composer', el('rem-view-compose').classList.contains('hidden') && !el('rem-view-sent').classList.contains('hidden'));
  check('...listing what the server holds (or saying nothing has gone)', /openReminderSend|Nothing has been sent yet/.test(el('rem-history').innerHTML));

  report();
})().catch((e) => { console.error(e); process.exit(1); });
