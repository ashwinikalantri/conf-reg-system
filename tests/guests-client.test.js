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
const g = (name, f = {}) => ({ id: ++id, name, phone: '+919800000001', designation: 'Professor', registered: 1, linked: true, ...f });
const rows = [
  g('Alpha Arriving', { arrival_date: '2026-11-20', arrival_time: '09:00', accommodation: 'Yatri Nivas', room_no: '1', overall_status: 'Confirmed' }),
  g('Bravo Homeless', { arrival_date: '2026-11-25', overall_status: 'Invited', pickup_vehicle: 'Car A', arrival_time: '08:00' }),
  g('Charlie Cancelled', { overall_status: 'Cancelled' }),
  g('Delta Roommate', { accommodation: 'Yatri Nivas', room_no: '1', overall_status: 'Arrived', registered: 0, departure_date: '2026-11-22', departure_time: '18:30', drop_vehicle: 'Car A' }),
  g('Echo Typed', { linked: false, registered: 0, guest_name: 'Echo Typed', guest_phone: '+910712000', overall_status: 'Invited', accommodation: 'MGIMS Guesthouse',
    possible_account: { phone_number: '9811111111', name: 'Echo Account', taken: false } }),
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
check('every guest is listed', ['Alpha Arriving', 'Bravo Homeless', 'Charlie Cancelled', 'Delta Roommate', 'Echo Typed'].every((n) => body.includes(`>${n}<`)));
check('Invited yellow, Confirmed green, Arrived blue', /bg-amber-100[^"]*">Invited</.test(body) && /bg-emerald-100[^"]*">Confirmed</.test(body) && /bg-blue-100[^"]*">Arrived</.test(body));
check('Cancelled red with strikethrough', /bg-rose-100 text-rose-800 border-rose-300 line-through">Cancelled</.test(body));
check('orange row: arriving within the window, no vehicle', /class="bg-orange-50 /.test(rowOf('Alpha Arriving')));
check('red row: no accommodation', /class="bg-rose-50 /.test(rowOf('Bravo Homeless')));
check('the cancelled guest is neither, and struck through', !/bg-rose-50|bg-orange-50/.test(rowOf('Charlie Cancelled')) && /line-through">Charlie Cancelled/.test(rowOf('Charlie Cancelled')));
check('purple chip on both roommates', /bg-violet-100[^>]*>Shares room/.test(rowOf('Alpha Arriving')) && /bg-violet-100[^>]*>Shares room/.test(rowOf('Delta Roommate')));
check('not registered is flagged', />Not registered</.test(rowOf('Delta Roommate')) && !/>Not registered</.test(rowOf('Alpha Arriving')));
check('arrival shows date and time together, 12-hour', />20 November 2026, 9:00 AM</.test(rowOf('Alpha Arriving')));
check('a coordinator gets Edit', />Edit</.test(rowOf('Alpha Arriving')));
check('the Faculty column has a fixed width, and a long designation is cut to two lines with the rest on hover',
  /<div class="w-56 break-words">/.test(rowOf('Alpha Arriving')) && /class="text-xs text-slate-500 line-clamp-2" title="Professor">Professor</.test(rowOf('Alpha Arriving')));
check('a guest without an account says so, not "Not registered"', />Not signed up</.test(rowOf('Echo Typed')) && !/>Not registered</.test(rowOf('Echo Typed')));

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
check('sorting by name, then reversed', order[0] === 'Echo Typed' && order[order.length - 1] === 'Alpha Arriving', order);
check('the header shows the sort', /Faculty ▼/.test(el('guests-thead').innerHTML));

console.log('\n== The editor follows the role ==');
sb.__g.openGuestEditor(rows[0].id);
const form = el('guest-edit-body').innerHTML;
// The attribute, not the disabled: style variants in the class list.
const disabled = (name) => new RegExp(`name="${name}"[^>]*\\sdisabled(?=[\\s>])`).test(form);
check('a transport coordinator edits arrival and departure', !disabled('arrival_date') && !disabled('drop_vehicle'));
check('...not the stay', disabled('accommodation') && disabled('room_no') && disabled('accommodation_coordinator'));
check('...and the shared fields', !disabled('overall_status') && !disabled('remarks'));
check('time is a 12-hour box over a hidden 24-hour value', /<input type="hidden" name="arrival_time" value="09:00"/.test(form)
  && /data-time12="arrival_time" value="9:00 AM"[^>]*oninput="onTime12Input\(this\)" onblur="onTime12Blur\(this\)"/.test(form));
check('the vehicle field suggests vehicles but takes free text', /name="pickup_vehicle" type="text"[^>]*list="guest-vehicle-options"/.test(form) && /<option value="Car A">/.test(form));
check('no Remove for a coordinator', el('guest-remove-btn').classList.contains('hidden'));
check('there is no "local transport not needed" tick-box', !/transport_not_needed/.test(form));
check('"accommodation not needed" is not the transport coordinator\'s', /type="checkbox" name="stay_not_needed"[^>]*\sdisabled/.test(form));
check('the flight number field is named after the mode', /data-number-for="arrival"><span data-number-label[^>]*>Flight\/Train No</.test(form)
  && /name="arrival_mode"[^>]*onchange="syncGuestModeFields\('arrival'\)"/.test(form));
check('a tick-box is saved as ticked or not, not as its label', /fields\[el\.name\] = el\.type === 'checkbox' \? el\.checked : el\.value/.test(js));
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
sb.__g.openGuestEditor(rows[4].id);
const uform = el('guest-edit-body').innerHTML;
check('a guest without an account: who they are is editable', /name="guest_name" type="text" value="Echo Typed"(?![^>]*\sdisabled(?=[\s>]))/.test(uform) && /name="guest_phone" type="text" value="\+910712000"/.test(uform));
check('...with the matching account offered to link', /Link to Echo Account</.test(uform) && /linkGuest\(\d+, '9811111111'\)/.test(uform));
check('...and a search to find another', /id="guest-link-search"/.test(uform));
check('...and the header says they are not signed up', /Not signed up yet/.test(el('guest-edit-who').textContent));
sb.__g.openGuestEditor(rows[0].id);
check('a linked guest has none of that', !/name="guest_name"/.test(el('guest-edit-body').innerHTML) && !/guest-link-search/.test(el('guest-edit-body').innerHTML));

console.log('\n== The other views ==');
sb.__g.renderGuestSchedule('pickups');
const pick = el('guests-view-pickups').innerHTML;
check('pickups in arrival order, Cancelled out', pick.indexOf('Alpha Arriving') < pick.indexOf('Bravo Homeless') && !pick.includes('Charlie Cancelled'));
check('...with the driver\'s phone from the vehicle list', pick.includes('>0712<'));
sb.__g.renderGuestSchedule('drops');
check('drops list departures, 12-hour', el('guests-view-drops').innerHTML.includes('22 November 2026, 6:30 PM'));
sb.__g.renderGuestRooms();
const roomsHtml = el('guests-view-rooms').innerHTML;
check('rooms: occupied, Full, and who', /Full</.test(roomsHtml) && roomsHtml.includes('Alpha Arriving, Delta Roommate'));
check('a transport coordinator gets no room form', !roomsHtml.includes('guest-room-form'));
sb.__g.renderGuestVehicles();
check('vehicles: the form for a transport coordinator, no Delete', el('guests-view-vehicles').innerHTML.includes('guest-vehicle-form') && !/>Delete</.test(el('guests-view-vehicles').innerHTML));
sb.__g.renderGuestDashboard();
const dash = el('guests-view-dashboard').innerHTML;
check('dashboard: guests listed, cancelled left out', />4</.test(dash) && /1 cancelled not counted/.test(dash));
check('...and how many are not signed up', /1 not signed up/.test(dash));
check('...arrivals in the window, with how many lack a vehicle', /1 with no pickup vehicle/.test(dash));
check('...counts include "Not set"', /Not set/.test(dash));
check('...time slots by name, 12-hour', /Morning 6 AM–12 PM/.test(dash) && /Evening 6 PM–12 AM/.test(dash));
check('...beds per accommodation', /Yatri Nivas/.test(dash));
adminView.sb.__g.renderGuestSettings();
const settingsHtml = adminView.el('guests-view-settings').innerHTML;
check('lists: "Cancelled" cannot be switched off or removed', /Cancelled <span class="text-\[10px\] text-slate-400">\(required\)<\/span>/.test(settingsHtml));
check('the settings show the slot boundaries', /value="6"/.test(settingsHtml) && /value="18"/.test(settingsHtml));

console.log('\n== Reading a typed time ==');
const tsb = { String, Number };
vm.createContext(tsb);
const grabT = (n) => { const i = js.indexOf(`function ${n}(`); return js.slice(i, js.indexOf('\n}', i) + 2); };
vm.runInContext([grabT('parseTime12'), grabT('guestTime12')].join('\n') + '\nglobalThis.p = parseTime12; globalThis.t12 = guestTime12;', tsb);
const as24 = (t) => tsb.p(t).hhmm;
check('9:30 pm, 930p, 9.30 P.M. and 21:30 are all 9:30 PM', ['9:30 pm', '930p', '9.30 P.M.', '21:30', '2130'].every((t) => as24(t) === '21:30'));
check('9am, 12am, 12:15 pm', as24('9am') === '09:00' && as24('12am') === '00:00' && as24('12:15 pm') === '12:15');
check('a leading zero means 24-hour already', as24('0930') === '09:30' && as24('09:30') === '09:30');
check('9:30 with no AM or PM is asked about, not guessed', tsb.p('9:30').ambiguous === true && tsb.p('12').ambiguous === true);
check('nonsense is refused', ['25:00', '9:75 am', '13pm', 'soon'].every((t) => tsb.p(t).invalid === true));
check('shown as 9:30 PM', tsb.t12('21:30') === '9:30 PM' && tsb.t12('00:05') === '12:05 AM');
check('a time that could not be read stops the save', /const bad = \[\.\.\.form\.querySelectorAll\('\[data-time12\]'\)\]\.find/.test(js));

console.log('\n== Nights ==');
const nsb = { String, Math, Date };
vm.createContext(nsb);
vm.runInContext([grabT('guestNights')].join('\n') + `\nconst nightsLabel = ${js.match(/const nightsLabel = ([^;]+);/)[1]};\nglobalThis.n = guestNights; globalThis.l = nightsLabel;`, nsb);
check('nights in the form, as the dates change', nsb.n('2026-11-20', '2026-11-23') === 3 && nsb.l(3) === '3 nights' && nsb.l(1) === '1 night' && nsb.l(0) === 'Same day, no night');
check('...worked out again whenever either date changes', /name="checkin_date"[^>]*onchange="syncGuestNights\(\)"/.test(el('guest-edit-body').innerHTML)
  && /name="checkout_date"[^>]*onchange="syncGuestNights\(\)"/.test(el('guest-edit-body').innerHTML));
check('the rooms form takes a range', /name="roomNo" required maxlength="400" placeholder="101, or 1-10, or 101-105, 110"/.test(js));

console.log('\n== Accommodation not needed ==');
const stayRow = data.guests.find((x) => x.name === 'Alpha Arriving');
stayRow.stay_not_needed = 1;
stay.sb.__set(data);
stay.sb.__g.openGuestEditor(stayRow.id);
const sh = stay.el('guest-edit-body').innerHTML;
check('ticked: the stay details are hidden', /id="guest-stay-fields" class="hidden /.test(sh));
check('...kept, with a note saying unticking brings them back', /id="guest-stay-note" class=" col-span-2/.test(sh) && /return if you untick this/.test(sh));
check('ticking or unticking shows or hides them at once', /name="stay_not_needed"[^>]*onchange="syncGuestStayFields\(\)"/.test(sh));
stayRow.stay_not_needed = 0;
stay.sb.__g.openGuestEditor(stayRow.id);
check('unticked: the stay details are asked for', /id="guest-stay-fields" class="col-span-2/.test(stay.el('guest-edit-body').innerHTML));

console.log('\n== Checking a flight by hand ==');
const fsb = { String, encodeURIComponent };
vm.createContext(fsb);
const grabFn = (n) => { const i = js.indexOf(`function ${n}(`); return js.slice(i, js.indexOf('\n}', i) + 2); };
vm.runInContext([grabFn('esc'), grabFn('formatFullDate'), grabFn('flightNumberOf'), grabFn('flightCheckUrl'), grabFn('flightNumberLink')].join('\n')
  + '\nglobalThis.url = flightCheckUrl; globalThis.link = flightNumberLink;', fsb);
check('Google: the flight number and the day', fsb.url('google', '6e 5172', '2026-11-20') === 'https://www.google.com/search?q=6E5172%20flight%2020%20November%202026');
check('Flightradar24: the flight\'s page', fsb.url('fr24', 'AI-629', '2026-11-20') === 'https://www.flightradar24.com/data/flights/ai629');
check('a train number gets no link', fsb.url('google', '12951', '2026-11-20') === null && !/<a /.test(fsb.link('12951', '2026-11-20')));
check('in a schedule the flight number is a link that opens in a new tab', /<a href="https:\/\/www\.google\.com\/search\?q=6E5172[^"]*" target="_blank" rel="noopener"[^>]*>6E 5172<\/a>/.test(fsb.link('6E 5172', '2026-11-20')));
sb.__g.openGuestEditor(rows[0].id);
check('the editor offers Check flight for arrival and departure, without a key', /openFlightCheck\('arrival', 'google'\)/.test(el('guest-edit-body').innerHTML)
  && /openFlightCheck\('departure', 'fr24'\)/.test(el('guest-edit-body').innerHTML) && !/fetchGuestFlight/.test(el('guest-edit-body').innerHTML));
check('...even to someone who may only look', /openFlightCheck\('arrival', 'google'\)/.test((() => { stay.sb.__g.openGuestEditor(rows[0].id); return stay.el('guest-edit-body').innerHTML; })()));

console.log('\n== Wiring ==');
check('Lists & Settings is hidden until shown to an admin', /id="guests-settings-tab" class="guest-subtab hidden/.test(ejs));
check('the tab is a main tab, #faculty in the address, opened by guests.view', /const MAIN_TABS = \[[^\]]*'faculty'/.test(js)
  && /tabFaculty\.classList\.toggle\('hidden', !canSee\('faculty'\)\)/.test(js) && !/MAIN_TABS = \[[^\]]*'guests'/.test(js));
check('coordinators land on it', /: canSee\('faculty'\) \? 'faculty'/.test(js));
check('an old #guests link still opens it', /return tab === 'guests' \? 'faculty' : tab;/.test(js) && /const hashTab = tabFromHash\(\);/.test(js));
check('the tab and section are named faculty', /id="nav-tab-faculty" onclick="switchBackendTab\('faculty'\)"/.test(fs.readFileSync(appFile('views', 'admin', 'partials', 'nav-tabs.ejs'), 'utf8'))
  && /<section id="section-faculty"/.test(ejs));
check('no import option', !/import/i.test(ejs));

report();
