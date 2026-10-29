// The delegate portal's layout for the conference (the design review of
// 29 Oct 2026):
//
//   * A tab bar -- Home, Programme, Map, Badge -- on the delegate's pages,
//     each tab only when it has something behind it, the page they are on
//     marked; the menu keeps what is used now and then.
//   * On the conference days one gold panel leads: what is on now, how far
//     it has run, its hall on the map, the badge; then the next talk; and
//     registration shrinks to one line that opens the whole panel.
//   * The programme: a navy day switch, what is on now pinned at the top.
//   * Small fixes: primary buttons navy, not steel; the balance banner rose
//     (an action), not orange; 12px uppercase labels.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const dash = fs.readFileSync(appFile('views', 'portal', 'sections', 'dashboard.ejs'), 'utf8');
const css = fs.readFileSync(appFile('public', 'styles.css'), 'utf8');

function load() {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      const s = new Set(['hidden']);
      const attrs = {};
      els.set(id, { id, value: '', innerHTML: '', textContent: '', dataset: {}, style: {},
        classList: { add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)),
          toggle: (c, on) => { const w = on === undefined ? !s.has(c) : !!on; if (w) s.add(c); else s.delete(c); return w; }, contains: (c) => s.has(c) },
        setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => attrs[k] ?? null,
        addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], scrollIntoView() {} });
    }
    return els.get(id);
  };
  const body = el('body');
  const sb = {
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: () => el(`tmp${Math.random()}`), head: el('head'), body, documentElement: el('html'), readyState: 'loading', cookie: '' },
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '', origin: 'https://x' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} }, scrollTo() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, fetch: () => Promise.reject(new Error('no network')),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval, URL, Intl, Date, Math, JSON, Promise, requestAnimationFrame: () => 0,
  };
  sb.window.document = sb.document; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(`${js}
    globalThis.__set = (prog, reg, certs, att) => { programmeData = prog; currentRegistration = reg; myCertificates = certs || []; attendanceMeData = att || null; programmeDay = prog && prog.now ? prog.now.date : null; };
    globalThis.__f = { navigateTo, updateDashTabs, renderHomeHero, toggleRegistrationDetails, renderProgrammePage };`, sb);
  return { sb, el, body };
}

const halls = [{ id: 1, name: 'Main Auditorium', lat: 20.741098, lng: 78.662453, building: 'New Auditorium Complex' },
  { id: 2, name: 'Hall A', lat: 20.741098, lng: 78.662453, building: 'New Auditorium Complex' }];
const sessions = [
  { id: 1, hallId: 1, hall: 'Main Auditorium', date: '2026-11-22', start: '10:00', end: '11:00', title: 'Quality as an Organizational Strategy', speakers: 'Dr Vikram Datta', counts: true },
  { id: 2, hallId: 2, hall: 'Hall A', date: '2026-11-22', start: '11:30', end: '12:30', title: 'Transforming Healthcare', speakers: 'Dr Amit Shah', counts: true },
  { id: 3, hallId: 1, hall: 'Main Auditorium', date: '2026-11-22', start: '13:00', end: '14:00', title: 'Lunch', counts: false },
  { id: 4, hallId: 1, hall: 'Main Auditorium', date: '2026-11-21', start: '10:00', end: '13:00', title: 'Workshops', speakers: 'Faculty', counts: true },
];
const prog = { halls, sessions, mine: [], now: { date: '2026-11-22', minutes: 10 * 60 + 30 } };
const confirmed = { bank_status: 'BANK_VERIFIED', registration_number: 'NQOCN20261234', category_label: 'Delegate' };

console.log('\n== The tab bar ==');
check('Home, Programme, Map, Badge, fixed to the bottom', /<nav id="dash-tabs" aria-label="Main" class="hidden fixed bottom-0/.test(dash)
  && ['home', 'programme', 'map', 'badge'].every((t) => new RegExp(`id="dash-tab-${t}"`).test(dash)) && /id="dash-tab-badge" onclick="openBadgeFullScreen\(\)"/.test(dash));
