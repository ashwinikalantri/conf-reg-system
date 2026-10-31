// The desktop view (the design review of 29 Oct 2026):
//
//   * Delegate: from tablet width up the tabs are links in the conference
//     bar (31 Oct 2026; it was each page's navy header) and the bottom bar is for phones; the delegate's pages start at
//     the top; the programme becomes a timetable (a column per hall) on a
//     desktop; the map's list sits beside the map; sign-in is two halves.
//   * Admin: Conference setup's jump buttons are a side menu on a desktop,
//     marking the card on screen; the faculty table drops Volunteers and
//     Needs (both in the editor), keeps Sr and Faculty in place while it
//     scrolls, and notes special needs under the name.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');
const read = (...p) => fs.readFileSync(appFile(...p), 'utf8');

const js = read('public', 'app.js');
const css = read('public', 'styles.css');
const dash = read('views', 'portal', 'sections', 'dashboard.ejs');
const nav = read('views', 'portal', 'partials', 'topbar.ejs');
const index = read('views', 'index.ejs');
const hero = read('views', 'portal', 'partials', 'hero.ejs');
const auth = read('views', 'portal', 'sections', 'auth.ejs');
const setup = read('views', 'admin', 'sections', 'general.ejs');

function load(wide) {
  const els = new Map();
  const mk = (id, extra = {}) => {
    const s = new Set(['hidden']);
    const attrs = {};
    return { id, value: '', innerHTML: '', textContent: '', dataset: {}, style: {}, ...extra,
      classList: { add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)),
        toggle: (c, on) => { const w = on === undefined ? !s.has(c) : !!on; if (w) s.add(c); else s.delete(c); return w; }, contains: (c) => s.has(c) },
      setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => attrs[k] ?? null,
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], scrollIntoView() {} };
  };
  const el = (id) => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); };
  const links = ['home', 'programme', 'map', 'badge'].map((t) => mk(`link-${t}`, { dataset: { tab: t } }));
  const body = el('body');
  const sb = {
    document: { getElementById: el, querySelector: () => null, querySelectorAll: (q) => (q === '.dash-nav-link' ? links : []), addEventListener() {},
      createElement: () => mk(`tmp${Math.random()}`), head: el('head'), body, documentElement: el('html'), readyState: 'loading', cookie: '' },
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/', search: '', origin: 'https://x' },
      matchMedia: () => ({ matches: wide, addEventListener() {} }), history: { replaceState() {} }, scrollTo() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, fetch: () => Promise.reject(new Error('no network')),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval, URL, Intl, Date, Math, JSON, Promise, requestAnimationFrame: () => 0,
  };
  sb.window.document = sb.document; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(`${js}
    globalThis.__set = (prog, reg) => { programmeData = prog; currentRegistration = reg; programmeDay = prog.now.date; programmeHall = ''; };
    globalThis.__f = { navigateTo, renderProgrammePage };`, sb);
  return { sb, el, body, links };
}
const halls = [{ id: 1, name: 'Main Auditorium', lat: 20.74, lng: 78.66 }, { id: 2, name: 'Hall A', lat: 20.74, lng: 78.66 }, { id: 3, name: 'Hall B', lat: null, lng: null }];
const s = (id, hallId, hall, start, end, title, extra = {}) => ({ id, hallId, hall, date: '2026-11-22', start, end, title, speakers: 'Dr X', counts: true, ...extra });
const sessions = [
  s(1, 1, 'Main Auditorium', '10:00', '11:00', 'Plenary'), s(2, 2, 'Hall A', '10:00', '11:00', 'Plenary'), s(3, 3, 'Hall B', '10:00', '11:00', 'Plenary'),
  s(4, 1, 'Main Auditorium', '11:30', '12:30', 'Financing Quality'), s(5, 2, 'Hall A', '11:30', '12:30', 'Transforming Healthcare'), s(6, 3, 'Hall B', '11:30', '12:30', 'Community Health Workers'),
  s(7, 1, 'Main Auditorium', '13:00', '14:00', 'Lunch', { speakers: '', counts: false }),
];
const prog = { halls, sessions, mine: [], now: { date: '2026-11-22', minutes: 9 * 60 } };

console.log('\n== Delegate: the tabs in the bar ==');
check('a nav in the bar from tablet width up, Home · Programme · Map · Badge', /class="dash-nav hidden md:flex/.test(nav)
  && ['home', 'programme', 'map', 'badge'].every((t) => new RegExp(`data-tab="${t}"`).test(nav)));
