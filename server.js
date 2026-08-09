const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { createWorker } = require('tesseract.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Payment screenshots are written here (never committed; see .gitignore) and
// served only through an authenticated route -- not from the static root.
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB decoded
const IMAGE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// --- CONFIG -------------------------------------------------------------
const COOKIE_NAME = 'nqocn_sid';
const OTP_TTL_MS = 5 * 60 * 1000;        // OTP valid for 5 minutes
const OTP_RESEND_MS = 30 * 1000;         // min gap between OTP requests
const OTP_MAX_ATTEMPTS = 5;              // wrong tries before OTP is burned
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // sessions last 12 hours

// Send the OTP back to the client when there is no real SMS gateway.
// Defaults on outside production so the app is usable out of the box;
// force it off with OTP_ECHO=false, or on with OTP_ECHO=true.
const OTP_ECHO = process.env.OTP_ECHO
  ? process.env.OTP_ECHO === 'true'
  : process.env.NODE_ENV !== 'production';

// Set COOKIE_SECURE=true when served over HTTPS (directly or via a proxy).
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
if (COOKIE_SECURE) app.set('trust proxy', 1);

const ADMIN_ROLES = ['SUPER_ADMIN', 'FINANCE_ADMIN', 'ACADEMIC_REVIEWER'];

// Authoritative fee schedule. The client has its own copy for display, but
// the amount charged and recorded is always computed here from the
// category key -- never taken from the request body.
const PRICING_TIERS = {
  nursing_ug:  { early: 500,  regular: 1000, late: 2000, label: 'Nursing Student UG' },
  nursing_pg:  { early: 750,  regular: 1500, late: 2500, label: 'Nursing Student PG' },
  med_student: { early: 1500, regular: 2200, late: 3000, label: 'Medical Student UG' },
  nurse_cho:   { early: 2000, regular: 2800, late: 3500, label: 'Nurse / Paramedical / CHO' },
  pg_doctor:   { early: 3000, regular: 4000, late: 5000, label: 'PG Student / Resident Doctor' },
  faculty_mo:  { early: 3000, regular: 4000, late: 5000, label: 'Doctors / Faculty / NHM MO' },
  chw:         { early: 200,  regular: 200,  late: 200,  label: 'Frontline CHWs (ASHA/ANM/AWW)' },
};

// Which column of the fee schedule is currently in effect. There are no
// cutoff dates defined yet, so this is configuration, defaulting to early.
const REGISTRATION_PHASE = ['early', 'regular', 'late'].includes(process.env.REGISTRATION_PHASE)
  ? process.env.REGISTRATION_PHASE
  : 'early';

// The conference's own UPI ID (VPA). A payment screenshot should show this as
// the payee; OCR checks the uploaded image against it.
const OFFICIAL_UPI_ID = process.env.OFFICIAL_UPI_ID || 'abhishekraut@cbin';

// --- CRYPTO / COOKIE HELPERS --------------------------------------------
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Escape a value for safe interpolation into server-rendered HTML.
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Constant-time comparison of two equal-length strings.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Decode a `data:image/...;base64,...` URI and validate type and size.
// Returns { buffer, ext } or { error }. Does not touch disk.
function decodeScreenshot(dataUri) {
  const m = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(dataUri || '');
  if (!m) return { error: 'A valid PNG, JPEG, GIF, or WebP image is required.' };

  const ext = IMAGE_EXT[m[1].toLowerCase()] || 'png';
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length === 0) return { error: 'The uploaded image is empty.' };
  if (buffer.length > MAX_IMAGE_BYTES) return { error: 'Image exceeds the 5 MB limit.' };
  return { buffer, ext };
}

// Write a validated image buffer to the upload dir; returns the filename.
async function writeScreenshotBuffer(buffer, ext) {
  const filename = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), buffer);
  return filename;
}

// tesseract.js can throw ASYNCHRONOUSLY (outside the recognize() promise, via
// process.nextTick) when handed a corrupt image, which would otherwise crash
// the whole server. This safety net keeps it alive; the affected submission
// just gets all-false checks and is flagged. The realistic source of an
// uncaught async throw in this app is the OCR worker on bad input.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (continuing):', (err && err.message) || err);
  ocrWorkerPromise = null; // drop a possibly-dead worker; a fresh one is made next time
});

// Lazily-created, reused OCR worker (creating one per request is expensive).
// The language model is cached under .ocr-cache/ (git-ignored) rather than
// the working directory.
let ocrWorkerPromise = null;
function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker('eng', 1, { cachePath: path.join(__dirname, '.ocr-cache') });
  }
  return ocrWorkerPromise;
}

// OCR a screenshot buffer and check it against the expected values. Every
// check is advisory; a failure to read the image yields all-false (flagged),
// never an error that blocks submission. Returns { amount, vpa, utr } booleans.
async function runOcrChecks(buffer, { expectedAmount, utr }) {
  let text = '';
  try {
    const worker = await getOcrWorker();
    // Bound the wait: a corrupt image can make the worker throw out-of-band
    // and never settle this promise, which would otherwise hang the request.
    const result = await Promise.race([
      worker.recognize(buffer),
      new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timed out')), 15000)),
    ]);
    text = (result && result.data && result.data.text) || '';
  } catch (err) {
    console.error('OCR failed:', err.message);
    ocrWorkerPromise = null; // drop a possibly-dead worker
    return { amount: false, vpa: false, utr: false };
  }

  const compact = text.replace(/\s+/g, '').toLowerCase();
  const digitsOnly = text.replace(/[^0-9]/g, '');
  const enteredUtrDigits = String(utr || '').replace(/[^0-9]/g, '');

  // Amount: the expected fee appears in the text as a standalone number, with
  // or without a thousands separator (e.g. 3000, 3,000, or 3 000).
  const amtWithSep = String(expectedAmount).replace(/\B(?=(\d{3})+(?!\d))/g, '[,\\s]?');
  const amount = new RegExp(`(?<!\\d)${amtWithSep}(?!\\d)`).test(text);

  // VPA: the conference UPI id appears (compare ignoring whitespace/case).
  const vpa = compact.includes(OFFICIAL_UPI_ID.replace(/\s+/g, '').toLowerCase());

  // UTR: the entered UTR digits appear in the image text.
  const utrMatch = enteredUtrDigits.length >= 6 && digitsOnly.includes(enteredUtrDigits);

  return { amount, vpa, utr: utrMatch };
}

