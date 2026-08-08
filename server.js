const express = require('express');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

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

// --- CRYPTO / COOKIE HELPERS --------------------------------------------
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Constant-time comparison of two equal-length strings.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
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

  // Additive migration: record the server-computed fee separately from the
  // amount the delegate claims to have paid.
  db.all('PRAGMA table_info(registrations)', (err, cols) => {
    if (err) return console.error('Schema check failed:', err.message);
    if (!cols.some((c) => c.name === 'expected_amount')) {
      db.run('ALTER TABLE registrations ADD COLUMN expected_amount REAL');
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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
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
    const { categoryKey, workshop, qiExposure, amount, utr, screenshot, isFlagged } = req.body;
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

    // What the delegate claims to have paid, for the finance audit trail.
    const claimedAmount = Number(amount);
    const amountMismatch = !Number.isFinite(claimedAmount) || Math.round(claimedAmount) !== expectedAmount;

    const phone = req.session.phone; // never from the client
    const name = req.session.name;
    const flagged = isFlagged || amountMismatch ? 1 : 0;
    const paidAmount = Number.isFinite(claimedAmount) ? claimedAmount : null;

    const result = await dbRun(
      `INSERT INTO registrations
        (phone_number, delegate_name, category_key, category_label, workshop, qi_exposure, expected_amount, paid_amount, utr_number, screenshot, is_flagged, bank_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
        ON CONFLICT(phone_number) DO UPDATE SET
          delegate_name = excluded.delegate_name,
          category_key = excluded.category_key,
          category_label = excluded.category_label,
          workshop = excluded.workshop,
          qi_exposure = excluded.qi_exposure,
          expected_amount = excluded.expected_amount,
          paid_amount = excluded.paid_amount,
          utr_number = excluded.utr_number,
          screenshot = excluded.screenshot,
          is_flagged = excluded.is_flagged,
          bank_status = 'PENDING'`,
      [phone, name, categoryKey, categoryLabel, workshop, qiExposure, expectedAmount, paidAmount, utr, screenshot, flagged]
    );
    res.json({ success: true, id: result.lastID, expectedAmount, amountMismatch });
  } catch (err) {
    console.error('Database Insert Error:', err);
    res.status(500).json({ success: false, error: 'Database save failed.' });
  }
});

// Fetch the caller's own registration (replaces the old IDOR-prone
// /api/registrations/user/:phone route).
app.get('/api/registrations/me', requireAuth, async (req, res, next) => {
  try {
    const row = await dbGet('SELECT * FROM registrations WHERE phone_number = ?', [req.session.phone]);
    res.json({ registration: row || null });
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

// Finance reconciliation: view all registrations.
app.get('/api/registrations', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const rows = await dbAll('SELECT * FROM registrations ORDER BY id DESC');
    res.json({ registrations: rows || [] });
  } catch (err) {
    next(err);
  }
});

// Finance reconciliation: update bank verification status.
app.put('/api/registrations/:id/status', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const { bankStatus } = req.body;
    const allowed = ['PENDING', 'BANK_VERIFIED', 'REJECTED'];
    if (!allowed.includes(bankStatus)) {
      return res.status(400).json({ success: false, error: 'Invalid bank status.' });
    }
    await dbRun('UPDATE registrations SET bank_status = ? WHERE id = ?', [bankStatus, req.params.id]);
    res.json({ success: true });
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

// Abstract review desk (super admin or academic reviewer).
app.get('/api/abstracts', requireRole('SUPER_ADMIN', 'ACADEMIC_REVIEWER'), async (req, res, next) => {
  try {
    const rows = await dbAll('SELECT * FROM abstracts ORDER BY id DESC');
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
    await dbRun('UPDATE abstracts SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- ERROR HANDLER ------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (OTP_ECHO) console.log('[dev] OTP echo is ON — codes are returned to the client and logged here.');
});
