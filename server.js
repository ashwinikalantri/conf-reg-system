require('dotenv').config(); // load .env before any process.env is read

// Node 16 exposes node:crypto as globalThis.crypto, which lacks the Web Crypto
// getRandomValues that the AWS SDK v3 (SES) requires. Install the real Web
// Crypto implementation so email sending works (Node 20+ does this natively).
const { webcrypto } = require('crypto');
if (typeof (globalThis.crypto && globalThis.crypto.getRandomValues) !== 'function') {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
}

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { createWorker } = require('tesseract.js');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
// Node 16 has no global fetch; node-fetch (v2, CommonJS) provides it for SMS.
const fetch = require('node-fetch');

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

const CONFERENCE_NAME = 'International Conference on Healthcare Quality & Patient Safety 2026';

// --- SMS (Vynttra) ------------------------------------------------------
// Only the API key is a secret; the DLT sender/entity/template/header IDs are
// registration identifiers and default to the NQOCN values, overridable by env.
const SMS = {
  apiKey: process.env.SMS_API_KEY || '',
  url: process.env.SMS_URL || 'https://api.vynttra.in/index.php/sms/json',
  sender: process.env.SMS_SENDER || 'KHSBDC',
  entityId: process.env.SMS_ENTITY_ID || '1201160068107545972',
  templateId: process.env.SMS_TEMPLATE_ID || '1077505970001758294',
  headerId: process.env.SMS_HEADER_ID || '1005654540639709445',
  type: process.env.SMS_TYPE || 'UNI',
};
const SMS_ENABLED = !!SMS.apiKey;

// Send the registration OTP over SMS using the registered DLT template.
// Fire-and-forget: failures are logged, never block OTP issuance.
async function sendOtpSms(phone, otp) {
  if (!SMS_ENABLED) return;
  const text = `Dear Delegate, Thank you for registering for the NQOCN Conference. Your OTP for registration verification is ${otp} NQOCN Conference MGIMS`;
  try {
    const res = await fetch(SMS.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SMS.apiKey },
      body: JSON.stringify({
        sender: SMS.sender,
        message: [{ number: `91${phone}`, text }],
        messagetype: SMS.type,
        dltentityid: SMS.entityId,
        dlttempid: SMS.templateId,
        dltheaderid: SMS.headerId,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.code !== 200) {
      console.error(`SMS to ${phone} not accepted (HTTP ${res.status}):`, JSON.stringify(data));
    } else {
      const id = data.data && data.data[0] && data.data[0].uniqueid;
      console.log(`SMS to ${phone} accepted by gateway${id ? ` (uniqueid ${id})` : ''}`);
    }
  } catch (err) {
    console.error(`SMS to ${phone} failed:`, err.message);
  }
}

// --- EMAIL (AWS SES v2 SDK) ---------------------------------------------
// Uses IAM credentials + region from the environment (AWS_ACCESS_KEY_ID,
// AWS_SECRET_ACCESS_KEY, AWS_REGION). SES_FROM must be a verified sender.
// Dormant until credentials, region, and a From address are all present.
const EMAIL_FROM = (process.env.SES_FROM || '').trim();
const EMAIL_ENABLED = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_REGION && EMAIL_FROM);
const sesClient = EMAIL_ENABLED ? new SESv2Client({ region: process.env.AWS_REGION }) : null;

// Send an email if configured; never throws (notifications are best-effort).
async function sendEmail(to, subject, html) {
  if (!EMAIL_ENABLED || !to) return;
  try {
    await sesClient.send(new SendEmailCommand({
      FromEmailAddress: EMAIL_FROM,
      Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Html: { Data: html, Charset: 'UTF-8' } } } },
    }));
  } catch (err) {
    console.error(`Email to ${to} failed:`, err.message);
  }
}

// Look up a delegate's email and fire a notification (best-effort, async).
async function notifyDelegate(phone, subject, html) {
  const u = await dbGet('SELECT email FROM users WHERE phone_number = ?', [phone]).catch(() => null);
  if (u && u.email) sendEmail(u.email, subject, html);
}

const emailWrap = (title, bodyHtml) =>
  `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
     <div style="background:#312e81;color:#fff;padding:1.25rem 1.5rem;border-radius:12px 12px 0 0">
       <div style="font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:#c7d2fe">NQOCN &amp; MGIMS Sevagram</div>
       <h1 style="font-size:1.05rem;margin:.35rem 0 0">${escapeHtml(CONFERENCE_NAME)}</h1>
     </div>
     <div style="border:1px solid #e2e8f0;border-top:0;border-radius:0 0 12px 12px;padding:1.5rem">
       <h2 style="font-size:1rem;margin:0 0 .75rem">${escapeHtml(title)}</h2>
       ${bodyHtml}
       <p style="color:#94a3b8;font-size:.72rem;margin-top:1.5rem">This is an automated message from the conference registration portal.</p>
     </div>
   </div>`;

// Fees are stored in the admin-editable fee_categories master and resolved at
// today's pricing phase (see resolveFee); nothing is taken from the request body.

// The conference's own UPI ID (VPA). A payment screenshot should show this as
// the payee; OCR checks the uploaded image against it.
const OFFICIAL_UPI_ID = process.env.OFFICIAL_UPI_ID || 'abhishekraut@cbin';