// Best-effort removal of a stored screenshot file (ignores legacy data URIs
// and already-missing files).
async function deleteScreenshotFile(value) {
  if (!value || /^data:/i.test(value)) return;
  try {
    await fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(value)));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Failed to remove old screenshot:', err.message);
  }
}

// Append an entry to the audit trail, attributed to the acting admin.
async function recordAudit({ req, entityType, entityId, action, oldValue, newValue }) {
  await dbRun(
    `INSERT INTO audit_log
      (entity_type, entity_id, action, old_value, new_value, actor_phone, actor_name, actor_role, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entityType,
      String(entityId),
      action,
      oldValue == null ? null : String(oldValue),
      newValue == null ? null : String(newValue),
      req.session.phone,
      req.session.name,
      req.session.role,
      Date.now(),
    ]
  );
}

// Fetch program options annotated with live enrollment counts. A slot is held
// by any non-rejected registration referencing the option.
function fetchProgramOptions({ activeOnly } = {}) {
  return dbAll(`
    SELECT o.id, o.type, o.name, o.capacity, o.active,
      (SELECT COUNT(*) FROM registrations r
         WHERE r.bank_status != 'REJECTED'
           AND ((o.type = 'WORKSHOP' AND r.workshop_option_id = o.id)
             OR (o.type = 'QI' AND r.qi_option_id = o.id))) AS enrolled
    FROM program_options o
    ${activeOnly ? 'WHERE o.active = 1' : ''}
    ORDER BY o.type, o.id`);
}

// Validate a chosen option and confirm it still has room. `ownRegId` is the
// caller's existing registration (excluded from the count on re-submission).
async function resolveOption(id, type, ownRegId) {
  const opt = await dbGet('SELECT * FROM program_options WHERE id = ? AND type = ? AND active = 1', [id, type]);
  const label = type === 'WORKSHOP' ? 'workshop' : 'QI practice';
  if (!opt) return { error: `Please choose an available ${label}.` };

  const col = type === 'WORKSHOP' ? 'workshop_option_id' : 'qi_option_id';
  const { n } = await dbGet(
    `SELECT COUNT(*) AS n FROM registrations WHERE ${col} = ? AND bank_status != 'REJECTED' AND id != ?`,
    [id, ownRegId == null ? -1 : ownRegId]
  );
  if (n >= opt.capacity) return { error: `"${opt.name}" is full. Please choose another ${label}.` };
  return { opt };
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// --- DATABASE -----------------------------------------------------------
const db = new sqlite3.Database('./conference.db', (err) => {
  if (err) console.error('Error connecting to SQLite:', err);
  else console.log('Connected to SQLite database.');
});

// Promise wrappers so the auth flow reads sequentially.
const dbGet = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
const dbAll = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const dbRun = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      phone_number TEXT PRIMARY KEY,
      full_name TEXT,
      designation TEXT,
      institution TEXT,
      pincode TEXT,
      state TEXT,
      district TEXT,
      post_office TEXT,
      role TEXT DEFAULT 'DELEGATE'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT UNIQUE,
      delegate_name TEXT,
      category_key TEXT,
      category_label TEXT,
      workshop TEXT,
      qi_exposure TEXT,
      paid_amount REAL,
      utr_number TEXT,
      screenshot TEXT,
      is_flagged INTEGER DEFAULT 0,
      bank_status TEXT DEFAULT 'PENDING'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS abstracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT,
      author_name TEXT,
      format TEXT,
      title TEXT,
      text TEXT,
      word_count INTEGER,
      status TEXT DEFAULT 'UNDER_REVIEW'
    )
  `);

  // Additive migration for databases created before the review workflow.
  db.all('PRAGMA table_info(abstracts)', (err, cols) => {
    if (err) return console.error('Schema check failed:', err.message);
    if (!cols.some((c) => c.name === 'status')) {
      db.run("ALTER TABLE abstracts ADD COLUMN status TEXT DEFAULT 'UNDER_REVIEW'");
    }
  });

  // One-time password codes, keyed by phone (one active code per number).
  db.run(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      phone_number TEXT PRIMARY KEY,
      otp_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0,
      last_sent_at INTEGER NOT NULL
    )
  `);

  // Server-side sessions. Only the hash of the cookie token is stored.
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      phone_number TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  // Append-only audit trail of administrative state changes (who did what,
  // to which record, and when).
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      actor_phone TEXT NOT NULL,
      actor_name TEXT,
      actor_role TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  // Master of enrollable programs (workshops and QI practice tracks) with a
  // per-option participant cap. Admin-editable.
  db.run(`
    CREATE TABLE IF NOT EXISTS program_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,          -- 'WORKSHOP' | 'QI'
      name TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 50,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `);

  // Additive migrations: server-computed fee, OCR check results, registration
  // number, and the chosen program-option ids (for capacity accounting).
  db.all('PRAGMA table_info(registrations)', (err, cols) => {
    if (err) return console.error('Schema check failed:', err.message);
    const names = cols.map((c) => c.name);
    if (!names.includes('expected_amount')) db.run('ALTER TABLE registrations ADD COLUMN expected_amount REAL');
    if (!names.includes('ocr_amount_match')) db.run('ALTER TABLE registrations ADD COLUMN ocr_amount_match INTEGER');
    if (!names.includes('ocr_vpa_match')) db.run('ALTER TABLE registrations ADD COLUMN ocr_vpa_match INTEGER');
    if (!names.includes('ocr_utr_match')) db.run('ALTER TABLE registrations ADD COLUMN ocr_utr_match INTEGER');
    if (!names.includes('registration_number')) db.run('ALTER TABLE registrations ADD COLUMN registration_number TEXT');
    if (!names.includes('workshop_option_id')) db.run('ALTER TABLE registrations ADD COLUMN workshop_option_id INTEGER');
    if (!names.includes('qi_option_id')) db.run('ALTER TABLE registrations ADD COLUMN qi_option_id INTEGER');

    // Backfill a number for any already-verified registration that predates
    // number assignment. Idempotent -- matches nothing once filled.
    db.run(
      `UPDATE registrations
          SET registration_number = 'NQOCN2026' || printf('%04d', id)
        WHERE bank_status = 'BANK_VERIFIED' AND (registration_number IS NULL OR registration_number = '')`
    );

    // One-time reformat: drop the hyphen from older NQOCN2026-000N numbers.
    // Idempotent -- matches nothing once no hyphenated numbers remain.
    db.run(
      `UPDATE registrations
          SET registration_number = REPLACE(registration_number, 'NQOCN2026-', 'NQOCN2026')
        WHERE registration_number LIKE 'NQOCN2026-%'`
    );
  });

  // Seed the program master on first run from the original fixed options.
  db.get('SELECT COUNT(*) AS n FROM program_options', (err, r) => {
    if (err || (r && r.n > 0)) return;
    const now = Date.now();
    const stmt = db.prepare('INSERT INTO program_options (type, name, capacity, active, created_at) VALUES (?, ?, ?, 1, ?)');
    [
      'POCQI Methodology for Healthcare Professionals',
      'Quality Improvement Workshop for Undergraduates',
      'The Art of Birthing: Learn, Empower and Birth',
      'Psychology of Change',
      'AI in Healthcare: Unlock the Potential',
      'Workshops on Patient Safety & Infection Control Topics',
      'Quality Improvement for enhancing Healthcare Professions Education',
      'Leadership in Nursing care',
      'Empathetic care for Quality Improvement',
      'Quality Improvement Workshop for Primary Healthcare Providers',
      'Improvement in Quality and safety through Simulation in Surgery',
    ].forEach((name) => stmt.run('WORKSHOP', name, 50, now));
    [
      'Exposure A: Neonatal ICU (SNCU / NICU QI)',
      'Exposure B: Emergency Department',
      'Exposure C: Surgical Safety & Infection Control',
      'Exposure D: Labor Room Quality (Maternal Care)',
    ].forEach((name) => stmt.run('QI', name, 50, now));
    stmt.finalize();
    console.log('Seeded default workshop and QI practice options.');
  });
});

// One-time migration: move any base64 screenshots still stored in the DB out
// to files, leaving only the filename behind. Idempotent -- once migrated,
// the LIKE no longer matches. Runs after table creation via db.serialize.
db.serialize(() => {
  db.all("SELECT id, screenshot FROM registrations WHERE screenshot LIKE 'data:image/%'", async (err, rows) => {
    if (err) return console.error('Screenshot migration check failed:', err.message);
    for (const row of rows) {
      const decoded = decodeScreenshot(row.screenshot);
      if (decoded.error) {
        console.error(`Skipping screenshot migration for registration ${row.id}: ${decoded.error}`);
        continue;
      }
      const filename = await writeScreenshotBuffer(decoded.buffer, decoded.ext);
      db.run('UPDATE registrations SET screenshot = ? WHERE id = ?', [filename, row.id]);
      console.log(`Migrated screenshot for registration ${row.id} -> ${filename}`);
    }
  });
});

// Periodically purge expired OTPs and sessions. unref() so it never keeps
// the process (or a test run) alive on its own.
setInterval(() => {
  const now = Date.now();
  db.run('DELETE FROM otp_codes WHERE expires_at < ?', [now]);
  db.run('DELETE FROM sessions WHERE expires_at < ?', [now]);
}, 60 * 60 * 1000).unref();

// --- AUTH CORE ----------------------------------------------------------
// Validate and burn an OTP. Returns { ok: true } or { ok: false, error }.
async function consumeOtp(phone, otp) {
  const row = await dbGet('SELECT * FROM otp_codes WHERE phone_number = ?', [phone]);
  if (!row) return { ok: false, error: 'Please request an OTP first.' };

  if (Date.now() > row.expires_at) {
    await dbRun('DELETE FROM otp_codes WHERE phone_number = ?', [phone]);
    return { ok: false, error: 'OTP expired. Please request a new one.' };
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await dbRun('DELETE FROM otp_codes WHERE phone_number = ?', [phone]);
    return { ok: false, error: 'Too many incorrect attempts. Please request a new OTP.' };
  }
  if (!safeEqual(row.otp_hash, sha256(`${phone}:${otp}`))) {
    await dbRun('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone_number = ?', [phone]);
    return { ok: false, error: 'Incorrect OTP.' };
  }

  await dbRun('DELETE FROM otp_codes WHERE phone_number = ?', [phone]); // single use
  return { ok: true };
}

// Issue a session and attach its cookie to the response.
async function startSession(phone, role, res) {
  const raw = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await dbRun(
    'INSERT INTO sessions (token_hash, phone_number, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    [sha256(raw), phone, role, now, now + SESSION_TTL_MS]
  );
  res.cookie(COOKIE_NAME, raw, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

// Populate req.session from the cookie when present and valid. Always
// calls next(); downstream guards decide what to do without a session.
async function loadSession(req, res, next) {
  try {
    const raw = parseCookies(req)[COOKIE_NAME];
    if (!raw) return next();

    const tokenHash = sha256(raw);
    const row = await dbGet('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]);
    if (!row) return next();

    if (Date.now() > row.expires_at) {
      await dbRun('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
      return next();
    }

    // Re-read the role from users so role changes take effect without a
    // re-login, and a deleted user loses access immediately.
    const user = await dbGet('SELECT role, full_name FROM users WHERE phone_number = ?', [row.phone_number]);
    if (!user) {
      await dbRun('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
      return next();
    }

    req.session = { phone: row.phone_number, role: user.role, name: user.full_name, tokenHash };
    next();
  } catch (err) {
    next(err);
  }
}

function requireAuth(req, res, next) {
  if (!req.session) return res.status(401).json({ success: false, error: 'Login required.' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session) return res.status(401).json({ success: false, error: 'Login required.' });
    if (!roles.includes(req.session.role)) {
      return res.status(403).json({ success: false, error: 'You do not have permission for this action.' });
    }
    next();
  };
}

// --- MIDDLEWARE ---------------------------------------------------------
// Body limit sized for a single base64 screenshot (5 MB image + ~33%
// encoding overhead + form fields), not the old 50 MB.
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ limit: '8mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(loadSession);

// Admin panel lives outside the static root and is only served to a
// logged-in admin. Anonymous users go to the portal to log in first.
app.get('/admin', (req, res) => {
  if (!req.session) return res.redirect('/');
  if (!ADMIN_ROLES.includes(req.session.role)) {
    return res.status(403).send(
      '<!doctype html><meta charset="utf-8"><title>Forbidden</title>' +
      '<body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;text-align:center">' +
      '<h1>403 — Not authorised</h1>' +
      '<p>Your account does not have administrative access.</p>' +
      '<p><a href="/">Return to the delegate portal</a></p></body>'
    );
  }
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// --- AUTH ENDPOINTS -----------------------------------------------------

// Request an OTP. Generates a random code, stores only its hash, and
// (outside production) returns/logs it since there is no SMS gateway.
app.post('/api/otp/request', async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Invalid phone number.' });
    }

    const existing = await dbGet('SELECT last_sent_at FROM otp_codes WHERE phone_number = ?', [phone]);
    if (existing && Date.now() - existing.last_sent_at < OTP_RESEND_MS) {
      const wait = Math.ceil((OTP_RESEND_MS - (Date.now() - existing.last_sent_at)) / 1000);
      return res.status(429).json({ success: false, error: `Please wait ${wait}s before requesting another OTP.` });
    }

    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const now = Date.now();
    await dbRun(
      `INSERT INTO otp_codes (phone_number, otp_hash, expires_at, attempts, last_sent_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(phone_number) DO UPDATE SET
         otp_hash = excluded.otp_hash,
         expires_at = excluded.expires_at,
         attempts = 0,
         last_sent_at = excluded.last_sent_at`,
      [phone, sha256(`${phone}:${otp}`), now + OTP_TTL_MS, now]
    );

    console.log(`[OTP] ${phone} -> ${otp} (valid ${OTP_TTL_MS / 60000} min)`);
    const payload = { success: true };
    if (OTP_ECHO) payload.devOtp = otp;
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// Register (or update own profile) after OTP verification, then log in.
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const { phone, otp, name, designation, institute, pincode, state, district, po } = req.body;
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Invalid phone number.' });
    }
    if (!name) {
      return res.status(400).json({ success: false, error: 'Full name is required.' });
    }

    const check = await consumeOtp(phone, otp);
    if (!check.ok) return res.status(400).json({ success: false, error: check.error });

    // OTP proves control of this number, so upserting the caller's own
    // record is safe. Role is never set from the request body.
    await dbRun(
      `INSERT INTO users (phone_number, full_name, designation, institution, pincode, state, district, post_office, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DELEGATE')
       ON CONFLICT(phone_number) DO UPDATE SET
         full_name = excluded.full_name,
         designation = excluded.designation,
         institution = excluded.institution,
         pincode = excluded.pincode,
         state = excluded.state,
         district = excluded.district,
         post_office = excluded.post_office`,
      [phone, name, designation, institute, pincode, state, district, po]
    );

    const user = await dbGet('SELECT * FROM users WHERE phone_number = ?', [phone]);
    await startSession(phone, user.role, res);
    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
});

// Log in an existing user after OTP verification.
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Invalid phone number.' });
    }

    const check = await consumeOtp(phone, otp);
    if (!check.ok) return res.status(400).json({ success: false, error: check.error });

    const user = await dbGet('SELECT * FROM users WHERE phone_number = ?', [phone]);
    if (!user) return res.status(404).json({ success: false, error: 'Mobile number not registered.' });

    await startSession(phone, user.role, res);
    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
});

// Current session, for restoring state on page load.
app.get('/api/auth/me', requireAuth, async (req, res, next) => {
  try {
    const user = await dbGet('SELECT * FROM users WHERE phone_number = ?', [req.session.phone]);
    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
});

// Log out: destroy the session and clear the cookie.
app.post('/api/auth/logout', async (req, res, next) => {
  try {
    if (req.session) {
      await dbRun('DELETE FROM sessions WHERE token_hash = ?', [req.session.tokenHash]);
    }
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- DELEGATE ENDPOINTS -------------------------------------------------

// Submit / update the caller's own payment registration.
app.post('/api/registrations', requireAuth, async (req, res, next) => {
  try {
    const { categoryKey, workshopOptionId, qiOptionId, amount, utr, screenshot, acknowledged } = req.body;
    if (!utr || !screenshot) {
      return res.status(400).json({ success: false, error: 'Missing required registration details.' });
    }

    // Fee and label are derived server-side from the category; the client's
    // amount and label are not trusted.
    const tier = PRICING_TIERS[categoryKey];
    if (!tier) {
      return res.status(400).json({ success: false, error: 'Invalid delegate category.' });
    }
    const expectedAmount = tier[REGISTRATION_PHASE];
    const categoryLabel = tier.label;

    const phone = req.session.phone; // never from the client
    const name = req.session.name;

    // Existing registration: reuse the id to free the delegate's own slot on
    // re-submission, and the old filename for cleanup.
    const prev = await dbGet('SELECT id, screenshot FROM registrations WHERE phone_number = ?', [phone]);
    const ownRegId = prev ? prev.id : null;

    // Resolve the chosen workshop / QI practice and enforce capacity. Done
    // before OCR so a full option fails fast.
    const ws = await resolveOption(workshopOptionId, 'WORKSHOP', ownRegId);
    if (ws.error) return res.status(400).json({ success: false, error: ws.error });
    const qi = await resolveOption(qiOptionId, 'QI', ownRegId);
    if (qi.error) return res.status(400).json({ success: false, error: qi.error });

    // Validate the image (in memory; not written to disk yet).
    const decoded = decodeScreenshot(screenshot);
    if (decoded.error) {
      return res.status(400).json({ success: false, error: decoded.error });
    }

    // Read the screenshot and check amount / conference UPI ID / UTR against it.
    const checks = await runOcrChecks(decoded.buffer, { expectedAmount, utr });
    const allChecksPass = checks.amount && checks.vpa && checks.utr;

    // If any check failed and the delegate hasn't acknowledged the warning,
    // don't commit -- let the client warn and re-submit with acknowledged=true.
    if (!allChecksPass && !acknowledged) {
      return res.json({ success: false, needsConfirmation: true, checks, expectedAmount });
    }

    // What the delegate claims to have paid, for the finance audit trail.
    const claimedAmount = Number(amount);
    const amountTampered = !Number.isFinite(claimedAmount) || Math.round(claimedAmount) !== expectedAmount;
    const paidAmount = Number.isFinite(claimedAmount) ? claimedAmount : null;

    // Flag for manual scrutiny if any screenshot check failed or the claimed
    // amount was tampered with.
    const flagged = !allChecksPass || amountTampered ? 1 : 0;

    const filename = await writeScreenshotBuffer(decoded.buffer, decoded.ext);

    const result = await dbRun(
      `INSERT INTO registrations
        (phone_number, delegate_name, category_key, category_label, workshop, qi_exposure, workshop_option_id, qi_option_id, expected_amount, paid_amount, utr_number, screenshot, ocr_amount_match, ocr_vpa_match, ocr_utr_match, is_flagged, bank_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
        ON CONFLICT(phone_number) DO UPDATE SET
          delegate_name = excluded.delegate_name,
          category_key = excluded.category_key,
          category_label = excluded.category_label,
          workshop = excluded.workshop,
          qi_exposure = excluded.qi_exposure,
          workshop_option_id = excluded.workshop_option_id,
          qi_option_id = excluded.qi_option_id,
          expected_amount = excluded.expected_amount,
          paid_amount = excluded.paid_amount,
          utr_number = excluded.utr_number,
          screenshot = excluded.screenshot,
          ocr_amount_match = excluded.ocr_amount_match,
          ocr_vpa_match = excluded.ocr_vpa_match,
          ocr_utr_match = excluded.ocr_utr_match,
          is_flagged = excluded.is_flagged,
          bank_status = 'PENDING'`,
      [phone, name, categoryKey, categoryLabel, ws.opt.name, qi.opt.name, ws.opt.id, qi.opt.id,
        expectedAmount, paidAmount, utr, filename,
        checks.amount ? 1 : 0, checks.vpa ? 1 : 0, checks.utr ? 1 : 0, flagged]
    );

    if (prev && prev.screenshot && prev.screenshot !== filename) {
      await deleteScreenshotFile(prev.screenshot);
    }

    // Assign a stable, unique registration number on first submission. It is
    // derived from the row id (already unique) and never reassigned; the
    // client only reveals it once the payment is verified.
    await dbRun(
      `UPDATE registrations
          SET registration_number = 'NQOCN2026' || printf('%04d', id)
        WHERE phone_number = ? AND (registration_number IS NULL OR registration_number = '')`,
      [phone]
    );

    res.json({ success: true, id: result.lastID, expectedAmount, checks, flagged: !!flagged });
  } catch (err) {
    console.error('Database Insert Error:', err);
    res.status(500).json({ success: false, error: 'Database save failed.' });
  }
});

// Columns to expose for a registration -- everything except the raw
// screenshot filename, plus a boolean the client can use to build the link.
const REGISTRATION_PUBLIC_COLUMNS =
  `id, registration_number, phone_number, delegate_name, category_key, category_label, workshop,
   qi_exposure, expected_amount, paid_amount, utr_number, is_flagged, bank_status,
   ocr_amount_match, ocr_vpa_match, ocr_utr_match,
   (screenshot IS NOT NULL AND screenshot != '') AS has_screenshot`;

// Fetch the caller's own registration (replaces the old IDOR-prone
// /api/registrations/user/:phone route).
app.get('/api/registrations/me', requireAuth, async (req, res, next) => {
  try {
    const row = await dbGet(
      `SELECT ${REGISTRATION_PUBLIC_COLUMNS} FROM registrations WHERE phone_number = ?`,
      [req.session.phone]
    );
    res.json({ registration: row || null });
  } catch (err) {
    next(err);
  }
});

// Active program options with remaining capacity, for the payment form.
app.get('/api/program-options', requireAuth, async (req, res, next) => {
  try {
    const rows = await fetchProgramOptions({ activeOnly: true });
    const shape = (o) => {
      const remaining = Math.max(0, o.capacity - o.enrolled);
      return { id: o.id, name: o.name, capacity: o.capacity, remaining, full: remaining <= 0 };
    };
    res.json({
      workshops: rows.filter((o) => o.type === 'WORKSHOP').map(shape),
      qiPractices: rows.filter((o) => o.type === 'QI').map(shape),
    });
  } catch (err) {
    next(err);
  }
});

// Printable payment receipt for the caller's own registration. Only available
// once the payment has been verified.
app.get('/api/registrations/me/receipt', requireAuth, async (req, res, next) => {
  try {
    const reg = await dbGet('SELECT * FROM registrations WHERE phone_number = ?', [req.session.phone]);
    if (!reg) {
      return res.status(404).send('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;margin-top:4rem">No registration found.</body>');
    }
    if (reg.bank_status !== 'BANK_VERIFIED') {
      return res.status(403).send('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;margin-top:4rem"><h2>Receipt not available yet</h2><p>Your receipt will be available once the finance team verifies your payment.</p><p><a href="/">Return to portal</a></p></body>');
    }

    const user = await dbGet('SELECT * FROM users WHERE phone_number = ?', [req.session.phone]);
    const verifiedRow = await dbGet(
      `SELECT created_at FROM audit_log
        WHERE entity_type = 'registration' AND entity_id = ? AND new_value = 'BANK_VERIFIED'
        ORDER BY id DESC LIMIT 1`,
      [String(reg.id)]
    );
    const verifiedOn = verifiedRow
      ? new Date(verifiedRow.created_at).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' })
      : '—';

    const row = (label, value) =>
      `<tr><td class="k">${escapeHtml(label)}</td><td class="v">${escapeHtml(value)}</td></tr>`;

    res.set('Cache-Control', 'private, no-store');
    res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment Receipt — ${escapeHtml(reg.registration_number)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:#f1f5f9; margin:0; padding:2rem; color:#0f172a; }
  .receipt { max-width: 640px; margin: 0 auto; background:#fff; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden; box-shadow:0 10px 30px rgba(2,6,23,.08); }
  .head { background:#312e81; color:#fff; padding:1.75rem 2rem; }
  .head .tag { font-size:.7rem; letter-spacing:.12em; text-transform:uppercase; color:#c7d2fe; }
  .head h1 { font-size:1.15rem; margin:.35rem 0 0; line-height:1.3; }
  .head p { margin:.35rem 0 0; font-size:.8rem; color:#c7d2fe; }
  .body { padding:1.5rem 2rem 2rem; }
  .num { display:flex; justify-content:space-between; align-items:center; background:#eef2ff; border:1px solid #c7d2fe; border-radius:12px; padding:1rem 1.25rem; margin-bottom:1.5rem; }
  .num .label { font-size:.7rem; text-transform:uppercase; letter-spacing:.1em; color:#4338ca; font-weight:700; }
  .num .value { font-size:1.35rem; font-weight:800; font-family:ui-monospace, monospace; color:#312e81; }
  .status { display:inline-block; background:#dcfce7; color:#166534; font-size:.7rem; font-weight:800; padding:.25rem .65rem; border-radius:999px; text-transform:uppercase; letter-spacing:.06em; }
  table { width:100%; border-collapse:collapse; font-size:.9rem; }
  td { padding:.6rem 0; border-bottom:1px solid #f1f5f9; vertical-align:top; }
  td.k { color:#64748b; width:42%; }
  td.v { font-weight:600; text-align:right; }
  .foot { margin-top:1.5rem; font-size:.72rem; color:#94a3b8; text-align:center; line-height:1.5; }
  .actions { text-align:center; margin-top:1.5rem; }
  button { background:#4f46e5; color:#fff; border:0; border-radius:10px; padding:.65rem 1.5rem; font-size:.85rem; font-weight:700; cursor:pointer; }
  @media print { body { background:#fff; padding:0; } .receipt { box-shadow:none; border:none; } .actions { display:none; } }
</style></head>
<body>
  <div class="receipt">
    <div class="head">
      <div class="tag">NQOCN &amp; MGIMS Sevagram · Payment Receipt</div>
      <h1>5th International Conference on Healthcare Quality &amp; Patient Safety</h1>
      <p>21–22 November 2026 · MGIMS, Sevagram, Wardha</p>
    </div>
    <div class="body">
      <div class="num">
        <span class="label">Registration No.</span>
        <span class="value">${escapeHtml(reg.registration_number)}</span>
      </div>
      <table>
        ${row('Status', 'Confirmed — Payment Verified')}
        ${row('Delegate', reg.delegate_name)}
        ${row('Designation', user ? user.designation : '')}
        ${row('Institution', user ? user.institution : '')}
        ${row('Mobile', '+91 ' + reg.phone_number)}
        ${row('Category', reg.category_label)}
        ${row('Workshop', reg.workshop)}
        ${row('QI Exposure', reg.qi_exposure)}
        ${row('Amount Paid', '₹' + (reg.expected_amount != null ? reg.expected_amount : reg.paid_amount))}
        ${row('UTR / Txn Ref', reg.utr_number)}
        ${row('Verified On', verifiedOn)}
      </table>
      <div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
      <p class="foot">This is a computer-generated receipt for conference registration.<br>Registration number <b>${escapeHtml(reg.registration_number)}</b> — please quote it in all correspondence.</p>
    </div>
  </div>
</body></html>`);
  } catch (err) {
    next(err);
  }
});

