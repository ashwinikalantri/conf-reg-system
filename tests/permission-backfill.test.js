// Roles are seeded into a database once and never re-seeded, so a permission
// added to the catalogue afterwards does not reach the roles already there.
// That is deliberate: it stops a new key silently widening a role someone has
// customised.
//
// It is wrong for a key that SPLITS an existing one. payments.view_totals
// carved conference-wide money out of payments.view, so every role holding
// payments.view could already see those figures -- leaving them behind takes
// away something nobody decided to take away, and leaves the catalogue
// granting what the database refuses. That is not hypothetical: the first
// live run of this change returned 403 to Finance Admin for a figure it had
// always been shown.
//
// The suite's own fixture cannot catch this, because it is seeded fresh from
// the current catalogue and so never lacks the key. This boots a server
// against a database doctored to look like one from before the split --
// which is what a real deployment is.
const { check, report, appFile } = require('./harness');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const ROOT = path.join(__dirname, '..');
const NEW_KEY = 'payments.view_totals';
const SOURCE_KEY = 'payments.view';

const open = (file) => new Promise((res, rej) => {
  const db = new sqlite3.Database(file, (e) => (e ? rej(e) : res(db)));
});
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { return e ? rej(e) : res(this); }));
const close = (db) => new Promise((res) => db.close(() => res()));

// Boot the app against `work`, wait for it to be listening, then stop it.
// Everything this test cares about happens during boot.
function boot(work, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: work,
      env: { ...process.env, PORT: String(port), OTP_ECHO: '1', DB_PATH: path.join(work, 'conference.db') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const done = (fn, arg) => { try { child.kill(); } catch (e) { /* already gone */ } fn(arg); };
    const timer = setTimeout(() => done(reject, new Error(`server did not start:\n${out}`)), 30000);
    const onData = (c) => {
      out += c;
      if (/Server running on/.test(out)) {
        clearTimeout(timer);
        // Give the post-listen boot work (migrations, seeding, the backfill)
        // a moment to finish before reading the database back.
        setTimeout(() => done(resolve, out), 1200);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nqocn-backfill-'));
  const file = path.join(work, 'conference.db');
  fs.copyFileSync(process.argv[2], file);

  // Make it look like a database from before the split: every role that has
  // the source key, without the new one.
  let db = await open(file);
  const before = await all(db,
    `SELECT rp.role_key FROM role_permissions rp JOIN roles r ON r.key = rp.role_key
      WHERE rp.permission = ? AND r.grants_all = 0 ORDER BY rp.role_key`, [SOURCE_KEY]);
  await run(db, 'DELETE FROM role_permissions WHERE permission = ?', [NEW_KEY]);
  const afterDelete = await all(db, 'SELECT role_key FROM role_permissions WHERE permission = ?', [NEW_KEY]);
  await close(db);

  console.log('\n== The stale database really is stale ==');
  check('there are roles holding the source permission', before.length > 0, before);
  check('and none of them holds the new one yet', afterDelete.length === 0, afterDelete);

  console.log('\n== Booting restores it ==');
  const out = await boot(work, 34100 + (process.pid % 900));
  check('the server announced the backfill', /Backfilled payments\.view_totals/.test(out),
    out.split('\n').filter((l) => /Backfill|error/i.test(l)).slice(0, 3).join(' | '));

  db = await open(file);
  const after = await all(db, 'SELECT role_key FROM role_permissions WHERE permission = ? ORDER BY role_key', [NEW_KEY]);
  const restored = after.map((r) => r.role_key);
  const expected = before.map((r) => r.role_key);
  check('every role that could already see the figures has them again',
    expected.every((r) => restored.includes(r)), { expected, restored });
  check('...and nothing else was granted it',
    restored.every((r) => expected.includes(r)), { expected, restored });

  console.log('\n== It is idempotent, and does not resurrect a deliberate removal ==');
  // Second boot: nothing to do, and no duplicate rows.
  const out2 = await boot(work, 34100 + ((process.pid + 1) % 900));
  check('a second boot reports no backfill', !/Backfilled payments\.view_totals/.test(out2));
  db = await open(file);
  const dupes = await all(db,
    'SELECT role_key, COUNT(*) n FROM role_permissions WHERE permission = ? GROUP BY role_key HAVING n > 1', [NEW_KEY]);
  check('no duplicate rows', dupes.length === 0, dupes);

  // A role that has had the SOURCE permission taken away must not be handed
  // the new one -- the backfill follows payments.view, it does not invent it.
  const victim = expected[0];
  await run(db, 'DELETE FROM role_permissions WHERE role_key = ? AND permission IN (?, ?)',
    [victim, SOURCE_KEY, NEW_KEY]);
  await close(db);
  await boot(work, 34100 + ((process.pid + 2) % 900));
  db = await open(file);
  const back = await all(db, 'SELECT 1 FROM role_permissions WHERE role_key = ? AND permission = ?', [victim, NEW_KEY]);
  await close(db);
  check(`a role without ${SOURCE_KEY} is not given the new key`, back.length === 0, { victim, back });

  fs.rmSync(work, { recursive: true, force: true });
  report();
})();
