// A delegate whose registration is confirmed cannot be in a group.
//
// The group discount is worked out at the moment a payment is submitted and
// nothing applies it afterwards, so once a registration is confirmed and paid
// the fee is settled. Letting such a delegate into a group could only
// mislead -- or, worse, cost them: if the group later dropped below its
// minimum, revokeGroupDiscountIfBelowThreshold() would look at the members
// and could leave someone owing a difference for a discount they never had.
//
// The rule used to be narrower: a confirmed registration blocked joining only
// when it was under a DIFFERENT category. This file pins the wider rule, on
// both ways into a group, and pins that it is confirmation that matters --
// a registration still awaiting verification is fine.
const { call, check, report, ADMIN_PW, adminLogin, openDb } = require('./harness');

const N = String(Date.now() % 100000000).padStart(8, '0');
const phones = { leader: `93${N}`, confirmed: `92${N}`, pending: `91${N}`, starter: `90${N}` };

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const cat = await db.get('SELECT category_key, label FROM fee_categories WHERE active = 1 ORDER BY sort_order, id LIMIT 1');

  // An account that can sign in: created, given a one-time password, then
  // choosing its own -- the same path the desk uses.
  const makeDelegate = async (phone, name) => {
    await call('POST', '/api/users', { phone, name, email: `gc-${phone}@example.test`, role: 'DELEGATE' }, admin);
    const reset = await call('POST', `/api/users/${phone}/reset-password`, {}, admin);
    const login = await call('POST', '/api/auth/login-password', { identifier: phone, password: reset.body.tempPassword });
    await call('POST', '/api/auth/set-password', { password: `own-${N}` }, login.cookie);
    return login.cookie;
  };
  // Its own registration row, at whatever status the check under test needs.
  const giveRegistration = (phone, name, status) => db.run(
    `INSERT INTO registrations (phone_number, delegate_name, category_key, category_label, bank_status)
     VALUES (?, ?, ?, ?, ?)`, [phone, name, cat.category_key, cat.label, status]);

  let ruleId = null;
  try {
    await call('POST', '/api/admin/group-rules',
      { categoryKey: cat.category_key, minSize: 5, discountType: 'FLAT', discountValue: 500 }, admin);
    ruleId = ((await call('GET', '/api/admin/group-rules', null, admin)).body.rules || [])
      .find((r) => r.category_key === cat.category_key).id;
    check('fixture: a category with a group discount', !!ruleId, ruleId);

    const leader = await makeDelegate(phones.leader, 'Group Leader');
    const started = await call('POST', '/api/groups', { categoryKey: cat.category_key, name: 'Confirmed-rule fixture' }, leader);
    check('fixture: a leader with a group', started.body.success === true, started.body.error);
    const groupId = started.body.groupId;

    console.log('\n== A confirmed, paid delegate cannot be added to a group ==');
    await makeDelegate(phones.confirmed, 'Already Paid');
    await giveRegistration(phones.confirmed, 'Already Paid', 'BANK_VERIFIED');
    const refused = await call('POST', `/api/groups/${groupId}/members`, { identifier: phones.confirmed }, leader);
    check('the leader is refused', refused.status === 400, [refused.status, refused.body.error]);
    check('...and told why, in terms of their payment, not their category',
      refused.body.error === 'That delegate has already paid and had their registration confirmed, so they cannot join a group.',
      refused.body.error);
    const joined = await db.get('SELECT COUNT(*) AS n FROM group_members WHERE phone_number = ?', [phones.confirmed]);
    check('...and they are not in the group', joined.n === 0, joined.n);

    console.log('\n== ...even though their category matches the group ==');
    // This is what changed: matching the group's category used to be enough.
    const sameCategory = await db.get('SELECT category_key FROM registrations WHERE phone_number = ?', [phones.confirmed]);
    check('fixture: their registration is under the group\'s own category',
      sameCategory.category_key === cat.category_key, sameCategory);
    check('the refusal stands regardless', refused.status === 400);

    console.log('\n== A registration still awaiting verification is fine ==');
    await makeDelegate(phones.pending, 'Not Yet Verified');
    await giveRegistration(phones.pending, 'Not Yet Verified', 'PENDING');
    const allowed = await call('POST', `/api/groups/${groupId}/members`, { identifier: phones.pending }, leader);
    check('they can be added', allowed.status === 200 && allowed.body.success, [allowed.status, allowed.body.error]);
    const isIn = await db.get('SELECT COUNT(*) AS n FROM group_members WHERE phone_number = ?', [phones.pending]);
    check('...and they really are in the group', isIn.n === 1, isIn.n);

    console.log('\n== Nor can a confirmed delegate start a group of their own ==');
    const starter = await makeDelegate(phones.starter, 'Paid And Confirmed');
    await giveRegistration(phones.starter, 'Paid And Confirmed', 'BANK_VERIFIED');
    const blocked = await call('POST', '/api/groups', { categoryKey: cat.category_key }, starter);
    check('starting one is refused', blocked.status === 400, [blocked.status, blocked.body.error]);
    check('...with the same reasoning, in the first person',
      blocked.body.error === 'Your registration is already confirmed and paid, so it cannot be part of a group.',
      blocked.body.error);
    const madeGroup = await db.get('SELECT COUNT(*) AS n FROM delegate_groups WHERE leader_phone = ?', [phones.starter]);
    check('...and no group was created', madeGroup.n === 0, madeGroup.n);

    // The same person, before their payment is verified, can start one -- so
    // the rule is about confirmation, not about having registered.
    await db.run("UPDATE registrations SET bank_status = 'PARTIAL_PAYMENT' WHERE phone_number = ?", [phones.starter]);
    const nowAllowed = await call('POST', '/api/groups', { categoryKey: cat.category_key }, starter);
    check('with a balance still due, they can start one', nowAllowed.body.success === true, nowAllowed.body.error);

    console.log('\n== ...and the portal is told, so it can hide the offer ==');
    // The panel asks /api/groups/me; without this it would offer a category
    // and then be refused on the click.
    const confirmedView = (await call('GET', '/api/groups/me', null, await (async () => {
      const r = await call('POST', `/api/users/${phones.confirmed}/reset-password`, {}, admin);
      const l = await call('POST', '/api/auth/login-password', { identifier: phones.confirmed, password: r.body.tempPassword });
      return l.cookie;
    })())).body;
    check('a confirmed delegate is told they cannot start one', confirmedView.canStart === false, confirmedView);
    check('...and why, so the panel can say nothing rather than guess',
      confirmedView.reason === 'REGISTRATION_CONFIRMED', confirmedView.reason);
    check('...and they are in no group', confirmedView.group === null, confirmedView.group);

    const pendingView = (await call('GET', '/api/groups/me', null, await (async () => {
      const r = await call('POST', `/api/users/${phones.pending}/reset-password`, {}, admin);
      const l = await call('POST', '/api/auth/login-password', { identifier: phones.pending, password: r.body.tempPassword });
      return l.cookie;
    })())).body;
    check('someone already in a group still sees it', !!pendingView.group, pendingView.group && pendingView.group.size);
    check('...and is told there is nothing to start', pendingView.canStart === false
      && pendingView.reason === 'ALREADY_IN_GROUP', pendingView.reason);

    console.log('\n== The portal says so where a leader will read it ==');
    const help = String((await call('GET', '/help/group-registration')).body);
    check('the how-to states the rule',
      /already confirmed cannot be in a group/.test(help.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')), help.length);
    check('...and explains the refusal in the portal\'s own words',
      help.includes('That delegate has already paid and had their registration confirmed, so they cannot join a group.'));
  } finally {
    // Leave the shared fixture as it was found.
    for (const p of Object.values(phones)) {
      await db.run('DELETE FROM group_members WHERE phone_number = ?', [p]);
      await db.run('DELETE FROM delegate_groups WHERE leader_phone = ?', [p]);
      await db.run('DELETE FROM registrations WHERE phone_number = ?', [p]);
    }
    if (ruleId) await call('DELETE', `/api/admin/group-rules/${ruleId}`, null, admin);
  }

  const leftBehind = await db.get(
    `SELECT COUNT(*) AS n FROM group_members WHERE phone_number IN (?, ?, ?, ?)`, Object.values(phones));
  check('nothing this file made is left in the fixture', leftBehind.n === 0, leftBehind.n);

  db.close();
  report();
})();
