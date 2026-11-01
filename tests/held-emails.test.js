// A staff action never emails by itself (1 Nov 2026): the email is held, the
// admin page asks Send or Cancel, and only Send sends it. What a delegate's
// own action sends, and sign-in codes, go at once.
const { call, check, report, ADMIN_PW, appFile, adminLogin, loginPassword, openDb } = require('./harness');
const fs = require('fs');

const N = String(Date.now() % 100000000).padStart(8, '0');

(async () => {
  const src = fs.readFileSync(appFile('server.js'), 'utf8');
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  const modal = fs.readFileSync(appFile('views', 'admin', 'modals', 'held-email.ejs'), 'utf8');

  console.log('\n== What is held ==');
  const held = src.match(/await holdEmail\(req, [^,]+, ('[^']+'|`[^`]+`)/g) || [];
  check('each staff action holds its email', held.length === 12, held.length);
  const routeOf = (at) => { const i = src.lastIndexOf('\napp.', at); return src.slice(i, src.indexOf('\n', i + 1)); };
  const left = [];
  for (const m of src.matchAll(/notifyDelegate\(/g)) {
    const route = routeOf(m.index);
    if (/requirePermission/.test(route)) left.push(route.slice(0, 70));
  }
  check('no route behind a staff permission still emails directly', left.length === 0, left);
  check('every holding route has the signed-in person in hand', (src.match(/async function holdEmail\(req, phone, subject, html\)/g) || []).length === 1 && /req\.res\.append\('X-Held-Emails'/.test(src));
  check('a sign-in code is not held', !/holdEmail\([^)]*verification code/.test(src) && /sendEmail\(dest, `Your/.test(src));

  const db = await openDb();
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const me = (await call('GET', '/api/auth/me', null, admin)).body.user;
  const ids = [];
  const hold = async (phone, subject) => {
    const r = await db.run("INSERT INTO held_emails (to_address, to_name, subject, html, by_phone, status, created_at) VALUES (?, ?, ?, '<p>Hello</p>', ?, 'PENDING', ?)", [`held${N}@example.org`, 'A Delegate', subject, phone, Date.now()]);
    ids.push(r.lastID);
    return r.lastID;
  };
  const status = async (id) => (await db.get('SELECT status FROM held_emails WHERE id = ?', [id])).status;
  const decide = (who, list, send) => call('POST', '/api/admin/held-emails/decide', { ids: list, send }, who);

  try {
    console.log('\n== Send or Cancel ==');
    const mine = await hold(me.phone_number, `Cancel me ${N}`);
    const list = await call('GET', '/api/admin/held-emails', null, admin);
    check('the one who acted sees it, with what it says', list.body.emails.some((e) => e.id === mine && e.html === '<p>Hello</p>' && e.to_address === `held${N}@example.org`));
    check('nobody else sees it', !(await call('GET', '/api/admin/held-emails', null, desk)).body.emails.some((e) => e.id === mine));
    const stranger = await decide(desk, [mine], true);
    check('nor can anyone else send it', stranger.body.sent === 0 && stranger.body.failed === 0 && (await status(mine)) === 'PENDING', stranger.body);
    check('signed out, nothing', (await call('GET', '/api/admin/held-emails')).status === 401 && (await decide(undefined, [mine], true)).status === 401);
    const cancel = await decide(admin, [mine], false);
    check('Cancel drops it and sends nothing', cancel.body.cancelled === 1 && cancel.body.sent === 0 && (await status(mine)) === 'CANCELLED', cancel.body);
    check('...and it is logged', !!(await db.get("SELECT id FROM audit_log WHERE action = 'EMAIL_CANCELLED' AND new_value = ?", [`Cancel me ${N}`])));
    check('...and cannot be sent afterwards', (await decide(admin, [mine], true)).body.sent === 0 && (await status(mine)) === 'CANCELLED');
    check('...and is gone from the list', !(await call('GET', '/api/admin/held-emails', null, admin)).body.emails.some((e) => e.id === mine));
    if (!process.env.HELD_EMAILS_E2E) {
      const send = await hold(me.phone_number, `Send me ${N}`);
      const sent = await decide(admin, [send], true);
      check('Send with email switched off here says it failed, not sent', sent.body.failed === 1 && sent.body.sent === 0 && (await status(send)) === 'FAILED', sent.body);
    }
    check('only the word true sends', /const send = req\.body\.send === true;/.test(src));
    check('no ids, no decision', (await decide(admin, [], true)).status === 400);

    console.log('\n== The popup ==');
    check('Send and Cancel, nothing that closes it otherwise', /onclick="decideHeldEmails\(true\)"/.test(modal) && /onclick="decideHeldEmails\(false\)"/.test(modal) && !/closeModal/.test(modal));
    check('above every other modal', /z-\[70\]/.test(modal));
    check('says what Cancel means', /Cancel drops the email only/.test(modal));
    check('any reply that held one brings it up; a visit brings back one unanswered', /res\.headers\.get\('X-Held-Emails'\)\) showHeldEmails\(\);/.test(js) && /activeAdminUser = me\.user;\n  showHeldEmails\(\);/.test(js));
    check('the email shows sealed off from the page', /<iframe sandbox="" title="The email" srcdoc="\$\{esc\(m\.html\)\}"/.test(js));
    check('the admin page has it', /admin\/modals\/held-email/.test(fs.readFileSync(appFile('views', 'admin.ejs'), 'utf8')));
    check('the toasts no longer say someone was emailed before Send', !/They have been emailed/.test(js) && !/Saved\.\$\{told/.test(js));

    if (process.env.HELD_EMAILS_E2E) {
      console.log('\n== An action, end to end (fake mail credentials) ==');
      await call('PUT', '/api/admin/general-settings', { notify: { sms: false, email: true, digest: false } }, admin);
      const reg = await db.get("SELECT r.id, r.phone_number FROM registrations r JOIN users u ON u.phone_number = r.phone_number WHERE r.bank_status = 'PENDING' AND COALESCE(u.email, '') != '' LIMIT 1");
      const r = await call('PUT', `/api/registrations/${reg.id}/status`, { bankStatus: 'REJECTED', rejectionReason: 'WRONG_DETAILS' }, admin);
      const h = r.headers && (r.headers.get ? r.headers.get('x-held-emails') : r.headers['x-held-emails']);
      check('the action answers with the held email', r.status === 200 && !!h, [r.status, h, r.body]);
      const row = await db.get('SELECT * FROM held_emails WHERE id = ?', [Number(h)]);
      check('...waiting, not sent', row && row.status === 'PENDING' && !(await db.get("SELECT id FROM audit_log WHERE action = 'EMAIL_SENT' AND new_value = ? AND created_at >= ?", [row.subject, row.created_at])));
      ids.push(Number(h));
      check('...and Cancel leaves the action done', (await decide(admin, [Number(h)], false)).body.cancelled === 1 && (await db.get('SELECT bank_status s FROM registrations WHERE id = ?', [reg.id])).s === 'REJECTED');
    }
  } finally {
    for (const id of ids) await db.run('DELETE FROM held_emails WHERE id = ?', [id]);
    await db.run("DELETE FROM audit_log WHERE action = 'EMAIL_CANCELLED' AND new_value LIKE ?", [`%${N}`]);
  }
  report();
})();