// Serve a payment screenshot to the owning delegate or a finance admin.
app.get('/api/registrations/:id/screenshot', requireAuth, async (req, res, next) => {
  try {
    const row = await dbGet('SELECT phone_number, screenshot FROM registrations WHERE id = ?', [req.params.id]);
    if (!row || !row.screenshot) {
      return res.status(404).json({ success: false, error: 'Screenshot not found.' });
    }

    const isFinance = req.session.role === 'SUPER_ADMIN' || req.session.role === 'FINANCE_ADMIN';
    if (!isFinance && req.session.phone !== row.phone_number) {
      return res.status(403).json({ success: false, error: 'You do not have permission to view this screenshot.' });
    }

    res.set('Cache-Control', 'private, no-store');

    // Defensive fallback for any legacy base64 value that escaped migration.
    if (/^data:image\//i.test(row.screenshot)) {
      const m = /^data:(image\/[a-z]+);base64,(.*)$/i.exec(row.screenshot);
      if (!m) return res.status(404).json({ success: false, error: 'Screenshot not found.' });
      res.type(m[1]);
      return res.send(Buffer.from(m[2], 'base64'));
    }

    const safeName = path.basename(row.screenshot); // guard against traversal
    const ext = path.extname(safeName).slice(1).toLowerCase();
    if (EXT_MIME[ext]) res.type(EXT_MIME[ext]);
    res.sendFile(path.join(UPLOAD_DIR, safeName), (err) => {
      if (err && !res.headersSent) res.status(404).json({ success: false, error: 'Screenshot not found.' });
    });
  } catch (err) {
    next(err);
  }
});

