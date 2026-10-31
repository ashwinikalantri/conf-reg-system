// The admin Overview, redesigned (31 Oct 2026, from the "Admin Overview"
// canvas): "Waiting on you" as one list, then registrations (each week, by
// category, sign-ups not registered), workshops' seats, money, abstracts and
// faculty; on a conference day a panel for the day leads. Each part shows
// only for a role that can open what it summarises.
const { check, report, appFile, call, adminLogin } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'overview.ejs'), 'utf8');
const css = fs.readFileSync(appFile('public', 'styles.css'), 'utf8');

function run({ permissions, sections, routes, conference }) {
  const els = {};
  const asked = [];
  const mk = (id) => (els[id] = els[id] || {
    id, textContent: '', innerHTML: '', innerText: '', value: '', style: {},
    classList: { c: new Set(id === 'body' ? [] : ['hidden']), add(k) { this.c.add(k); }, remove(k) { this.c.delete(k); },
      toggle(k, on) { const w = on === undefined ? !this.c.has(k) : !!on; if (w) this.c.add(k); else this.c.delete(k); return w; }, contains(k) { return this.c.has(k); } },
    dataset: {}, setAttribute() {}, getAttribute: () => null, appendChild() {}, remove() {}, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], focus() {},
  });
  const doc = { getElementById: mk, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    createElement: () => mk('created'), body: mk('body'), documentElement: mk('html'), readyState: 'loading', cookie: '', title: '' };
  const sandbox = {
    document: doc,
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' },
    fetch: (url) => {
      const u = String(url).split('?')[0];
      asked.push(u);
      const body = routes[u];
      if (body === undefined) return Promise.resolve({ ok: false, status: 403, json: async () => ({}) });
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    },
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Intl, Date, Math, JSON, Promise,
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  sandbox.window.document = doc; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.__SECTIONS__ = sections;
  sandbox.__PERMS__ = permissions;
  sandbox.__CONF__ = conference || {};
  vm.runInContext(`${js}\nmySections = __SECTIONS__;\nmyPermissions = new Set(__PERMS__);\nconferenceInfo = { ...conferenceInfo, ...__CONF__ };\n`, sandbox, { filename: 'app.js+driver' });
  const hidden = (id) => mk(id).classList.contains('hidden');
  return { sandbox, els: new Proxy(els, { get: (o, k) => mk(k) }), hidden, asked };
}

const DAY = 864e5;
const now = Date.now();
const REGS = { registrations: [
  { bank_status: 'BANK_VERIFIED', category_label: 'Doctor', submitted_at: now - 1 * DAY, expected_amount: 3000, verified_total: 3000 },
  { bank_status: 'BANK_VERIFIED', category_label: 'Doctor', submitted_at: now - 8 * DAY, expected_amount: 3000, verified_total: 3000 },
  { bank_status: 'BANK_VERIFIED', category_label: 'Nurse', submitted_at: now - 8 * DAY, expected_amount: 2000, verified_total: 2000 },
  { bank_status: 'PARTIAL_PAYMENT', category_label: 'Nurse', submitted_at: now - 30 * DAY, expected_amount: 2000, verified_total: 750 },
  { bank_status: 'REJECTED', category_label: 'Doctor', submitted_at: now - 2 * DAY, expected_amount: 3000, verified_total: 0 },
] };
const ADMIN_GROUPS = { groups: [
  { name: 'Workshops', options: [
    { name: 'Leadership', capacity: 40, enrolled: 50, active: 1 },
    { name: 'Psychology of Change', capacity: 30, enrolled: 30, active: 1 },
    { name: 'POCQI', capacity: 40, enrolled: 23, active: 1 },
    { name: 'Retired', capacity: 30, enrolled: 3, active: 0 },
  ] },
  { name: 'QI Practices', options: [{ name: 'Midwifery-led Care Units', capacity: 30, enrolled: 12, active: 1 }] },
] };
const PUBLIC_GROUPS = { groups: [{ name: 'Workshops', options: [{ name: 'Leadership', capacity: 40, remaining: 0 }, { name: 'POCQI', capacity: 40, remaining: 17 }] }] };
const ABS = { abstracts: [
  { status: 'UNDER_REVIEW', format: 'Oral Paper' }, { status: 'UNDER_REVIEW', format: 'Oral Paper' },
  { status: 'ACCEPTED', format: 'Poster Presentation' }, { status: 'REJECTED', format: 'Oral Paper' },
] };
const GUESTS = { dashboard: { noAccommodation: 2, notSignedUp: 1 }, guests: [
  { overall_status: 'Confirmed', phone_number: 'x1', arrival_date: '2026-11-20', room_no: '12', pickup_status: 'Done' },
  { overall_status: 'Invited', phone_number: 'x2', arrival_date: '', room_no: '', pickup_status: '' },
  { overall_status: 'Invited', phone_number: null, arrival_date: '', room_no: '', stay_not_needed: 1, pickup_status: 'Not needed' },
  { overall_status: 'Invited', cancelled: 1 },
] };

