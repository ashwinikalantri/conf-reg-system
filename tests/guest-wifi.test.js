// Wi-Fi logins for faculty (owner, 20 Nov 2026): the venue's guest logins,
// pasted in once; the next free one given to a faculty member from their
// panel, shown with the network, taken back to give again.
const fs = require('fs');
const G = require('../guests');
const { call, check, report, adminLogin, loginPassword, ADMIN_PW, openDb, appFile } = require('./harness');

(async () => {
  console.log('\n== Reading the list ==');
  const p = G.parseWifiLogins('Sr No ,Username,Password\n1,demo11,x1@Ab\n2,demo21,y2@Cd\n\ndemo30\tz@3@Ef\n3,demo49,7@@gH');
  check('the IT sheet as it comes: header and serial numbers passed over, tabs too', p.errors.length === 0
    && JSON.stringify(p.logins) === JSON.stringify([{ username: 'demo11', password: 'x1@Ab' }, { username: 'demo21', password: 'y2@Cd' }, { username: 'demo30', password: 'z@3@Ef' }, { username: 'demo49', password: '7@@gH' }]), p);
  check('a line without a password is an error; one listed twice too', G.parseWifiLogins('x\ndemo1,a\nDEMO1,b').errors.length === 2);
  check('what they are told: the network, the username, the password', /network "Guest"/.test(G.wifiInstructions('u1', 'p@1')) && /Username: u1/.test(G.wifiInstructions('u1', 'p@1')));

  console.log('\n== Giving them ==');
  const admin = await adminLogin();
  const desk = await loginPassword('9000000006', ADMIN_PW);
  const db = openDb();
  const N = String(Date.now()).slice(-6);
  const made = [];
  const users = [`wifiA${N}`, `wifiB${N}`];
  try {
    for (const n of ['A', 'B', 'C']) made.push((await db.run("INSERT INTO guests (guest_name, overall_status, created_at) VALUES (?, 'Confirmed', ?)", [`Dr Wifi ${n} ${N}`, Date.now()])).lastID);
    check('only those who manage the Faculty tab add logins', (await call('POST', '/api/guests/wifi', { text: `${users[0]},pw1` }, desk)).status === 403);
    const add = await call('POST', '/api/guests/wifi', { text: `Username,Password\n${users[0]},pw@1\n${users[1]},pw@2` }, admin);
    check('logins added', add.body.success && add.body.added === 2, add.body);
    check('...again: already there, not twice', (await call('POST', '/api/guests/wifi', { text: `${users[0]},pw@1` }, admin)).body.already === 1);
    // Only these two are free, for the test.
    const others = await db.all('SELECT id FROM guest_wifi WHERE guest_id IS NULL AND username NOT IN (?, ?)', users);
    await db.run(`UPDATE guest_wifi SET guest_id = -id WHERE id IN (${others.map((o) => o.id).join(',') || 0})`);
    const give = (id, body = {}, who = admin) => call('POST', `/api/guests/${id}/wifi`, body, who);
    const g1 = await give(made[0]);
    check('the next free one is given', g1.body.success && g1.body.username === users[0], g1.body);
    check('...again: the same, nothing new', (await give(made[0])).body.changed === 0);
    check('the next person gets the next', (await give(made[1])).body.username === users[1]);
    const none = await give(made[2]);
    check('none left: says so', none.status === 400 && /No Wi-Fi logins left/.test(none.body.error), none.body);
    const list = (await call('GET', '/api/guests', null, admin)).body;
    const a = list.guests.find((x) => x.id === made[0]);
    check('their panel has it: username and password', a.wifi_username === users[0] && a.wifi_password === 'pw@1' && list.wifi.network === 'Guest');
    check('the list says who has which', list.wifi.logins.some((l) => l.username === users[0] && l.guest_id === made[0] && !!l.allotted_by));
    check('the front desk cannot give one', (await give(made[2], {}, desk)).status === 403);
    check('a given login cannot be removed from the list', (await call('DELETE', `/api/guests/wifi/${list.wifi.logins.find((l) => l.username === users[0]).id}`, null, admin)).status === 400);
    const back = await give(made[0], { undo: true });
    check('taken back: free again, given to the next who asks', back.body.changed === 1 && (await give(made[2])).body.username === users[0]);
    check('logged, without the password', !!(await db.get("SELECT 1 FROM audit_log WHERE action = 'GUEST_WIFI_GIVEN' AND entity_id = ? AND new_value NOT LIKE '%pw@%'", [String(made[0])]))
      && !!(await db.get("SELECT 1 FROM audit_log WHERE action = 'GUEST_WIFI_TAKEN_BACK' AND entity_id = ?", [String(made[0])])));
    await db.run("UPDATE guests SET overall_status = 'Cancelled' WHERE id = ?", [made[0]]);
    check('cancelled: none given', (await give(made[0])).status === 400);
    await give(made[2], { undo: true });
    const freeId = (await db.get('SELECT id FROM guest_wifi WHERE username = ?', [users[0]])).id;
    check('a free one can be removed', (await call('DELETE', `/api/guests/wifi/${freeId}`, null, admin)).body.success === true);
    await db.run(`UPDATE guest_wifi SET guest_id = NULL WHERE guest_id < 0`);
  } finally {
    await db.run(`UPDATE guest_wifi SET guest_id = NULL WHERE guest_id < 0`).catch(() => {});
    await db.run('DELETE FROM guest_wifi WHERE username IN (?, ?)', users);
    for (const id of made) await db.run('DELETE FROM guests WHERE id = ?', [id]);
    db.close();
  }

  console.log('\n== On the page ==');
  const js = fs.readFileSync(appFile('public', 'app.js'), 'utf8');
  check('the panel shows it, with Copy for WhatsApp and Take back', /\$\{guestWifiStrip\(g\)\}/.test(js) && /Copy for WhatsApp/.test(js) && /giveGuestWifi\(\$\{esc\(g\.id\)\}, false\)/.test(js));
  check('the list is under Cars, drivers & rooms', /renderGuestRooms\(\); renderGuestWifi\(\);/.test(js));
  report();
})();