// Submit an abstract under the caller's own identity.
app.post('/api/abstracts', requireAuth, async (req, res, next) => {
  try {
    const { format, title, text, wordCount } = req.body;
    await dbRun(
      'INSERT INTO abstracts (phone_number, author_name, format, title, text, word_count) VALUES (?, ?, ?, ?, ?, ?)',
      [req.session.phone, req.session.name, format, title, text, wordCount]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- ADMIN ENDPOINTS ----------------------------------------------------

// Finance reconciliation: view all registrations, each annotated with the
// most recent audit entry (who last changed its status, and when).
app.get('/api/registrations', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const rows = await dbAll(`
      SELECT ${REGISTRATION_PUBLIC_COLUMNS},
        (SELECT actor_name FROM audit_log a
           WHERE a.entity_type = 'registration' AND a.entity_id = CAST(registrations.id AS TEXT)
           ORDER BY a.id DESC LIMIT 1) AS last_action_by,
        (SELECT created_at FROM audit_log a
           WHERE a.entity_type = 'registration' AND a.entity_id = CAST(registrations.id AS TEXT)
           ORDER BY a.id DESC LIMIT 1) AS last_action_at
      FROM registrations ORDER BY id DESC`);
    res.json({ registrations: rows || [] });
  } catch (err) {
    next(err);
  }
});

// Finance reconciliation: update bank verification status (audited).
app.put('/api/registrations/:id/status', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const { bankStatus } = req.body;
    const allowed = ['PENDING', 'BANK_VERIFIED', 'REJECTED'];
    if (!allowed.includes(bankStatus)) {
      return res.status(400).json({ success: false, error: 'Invalid bank status.' });
    }

    const existing = await dbGet('SELECT bank_status FROM registrations WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Registration not found.' });
    }

    await dbRun('UPDATE registrations SET bank_status = ? WHERE id = ?', [bankStatus, req.params.id]);

    // Safety net: ensure a verified registration always has a number, even if
    // it was created before numbers were assigned at submission.
    if (bankStatus === 'BANK_VERIFIED') {
      await dbRun(
        `UPDATE registrations
            SET registration_number = 'NQOCN2026' || printf('%04d', id)
          WHERE id = ? AND (registration_number IS NULL OR registration_number = '')`,
        [req.params.id]
      );
    }

    await recordAudit({
      req,
      entityType: 'registration',
      entityId: req.params.id,
      action: 'BANK_STATUS_CHANGE',
      oldValue: existing.bank_status,
      newValue: bankStatus,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Full audit history for one registration.
app.get('/api/registrations/:id/audit', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const rows = await dbAll(
      `SELECT action, old_value, new_value, actor_name, actor_role, actor_phone, created_at
         FROM audit_log
        WHERE entity_type = 'registration' AND entity_id = ?
        ORDER BY id DESC`,
      [String(req.params.id)]
    );
    res.json({ audit: rows || [] });
  } catch (err) {
    next(err);
  }
});

// User administration (super admin only).
app.get('/api/users', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const rows = await dbAll('SELECT * FROM users');
    res.json({ users: rows || [] });
  } catch (err) {
    next(err);
  }
});

