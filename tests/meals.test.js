// Meals at the counters (planned and agreed 31 Oct 2026): confirmed
// delegates, faculty and organisers are served, once per person per meal,
// whichever counter; others are sent to the registration desk unless served
// anyway with a reason. A meal is the programme's sessions ticked "meal" that
// start together, so the workshop-day lunch on two lawns is one meal.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const M = require(appFile('meals.js'));
const perms = require(appFile('permissions.js'));

const N = String(Date.now() % 100000000).padStart(8, '0');

console.log('\n== The rules ==');
{
  const sessions = [
    { id: 1, session_date: '2026-11-21', start_time: '13:00', end_time: '14:00', title: 'Lunch', hall: 'Community Medicine Lawn', meal: 1 },
    { id: 2, session_date: '2026-11-21', start_time: '13:00', end_time: '14:00', title: 'Lunch', hall: 'Kamla Desikan Lawn', meal: 1 },
    { id: 3, session_date: '2026-11-21', start_time: '20:00', end_time: '21:30', title: 'Conference Dinner', hall: 'Dining Area', meal: 1 },
    { id: 4, session_date: '2026-11-21', start_time: '13:00', end_time: '14:00', title: 'A talk', hall: 'Hall A', meal: 0 },
  ];
  const meals = M.groupMeals(sessions);
  check('two lawns at the same time are one meal, two counters; a talk is no meal', meals.length === 2 && meals[0].counters.length === 2
    && meals[0].counters.map((c) => c.hall).join() === 'Community Medicine Lawn,Kamla Desikan Lawn' && meals[1].title === 'Conference Dinner');
  const at = (hhmm) => Date.parse(`2026-11-21T${hhmm}:00+05:30`);
  check('served from an hour before to an hour after', M.mealWindow(meals[0], at('12:00')).open && M.mealWindow(meals[0], at('15:00')).open
    && !M.mealWindow(meals[0], at('11:59')).open && M.mealWindow(meals[0], at('15:01')).over);
  check('the counter first shows the meal on now, else the next', M.currentMeal(meals, at('13:30')).key === meals[0].key && M.currentMeal(meals, at('16:00')).key === meals[1].key);
  check('confirmed delegate: served', M.decide({ regStatus: 'BANK_VERIFIED' }).eligible && M.decide({ regStatus: 'BANK_VERIFIED' }).kind === 'DELEGATE');
  check('faculty, registered or not: served, as faculty', M.decide({ faculty: true }).kind === 'FACULTY' && M.decide({ faculty: true, regStatus: 'PENDING' }).eligible);
  check('organiser: served', M.decide({ staff: true }).kind === 'ORGANISER' && M.decide({ staff: true }).eligible);
  const due = M.decide({ regStatus: 'PARTIAL_PAYMENT' });
  check('balance due: not served, sent to the registration desk', !due.eligible && /Balance due: send them to the registration desk/.test(due.reason));
  check('not registered, or taken off the Faculty list: not served', !M.decide({}).eligible && /Not registered/.test(M.decide({}).reason) && /cancelled/.test(M.decide({ facultyCancelled: true }).reason));
  const code = M.newPassCode(require('crypto').randomBytes);
  check('a meal pass code: MP and ten letters or digits, no look-alikes', M.PASS_RE.test(code) && !/[01IO]/.test(code.slice(2)), code);
}

console.log('\n== The role and the permissions ==');
check('a Volunteer – Meals role that may serve and nothing else', JSON.stringify(perms.permissionsForRole('VOLUNTEER_MEALS')) === '["meals.scan"]');
check('the counter and the counts are their own permissions', perms.PERMISSION_KEYS.includes('meals.scan') && perms.PERMISSION_KEYS.includes('meals.view'));
check('the Meals report needs the counts', perms.REPORT_PERMISSIONS.meals === 'meals.view');

