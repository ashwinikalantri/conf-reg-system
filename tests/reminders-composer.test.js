// The Reminders composer: one place to email any audience.
//
//   * Placeholders: each audience fills only what it knows; an email using
//     one it cannot fill is refused (it would arrive as "{{name}}"), and one
//     leaving out a required one ({{codes}}) too.
//   * Four new audiences, each exactly who it says: faculty not registered
//     (with or without an account), accounts at an email domain not
//     registered, accounts with an unverified email not registered, and the
//     registered narrowed by category and status (in its own test).
//   * The preview is the email as one recipient will get it.
//   * Pasted addresses keep their own permission and fill nothing in.
//   * Sent: every send, including those from before the history existed.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');
const R = require('../reminders');

const N = String(Date.now()).slice(-7);
const DOMAIN = `rem${N}.test`;
const base = { salutation: 'Dr', age: '41', gender: 'Female', designation: 'Professor',
  institute: 'Test College', pincode: '442102', state: 'Maharashtra', district: 'Wardha' };

(async () => {
  console.log('\n== Placeholders ==');
  check('found once each, in order', JSON.stringify(R.placeholdersIn('Hi {{name}} {{ title }} {{name}}')) === '["name","title"]');
  check('filled with what is given; anything else left alone', R.fillPlaceholders('{{name}}: {{x}}', { name: 'Dr A' }) === 'Dr A: {{x}}');
  check('an audience refuses one it cannot fill', /\{\{name\}\} cannot be filled in for "Pasted addresses"/.test(R.placeholderError('paste', 'Hi', 'Dear {{name}}') || ''));
  check('...in the subject too', !!R.placeholderError('signups', 'Your {{amount}}', 'x'));
  check('a required one left out is refused', /Keep \{\{codes\}\}/.test(R.placeholderError('codes', 'S', 'Dear {{name}}') || ''));
  check('a complete email passes', R.placeholderError('codes', 'S', 'Dear {{name}}, {{codes}}') === null && R.placeholderError('balance', 'S', '{{name}} owes {{amount}}') === null);
  check('a domain is read however typed', R.normaliseDomain(' @MGIMS.ac.in ') === 'mgims.ac.in' && R.normaliseDomain('mgims') === null && R.normaliseDomain('a b.com') === null);
  check('every audience keeps a distinct audit action', new Set(R.AUDIENCES.map((a) => a.action)).size === R.AUDIENCES.length);
  check('the old cards\' actions are kept, so "last reminded" carries on',
    ['REGISTRATION_REMINDER_SENT', 'BALANCE_DUE_REMINDER_SENT', 'REGISTERED_DELEGATE_REMINDER_SENT', 'ABSTRACT_UNREGISTERED_REMINDER_SENT', 'CODE_HOLDER_REMINDER_SENT', 'CUSTOM_REMINDER_SENT']
      .every((act) => R.AUDIENCE_BY_ACTION[act]));

  console.log('\n== Older sends, grouped back together ==');
  const t0 = 1_700_000_000_000;
  const rows = [
    { id: 1, action: 'REGISTRATION_REMINDER_SENT', entity_id: 'p1', new_value: 'Hello', actor_phone: 'a', actor_name: 'Admin', created_at: t0 },
    { id: 2, action: 'REGISTRATION_REMINDER_SENT', entity_id: 'p2', new_value: 'Hello', actor_phone: 'a', actor_name: 'Admin', created_at: t0 + 5000 },
    { id: 3, action: 'BALANCE_DUE_REMINDER_SENT', entity_id: 'p3', new_value: 'Pay (₹1,500 due)', actor_phone: 'a', actor_name: 'Admin', created_at: t0 + 6000 },
    { id: 4, action: 'BALANCE_DUE_REMINDER_SENT', entity_id: 'p4', new_value: 'Pay (₹200 due)', actor_phone: 'a', actor_name: 'Admin', created_at: t0 + 7000 },
    { id: 5, action: 'REGISTRATION_REMINDER_SENT', entity_id: 'p1', new_value: 'Hello', actor_phone: 'a', actor_name: 'Admin', created_at: t0 + 2 * 3600e3 },
  ];
  const groups = R.groupLegacySends(rows);
  check('one send per action, person and subject, close together', groups.length === 3 && groups[0].count === 2 && groups[0].audience === 'signups', groups.map((g) => g.count));
  check('...the per-person balance is not part of the subject', groups[1].subject === 'Pay' && groups[1].count === 2);
  check('...and a later repeat is a send of its own', groups[2].count === 1 && groups[2].id === 'legacy-5');

  const admin = await adminLogin();
  const db = openDb();
  const signUp = async (email, name) => {
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const r = await call('POST', '/api/auth/register', { ...base, name, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    return r.body.user && r.body.user.phone_number;
  };
  const cat = await db.get('SELECT category_key, label FROM fee_categories WHERE active = 1 LIMIT 1');
  const register = (phone, status = 'PENDING') => db.run(
    "INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status) VALUES (?, 'Fixture', ?, ?, ?)",
    [phone, cat.category_key, cat.label, status]);
  const people = {
    domIn: await signUp(`in-${N}@${DOMAIN}`, `Dom In ${N}`),
    domReg: await signUp(`reg-${N}@${DOMAIN}`, `Dom Reg ${N}`),
    domRej: await signUp(`rej-${N}@${DOMAIN}`, `Dom Rej ${N}`),
    other: await signUp(`out-${N}@example.test`, `Dom Out ${N}`),
  };
  check('fixture: four delegates', Object.values(people).every(Boolean));
  const phones = Object.values(people);
  const guestIds = [];
  let sendId = null;
  try {
    await register(people.domReg);
    await register(people.domRej, 'REJECTED');
    await db.run('UPDATE users SET email_verified = 0 WHERE phone_number IN (?, ?)', [people.domIn, people.other]);
    const ins = async (phone, name, email, status = null) => {
      const r = await db.run('INSERT INTO guests (phone_number, guest_name, guest_email, overall_status, created_at) VALUES (?, ?, ?, ?, ?)', [phone, name, email, status, Date.now()]);
      guestIds.push(r.lastID);
      return r.lastID;
    };
    await ins(people.other, `Faculty Linked ${N}`, null);
    await ins(people.domReg, `Faculty Registered ${N}`, null);
    await ins(null, `Faculty Unlinked ${N}`, `unlinked-${N}@example.test`);
    await ins(null, `Faculty Cancelled ${N}`, `cancelled-${N}@example.test`, 'Cancelled');

    console.log('\n== Every audience, counted ==');
    const aud = (await call('GET', '/api/admin/reminders/audiences', null, admin)).body;
    check('all eleven, in four groups', aud.audiences.length === 11 && new Set(aud.audiences.map((a) => a.group)).size === 4, aud.audiences.map((a) => a.key));
    const count = (k, list = aud) => list.audiences.find((a) => a.key === k).count;
    check('pasted addresses have no count, nor a domain until one is given', count('paste') === null && count('domain') === null);
    const withDomain = (await call('GET', `/api/admin/reminders/audiences?domain=@${DOMAIN.toUpperCase()}`, null, admin)).body;
    check('...given one, its count', count('domain', withDomain) === 2, count('domain', withDomain));
    check('each says what it fills in', aud.audiences.find((a) => a.key === 'balance').placeholders.includes('amount') && aud.placeholders.codes);

    const list = async (k, q = '') => (await call('GET', `/api/admin/reminders/audiences/${k}/recipients${q}`, null, admin)).body.recipients || [];

    console.log('\n== By email domain ==');
    const dom = await list('domain', `?domain=${DOMAIN}`);
    const domIds = dom.map((r) => r.id);
    check('an account at the domain, not registered: in', domIds.includes(people.domIn));
    check('...one whose registration was rejected: in too', domIds.includes(people.domRej));
    check('one registered: out', !domIds.includes(people.domReg));
    check('one at another domain: out', !domIds.includes(people.other));
    check('unverified addresses are marked -- a domain code waits on verification', dom.find((r) => r.id === people.domIn).tags.includes('Email not verified'));
    check('no domain, nobody', (await list('domain')).length === 0 && (await list('domain', '?domain=nonsense')).length === 0);

    console.log('\n== Email not verified ==');
    const unv = (await list('unverified')).map((r) => r.id);
    check('unverified and not registered: in', unv.includes(people.domIn) && unv.includes(people.other));
    check('verified: out', !unv.includes(people.domRej));
    check('nobody in it has verified', (await Promise.all(unv.map((p) => db.get('SELECT email_verified FROM users WHERE phone_number = ?', [p])))).every((u) => !u.email_verified));

    console.log('\n== Faculty, not registered ==');
    const fac = await list('faculty');
    const facBy = (name) => fac.find((r) => r.name && r.name.includes(name));
    check('with an account, not registered: in, at their account\'s address', !!facBy(`Dom Out ${N}`) && facBy(`Dom Out ${N}`).email === `out-${N}@example.test`, fac.map((r) => r.name));
    check('registered: out', !fac.some((r) => r.id === people.domReg));
    check('not signed up: in, at the address on their faculty record', !!facBy(`Faculty Unlinked ${N}`) && facBy(`Faculty Unlinked ${N}`).tags.includes('Not signed up'));
    check('cancelled: out', !facBy(`Faculty Cancelled ${N}`));

    console.log('\n== The preview ==');
    const pv = (k, body) => call('POST', `/api/admin/reminders/audiences/${k}/preview`, body, admin).then((r) => r.body);
    const p1 = await pv('faculty', { subject: 'For {{name}}', bodyHtml: '<p>Dear {{name}},</p>', recipientId: `unlinked-${N}@example.test` });
    check('it is the chosen recipient\'s email, filled in', p1.recipient && p1.recipient.name === `Faculty Unlinked ${N}` && p1.html.includes(`Dear Faculty Unlinked ${N},`) && p1.subject === `For Faculty Unlinked ${N}`, p1.recipient);
    check('...inside the email\'s own chrome (the steel header band)', p1.html.includes('background:#1c3549') && p1.html.indexOf('background:#1c3549') < p1.html.indexOf('Dear Faculty Unlinked'));
    const p2 = await pv('domain', { subject: 'S', bodyHtml: '<p>{{name}}</p>', filters: { domain: 'nobody.example' } });
    check('nobody in the audience: an example, said to be one', p2.recipient === null && p2.html.includes('Dr Example Delegate'));
    const p3 = await pv('paste', { subject: 'S', bodyHtml: '<p>Dear {{name}}</p>' });
    check('it reports a placeholder the audience cannot fill', JSON.stringify(p3.problems.unsupported) === '["name"]');
    check('an unknown audience is not found', (await call('GET', '/api/admin/reminders/audiences/everyone/recipients', null, admin)).status === 404);

    console.log('\n== Pasted addresses ==');
    check('have no list', (await call('GET', '/api/admin/reminders/audiences/paste/recipients', null, admin)).status === 400);
    const viaAudience = await call('POST', '/api/admin/reminders/audiences/paste/send', { subject: 'S', bodyHtml: 'b', ids: ['a@b.test'] }, admin);
    check('cannot be sent to under the audience permission', viaAudience.status === 400);
    const named = await call('POST', '/api/admin/reminders/paste/send', { subject: 'S', bodyHtml: 'Dear {{name}}', ids: ['a@b.test'] }, admin);
    check('an email greeting them by {{name}} is refused', named.status === 400 && /\{\{name\}\}/.test(named.body.error), named.body);
    const empty = await call('POST', '/api/admin/reminders/paste/send', { subject: 'S', bodyHtml: 'b', ids: [] }, admin);
    check('no addresses, no send', empty.status === 400);

    console.log('\n== Who may do what ==');
    const desk = await loginPassword('9000000006', ADMIN_PW);
    check('the front desk cannot list an audience', (await call('GET', '/api/admin/reminders/audiences', null, desk)).status === 403);
    check('...nor preview, nor read the history', (await call('POST', '/api/admin/reminders/audiences/signups/preview', { subject: 's', bodyHtml: 'b' }, desk)).status === 403
      && (await call('GET', '/api/admin/reminders/history', null, desk)).status === 403);
    check('...nor send to pasted addresses', (await call('POST', '/api/admin/reminders/paste/send', { subject: 's', bodyHtml: 'b', ids: ['a@b.test'] }, desk)).status === 403);

    console.log('\n== Sent ==');
    const r = await db.run(`INSERT INTO reminder_sends (audience, filters, subject, body_html, requested, sent, skipped, sent_by_phone, sent_by_name, created_at)
      VALUES ('domain', ?, ?, '<p>Dear {{name}}</p>', 3, 1, ?, '9000000001', 'Fixture Admin', ?)`,
      [JSON.stringify({ domain: DOMAIN }), `Composer send ${N}`, JSON.stringify({ cooldown: 1, noEmail: 1 }), Date.now()]);
    sendId = r.lastID;
    for (const [id, outcome] of [[people.domIn, 'sent'], [people.domRej, 'cooldown'], ['999', 'no_longer_due']]) {
      await db.run('INSERT INTO reminder_send_recipients (send_id, recipient_id, name, email, outcome) VALUES (?, ?, ?, ?, ?)', [sendId, id, null, null, outcome]);
    }
    const hist = (await call('GET', '/api/admin/reminders/history', null, admin)).body.sends || [];
    const mine = hist.find((s) => s.id === sendId);
    check('a send is listed, with its audience, filter, counts and sender', mine && mine.audienceLabel === 'By email domain' && mine.filters.domain === DOMAIN
      && mine.sent === 1 && mine.skipped.cooldown === 1 && mine.sentBy === 'Fixture Admin', mine);
    const one = (await call('GET', `/api/admin/reminders/history/${sendId}`, null, admin)).body.send;
    check('...and opens to the email as written, and each person with what happened', one.body === '<p>Dear {{name}}</p>' && one.recipients.length === 3
      && one.recipients.map((x) => x.outcome).join() === 'sent,cooldown,no_longer_due');
    check('a send that is not there is not found', (await call('GET', '/api/admin/reminders/history/999999', null, admin)).status === 404);

    console.log('\n== The page ==');
    const view = fs.readFileSync(appFile('views', 'admin', 'sections', 'reminders.ejs'), 'utf8');
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('one composer: who, what, send to', ['id="rem-audiences"', 'id="rem-template"', 'id="rem-subject"', 'id="rem-body"', 'id="rem-recipients"', 'id="rem-send-btn"'].every((x) => view.includes(x)));
    check('the six old cards are gone', !/reminders-list|bdreminders-list|regdelegates-list|absunreg-list|codeholders-list|customreminder-emails/.test(view));
    check('the preview cannot run script or reach the page', /<iframe id="rem-preview" sandbox=""/.test(view) && /<iframe id="rem-send-preview" sandbox=""/.test(view));
    check('Compose and Sent', view.includes("switchReminderView('compose')") && view.includes("switchReminderView('sent')"));
    check('the preview is drawn by the server, after typing stops', /function scheduleReminderPreview\(delay = 450\)/.test(js) && /\/preview`, \{/.test(js));
    check('only people who can be written to can be chosen', /const reminderSelectable = \(r\) => !!r\.email && !reminderOnCooldown\(r\);/.test(js));
    check('the tab loads the composer', /if \(tab === 'reminders'\) renderReminders\(\);/.test(js));
  } finally {
    for (const id of guestIds) await db.run('DELETE FROM guests WHERE id = ?', [id]);
    for (const p of phones) await db.run('DELETE FROM registrations WHERE phone_number = ?', [p]);
    // Other tests expect every account to have a verified channel.
    await db.run(`UPDATE users SET email_verified = 1 WHERE phone_number IN (${phones.map(() => '?').join(',')})`, phones);
    if (sendId) {
      await db.run('DELETE FROM reminder_send_recipients WHERE send_id = ?', [sendId]);
      await db.run('DELETE FROM reminder_sends WHERE id = ?', [sendId]);
    }
  }
  db.close();
  report();
})();