app.post('/api/users', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { name, phone, designation, institute, role } = req.body;
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Invalid phone number.' });
    }
    if (!ADMIN_ROLES.includes(role) && role !== 'DELEGATE') {
      return res.status(400).json({ success: false, error: 'Invalid role.' });
    }
    await dbRun(
      'INSERT INTO users (phone_number, full_name, designation, institution, role) VALUES (?, ?, ?, ?, ?)',
      [phone, name, designation, institute, role]
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ success: false, error: 'A user with that phone number already exists.' });
    }
    next(err);
  }
});

app.put('/api/users/:phone/role', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!ADMIN_ROLES.includes(role) && role !== 'DELEGATE') {
      return res.status(400).json({ success: false, error: 'Invalid role.' });
    }
    await dbRun('UPDATE users SET role = ? WHERE phone_number = ?', [role, req.params.phone]);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- PROGRAM OPTIONS ADMIN (workshops & QI practices) -------------------

function validProgramInput({ type, name, capacity }, { partial } = {}) {
  if (!partial || type !== undefined) {
    if (type !== 'WORKSHOP' && type !== 'QI') return 'Type must be WORKSHOP or QI.';
  }
  if (!partial || name !== undefined) {
    if (!name || !String(name).trim()) return 'Name is required.';
  }
  if (!partial || capacity !== undefined) {
    if (!Number.isInteger(capacity) || capacity < 0) return 'Capacity must be a non-negative integer.';
  }
  return null;
}