(async () => {
  const admin = await adminLogin();
  // The academic reviewer holds nothing about meals (the Front Desk serves them since 6 Nov 2026).
  const desk = await loginPassword('9000000003', ADMIN_PW);
  const db = openDb();
  const made = { halls: [], sessions: [], regs: [], guests: [] };
  try {
    console.log('\n== A meal at two counters ==');
    const ist = new Date(Date.now() + 5.5 * 3600e3);
    const today = ist.toISOString().slice(0, 10);
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const start = hhmm(Math.max(0, Math.min(mins - 5, 22 * 60)));
    const end = hhmm(Math.max(0, Math.min(mins - 5, 22 * 60)) + 60);
    const hallA = (await call('POST', '/api/admin/programme/halls', { name: `Lawn A ${N}` }, admin)).body.id;
    const hallB = (await call('POST', '/api/admin/programme/halls', { name: `Lawn B ${N}` }, admin)).body.id;
    made.halls.push(hallA, hallB);
    const s1 = await call('POST', '/api/admin/programme/sessions', { hallId: hallA, date: today, start, end, title: `Test Lunch ${N}`, counts: false, meal: true }, admin);
    const s2 = await call('POST', '/api/admin/programme/sessions', { hallId: hallB, date: today, start, end, title: `Test Lunch ${N}`, counts: false, meal: true }, admin);
    made.sessions.push(s1.body.id, s2.body.id);
    check('a session can be ticked as a meal', s1.body.success && (await db.get('SELECT meal FROM programme_sessions WHERE id = ?', [s1.body.id])).meal === 1);
    const list = await call('GET', '/api/meals', null, admin);
    const meal = list.body.meals.find((m) => m.title === `Test Lunch ${N}`);
    check('the counter sees it, being served, at both lawns', meal && meal.window.open && meal.counters.length === 2 && list.body.expected.total > 0, list.body);
    check('a role without meals.scan cannot open the counter', (await call('GET', '/api/meals', null, desk)).status === 403);

    const reg = async (status, tag) => {
      const phone = `+9197${N.slice(-7)}${tag}`;
      await db.run('INSERT INTO users (phone_number, full_name, role, created_at) VALUES (?, ?, ?, ?)', [phone, `Meal ${tag} ${N}`, 'DELEGATE', Date.now()]);
      const r = await db.run(`INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status, registration_number)
        VALUES (?, ?, 'chw', 'Frontline Health Worker', ?, ?)`, [phone, `Meal ${tag} ${N}`, status, `ML${tag}${N}`]);
      made.regs.push({ id: r.lastID, phone });
      return `ML${tag}${N}`;
    };
    const okId = await reg('BANK_VERIFIED', '1');
    const dueId = await reg('PARTIAL_PAYMENT', '2');
    const serve = (body) => call('POST', '/api/meals/serve', { mealKey: meal.key, sessionId: meal.counters[0].sessionId, ...body }, admin);

    const first = await serve({ identifier: okId });
    check('a confirmed delegate\'s badge: Serve', first.body.result === 'SERVE' && first.body.person.kind === 'DELEGATE' && first.body.servingId, first.body);
    const again = await call('POST', '/api/meals/serve', { mealKey: meal.key, sessionId: meal.counters[1].sessionId, identifier: okId }, admin);
    check('...at the other lawn: Already served, when and where', again.body.result === 'ALREADY' && again.body.counter === `Lawn A ${N}` && again.body.servedAt > 0, again.body);
    const notYet = await serve({ identifier: dueId });
    check('balance due: Not on the list, with why', notYet.body.result === 'NOT_ELIGIBLE' && /Balance due/.test(notYet.body.person.reason), notYet.body);
    const anyway = await serve({ personKey: notYet.body.person.key, overrideReason: 'Paying at the desk after lunch' });
    check('...served anyway, the reason kept', anyway.body.result === 'SERVE' && anyway.body.anyway === true
      && (await db.get('SELECT override_reason FROM meal_servings WHERE id = ?', [anyway.body.servingId])).override_reason === 'Paying at the desk after lunch'
      && !!(await db.get("SELECT 1 AS y FROM audit_log WHERE action = 'MEAL_SERVED_ANYWAY' AND entity_id = ?", [String(anyway.body.servingId)])));
    const unknown = await serve({ identifier: `NOPE${N}` });
    check('a code nobody has: Not found', unknown.status === 404 && unknown.body.result === 'UNKNOWN');

    console.log('\n== Faculty with no account: a pass, and by name ==');
    const g = await db.run("INSERT INTO guests (guest_name, guest_designation, overall_status, created_at) VALUES (?, 'Professor', 'Confirmed', ?)", [`Prof Meal Faculty ${N}`, Date.now()]);
    made.guests.push(g.lastID);
    const found = await call('GET', `/api/meals/search?q=${encodeURIComponent(`Meal Faculty ${N}`)}`, null, admin);
    const fp = (found.body.people || []).find((p) => p.key === `faculty-${g.lastID}`);
    check('found by name, as faculty, served', fp && fp.eligible && fp.kindLabel === 'Faculty', found.body);
    const pdf = await call('GET', '/api/admin/meals/passes.pdf', null, admin);
    const pass = await db.get('SELECT code FROM meal_passes WHERE person_key = ?', [`faculty-${g.lastID}`]);
    check('the meal passes print, one for them among them', pdf.status === 200 && /^%PDF/.test(pdf.raw || '') && pass && M.PASS_RE.test(pass.code));
    const byPass = await serve({ identifier: pass.code });
    check('their pass: Serve, as faculty', byPass.body.result === 'SERVE' && byPass.body.person.kind === 'FACULTY', byPass.body);
    const byName = await serve({ personKey: `faculty-${g.lastID}` });
    check('...found by name too: the same person, Already served', byName.body.result === 'ALREADY');

    console.log('\n== A mistake taken back ==');
    const undo = await call('POST', '/api/meals/undo', { servingId: first.body.servingId }, admin);
    const reserve = await serve({ identifier: okId });
    check('undone, they can be served again', undo.body.success && reserve.body.result === 'SERVE', [undo.body, reserve.body]);

    console.log('\n== The counts ==');
    const sum = await call('GET', '/api/admin/meals/summary', null, admin);
    const sm = sum.body.meals.find((m) => m.key === meal.key);
    check('served, by kind and at each counter', sm.served === 3 && sm.byKind.DELEGATE === 2 && sm.byKind.FACULTY === 1 && sm.anyway === 1
      && sm.counters[0].served === 3 && sm.counters[1].served === 0, sm);
    const rep = await call('GET', '/api/admin/reports/meals?format=json', null, admin);
    check('the Meals report: each meal, each counter, who was served', rep.body.success && rep.body.report.sections[0].name === 'Meals'
      && rep.body.report.sections.some((s) => s.name === 'By counter') && rep.body.report.sections.some((s) => s.name.startsWith(`Test Lunch ${N}`) && s.rows.length === 3));
    check('a role without the counts gets no report', (await call('GET', '/api/admin/reports/meals?format=json', null, desk)).status === 403);

    console.log('\n== Not being served now ==');
    const later = await call('POST', '/api/admin/programme/sessions', { hallId: hallA, date: '2099-01-01', start: '13:00', end: '14:00', title: `Future Lunch ${N}`, counts: false, meal: true }, admin);
    made.sessions.push(later.body.id);
    const fut = await call('POST', '/api/meals/serve', { mealKey: '2099-01-01 13:00', sessionId: later.body.id, identifier: okId }, admin);
    check('a meal not on now: the counter says when it is', fut.status === 409 && /1:00 PM to 2:00 PM/i.test(fut.body.error), fut.body);

    console.log('\n== The screens ==');
    const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'meals.ejs'), 'utf8');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('Settings › Conference › Meals, the counter volunteers\' landing page', /id="settings-item-meals" onclick="selectSettingsTab\('meals'\)"/.test(fs.readFileSync(appFile('views', 'admin', 'partials', 'header.ejs'), 'utf8'))
      && /: canSee\('meals'\) \? 'meals'/.test(js));
    check('the counter: meal, counter, scan, find by name; passes and report for the counts', ['id="meal-select"', 'id="meal-counter"', 'onclick="openMealScanner()"', 'id="meal-search"', 'href="/api/admin/meals/passes.pdf"'].every((x) => view.includes(x)));
    check('the answer fills the screen: green, amber, red', /bg-emerald-600 text-white[\s\S]*?Served anyway' : 'Serve'/.test(js) && /bg-amber-400 text-amber-950[\s\S]*?Already served/.test(js) && /bg-rose-700 text-white[\s\S]*?Not on the list/.test(js));
    check('a scan answers over the camera at once, the name big; "Serve" clears itself, no Done to press',
      view.includes('id="meal-scan-flash"') && /showMealFlash\(mealResultHtml\(d, true\), d\.result\)/.test(js) && /MEAL_FLASH_MS = \{ SERVE: \d+/.test(js)
        && !/NOT_ELIGIBLE: \d+/.test(js.slice(js.indexOf('MEAL_FLASH_MS'), js.indexOf('MEAL_FLASH_MS') + 120)));
    check('a phone needs no scrolling: meal and counter side by side, the search answer replaces its list, the camera clipped to the screen',
      /<div class="flex gap-2 sm:gap-3">\s*<div class="flex-1 min-w-0">\s*<label for="meal-select"/.test(view) && /hidden sm:block text-\[15px\] text-slate-600">Scan each badge/.test(view)
        && view.indexOf('id="meal-search"') < view.indexOf('id="meal-result"') && /if \(body\.personKey\) \{[\s\S]{0,200}?input\.value = ''/.test(js)
        && /min-h-0 overflow-hidden[^"]*bg-black/.test(view) && view.includes('h-[100dvh]'));
    check('a meal pass is read as it is, a badge as the desk reads it', /\/\^MP\[A-Z2-9\]\{10\}\$\/i\.test\(raw\) \? raw\.toUpperCase\(\) : deskIdentifierFromScan\(raw\)/.test(js));
  } finally {
    for (const id of made.sessions) {
      await db.run('DELETE FROM meal_servings WHERE session_id = ?', [id]);
      await db.run('DELETE FROM programme_sessions WHERE id = ?', [id]);
    }
    for (const id of made.halls) await db.run('DELETE FROM halls WHERE id = ?', [id]);
    for (const r of made.regs) {
      await db.run('DELETE FROM registrations WHERE id = ?', [r.id]);
      await db.run('DELETE FROM users WHERE phone_number = ?', [r.phone]);
    }
    for (const id of made.guests) {
      await db.run('DELETE FROM meal_passes WHERE person_key = ?', [`faculty-${id}`]);
      await db.run('DELETE FROM guests WHERE id = ?', [id]);
    }
  }
  db.close();
  report();
})();
