// The Guests tab as drawn: app.js run whole, fed a board computed by
// guests.js from real-shaped rows, with just enough of a page to draw into.
//
// What a coordinator sees (redesigned 20 Nov 2026): the Day plan with the
// one thing each person still needs, everyone one line a person with the
// usual cuts as chips, a person's panel, the editor enabling only the
// sections the role may edit, rooms, vehicles, and the admin-only pieces
// staying hidden.
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
    globalThis.__g = { renderGuestList, renderGuestDay, renderGuestPanel, openGuestPanel, setGuestChip, setGuestSort, setGuestDay, guestNeeds,
      openGuestCarPicker, toggleGuestSheets, renderGuestVehicles, renderGuestRooms, renderGuestSettings, openGuestEditor, fillGuestFilters, switchGuestView };`, sandbox);
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
const body = el('guests-list').innerHTML;
const rowOf = (name) => (body.split('role="button"').find((r) => r.includes(`>${name}<`)) || '');
check('everyone not cancelled is listed, a line each', ['Alpha Arriving', 'Bravo Homeless', 'Delta Roommate', 'Echo Typed'].every((n) => body.includes(`>${n}<`))
  && !body.includes('>Charlie Cancelled<') && (body.match(/role="button"/g) || []).length === 4);
check('...each opening their panel', /onclick="openGuestPanel\(\d+\)"/.test(rowOf('Alpha Arriving')));
check('arriving soon with no car: "No car", in orange', /text-orange-700 font-semibold">No car</.test(rowOf('Alpha Arriving')));
check('...and the day and time, 12-hour', />Fri 20 Nov · 09:00 am</.test(rowOf('Alpha Arriving')));
check('what is needed, as chips: a car, a room', />Car</.test(rowOf('Alpha Arriving')) && />Room</.test(rowOf('Bravo Homeless')));
check('a car chosen shows the car', />Car A</.test(rowOf('Bravo Homeless')));
check('travel not known says so, and is needed', />Not known</.test(rowOf('Echo Typed')) && />Travel details</.test(rowOf('Echo Typed')));
check('the chips count: All, Needs something, Travel not known, Staying, Own stay, To email, Cancelled',
  ['All', 'Needs something', 'Travel not known', 'Staying', 'Own stay', 'To email', 'Cancelled'].every((c) => el('guests-chips').innerHTML.includes(`${c} <b`))
  && /All <b class="ml-1\.5 tabular-nums ">4<\/b>/.test(el('guests-chips').innerHTML.replace(/\s+/g, ' ').replace(/All\s+<b/, 'All <b')), el('guests-chips').innerHTML);
sb.__g.setGuestChip('cancelled');
check('Cancelled, apart, struck through', /line-through">Charlie Cancelled/.test(el('guests-list').innerHTML) && !el('guests-list').innerHTML.includes('>Alpha Arriving<'));
sb.__g.setGuestChip('unknown');
check('Travel not known', el('guests-list').innerHTML.includes('>Echo Typed<') && !el('guests-list').innerHTML.includes('>Alpha Arriving<'));
sb.__g.setGuestChip('all');
check('the flags in view beside Sort (owner, 20 Nov); the other old filters under More filters',
  ejs.indexOf('id="guests-filter-flag"') < ejs.indexOf('id="guests-sort"') && ejs.indexOf('id="guests-filter-flag"') < ejs.indexOf('<details id="guests-more-filters"')
  && /<details id="guests-more-filters"[\s\S]*id="guests-filter-status"[\s\S]*id="guests-filter-district"[\s\S]*<\/details>/.test(ejs) && /<option value="noProgramme">/.test(ejs));

el('guests-filter-flag').value = 'noAccommodation';
sb.__g.renderGuestList();
check('filtering by a flag', el('guests-list').innerHTML.includes('>Bravo Homeless<') && !el('guests-list').innerHTML.includes('>Alpha Arriving<'));
el('guests-filter-flag').value = '';
el('guests-filter-status').value = 'Cancelled';
sb.__g.renderGuestList();
check('a status asked for shows, Cancelled too', el('guests-list').innerHTML.includes('>Charlie Cancelled<'));
el('guests-filter-status').value = '';
el('guests-search').value = 'delta';
sb.__g.renderGuestList();
check('search', el('guests-list').innerHTML.includes('>Delta Roommate<') && !el('guests-list').innerHTML.includes('>Bravo Homeless<'));
el('guests-search').value = '';
sb.__g.setGuestSort('name');
const order = [...el('guests-list').innerHTML.matchAll(/font-semibold text-navy [^>]*>([A-Z][a-z]+ [A-Za-z]+)</g)].map((m) => m[1]);
check('sorting by stay puts room 2 before room 10', /accommodation: \(g\) => [^\n]*\.replace\(\/\\d\+\/g, \(d\) => d\.padStart\(10, '0'\)\)/.test(js));
check('sorted by name', order.join() === 'Alpha Arriving,Bravo Homeless,Delta Roommate,Echo Typed', order);

console.log('\n== The Day plan ==');
sb.__g.renderGuestDay();
const dayHtml = el('guests-view-day').innerHTML;
check('it opens on the first day from today with something on', /aria-pressed="true"[^>]*>\s*<span[^>]*>Fri 20 Nov</.test(dayHtml));
check('each day says how many come and go', />1 in · 0 out</.test(dayHtml) && />0 in · 1 out</.test(dayHtml));
check('"Waiting on you": arriving with no car, staying with no room', />1<\/b> arriving by Sat 21 Nov with no car →/.test(dayHtml) && /staying, no room →/.test(dayHtml));
check('the arrival with no car has Assign car', /openGuestCarPicker\(\[1\], 'Pickup', 'day'\)[^>]*>Assign car</.test(dayHtml));
check('checking in: their room -- no buttons for a transport coordinator', /Yatri Nivas · 1/.test(dayHtml) && !/>Mark checked in</.test(dayHtml));
const adminDay = load(['guests.view', 'guests.edit', 'guests.travel', 'guests.stay', 'guests.manage']);
adminDay.sb.__set(data);
adminDay.sb.__g.renderGuestDay();
check('...Mark checked in for whoever looks after the stay', />Mark checked in</.test(adminDay.el('guests-view-day').innerHTML));
sb.__g.openGuestCarPicker([1], 'Pickup', 'day');
const pickHtml = el('guests-view-day').innerHTML;
check('the car picker: each car, free or busy, a driver, Assign, Not needed', /setGuestPick\('vehicle', &quot;Car A&quot;\)/.test(pickHtml) && /free</.test(pickHtml)
  && />Assign</.test(pickHtml) && />Not needed</.test(pickHtml));
sb.__g.setGuestDay('2026-11-22');
check('another day: who leaves, with their car', /Delta Roommate/.test(el('guests-view-day').innerHTML) && /Car A/.test(el('guests-view-day').innerHTML));
sb.__g.toggleGuestSheets();
check('driver sheets: copy for WhatsApp, and their own link', /Driver sheets · Sun 22 Nov/.test(el('guests-view-day').innerHTML));
sb.__g.toggleGuestSheets();
check('the statuses follow on the server, not by hand here', /Object\.assign\(values, guestLib\.autoStatusValues\(current, values, lists\)\)/.test(fs.readFileSync(appFile('server.js'), 'utf8')));

console.log('\n== A person, in the panel ==');
sb.__g.openGuestPanel(2);
const panel = el('guest-panel').innerHTML;
check('their parts: Coming, Staying, Going, In the programme, Notes', ['Coming', 'Staying', 'Going', 'In the programme', 'Notes &amp; contacts'].every((t) => panel.includes(`>${t}</h4>`)));
check('...each with Edit, opening the editor on that part', /openGuestEditor\(2, 'Arrival'\)/.test(panel) && /openGuestEditor\(2, 'Stay'\)/.test(panel) && /openGuestEditor\(2, 'Other'\)/.test(panel));
check('...no room: says so; Give a room is for whoever looks after the stay', />No room</.test(panel) && !/>Give a room</.test(panel)
  && (() => { adminDay.sb.__g.openGuestPanel(2); return /openGuestRoomPicker\(2, 'panel'\)[^>]*>Give a room</.test(adminDay.el('guest-panel').innerHTML); })());
check('the panel is open', !el('guest-panel').classList.contains('hidden'));

console.log('\n== The editor follows the role ==');
sb.__g.openGuestEditor(rows[0].id);
const form = el('guest-edit-body').innerHTML;
// The attribute, not the disabled: style variants in the class list.
const disabled = (name) => new RegExp(`name="${name}"[^>]*\\sdisabled(?=[\\s>])`).test(form);
check('a transport coordinator edits arrival and departure', !disabled('arrival_date') && !disabled('drop_vehicle'));
check('...not the stay', disabled('accommodation') && disabled('room_no') && disabled('accommodation_coordinator'));
check('...and the shared fields', !disabled('overall_status') && !disabled('remarks'));
const timeBox = (form.match(/data-time12="arrival_time"[\s\S]*?<\/div>/) || [''])[0];
check('time is picked, hour / minutes / am-pm, over a hidden 24-hour value', /<input type="hidden" name="arrival_time" value="09:00"/.test(form)
  && /<option value="09" selected>/.test(timeBox) && /<option value="00" selected>/.test(timeBox) && /<option value="am" selected>/.test(timeBox)
  && (timeBox.match(/<select data-part="(h|m|ap)"[^>]*onchange="onTime12Change\(this\)"/g) || []).length === 3
  && !/type="text" data-time12/.test(form));
check('...12 hours, every minute, am and pm', (timeBox.match(/data-part="h"[\s\S]*?<\/select>/)[0].match(/<option value="\d\d"/g) || []).length === 12
  && (timeBox.match(/data-part="m"[\s\S]*?<\/select>/)[0].match(/<option value="\d\d"/g) || []).length === 60);
check('the travel boxes keep to their column on a phone', /<fieldset data-group="Arrival" class="min-w-0 /.test(form));
check('opened from a part of the panel, the editor shows that part alone', /function openGuestEditor\(id, only\)/.test(js)
  && /c\.classList\.toggle\('hidden', c\.dataset\.group !== only\)/.test(js));
check('...and from a tablet up the three pickers share two columns, so the time is never cut off', /<label class="block min-w-0 md:col-span-2"><span[^>]*>Time<\/span><input type="hidden" name="arrival_time"/.test(form));
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
check('...but can be unlinked, if the account is someone else\'s', /onclick="unlinkGuest\(\d+\)"[^>]*>Unlink from this account</.test(el('guest-edit-body').innerHTML));
check('a guest not linked has no Unlink', !/unlinkGuest/.test(uform));
const roView = load(['guests.view']);
roView.sb.__set(data);
roView.sb.__g.openGuestEditor(rows[0].id);
check('...nor does someone who may not link', !/unlinkGuest/.test(roView.el('guest-edit-body').innerHTML));

console.log('\n== The other views ==');
sb.__g.renderGuestRooms();
const roomsHtml = el('guests-view-rooms').innerHTML;
check('rooms: occupied, Full, and who', /Full</.test(roomsHtml) && roomsHtml.includes('Alpha Arriving, Delta Roommate'));
check('a transport coordinator gets no room form', !roomsHtml.includes('guest-room-form'));
sb.__g.renderGuestVehicles();
check('vehicles: the form for a transport coordinator, no Delete', el('guests-view-vehicles').innerHTML.includes('guest-vehicle-form') && !/>Delete</.test(el('guests-view-vehicles').innerHTML));
adminView.sb.__g.renderGuestSettings();
const settingsHtml = adminView.el('guests-view-settings').innerHTML;
check('lists: "Cancelled" cannot be switched off or removed', /Cancelled <span class="text-\[10px\] text-slate-400">\(required\)<\/span>/.test(settingsHtml));
check('the settings show the slot boundaries', /value="6"/.test(settingsHtml) && /value="18"/.test(settingsHtml));

console.log('\n== A picked time ==');
const tsb = { String, Number };
vm.createContext(tsb);
const grabT = (n) => { const i = js.indexOf(`function ${n}(`); return js.slice(i, js.indexOf('\n}', i) + 2); };
vm.runInContext([grabT('time12Parts'), grabT('time12Value'), grabT('travelTime12'), grabT('guestTime12')].join('\n')
  + '\nglobalThis.parts = time12Parts; globalThis.val = time12Value; globalThis.t12 = travelTime12; globalThis.prog12 = guestTime12;', tsb);
const as24 = (h, m, ap) => tsb.val(h, m, ap).hhmm;
check('09 : 30 pm is 21:30; 12 : 00 am midnight; 12 : 15 pm noon', as24('09', '30', 'pm') === '21:30' && as24('12', '00', 'am') === '00:00' && as24('12', '15', 'pm') === '12:15');
check('a saved time opens picked', JSON.stringify(tsb.parts('21:30')) === '{"h":"09","m":"30","ap":"pm"}' && JSON.stringify(tsb.parts('00:05')) === '{"h":"12","m":"05","ap":"am"}');
check('...and every one reads back as it was', Array.from({ length: 24 * 60 }, (_, i) => `${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`)
  .every((t) => { const x = tsb.parts(t); return as24(x.h, x.m, x.ap) === t; }));
check('nothing picked is no time; part picked is not saved', tsb.val('', '', '').empty === true && tsb.val('09', '30', '').incomplete === true && tsb.val('', '30', 'pm').incomplete === true);
check('shown as 09:30 pm', tsb.t12('21:30') === '09:30 pm' && tsb.t12('00:05') === '12:05 am');
check('...while the programme keeps its own times (9:30 PM)', tsb.prog12('21:30') === '9:30 PM');
check('a time half picked stops the save', /const bad = \[\.\.\.form\.querySelectorAll\('\[data-time12\]'\)\]\.find\(\(el\) => el\.dataset\.invalid === '1'\)/.test(js));
check('picking the hour fills in :00; clearing it clears the time', /sel\.dataset\.part === 'h' && !sel\.value\) \{ part\('m'\)\.value = ''; part\('ap'\)\.value = ''; \}/.test(js)
  && /sel\.value && !part\('m'\)\.value\) part\('m'\)\.value = '00'/.test(js));

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
check('...kept, with a note saying unticking brings them back', /id="guest-stay-note" class=" col-span-full/.test(sh) && /return if you untick this/.test(sh));
check('ticking or unticking shows or hides them at once', /name="stay_not_needed"[^>]*onchange="syncGuestStayFields\(\)"/.test(sh));
stayRow.stay_not_needed = 0;
stay.sb.__g.openGuestEditor(stayRow.id);
check('unticked: the stay details are asked for', /id="guest-stay-fields" class="col-span-full/.test(stay.el('guest-edit-body').innerHTML));

console.log('\n== Institute and district filters ==');
const placeOf = { 'Alpha Arriving': ['MGIMS, Sevagram', 'Wardha', 'Maharashtra'], 'Bravo Homeless': ['mgims,  sevagram', 'Wardha', 'Maharashtra'],
  'Charlie Cancelled': ['AIIMS, Nagpur', 'Aurangabad', 'Bihar'], 'Delta Roommate': ['GMC Aurangabad', 'Aurangabad', 'Maharashtra'] };
data.guests.forEach((x) => { const p = placeOf[x.name] || [null, null, null]; [x.institution, x.district, x.state] = p; });
sb.__set(data);
sb.__g.fillGuestFilters();
const instOpts = el('guests-filter-institution').innerHTML;
const distOpts = el('guests-filter-district').innerHTML;
check('the institute filter lists each institute once, with how many, case and spacing aside', /<option value="">Any institute<\/option>/.test(instOpts)
  && /<option value="mgims, sevagram">MGIMS, Sevagram \(2\)<\/option>/.test(instOpts) && (instOpts.match(/sevagram/gi) || []).length === 2, instOpts);
check('...and those with none recorded (not signed up)', /<option value="__none">Institute not recorded \(1\)<\/option>/.test(instOpts));
check('the district filter keeps districts of the same name in different states apart', /value="aurangabad\|bihar">Aurangabad, Bihar \(1\)/.test(distOpts)
  && /value="aurangabad\|maharashtra">Aurangabad, Maharashtra \(1\)/.test(distOpts) && /Wardha, Maharashtra \(2\)/.test(distOpts), distOpts);
const listed = () => ['Alpha Arriving', 'Bravo Homeless', 'Charlie Cancelled', 'Delta Roommate', 'Echo Typed'].filter((n) => el('guests-list').innerHTML.includes(`>${n}<`));
el('guests-filter-institution').value = 'mgims, sevagram';
sb.__g.renderGuestList();
check('filtering by institute', listed().join() === 'Alpha Arriving,Bravo Homeless', listed());
el('guests-filter-institution').value = '';
el('guests-filter-district').value = 'aurangabad|maharashtra';
sb.__g.renderGuestList();
check('filtering by district', listed().join() === 'Delta Roommate', listed());
el('guests-filter-district').value = '__none';
sb.__g.renderGuestList();
check('...or by none recorded', listed().join() === 'Echo Typed', listed());
el('guests-filter-district').value = '';
sb.__g.renderGuestList();
check('the server sends district and state with each faculty member', /u\.institution, u\.district, u\.state/.test(fs.readFileSync(appFile('server.js'), 'utf8')));

console.log('\n== Room No ==');
const roomData = { ...data, rooms: [
  { id: 1, accommodation: 'Yatri Nivas', room_no: '2', room_type: 'Double', beds: 2, occupied: 1 },
  { id: 2, accommodation: 'Yatri Nivas', room_no: '10', room_type: 'Single', beds: 1, occupied: 1 },
  { id: 3, accommodation: 'MGIMS Guesthouse', room_no: '7', beds: 2, occupied: 0 }] };
const roomGuest = { ...data.guests[0], id: 9001, accommodation: 'Yatri Nivas', room_no: '2', stay_not_needed: 0 };
stay.sb.__set({ ...roomData, guests: [...data.guests, roomGuest] });
stay.sb.__g.openGuestEditor(9001);
const rh = stay.el('guest-edit-body').innerHTML;
const roomSelect = (rh.match(/<select name="room_no"[\s\S]*?<\/select>/) || [''])[0];
check('Room No is a drop-down, not typed', !!roomSelect && !/<input name="room_no"/.test(rh));
check('...of the rooms listed at their accommodation, with type and beds taken', /<option value="2" selected>2 · Double · 1 of 2 beds taken<\/option>/.test(roomSelect)
  && /<option value="10" >10 · Single · 1 of 1 bed taken \(full\)<\/option>/.test(roomSelect) && !/value="7"/.test(roomSelect), roomSelect);
check('...and changes with the accommodation', /name="accommodation"[^>]*onchange="syncGuestRoomOptions\(\)"/.test(rh));
const optHtml = (acc, cur, keep) => vm.runInContext(`guestRoomOptionsHtml(${JSON.stringify(acc)}, ${JSON.stringify(cur)}, ${keep})`, stay.sb);
check('a room no longer listed stays offered to whoever has it', /<option value="99" selected>99 \(not on the Rooms list\)<\/option>/.test(optHtml('Yatri Nivas', '99', true)));
check('...but not once the accommodation is changed', !/value="99"/.test(optHtml('MGIMS Guesthouse', '99', false)));
check('no accommodation chosen: asks for it first', /Choose the accommodation first/.test(optHtml('', '', false)));
check('an accommodation with no rooms listed says where to add them', /No rooms listed here yet: add them under Rooms/.test(optHtml('Hindi University Guesthouse', '', false)));
check('the transport coordinator cannot change it', /<select name="room_no" disabled/.test((() => { sb.__set({ ...roomData, guests: [...data.guests, roomGuest] }); sb.__g.openGuestEditor(9001); return el('guest-edit-body').innerHTML; })()));
sb.__set(data); stay.sb.__set(data);

console.log('\n== The tab badge ==');
check('the Faculty tab shows how many faculty there are, Cancelled aside', /const facultyCount = guestData\.dashboard\.listed;/.test(js)
  && /id="badge-faculty-count" class="hidden bg-slate-100 text-slate-700/.test(fs.readFileSync(appFile('views', 'admin', 'partials', 'nav-tabs.ejs'), 'utf8')) && !/badge-guest-alerts/.test(js));

console.log('\n== Pickup or drop not required ==');
const legRow = data.guests.find((x) => x.name === 'Alpha Arriving');
Object.assign(legRow, { pickup_status: 'Not required', arrival_mode: 'Flight', arrival_point: 'Nagpur Airport', pickup_vehicle: 'Car A' });
sb.__set(data);
sb.__g.openGuestEditor(legRow.id);
const lh = el('guest-edit-body').innerHTML;
check('pickup not required: date, time and status asked for', /name="arrival_date"/.test(lh) && /name="arrival_time"/.test(lh) && /name="pickup_status"/.test(lh));
check('...mode, number, point and vehicle hidden', /id="guest-arrival-details" class="hidden col-span-full/.test(lh)
  && ['arrival_mode', 'arrival_number', 'arrival_point', 'pickup_vehicle'].every((f) => lh.indexOf(`name="${f}"`) > lh.indexOf('id="guest-arrival-details"')));
check('...with a note, which says what was entered earlier is kept', /id="guest-arrival-note" class="col-span-full[^"]*">Pickup not required: only the date and time are needed\. Details entered earlier are kept/.test(lh));
check('...changing the status shows or hides them at once', /name="pickup_status"[^>]*onchange="syncGuestTransferFields\('arrival'\)"/.test(lh)
  && /name="drop_status"[^>]*onchange="syncGuestTransferFields\('departure'\)"/.test(lh));
check('the drop is asked for in full while it is required', /id="guest-departure-details" class="col-span-full/.test(lh) && /id="guest-departure-note" class="hidden /.test(lh));
sb.__g.renderGuestList();
const lrow = (el('guests-list').innerHTML.split('role="button"').find((r) => r.includes('>Alpha Arriving<')) || '');
check('the list shows the arrival time and "Own way", not the set-aside details', />Fri 20 Nov · 09:00 am</.test(lrow) && />Own way</.test(lrow)
  && !/Nagpur Airport|>Car A</.test(lrow));
sb.__set({ ...data, pickups: [{ id: legRow.id, name: 'Alpha Arriving', at: '2026-11-20 09:00', status: 'Not required', clash: [], alert: false }] });
sb.__g.setGuestDay('2026-11-20');
check('the Day plan says "Not needed", and asks for no car', />Not needed</.test(el('guests-view-day').innerHTML) && !/>Assign car</.test(el('guests-view-day').innerHTML));
Object.assign(legRow, { pickup_status: null, arrival_mode: null, arrival_point: null, pickup_vehicle: null });
sb.__set(data);

console.log('\n== No flight look-up or check links ==');
sb.__g.openGuestEditor(rows[0].id);
check('the editor has no flight look-up or check links', !/fetchGuestFlight|openFlightCheck|data-flight-checks|guest-flight-/.test(el('guest-edit-body').innerHTML));
check('...and the code for them is gone', !/function (fetchGuestFlight|useGuestFlight|openFlightCheck|flightCheckUrl|flightNumberLink)\(|\/api\/guests\/flight|flightradar24/i.test(js));

console.log('\n== Volunteers and the Front Desk ==');
check('the dropdowns are Transport Volunteer and Accommodation Volunteer', />Transport Volunteer</.test(adminView.el('guest-edit-body').innerHTML)
  && />Accommodation Volunteer</.test(adminView.el('guest-edit-body').innerHTML));
const mineBefore = el('guests-filter-flag').value;
el('guests-filter-flag').value = 'mine';
vm.runInContext("activeAdminUser = { phone_number: 'A1' };", sb);
data.guests.forEach((x) => { x.accommodation_coordinator = x.name === 'Bravo Homeless' ? 'A1' : null; });
sb.__g.renderGuestList();
check('"Assigned to me" shows a volunteer their own faculty', el('guests-list').innerHTML.includes('>Bravo Homeless<') && !el('guests-list').innerHTML.includes('>Alpha Arriving<'));
el('guests-filter-flag').value = mineBefore;
const dsb = { String, Number, Date, Math };
vm.createContext(dsb);
vm.runInContext(['let canKeys = [];', 'function can(k) { return canKeys.includes(k); }', `const deskBtn = ${js.match(/const deskBtn = (\(label, onclick, tone\) => \{[\s\S]*?\n\};)/)[1]}`, grabT('esc'), grabT('formatFullDate'), js.match(/const SHORT_MONTHS = [^\n]+/)[0], grabT('shortDateRange'), grabT('guestTime12'), grabT('guestWhen'), grabT('travelTime12'), grabT('travelWhen'), grabT('guestNights'), grabT('transferNotRequired'), grabT('guestLegHtml'), grabT('guestStayHtml'), grabT('deskCard'), grabT('deskFacultyCard')].join('\n')
  + `\nconst nightsLabel = ${js.match(/const nightsLabel = ([^;]+);/)[1]};\nglobalThis.card = deskFacultyCard;`, dsb);
const dcard = dsb.card({ arrival_date: '2026-11-20', arrival_time: '21:30', arrival_mode: 'Flight', arrival_number: '6E 123', pickup_vehicle: 'Car A',
  accommodation: 'Yatri Nivas', room_no: '7', checkin_date: '2026-11-20', checkout_date: '2026-11-22', transport_volunteer: 'Tara' });
check('the Front Desk shows a faculty member\'s travel and stay', /Faculty — travel &amp; stay|Faculty — travel & stay/.test(dcard)
  && /20 November 2026, 09:30 pm<\/p><p class="text-xs text-slate-500">Flight · 6E 123/.test(dcard) && /Yatri Nivas · 7/.test(dcard) && /2 nights/.test(dcard) && /Tara/.test(dcard));
check('...and nothing when there is nothing to show', dsb.card({ id: 1 }) === '' && dsb.card(null) === '');
const dcardOwn = dsb.card({ arrival_date: '2026-11-20', arrival_time: '21:30', arrival_mode: 'Flight', arrival_number: '6E 123', pickup_vehicle: 'Car A', pickup_status: 'Not required' });
check('...and for a pickup not required, the time and "Not required" only', /09:30 pm<\/p><p class="text-xs mt-0\.5 text-slate-500">Not required/.test(dcardOwn) && !/6E 123|Car A/.test(dcardOwn));
check('...placed on the record, after the programme', /const left = \[deskDaysCard\(conferenceDays, reg\), reg \? deskProgrammeCard\(selections, conferenceDays\) : '', (deskCertificatesCard\(d\.certificates\), )?deskFacultyCard\(guest\)\]/.test(js));
vm.runInContext("canKeys = ['guests.view', 'guests.travel'];", dsb);
check('a coordinator gets Travel & stay on the desk, even before details exist', /deskOpenFaculty\(5\)[^>]*>Travel &amp; stay</.test(dsb.card({ id: 5 })) || /deskOpenFaculty\(5\)[^>]*>Travel & stay</.test(dsb.card({ id: 5 })));
check('...and the empty card says so', /No travel or stay details yet/.test(dsb.card({ id: 5 })));
vm.runInContext("canKeys = ['guests.view'];", dsb);
check('someone who may only look gets View record', /deskOpenFaculty\(5\)[^>]*>View record</.test(dsb.card({ id: 5 })));

console.log('\n== On a phone ==');
el('guests-filter-flag').value = ''; el('guests-filter-status').value = ''; el('guests-search').value = '';
sb.__g.renderGuestList();
const ejsAll = ejs;
check('the list stacks on a phone: name, then arrives / leaves / stay, then needs', /grid grid-cols-3 lg:grid-cols-\[/.test(el('guests-list').innerHTML)
  && /lg:hidden block text-\[11px\][^>]*>Arrives</.test(el('guests-list').innerHTML));
check('a Sort select', /id="guests-sort" onchange="setGuestSort\(this\.value\)"/.test(ejsAll));
check('four tabs: Day plan, Faculty, Cars drivers & rooms, Settings', [...ejsAll.matchAll(/data-guest-view="(\w+)"/g)].map((m) => m[1]).join() === 'day,list,resources,settings');
sb.__g.setGuestDay('2026-11-20');
check('the Day plan on a phone: Arriving, Leaving, Rooms, one at a time', /setGuestDaySection\('in'\)/.test(el('guests-view-day').innerHTML) && /data-daysec="out" class="hidden lg:block/.test(el('guests-view-day').innerHTML));
check('the panel is full screen on a phone', /id="guest-panel" class="hidden fixed inset-y-0 right-0 z-50 w-full sm:w-\[30rem\]/.test(ejsAll));
sb.__g.renderGuestRooms();
check('rooms as cards: beds used of beds', /Yatri Nivas · 1<\/p>/.test(el('guests-view-rooms').innerHTML) && /2 of 2 beds/.test(el('guests-view-rooms').innerHTML));
sb.__g.renderGuestVehicles();
// Vehicles and drivers, two lists (19 Nov 2026): a row each, stacked on a phone.
check('vehicles listed, each a row that stacks on a phone', /<p class="font-semibold text-slate-800 break-words">Car A<\/p>/.test(el('guests-view-vehicles').innerHTML) && />Drivers<\/h3>/.test(el('guests-view-vehicles').innerHTML));
const modal = fs.readFileSync(appFile('views', 'admin', 'modals', 'guest-edit.ejs'), 'utf8');
check('the editor is full-screen on a phone, Save always in view', /id="modal-guest-edit" class="hidden fixed inset-0[^"]*items-stretch sm:items-center p-0 sm:p-4/.test(modal)
  && /h-full sm:h-auto/.test(modal) && /overflow-y-auto flex-1 min-h-0/.test(modal));
sb.__g.openGuestEditor(rows[0].id);
check('...its fields in one column on a phone', /grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3/.test(el('guest-edit-body').innerHTML) && !/col-span-2 sm:col-span-4/.test(el('guest-edit-body').innerHTML));

console.log('\n== Whatever is entered is shown ==');
const psb = { String, Number, Date, Math };
vm.createContext(psb);
vm.runInContext([grabT('esc'), grabT('formatFullDate'), js.match(/const SHORT_MONTHS = [^\n]+/)[0], grabT('shortDateRange'), grabT('guestTime12'), grabT('guestWhen'), grabT('travelTime12'), grabT('travelWhen'), grabT('guestNights'), grabT('transferNotRequired'), grabT('guestLegHtml'), grabT('guestStayHtml')].join('\n')
  + `\nconst nightsLabel = ${js.match(/const nightsLabel = ([^;]+);/)[1]};\nglobalThis.leg = guestLegHtml; globalThis.stayOf = guestStayHtml; globalThis.range = shortDateRange;`, psb);
const datesOnly = psb.stayOf({ checkin_date: '2026-11-20', checkout_date: '2026-11-22' });
check('stay dates with no guesthouse yet are shown, with the nights', /20 - 22 Nov 2026 · 2 nights/.test(datesOnly) && !/Not set/.test(datesOnly), datesOnly);
check('a stay range is written short: "20 - 23 Nov 2026"', psb.range('2026-11-20', '2026-11-23') === '20 - 23 Nov 2026');
check('...across months, each month named once', psb.range('2026-11-30', '2026-12-02') === '30 Nov - 2 Dec 2026');
check('...across years, each year too', psb.range('2026-12-30', '2027-01-02') === '30 Dec 2026 - 2 Jan 2027');
check('...and one day as one date', psb.range('2026-11-20', '2026-11-20') === '20 Nov 2026');
check('one date alone is shown too', /From 20 November 2026/.test(psb.stayOf({ checkin_date: '2026-11-20' })) && /Until 22 November 2026/.test(psb.stayOf({ checkout_date: '2026-11-22' })));
check('a room type alone, a room number alone', /Double/.test(psb.stayOf({ room_type: 'Double' })) && /Room 7/.test(psb.stayOf({ room_no: '7' })));
check('nothing entered gives nothing (the list says Not set)', psb.stayOf({}) === '' && psb.leg() === '');
check('arranging their own stay says so, not the details kept from before', /Arranging their own stay/.test(psb.stayOf({ stay_not_needed: 1, accommodation: 'Yatri Nivas' }))
  && !/Yatri/.test(psb.stayOf({ stay_not_needed: 1, accommodation: 'Yatri Nivas' })));
const shared = psb.stayOf({ accommodation: 'Yatri Nivas', room_no: '102', flags: { sharedRoom: ['Dr A Rao', 'Dr B <Shah>'] } });
check('sharing a room: who with, under the stay', /Yatri Nivas · 102[\s\S]*Sharing with Dr A Rao, Dr B &lt;Shah&gt;/.test(shared), shared);
check('...and nothing about sharing when alone', !/Sharing/.test(psb.stayOf({ accommodation: 'Yatri Nivas', room_no: '101', flags: { sharedRoom: [] } })));
const partLeg = psb.leg(null, null, 'Flight', '6E 123', null, null, 'Pending');
check('a flight number or status with no date yet is shown', /Flight · 6E 123/.test(partLeg) && /Pending/.test(partLeg) && !/No vehicle/.test(partLeg));
check('"No vehicle" only once there is a date to meet', /No vehicle/.test(psb.leg('2026-11-20')));

console.log('\n== The travel & stay email ==');
{
  const mk = (extra) => G.buildBoard({ guests: [
    { id: 1, name: 'Sent Same', email: 'a@x.org', arrival_date: '2026-11-21', arrangements_sent_at: Date.UTC(2026, 10, 20, 10), arrangements_sent_by: 'Tara', ...extra },
    { id: 2, name: 'Never Sent', email: 'b@x.org' },
    { id: 3, name: 'No Address' },
    { id: 4, name: 'Gone Away', email: 'd@x.org', overall_status: 'Cancelled' },
  ], lists, settings, today: '2026-11-19' });
  const same = mk({});
  same.guests[0].arrangements_sent_print = G.arrangementsPrint(same.guests[0]);
  const fresh = G.buildBoard({ guests: same.guests, lists, settings, today: '2026-11-19' });
  const e = load(['guests.view', 'guests.edit']);
  e.sb.__set({ ...data, ...fresh });
  e.sb.__g.setGuestChip('all');
  e.sb.__g.renderGuestList();
  const html = e.el('guests-list').innerHTML;
  const rowOf2 = (n) => html.split('role="button"').find((r) => r.includes(n)) || '';
  check('sent: a badge with the day, and Email again', /Emailed 20 Nov ✓/.test(rowOf2('Sent Same')) && />Email again</.test(rowOf2('Sent Same')), rowOf2('Sent Same'));
  check('...who sent it, on hover', /title="Sent 20 Nov[^"]*by Tara"/.test(rowOf2('Sent Same')));
  check('never sent: an Email button, no badge', />Email</.test(rowOf2('Never Sent')) && !/Emailed/.test(rowOf2('Never Sent')));
  check('the button does not open the panel too', /onclick="event\.stopPropagation\(\); emailGuestArrangements\(2, this\)"/.test(rowOf2('Never Sent')));
  check('no address: says so, no button', /No email address/.test(rowOf2('No Address')) && !/emailGuestArrangements/.test(rowOf2('No Address')));
  e.sb.__g.setGuestChip('toemail');
  const due = e.el('guests-list').innerHTML;
  check('"To email": the ones not sent yet', /Never Sent/.test(due) && /No Address/.test(due) && !/Sent Same/.test(due) && !/Gone Away/.test(due));
  const moved = G.buildBoard({ guests: [{ ...same.guests[0], arrival_time: '11:00' }], lists, settings, today: '2026-11-19' });
  e.sb.__set({ ...data, ...moved });
  e.sb.__g.setGuestChip('toemail');
  const m = e.el('guests-list').innerHTML;
  check('changed since: amber, and back on "To email"', /Emailed 20 Nov · changed since/.test(m) && /bg-amber-50/.test(m));
  e.sb.__g.openGuestPanel(1);
  check('the panel: when, by whom, what changed, and the button', /Sent 20 Nov[^<]*by Tara\. Their travel or stay has changed since\./.test(e.el('guest-panel').innerHTML)
    && /emailGuestArrangements\(1, this\)/.test(e.el('guest-panel').innerHTML));
  const v = load(['guests.view']);
  v.sb.__set({ ...data, ...fresh });
  v.sb.__g.setGuestChip('all');
  v.sb.__g.renderGuestList();
  check('without guests.edit: the badge, no button', /Emailed 20 Nov/.test(v.el('guests-list').innerHTML) && !/emailGuestArrangements/.test(v.el('guests-list').innerHTML));
  check('sending a faculty email redraws the page', /if \(send && data\.sent && guestData && document\.getElementById\('guests-list'\)\) renderGuests\(\);/.test(js));
}

console.log('\n== Wiring ==');
check('Lists & Settings is hidden until shown to an admin', /id="guests-settings-tab" class="guest-subtab hidden/.test(ejs));
check('the tab is a main tab, #faculty in the address, opened by guests.view', /const MAIN_TABS = \[[^\]]*'faculty'/.test(js)
  && /tabFaculty\.classList\.toggle\('hidden', !canSee\('faculty'\)\)/.test(js) && !/MAIN_TABS = \[[^\]]*'guests'/.test(js));
check('coordinators land on it', /: canSee\('faculty'\) \? 'faculty'/.test(js));
check('an old #guests link still opens it', /\{ guests: 'faculty', certsettings: 'general' \}\[tab\] \|\| tab/.test(js) && /const hashTab = tabFromHash\(\);/.test(js));
check('the tab and section are named faculty', /id="nav-tab-faculty" onclick="switchBackendTab\('faculty'\)"/.test(fs.readFileSync(appFile('views', 'admin', 'partials', 'nav-tabs.ejs'), 'utf8'))
  && /<section id="section-faculty"/.test(ejs));
check('no import option', !/import/i.test(ejs));

report();