check('...with room kept for it below the page', /body\.has-tabs \{ padding-bottom: calc\(5\.5rem/.test(css));
check('the menu keeps what is used now and then: profile, admin, password, log out', /aria-label="More: profile, password, log out"/.test(dash)
  && !/onclick="dashGo\('home'\)" class="w-full/.test(dash) && !/id="dash-menu-programme"/.test(dash) && !/id="dash-menu-map"/.test(dash));
check('the programme and map pages lose their Back buttons to it', !/onclick="closeProgrammePage\(\)" aria-label="Back"/.test(dash)
  && !/<section id="map-page"[\s\S]*?aria-label="Back"[\s\S]*?<\/header>/.test(dash.split('<section id="profile-page"')[0]));
{
  const { sb, el, body } = load();
  sb.__set(null, null);
  sb.__f.navigateTo('dashboard-page');
  check('on the home page: the bar, with Home only, before anything is known', !el('dash-tabs').classList.contains('hidden') && body.classList.contains('has-tabs')
    && !el('dash-tab-home').classList.contains('hidden') && ['programme', 'map', 'badge'].every((t) => el(`dash-tab-${t}`).classList.contains('hidden')));
  check('...Home marked as here', el('dash-tab-home').getAttribute('aria-current') === 'page' && el('dash-tab-home').classList.contains('bg-gold-50'));
  sb.__set(prog, confirmed);
  sb.__f.navigateTo('programme-page');
  check('programme out, a hall on the map, confirmed: all four', ['home', 'programme', 'map', 'badge'].every((t) => !el(`dash-tab-${t}`).classList.contains('hidden')));
  check('...Programme marked, Home not', el('dash-tab-programme').getAttribute('aria-current') === 'page' && el('dash-tab-home').getAttribute('aria-current') === 'false'
    && !el('dash-tab-home').classList.contains('bg-gold-50'));
  sb.__set({ ...prog, halls: halls.map((h) => ({ ...h, lat: null, lng: null })) }, { ...confirmed, bank_status: 'PENDING' });
  sb.__f.updateDashTabs();
  check('no hall on the map, not yet confirmed: no Map, no Badge', el('dash-tab-map').classList.contains('hidden') && el('dash-tab-badge').classList.contains('hidden'));
  sb.__f.navigateTo('auth-page');
  check('off the delegate\'s pages (signing in): no bar', el('dash-tabs').classList.contains('hidden') && !body.classList.contains('has-tabs'));
}

console.log('\n== The conference day ==');
{
  const { sb, el } = load();
  sb.__set(prog, confirmed, [], { completion: { parts: [{ label: '22 Nov, Morning', done: true }, { label: '22 Nov, Afternoon', done: false }] } });
  sb.__f.renderHomeHero();
  const hero = el('home-hero').innerHTML;
  check('one gold panel: what is on now, until when', !el('home-hero').classList.contains('hidden') && /On now/.test(hero) && /until 11:00 AM/.test(hero)
    && /Quality as an Organizational Strategy/.test(hero) && /Dr Vikram Datta/.test(hero));
  check('...how far it has run', /aria-label="50% of the session gone"/.test(hero) && /style="width:50%"/.test(hero));
  check('...its hall, on the map, with the building', /onclick="openMapPage\(1\)"/.test(hero) && /Main Auditorium<\/span><span class="block text-sm text-slate-600">New Auditorium Complex · Map and directions/.test(hero));
  check('...one badge button, navy, and the attendance so far', (hero.match(/openBadgeFullScreen\(\)/g) || []).length === 1 && /bg-navy[^"]*">Show my badge to mark attendance/.test(hero)
    && /✓ Morning marked/.test(hero) && /○ Afternoon</.test(hero) && !/Full programme/.test(hero));
  const next = el('home-next').innerHTML;
  check('then the next talk, breaks aside', !el('home-next').classList.contains('hidden') && /Next · 11:30 AM/.test(next) && /Transforming Healthcare/.test(next) && /Hall A · Dr Amit Shah/.test(next));
  check('registration shrinks to one line', !el('registration-row').classList.contains('hidden') && el('registration-card').classList.contains('hidden')
    && el('registration-row-number').textContent === 'NQOCN20261234' && /Delegate · Receipt and details/.test(el('registration-row-line').textContent));
  sb.__f.toggleRegistrationDetails();
  check('...which opens the whole panel, and closes it again', !el('registration-card').classList.contains('hidden') && el('registration-row').getAttribute('aria-expanded') === 'true'
    && (sb.__f.toggleRegistrationDetails(), el('registration-card').classList.contains('hidden')));
  sb.__set({ ...prog, now: { date: '2026-11-15', minutes: 600 } }, confirmed);
  sb.__f.renderHomeHero();
  check('before the conference: the full registration panel, no next talk', el('home-hero').classList.contains('hidden') && el('home-next').classList.contains('hidden')
    && el('registration-row').classList.contains('hidden') && !el('registration-card').classList.contains('hidden'));
}

console.log('\n== The programme ==');
{
  const { sb, el } = load();
  sb.__set(prog, confirmed);
  sb.__f.renderProgrammePage();
  const days = el('prog-page-days');
  check('the day switch: one row, navy for the day shown', days.style.gridTemplateColumns === 'repeat(2, minmax(0, 1fr))'
    && /aria-selected="true"\s*class="min-h-\[44px\] px-2 py-2 rounded-lg text-\[15px\] bg-navy text-white font-bold"/.test(days.innerHTML));
  const now = el('prog-page-now');
  check('what is on now, pinned above the list', !now.classList.contains('hidden') && /On now/.test(now.innerHTML) && /Quality as an Organizational Strategy/.test(now.innerHTML) && /width:50%/.test(now.innerHTML));
  vm.runInContext("programmeDay = '2026-11-21'", sb);
  sb.__f.renderProgrammePage();
  check('...only on today', now.classList.contains('hidden'));
}

console.log('\n== Small fixes ==');
const portalViews = ['sections/auth.ejs', 'sections/dashboard.ejs', 'modals/registration-payment.ejs', 'modals/verify-email.ejs', 'modals/set-password.ejs', 'modals/confirm.ejs', 'modals/correct-submission.ejs', 'modals/add-group-member.ejs']
  .map((f) => fs.readFileSync(appFile('views', 'portal', ...f.split('/')), 'utf8')).join('\n');
check('primary buttons navy, not steel, across the portal', !/bg-indigo-600 hover:bg-indigo-700/.test(portalViews) && (portalViews.match(/bg-navy hover:bg-indigo-700/g) || []).length >= 18
  && !/border-indigo-600 text-indigo-700/.test(portalViews));
check('the balance banner is an action: rose, like the other', /id="balance-banner" class="hidden rounded-2xl border-2 border-rose-300 bg-rose-50/.test(dash) && !/orange-/.test(dash));
check('its labels 12px, not 11', !/text-\[11px\] text-slate-500 uppercase/.test(dash));
report();
