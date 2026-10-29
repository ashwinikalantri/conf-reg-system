// A session's speakers/facilitators and chairs/moderators, picked from the
// faculty list.
//
//   * The names: titles and case aside; "Dr A, Dr B and Team" read as two
//     people and "and Team"; a name is linked only when exactly one faculty
//     member has it; the line puts "and Team" after a space.
//   * Through the server: a session saved with its lists shows its lines to
//     delegates, made from the faculty list's names as they are now; someone
//     not on the faculty list is refused; a speaker added from the session
//     editor joins the faculty list (an account is offered instead; nobody
//     twice); the Faculty tab shows each person's sessions; a removed faculty
//     member's name stays in the programme as words; a session typed before
//     comes to the editor with a proposal.
//   * The editor: chips, search, keep as words, add to faculty.
const { call, check, report, ADMIN_PW, adminLogin, loginPassword, openDb, appFile } = require('./harness');
const P = require('../programme-people');
const fs = require('fs');
const vm = require('vm');

console.log('\n== The names ==');
check('titles, dots and case aside', P.normName('Prof Dr B. S. Garg') === 'b s garg' && P.normName('Maj Gen Atul Kotwal') === 'atul kotwal' && P.normName('Dr') === 'dr');
check('"Dr A, Dr B and Team": two people and "and Team"', JSON.stringify(P.splitLegacy('Dr A, Dr B and Team')) === JSON.stringify(['Dr A', 'Dr B', 'and Team']));
check('"NQoCN and MGIMS Team" stays whole', JSON.stringify(P.splitLegacy('NQoCN and MGIMS Team')) === JSON.stringify(['NQoCN and MGIMS Team']));
const fac = [{ id: 1, name: 'Dr Vikram Datta' }, { id: 2, name: 'Dr Amit Gupta' }, { id: 3, name: 'Prof Amit Gupta' }];
check('a name is linked when exactly one faculty member has it', JSON.stringify(P.matchFaculty(['Prof Vikram Datta', 'Dr Vikram'], fac))
  === JSON.stringify([{ guestId: 1 }, { text: 'Dr Vikram' }]));
