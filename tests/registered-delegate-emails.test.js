// Announcements to delegates who HAVE registered.
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

const LIST = '/api/admin/reminders/registered';
const SEND = '/api/admin/reminders/registered/send';

(async () => {
  const admin = await adminLogin();
  const db = openDb({ readOnly: true });

  console.log('\n== The audience is the registered, and all of them ==');
  const res = await call('GET', LIST, null, admin);
  check('the list responds', res.status === 200, res.status);
  const rows = res.body.users || [];
  const inDb = await db.all('SELECT phone_number, bank_status FROM registrations');
  check('fixture: there are registrations to address', inDb.length > 3, inDb.length);
  check('every registration is in it', rows.length === inDb.length, [rows.length, inDb.length]);
  const statuses = [...new Set(rows.map((r) => r.bank_status))];
  check('...whatever their payment status', statuses.length > 1, statuses);
  check('...including ones still awaiting verification',
    rows.some((r) => r.bank_status !== 'BANK_VERIFIED'), statuses);

  // The other card's audience is the complement of this one: signed up, never
  // registered. Nobody should be in both.
  const signups = ((await call('GET', '/api/admin/reminders/pending-signups', null, admin)).body.users || [])
    .map((u) => u.phone_number);
  const overlap = rows.map((r) => r.phone_number).filter((p) => signups.includes(p));
  check('nobody is in this audience and the prospects one', overlap.length === 0, overlap.slice(0, 3));

  console.log('\n== Each recipient carries what the email needs ==');
  const withEmail = rows.find((r) => r.email);
  check('a recipient has a name to greet', !!withEmail && !!withEmail.delegate_name, withEmail && withEmail.delegate_name);
  // The salutation is folded into the name server-side (withDelegateSalutation)
  // and the separate column dropped, so "Dr Priya Sharma" arrives as one
  // field -- the greeting must not come out as a bare first name.
  const titled = await db.all(
    `SELECT u.salutation, r.delegate_name FROM registrations r JOIN users u ON u.phone_number = r.phone_number
      WHERE COALESCE(u.salutation, '') != ''`);
  check('fixture: somebody has a salutation on file', titled.length > 0, titled.length);
  const byName = new Map(rows.map((r) => [r.delegate_name, r]));
  check('...and it arrives as part of the name, not a field of its own',
    titled.every((t) => [...byName.keys()].some((n) => n.startsWith(`${t.salutation} `))),
    titled.slice(0, 2));
  check('no stray salutation column is left for the client to re-add',
    rows.every((r) => !('delegate_salutation' in r)));
  check('...and an address to send to', !!withEmail && /@/.test(withEmail.email));
  check('the list says when each was last written to, so the card can grey them out',
    rows.every((r) => 'last_reminder_sent_at' in r));

  console.log('\n== Only the roles that could already email delegates ==');
  const desk = await loginPassword('9000000006', ADMIN_PW);       // FRONT_DESK
  check('the front desk cannot read the audience', (await call('GET', LIST, null, desk)).status === 403);
  check('...nor send to it', (await call('POST', SEND, { subject: 's', bodyHtml: 'b', phones: ['9000000001'] }, desk)).status === 403);
  const reviewer = await loginPassword('9000000003', ADMIN_PW);   // ACADEMIC_REVIEWER
  check('nor an academic reviewer', (await call('GET', LIST, null, reviewer)).status === 403);
  check('nor an anonymous caller', (await call('GET', LIST)).status === 401);

  console.log('\n== A send is refused unless it is complete ==');
  const noSubject = await call('POST', SEND, { bodyHtml: 'b', phones: ['9000000001'] }, admin);
  check('no subject, no send', noSubject.status === 400 && /Subject/.test(noSubject.body.error), noSubject.body.error);
  const noBody = await call('POST', SEND, { subject: 's', phones: ['9000000001'] }, admin);
  check('no body, no send', noBody.status === 400 && /body/i.test(noBody.body.error), noBody.body.error);
  const noOne = await call('POST', SEND, { subject: 's', bodyHtml: 'b', phones: [] }, admin);
  check('nobody selected, no send', noOne.status === 400, [noOne.status, noOne.body.error]);
  // Email is off in the fixture, which is what a misconfigured server looks
  // like: it must say so rather than silently reporting success.
  const noEmail = await call('POST', SEND, { subject: 's', bodyHtml: 'b', phones: [rows[0].phone_number] }, admin);
  check('with email switched off it says so, rather than claiming to have sent',
    noEmail.status === 400 && /Email is not configured/.test(noEmail.body.error), [noEmail.status, noEmail.body.error]);
  const sentAnyway = await db.get(
    "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'REGISTERED_DELEGATE_REMINDER_SENT'");
  check('...and nothing was recorded as sent', sentAnyway.n === 0, sentAnyway.n);

  console.log('\n== The 24-hour guard is this announcement\'s own ==');
  // Lifted from the route so the test cannot drift from what runs.
  const src = fs.readFileSync(appFile('server.js'), 'utf8');
  const at = src.indexOf("action = 'REGISTERED_DELEGATE_REMINDER_SENT' AND created_at >= ?");
  check('the send route looks for its own action, not another card\'s', at > 0);
  const window24 = src.slice(src.lastIndexOf('const since =', at), at);
  check('...over a rolling 24 hours', /24 \* 60 \* 60 \* 1000/.test(window24), window24.slice(0, 80));
  check('it records one audit row per recipient, which is what makes that queryable',
    /entityType: 'reminder_email', entityId: u\.phone_number,\s*\n\s*action: 'REGISTERED_DELEGATE_REMINDER_SENT'/.test(src));
  // The guards run in the same order as the sibling card's route, so an admin
  // who knows one gets the same message from the other.
  const routeAt = src.indexOf("app.post('/api/admin/reminders/registered/send'");
  const route = src.slice(routeAt, src.indexOf('\n});', routeAt));
  const order = ['Subject is required.', 'Email body is required.', 'Email is not configured on this server.', 'Select at least one delegate to send to.']
    .map((m) => route.indexOf(m));
  check('it refuses an empty subject, an empty body, an unconfigured server and an empty selection',
    order.every((i) => i > 0), order);
  check('...in that order, as the other bulk send does',
    order.every((v, i) => i === 0 || v > order[i - 1]), order);
  check('a delegate with no address on file is skipped, not failed',
    /if \(!u\.email\) \{ skippedNoEmail\+\+; continue; \}/.test(src));
  check('{{name}} is replaced per recipient, and escaped',
    /split\('\{\{name\}\}'\)\.join\(escapeHtml\(name\)\)/.test(src));
  check('one email per person, even if they somehow have two registrations',
    /seen\.has\(r\.phone_number\)/.test(src));

  console.log('\n== The test send goes to the admin alone ==');
  const test = await call('POST', '/api/admin/reminders/test-send', { subject: 'Check', bodyHtml: 'Hello {{name}}' }, admin);
  check('it is refused too while email is off, rather than pretending',
    test.status === 400 && /Email is not configured/.test(test.body.error), [test.status, test.body.error]);

  db.close();
  report();
})();