// Categories that must upload a student ID card, with the discipline and level
// the card is expected to show. OCR does a preliminary check against these.
const STUDENT_CATEGORIES = {
  nursing_ug:  { discipline: 'nursing', level: 'UG', label: 'Nursing UG' },
  nursing_pg:  { discipline: 'nursing', level: 'PG', label: 'Nursing PG' },
  med_student: { discipline: 'medical', level: 'UG', label: 'Medical UG' },
  pg_doctor:   { discipline: 'medical', level: 'PG', label: 'Medical PG / Resident' },
};

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

// Decode a `data:application/pdf;base64,...` URI, validating type, PDF magic
// bytes, and size. Returns { buffer, ext } or { error }.
function decodePdf(dataUri) {
  const m = /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/i.exec(dataUri || '');
  if (!m) return { error: 'A valid PDF file is required.' };

  const buffer = Buffer.from(m[1], 'base64');
  if (buffer.length === 0) return { error: 'The uploaded PDF is empty.' };
  if (buffer.length > MAX_IMAGE_BYTES) return { error: 'PDF exceeds the 5 MB limit.' };
  if (buffer.slice(0, 5).toString('latin1') !== '%PDF-') return { error: 'The uploaded file is not a valid PDF.' };
  return { buffer, ext: 'pdf' };
}

// Write a validated upload buffer to the upload dir; returns the filename.
async function writeUploadBuffer(buffer, ext) {
  const filename = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), buffer);
  return filename;
}
const writeScreenshotBuffer = writeUploadBuffer; // back-compat alias

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

// Roughly detect discipline and level from an ID card's OCR text. Deliberately
// permissive keyword matching -- this is a preliminary, advisory check.
function detectIdAttributes(text) {
  const t = text.toLowerCase();
  let discipline = null;
  if (/nursing|g\.?n\.?m|a\.?n\.?m/.test(t)) discipline = 'nursing';
  else if (/mbbs|m\.?b\.?b\.?s|medic|medicine|surgery|\bmd\b|\bms\b/.test(t)) discipline = 'medical';

  let level = null;
  if (/post[-\s]?grad|\bpg\b|m\.?sc|\bmd\b|\bms\b|resident|master|\bdnb\b/.test(t)) level = 'PG';
  else if (/under[-\s]?grad|\bug\b|b\.?sc|mbbs|bachelor|(1st|2nd|3rd|first|second|third|final)\s+year/.test(t)) level = 'UG';

  return { discipline, level };
}

