// Late abstract submission for named delegates.
//
// The last date closes submission for everyone. A Super Admin can let one
// named delegate submit after it, through a date chosen for them:
//
//   * the server is what lets them in -- POST /api/abstracts honours their
//     date, and nobody else's -- and an extension that has run out closes
//     them again like everybody else;
//   * the portal shows their own date, and says it is theirs;
//   * it is a Super Admin power only (abstracts.extend_deadline), refused to
//     every other role and to the delegate themselves;
//   * someone who has already submitted cannot be "extended" -- one abstract
//     per delegate -- and a date in the past is refused;
//   * granting, changing and withdrawing are in the activity log.
//
// The suite runs files one at a time against one server, so this file moves
// the shared deadline -- and puts it back in `finally`, pass or fail.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const IST = 5.5 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const istDay = (offset) => new Date(Date.now() + IST + offset * DAY).toISOString().slice(0, 10);
const N = String(Date.now() % 100000000).padStart(8, '0');
const phones = { late: `94${N}`, other: `93${N}`, lapsed: `92${N}`, done: `91${N}` };
const ABSTRACT = {
  format: 'Oral Paper', title: 'Extension fixture abstract',
  background: 'Some background.', aim: 'An aim.', methods: 'A method.', results: 'A result.',
  conclusion: 'A conclusion.', keywords: 'quality, safety',
};

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const settings = async () => (await call('GET', '/api/admin/general-settings', null, admin)).body.conference;
  const setDeadline = (d) => call('PUT', '/api/admin/general-settings', { conference: { abstractDeadline: d } }, admin);
  const original = (await settings()).abstractDeadline;
  const signIn = async (phone) => {
    const r = await call('POST', `/api/users/${phone}/reset-password`, {}, admin);
    return (await call('POST', '/api/auth/login-password', { identifier: phone, password: r.body.tempPassword })).cookie;
  };
  const allow = (phone, until, extra = {}, cookie = admin) =>
    call('PUT', `/api/abstracts/extensions/${phone}`, { until, ...extra }, cookie);
  const submit = (cookie, title) => call('POST', '/api/abstracts', { ...ABSTRACT, title }, cookie);

  try {
    const cookies = {};
    for (const [k, p] of Object.entries(phones)) {
      await call('POST', '/api/users', { phone: p, name: `Late ${k}`, email: `ext-${k}-${N}@example.test`, role: 'DELEGATE' }, admin);
      cookies[k] = await signIn(p);
    }
    // One of them submitted while it was still open.
    check('fixture: submitting works while the last date is ahead', (await submit(cookies.done, `Done ${N}`)).body.success === true);

    // Closed for everyone: the last date was yesterday.
    await setDeadline(istDay(-1));
    check('fixture: submission is now closed', (await settings()).abstractSubmissionOpen === false);

    console.log('\n== Allowing one delegate ==');
    const granted = await allow(phones.late, istDay(3), { notify: true });
    check('a Super Admin can allow a named delegate', granted.body.success === true, granted.body);
    check('...and is told no email went, email being off here', granted.body.emailed === false, granted.body);
    const row = await db.get('SELECT until, granted_by FROM abstract_extensions WHERE phone_number = ?', [phones.late]);
    check('their date is stored', row && row.until === istDay(3), row);
    check('...with who allowed it', row && !!row.granted_by, row);

    console.log('\n== The server lets them in, and nobody else ==');
    const mine = (await call('GET', '/api/abstracts/me', null, cookies.late)).body.submission;
    check('their window is open', mine.open === true, mine);
    check('...through their own date', mine.deadline === istDay(3), mine);
    check('...and it says the date is theirs', mine.extended === true, mine);
    const theirs = (await call('GET', '/api/abstracts/me', null, cookies.other)).body.submission;
    check('another delegate is still closed', theirs.open === false && theirs.extended === false && theirs.deadline === istDay(-1), theirs);
    const late = await submit(cookies.late, `Late ${N}`);
    check('the delegate allowed can submit', late.body.success === true, late.body);
    const refused = await submit(cookies.other, `Other ${N}`);
    check('the other is refused', refused.status === 403 && refused.body.code === 'ABSTRACT_SUBMISSION_CLOSED', [refused.status, refused.body]);

    console.log('\n== An extension that has run out closes them again ==');
    await db.run('INSERT INTO abstract_extensions (phone_number, until, granted_at, granted_by) VALUES (?, ?, ?, ?)',
      [phones.lapsed, istDay(-1), Date.now(), 'fixture']);
    // Equal to the last date -- no later than everyone else's, so not "extended".
    const lapsedWin = (await call('GET', '/api/abstracts/me', null, cookies.lapsed)).body.submission;
    check('closed', lapsedWin.open === false, lapsedWin);
    const lapsedTry = await submit(cookies.lapsed, `Lapsed ${N}`);
    check('...and refused', lapsedTry.status === 403, lapsedTry.status);
    await setDeadline(istDay(-3));
    const lapsedLater = (await call('GET', '/api/abstracts/me', null, cookies.lapsed)).body.submission;
    check('a lapsed date of their own is still the one they are told', lapsedLater.open === false && lapsedLater.deadline === istDay(-1) && lapsedLater.extended === true, lapsedLater);
    await setDeadline(istDay(-1));

    console.log('\n== What is refused ==');
    const past = await allow(phones.other, istDay(-1));
    check('a date that has gone', past.status === 400, [past.status, past.body.error]);
    const notDate = await allow(phones.other, 'soon');
    check('something that is not a date', notDate.status === 400, notDate.status);
    const already = await allow(phones.done, istDay(5));
    check('someone who has already submitted', already.status === 409 && /already submitted/.test(already.body.error), [already.status, already.body.error]);
    const nobody = await allow(`99${N}`, istDay(5));
    check('an account that does not exist', nobody.status === 404, nobody.status);
    const staff = await allow('9000000002', istDay(5));
    check('a staff account, which is not a delegate', staff.status === 404, staff.status);
    check('today itself is allowed', (await allow(phones.other, istDay(0))).body.success === true);

    console.log('\n== Super Admin only ==');
    const reviewer = await loginPassword('9000000003', ADMIN_PW);   // ACADEMIC_REVIEWER
    const finance = await loginPassword('9000000002', ADMIN_PW);    // FINANCE_ADMIN
    const desk = await loginPassword('9000000006', ADMIN_PW);       // FRONT_DESK
    for (const [who, c] of [['an academic reviewer', reviewer], ['finance', finance], ['the front desk', desk], ['the delegate themselves', cookies.other]]) {
      check(`${who} cannot allow one`, (await allow(phones.other, istDay(5), {}, c)).status === 403);
      check(`...nor list them`, (await call('GET', '/api/abstracts/extensions', null, c)).status === 403);
      check(`...nor search`, (await call('GET', '/api/abstracts/extensions/search?q=Late', null, c)).status === 403);
    }
    check('nor anyone signed out', (await call('GET', '/api/abstracts/extensions')).status === 401);
    const perms = require('../permissions');
    check('no built-in role but Super Admin holds the key',
      ['FINANCE_ADMIN', 'ACADEMIC_REVIEWER', 'FINANCE_ACADEMIC', 'FRONT_DESK', 'OPERATIONS'].every((r) => !perms.roleCan(r, 'abstracts.extend_deadline')));
    check('...which holds it', perms.roleCan('SUPER_ADMIN', 'abstracts.extend_deadline'));

    console.log('\n== The list and the search ==');
    const list = (await call('GET', '/api/abstracts/extensions', null, admin)).body;
    const entry = (p) => (list.extensions || []).find((e) => e.phone_number === p);
    check('the list has everyone allowed', !!entry(phones.late) && !!entry(phones.other) && !!entry(phones.lapsed));
    check('...shows who has since submitted', entry(phones.late).abstract_status === 'UNDER_REVIEW' && entry(phones.other).abstract_status === null);
    check('...and the general last date, for the heading', list.deadline === istDay(-1) && list.today === istDay(0), [list.deadline, list.today]);
    const found = (await call('GET', `/api/abstracts/extensions/search?q=Late`, null, admin)).body.results || [];
    const f = (p) => found.find((r) => r.phone_number === p);
    check('search finds delegates by name', !!f(phones.other));
    check('...says who has already submitted', Number(f(phones.done).has_abstract) === 1);
    check('...and who already has a date', f(phones.other).extended_until === istDay(0));
    check('...never staff', !found.some((r) => /^90000000/.test(r.phone_number)));
    check('a single character finds nothing', ((await call('GET', '/api/abstracts/extensions/search?q=L', null, admin)).body.results || []).length === 0);
    check('% is not a wildcard', ((await call('GET', '/api/abstracts/extensions/search?q=%25%25', null, admin)).body.results || []).length === 0);

    console.log('\n== Changing and withdrawing ==');
    check('allowing again changes the date', (await allow(phones.other, istDay(7))).body.success === true
      && (await db.get('SELECT until FROM abstract_extensions WHERE phone_number = ?', [phones.other])).until === istDay(7));
    const withdraw = await call('DELETE', `/api/abstracts/extensions/${phones.other}`, null, admin);
    check('it can be withdrawn', withdraw.body.success === true, withdraw.body);
    check('...and they are closed again', (await call('GET', '/api/abstracts/me', null, cookies.other)).body.submission.open === false);
    check('withdrawing twice says there is nothing to withdraw',
      (await call('DELETE', `/api/abstracts/extensions/${phones.other}`, null, admin)).status === 404);
    const log = await db.all(
      "SELECT action, old_value, new_value FROM audit_log WHERE entity_type = 'abstract_extension' AND entity_id = ? ORDER BY id", [phones.other]);
    check('each change is in the activity log',
      JSON.stringify(log.map((l) => [l.action, l.old_value, l.new_value])) === JSON.stringify([
        ['ABSTRACT_EXTENSION_GRANT', null, istDay(0)],
        ['ABSTRACT_EXTENSION_GRANT', istDay(0), istDay(7)],
        ['ABSTRACT_EXTENSION_REVOKE', istDay(7), null]]), log);

    console.log('\n== The email, when asked for ==');
    const src = fs.readFileSync(appFile('server.js'), 'utf8');
    const route = src.slice(src.indexOf("app.put('/api/abstracts/extensions/:phone'"), src.indexOf("app.delete('/api/abstracts/extensions/:phone'"));
    check('only sent when the admin ticks it, and there is an address', /const emailed = !!req\.body\.notify && emailEnabled\(\) && !!u\.email;/.test(route));
    check('...naming their own date', /Your last date for submission[\s\S]*formatDMY\(until\)/.test(route));
    check('...in the house palette', !/#4f46e5|#4338ca|#c7d2fe|#eef2ff/i.test(route));

    console.log('\n== The portal says the date is theirs ==');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    const grab = (n) => { const i = js.indexOf(`function ${n}(`); return js.slice(i, js.indexOf('\n}', i) + 2); };
    const els = {};
    const el = (id) => (els[id] = els[id] || { innerHTML: '', classList: { hidden: true, toggle(_, v) { this.hidden = v; } } });
    const sb = { document: { getElementById: el }, String, Number, Date };
    vm.createContext(sb);
    vm.runInContext([grab('esc'), grab('formatFullDate'), grab('formatFullDateWithDay'), grab('renderAbstractDeadlineNote')].join('\n')
      + '\nglobalThis.note = renderAbstractDeadlineNote;', sb);
    sb.note(null, { open: true, deadline: '2026-10-30', extended: true });
    check('an extended delegate is told it is theirs', /extended for you/.test(els['abstract-deadline-note'].innerHTML), els['abstract-deadline-note'].innerHTML);
    sb.note(null, { open: true, deadline: '2026-10-30', extended: false });
    check('everyone else sees the plain last date', /Last date for submission/.test(els['abstract-deadline-note'].innerHTML)
      && !/extended for you/.test(els['abstract-deadline-note'].innerHTML));

    console.log('\n== The admin panel ==');
    const ejs = fs.readFileSync(appFile('views', 'admin', 'sections', 'abstracts.ejs'), 'utf8');
    check('it is on the Abstracts tab', ejs.includes('id="abstracts-extension-block"') && ejs.includes('id="absext-table-body"'));
    check('...hidden for a role without the key', /extensionBlock\.classList\.toggle\('hidden', !can\('abstracts\.extend_deadline'\)\)/.test(js));
    check('...and asks before emailing, ticked by default', /<input type="checkbox" id="absext-notify" checked>/.test(ejs));
    check('Withdraw asks first', /async function withdrawAbstractExtension[\s\S]*?showConfirm\(/.test(js));
  } finally {
    await setDeadline(original);
    for (const p of Object.values(phones)) {
      await db.run('DELETE FROM abstract_extensions WHERE phone_number = ?', [p]);
      await db.run('DELETE FROM abstracts WHERE phone_number = ?', [p]);
      await db.run('DELETE FROM users WHERE phone_number = ?', [p]);
    }
  }
  check('the last date is put back', (await settings()).abstractDeadline === original);
  const left = await db.get('SELECT COUNT(*) AS n FROM abstract_extensions WHERE phone_number IN (?, ?, ?, ?)', Object.values(phones));
  check('nothing this file made is left in the fixture', left.n === 0, left.n);
  db.close();
  report();
})();
