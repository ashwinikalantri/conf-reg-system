// The delegates' campus map.
//
//   * A hall's map location is set in Programme settings as Google Maps
//     copies it ("20.741279, 78.662397"), cleared by leaving it blank, and
//     refused when it is not a place; the change is logged.
//   * The delegate programme carries each hall's location.
//   * Halls at one spot are one building: one pin, numbered as in the list.
//   * Each place has walking directions in Google Maps and, on the day, what
//     is on there now or next.
//   * The menu offers the map only once a hall is on it; Leaflet is fetched
//     when the page opens, not with the portal; a hall in the programme opens
//     the map at its pin.
const { call, check, report, adminLogin, openDb, appFile } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
const dash = fs.readFileSync(appFile('views', 'portal', 'sections', 'dashboard.ejs'), 'utf8');
const index = fs.readFileSync(appFile('views', 'index.ejs'), 'utf8');

function load() {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      const s = new Set(['hidden']);
      els.set(id, { id, value: '', innerHTML: '', textContent: '', dataset: {}, style: {},
        classList: { add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)),
          toggle: (c, on) => { const w = on === undefined ? !s.has(c) : !!on; if (w) s.add(c); else s.delete(c); return w; }, contains: (c) => s.has(c) },
        setAttribute() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], scrollIntoView() {} });
    }
    return els.get(id);
  };
  const sb = {
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: () => el(`tmp${Math.random()}`), head: el('head'), body: el('body'), documentElement: el('html'), readyState: 'loading', cookie: '' },
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
    globalThis.__set = (d) => { programmeData = d; programmeDay = d.now ? d.now.date : null; };
    globalThis.__f = { campusPlaces, campusDirectionsUrl, campusListHtml, renderProgrammePage, openMapPage };`, sb);
  return { sb, el };
}

(async () => {
  console.log('\n== Setting a hall\'s location ==');
  const admin = await adminLogin();
  const db = openDb();
  const added = await call('POST', '/api/admin/programme/halls', { name: `Map Test Hall ${Date.now() % 100000}` }, admin);
  const id = added.body.id;
  const put = (body) => call('PUT', `/api/admin/programme/halls/${id}`, body, admin);
  const row = () => db.get('SELECT lat, lng FROM halls WHERE id = ?', [id]);
  check('as Google Maps copies it: latitude, longitude', (await put({ location: '20.741279, 78.662397' })).body.success === true
    && JSON.stringify(await row()) === JSON.stringify({ lat: 20.741279, lng: 78.662397 }));
  check('...or with a space between them', (await put({ location: ' 20.7410 78.6624 ' })).body.success === true && (await row()).lat === 20.741);
  for (const bad of ['near the canteen', '200, 78.66', '20.74', '20.74, 78.66, 3']) {
    const r = await put({ location: bad });
    check(`"${bad}" is refused, with how to write it`, r.status === 400 && /latitude, longitude/.test(r.body.error), r.body);
  }
  check('...and nothing changed', (await row()).lat === 20.741);
  check('renaming leaves the location alone', (await put({ name: 'Map Test Hall renamed' })).body.success === true && (await row()).lat === 20.741);
  const log = await db.get("SELECT old_value, new_value FROM audit_log WHERE action = 'HALL_UPDATED' AND entity_id = ? ORDER BY id DESC LIMIT 1 OFFSET 1", [String(id)]);
  check('a location change is logged, from and to', log && /20\.741279, 78\.662397/.test(log.old_value) && /20\.741, 78\.6624/.test(log.new_value), log);
  const prog = (await call('GET', '/api/programme', null, admin)).body;
  const mine = prog.halls.find((h) => h.id === id);
  check('the delegate programme carries each hall\'s location', mine && mine.lat === 20.741 && mine.lng === 78.6624);
  check('a floor can be given, where it helps', (await put({ floor: ' 2nd   floor ' })).body.success === true
    && (await db.get('SELECT floor FROM halls WHERE id = ?', [id])).floor === '2nd floor');
  check('...is in the delegate programme', (await call('GET', '/api/programme', null, admin)).body.halls.find((h) => h.id === id).floor === '2nd floor');
  check('...is logged', /2nd floor/.test((await db.get("SELECT new_value FROM audit_log WHERE action = 'HALL_UPDATED' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(id)])).new_value));
  check('...is cleared by leaving it blank, and kept when only the name changes', (await put({ name: 'Map Test Hall floor' })).body.success === true
    && (await db.get('SELECT floor FROM halls WHERE id = ?', [id])).floor === '2nd floor'
    && (await put({ floor: '' })).body.success === true && (await db.get('SELECT floor FROM halls WHERE id = ?', [id])).floor === null);
  check('...and kept short', (await put({ floor: 'x'.repeat(61) })).status === 400);
  check('a building can be named, in the programme and the log', (await put({ building: ' MCH  building ' })).body.success === true
    && (await call('GET', '/api/programme', null, admin)).body.halls.find((h) => h.id === id).building === 'MCH building'
    && /in MCH building/.test((await db.get("SELECT new_value FROM audit_log WHERE action = 'HALL_UPDATED' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(id)])).new_value));
  check('...and cleared', (await put({ building: '' })).body.success === true && (await db.get('SELECT building FROM halls WHERE id = ?', [id])).building === null);
  check('the editor has a building box, saved with the rest', /class="prog-hall-building /.test(js) && /building: document\.querySelector\(`\.prog-hall-building/.test(js));
  check('the editor has a floor box, saved with the rest', /class="prog-hall-floor /.test(js) && /floor: document\.querySelector\(`\.prog-hall-floor/.test(js));
  check('blank clears it', (await put({ location: '' })).body.success === true && JSON.stringify(await row()) === JSON.stringify({ lat: null, lng: null }));
  check('the editor has a location box on each hall, saved with the name', /class="prog-hall-loc /.test(js)
    && /location: document\.querySelector\(`\.prog-hall-loc\[data-hall="\$\{id\}"\]`\)\.value/.test(js));
  await put({ active: false });
  db.close();

  console.log('\n== One pin per building ==');
  const { sb, el } = load();
  const halls = [
    { id: 1, name: 'Main Auditorium', lat: 20.741279, lng: 78.662397 },
    { id: 2, name: 'Hall A', lat: 20.74101, lng: 78.662377 },
    { id: 9, name: 'Digital Library', lat: null, lng: null },
    { id: 7, name: 'Obstetrics and Gynaecology Seminar Hall', lat: 20.740149, lng: 78.659761 },
    { id: 6, name: 'Pediatrics Seminar Hall', lat: 20.740149, lng: 78.659761, floor: '2nd floor' },
  ];
  const places = sb.__f.campusPlaces(halls);
  check('halls without a location are left off', places.length === 3 && !places.some((p) => p.halls.some((h) => h.id === 9)));
  check('halls at the same spot share a pin, ground floor up -- a hall with no floor after', places[2].n === 3 && places[2].halls.map((h) => h.id).join() === '6,7');
  check('directions: Google Maps, walking, to the spot', sb.__f.campusDirectionsUrl(places[0])
    === 'https://www.google.com/maps/dir/?api=1&destination=20.741279,78.662397&travelmode=walking');
  sb.__set({ halls, now: { date: '2026-11-22', minutes: 10 * 60 + 15 }, mine: [], sessions: [
    { id: 11, hallId: 1, hall: 'Main Auditorium', date: '2026-11-22', start: '10:00', end: '11:00', title: 'Quality as a Strategy', speakers: 'A', counts: true },
    { id: 12, hallId: 6, hall: 'Pediatrics Seminar Hall', date: '2026-11-22', start: '14:30', end: '15:30', title: 'Neonatal QI', speakers: 'B', counts: true },
    { id: 13, hallId: 2, hall: 'Hall A', date: '2026-11-22', start: '10:00', end: '10:30', title: 'Tea', counts: false },
  ] });
  const list = sb.__f.campusListHtml(places, 3);
  check('the list numbers each place as its pin', (list.match(/class="campus-pin shrink-0/g) || []).length === 3);
  check('no building named: the first hall heads, with its floor, and names the others', /Pediatrics Seminar Hall<\/span>\s*<span class="block text-xs font-semibold text-slate-600">2nd floor<\/span>\s*<span class="block text-xs text-slate-500">Same building: Obstetrics and Gynaecology Seminar Hall</.test(list), list);
  check('...no floor where none is set', !/Main Auditorium<\/span>\s*<span class="block text-xs font-semibold text-slate-600">/.test(list) && !/Gynaecology Seminar Hall, /.test(list));
  const mch = sb.__f.campusPlaces([
    { id: 6, name: 'Pediatrics Seminar Hall', lat: 20.740149, lng: 78.659761, floor: 'First floor', building: 'Maternal and Child Health (MCH) building' },
    { id: 7, name: 'Obstetrics and Gynaecology Seminar Hall', lat: 20.740149, lng: 78.659761, floor: 'Second floor', building: 'Maternal and Child Health (MCH) building' },
    { id: 17, name: 'MLCU, MCH Wing', lat: 20.740149, lng: 78.659761, floor: 'Ground floor', building: 'Maternal and Child Health (MCH) building' }]);
  const mchList = sb.__f.campusListHtml(mch, 0);
  check('a named building heads its halls, ground floor up', mch.length === 1 && mch[0].halls.map((h) => h.id).join() === '17,6,7'
    && /Maternal and Child Health \(MCH\) building<\/span>\s*<span class="block text-xs text-slate-600">MLCU, MCH Wing <span class="text-slate-400">·<\/span> <span class="font-semibold">Ground floor/.test(mchList)
    && mchList.indexOf('Pediatrics Seminar Hall') < mchList.indexOf('Obstetrics and Gynaecology') && !/Same building/.test(mchList), mchList);
  const complex = sb.__f.campusPlaces([
    { id: 1, name: 'Main Auditorium', lat: 20.741279, lng: 78.662397, building: 'New Auditorium Complex' },
    { id: 2, name: 'Hall A', lat: 20.74101, lng: 78.662377, building: 'New Auditorium Complex' }]);
  check('halls of one building at their own spots keep their own pins, each headed by the building', complex.length === 2
    && (sb.__f.campusListHtml(complex, 0).match(/New Auditorium Complex<\/span>/g) || []).length === 2);
  const rank = (f) => vm.runInContext(`campusFloorRank(${JSON.stringify(f)})`, sb);
  check('floors ordered as people write them', rank('Basement') < rank('Ground Floor') && rank('Ground floor') < rank('1st floor')
    && rank('First Floor') === rank('1st floor') && rank('Second floor') < rank('3rd floor') && rank('') > rank('Tenth floor'));
  const solo = sb.__f.campusPlaces([{ id: 4, name: 'Sarojini Naidu Hall', lat: 20.739344, lng: 78.660126, floor: 'Ground floor' }]);
  check('...under the name, for a hall on its own', /Sarojini Naidu Hall<\/span>\s*<span class="block text-xs font-semibold text-slate-600">Ground floor<\/span>/.test(sb.__f.campusListHtml(solo, 0)));
  check('what is on now, or next today, in that building', /On now: Quality as a Strategy/.test(list) && /Next, 2:30 PM: Neonatal QI/.test(list));
  check('...a break is not "on"', !/Tea/.test(list));
  check('each has Directions, opening outside the portal', (list.match(/target="_blank" rel="noopener"[^>]*>Directions</g) || []).length === 3);
  check('the chosen place is marked', /bg-gold-50/.test(list) && /campus-pin shrink-0 is-chosen" aria-hidden="true">3</.test(list));
  check('nothing on the map: says so', /No halls are on the map yet/.test(sb.__f.campusListHtml([], 0)));
  const withVillage = sb.__f.campusPlaces([...halls, { id: 18, name: 'Madni Village (field visit)', lat: 20.685862, lng: 78.747389 }]);
  const core = vm.runInContext(`campusCore(${JSON.stringify(withVillage)})`, sb);
  check('the map opens on the campus: a village 10 km off is not in the view it fits', core.length === 3 && !core.some((p) => p.halls[0].id === 18));
  check('...but keeps its pin, and the list says how far it is', withVillage.length === 4
    && /Madni Village \(field visit\)<\/span>[\s\S]*?Off campus, about 11 km away/.test(sb.__f.campusListHtml(withVillage, 0)));
  check('...a campus hall says nothing of the sort', !/Off campus/.test(sb.__f.campusListHtml(places, 0)));

  console.log('\n== In the portal ==');
  check('the menu has Map, hidden until a hall has a location', /id="dash-menu-map" onclick="dashGo\('map'\)" class="hidden /.test(dash)
    && /menuMap\.classList\.toggle\('hidden', !campusPlaces\(programmeData\.halls\)\.length\)/.test(js));
  check('the page: map, street or satellite, Where am I, the list', /<section id="map-page"/.test(dash) && /id="campus-map"/.test(dash)
    && /id="campus-map-satellite"/.test(dash) && /onclick="locateOnCampusMap\(\)"/.test(dash) && /id="campus-map-list"/.test(dash));
  check('Leaflet is fetched when the map opens, not with the portal', !/leaflet/i.test(index) && /cdnjs\.cloudflare\.com\/ajax\/libs\/leaflet\/1\.9\.4\/leaflet\.min/.test(js));
  check('following their location stops when they leave the map', /if \(pageId !== 'map-page'\) stopCampusLocate\(\);/.test(js));
  sb.__f.renderProgrammePage();
  const progList = el('prog-page-list').innerHTML;
  check('in the programme, a hall on the map opens the map at it', /onclick="openMapPage\(1\)" aria-label="Main Auditorium on the campus map"/.test(progList), progList.slice(0, 400));
  sb.__f.openMapPage(6).catch(() => {});
  check('...at that hall\'s building', /campus-pin shrink-0 is-chosen" aria-hidden="true">3</.test(el('campus-map-list').innerHTML));
  report();
})();