(async () => {
  console.log('\n== The page ==');
  check('one "Waiting on you" list, rows not tiles', /<h3 class="text-lg font-bold text-slate-900">Waiting on you<\/h3>/.test(view)
    && (view.match(/class="ov-row hidden"/g) || []).length === 7 && /\.ov-row \{ display: grid;/.test(css) && /\.ov-row\.hidden \{ display: none; \}/.test(css));
  check('...money first: balance due, then approvals, the statement, abstracts, faculty',
    ['ov-q-balance', 'ov-q-payments', 'ov-q-statement', 'ov-q-abstracts', 'ov-q-rooms', 'ov-q-pickups', 'ov-q-signup']
      .every((id, i, a) => !i || view.indexOf(`id="${id}"`) > view.indexOf(`id="${a[i - 1]}"`)));
  check('balance due opens Registration on that list', /id="ov-q-balance" onclick="setPaymentFilter\('balance'\); switchBackendTab\('payments'\)"/.test(view));
  check('registrations, workshops, money, abstracts, faculty and the map', ['overview-regs', 'overview-workshops', 'overview-money', 'overview-abstracts', 'overview-faculty', 'delegate-map']
    .every((id) => view.includes(`id="${id}"`)));
  check('no shouting labels, numbers bold not black', !/uppercase|font-black/.test(view));
  check('the map is a glance: in the narrow column under Faculty, never wider than a phone', view.indexOf('id="overview-faculty"') < view.indexOf('id="delegate-map"')
    && /id="delegate-map" class="w-full max-w-md mx-auto relative"/.test(view) && view.indexOf('id="delegate-map"') < view.lastIndexOf('</div>\n    </div>\n\n  </section>'));

  console.log('\n== Where the conference stands ==');
  {
    const iso = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
    const r = run({ permissions: [], sections: {}, routes: {}, conference: { startDate: iso(now + 21 * DAY), endDate: iso(now + 22 * DAY), location: 'MGIMS, Sevagram' } });
    const w = r.sandbox.overviewWhen();
    check('three weeks out: the days to go, the dates and the place', w.lead === '21 days to go' && /MGIMS, Sevagram/.test(w.where) && w.onDay === false, w);
    const d1 = run({ permissions: [], sections: {}, routes: {}, conference: { startDate: iso(now), endDate: iso(now + DAY) } }).sandbox.overviewWhen();
    check('on the first of two days: "Day 1 of 2", a conference day', d1.lead === 'Day 1 of 2' && d1.onDay === true, d1);
    const after = run({ permissions: [], sections: {}, routes: {}, conference: { startDate: iso(now - 3 * DAY), endDate: iso(now - 2 * DAY) } }).sandbox.overviewWhen();
    check('after it: over', after.lead === 'The conference is over' && !after.onDay, after);
  }

  console.log('\n== Everything, for someone who may see everything ==');
  const ALL = ['payments.view', 'payments.view_totals', 'statement.view', 'abstracts.view', 'guests.view', 'comms.reminders_view', 'masters.programs_view'];
  const full = run({ permissions: ALL, sections: { payments: true, statement: true, abstracts: true, programs: true },
    routes: {
      '/api/registrations': REGS, '/api/abstracts': ABS, '/api/admin/bank-statement/reconcile': { summary: { unmatchedCredits: 0 } },
      '/api/admin/finance-summary': { collected: 8750, outstanding: 1250, owingCount: 1 }, '/api/guests': GUESTS,
      '/api/admin/program-groups': ADMIN_GROUPS, '/api/admin/reminders/audiences': { audiences: [{ key: 'signups', count: 279 }, { key: 'balance', count: 1 }] },
    } });
  await full.sandbox.renderBackendOverview();
  const e = full.els;
  check('registered leaves the rejected out, and says so', String(e['ov-delegates'].textContent) === '4' && /besides 1 rejected/.test(e['ov-delegates-sub'].textContent), [e['ov-delegates'].textContent, e['ov-delegates-sub'].textContent]);
  check('confirmed, as a share of them', String(e['ov-confirmed'].textContent) === '3' && e['ov-confirmed-sub'].textContent === '75% of them', e['ov-confirmed-sub'].textContent);
  check('signed up, not registered: the Reminders audience\'s count', !full.hidden('ov-signups-box') && String(e['ov-signups'].textContent) === '279');
  check('balance due says what is owed', !full.hidden('ov-q-balance') && e['ov-balance-sub'].textContent === '₹1,250 still owed', e['ov-balance-sub'].textContent);
  const weeks = e['ov-weeks'].innerHTML;
  check('each week a bar, from the first registration to this week, the week running in gold', !full.hidden('ov-weeks-box')
    && (weeks.match(/title="Week of/g) || []).length >= 5 && (weeks.match(/bg-gold-500/g) || []).length === 1 && /bg-gold-500[^"]*" style="height:\d+px"><\/div>\s*<\/div>$/.test(weeks.trim()));
  check('...the rejected not counted in them', (weeks.match(/>(\d+)<\/span>/g) || []).map((x) => Number(x.replace(/\D/g, ''))).reduce((a, b) => a + b, 0) === 4, weeks.slice(0, 300));
  check('categories, largest first', /title="Doctor: 2"/.test(e['ov-cats-bar'].innerHTML) && e['ov-cats-legend'].innerHTML.indexOf('Doctor') < e['ov-cats-legend'].innerHTML.indexOf('Nurse'));
  const ws = e['ov-ws-list'].innerHTML;
  check('workshops: seats taken of capacity, by group', !full.hidden('overview-workshops') && /Leadership[\s\S]*?50 \/ 40/.test(ws) && /QI Practices/.test(ws));
  check('...over capacity marked, and full', /\+10<\/span>/.test(ws) && /30 \/ 30<span[^>]*>Full<\/span>/.test(ws) && e['ov-ws-summary'].textContent === '1 full · 1 over capacity', e['ov-ws-summary'].textContent);
  check('...an option no longer offered left out', !/Retired/.test(ws));
  check('money: collected, outstanding, and how much of what is due is in', !full.hidden('overview-money') && e['ov-collected'].textContent === '₹8,750' && e['ov-money-bar'].style.width === '87.5%', e['ov-money-bar'].style.width);
  check('abstracts: where they stand, and oral against poster', !full.hidden('overview-abstracts') && String(e['ov-abs-total'].textContent) === '4'
    && /Under review <b[^>]*>2<\/b>/.test(e['ov-abs-legend'].innerHTML) && /Not accepted <b[^>]*>1<\/b>/.test(e['ov-abs-legend'].innerHTML)
    && /Oral Paper<\/span><b[^>]*>3<\/b>/.test(e['ov-abs-formats'].innerHTML));
  check('faculty: the cancelled left out, by status', String(e['ov-fac-total'].textContent) === '3' && e['ov-fac-sub'].textContent === '2 invited · 1 confirmed', e['ov-fac-sub'].textContent);
  const fb = e['ov-fac-bars'].innerHTML;
  check('...accounts, arrivals, and rooms of those staying with us', /Signed up to the portal<\/span><b[^>]*>2 \/ 3/.test(fb) && /Arrival known<\/span><b[^>]*>1 \/ 3/.test(fb) && /Room assigned<\/span><b[^>]*>1 \/ 2/.test(fb), fb.replace(/\s+/g, ' ').slice(0, 400));
  check('the faculty rows, with how many have accounts', !full.hidden('ov-q-rooms') && !full.hidden('ov-q-pickups') && e['ov-signup-sub'].textContent === '2 of 3 have a portal account', e['ov-signup-sub'].textContent);
  check('a clear section says so under the rows', !full.hidden('overview-clear-line') && e['overview-clear-line'].textContent === 'Nothing waiting in the bank statement.', e['overview-clear-line'].textContent);

  console.log('\n== Each part only for a role that can open it ==');
  {
    const ops = run({ permissions: ['payments.view'], sections: { payments: true }, routes: { '/api/registrations': REGS, '/api/program-options': PUBLIC_GROUPS } });
    await ops.sandbox.renderBackendOverview();
    check('payments without totals: registrations, no Money card', !ops.hidden('overview-regs') && ops.hidden('overview-money'));
    check('...no sign-ups count without the Reminders audience', ops.hidden('ov-signups-box') && !ops.asked.includes('/api/admin/reminders/audiences'));
    check('...no abstracts or faculty cards', ops.hidden('overview-abstracts') && ops.hidden('overview-faculty'));
    check('workshops from the form\'s seats-left when the Workshops screen is not theirs', !ops.hidden('overview-workshops') && /40 \/ 40<span[^>]*>Full/.test(ops.els['ov-ws-list'].innerHTML)
      && !ops.asked.includes('/api/admin/program-groups') && ops.hidden('ov-ws-open'));
  }
  {
    const rev = run({ permissions: ['abstracts.view'], sections: { abstracts: true }, routes: { '/api/abstracts': ABS } });
    await rev.sandbox.renderBackendOverview();
    check('a reviewer: abstracts, nothing on registrations or money', !rev.hidden('overview-abstracts') && rev.hidden('overview-regs') && rev.hidden('overview-money')
      && !rev.asked.includes('/api/registrations') && !rev.asked.includes('/api/admin/finance-summary'));
  }

  console.log('\n== A conference day ==');
  {
    const day = run({ permissions: ['attendance.view'], sections: {}, routes: {} });
    day.sandbox.renderOverviewNow({ registered: 374, completed: 288, presentToday: 312, badgesCollected: 341, sessions: [
      { hall: 'Main Auditorium', title: 'Plenary', start: '00:00', end: '23:59', present: 164, enrolled: null, window: { open: true } },
      { hall: 'Hall A', title: 'Orals', start: '00:00', end: '23:59', present: 58, enrolled: null, window: { open: true } },
    ] }, true);
    const d = day.els;
    check('the day\'s figures lead', !day.hidden('overview-now') && !day.hidden('ov-day-stats') && String(d['ov-day-present'].textContent) === '312'
      && String(d['ov-day-badges'].textContent) === '341' && String(d['ov-day-done'].textContent) === '288' && /of 374 registered/.test(d['ov-day-present-sub'].textContent));
    check('...in the halls now: those marked at the sessions on', String(d['ov-day-now'].textContent) === '222');
    day.sandbox.renderOverviewNow({ registered: 374, completed: 0, presentToday: 0, badgesCollected: 0, sessions: [] }, true);
    check('...the panel stays on the day with no session open, the halls do not', !day.hidden('overview-now') && day.hidden('overview-now-wrap'));
    day.sandbox.renderOverviewNow({ sessions: [] }, false);
    check('not a conference day, nothing open: no panel', day.hidden('overview-now'));
  }

  console.log('\n== The attendance summary carries the day\'s two new figures ==');
  {
    const cookie = await adminLogin();
    const r = await call('GET', '/api/attendance/summary', null, cookie);
    check('present today and badges collected', r.status === 200 && Number.isInteger(r.body.presentToday) && Number.isInteger(r.body.badgesCollected), r.body && Object.keys(r.body));
  }
  report();
})();
