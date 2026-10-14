// An abstract can only be presented by a registered delegate.
//
//   * approving the abstract of an author who has not registered is
//     provisional -- pending registration -- and becomes a full approval by
//     itself once they register (worked out each time, never stored);
//   * "registered" means a registration that has not been rejected, whatever
//     its payment status;
//   * step one (approval) sends nothing; the delegate hears once, when step
//     two allots oral or poster -- and for an author who has not registered,
//     that email says the acceptance is provisional and registration is
//     mandatory for presentation;
//   * a reminder card reaches authors who submitted but have not registered,
//     each with their own abstract's title, under the same keys, guards and
//     cooldown as the other bulk sends.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const vm = require('vm');

const N = String(Date.now() % 100000000).padStart(8, '0');
const phones = { unreg: `95${N}`, reg: `96${N}`, rejectedReg: `97${N}`, rejectedAbs: `98${N}` };
const LIST = '/api/admin/reminders/abstract-unregistered';
const SEND = `${LIST}/send`;
const TEST = `${LIST}/test-send`;

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const cat = await db.get('SELECT category_key, label FROM fee_categories WHERE active = 1 ORDER BY sort_order, id LIMIT 1');
  const ids = {};

  const signIn = async (phone) => {
    const r = await call('POST', `/api/users/${phone}/reset-password`, {}, admin);
    return (await call('POST', '/api/auth/login-password', { identifier: phone, password: r.body.tempPassword })).cookie;
  };
  const register = (phone, status) => db.run(
    `INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status)
     VALUES (?, ?, ?, ?, ?)`, [phone, `Author ${phone.slice(0, 2)}`, cat.category_key, cat.label, status]);
  const abstractsById = async () => {
    const rows = (await call('GET', '/api/abstracts', null, admin)).body.abstracts || [];
    return Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, rows.find((a) => a.id === id)]));
  };

  try {
    for (const [key, phone] of Object.entries(phones)) {
      await call('POST', '/api/users', { phone, name: `Author ${key}`, email: `pa-${key}-${N}@example.test`, role: 'DELEGATE' }, admin);
      const r = await db.run(
        `INSERT INTO abstracts (phone_number, author_name, format, title, text, word_count, status)
         VALUES (?, ?, 'Paper', ?, 'Body.', 120, ?)`,
        [phone, `Author ${key}`, `Provisional fixture ${key} ${N}`, key === 'rejectedAbs' ? 'REJECTED' : 'UNDER_REVIEW']);
      ids[key] = r.lastID;
    }
    await register(phones.reg, 'PENDING');            // registered, payment not yet verified
    await register(phones.rejectedReg, 'REJECTED');   // a rejected registration is not one

    console.log('\n== Whether the author has registered ==');
    let rows = await abstractsById();
    check('fixture: the review desk lists all four', Object.values(rows).every(Boolean));
    check('no registration: not registered', Number(rows.unreg.author_registered) === 0, rows.unreg.author_registered);
    check('a registration still awaiting payment counts', Number(rows.reg.author_registered) === 1, rows.reg.author_registered);
    check('a rejected registration does not', Number(rows.rejectedReg.author_registered) === 0, rows.rejectedReg.author_registered);

    console.log('\n== Step one: approving an unregistered author is provisional ==');
    const approve = (id) => call('PUT', `/api/abstracts/${id}/status`, { status: 'ACCEPTED' }, admin);
    const a1 = await approve(ids.unreg);
    check('it is approved', a1.body.success === true, a1.body);
    check('...and the reviewer is told it is provisional', a1.body.provisional === true, a1.body);
    const a2 = await approve(ids.reg);
    check('a registered author\'s approval is not provisional', a2.body.success === true && a2.body.provisional === false, a2.body);
    const a3 = await approve(ids.rejectedReg);
    check('nor is one whose registration was rejected treated as registered', a3.body.provisional === true, a3.body);
    const stored = await db.get('SELECT status FROM abstracts WHERE id = ?', [ids.unreg]);
    check('it is stored as an ordinary approval -- provisional is worked out, not saved', stored.status === 'ACCEPTED', stored);
    const reject = await call('PUT', `/api/abstracts/${ids.rejectedAbs}/status`, { status: 'REJECTED' }, admin);
    check('other decisions say nothing about it', reject.body.success === true && reject.body.provisional === false, reject.body);

    console.log('\n== Step one sends no email; step two does ==');
    const src = fs.readFileSync(appFile('server.js'), 'utf8');
    const routeOf = (head) => { const i = src.indexOf(head); return src.slice(i, src.indexOf('\n});', i)); };
    const statusRoute = routeOf("app.put('/api/abstracts/:id/status'");
    // Every email this step can send sits under the one decision that needs it.
    const guards = statusRoute.split('notifyDelegate(').slice(0, -1)
      .map((before) => (before.match(/if \(status === '([A-Z_]+)'[^\n]*\)\s*\{\s*$/) || [])[1]);
    check('approval sends nothing: the only emails are for rejection and corrections',
      JSON.stringify(guards) === '["REJECTED","REVISION_REQUESTED"]', guards);
    check('...and nothing else in the route sends mail', !/sendEmail\(/.test(statusRoute));
    const allocRoute = routeOf("app.put('/api/abstracts/:id/allocation'");
    check('allotment checks registration when it emails', /const provisional = !\(await authorHasRegistered\(a\.phone_number\)\)/.test(allocRoute));
    const provisionalMail = allocRoute.slice(allocRoute.indexOf('if (provisional)'), allocRoute.indexOf('} else {', allocRoute.indexOf('if (provisional)')));
    check('...and for an unregistered author, says the acceptance is provisional',
      /provisionally accepted/.test(provisionalMail), provisionalMail.slice(0, 120));
    check('...and that registration is mandatory for presentation', /Registration is mandatory for presentation/.test(provisionalMail));
    check('...in the house palette', !/#4f46e5|#4338ca|#c7d2fe|#eef2ff/i.test(provisionalMail));

    const allot = await call('PUT', `/api/abstracts/${ids.unreg}/allocation`, { allocation: 'POSTER' }, admin);
    check('allotting a provisional abstract is allowed', allot.body.success === true, allot.body);
    check('...and reports it was provisional', allot.body.provisional === true, allot.body);
    const allotReg = await call('PUT', `/api/abstracts/${ids.reg}/allocation`, { allocation: 'ORAL' }, admin);
    check('a registered author\'s allotment is not', allotReg.body.provisional === false, allotReg.body);

    console.log('\n== The portal tells the author ==');
    const unregCookie = await signIn(phones.unreg);
    const mine = (await call('GET', '/api/abstracts/me', null, unregCookie)).body;
    check('their own view says they have not registered', mine.registered === false, mine.registered);
    const regMine = (await call('GET', '/api/abstracts/me', null, await signIn(phones.reg))).body;
    check('a registered author\'s says they have', regMine.registered === true, regMine.registered);

    console.log('\n== The reminder audience: submitted, not registered ==');
    const res = await call('GET', LIST, null, admin);
    check('the list responds', res.status === 200, res.status);
    const users = res.body.users || [];
    const inList = (p) => users.some((u) => u.phone_number === p);
    check('the unregistered author is on it', inList(phones.unreg));
    check('...and so is one whose registration was rejected', inList(phones.rejectedReg));
    check('a registered author is not', !inList(phones.reg));
    check('nor an author whose abstract was not accepted', !inList(phones.rejectedAbs));
    check('nobody on it has registered', (await Promise.all(users.map((u) => db.get(
      "SELECT COUNT(*) AS n FROM registrations WHERE phone_number = ? AND COALESCE(bank_status, '') != 'REJECTED'", [u.phone_number]))))
      .every((r) => r.n === 0));
    check('one row per person', new Set(users.map((u) => u.phone_number)).size === users.length);
    const me = users.find((u) => u.phone_number === phones.unreg);
    check('each row carries the abstract title, for {{title}}', me && me.title === `Provisional fixture unreg ${N}`, me && me.title);
    check('...a name and an address', me && me.name && /@/.test(me.email || ''), me);
    check('...where it stands, for the card', me && me.status === 'ACCEPTED' && me.allocation === 'POSTER', me);
    check('...and when they were last written to', users.every((u) => 'last_reminder_sent_at' in u));

    console.log('\n== Only the roles that could already email delegates ==');
    const desk = await loginPassword('9000000006', ADMIN_PW);       // FRONT_DESK
    check('the front desk cannot read the audience', (await call('GET', LIST, null, desk)).status === 403);
    check('...nor send to it', (await call('POST', SEND, { subject: 's', bodyHtml: 'b', phones: [phones.unreg] }, desk)).status === 403);
    check('...nor send a test', (await call('POST', TEST, { subject: 's', bodyHtml: 'b' }, desk)).status === 403);
    const reviewer = await loginPassword('9000000003', ADMIN_PW);   // ACADEMIC_REVIEWER
    check('nor an academic reviewer', (await call('GET', LIST, null, reviewer)).status === 403);
    check('nor an anonymous caller', (await call('GET', LIST)).status === 401);

    console.log('\n== A send is refused unless it is complete ==');
    const noSubject = await call('POST', SEND, { bodyHtml: 'b', phones: [phones.unreg] }, admin);
    check('no subject, no send', noSubject.status === 400 && /Subject/.test(noSubject.body.error), noSubject.body.error);
    const noBody = await call('POST', SEND, { subject: 's', phones: [phones.unreg] }, admin);
    check('no body, no send', noBody.status === 400 && /body/i.test(noBody.body.error), noBody.body.error);
    const noEmail = await call('POST', SEND, { subject: 's', bodyHtml: 'b', phones: [phones.unreg] }, admin);
    check('with email switched off it says so, rather than claiming to have sent',
      noEmail.status === 400 && /Email is not configured/.test(noEmail.body.error), [noEmail.status, noEmail.body.error]);
    const test = await call('POST', TEST, { subject: 's', bodyHtml: 'b' }, admin);
    check('the test send too', test.status === 400 && /Email is not configured/.test(test.body.error), test.body.error);
    const sendRoute = routeOf(`app.post('${SEND}'`);
    const order = ['Subject is required.', 'Email body is required.', 'Email is not configured on this server.', 'Select at least one delegate to send to.']
      .map((m) => sendRoute.indexOf(m));
    check('the same guards as the other bulk sends, in the same order', order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), order);
    check('its own 24-hour cooldown and one audit row per recipient',
      /action = 'ABSTRACT_UNREGISTERED_REMINDER_SENT'/.test(src)
      && /entityType: 'reminder_email', entityId: u\.phone_number,\s*\n\s*action: 'ABSTRACT_UNREGISTERED_REMINDER_SENT'/.test(sendRoute)
      && /last_reminder_sent_at >= since/.test(sendRoute));
    check('the list is worked out afresh at send time', /await abstractAuthorsNotRegistered\(\)\)\.filter/.test(sendRoute));
    check('{{name}} and {{title}} are both filled in, escaped',
      /split\('\{\{name\}\}'\)\.join\(escapeHtml\(/.test(src) && /split\('\{\{title\}\}'\)\.join\(escapeHtml\(/.test(src));
    const sentAnyway = await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ABSTRACT_UNREGISTERED_REMINDER_SENT'");
    check('nothing was recorded as sent', sentAnyway.n === 0, sentAnyway.n);

    console.log('\n== Registering makes it a full approval, by itself ==');
    await register(phones.unreg, 'PENDING');
    rows = await abstractsById();
    check('the desk now sees the author as registered', Number(rows.unreg.author_registered) === 1);
    check('...and they are off the reminder list',
      !((await call('GET', LIST, null, admin)).body.users || []).some((u) => u.phone_number === phones.unreg));
    check('...and the portal no longer says otherwise', (await call('GET', '/api/abstracts/me', null, unregCookie)).body.registered === true);

    console.log('\n== The review desk shows it ==');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    const grab = (n) => { const i = js.indexOf(`function ${n}(`); return js.slice(i, js.indexOf('\n}', i) + 2); };
    const constant = (n) => { const i = js.indexOf(`const ${n} = {`); return js.slice(i, js.indexOf('\n};', i) + 3); };
    const sb = { Number, String, Date };
    vm.createContext(sb);
    vm.runInContext([constant('ABSTRACT_STATUS_STYLES'), grab('esc'), grab('fmtAuditTime'), grab('abstractProvisional'), grab('abstractCardHeader')].join('\n')
      + '\nglobalThis.header = abstractCardHeader;', sb);
    const base = { id: 1, title: 'T', author_name: 'A', format: 'Paper' };
    const prov = sb.header({ ...base, status: 'ACCEPTED', author_registered: 0 });
    check('an approval pending registration is labelled provisional', />ACCEPTED · PROVISIONAL</.test(prov));
    check('...and says why', /Pending registration — the author has not registered/.test(prov));
    const full = sb.header({ ...base, status: 'ACCEPTED', author_registered: 1 });
    check('a registered author\'s is a plain approval', />ACCEPTED</.test(full) && !/PROVISIONAL|Pending registration/.test(full));
    const before = sb.header({ ...base, status: 'UNDER_REVIEW', author_registered: 0 });
    check('before deciding, the reviewer is told approval would be provisional', /approval will be provisional/.test(before));
    check('...but not about a registered author', !/provisional/i.test(sb.header({ ...base, status: 'UNDER_REVIEW', author_registered: 1 })));
    check('...nor about one already rejected', !/provisional/i.test(sb.header({ ...base, status: 'REJECTED', author_registered: 0 })));

    console.log('\n== The reminder template ==');
    const tsb = { conferenceInfo: { name: 'Fixture Conference', acronym: 'FIXCON', location: 'Sevagram', startDate: '2026-11-20', endDate: '2026-11-22' },
      window: { location: { origin: 'https://portal.example' } }, Number, String };
    vm.createContext(tsb);
    vm.runInContext([grab('esc'), grab('formatFullDate'), grab('buildAbstractRegistrationMandatoryBody')].join('\n')
      + '\nglobalThis.body = buildAbstractRegistrationMandatoryBody();', tsb);
    const body = tsb.body;
    check('it greets each author and names their abstract', /\{\{name\}\}/.test(body) && /\{\{title\}\}/.test(body));
    check('it says registration is mandatory for presentation', /Registration is mandatory for presentation/.test(body));
    check('...and that approval stays provisional until they register', /provisional &mdash; pending registration/.test(body));
    check('...with a way to register', /href="https:\/\/portal\.example"[^>]*>Register Now</.test(body));
    check('in the house palette, not the old indigo', !/#4f46e5|#4338ca|#c7d2fe|#eef2ff/i.test(body));
    check('the template is registered and offered on its card',
      /'abstract-registration-mandatory': \{/.test(js)
      && /abstractUnregistered: \{ picker: 'absunreg-template', subject: 'absunreg-subject', body: 'absunreg-body' \}/.test(js)
      && fs.readFileSync(appFile('views', 'admin', 'sections', 'reminders.ejs'), 'utf8').includes('<option value="abstract-registration-mandatory">'));
    check('the card loads with the Reminders tab', /renderRegisteredDelegateEmails\(\);\n\s*renderAbstractUnregisteredEmails\(\);/.test(js));
  } finally {
    // Leave the shared fixture as it was found.
    for (const p of Object.values(phones)) {
      await db.run('DELETE FROM abstracts WHERE phone_number = ?', [p]);
      await db.run('DELETE FROM registrations WHERE phone_number = ?', [p]);
      await db.run('DELETE FROM users WHERE phone_number = ?', [p]);
    }
  }
  const left = await db.get(`SELECT COUNT(*) AS n FROM abstracts WHERE phone_number IN (?, ?, ?, ?)`, Object.values(phones));
  check('nothing this file made is left in the fixture', left.n === 0, left.n);

  db.close();
  report();
})();