check('...not when two have it', P.matchFaculty(['Amit Gupta'], fac)[0].text === 'Amit Gupta');
check('the line: commas, and "and Team" after a space', P.joinPeople(['Dr A', 'Dr B', 'and Team']) === 'Dr A, Dr B and Team' && P.joinPeople([]) === '');
check('a list: someone not on the faculty list is refused', /no longer on the faculty list/.test(P.cleanPeople([{ guestId: 99 }], new Set([1]), 'Speakers').error));
check('...the same person once; blank words dropped', JSON.stringify(P.cleanPeople([{ guestId: 1 }, { guestId: '1' }, { text: '  ' }, { text: ' and  Team ' }], new Set([1]), 'S').value)
  === JSON.stringify([{ guestId: 1 }, { text: 'and Team' }]));

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const N = String(Date.now() % 1000000);
  const madeGuests = [];
  const madeSessions = [];
  const account = `79${N.padStart(8, '0')}`;
  try {
    console.log('\n== Adding a speaker who is not yet faculty ==');
    const add = (body, c = admin) => call('POST', '/api/admin/programme/faculty', body, c);
    const a = await add({ guest: { name: `Dr Speaker ${N}`, designation: 'Professor', email: `spk${N}@example.test` } });
    check('they join the faculty list, not signed up', a.body.success === true && a.body.name === `Dr Speaker ${N}` && a.body.linked === false, a.body);
    madeGuests.push(a.body.id);
    check('...and the faculty list has them', !!(await db.get('SELECT id FROM guests WHERE id = ? AND guest_name = ?', [a.body.id, `Dr Speaker ${N}`])));
    check('nobody twice: the same email points to them', (await add({ guest: { name: 'Someone', email: `SPK${N}@example.test` } })).body.guestId === a.body.id);
    await call('POST', '/api/users', { phone: account, name: `Chair Person ${N}`, email: `chair${N}@example.test`, role: 'DELEGATE' }, admin);
    const hasAcc = await add({ guest: { name: 'Chair', email: `chair${N}@example.test` } });
    check('someone with an account: the account is offered', hasAcc.status === 409 && hasAcc.body.code === 'ACCOUNT_EXISTS' && hasAcc.body.account.phone_number === account);
    const marked = await add({ phone: account });
    check('...and marked as faculty', marked.body.success === true && marked.body.linked === true && marked.body.name === `Chair Person ${N}`, marked.body);
    madeGuests.push(marked.body.id);
    check('the front desk cannot add faculty from here', (await add({ guest: { name: 'X' } }, await loginPassword('9000000006', ADMIN_PW))).status === 403);

    console.log('\n== A session with its lists ==');
    const hall = { id: (await call('POST', '/api/admin/programme/halls', { name: `Panel Hall ${N}` }, admin)).body.id };
    const base = { hallId: hall.id, date: '2026-11-22', start: '15:00', end: '16:00', title: `QI panel ${N}`, counts: false };
    const bad = await call('POST', '/api/admin/programme/sessions', { ...base, people: { speakers: [{ guestId: 999999 }], chairs: [] } }, admin);
    check('someone not on the faculty list is refused', bad.status === 400 && /no longer on the faculty list/.test(bad.body.error));
    const s = await call('POST', '/api/admin/programme/sessions', { ...base,
      people: { speakers: [{ guestId: a.body.id }, { text: 'and Team' }], chairs: [{ guestId: marked.body.id }] } }, admin);
    check('saved', s.body.success === true, s.body);
    madeSessions.push(s.body.id);
    const rows = await db.all('SELECT role, position, guest_id, name FROM programme_session_faculty WHERE session_id = ? ORDER BY role, position', [s.body.id]);
    check('kept in order, faculty by id, words as words', JSON.stringify(rows) === JSON.stringify([
      { role: 'chair', position: 0, guest_id: marked.body.id, name: null },
      { role: 'speaker', position: 0, guest_id: a.body.id, name: null },
      { role: 'speaker', position: 1, guest_id: null, name: 'and Team' }]), rows);
    const pub = async () => (await call('GET', '/api/programme', null, admin)).body.sessions.find((x) => x.id === s.body.id);
    const seen = await pub();
    check('delegates see the lines', seen.speakers === `Dr Speaker ${N} and Team` && seen.chairs === `Chair Person ${N}`, seen);
    await call('PUT', `/api/guests/${a.body.id}`, { fields: { guest_name: `Prof Speaker ${N}` } }, admin);
    check('a name corrected on the faculty list is corrected in the programme', (await pub()).speakers === `Prof Speaker ${N} and Team`);
    const board = (await call('GET', '/api/guests', null, admin)).body;
    const sp = board.guests.find((g) => g.id === a.body.id);
    check('the Faculty tab shows their sessions', sp.sessions.length === 1 && sp.sessions[0].role === 'Speaker' && sp.sessions[0].title === `QI panel ${N}` && sp.sessions[0].start === '15:00');
    check('...as chair too', board.guests.find((g) => g.id === marked.body.id).sessions[0].role === 'Chair');
    const adminProg = (await call('GET', '/api/admin/programme', null, admin)).body;
    const ed = adminProg.sessions.find((x) => x.id === s.body.id);
    check('the editor gets the lists, with names', ed.people.speakers[0].guestId === a.body.id && ed.people.speakers[0].name === `Prof Speaker ${N}` && !ed.people.proposed);
    check('...and the faculty list to pick from', adminProg.faculty.some((f) => f.id === a.body.id && f.designation === 'Professor'));
    const log = await db.get("SELECT new_value FROM audit_log WHERE action = 'SESSION_ADDED' AND entity_id = ?", [String(s.body.id)]);
    check('the log names who speaks and chairs', log && /Speakers: Dr Speaker \d+ and Team · Chairs: Chair Person/.test(log.new_value), log);

    console.log('\n== A session typed before the lists ==');
    const old = await call('POST', '/api/admin/programme/sessions', { ...base, start: '16:00', end: '17:00', title: `Old ${N}`,
      speakers: `Dr Prof Speaker ${N}, Dr Not Faculty ${N} and Team`, chairs: '' }, admin);
    madeSessions.push(old.body.id);
    check('delegates see its words', (await call('GET', '/api/programme', null, admin)).body.sessions.find((x) => x.id === old.body.id).speakers === `Dr Prof Speaker ${N}, Dr Not Faculty ${N} and Team`);
    const prop = (await call('GET', '/api/admin/programme', null, admin)).body.sessions.find((x) => x.id === old.body.id).people;
    check('the editor gets a proposal: the faculty member linked, the rest as words', prop.proposed === true
      && prop.speakers[0].guestId === a.body.id && prop.speakers[1].text === `Dr Not Faculty ${N}` && prop.speakers[2].text === 'and Team', prop);

    console.log('\n== Removing a faculty member ==');
    await call('DELETE', `/api/guests/${a.body.id}`, null, admin);
    madeGuests.shift();
    check('their name stays in the programme, as words', (await pub()).speakers === `Prof Speaker ${N} and Team`);
    await call('DELETE', `/api/admin/programme/sessions/${s.body.id}`, null, admin);
    madeSessions.shift();
    check('deleting a session deletes its lists', !(await db.get('SELECT 1 FROM programme_session_faculty WHERE session_id = ?', [s.body.id])));
  } finally {
    for (const id of madeSessions) { await db.run('DELETE FROM programme_sessions WHERE id = ?', [id]); await db.run('DELETE FROM programme_session_faculty WHERE session_id = ?', [id]); }
    for (const id of madeGuests) await db.run('DELETE FROM guests WHERE id = ?', [id]);
    await db.run('DELETE FROM guests WHERE phone_number = ?', [account]);
    await db.run('DELETE FROM users WHERE phone_number = ?', [account]);
    await db.run("DELETE FROM halls WHERE name = ?", [`Panel Hall ${N}`]);
  }
  db.close();

  console.log('\n== The editor ==');
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  const ejs = fs.readFileSync(appFile('views', 'admin', 'sections', 'programme.ejs'), 'utf8');
  check('the two boxes are pickers now', /id="ps-people-speakers"/.test(ejs) && /id="ps-people-chairs"/.test(ejs) && !/id="ps-speakers"/.test(ejs));
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, { id, value: '', innerHTML: '', textContent: '', classList: { toggle() {}, add() {}, remove() {} }, focus() {} }); return els.get(id); };
  const sb = { document: { getElementById: el }, String, Number, Set, JSON, Object, Array };
  vm.createContext(sb);
  const grab = (n) => { const i = js.indexOf(`function ${n}(`); return js.slice(i, js.indexOf('\n}', i) + 2); };
  vm.runInContext([grab('esc'), js.match(/let psPeople = [^\n]+/)[0], js.match(/const PS_ROLE_LABELS = [^\n]+/)[0], js.match(/const PS_TITLES = [^\n]+/)[0],
    ...['psNormName', 'renderSessionPeople', 'findSessionPerson', 'addSessionPerson', 'addSessionText', 'removeSessionPerson', 'startNewFaculty', 'placeSessionFaculty'].map(grab),
    `var attState = { programme: { faculty: [{ id: 1, name: 'Dr Vikram Datta', designation: 'MS' }, { id: 2, name: 'Dr Amit Gupta', designation: '' }, { id: 3, name: 'Dr Gone', cancelled: true }] } };
     globalThis.st = () => psPeople;`].join('\n'), sb);
  vm.runInContext("psPeople = { speakers: [{ guestId: 1, name: 'Dr Vikram Datta' }, { text: 'Dr Nobody', name: 'Dr Nobody' }, { text: 'and Team', name: 'and Team' }], chairs: [] }; renderSessionPeople('speakers');", sb);
  const box = el('ps-people-speakers').innerHTML;
  check('faculty as navy chips, words as dashed ones', /bg-navy text-white[^>]*>Dr Vikram Datta</.test(box) && /border-dashed[^>]*title="Not on the faculty list">Dr Nobody/.test(box));
  check('...a person in words can be added to the faculty list; "and Team" cannot', /Dr Nobody <button type="button" onclick="startNewFaculty\('speakers', 1\)"/.test(box) && !/and Team <button type="button" onclick="startNewFaculty/.test(box));
  el('ps-find-speakers').value = 'amit';
  vm.runInContext("findSessionPerson('speakers')", sb);
  const found = el('ps-found-speakers').innerHTML;
  check('search finds faculty by name, titles aside', /addSessionPerson\('speakers', 2\)/.test(found) && !/addSessionPerson\('speakers', 1\)/.test(found));
  el('ps-find-speakers').value = 'gone';
  vm.runInContext("findSessionPerson('speakers')", sb);
  check('...not Cancelled faculty; and offers to add or keep as words', !/addSessionPerson\('speakers', 3\)/.test(el('ps-found-speakers').innerHTML)
    && /Add “gone” to the faculty list/.test(el('ps-found-speakers').innerHTML) && /Keep “gone” as words/.test(el('ps-found-speakers').innerHTML));
  vm.runInContext("addSessionPerson('speakers', 2); addSessionPerson('speakers', 2)", sb);
  check('adding: once, at the end', sb.st().speakers.map((p) => p.guestId || p.text).join() === '1,Dr Nobody,and Team,2');
  vm.runInContext("placeSessionFaculty('speakers', 1, 7, 'Dr Nobody Now')", sb);
  check('a person in words added to the faculty list takes their place', sb.st().speakers[1].guestId === 7 && sb.st().speakers[1].name === 'Dr Nobody Now');
  vm.runInContext("removeSessionPerson('speakers', 0)", sb);
  check('removing', sb.st().speakers[0].guestId === 7);
  check('saving sends the lists, faculty by id', /people: Object\.fromEntries\(\['speakers', 'chairs'\]\.map\(\(role\) => \[role,\s*psPeople\[role\]\.map\(\(p\) => \(p\.guestId != null \? \{ guestId: p\.guestId \} : \{ text: p\.text \}\)\)\]\)\)/.test(js));
  check('the Faculty tab: their sessions in the editor and a count on the list', /In the programme<\/p>/.test(js) && /session\$\{g\.sessions\.length === 1 \? '' : 's'\} in the programme/.test(js));
  report();
})();
