// The Guests tab as drawn: app.js run whole, fed a board computed by
// guests.js from real-shaped rows, with just enough of a page to draw into.
//
// What a coordinator sees: the status colours (Cancelled struck through),
// the orange/red row tints and the purple chip, sorting and filtering, the
// editor enabling only the sections the role may edit, the schedules, rooms,
// vehicles and dashboard, and the admin-only pieces staying hidden.
const { check, report, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');
const G = require('../guests');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const ejs = fs.readFileSync(appFile('views', 'admin', 'sections', 'guests.ejs'), 'utf8');

function load(perms) {
  const els = new Map();
  const classList = (el) => ({
    _s: new Set(['hidden']),
    add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
    toggle(c, on) { const want = on === undefined ? !this._s.has(c) : !!on; if (want) this._s.add(c); else this._s.delete(c); return want; },
    contains(c) { return this._s.has(c); },
  });
  const el = (id) => {
    if (!els.has(id)) {
      const e = { id, value: '', innerHTML: '', textContent: '', dataset: {}, style: {}, disabled: false, checked: false,
        setAttribute() {}, getAttribute: () => null, addEventListener() {}, focus() {}, querySelectorAll: () => [], querySelector: () => null };
      e.classList = classList(e);
      els.set(id, e);
    }
    return els.get(id);
  };
  const sandbox = {
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: () => el(`tmp${Math.random()}`), body: el('body'), documentElement: el('html'), readyState: 'loading', cookie: '' },
    window: { addEventListener() {}, location: { href: '', hash: '', pathname: '/admin', search: '', origin: 'https://x' },
      matchMedia: () => ({ matches: false, addEventListener() {} }), history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, fetch: () => Promise.reject(new Error('no network')),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval, URL, Intl, Date, Math, JSON, Promise, requestAnimationFrame: () => 0,
  };
  sandbox.window.document = sandbox.document; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${js}
    myPermissions = new Set(${JSON.stringify(perms)});
    globalThis.__set = (d) => { guestData = d; };
    globalThis.__g = { renderGuestList, renderGuestDashboard, renderGuestSchedule, renderGuestVehicles, renderGuestRooms,
      renderGuestSettings, openGuestEditor, fillGuestFilters, sortGuests, switchGuestView };`, sandbox);
  return { sb: sandbox, el };
}

let id = 0;
const lists = Object.fromEntries(Object.entries(G.DEFAULT_LISTS).map(([k, v]) => [k, [...v]]));
const g = (name, f = {}) => ({ id: ++id, name, phone: '+919800000001', designation: 'Professor', registered: 1, ...f });
const rows = [
  g('Alpha Arriving', { arrival_date: '2026-11-20', arrival_time: '09:00', accommodation: 'Yatri Nivas', room_no: '1', overall_status: 'Confirmed' }),
  g('Bravo Homeless', { arrival_date: '2026-11-25', overall_status: 'Invited', pickup_vehicle: 'Car A', arrival_time: '08:00' }),
  g('Charlie Cancelled', { overall_status: 'Cancelled' }),
  g('Delta Roommate', { accommodation: 'Yatri Nivas', room_no: '1', overall_status: 'Arrived', registered: 0, departure_date: '2026-11-22', departure_time: '18:30', drop_vehicle: 'Car A' }),
];
const settings = { alertDays: 2, slotBounds: [6, 12, 18], clashMinutes: 60 };
const board = G.buildBoard({ guests: rows, vehicles: [{ id: 1, label: 'Car A', driver_phone: '0712', seats: 4 }],
  rooms: [{ id: 1, accommodation: 'Yatri Nivas', room_no: '1', room_type: 'Double', beds: 2 }], lists, settings, today: '2026-11-19' });
const data = {
  ...board, lists, settings, today: '2026-11-19', listLabels: G.LIST_LABELS,
  coordinators: { transport: [{ phone: 'T1', name: 'Tara' }], accommodation: [{ phone: 'A1', name: 'Anil' }] },
  listRows: Object.entries(lists).flatMap(([k, vs]) => vs.map((v, i) => ({ id: `${k}${i}`, list_key: k, value: v, sort_order: i, active: 1, inUse: 0, protected: v === 'Cancelled' }))),
};

console.log('\n== The list ==');
const { sb, el } = load(['guests.view', 'guests.edit', 'guests.travel']);
sb.__set(data);
sb.__g.fillGuestFilters();
sb.__g.renderGuestList();
const body = el('guests-tbody').innerHTML;
const rowOf = (name) => (body.split('<tr').find((r) => r.includes(`>${name}<`)) || '');
check('every guest is listed', ['Alpha Arriving', 'Bravo Homeless', 'Charlie Cancelled', 'Delta Roommate'].every((n) => body.includes(`>${n}<`)));
check('Invited yellow, Confirmed green, Arrived blue', /bg-amber-100[^"]*">Invited</.test(body) && /bg-emerald-100[^"]*">Confirmed</.test(body) && /bg-blue-100[^"]*">Arrived</.test(body));
check('Cancelled red with strikethrough', /bg-rose-100 text-rose-800 border-rose-300 line-through">Cancelled</.test(body));
check('orange row: arriving within the window, no vehicle', /class="bg-orange-50 /.test(rowOf('Alpha Arriving')));
check('red row: no accommodation', /class="bg-rose-50 /.test(rowOf('Bravo Homeless')));
check('the cancelled guest is neither, and struck through', !/bg-rose-50|bg-orange-50/.test(rowOf('Charlie Cancelled')) && /line-through">Charlie Cancelled/.test(rowOf('Charlie Cancelled')));
check('purple chip on both roommates', /bg-violet-100[^>]*>Shares room/.test(rowOf('Alpha Arriving')) && /bg-violet-100[^>]*>Shares room/.test(rowOf('Delta Roommate')));
check('not registered is flagged', />Not registered</.test(rowOf('Delta Roommate')) && !/>Not registered</.test(rowOf('Alpha Arriving')));
check('arrival shows date and time together', />2026-11-20 09:00</.test(rowOf('Alpha Arriving')));
check('a coordinator gets Edit', />Edit</.test(rowOf('Alpha Arriving')));

el('guests-filter-flag').value = 'noAccommodation';
sb.__g.renderGuestList();
check('filtering by a flag', el('guests-tbody').innerHTML.includes('>Bravo Homeless<') && !el('guests-tbody').innerHTML.includes('>Alpha Arriving<'));
el('guests-filter-flag').value = '';
el('guests-filter-status').value = '__live';
sb.__g.renderGuestList();
check('"All but Cancelled" hides Cancelled', !el('guests-tbody').innerHTML.includes('>Charlie Cancelled<'));
el('guests-filter-status').value = '';
el('guests-search').value = 'delta';
sb.__g.renderGuestList();
check('search', el('guests-tbody').innerHTML.includes('>Delta Roommate<') && !el('guests-tbody').innerHTML.includes('>Bravo Homeless<'));
el('guests-search').value = '';
sb.__g.sortGuests('name');
sb.__g.sortGuests('name');
const order = [...el('guests-tbody').innerHTML.matchAll(/font-semibold[^>]*>([A-Z][a-z]+ [A-Za-z]+)</g)].map((m) => m[1]);
check('sorting by name, then reversed', order[0] === 'Delta Roommate' && order[order.length - 1] === 'Alpha Arriving', order);
check('the header shows the sort', /Guest ▼/.test(el('guests-thead').innerHTML));

console.log('\n== The editor follows the role ==');
sb.__g.openGuestEditor(rows[0].id);
const form = el('guest-edit-body').innerHTML;
// The attribute, not the disabled: style variants in the class list.
const disabled = (name) => new RegExp(`name="${name}"[^>]*\\sdisabled(?=[\\s>])`).test(form);
check('a transport coordinator edits arrival and departure', !disabled('arrival_date') && !disabled('drop_vehicle'));
check('...not the stay', disabled('accommodation') && disabled('room_no') && disabled('accommodation_coordinator'));
check('...and the shared fields', !disabled('overall_status') && !disabled('remarks'));
check('times are 24-hour text, not a 12-hour picker', /name="arrival_time" type="text"[^>]*pattern="\(\[01\]\[0-9\]\|2\[0-3\]\):\[0-5\]\[0-9\]"/.test(form));
check('the vehicle field suggests vehicles but takes free text', /name="pickup_vehicle" type="text"[^>]*list="guest-vehicle-options"/.test(form) && /<option value="Car A">/.test(form));
check('no Remove for a coordinator', el('guest-remove-btn').classList.contains('hidden'));
const stay = load(['guests.view', 'guests.edit', 'guests.stay']);
stay.sb.__set(data);
stay.sb.__g.openGuestEditor(rows[0].id);
const sform = stay.el('guest-edit-body').innerHTML;
const sDisabled = (name) => new RegExp(`name="${name}"[^>]*\\sdisabled(?=[\\s>])`).test(sform);
check('an accommodation coordinator: the reverse', !sDisabled('accommodation') && !sDisabled('room_no') && sDisabled('arrival_date') && sDisabled('pickup_vehicle'));
const adminView = load(['guests.view', 'guests.edit', 'guests.travel', 'guests.stay', 'guests.manage']);
adminView.sb.__set(data);
adminView.sb.__g.openGuestEditor(rows[0].id);
check('an admin can remove', !adminView.el('guest-remove-btn').classList.contains('hidden'));

console.log('\n== The other views ==');
sb.__g.renderGuestSchedule('pickups');
const pick = el('guests-view-pickups').innerHTML;
check('pickups in arrival order, Cancelled out', pick.indexOf('Alpha Arriving') < pick.indexOf('Bravo Homeless') && !pick.includes('Charlie Cancelled'));
check('...with the driver\'s phone from the vehicle list', pick.includes('>0712<'));
sb.__g.renderGuestSchedule('drops');
check('drops list departures', el('guests-view-drops').innerHTML.includes('2026-11-22 18:30'));
sb.__g.renderGuestRooms();
const roomsHtml = el('guests-view-rooms').innerHTML;
check('rooms: occupied, Full, and who', /Full</.test(roomsHtml) && roomsHtml.includes('Alpha Arriving, Delta Roommate'));
check('a transport coordinator gets no room form', !roomsHtml.includes('guest-room-form'));
sb.__g.renderGuestVehicles();
check('vehicles: the form for a transport coordinator, no Delete', el('guests-view-vehicles').innerHTML.includes('guest-vehicle-form') && !/>Delete</.test(el('guests-view-vehicles').innerHTML));
sb.__g.renderGuestDashboard();
const dash = el('guests-view-dashboard').innerHTML;
check('dashboard: guests listed, cancelled left out', />3</.test(dash) && /1 cancelled not counted/.test(dash));
check('...arrivals in the window, with how many lack a vehicle', /1 with no pickup vehicle/.test(dash));
check('...counts include "Not set"', /Not set/.test(dash));
check('...time slots by name', /Morning 06-12/.test(dash) && /Evening 18-24/.test(dash));
check('...beds per accommodation', /Yatri Nivas/.test(dash));
adminView.sb.__g.renderGuestSettings();
const settingsHtml = adminView.el('guests-view-settings').innerHTML;
check('lists: "Cancelled" cannot be switched off or removed', /Cancelled <span class="text-\[10px\] text-slate-400">\(required\)<\/span>/.test(settingsHtml));
check('the settings show the slot boundaries', /value="6"/.test(settingsHtml) && /value="18"/.test(settingsHtml));

console.log('\n== Wiring ==');
check('Lists & Settings is hidden until shown to an admin', /id="guests-settings-tab" class="guest-subtab hidden/.test(ejs));
check('the tab is a main tab, opened by guests.view', /const MAIN_TABS = \[[^\]]*'guests'/.test(js) && /tabGuests\.classList\.toggle\('hidden', !canSee\('guests'\)\)/.test(js));
check('coordinators land on it', /: canSee\('guests'\) \? 'guests'/.test(js));
check('no import option', !/import/i.test(ejs));

report();