// OCR a student ID card and check it against the claimed category. Advisory:
// an unreadable or ambiguous card yields false (flagged), never an error.
async function runIdCardCheck(buffer, categoryKey) {
  const expect = STUDENT_CATEGORIES[categoryKey];
  if (!expect) return null; // category does not require an ID card
  let text = '';
  try {
    const worker = await getOcrWorker();
    const result = await Promise.race([
      worker.recognize(buffer),
      new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timed out')), 15000)),
    ]);
    text = (result && result.data && result.data.text) || '';
  } catch (err) {
    console.error('ID OCR failed:', err.message);
    ocrWorkerPromise = null;
    return false;
  }
  const { discipline, level } = detectIdAttributes(text);
  return discipline === expect.discipline && level === expect.level;
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

// Which pricing phase is in effect today, from the configured cutoff dates.
function currentPhase(config, today = new Date()) {
  const d = today.toISOString().slice(0, 10); // YYYY-MM-DD
  if (config && config.early_until && d <= config.early_until) return 'early';
  if (config && config.regular_until && d <= config.regular_until) return 'regular';
  return 'late';
}

function getFeeConfig() {
  return dbGet('SELECT early_until, regular_until FROM fee_config WHERE id = 1');
}

// Resolve the authoritative fee and label for a category at today's phase.
async function resolveFee(categoryKey) {
  const cat = await dbGet('SELECT * FROM fee_categories WHERE category_key = ? AND active = 1', [categoryKey]);
  if (!cat) return null;
  const phase = currentPhase(await getFeeConfig());
  const fee = { early: cat.early_fee, regular: cat.regular_fee, late: cat.late_fee }[phase];
  return { amount: fee, label: cat.label, phase };
}

// Assign (once) and return a delegate's registration number, drawn from a
// monotonic sequence at signup so it exists before any payment.
async function assignUserRegNumber(phone) {
  const u = await dbGet('SELECT registration_number FROM users WHERE phone_number = ?', [phone]);
  if (u && u.registration_number) return u.registration_number;
  const seq = await dbRun('INSERT INTO reg_seq DEFAULT VALUES');
  const number = 'NQOCN2026' + String(seq.lastID).padStart(4, '0');
  await dbRun(
    "UPDATE users SET registration_number = ? WHERE phone_number = ? AND (registration_number IS NULL OR registration_number = '')",
    [number, phone]
  );
  const after = await dbGet('SELECT registration_number FROM users WHERE phone_number = ?', [phone]);
  return after ? after.registration_number : number;
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

  // Additive user columns: age, gender, email, and the registration number
  // assigned at signup. Queued unconditionally (the no-op callback swallows the
  // "duplicate column" error on later runs) so they exist before the backfill.
  ['ALTER TABLE users ADD COLUMN age INTEGER',
   'ALTER TABLE users ADD COLUMN gender TEXT',
   'ALTER TABLE users ADD COLUMN email TEXT',
   'ALTER TABLE users ADD COLUMN registration_number TEXT',
  ].forEach((sql) => db.run(sql, () => {}));

  // Monotonic source for registration numbers. Reserved to start at 1001 so
  // new numbers never collide with older registration-id-derived ones.
  db.run('CREATE TABLE IF NOT EXISTS reg_seq (id INTEGER PRIMARY KEY AUTOINCREMENT)');
  db.run('INSERT OR IGNORE INTO reg_seq (id) VALUES (1000)');

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

  // Additive migration for databases created before the review workflow and
  // before PDF uploads (abstract_file holds the stored PDF filename).
  db.all('PRAGMA table_info(abstracts)', async (err, cols) => {
    if (err) return console.error('Schema check failed:', err.message);
    const names = cols.map((c) => c.name);
    if (!names.includes('status')) db.run("ALTER TABLE abstracts ADD COLUMN status TEXT DEFAULT 'UNDER_REVIEW'");
    if (!names.includes('abstract_file')) db.run('ALTER TABLE abstracts ADD COLUMN abstract_file TEXT');
    if (!names.includes('allocation')) db.run('ALTER TABLE abstracts ADD COLUMN allocation TEXT'); // ORAL | POSTER

    // Enforce one abstract per author: drop duplicates (keep the latest) BEFORE
    // creating the unique index. Sequenced so the index can't fail on dupes.
    try {
      await dbRun('DELETE FROM abstracts WHERE id NOT IN (SELECT MAX(id) FROM abstracts GROUP BY phone_number)');
      await dbRun('CREATE UNIQUE INDEX IF NOT EXISTS idx_abstracts_phone ON abstracts(phone_number)');
    } catch (e) {
      console.error('Abstract unique-index migration failed:', e.message);
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

  // Fee master: per-category fees for each pricing phase, plus the global
  // early/regular cutoff dates. Admin-editable.
  db.run(`
    CREATE TABLE IF NOT EXISTS fee_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_key TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      early_fee REAL NOT NULL DEFAULT 0,
      regular_fee REAL NOT NULL DEFAULT 0,
      late_fee REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS fee_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      early_until TEXT,
      regular_until TEXT
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
    if (!names.includes('id_card')) db.run('ALTER TABLE registrations ADD COLUMN id_card TEXT');
    if (!names.includes('ocr_id_match')) db.run('ALTER TABLE registrations ADD COLUMN ocr_id_match INTEGER');
    if (!names.includes('rejection_reason')) db.run('ALTER TABLE registrations ADD COLUMN rejection_reason TEXT');
    if (!names.includes('rejection_note')) db.run('ALTER TABLE registrations ADD COLUMN rejection_note TEXT');

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
      'Midwifery-led Care Units',
      'Quality Improvement for Child Development',
      'Quality Improvement for Community Health',
      'Student Parliament for Quality Improvement',
    ].forEach((name) => stmt.run('QI', name, 50, now));
    stmt.finalize();
    console.log('Seeded default workshop and QI practice options.');
  });

  // Seed the fee master on first run from the original hardcoded tiers.
  db.get('SELECT COUNT(*) AS n FROM fee_categories', (err, r) => {
    if (err || (r && r.n > 0)) return;
    const stmt = db.prepare('INSERT INTO fee_categories (category_key, label, early_fee, regular_fee, late_fee, active, sort_order) VALUES (?, ?, ?, ?, ?, 1, ?)');
    const seed = [
      ['nursing_ug', 'Nursing Student UG', 500, 1000, 2000],
      ['nursing_pg', 'Nursing Student PG', 750, 1500, 2500],
      ['med_student', 'Medical Student UG', 1500, 2200, 3000],
      ['nurse_cho', 'Nurse / Paramedical / CHO', 2000, 2800, 3500],
      ['pg_doctor', 'PG Student / Resident Doctor', 3000, 4000, 5000],
      ['faculty_mo', 'Doctors / Faculty / NHM MO', 3000, 4000, 5000],
      ['chw', 'Frontline CHWs (ASHA/ANM/AWW)', 200, 200, 200],
    ];
    seed.forEach((s, i) => stmt.run(s[0], s[1], s[2], s[3], s[4], i));
    stmt.finalize();
    console.log('Seeded default fee categories.');
  });
  db.run("INSERT OR IGNORE INTO fee_config (id, early_until, regular_until) VALUES (1, '2026-09-30', '2026-10-31')");
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

// One-time backfill: give every existing user a registration number (reusing
// their registration's number if it has one), then sync registrations to it.
db.serialize(() => {
  db.all(
    `SELECT phone_number,
       (SELECT registration_number FROM registrations r WHERE r.phone_number = users.phone_number) AS reg_num
     FROM users WHERE registration_number IS NULL OR registration_number = ''`,
    async (err, rows) => {
      if (err) return console.error('Reg-number backfill failed:', err.message);
      for (const row of rows) {
        let number = row.reg_num;
        if (!number) {
          const seq = await dbRun('INSERT INTO reg_seq DEFAULT VALUES');
          number = 'NQOCN2026' + String(seq.lastID).padStart(4, '0');
        }
        await dbRun('UPDATE users SET registration_number = ? WHERE phone_number = ?', [number, row.phone_number]);
      }
      await dbRun(
        `UPDATE registrations SET registration_number =
           (SELECT registration_number FROM users u WHERE u.phone_number = registrations.phone_number)
         WHERE EXISTS (SELECT 1 FROM users u WHERE u.phone_number = registrations.phone_number AND u.registration_number IS NOT NULL)`
      );
    }
  );
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
    if (SMS_ENABLED) sendOtpSms(phone, otp); // fire-and-forget; logs on failure

    const payload = { success: true, smsSent: SMS_ENABLED };
    // Never echo the OTP once SMS delivery is configured.
    if (OTP_ECHO && !SMS_ENABLED) payload.devOtp = otp;
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// Register (or update own profile) after OTP verification, then log in.
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const { phone, otp, name, designation, institute, pincode, state, district, age, gender, email } = req.body;
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Invalid phone number.' });
    }
    if (!name) {
      return res.status(400).json({ success: false, error: 'Full name is required.' });
    }
    const ageNum = age === '' || age == null ? null : parseInt(age, 10);
    if (ageNum != null && (!Number.isInteger(ageNum) || ageNum < 1 || ageNum > 120)) {
      return res.status(400).json({ success: false, error: 'Please enter a valid age.' });
    }
    const genderVal = ['Male', 'Female', 'Other'].includes(gender) ? gender : null;
    const emailVal = email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim()) ? String(email).trim() : null;
    if (email && !emailVal) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }

    const check = await consumeOtp(phone, otp);
    if (!check.ok) return res.status(400).json({ success: false, error: check.error });

    // OTP proves control of this number, so upserting the caller's own
    // record is safe. Role is never set from the request body.
    await dbRun(
      `INSERT INTO users (phone_number, full_name, designation, institution, pincode, state, district, age, gender, email, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DELEGATE')
       ON CONFLICT(phone_number) DO UPDATE SET
         full_name = excluded.full_name,
         designation = excluded.designation,
         institution = excluded.institution,
         pincode = excluded.pincode,
         state = excluded.state,
         district = excluded.district,
         age = excluded.age,
         gender = excluded.gender,
         email = excluded.email`,
      [phone, name, designation, institute, pincode, state, district, ageNum, genderVal, emailVal]
    );

    await assignUserRegNumber(phone); // ensure a registration number exists
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

    // If the number isn't registered, tell the client to switch to sign-up.
    // Done before consuming the OTP so the same code remains valid there.
    const user = await dbGet('SELECT * FROM users WHERE phone_number = ?', [phone]);
    if (!user) return res.json({ success: false, notRegistered: true });

    const check = await consumeOtp(phone, otp);
    if (!check.ok) return res.status(400).json({ success: false, error: check.error });

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
    const { categoryKey, workshopOptionId, qiOptionId, amount, utr, screenshot, idCard, acknowledged } = req.body;
    if (!utr || !screenshot) {
      return res.status(400).json({ success: false, error: 'Missing required registration details.' });
    }

    // Fee and label are derived server-side from the fee master at today's
    // pricing phase; the client's amount and label are not trusted.
    const feeInfo = await resolveFee(categoryKey);
    if (!feeInfo) {
      return res.status(400).json({ success: false, error: 'Invalid delegate category.' });
    }
    const expectedAmount = feeInfo.amount;
    const categoryLabel = feeInfo.label;

    const phone = req.session.phone; // never from the client
    const name = req.session.name;

    // Existing registration: reuse the id to free the delegate's own slot on
    // re-submission, and the old filenames for cleanup.
    const prev = await dbGet('SELECT id, screenshot, id_card FROM registrations WHERE phone_number = ?', [phone]);
    const ownRegId = prev ? prev.id : null;

    // Workshop and QI practice are optional. When chosen, validate the option
    // and enforce capacity (before OCR so a full option fails fast); when left
    // blank, record no selection.
    let ws = { opt: null };
    if (workshopOptionId) {
      ws = await resolveOption(workshopOptionId, 'WORKSHOP', ownRegId);
      if (ws.error) return res.status(400).json({ success: false, error: ws.error });
    }
    let qi = { opt: null };
    if (qiOptionId) {
      qi = await resolveOption(qiOptionId, 'QI', ownRegId);
      if (qi.error) return res.status(400).json({ success: false, error: qi.error });
    }

    // Validate the payment screenshot (in memory; not written to disk yet).
    const decoded = decodeScreenshot(screenshot);
    if (decoded.error) {
      return res.status(400).json({ success: false, error: decoded.error });
    }

    // Student categories must upload an ID card, checked against the category.
    const needsId = !!STUDENT_CATEGORIES[categoryKey];
    let idDecoded = null;
    if (needsId) {
      if (!idCard) {
        return res.status(400).json({ success: false, error: 'A student ID card is required for this category.' });
      }
      idDecoded = decodeScreenshot(idCard);
      if (idDecoded.error) {
        return res.status(400).json({ success: false, error: `ID card: ${idDecoded.error}` });
      }
    }

    // Read the screenshot (amount / UPI ID / UTR) and, for students, the ID card.
    const checks = await runOcrChecks(decoded.buffer, { expectedAmount, utr });
    if (needsId) checks.id = await runIdCardCheck(idDecoded.buffer, categoryKey);
    const allChecksPass = checks.amount && checks.vpa && checks.utr && (!needsId || checks.id);

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
    const idFilename = idDecoded ? await writeUploadBuffer(idDecoded.buffer, idDecoded.ext) : null;
    const idMatch = needsId ? (checks.id ? 1 : 0) : null;

    const result = await dbRun(
      `INSERT INTO registrations
        (phone_number, delegate_name, category_key, category_label, workshop, qi_exposure, workshop_option_id, qi_option_id, expected_amount, paid_amount, utr_number, screenshot, id_card, ocr_amount_match, ocr_vpa_match, ocr_utr_match, ocr_id_match, is_flagged, bank_status, rejection_reason, rejection_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL)
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
          id_card = excluded.id_card,
          ocr_amount_match = excluded.ocr_amount_match,
          ocr_vpa_match = excluded.ocr_vpa_match,
          ocr_utr_match = excluded.ocr_utr_match,
          ocr_id_match = excluded.ocr_id_match,
          is_flagged = excluded.is_flagged,
          bank_status = 'PENDING',
          rejection_reason = NULL,
          rejection_note = NULL`,
      [phone, name, categoryKey, categoryLabel, ws.opt ? ws.opt.name : null, qi.opt ? qi.opt.name : null, ws.opt ? ws.opt.id : null, qi.opt ? qi.opt.id : null,
        expectedAmount, paidAmount, utr, filename, idFilename,
        checks.amount ? 1 : 0, checks.vpa ? 1 : 0, checks.utr ? 1 : 0, idMatch, flagged]
    );

    if (prev && prev.screenshot && prev.screenshot !== filename) {
      await deleteScreenshotFile(prev.screenshot);
    }
    if (prev && prev.id_card && prev.id_card !== idFilename) {
      await deleteScreenshotFile(prev.id_card);
    }

    // Stamp the registration with the delegate's signup-assigned number.
    const regNo = await assignUserRegNumber(phone);
    await dbRun('UPDATE registrations SET registration_number = ? WHERE phone_number = ?', [regNo, phone]);

    // Acknowledge the payment; registration is confirmed later on verification.
    notifyDelegate(phone, 'Payment received — verification pending',
      emailWrap('We’ve received your payment details',
        `<p>Dear ${escapeHtml(name)},</p>
         <p>Thank you for submitting your payment for the ${escapeHtml(CONFERENCE_NAME)}.</p>
         <p>Your payment reference (<b>UTR ${escapeHtml(utr)}</b>) has been received and is now <b>pending verification</b> by our team.</p>
         <p>Registration number: <b>${escapeHtml(regNo)}</b></p>
         <p>Your registration will be <b>confirmed once your payment is verified</b> — you’ll receive a confirmation email at that point. No further action is needed for now.</p>`));

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
   ocr_amount_match, ocr_vpa_match, ocr_utr_match, ocr_id_match, rejection_reason, rejection_note,
   (screenshot IS NOT NULL AND screenshot != '') AS has_screenshot,
   (id_card IS NOT NULL AND id_card != '') AS has_id_card`;

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

// Active fee categories with the fee at today's phase, for the payment form.
app.get('/api/fees', requireAuth, async (req, res, next) => {
  try {
    const config = await getFeeConfig();
    const phase = currentPhase(config);
    const cats = await dbAll('SELECT category_key, label, early_fee, regular_fee, late_fee FROM fee_categories WHERE active = 1 ORDER BY sort_order, id');
    res.json({
      phase,
      earlyUntil: config ? config.early_until : null,
      regularUntil: config ? config.regular_until : null,
      categories: cats.map((c) => ({
        key: c.category_key,
        label: c.label,
        fee: { early: c.early_fee, regular: c.regular_fee, late: c.late_fee }[phase],
      })),
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
      <h1>${escapeHtml(CONFERENCE_NAME)}</h1>
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

// Serve an uploaded student ID card to the owning delegate or a finance admin.
app.get('/api/registrations/:id/id-card', requireAuth, async (req, res, next) => {
  try {
    const row = await dbGet('SELECT phone_number, id_card FROM registrations WHERE id = ?', [req.params.id]);
    if (!row || !row.id_card) {
      return res.status(404).json({ success: false, error: 'ID card not found.' });
    }
    const isFinance = req.session.role === 'SUPER_ADMIN' || req.session.role === 'FINANCE_ADMIN';
    if (!isFinance && req.session.phone !== row.phone_number) {
      return res.status(403).json({ success: false, error: 'You do not have permission to view this ID card.' });
    }
    res.set('Cache-Control', 'private, no-store');
    const safeName = path.basename(row.id_card);
    const ext = path.extname(safeName).slice(1).toLowerCase();
    if (EXT_MIME[ext]) res.type(EXT_MIME[ext]);
    res.sendFile(path.join(UPLOAD_DIR, safeName), (err) => {
      if (err && !res.headersSent) res.status(404).json({ success: false, error: 'ID card not found.' });
    });
  } catch (err) {
    next(err);
  }
});

// Submit an abstract under the caller's own identity.
const ABSTRACT_FORMATS = ['Oral Paper', 'Poster Presentation'];

app.post('/api/abstracts', requireAuth, async (req, res, next) => {
  try {
    const { format, title, pdf } = req.body;
    if (!title || !String(title).trim()) {
      return res.status(400).json({ success: false, error: 'Abstract title is required.' });
    }
    if (!ABSTRACT_FORMATS.includes(format)) {
      return res.status(400).json({ success: false, error: 'Please choose a valid presentation format.' });
    }
    const decoded = decodePdf(pdf);
    if (decoded.error) {
      return res.status(400).json({ success: false, error: decoded.error });
    }

    // One abstract per author, and it is locked once submitted.
    const prev = await dbGet('SELECT id FROM abstracts WHERE phone_number = ?', [req.session.phone]);
    if (prev) {
      return res.status(409).json({ success: false, error: 'You have already submitted an abstract; it cannot be changed.' });
    }

    const filename = await writeUploadBuffer(decoded.buffer, decoded.ext);
    const cleanTitle = String(title).trim();
    await dbRun(
      "INSERT INTO abstracts (phone_number, author_name, format, title, abstract_file, status) VALUES (?, ?, ?, ?, ?, 'UNDER_REVIEW')",
      [req.session.phone, req.session.name, format, cleanTitle, filename]
    );

    // Acknowledge receipt; acceptance is communicated after committee review.
    notifyDelegate(req.session.phone, 'Abstract received — under review',
      emailWrap('We’ve received your abstract',
        `<p>Dear ${escapeHtml(req.session.name)},</p>
         <p>Thank you for submitting your abstract, <b>"${escapeHtml(cleanTitle)}"</b>, for the ${escapeHtml(CONFERENCE_NAME)}.</p>
         <p>Your submission has been received and is now <b>under review</b> by the scientific committee.</p>
         <p>You’ll be notified by email once a decision has been made. No further action is needed for now.</p>`));

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// The caller's own abstract (for the dashboard status), or null.
app.get('/api/abstracts/me', requireAuth, async (req, res, next) => {
  try {
    const row = await dbGet(
      'SELECT id, format, title, status, allocation FROM abstracts WHERE phone_number = ?',
      [req.session.phone]
    );
    res.json({ abstract: row || null });
  } catch (err) {
    next(err);
  }
});

// Serve an abstract PDF to a reviewer/super admin or the submitting author.
app.get('/api/abstracts/:id/file', requireAuth, async (req, res, next) => {
  try {
    const row = await dbGet('SELECT phone_number, abstract_file FROM abstracts WHERE id = ?', [req.params.id]);
    if (!row || !row.abstract_file) {
      return res.status(404).json({ success: false, error: 'Abstract file not found.' });
    }
    const isReviewer = req.session.role === 'SUPER_ADMIN' || req.session.role === 'ACADEMIC_REVIEWER';
    if (!isReviewer && req.session.phone !== row.phone_number) {
      return res.status(403).json({ success: false, error: 'You do not have permission to view this abstract.' });
    }
    res.set('Cache-Control', 'private, no-store');
    res.type('application/pdf');
    res.sendFile(path.join(UPLOAD_DIR, path.basename(row.abstract_file)), (err) => {
      if (err && !res.headersSent) res.status(404).json({ success: false, error: 'Abstract file not found.' });
    });
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
    const { bankStatus, rejectionReason, rejectionNote } = req.body;
    const allowed = ['PENDING', 'BANK_VERIFIED', 'REJECTED'];
    if (!allowed.includes(bankStatus)) {
      return res.status(400).json({ success: false, error: 'Invalid bank status.' });
    }

    // A rejection must state why, so the delegate gets the right next step.
    const REJECTION_REASONS = ['PAYMENT', 'ID', 'OTHER'];
    let reason = null;
    let note = null;
    if (bankStatus === 'REJECTED') {
      if (!REJECTION_REASONS.includes(rejectionReason)) {
        return res.status(400).json({ success: false, error: 'A rejection reason is required (payment, ID, or other).' });
      }
      reason = rejectionReason;
      note = rejectionNote ? String(rejectionNote).slice(0, 500) : null;
      if (reason === 'OTHER' && !note) {
        return res.status(400).json({ success: false, error: 'Please describe the reason for an "Other" rejection.' });
      }
    }

    const existing = await dbGet('SELECT bank_status FROM registrations WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Registration not found.' });
    }

    await dbRun(
      'UPDATE registrations SET bank_status = ?, rejection_reason = ?, rejection_note = ? WHERE id = ?',
      [bankStatus, reason, note, req.params.id]
    );

    await recordAudit({
      req,
      entityType: 'registration',
      entityId: req.params.id,
      action: 'BANK_STATUS_CHANGE',
      oldValue: existing.bank_status,
      newValue: bankStatus === 'REJECTED' ? `REJECTED (${reason})` : bankStatus,
    });

    // Email the delegate about the outcome (best-effort).
    if (bankStatus !== existing.bank_status) {
      const reg = await dbGet('SELECT phone_number, delegate_name, registration_number FROM registrations WHERE id = ?', [req.params.id]);
      if (reg && bankStatus === 'BANK_VERIFIED') {
        notifyDelegate(reg.phone_number, 'Registration Confirmed',
          emailWrap('Your registration is confirmed',
            `<p>Dear ${escapeHtml(reg.delegate_name)},</p>
             <p>Your payment has been verified and your registration is <b>confirmed</b>.</p>
             <p>Registration number: <b>${escapeHtml(reg.registration_number)}</b></p>
             <p>You can download your receipt from the delegate portal.</p>`));
      } else if (reg && bankStatus === 'REJECTED') {
        const reasonText = { PAYMENT: 'a payment discrepancy', ID: 'an ID verification issue', OTHER: 'the reason noted below' }[reason] || 'a discrepancy';
        notifyDelegate(reg.phone_number, 'Action needed on your registration',
          emailWrap('Your registration needs attention',
            `<p>Dear ${escapeHtml(reg.delegate_name)},</p>
             <p>Your registration could not be verified due to ${escapeHtml(reasonText)}${note ? `: <i>${escapeHtml(note)}</i>` : ''}.</p>
             <p>Please log in to the delegate portal to review and resubmit.</p>`));
      }
    }
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

// --- FEE MASTER ADMIN ---------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const feeFields = (b) => ({
  early: Number(b.earlyFee), regular: Number(b.regularFee), late: Number(b.lateFee),
});

app.get('/api/admin/fees', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const config = await getFeeConfig();
    const categories = await dbAll('SELECT * FROM fee_categories ORDER BY sort_order, id');
    res.json({ config: config || {}, phase: currentPhase(config), categories });
  } catch (err) {
    next(err);
  }
});

app.put('/api/admin/fees/config', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { earlyUntil, regularUntil } = req.body;
    if ((earlyUntil && !DATE_RE.test(earlyUntil)) || (regularUntil && !DATE_RE.test(regularUntil))) {
      return res.status(400).json({ success: false, error: 'Dates must be YYYY-MM-DD.' });
    }
    if (earlyUntil && regularUntil && earlyUntil > regularUntil) {
      return res.status(400).json({ success: false, error: 'Early cutoff must be on or before the regular cutoff.' });
    }
    await dbRun('UPDATE fee_config SET early_until = ?, regular_until = ? WHERE id = 1', [earlyUntil || null, regularUntil || null]);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/fees/categories', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { categoryKey, label } = req.body;
    const f = feeFields(req.body);
    if (!categoryKey || !/^[a-z0-9_]+$/.test(categoryKey)) {
      return res.status(400).json({ success: false, error: 'Category key must be lowercase letters, digits, or underscores.' });
    }
    if (!label || !String(label).trim()) return res.status(400).json({ success: false, error: 'Label is required.' });
    if ([f.early, f.regular, f.late].some((x) => !Number.isFinite(x) || x < 0)) {
      return res.status(400).json({ success: false, error: 'Fees must be non-negative numbers.' });
    }
    const max = await dbGet('SELECT COALESCE(MAX(sort_order), -1) AS m FROM fee_categories');
    await dbRun(
      'INSERT INTO fee_categories (category_key, label, early_fee, regular_fee, late_fee, active, sort_order) VALUES (?, ?, ?, ?, ?, 1, ?)',
      [categoryKey, String(label).trim(), f.early, f.regular, f.late, max.m + 1]
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ success: false, error: 'A category with that key already exists.' });
    }
    next(err);
  }
});

app.put('/api/admin/fees/categories/:id', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const existing = await dbGet('SELECT * FROM fee_categories WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Category not found.' });
    const { label, active } = req.body;
    const f = feeFields(req.body);
    if ([f.early, f.regular, f.late].some((x) => !Number.isFinite(x) || x < 0)) {
      return res.status(400).json({ success: false, error: 'Fees must be non-negative numbers.' });
    }
    await dbRun(
      'UPDATE fee_categories SET label = ?, early_fee = ?, regular_fee = ?, late_fee = ?, active = ? WHERE id = ?',
      [label !== undefined ? String(label).trim() : existing.label, f.early, f.regular, f.late,
        active !== undefined ? (active ? 1 : 0) : existing.active, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/admin/fees/categories/:id', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const cat = await dbGet('SELECT * FROM fee_categories WHERE id = ?', [req.params.id]);
    if (!cat) return res.status(404).json({ success: false, error: 'Category not found.' });
    const used = await dbGet('SELECT COUNT(*) AS n FROM registrations WHERE category_key = ?', [cat.category_key]);
    if (used.n > 0) {
      return res.status(409).json({ success: false, error: `Cannot delete: ${used.n} registration(s) use this category. Deactivate it instead.` });
    }
    await dbRun('DELETE FROM fee_categories WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- REPORTS (Excel/CSV + printable PDF) --------------------------------

async function buildReport(type) {
  if (type === 'verified') {
    const rows = await dbAll(
      `SELECT registration_number, delegate_name, phone_number, category_label, workshop, qi_exposure, paid_amount
         FROM registrations WHERE bank_status = 'BANK_VERIFIED'
         ORDER BY registration_number`);
    return {
      title: 'Registered Users with Verified Payment',
      columns: ['Reg No', 'Name', 'Mobile', 'Category', 'Workshop', 'QI Practice', 'Amount'],
      rows: rows.map((r) => [r.registration_number, r.delegate_name, r.phone_number, r.category_label, r.workshop, r.qi_exposure, r.paid_amount]),
    };
  }
  if (type === 'workshops') {
    const rows = await dbAll(
      `SELECT workshop, delegate_name, phone_number, category_label, bank_status
         FROM registrations
        WHERE workshop IS NOT NULL AND workshop != '' AND bank_status != 'REJECTED'
        ORDER BY workshop, delegate_name`);
    return {
      title: 'Registered Users per Workshop',
      columns: ['Workshop', 'Delegate', 'Mobile', 'Category', 'Status'],
      rows: rows.map((r) => [r.workshop, r.delegate_name, r.phone_number, r.category_label, r.bank_status]),
    };
  }
  if (type === 'abstracts') {
    const rows = await dbAll(
      `SELECT title, author_name, format, phone_number FROM abstracts WHERE status = 'ACCEPTED' ORDER BY title`);
    return {
      title: 'Accepted Abstracts',
      columns: ['Title', 'Author', 'Format', 'Mobile'],
      rows: rows.map((r) => [r.title, r.author_name, r.format, r.phone_number]),
    };
  }
  return null;
}

const REPORT_ROLES = {
  verified: ['SUPER_ADMIN', 'FINANCE_ADMIN'],
  workshops: ['SUPER_ADMIN', 'FINANCE_ADMIN'],
  abstracts: ['SUPER_ADMIN', 'ACADEMIC_REVIEWER'],
};

function toCsv({ columns, rows }) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [columns, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

function reportHtml(rep) {
  const th = rep.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
  const trs = rep.rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('') ||
    `<tr><td colspan="${rep.columns.length}" style="text-align:center;color:#94a3b8">No records</td></tr>`;
  const now = new Date().toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(rep.title)}</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;margin:2rem;}
  h1{font-size:1.2rem;margin:0 0 .25rem;}
  .sub{color:#64748b;font-size:.8rem;margin-bottom:1rem;}
  table{width:100%;border-collapse:collapse;font-size:.8rem;}
  th,td{border:1px solid #e2e8f0;padding:.5rem .6rem;text-align:left;vertical-align:top;}
  th{background:#f1f5f9;text-transform:uppercase;font-size:.68rem;letter-spacing:.04em;color:#475569;}
  tr:nth-child(even) td{background:#f8fafc;}
  .actions{margin:1.25rem 0;}
  button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:.55rem 1.25rem;font-weight:700;cursor:pointer;}
  @media print{body{margin:0;}.actions{display:none;}}
</style></head><body>
  <h1>NQOCN 2026 · ${escapeHtml(rep.title)}</h1>
  <p class="sub">Generated ${escapeHtml(now)} · ${rep.rows.length} record(s)</p>
  <div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
  <table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>
</body></html>`;
}

app.get('/api/admin/reports/:type', requireAuth, async (req, res, next) => {
  try {
    const type = req.params.type;
    const roles = REPORT_ROLES[type];
    if (!roles) return res.status(404).json({ success: false, error: 'Unknown report.' });
    if (!roles.includes(req.session.role)) {
      return res.status(403).json({ success: false, error: 'You do not have permission for this report.' });
    }
    const rep = await buildReport(type);
    res.set('Cache-Control', 'private, no-store');
    if (req.query.format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="nqocn-${type}-report.csv"`);
      return res.send(toCsv(rep));
    }
    res.type('html').send(reportHtml(rep));
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

    // Resetting away from ACCEPTED clears any allocation.
    if (status !== 'ACCEPTED') {
      await dbRun('UPDATE abstracts SET status = ?, allocation = NULL WHERE id = ?', [status, req.params.id]);
    } else {
      await dbRun('UPDATE abstracts SET status = ? WHERE id = ?', [status, req.params.id]);
    }
    await recordAudit({
      req,
      entityType: 'abstract',
      entityId: req.params.id,
      action: 'ABSTRACT_STATUS_CHANGE',
      oldValue: existing.status,
      newValue: status,
    });

    if (status === 'ACCEPTED' && existing.status !== 'ACCEPTED') {
      const a = await dbGet('SELECT phone_number, author_name, title FROM abstracts WHERE id = ?', [req.params.id]);
      if (a) notifyDelegate(a.phone_number, 'Your abstract has been accepted',
        emailWrap('Abstract accepted',
          `<p>Dear ${escapeHtml(a.author_name)},</p>
           <p>We are pleased to inform you that your abstract <b>"${escapeHtml(a.title)}"</b> has been <b>accepted</b>.</p>
           <p>The presentation format (oral or poster) will be communicated separately.</p>`));
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Allocate an accepted abstract to oral or poster presentation.
app.put('/api/abstracts/:id/allocation', requireRole('SUPER_ADMIN', 'ACADEMIC_REVIEWER'), async (req, res, next) => {
  try {
    const { allocation } = req.body;
    if (!['ORAL', 'POSTER'].includes(allocation)) {
      return res.status(400).json({ success: false, error: 'Allocation must be ORAL or POSTER.' });
    }
    const a = await dbGet('SELECT status, phone_number, author_name, title FROM abstracts WHERE id = ?', [req.params.id]);
    if (!a) return res.status(404).json({ success: false, error: 'Abstract not found.' });
    if (a.status !== 'ACCEPTED') {
      return res.status(400).json({ success: false, error: 'Only accepted abstracts can be allocated.' });
    }
    await dbRun('UPDATE abstracts SET allocation = ? WHERE id = ?', [allocation, req.params.id]);
    await recordAudit({
      req, entityType: 'abstract', entityId: req.params.id,
      action: 'ABSTRACT_ALLOCATION', oldValue: null, newValue: allocation,
    });
    const kind = allocation === 'ORAL' ? 'oral' : 'poster';
    notifyDelegate(a.phone_number, `Your abstract: ${kind} presentation`,
      emailWrap('Presentation format allocated',
        `<p>Dear ${escapeHtml(a.author_name)},</p>
         <p>Your accepted abstract <b>"${escapeHtml(a.title)}"</b> has been allocated for <b>${kind} presentation</b>.</p>
         <p>Further details will be communicated.</p>`));
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
  console.log(`SMS OTP: ${SMS_ENABLED ? 'ENABLED (Vynttra)' : 'disabled (no SMS_API_KEY)'}`);
  console.log(`Email: ${EMAIL_ENABLED ? `ENABLED (SES, from ${EMAIL_FROM})` : 'disabled (no AWS/SES config)'}`);
  if (OTP_ECHO && !SMS_ENABLED) console.log('[dev] OTP echo is ON — codes are returned to the client and logged here.');
});
