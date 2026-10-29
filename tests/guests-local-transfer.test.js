// Faculty from MGIMS or Sevagram are already here: when they are marked as
// faculty, typed in, or linked to their account, their pickup and drop are
// "Not required" (guests.js isLocalFaculty). Everyone else's stay unset, and
// a pickup or drop already set is never overwritten.
const { call, check, report, adminLogin, openDb } = require('./harness');
const G = require('../guests');

const N = String(Date.now() % 100000000).padStart(8, '0');
const P = { mgims: `71${N}`, kasturba: `72${N}`, away: `73${N}`, manipal: `74${N}`, linkMe: `75${N}`, linkSet: `76${N}` };

console.log('\n== Who is from MGIMS or Sevagram ==');
check('MGIMS by name, by its full name, or Sevagram', G.isLocalFaculty({ institution: 'MGIMS, Wardha' })
  && G.isLocalFaculty({ institution: 'Mahatma Gandhi Institute of Medical Sciences, Sevagram' })
  && G.isLocalFaculty({ institution: 'Kasturba Nursing College, Sevagram' }));
check('...or a designation that says so, or an @mgims.ac.in email', G.isLocalFaculty({ designation: 'Professor, MGIMS' }) && G.isLocalFaculty({ email: 'someone@MGIMS.ac.in ' }));
check('not Kasturba Medical College, Manipal; not Wardha alone; not an mgims look-alike', !G.isLocalFaculty({ institution: 'Kasturba Medical College, Manipal' })
  && !G.isLocalFaculty({ institution: 'Government Hospital, Wardha' }) && !G.isLocalFaculty({ email: 'x@notmgims.ac.in.example' }) && !G.isLocalFaculty({}));

(async () => {
  const admin = await adminLogin();
  const db = openDb();
  const mkUser = async (phone, name, institution) => {
    await call('POST', '/api/users', { phone, name, email: `glt-${phone}@example.test`, role: 'DELEGATE', designation: 'Professor' }, admin);
    await db.run('UPDATE users SET institution = ? WHERE phone_number = ?', [institution, phone]);
  };
  const row = (id) => db.get('SELECT pickup_status, drop_status FROM guests WHERE id = ?', [id]);
  const typedIds = [];
  try {
    console.log('\n== Marked as faculty ==');
    await mkUser(P.mgims, 'Meera Mgims', 'Mahatma Gandhi Institute of Medical Sciences, Sevagram');
    await mkUser(P.kasturba, 'Kavita Kasturba', 'Kasturba Nursing College, Sevagram');
    await mkUser(P.away, 'Arun Away', 'AIIMS, Nagpur');
    await mkUser(P.manipal, 'Mohan Manipal', 'Kasturba Medical College, Manipal');
    const m = await call('POST', '/api/guests', { phone: P.mgims }, admin);
    const mr = await row(m.body.id);
    check('from MGIMS: pickup and drop "Not required", and the reply says so', m.body.local === true && mr.pickup_status === 'Not required' && mr.drop_status === 'Not required', [m.body, mr]);
    const k = await call('POST', '/api/guests', { phone: P.kasturba }, admin);
    check('from Sevagram: the same', (await row(k.body.id)).pickup_status === 'Not required');
    const a = await call('POST', '/api/guests', { phone: P.away }, admin);
    const ar = await row(a.body.id);
    check('from elsewhere: left unset', a.body.local === false && ar.pickup_status === null && ar.drop_status === null);
    const mm = await call('POST', '/api/guests', { phone: P.manipal }, admin);
    check('Kasturba Medical College, Manipal: left unset', (await row(mm.body.id)).pickup_status === null);
    const log = await db.get("SELECT new_value FROM audit_log WHERE action = 'GUEST_ADDED' AND entity_id = ?", [String(m.body.id)]);
    check('the log says why', log && /from MGIMS\/Sevagram, so pickup and drop not required/.test(log.new_value), log);

    console.log('\n== Typed in, not signed up ==');
    const t = await call('POST', '/api/guests', { guest: { name: `Tara Typed ${N}`, email: `tara${N}@mgims.ac.in` } }, admin);
    typedIds.push(t.body.id);
    check('an @mgims.ac.in email: pickup and drop "Not required"', t.body.local === true && (await row(t.body.id)).drop_status === 'Not required');
    const t2 = await call('POST', '/api/guests', { guest: { name: `Tejas Typed ${N}`, designation: 'Professor, Delhi' } }, admin);
    typedIds.push(t2.body.id);
    check('otherwise left unset', (await row(t2.body.id)).pickup_status === null);

    console.log('\n== Linked to their account later ==');
    await mkUser(P.linkMe, 'Lata Linked', 'MGIMS Sevagram');
    await mkUser(P.linkSet, 'Lalit Linked', 'MGIMS Sevagram');
    const u1 = await call('POST', '/api/guests', { guest: { name: `Lata ${N}` } }, admin);
    const u2 = await call('POST', '/api/guests', { guest: { name: `Lalit ${N}` } }, admin);
    typedIds.push(u1.body.id, u2.body.id);
    await db.run("UPDATE guests SET pickup_status = 'Assigned' WHERE id = ?", [u2.body.id]);
    const l1 = await call('PUT', `/api/guests/${u1.body.id}/link`, { phone: P.linkMe }, admin);
    check('linking shows them to be from MGIMS: pickup and drop become "Not required"', l1.body.local === true
      && JSON.stringify(await row(u1.body.id)) === JSON.stringify({ pickup_status: 'Not required', drop_status: 'Not required' }));
    await call('PUT', `/api/guests/${u2.body.id}/link`, { phone: P.linkSet }, admin);
    check('...a pickup already set is kept; only the unset drop changes', JSON.stringify(await row(u2.body.id)) === JSON.stringify({ pickup_status: 'Assigned', drop_status: 'Not required' }));
  } finally {
    const phones = Object.values(P);
    const marks = phones.map(() => '?').join(',');
    await db.run(`DELETE FROM guests WHERE phone_number IN (${marks})`, phones);
    for (const id of typedIds) if (id) await db.run('DELETE FROM guests WHERE id = ?', [id]);
    await db.run(`DELETE FROM user_roles WHERE phone_number IN (${marks})`, phones);
    await db.run(`DELETE FROM users WHERE phone_number IN (${marks})`, phones);
  }
  db.close();
  report();
})();
