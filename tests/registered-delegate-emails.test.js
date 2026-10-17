// Announcements to delegates who HAVE registered (the "Registered
// delegates" audience in the Reminders composer).
//
// The reminders tab could reach two audiences: people who signed up and never
// registered, and registrations with a balance due. Neither is the audience
// for "the abstract deadline has moved", which concerns delegates themselves
// -- so that announcement had nowhere to go. This is that audience.
//
// What it must get right, each a way it could be built wrongly:
//   * it is the registered, and only the registered -- a prospect who never
//     registered belongs to the other card, and appearing in both would mean
//     two emails about different things;
//   * every payment status counts: a delegate whose payment is still pending
//     has registered and needs the news as much as a confirmed one;
//   * it is guarded by the same keys as the other bulk sends, so it hands
//     nobody a way to email delegates they did not already have;
//   * it repeats the 24-hour guard, under its own name, so this announcement
//     is not suppressed by a different one sent yesterday.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');

const LIST = '/api/admin/reminders/audiences/registered/recipients';
const SEND = '/api/admin/reminders/audiences/registered/send';

(async () => {
  const admin = await adminLogin();
  const db = openDb({ readOnly: true });

  console.log('\n== The audience is the registered, and all of them ==');
  const res = await call('GET', LIST, null, admin);
  check('the list responds', res.status === 200, res.status);
  const rows = res.body.recipients || [];
  const inDb = await db.all('SELECT DISTINCT phone_number, bank_status FROM registrations');
  check('fixture: there are registrations to address', inDb.length > 3, inDb.length);
  check('every registered person is in it', rows.length === new Set(inDb.map((r) => r.phone_number)).size, [rows.length, inDb.length]);
  const statuses = [...new Set(rows.flatMap((r) => r.tags))];
  check('...whatever their payment status', statuses.length > 1, statuses);
  check('...including ones still awaiting verification', statuses.some((t) => t !== 'Verified'), statuses);

  // The prospects audience is the complement of this one: signed up, never
  // registered. Nobody should be in both.
  const signups = ((await call('GET', '/api/admin/reminders/audiences/signups/recipients', null, admin)).body.recipients || []).map((u) => u.id);
  const overlap = rows.map((r) => r.id).filter((p) => signups.includes(p));
  check('nobody is in this audience and the prospects one', overlap.length === 0, overlap.slice(0, 3));

  console.log('\n== Narrowed by category and by status ==');
  const someone = await db.get('SELECT category_key, bank_status FROM registrations WHERE category_key IS NOT NULL LIMIT 1');
  const byCat = (await call('GET', `${LIST}?category=${encodeURIComponent(someone.category_key)}`, null, admin)).body.recipients || [];
  const catCount = await db.get('SELECT COUNT(DISTINCT phone_number) AS n FROM registrations WHERE category_key = ?', [someone.category_key]);
  check('a category gives just that category', byCat.length === catCount.n && byCat.length < rows.length, [byCat.length, catCount.n]);
  const pending = (await call('GET', `${LIST}?status=PENDING`, null, admin)).body.recipients || [];
  check('a status gives just that status', pending.length > 0 && pending.every((r) => r.tags.includes('Pending')), pending.map((r) => r.tags));
  const both = (await call('GET', `${LIST}?category=${encodeURIComponent(someone.category_key)}&status=${someone.bank_status}`, null, admin)).body.recipients || [];
  check('...and both together, both', both.length >= 1 && both.length <= byCat.length);
  const opts = (await call('GET', '/api/admin/reminders/audiences', null, admin)).body.options;
  check('the composer is told every category and status to offer', opts.categories.length > 0 && opts.statuses.some((s) => s.value === 'PARTIAL_PAYMENT'));

  console.log('\n== Each recipient carries what the email needs ==');
  const withEmail = rows.find((r) => r.email);
  check('a recipient has a name to greet', !!withEmail && !!withEmail.name, withEmail && withEmail.name);
  // The salutation is folded into the name server-side (withDelegateSalutation),
  // so "Dr Priya Sharma" arrives as one field.
  const titled = await db.all(
    `SELECT u.salutation, r.delegate_name FROM registrations r JOIN users u ON u.phone_number = r.phone_number
      WHERE COALESCE(u.salutation, '') != ''`);
  check('fixture: somebody has a salutation on file', titled.length > 0, titled.length);
  check('...and it arrives as part of the name', titled.every((t) => rows.some((r) => (r.name || '').startsWith(`${t.salutation} `))), titled.slice(0, 2));
  check('...and an address to send to', !!withEmail && /@/.test(withEmail.email));
  check('the list says when each was last written to, so the composer can grey them out', rows.every((r) => 'last_reminder_sent_at' in r));
  check('...and nothing private to the email (values) is sent to the page', rows.every((r) => !('values' in r)));
  const preview = (await call('POST', '/api/admin/reminders/audiences/registered/preview', { subject: 'Hi {{name}}', bodyHtml: '<p>Dear {{name}},</p>', recipientId: withEmail.id }, admin)).body;
  check('{{name}} is filled in, in the subject and the body', preview.subject === `Hi ${withEmail.name}` && preview.html.includes(`Dear ${withEmail.name},`), preview.subject);

  console.log('\n== Only the roles that could already email delegates ==');
  const desk = await loginPassword('9000000006', ADMIN_PW);       // FRONT_DESK
  check('the front desk cannot read the audience', (await call('GET', LIST, null, desk)).status === 403);
  check('...nor send to it', (await call('POST', SEND, { subject: 's', bodyHtml: 'b', ids: ['9000000001'] }, desk)).status === 403);
  const reviewer = await loginPassword('9000000003', ADMIN_PW);   // ACADEMIC_REVIEWER
  check('nor an academic reviewer', (await call('GET', LIST, null, reviewer)).status === 403);
  check('nor an anonymous caller', (await call('GET', LIST)).status === 401);

  console.log('\n== A send is refused unless it is complete ==');
  const noSubject = await call('POST', SEND, { bodyHtml: 'b', ids: ['9000000001'] }, admin);
  check('no subject, no send', noSubject.status === 400 && /Subject/.test(noSubject.body.error), noSubject.body.error);
  const noBody = await call('POST', SEND, { subject: 's', ids: ['9000000001'] }, admin);
  check('no body, no send', noBody.status === 400 && /body/i.test(noBody.body.error), noBody.body.error);
  const literal = await call('POST', SEND, { subject: 's', bodyHtml: 'Your balance: {{amount}}', ids: ['9000000001'] }, admin);
  check('a placeholder this audience cannot fill is refused -- it would arrive as typed', literal.status === 400 && /\{\{amount\}\}/.test(literal.body.error), literal.body.error);
  // Email is off in the fixture, which is what a misconfigured server looks
  // like: it must say so rather than silently reporting success.
  const noEmail = await call('POST', SEND, { subject: 's', bodyHtml: 'b', ids: [rows[0].id] }, admin);
  check('with email switched off it says so, rather than claiming to have sent',
    noEmail.status === 400 && /Email is not configured/.test(noEmail.body.error), [noEmail.status, noEmail.body.error]);
  const sentAnyway = await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'REGISTERED_DELEGATE_REMINDER_SENT'");
  check('...and nothing was recorded as sent', sentAnyway.n === 0, sentAnyway.n);

  console.log('\n== The 24-hour guard is this audience\'s own ==');
  const src = fs.readFileSync(appFile('server.js'), 'utf8');
  check('it keeps the action name it always had, so "last reminded" carries on',
    require('../reminders').AUDIENCE_BY_KEY.registered.action === 'REGISTERED_DELEGATE_REMINDER_SENT');
  check('"last reminded" reads that audience\'s own action',
    /WHERE entity_type = 'reminder_email' AND action = \? GROUP BY entity_id`, \[audience\.action\]/.test(src));
  check('...over a rolling 24 hours', /const REMINDER_COOLDOWN_MS = 24 \* 60 \* 60 \* 1000;/.test(src)
    && /const since = Date\.now\(\) - REMINDER_COOLDOWN_MS;/.test(src));
  check('a delegate with no address on file is skipped, not failed', /if \(!m\.email\) \{ outcomes\.push\(\{ \.\.\.m, outcome: 'no_email' \}\); continue; \}/.test(src));
  check('one email per person, even if they somehow have two registrations', /if \(seen\.has\(r\.phone_number\)\) continue;/.test(src));

  console.log('\n== The test send goes to the admin alone ==');
  const test = await call('POST', '/api/admin/reminders/audiences/registered/test', { subject: 'Check', bodyHtml: 'Hello {{name}}' }, admin);
  check('it is refused too while email is off, rather than pretending',
    test.status === 400 && /Email is not configured/.test(test.body.error), [test.status, test.body.error]);

  db.close();
  report();
})();