check('...one bar for all four delegate pages, not one per page header', (index.match(/include\('portal\/partials\/topbar'\)/g) || []).length === 1 && !/desktop-nav|dash-nav/.test(dash));
check('the bottom bar is for phones, and so is the room kept for it', /<nav id="dash-tabs" aria-label="Main" class="hidden md:hidden/.test(dash)
  && /@media \(max-width: 767px\) \{ body\.has-tabs \{ padding-bottom/.test(css));
{
  const { sb, body, links } = load(true);
  sb.__set(prog, { bank_status: 'BANK_VERIFIED' });
  sb.__f.navigateTo('map-page');
  const by = (t) => links.find((l) => l.dataset.tab === t);
  check('the header links show as the bottom tabs do, the page marked', ['home', 'programme', 'map', 'badge'].every((t) => !by(t).classList.contains('hidden'))
    && by('map').getAttribute('aria-current') === 'page' && by('home').getAttribute('aria-current') === 'false');
  check('the delegate\'s pages start at the top', body.classList.contains('justify-start') && !body.classList.contains('justify-center'));
  sb.__f.navigateTo('auth-page');
  check('...sign-in stays centred', body.classList.contains('justify-center') && !body.classList.contains('justify-start'));
}

console.log('\n== Delegate: the programme on a desktop ==');
{
  const { sb, el } = load(true);
  sb.__set(prog, null);
  sb.__f.renderProgrammePage();
  const html = el('prog-page-list').innerHTML;
  check('as wide as the home page (no narrow column, no jump between tabs)', /<section id="programme-page" class="hidden w-full max-w-2xl lg:max-w-5xl">/.test(dash)
    && /<section id="map-page" class="hidden w-full max-w-2xl lg:max-w-5xl">/.test(dash));
  check('talks that start together sit side by side, two or three to a row', /<div class="grid gap-2 lg:grid-cols-2 xl:grid-cols-3">[\s\S]*?Financing Quality[\s\S]*?Transforming Healthcare[\s\S]*?Community Health Workers/.test(html));
  check('...each card the row\'s height', /px-4 py-3 h-full">/.test(html));
  check('no hall-column timetable left (real days have 6-13 halls)', !/grid-template-columns: 4\.5rem/.test(js) && !/lg:max-w-6xl/.test(js));
}

console.log('\n== Delegate: the badge ==');
{
  const home = dash.slice(dash.indexOf('<section id="dashboard-page"'), dash.indexOf('</section>', dash.indexOf('<section id="dashboard-page"')));
  check('the full-screen badge is outside the pages, so the Badge tab opens it from any of them', /<div id="badge-full"/.test(dash) && !/id="badge-full"/.test(home)
    && dash.indexOf('id="badge-full"') > dash.lastIndexOf('</section>'));
  check('...its QR loaded with the badge, not on the tap', /const fullQr = document\.getElementById\('badge-full-qr'\);\s*if \(fullQr\) fullQr\.src = `\/api\/qr\//.test(js));
}

console.log('\n== Delegate: map and sign-in ==');
check('the map: the list beside the map, the map taller', /lg:grid lg:grid-cols-\[minmax\(0,1fr\)_22rem\]/.test(dash) && /lg:h-\[70vh\]/.test(dash));
check('sign-in: the conference and the form side by side on a desktop', /<div id="portal-front" class="w-full flex flex-col items-center lg:flex-row lg:items-stretch lg:justify-center">\s*<%- include\('portal\/partials\/hero'\) %>\s*<%- include\('portal\/sections\/auth'\) %>\s*<\/div>/.test(index)
  && /lg:max-w-\[440px\][^"]*lg:rounded-r-none/.test(hero) && /lg:max-w-\[520px\][^"]*lg:rounded-l-none/.test(auth));
check('...the conference\'s half carries no description, only the conference', !/<ul\b|<li>/.test(hero));
check('...centred only while shown (never undoing .hidden on the delegate\'s pages)', /#portal-hero:not\(\.hidden\) \{ display: flex;/.test(css) && !/lg:flex/.test(hero));

console.log('\n== Admin: settings and the faculty list ==');
check('Conference setup: a side menu on a desktop, a row on a phone', /<nav id="gs-jump" aria-label="Conference setup" class="flex flex-wrap[^"]*lg:flex-col/.test(setup)
  && (setup.match(/data-target="gs-card-[a-z]+"/g) || []).length === 9 && /lg:grid lg:grid-cols-\[13rem_minmax\(0,1fr\)\]/.test(setup));
check('...marking the card on screen', /function watchSettingsJump\(\)/.test(js) && /new IntersectionObserver/.test(js) && /renderBackupStatus\(\);\n  loadHallsCard\(\);\n  watchSettingsJump\(\);/.test(js));
const listFn = js.slice(js.indexOf('function renderGuestList()'), js.indexOf('// A card per person, for a phone'));
check('the faculty table: no Volunteers or Needs columns (both in the editor)', !/>Volunteers</.test(listFn) && !/Needs · Remarks/.test(listFn) && /colspan="7"/.test(listFn));
check('...Sr and Faculty stay in place while it scrolls', /sticky left-0 z-20 bg-slate-50/.test(listFn) && /sticky left-10 z-10 bg-inherit/.test(listFn) && /guestRowTint\(g\) \|\| 'bg-white'/.test(listFn));
check('...special needs noted under the name', /Special needs: see the editor/.test(listFn));
report();
