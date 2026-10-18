// Invite-only programme groups (e.g. a workshop by invitation).
//
//   * Not offered on the registration form; a delegate who sends its option
//     anyway is refused.
//   * The organisers enrol invitees from the option's roster, and a
//     delegate's own choices, saved again, leave that enrolment alone.
//   * It still earns a workshop certificate, like any workshop.
//   * It cannot also be required.
const { call, check, report, appFile, adminLogin, openDb } = require('./harness');
const fs = require('fs');

const N = String(Date.now()).slice(-7);

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  let groupId = null;
  let regId = null;
  try {
    const g = await call('POST', '/api/admin/program-groups', { name: `Invited Workshops ${N}`, required: false, maxSelect: 1 }, admin);
    groupId = g.body.id || (await db.get('SELECT id FROM program_groups WHERE name = ?', [`Invited Workshops ${N}`])).id;
    const opt = await call('POST', '/api/admin/program-options', { groupId, name: `By Invitation ${N}`, capacity: 30, fee: 0 }, admin);
    const optionId = opt.body.id;
    check('fixture: a group and its option', !!groupId && !!optionId, [g.body, opt.body]);
    check('an invite-only group cannot be required', (await call('PUT', `/api/admin/program-groups/${groupId}`, { inviteOnly: true, required: true }, admin)).status === 400);
    const set = await call('PUT', `/api/admin/program-groups/${groupId}`, { inviteOnly: true }, admin);
    check('a group is made invite-only', set.body.success === true && Number((await db.get('SELECT invite_only FROM program_groups WHERE id = ?', [groupId])).invite_only) === 1);
    const listed = (await call('GET', '/api/admin/program-groups', null, admin)).body.groups.find((x) => x.id === groupId);
    check('...and, named a workshop, it takes attendance like one', listed.takes_attendance === 1 && Number(listed.invite_only) === 1);

    console.log('\n== Delegates ==');
    const email = `invite-${N}@example.test`;
    const otp = await call('POST', '/api/otp/request', { destination: email });
    const signed = await call('POST', '/api/auth/register', { salutation: 'Dr', age: '40', gender: 'Female', designation: 'Professor', institute: 'Test College', pincode: '442102', state: 'Maharashtra', district: 'Wardha', name: `Invitee ${N}`, country: 'United Kingdom', email, emailOtp: otp.body.devOtp, password: 'testpass123' });
    const delegate = signed.cookie;
    const phone = signed.body.user.phone_number;
    const offered = (await call('GET', '/api/program-options', null, delegate)).body.groups;
    check('the registration form does not offer it', !offered.some((x) => x.id === groupId) && offered.length > 0);
    const cat = await db.get('SELECT category_key FROM fee_categories WHERE active = 1 LIMIT 1');
    const sneaky = await call('POST', '/api/registrations', { categoryKey: cat.category_key, optionIds: [optionId], acknowledged: true, paymentMode: 'UPI' }, delegate);
    check('choosing it anyway is refused', sneaky.body.success === false && /by invitation only/.test(sneaky.body.error), sneaky.body);

    console.log('\n== The organisers enrol invitees ==');
    regId = (await db.run("INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status) VALUES (?, ?, ?, 'X', 'BANK_VERIFIED')", [phone, `Invitee ${N}`, cat.category_key])).lastID;
    const other = await db.get("SELECT o.id, o.group_id FROM program_options o JOIN program_groups g ON g.id = o.group_id WHERE g.name = 'Workshops' AND o.active = 1 LIMIT 1");
    await db.run('INSERT INTO registration_options (registration_id, group_id, option_id, is_faculty) VALUES (?, ?, ?, 0)', [regId, other.group_id, other.id]);
    const enrol = await call('POST', `/api/admin/program-options/${optionId}/enroll`, { identifier: email }, admin);
    const rows = await db.all('SELECT option_id FROM registration_options WHERE registration_id = ?', [regId]);
    check('an invitee is enrolled from the roster', enrol.body.success === true && rows.some((r) => r.option_id === optionId));
    check('...keeping the workshop they chose themselves (a group of its own)', rows.some((r) => r.option_id === other.id));
    const src = fs.readFileSync(appFile('server.js'), 'utf8');
    check('a delegate\'s choices saved again leave an invitation alone',
      /DELETE FROM registration_options WHERE registration_id = \? AND group_id NOT IN \(SELECT id FROM program_groups WHERE invite_only = 1\)/.test(src));
    const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
    check('Programs has the invite-only switch', /class="group-invite" data-id=/.test(js));
  } finally {
    if (regId) {
      await db.run('DELETE FROM registration_options WHERE registration_id = ?', [regId]);
      await db.run('DELETE FROM registrations WHERE id = ?', [regId]);
    }
    if (groupId) {
      await db.run('DELETE FROM program_options WHERE group_id = ?', [groupId]);
      await db.run('DELETE FROM program_groups WHERE id = ?', [groupId]);
    }
  }
  db.close();
  report();
})();