// List every option (active or not) with enrollment counts.
app.get('/api/admin/program-options', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    res.json({ options: await fetchProgramOptions({ activeOnly: false }) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/program-options', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { type, name, capacity } = req.body;
    const bad = validProgramInput({ type, name, capacity });
    if (bad) return res.status(400).json({ success: false, error: bad });
    const result = await dbRun(
      'INSERT INTO program_options (type, name, capacity, active, created_at) VALUES (?, ?, ?, 1, ?)',
      [type, String(name).trim(), capacity, Date.now()]
    );
    res.json({ success: true, id: result.lastID });
  } catch (err) {
    next(err);
  }
});

app.put('/api/admin/program-options/:id', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { name, capacity, active } = req.body;
    const bad = validProgramInput({ name, capacity }, { partial: true });
    if (bad) return res.status(400).json({ success: false, error: bad });

    const existing = await dbGet('SELECT * FROM program_options WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Option not found.' });

    await dbRun(
      'UPDATE program_options SET name = ?, capacity = ?, active = ? WHERE id = ?',
      [
        name !== undefined ? String(name).trim() : existing.name,
        capacity !== undefined ? capacity : existing.capacity,
        active !== undefined ? (active ? 1 : 0) : existing.active,
        req.params.id,
      ]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Delete an option, but only if nobody is enrolled (otherwise deactivate it).
app.delete('/api/admin/program-options/:id', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const opt = await dbGet('SELECT * FROM program_options WHERE id = ?', [req.params.id]);
    if (!opt) return res.status(404).json({ success: false, error: 'Option not found.' });

    const col = opt.type === 'WORKSHOP' ? 'workshop_option_id' : 'qi_option_id';
    const used = await dbGet(
      `SELECT COUNT(*) AS n FROM registrations WHERE ${col} = ? AND bank_status != 'REJECTED'`,
      [opt.id]
    );
    if (used.n > 0) {
      return res.status(409).json({ success: false, error: `Cannot delete: ${used.n} delegate(s) enrolled. Deactivate it instead.` });
    }
    await dbRun('DELETE FROM program_options WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Abstract review desk (super admin or academic reviewer). Each abstract is
// annotated with who last changed its status, and when.
app.get('/api/abstracts', requireRole('SUPER_ADMIN', 'ACADEMIC_REVIEWER'), async (req, res, next) => {
  try {
    const rows = await dbAll(`
      SELECT abstracts.*,
        (SELECT actor_name FROM audit_log a
           WHERE a.entity_type = 'abstract' AND a.entity_id = CAST(abstracts.id AS TEXT)
           ORDER BY a.id DESC LIMIT 1) AS last_action_by,
        (SELECT created_at FROM audit_log a
           WHERE a.entity_type = 'abstract' AND a.entity_id = CAST(abstracts.id AS TEXT)
           ORDER BY a.id DESC LIMIT 1) AS last_action_at
      FROM abstracts ORDER BY id DESC`);
    res.json({ abstracts: rows || [] });
  } catch (err) {
    next(err);
  }
});

app.put('/api/abstracts/:id/status', requireRole('SUPER_ADMIN', 'ACADEMIC_REVIEWER'), async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowed = ['UNDER_REVIEW', 'ACCEPTED', 'REJECTED'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid abstract status.' });
    }

    const existing = await dbGet('SELECT status FROM abstracts WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Abstract not found.' });
    }

    await dbRun('UPDATE abstracts SET status = ? WHERE id = ?', [status, req.params.id]);
    await recordAudit({
      req,
      entityType: 'abstract',
      entityId: req.params.id,
      action: 'ABSTRACT_STATUS_CHANGE',
      oldValue: existing.status,
      newValue: status,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- ERROR HANDLER ------------------------------------------------------
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ success: false, error: 'Upload too large. Payment screenshots must be under 5 MB.' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (OTP_ECHO) console.log('[dev] OTP echo is ON — codes are returned to the client and logged here.');
});
