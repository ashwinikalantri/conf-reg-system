// Shared test harness.
//
// Every test file used to carry its own copy of an HTTP client, a check()
// and a pass/fail counter -- 34 copies of the first, 35 of the second, with
// the port hardcoded 35 times. That duplication is why there was no way to
// run the suite other than a shell loop, and why the port could not move.
//
// The helpers here are a superset of what those copies did, so a converted
// file behaves exactly as before: same request semantics, same response
// shape, and the same "  PASS  name" / "  FAIL  name  -> detail" lines that
// the runner counts.
//
// Nothing here is specific to one test. Fixtures come next (Phase 0.2); for
// now the suite still runs against a copy of a real database supplied as
// argv[2], exactly as it did.

const http = require('http');
const path = require('path');
const fs = require('fs');

// The application under test, one directory up. Tests that assert on source
// (that a route exists, that a config value is not hardcoded) read it from
// here rather than relative to themselves.
const ROOT = path.join(__dirname, '..');
const appFile = (...rel) => path.join(ROOT, ...rel);

// Where the running instance keeps its data -- resolved from the database it
// was given, exactly as the server resolves its own BACKUP_DIR. That is where
// the backup handshake files appear, so tests must look in the same place
// rather than beside themselves.
const dataDir = () => path.dirname(fs.realpathSync(process.argv[2]));

// Where the app under test is listening. Defaults to the port the suite has
// always used, so this can be adopted file by file without a flag day.
const HOST = process.env.TEST_HOST || 'localhost';
const PORT = Number(process.env.TEST_PORT || 4188);
const BASE = `http://${HOST}:${PORT}`;

// One request. Returns every field any of the old private copies returned,
// so no caller has to change what it reads:
//   status   HTTP status code
//   body     parsed JSON; the response TEXT when it is not JSON. That is what
//            the clients this replaced did, and several tests read .body on
//            HTML pages and CSV exports. .raw is always the text.
//   raw      the response as text (HTML pages, CSV exports)
//   buf      the response as a Buffer (images)
//   type     content-type header
//   headers  all response headers
//   location the Location header, for redirects
//   cookie   the first Set-Cookie, trimmed to name=value for re-sending
function call(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: HOST,
      port: PORT,
      path,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const raw = buf.toString();
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* leave it as text */ }
        const setCookie = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          body: parsed,
          raw,
          buf,
          type: res.headers['content-type'],
          headers: res.headers,
          location: res.headers.location,
          cookie: setCookie ? setCookie[0].split(';')[0] : null,
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// POST-only shorthand, for the files that were written against one.
const req = (path, body, cookie) => call('POST', path, body, cookie);

// --- assertions ------------------------------------------------------------
let passed = 0;
let failed = 0;

// `detail` is printed only on failure, and only when given. Objects are
// JSON-stringified and long values clipped -- a failure should be readable in
// a terminal, not a wall of a serialised response.
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
    return true;
  }
  failed++;
  let shown = '';
  if (detail !== undefined) {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    shown = `  -> ${String(text === undefined ? '' : text).slice(0, 200)}`;
  }
  console.log(`  FAIL  ${name}${shown}`);
  return false;
}

const counts = () => ({ passed, failed });

// Prints the tally every file used to print for itself, and sets the exit
// code. Callers close their own database first -- this does not return.
function report() {
  console.log(`\n---- ${passed} passed, ${failed} failed ----`);
  process.exit(failed ? 1 : 0);
}

// --- sign-in ---------------------------------------------------------------
// Each test file gets its own super admin out of the seeded pool. The OTP
// resend throttle is per destination: if every file signed in as the same
// person they would throttle each other, which is exactly what happened when
// the suite first ran against a fixture. Chosen from the file name so a given
// test always gets the same account, whatever order the runner uses.
const ADMIN_POOL_SIZE = 60;   // must match tests/seed.js
const ADMIN_PW = 'harness-admin-pw';
const DELEGATE_PW = 'harness-delegate-pw';
const ADMIN = (() => {
  const who = path.basename(process.argv[1] || 'unknown');
  let n = 0;
  for (const ch of who) n = (n * 31 + ch.charCodeAt(0)) % ADMIN_POOL_SIZE;
  return `90001${String(n + 1).padStart(5, '0')}`;
})();

// Sign in as this file's admin. Password rather than OTP: it is not what these
// tests are checking, and it does not consume the OTP throttle.
const adminLogin = () => loginPassword(ADMIN, ADMIN_PW);

// Both routes into the app, returning the session cookie or null. Null rather
// than throwing because several tests deliberately probe accounts that cannot
// log in, and because the OTP resend throttle can legitimately refuse.
async function loginOtp(identifier) {
  const asked = await call('POST', '/api/auth/login-otp', { identifier });
  if (!asked.body || !asked.body.success) return null;
  const done = await call('POST', '/api/auth/login', { identifier, otp: asked.body.devOtp });
  return done.body && done.body.success ? done.cookie : null;
}

async function loginPassword(identifier, password) {
  const done = await call('POST', '/api/auth/login-password', { identifier, password });
  return done.body && done.body.success ? done.cookie : null;
}

// --- database --------------------------------------------------------------
// The suite still reads the database directly to find fixtures and to confirm
// that an API call actually wrote what it claimed. Path comes from argv[2],
// as it always has.
function openDb({ readOnly = false } = {}) {
  const sqlite3 = require('sqlite3').verbose();
  const file = process.argv[2];
  if (!file) throw new Error('No database path given. Pass it as the first argument.');
  const db = readOnly
    ? new sqlite3.Database(file, sqlite3.OPEN_READONLY)
    : new sqlite3.Database(file);
  return {
    db,
    all: (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => (e ? rej(e) : res(rows)))),
    get: (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => (e ? rej(e) : res(row)))),
    run: (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { return e ? rej(e) : res(this); })),
    close: () => db.close(),
  };
}

module.exports = { BASE, HOST, PORT, ROOT, appFile, dataDir, ADMIN, ADMIN_PW, DELEGATE_PW, adminLogin, call, req, check, counts, report, loginOtp, loginPassword, openDb };
