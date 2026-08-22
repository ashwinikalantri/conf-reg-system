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
const { Jimp } = require('jimp');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
// Node 16 has no global fetch; node-fetch (v2, CommonJS) provides it for SMS.
const fetch = require('node-fetch');
const multer = require('multer');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

// Payment screenshots are written here (never committed; see .gitignore) and
// served only through an authenticated route -- not from the static root.
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Uploaded bank statement files (source-of-truth copies for audit), separate
// from delegate uploads. Never served directly; admin-only, never committed.
const STATEMENT_DIR = path.join(__dirname, 'bank-statements');
fs.mkdirSync(STATEMENT_DIR, { recursive: true });
const statementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

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

const ADMIN_ROLES = ['SUPER_ADMIN', 'FINANCE_ADMIN', 'ACADEMIC_REVIEWER', 'FINANCE_ACADEMIC'];

// Some roles imply others for permission checks. FINANCE_ACADEMIC is a combined
// role that grants both finance-admin and academic-reviewer access; every other
// role grants only itself. (SUPER_ADMIN is listed explicitly where it applies.)
const ROLE_IMPLIES = { FINANCE_ACADEMIC: ['FINANCE_ADMIN', 'ACADEMIC_REVIEWER'] };
function roleGrants(role) {
  return [role, ...(ROLE_IMPLIES[role] || [])];
}

// Admin-editable from Settings → General (see GENERAL_SETTINGS_KEYS below),
// persisted in schema_meta. name/acronym/dates/location are display-only text
// used across confirmation emails, reports, and printable pages -- nothing
// here gates any capability, so unlike SMS/EMAIL/UPI there's no *Enabled()
// check for it.
const CONFERENCE = {
  name: 'International Conference on Healthcare Quality & Patient Safety 2026',
  acronym: 'NQOCN 2026',
  startDate: '2026-11-21',
  endDate: '2026-11-22',
  location: 'MGIMS, Sevagram, Wardha',
};
const PORTAL_URL = process.env.PORTAL_URL || 'https://registration.mgims.ac.in';

// "21–22 Nov 2026" (same month) or "28 Nov – 2 Dec 2026" (spanning months),
// from the YYYY-MM-DD strings Settings → General's date inputs produce.
function formatConferenceDates() {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const parse = (d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
    return m ? { year: m[1], month: MONTHS[Number(m[2]) - 1], day: Number(m[3]) } : null;
  };
  const s = parse(CONFERENCE.startDate);
  const e = parse(CONFERENCE.endDate);
  if (!s && !e) return '';
  if (s && e) {
    return (s.month === e.month && s.year === e.year)
      ? `${s.day}–${e.day} ${s.month} ${s.year}`
      : `${s.day} ${s.month}${s.year !== e.year ? ' ' + s.year : ''} – ${e.day} ${e.month} ${e.year}`;
  }
  const one = s || e;
  return `${one.day} ${one.month} ${one.year}`;
}

// --- .ENV FILE HELPERS ---------------------------------------------------
// Lets Settings → General persist a credential change to the actual .env
// file (not the database) so it survives a restart and stays wherever every
// other secret in this app already lives -- one source of truth, and
// nothing sensitive ever lands in conference.db or a backup of it. Updates
// process.env immediately too, so the change takes effect without a restart.
const ENV_PATH = path.join(__dirname, '.env');
function writeEnvVar(key, value) {
  // A value with an embedded newline/CR would break out of its `KEY=...` line
  // and inject arbitrary extra lines (i.e. arbitrary new env vars) into .env.
  // Reject at this boundary so no caller can ever write a multi-line value,
  // and mutate process.env only after the value is proven safe.
  if (/[\r\n]/.test(value)) throw new Error(`Refusing to write ${key}: value must not contain a line break.`);
  process.env[key] = value;
  let content = '';
  try { content = fs.readFileSync(ENV_PATH, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  // Replace with a function, not the string `line`: a string replacement
  // interprets $&, $$, $`, $', $n as special tokens, so a secret containing
  // any of those would be silently corrupted. A replacer function inserts the
  // value verbatim.
  content = re.test(content) ? content.replace(re, () => line) : (content.replace(/\n*$/, '\n') + line + '\n');
  fs.writeFileSync(ENV_PATH, content);
}
// Last-4 preview, used ONLY for the AWS Access Key ID -- which is not a bearer
// secret (it's the public half of the pair, shown by AWS's own console), so a
// tail is safe and lets an admin confirm which key is active. True secrets
// (SMS API key, AWS Secret Access Key) are never passed through this; the
// browser gets only a set/not-set boolean for those.
const maskSecret = (v) => v ? `••••${String(v).slice(-4)}` : null;

// --- SMS (Vynttra) ------------------------------------------------------
// Only the API key is a secret; the DLT sender/entity/template/header IDs are
// registration identifiers and default to the NQOCN values, overridable by env.
// Operational fields, and now the API key itself too, are admin-editable from
// Settings → General -- operational fields persist to schema_meta, while the
// key (like every credential here) persists to .env via writeEnvVar(), never
// to the database, and the browser is only ever told whether it is set, never
// any of its bytes.
const SMS = {
  apiKey: process.env.SMS_API_KEY || '',
  url: process.env.SMS_URL || 'https://api.vynttra.in/index.php/sms/json',
  sender: process.env.SMS_SENDER || 'KHSBDC',
  entityId: process.env.SMS_ENTITY_ID || '1201160068107545972',
  templateId: process.env.SMS_TEMPLATE_ID || '1077505970001758294',
  headerId: process.env.SMS_HEADER_ID || '1005654540639709445',
  type: process.env.SMS_TYPE || 'UNI',
};
// Capability depends on runtime-editable fields now, so these are functions
// rather than booleans frozen at boot.
const smsEnabled = () => !!SMS.apiKey && !!SMS.url && !!SMS.sender;

// Runtime on/off switches a super admin can flip (persisted in schema_meta,
// loaded at boot by loadNotificationToggles). These gate sending ON TOP of the
// env-based capability (smsEnabled() / emailEnabled()) -- turning a channel off
// stops all outgoing messages on it without touching credentials.
const notifyToggle = { sms: true, email: true };
async function loadNotificationToggles() {
  const s = await dbGet("SELECT value FROM schema_meta WHERE key = 'notify_sms_enabled'").catch(() => null);
  const e = await dbGet("SELECT value FROM schema_meta WHERE key = 'notify_email_enabled'").catch(() => null);
  if (s) notifyToggle.sms = s.value !== '0';
  if (e) notifyToggle.email = e.value !== '0';
}

// Non-secret operational fields for SMS/Email/UPI, admin-editable from
// Settings → General, persisted in schema_meta and applied over the env
// defaults set on SMS/EMAIL/UPI above. Credentials (SMS_API_KEY, AWS keys)
// are intentionally not among these keys -- they only ever come from .env.
const GENERAL_SETTINGS_KEYS = {
  sms_sender: ['SMS', 'sender'], sms_url: ['SMS', 'url'], sms_entity_id: ['SMS', 'entityId'],
  sms_template_id: ['SMS', 'templateId'], sms_header_id: ['SMS', 'headerId'], sms_type: ['SMS', 'type'],
  email_from: ['EMAIL', 'from'], email_from_name: ['EMAIL', 'fromName'], email_region: ['EMAIL', 'region'],
  upi_id: ['UPI', 'id'], upi_payee_name: ['UPI', 'payeeName'],
  conference_name: ['CONFERENCE', 'name'], conference_acronym: ['CONFERENCE', 'acronym'],
  conference_start_date: ['CONFERENCE', 'startDate'], conference_end_date: ['CONFERENCE', 'endDate'],
  conference_location: ['CONFERENCE', 'location'],
};
async function loadGeneralSettings() {
  const keys = Object.keys(GENERAL_SETTINGS_KEYS);
  const rows = await dbAll(`SELECT key, value FROM schema_meta WHERE key IN (${keys.map(() => '?').join(',')})`, keys);
  const targets = { SMS, EMAIL, UPI, CONFERENCE };
  for (const row of rows) {
    const dest = GENERAL_SETTINGS_KEYS[row.key];
    if (dest && row.value) targets[dest[0]][dest[1]] = row.value;
  }
  rebuildSesClient();
}

// Send the registration OTP over SMS using the registered DLT template.
// Fire-and-forget: failures are logged, never block OTP issuance.
async function sendOtpSms(phone, otp) {
  if (!smsEnabled() || !notifyToggle.sms) return;
  const text = `Dear Delegate, Thank you for registering for the NQOCN Conference. Your OTP for registration verification is ${otp} NQOCN Conference MGIMS`;
  // Without a bound, a stalled connection to the gateway (network blip,
  // upstream not closing) hangs this fire-and-forget call forever -- no
  // success, no error, nothing logged, silently and permanently unable to
  // tell that the SMS never went out.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
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
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (data.code !== 200) {
      console.error(`SMS to ${phone} not accepted (HTTP ${res.status}):`, JSON.stringify(data));
      writeAuditRow('sms', phone, 'SMS_FAILED', null, `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`, null, null, null).catch(() => {});
    } else {
      const id = data.data && data.data[0] && data.data[0].uniqueid;
      console.log(`SMS to ${phone} accepted by gateway${id ? ` (uniqueid ${id})` : ''}`);
      writeAuditRow('sms', phone, 'SMS_SENT', null, id ? `uniqueid ${id}` : 'accepted', null, null, null).catch(() => {});
    }
  } catch (err) {
    const detail = err.name === 'AbortError' ? 'timed out after 10s' : err.message;
    console.error(`SMS to ${phone} failed:`, detail);
    writeAuditRow('sms', phone, 'SMS_FAILED', null, detail, null, null, null).catch(() => {});
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- EMAIL (AWS SES v2 SDK) ---------------------------------------------
// Uses IAM credentials + region from the environment (AWS_ACCESS_KEY_ID,
// AWS_SECRET_ACCESS_KEY, AWS_REGION). SES_FROM must be a verified sender.
// Dormant until credentials, region, and a From address are all present.
// From address / display name / region, and now the IAM credentials too, are
// admin-editable from Settings → General. awsCredsPresent() reads process.env
// live so capability checks see a mid-run credential change immediately.
//
// IMPORTANT: that alone does NOT make an existing SESv2Client use new
// credentials. The AWS SDK v3 default provider chain resolves static IAM keys
// from process.env once, when the client first needs them, and memoizes the
// result for that client's lifetime (only expiring/STS credentials refresh) --
// it does NOT re-read process.env per .send(). So a credential OR region change
// only takes effect because rebuildSesClient() constructs a brand-new client;
// keep calling it on every such change (see the general-settings PUT handler).
const EMAIL = {
  from: (process.env.SES_FROM || '').trim(),
  fromName: process.env.SES_FROM_NAME || 'NQOCN 2026',
  region: (process.env.AWS_REGION || '').trim(),
};
const awsCredsPresent = () => !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
const emailEnabled = () => awsCredsPresent() && !!EMAIL.region && !!EMAIL.from;
// RFC 5322 "Display Name <address>" form -- without it SES sends with no
// name, so inboxes show only the bare address instead of "NQOCN 2026".
const emailFromFormatted = () => EMAIL.from ? `"${EMAIL.fromName.replace(/"/g, '')}" <${EMAIL.from}>` : EMAIL.from;
// Construct a fresh client on every credential/region change: a live client
// caches its resolved credentials and is bound to its region, so mutating
// EMAIL/process.env is not enough on its own (see the block comment above).
let sesClient = null;
function rebuildSesClient() {
  sesClient = emailEnabled() ? new SESv2Client({ region: EMAIL.region }) : null;
}
rebuildSesClient();

// Send an email if configured; never throws (notifications are best-effort).
// The runtime notifyToggle.email switch lets a super admin silence all email.
async function sendEmail(to, subject, html) {
  if (!emailEnabled() || !notifyToggle.email || !to || !sesClient) return;
  try {
    await sesClient.send(new SendEmailCommand({
      FromEmailAddress: emailFromFormatted(),
      Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Html: { Data: html, Charset: 'UTF-8' } } } },
    }));
    writeAuditRow('email', to, 'EMAIL_SENT', null, subject, null, null, null).catch(() => {});
  } catch (err) {
    console.error(`Email to ${to} failed:`, err.message);
    writeAuditRow('email', to, 'EMAIL_FAILED', null, `${subject} — ${err.message}`.slice(0, 300), null, null, null).catch(() => {});
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
       <h1 style="font-size:1.05rem;margin:.35rem 0 0">${escapeHtml(CONFERENCE.name)}</h1>
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
// the payee; OCR checks the uploaded image against it. Admin-editable from
// Settings → General, and served to the delegate payment form via /api/fees
// so the QR code and the OCR check can never drift apart.
const UPI = {
  id: process.env.OFFICIAL_UPI_ID || 'abhishekraut@cbin',
  payeeName: process.env.UPI_PAYEE_NAME || 'NQOCN 2026',
};

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

// Format a rupee amount with Indian digit grouping (e.g. 100000 -> 1,00,000):
// last three digits grouped, then every two digits. Done manually because
// toLocaleString('en-IN') falls back to Western grouping on this Node build
// (no full ICU). Output is plain digits + commas, safe to drop into HTML.
function inr(v) {
  const num = typeof v === 'number' ? v : Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  if (!isFinite(num)) return v == null ? '' : String(v);
  const neg = num < 0;
  const s = String(Math.round(Math.abs(num)));
  let out;
  if (s.length <= 3) out = s;
  else out = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3);
  return (neg ? '-' : '') + out;
}

// Normalise a person's name to Title Case (idempotent -- safe to re-run on
// already-cased input). Lower-cases everything, then capitalises the first
// letter after start-of-string, whitespace, hyphen, period, or apostrophe, so
// "DR SMITA J." -> "Dr Smita J." and "jean-pierre" -> "Jean-Pierre".
function titleCase(v) {
  const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  if (!s) return s;
  return s.toLowerCase().replace(/(^|[\s\-'.])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

// Salutations offered on the signup form -- a separate field from Full Name.
const SALUTATIONS = ['Mr', 'Mrs', 'Ms', 'Dr', 'Prof'];

// If a name starts with one of these titles (with or without a trailing
// period), split it into { salutation, name } with the title removed.
// Requires a period or whitespace right after the title so "Mrunal" or
// "Drashti" are never mistaken for "Mr"/"Dr" + a name.
function splitSalutation(fullName) {
  const s = String(fullName == null ? '' : fullName).trim();
  const m = /^(mrs|mr|ms|dr|prof)[.\s]+(.*)$/i.exec(s);
  if (!m || !m[2].trim()) return { salutation: null, name: s };
  const canonical = SALUTATIONS.find((x) => x.toLowerCase() === m[1].toLowerCase());
  return { salutation: canonical, name: m[2].trim() };
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

  // Amount detection. Two prongs, because the amount is the single hardest
  // thing to OCR on a payment receipt -- it's shown in a big, bold,
  // stylized font that Tesseract mangles far more than the plain body text.
  const expectedAmountStr = String(expectedAmount);
  // OCR routinely reads the "0" digit as the letter "O" and "1" as "l"/"I"
  // in that bold amount font; fix those look-alikes inside any digit-ish run
  // so the zeroes count as digits.
  const normDigits = (s) => s.replace(/[0-9OolI]+/g, (run) => run.replace(/[OoIl]/g, (c) => (c === 'I' || c === 'l' ? '1' : '0')));

  let amount = false;

  // Prong 1 (currency-anchored, high confidence): when a rupee marker is
  // read intact -- the ₹ glyph, "Rs", or "INR" -- the number right after it
  // is the amount. Take its integer part (before any decimal), drop commas,
  // and compare. This is the case the "look next to the ₹ symbol" ask is
  // about, and it's unambiguous when the symbol survives OCR.
  const anchorRe = /(?:₹|rs\.?|inr)\s*([0-9OolI][0-9OolI.,\s]*)/gi;
  let m;
  while (!amount && (m = anchorRe.exec(text)) !== null) {
    const intPart = normDigits(m[1]).split('.')[0].replace(/[^0-9]/g, '');
    if (intPart === expectedAmountStr) amount = true;
  }

  // Prong 2 (digit-run matching, tolerant): the ₹ glyph is frequently NOT
  // read cleanly -- it gets dropped, or fused onto the number as a stray
  // leading digit (e.g. "₹3,000.00" -> "33,000.00"), or a comma is read as
  // a digit (e.g. "₹2,000" -> "2 9 0 0 0"). Concatenate adjacent digit runs
  // into candidate numbers and match the expected amount either exactly, or
  // allowing exactly ONE spurious character to be deleted (the misread
  // symbol/comma). The length guard (candidate is exactly one digit longer
  // than expected) is what keeps this from matching a 12-digit UTR or an
  // account number -- only a number one digit off from the fee can match.
  const deletable = (cand, target) => {
    if (cand.length !== target.length + 1) return false;
    for (let i = 0; i < cand.length; i++) {
      if (cand.slice(0, i) + cand.slice(i + 1) === target) return true;
    }
    return false;
  };
  const amountTokens = normDigits(text).split(/[^0-9]+/).filter(Boolean);
  for (let i = 0; !amount && i < amountTokens.length; i++) {
    let acc = '';
    for (let j = i; j < amountTokens.length; j++) {
      acc += amountTokens[j];
      if (acc.length > expectedAmountStr.length + 1) break;
      if (acc === expectedAmountStr || deletable(acc, expectedAmountStr)) { amount = true; break; }
    }
  }

  // VPA: the conference UPI id appears (compare ignoring whitespace/case).
  const vpa = compact.includes(UPI.id.replace(/\s+/g, '').toLowerCase());

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

// OCR a single ID-card buffer and return its raw text, or null on OCR failure.
async function ocrIdCardText(buffer) {
  try {
    const worker = await getOcrWorker();
    const result = await Promise.race([
      worker.recognize(buffer),
      new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timed out')), 15000)),
    ]);
    return (result && result.data && result.data.text) || '';
  } catch (err) {
    console.error('ID OCR failed:', err.message);
    ocrWorkerPromise = null;
    return null;
  }
}

// OCR a student ID card and check it against the claimed category. Advisory:
// an unreadable or ambiguous card yields false (flagged), never an error.
//
// Phone-photographed ID cards are frequently uploaded sideways or upside
// down, which tanks OCR accuracy far more than blur or bad lighting does.
// Try the image as-is first (the common case, and the fast path); only if
// that fails to identify a matching discipline/level do we pay the cost of
// re-OCRing at 90/180/270 degrees, keeping whichever rotation is the first
// to produce a match.
async function runIdCardCheck(buffer, categoryKey) {
  const expect = STUDENT_CATEGORIES[categoryKey];
  if (!expect) return null; // category does not require an ID card

  const text = await ocrIdCardText(buffer);
  if (text === null) return false;
  const attrs = detectIdAttributes(text);
  if (attrs.discipline === expect.discipline && attrs.level === expect.level) return true;

  for (const angle of [90, 180, 270]) {
    let rotatedBuffer;
    try {
      const image = await Jimp.read(buffer);
      rotatedBuffer = await image.rotate(angle).getBuffer('image/jpeg');
    } catch (err) {
      break; // not an image Jimp can decode -- rotating won't help
    }
    const rotatedText = await ocrIdCardText(rotatedBuffer);
    if (rotatedText === null) continue;
    const rotatedAttrs = detectIdAttributes(rotatedText);
    if (rotatedAttrs.discipline === expect.discipline && rotatedAttrs.level === expect.level) return true;
  }

  return false;
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

// Low-level audit write, independent of req.session -- used both by
// recordAudit() (admin actions with a logged-in actor) and by system-initiated
// events (login itself, outgoing SMS/email) where either there's no session
// yet or the "actor" is the system, not an admin.
async function writeAuditRow(entityType, entityId, action, oldValue, newValue, actorPhone, actorName, actorRole) {
  // actor_phone is NOT NULL. System-initiated events (outgoing SMS/email) have
  // no admin actor, so a null here would fail the constraint and -- because
  // these callers are fire-and-forget with a swallowed .catch -- would drop the
  // audit row silently. Fall back to a 'system' actor so those writes succeed.
  const isSystem = actorPhone == null;
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
      isSystem ? 'system' : String(actorPhone),
      actorName == null ? (isSystem ? 'System' : null) : String(actorName),
      actorRole == null ? (isSystem ? 'SYSTEM' : null) : String(actorRole),
      Date.now(),
    ]
  );
}

// Append an entry to the audit trail, attributed to the acting admin.
async function recordAudit({ req, entityType, entityId, action, oldValue, newValue }) {
  await writeAuditRow(entityType, entityId, action, oldValue, newValue, req.session.phone, req.session.name, req.session.role);
}

// Every entity_type written by a Settings-page recordAudit() call belongs
// here -- the admin "General Logs" tab's query (see GET /api/admin/activity-log)
// builds its filter from this single array instead of a second, separately
// hand-maintained SQL literal list. Adding a new settings feature? Add its
// entityType string here too, or its audit entries will write successfully
// but never appear in General Logs.
const GENERAL_LOG_ENTITY_TYPES = [
  'program_option', 'fee_config', 'fee_category', 'discount_code', 'group_rule', 'general_settings',
  'settings', // legacy: pre-rename NOTIFICATION_TOGGLE rows only
];

// Login event -- entityId is the phone so the login log can be searched per
// delegate/admin like every other log.
async function recordLogin(phone, name, role) {
  await writeAuditRow('login', phone, 'LOGIN', null, null, phone, name, role).catch((err) => console.error('Login log failed:', err.message));
}

// Fetch program options annotated with live enrollment counts. A slot is held
// by any non-rejected registration referencing the option -- except faculty,
// who are attached to the option (so they show on its roster/report) but
// don't occupy a capacity slot.
function fetchProgramOptions({ activeOnly } = {}) {
  return dbAll(`
    SELECT o.id, o.type, o.name, o.capacity, o.active,
      (SELECT COUNT(*) FROM registrations r
         WHERE r.bank_status != 'REJECTED'
           AND ((o.type = 'WORKSHOP' AND r.workshop_option_id = o.id AND r.workshop_is_faculty = 0)
             OR (o.type = 'QI' AND r.qi_option_id = o.id AND r.qi_is_faculty = 0))) AS enrolled,
      (SELECT COUNT(*) FROM registrations r
         WHERE r.bank_status != 'REJECTED'
           AND ((o.type = 'WORKSHOP' AND r.workshop_option_id = o.id AND r.workshop_is_faculty = 1)
             OR (o.type = 'QI' AND r.qi_option_id = o.id AND r.qi_is_faculty = 1))) AS faculty_count
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
  const facultyCol = type === 'WORKSHOP' ? 'workshop_is_faculty' : 'qi_is_faculty';
  const { n } = await dbGet(
    `SELECT COUNT(*) AS n FROM registrations WHERE ${col} = ? AND bank_status != 'REJECTED' AND id != ? AND ${facultyCol} = 0`,
    [id, ownRegId == null ? -1 : ownRegId]
  );
  if (n >= opt.capacity) return { error: `"${opt.name}" is full. Please choose another ${label}.` };
  return { opt };
}

// Which pricing phase is in effect today, from the configured cutoff dates.
// Four phases: early (<= early_until), regular (<= regular_until),
// late (<= late_until), spot (after late_until, or if no cutoffs are set).
function currentPhase(config, today = new Date()) {
  const d = today.toISOString().slice(0, 10); // YYYY-MM-DD
  if (config && config.early_until && d <= config.early_until) return 'early';
  if (config && config.regular_until && d <= config.regular_until) return 'regular';
  if (config && config.late_until && d <= config.late_until) return 'late';
  return 'spot';
}

function getFeeConfig() {
  return dbGet('SELECT early_until, regular_until, late_until FROM fee_config WHERE id = 1');
}

// Resolve the authoritative fee and label for a category at today's phase.
async function resolveFee(categoryKey) {
  const cat = await dbGet('SELECT * FROM fee_categories WHERE category_key = ? AND active = 1', [categoryKey]);
  if (!cat) return null;
  const phase = currentPhase(await getFeeConfig());
  const fee = { early: cat.early_fee, regular: cat.regular_fee, late: cat.late_fee, spot: cat.spot_fee }[phase];
  return { amount: fee, label: cat.label, phase };
}

// The rupee discount a code takes off a base fee (never more than the fee).
function computeDiscountAmount(codeRow, baseFee) {
  if (!codeRow) return 0;
  const raw = codeRow.discount_type === 'PERCENT'
    ? Math.round((baseFee * codeRow.discount_value) / 100)
    : codeRow.discount_value;
  return Math.max(0, Math.min(Math.round(raw), Math.round(baseFee)));
}

// Validate a promo code for a specific delegate + category. Returns
// { ok, code } or { ok:false, error }. Usage is counted from registrations
// that currently hold the code (excluding the caller's own, so re-submitting
// doesn't consume a second slot), so a code can't be applied more than
// max_uses times across delegates.
async function validateDiscountCode(rawCode, phone, categoryKey) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'Enter a promo code.' };
  const row = await dbGet('SELECT * FROM discount_codes WHERE code = ?', [code]);
  if (!row || !row.active) return { ok: false, error: 'This promo code is not valid.' };
  if (row.expires_at) {
    // Compare as calendar dates in IST; a code is valid through its expiry day.
    // toLocaleDateString('en-CA', {timeZone}) is the "correct" way to get this,
    // but silently falls back to US M/D/YYYY on this Node build's limited ICU
    // (no error -- it just returns the wrong format), which broke the string
    // comparison below for every code with an expiry. Shifting the clock by
    // IST's fixed +5:30 offset and reading the UTC date is ICU-independent.
    const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
    if (row.expires_at < today) return { ok: false, error: 'This promo code has expired.' };
  }
  if (row.scope_type === 'CATEGORY' && row.scope_value !== categoryKey) {
    return { ok: false, error: 'This promo code does not apply to your delegate category.' };
  }
  if (row.scope_type === 'INDIVIDUAL' && row.scope_value !== phone) {
    return { ok: false, error: 'This promo code is not valid for your account.' };
  }
  if (row.max_uses && row.max_uses > 0) {
    const used = await dbGet(
      "SELECT COUNT(*) AS n FROM registrations WHERE UPPER(discount_code) = ? AND bank_status != 'REJECTED' AND phone_number != ?",
      [code, phone]);
    if (used && used.n >= row.max_uses) {
      return { ok: false, error: 'This promo code has reached its usage limit.' };
    }
  }
  return { ok: true, code: row };
}

// A delegate's group and whether it currently qualifies for its category's
// group discount (member count >= the rule's min_size). Returns null if the
// delegate isn't in a group.
async function getDelegateGroup(phone) {
  const m = await dbGet('SELECT group_id FROM group_members WHERE phone_number = ?', [phone]);
  if (!m) return null;
  const group = await dbGet('SELECT * FROM delegate_groups WHERE id = ?', [m.group_id]);
  if (!group) return null;
  const members = await dbAll('SELECT phone_number, joined_at FROM group_members WHERE group_id = ? ORDER BY joined_at ASC', [group.id]);
  const rule = await dbGet('SELECT * FROM group_discount_rules WHERE category_key = ? AND active = 1', [group.category_key]);
  const size = members.length;
  const qualifies = !!rule && size >= rule.min_size;
  return { group, members, rule, size, qualifies };
}

// The group-discount rupee amount for a delegate against a base fee (0 if not
// in a qualifying group). Reuses the discount-code compute (same shape).
async function getGroupDiscountAmount(phone, baseFee) {
  const g = await getDelegateGroup(phone);
  if (!g || !g.qualifies) return 0;
  return computeDiscountAmount(g.rule, baseFee);
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
   'ALTER TABLE users ADD COLUMN salutation TEXT',
   'ALTER TABLE users ADD COLUMN created_at INTEGER',
  ].forEach((sql) => db.run(sql, () => {}));

  // One-time backfill of created_at (account signup time) for rows predating
  // the column. The true original signup is lost for old accounts (12h
  // sessions are pruned), so estimate it as the earliest evidence we still
  // have: the earliest surviving session, floored by the registration date so
  // "signed up" can never fall after "registered". NULL stays NULL only when
  // there is neither a session nor a registration to anchor to.
  db.run(`UPDATE users SET created_at = (
            SELECT MIN(t) FROM (
              SELECT MIN(se.created_at) AS t FROM sessions se WHERE se.phone_number = users.phone_number
              UNION ALL
              SELECT r.submitted_at AS t FROM registrations r WHERE r.phone_number = users.phone_number
            ) WHERE t IS NOT NULL
          )
          WHERE created_at IS NULL`, () => {});

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
  // early/regular/late cutoff dates. Admin-editable.
  db.run(`
    CREATE TABLE IF NOT EXISTS fee_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_key TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      early_fee REAL NOT NULL DEFAULT 0,
      regular_fee REAL NOT NULL DEFAULT 0,
      late_fee REAL NOT NULL DEFAULT 0,
      spot_fee REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS fee_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      early_until TEXT,
      regular_until TEXT,
      late_until TEXT
    )
  `);
  // Additive migration for fee tables created before the spot-registration
  // phase existed.
  db.all('PRAGMA table_info(fee_categories)', (err, cols) => {
    if (err) return console.error('Schema check failed:', err.message);
    const names = cols.map((c) => c.name);
    if (!names.includes('spot_fee')) {
      db.run('ALTER TABLE fee_categories ADD COLUMN spot_fee REAL NOT NULL DEFAULT 0', () => {
        // Default the new spot fee to the late fee so existing categories
        // keep charging something sane until an admin sets it explicitly.
        db.run('UPDATE fee_categories SET spot_fee = late_fee WHERE spot_fee = 0');
      });
    }
    if (!names.includes('subtitle')) {
      db.run("ALTER TABLE fee_categories ADD COLUMN subtitle TEXT NOT NULL DEFAULT ''");
    }
  });
  db.all('PRAGMA table_info(fee_config)', (err, cols) => {
    if (err) return console.error('Schema check failed:', err.message);
    const names = cols.map((c) => c.name);
    if (!names.includes('late_until')) db.run('ALTER TABLE fee_config ADD COLUMN late_until TEXT');
  });

  // Tiny key/value table for one-off migration flags -- lets a boot-time
  // backfill (see retitleNamesOnBoot) run exactly once ever, rather than on
  // every restart.
  db.run('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)');

  // Admin-created promo / discount codes. code is stored uppercased and is
  // unique. scope_type GLOBAL (any delegate), CATEGORY (scope_value =
  // category_key), or INDIVIDUAL (scope_value = phone_number). discount_type
  // PERCENT or FLAT. max_uses NULL/0 = unlimited; usage is counted from
  // registrations that currently hold the code (see validateDiscountCode).
  db.run(`
    CREATE TABLE IF NOT EXISTS discount_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      discount_type TEXT NOT NULL,
      discount_value REAL NOT NULL,
      scope_type TEXT NOT NULL,
      scope_value TEXT,
      max_uses INTEGER,
      expires_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      created_by TEXT
    )
  `);

  // Group-discount rules (admin Masters): per category, the minimum group size
  // that unlocks a discount and the discount itself. One rule per category.
  db.run(`
    CREATE TABLE IF NOT EXISTS group_discount_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_key TEXT UNIQUE NOT NULL,
      min_size INTEGER NOT NULL DEFAULT 5,
      discount_type TEXT NOT NULL,
      discount_value REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `);

  // Delegate groups formed to claim a group discount. All members share one
  // category (the group's). leader_phone is the delegate who started it.
  db.run(`
    CREATE TABLE IF NOT EXISTS delegate_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      category_key TEXT NOT NULL,
      leader_phone TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  // One membership row per delegate (a delegate can be in at most one group).
  db.run(`
    CREATE TABLE IF NOT EXISTS group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      phone_number TEXT UNIQUE NOT NULL,
      joined_at INTEGER NOT NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id)');

  // Bank statement transactions, imported from admin-uploaded statement
  // files. dedupe_hash is a stable fingerprint of the row so re-uploading an
  // overlapping statement silently skips rows already imported -- this is
  // how multiple uploads "compile into one" statement.
  db.run(`
    CREATE TABLE IF NOT EXISTS bank_statement_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_date TEXT,
      value_date TEXT,
      branch_code TEXT,
      cheque_number TEXT,
      description TEXT,
      debit REAL,
      credit REAL,
      balance REAL,
      extracted_ref TEXT,
      dedupe_hash TEXT UNIQUE NOT NULL,
      source_file TEXT,
      imported_at INTEGER NOT NULL,
      imported_by TEXT
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_stmt_ref ON bank_statement_transactions(extracted_ref)');

  // Individual payment transactions against a registration. Historically a
  // registration carried a SINGLE inline payment (paid_amount/utr_number/
  // screenshot/bank_txn_id columns on registrations). This table breaks that
  // 1-to-1 assumption so one registration can accrue MULTIPLE payments
  // (initial + top-ups toward an outstanding balance), each with its own
  // screenshot, its own OCR checks, its own admin review state, and its own
  // 1-to-1 bank-statement link. A registration is only fully paid once the
  // sum of its VERIFIED transactions' verified_amount reaches the fee due.
  //
  // The legacy inline columns on registrations are still maintained for
  // backward compatibility during the transition; this table is the source
  // of truth for the cumulative/partial-payment logic. Existing rows are
  // migrated in by backfillPaymentTransactionsOnBoot().
  db.run(`
    CREATE TABLE IF NOT EXISTS payment_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registration_id INTEGER NOT NULL,
      phone_number TEXT,
      amount REAL,                       -- amount the delegate claims this transaction paid
      verified_amount REAL,              -- amount an admin acknowledges was actually received
      utr_number TEXT,
      screenshot TEXT,
      payment_mode TEXT DEFAULT 'UPI',
      ocr_amount_match INTEGER,
      ocr_vpa_match INTEGER,
      ocr_utr_match INTEGER,
      is_flagged INTEGER DEFAULT 0,
      txn_status TEXT DEFAULT 'PENDING', -- PENDING | VERIFIED | REJECTED
      bank_txn_id INTEGER,               -- linked bank_statement_transactions.id (1-to-1)
      rejection_reason TEXT,
      rejection_note TEXT,
      submitted_at INTEGER,
      reviewed_by TEXT,
      reviewed_at INTEGER
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_paytxn_reg ON payment_transactions(registration_id)');
  // A given bank-statement row can back at most one payment transaction.
  // NULLs are distinct in SQLite UNIQUE indexes, so unlinked rows never collide.
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_paytxn_bank_txn_id ON payment_transactions(bank_txn_id)');

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
    // Faculty for a workshop/QI practice are enrolled the same way as a
    // delegate (same option_id columns) but don't occupy a capacity slot and
    // are labeled "Faculty" instead of counted as an attendee -- see
    // fetchProgramOptions() and the workshops report.
    if (!names.includes('workshop_is_faculty')) db.run('ALTER TABLE registrations ADD COLUMN workshop_is_faculty INTEGER DEFAULT 0');
    if (!names.includes('qi_is_faculty')) db.run('ALTER TABLE registrations ADD COLUMN qi_is_faculty INTEGER DEFAULT 0');
    if (!names.includes('id_card')) db.run('ALTER TABLE registrations ADD COLUMN id_card TEXT');
    if (!names.includes('ocr_id_match')) db.run('ALTER TABLE registrations ADD COLUMN ocr_id_match INTEGER');
    if (!names.includes('rejection_reason')) db.run('ALTER TABLE registrations ADD COLUMN rejection_reason TEXT');
    if (!names.includes('rejection_note')) db.run('ALTER TABLE registrations ADD COLUMN rejection_note TEXT');
    if (!names.includes('payment_mode')) db.run("ALTER TABLE registrations ADD COLUMN payment_mode TEXT DEFAULT 'UPI'");
    if (!names.includes('submitted_at')) db.run('ALTER TABLE registrations ADD COLUMN submitted_at INTEGER');
    if (!names.includes('bank_txn_id')) {
      db.run('ALTER TABLE registrations ADD COLUMN bank_txn_id INTEGER', () => {
        // One statement transaction can back at most one registration. SQLite
        // treats each NULL as distinct in a UNIQUE index, so unlinked rows
        // (the common case) never collide with each other.
        db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_registrations_bank_txn_id ON registrations(bank_txn_id)');
      });
    }
    // Admin (approver) confirmation that a student category's uploaded ID
    // card actually verifies that status -- distinct from ocr_id_match,
    // which is only the automated advisory check. Required before a student
    // registration can be verified (see PUT .../status).
    if (!names.includes('id_verified')) db.run('ALTER TABLE registrations ADD COLUMN id_verified INTEGER DEFAULT 0');
    if (!names.includes('id_verified_by')) db.run('ALTER TABLE registrations ADD COLUMN id_verified_by TEXT');
    if (!names.includes('id_verified_at')) db.run('ALTER TABLE registrations ADD COLUMN id_verified_at INTEGER');
    // Admin category lock: when set, the delegate cannot change their category
    // on the portal and the fee is fixed to the locked category (see the
    // lock-category endpoint).
    if (!names.includes('category_locked')) db.run('ALTER TABLE registrations ADD COLUMN category_locked INTEGER DEFAULT 0');
    // Applied promo/discount code and the rupee amount it took off the fee.
    if (!names.includes('discount_code')) db.run('ALTER TABLE registrations ADD COLUMN discount_code TEXT');
    if (!names.includes('discount_amount')) db.run('ALTER TABLE registrations ADD COLUMN discount_amount REAL DEFAULT 0');

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

  // Seed the fee master on first run from the original hardcoded tiers. The
  // spot (walk-in) fee defaults to a step above the late fee.
  db.get('SELECT COUNT(*) AS n FROM fee_categories', (err, r) => {
    if (err || (r && r.n > 0)) return;
    const stmt = db.prepare('INSERT INTO fee_categories (category_key, label, early_fee, regular_fee, late_fee, spot_fee, active, sort_order) VALUES (?, ?, ?, ?, ?, ?, 1, ?)');
    const seed = [
      ['nursing_ug', 'Nursing Student UG', 500, 1000, 2000, 2500],
      ['nursing_pg', 'Nursing Student PG', 750, 1500, 2500, 3000],
      ['med_student', 'Medical Student UG', 1500, 2200, 3000, 3500],
      ['nurse_cho', 'Nurse / Paramedical / CHO', 2000, 2800, 3500, 4000],
      ['pg_doctor', 'PG Student / Resident Doctor', 3000, 4000, 5000, 5500],
      ['faculty_mo', 'Doctors / Faculty / NHM MO', 3000, 4000, 5000, 5500],
      ['chw', 'Frontline CHWs (ASHA/ANM/AWW)', 200, 200, 200, 200],
    ];
    seed.forEach((s, i) => stmt.run(s[0], s[1], s[2], s[3], s[4], s[5], i));
    stmt.finalize();
    console.log('Seeded default fee categories.');
  });
  // Four pricing phases: Early Bird till 31 Aug 2026, Regular till 30 Sep
  // 2026, Late till 31 Oct 2026, Spot Registration after.
  db.run("INSERT OR IGNORE INTO fee_config (id, early_until, regular_until, late_until) VALUES (1, '2026-08-31', '2026-09-30', '2026-10-31')");
  db.run("UPDATE fee_config SET late_until = '2026-10-31' WHERE id = 1 AND (late_until IS NULL OR late_until = '')");
});

// One-time-ever backfill: normalise stored person names to Title Case. Guarded
// by a persisted flag in schema_meta so it runs exactly once across the
// application's lifetime -- not once per boot (an app restarted often, e.g.
// under a file-watcher during development, must not keep re-running this).
//
// It also fully finishes BEFORE the server starts accepting requests: it is
// only meant to clean up rows that existed before this code first shipped.
// If it were left to run fire-and-forget (racing with app.listen), a
// delegate who signs up in the first moments after that one-time boot could
// have the name they just typed silently rewritten mid-request -- exactly
// what we don't want, since new submissions are deliberately left untouched
// to preserve exact certificate-name input (see the signup form's hint).
async function retitleNamesOnBoot() {
  const already = await dbGet("SELECT value FROM schema_meta WHERE key = 'titlecase_backfill_done'");
  if (already) return;

  const retitle = async (table, col, keyCol) => {
    const rows = await dbAll(`SELECT ${keyCol} AS k, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != ''`);
    for (const row of rows) {
      const fixed = titleCase(row.v);
      if (fixed !== row.v) await dbRun(`UPDATE ${table} SET ${col} = ? WHERE ${keyCol} = ?`, [fixed, row.k]);
    }
  };
  await retitle('users', 'full_name', 'phone_number');
  await retitle('registrations', 'delegate_name', 'id');
  await retitle('abstracts', 'author_name', 'id');

  await dbRun("INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('titlecase_backfill_done', ?)", [String(Date.now())]);
}

// One-time-ever: the signup form used to have no separate salutation field,
// so people typed "Dr Abhishek Raut" etc. straight into Full Name. Split any
// already-stored name that starts with a title into salutation + clean name.
// Same run-once-ever + pre-listen gating as retitleNamesOnBoot, and for the
// same reason: this must never touch a name typed after the split field
// already existed.
async function splitSalutationsOnBoot() {
  const already = await dbGet("SELECT value FROM schema_meta WHERE key = 'salutation_split_done'");
  if (already) return;

  const rows = await dbAll("SELECT phone_number, full_name FROM users WHERE full_name IS NOT NULL AND full_name != ''");
  for (const row of rows) {
    const { salutation, name } = splitSalutation(row.full_name);
    if (salutation) {
      await dbRun('UPDATE users SET salutation = ?, full_name = ? WHERE phone_number = ?', [salutation, name, row.phone_number]);
    }
  }

  await dbRun("INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('salutation_split_done', ?)", [String(Date.now())]);
}

// One-time migration: seed payment_transactions from the legacy inline payment
// columns on registrations, so the new multi-transaction model starts with a
// faithful ledger of every payment already submitted. Run-once (schema_meta
// flag) AND self-guarding (only seeds a registration that has both a
// screenshot on file and zero existing transactions), so it can never
// double-insert even if the flag were cleared. Must complete before the port
// opens, so no real submission races it. See the payment_transactions table
// comment for the model.
async function backfillPaymentTransactionsOnBoot() {
  // Deliberately NOT gated on a run-once flag: during the transition window,
  // while the submission path still writes only the legacy inline columns,
  // this needs to run every boot to catch up any newly-submitted registration
  // that has no ledger row yet. The per-registration "0 existing txns" guard
  // below makes it idempotent, so re-running is safe. Once submission
  // dual-writes into payment_transactions, this becomes a no-op.
  const regs = await dbAll(
    `SELECT id, phone_number, paid_amount, expected_amount, utr_number, screenshot, payment_mode,
            ocr_amount_match, ocr_vpa_match, ocr_utr_match, is_flagged, bank_status,
            bank_txn_id, rejection_reason, rejection_note, submitted_at
       FROM registrations
      WHERE screenshot IS NOT NULL AND screenshot != ''`);

  let seeded = 0;
  for (const r of regs) {
    const existing = await dbGet('SELECT COUNT(*) AS n FROM payment_transactions WHERE registration_id = ?', [r.id]);
    if (existing && existing.n > 0) continue;

    // Map the registration's overall status onto this single seed transaction.
    // A verified registration => this payment is verified for the full fee it
    // was approved against; rejected => rejected; anything else => pending.
    let txnStatus = 'PENDING';
    let verifiedAmount = null;
    if (r.bank_status === 'BANK_VERIFIED') {
      txnStatus = 'VERIFIED';
      verifiedAmount = r.expected_amount != null ? r.expected_amount : r.paid_amount;
    } else if (r.bank_status === 'REJECTED') {
      txnStatus = 'REJECTED';
    }

    await dbRun(
      `INSERT INTO payment_transactions
        (registration_id, phone_number, amount, verified_amount, utr_number, screenshot, payment_mode,
         ocr_amount_match, ocr_vpa_match, ocr_utr_match, is_flagged, txn_status, bank_txn_id,
         rejection_reason, rejection_note, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.phone_number, r.paid_amount, verifiedAmount, r.utr_number, r.screenshot,
       r.payment_mode || 'UPI', r.ocr_amount_match, r.ocr_vpa_match, r.ocr_utr_match,
       r.is_flagged ? 1 : 0, txnStatus, r.bank_txn_id, r.rejection_reason, r.rejection_note,
       r.submitted_at]
    );
    seeded++;
  }

  if (seeded) console.log(`Seeded ${seeded} payment transaction(s) from legacy inline payments.`);
}

// Cumulative payment state for a registration, derived from its
// payment_transactions ledger. verifiedTotal sums the admin-acknowledged
// amount of every VERIFIED transaction (falling back to the claimed amount if
// an older verified row has no explicit verified_amount). fullyPaid is the gate
// for approval / receipt generation.
async function getPaymentSummary(registrationId, expectedAmount) {
  const txns = await dbAll(
    'SELECT * FROM payment_transactions WHERE registration_id = ? ORDER BY submitted_at ASC, id ASC',
    [registrationId]);
  const verifiedTotal = txns
    .filter((t) => t.txn_status === 'VERIFIED')
    .reduce((sum, t) => sum + (t.verified_amount != null ? t.verified_amount : (t.amount || 0)), 0);
  const fee = expectedAmount || 0;
  const remaining = Math.max(0, fee - verifiedTotal);
  return {
    txns,
    verifiedTotal,
    remaining,
    fee,
    fullyPaid: fee > 0 && verifiedTotal >= fee,
    hasPartial: verifiedTotal > 0 && verifiedTotal < fee,
  };
}

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
    const granted = roleGrants(req.session.role);
    if (!roles.some((r) => granted.includes(r))) {
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

// Autocomplete source for the signup form's Designation/Institute fields --
// distinct values already on file, so new delegates can pick an existing
// spelling instead of introducing a near-duplicate. Public (pre-auth, since
// this is needed while filling the signup form itself) and low-sensitivity
// (job titles and institution names only, no names/phone numbers).
app.get('/api/directory/suggestions', async (req, res, next) => {
  try {
    // GROUP BY LOWER(...) rather than SELECT DISTINCT so values that only
    // differ by case (e.g. a future row saved as "professor" alongside an
    // existing "Professor") still collapse to one suggestion; MIN() favors
    // the title-cased spelling whenever both exist, since SQLite's default
    // BINARY collation sorts uppercase letters before lowercase ones.
    const designations = await dbAll(
      `SELECT MIN(designation) AS designation FROM users WHERE designation IS NOT NULL AND TRIM(designation) != ''
       GROUP BY LOWER(designation) ORDER BY designation`);
    const institutions = await dbAll(
      `SELECT MIN(institution) AS institution FROM users WHERE institution IS NOT NULL AND TRIM(institution) != ''
       GROUP BY LOWER(institution) ORDER BY institution`);
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      designations: designations.map((r) => r.designation),
      institutions: institutions.map((r) => r.institution),
    });
  } catch (err) {
    next(err);
  }
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
    // Reflect the runtime SMS toggle: if a super admin has turned SMS off, the
    // OTP isn't sent, and (in dev) it's echoed so login still works.
    const smsWillSend = smsEnabled() && notifyToggle.sms;
    if (smsWillSend) sendOtpSms(phone, otp); // fire-and-forget; logs on failure

    const payload = { success: true, smsSent: smsWillSend };
    // Never echo the OTP once SMS delivery is actually happening.
    if (OTP_ECHO && !smsWillSend) payload.devOtp = otp;
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// Register (or update own profile) after OTP verification, then log in.
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const { phone, otp, salutation, name, designation, institute, pincode, state, district, age, gender, email } = req.body;
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Invalid phone number.' });
    }
    if (!name) {
      return res.status(400).json({ success: false, error: 'Full name is required.' });
    }
    // Always normalise the name to Title Case, so "pratiksha vasantrao
    // meshram", "JOHN SMITH", or "pratiksha Vasantrao meshram" all become
    // "Pratiksha Vasantrao Meshram". titleCase is idempotent, so a name
    // already in Title Case is returned unchanged.
    const nameVal = titleCase(name);
    const salutationVal = SALUTATIONS.includes(salutation) ? salutation : null;
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
      `INSERT INTO users (phone_number, salutation, full_name, designation, institution, pincode, state, district, age, gender, email, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DELEGATE', ?)
       ON CONFLICT(phone_number) DO UPDATE SET
         salutation = excluded.salutation,
         full_name = excluded.full_name,
         designation = excluded.designation,
         institution = excluded.institution,
         pincode = excluded.pincode,
         state = excluded.state,
         district = excluded.district,
         age = excluded.age,
         gender = excluded.gender,
         email = excluded.email,
         created_at = COALESCE(users.created_at, excluded.created_at)`,
      [phone, salutationVal, nameVal, designation, institute, pincode, state, district, ageNum, genderVal, emailVal, Date.now()]
    );

    await assignUserRegNumber(phone); // ensure a registration number exists
    const user = await dbGet('SELECT * FROM users WHERE phone_number = ?', [phone]);
    await startSession(phone, user.role, res);
    recordLogin(phone, user.full_name, user.role); // fire-and-forget
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
    recordLogin(phone, user.full_name, user.role); // fire-and-forget
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
    const { categoryKey, workshopOptionId, qiOptionId, amount, utr, screenshot, idCard, acknowledged, paymentMode, discountCode } = req.body;
    const mode = paymentMode === 'NEFT_RTGS' ? 'NEFT_RTGS' : 'UPI';

    const phone = req.session.phone; // never from the client
    const name = req.session.name;

    // Existing registration: reuse the id to free the delegate's own slot on
    // re-submission, and the old filenames for cleanup.
    const prev = await dbGet('SELECT id, screenshot, id_card, bank_status, category_key, category_locked, discount_code FROM registrations WHERE phone_number = ?', [phone]);
    const ownRegId = prev ? prev.id : null;

    // If an admin has locked this delegate's category, the client's choice is
    // ignored -- the fee is fixed to the locked category.
    const effectiveCategoryKey = (prev && prev.category_locked) ? prev.category_key : categoryKey;

    // Fee and label are derived server-side from the fee master at today's
    // pricing phase; the client's amount and label are not trusted.
    const feeInfo = await resolveFee(effectiveCategoryKey);
    if (!feeInfo) {
      return res.status(400).json({ success: false, error: 'Invalid delegate category.' });
    }
    const categoryLabel = feeInfo.label;

    // Discounts. Two possible sources, and the delegate gets the better one
    // (they don't stack): a promo code they entered, or a group discount if
    // they're in a qualifying group for this category. Both are re-validated
    // server-side; the client's computed fee is never trusted. Computed before
    // the utr/screenshot check below, since a fully-discounted (₹0)
    // registration needs neither.
    let promoDiscount = 0;
    let promoCode = null;
    let promoCodeId = null;
    if (discountCode && String(discountCode).trim() && String(discountCode).trim().toUpperCase() !== 'GROUP') {
      const dv = await validateDiscountCode(discountCode, phone, effectiveCategoryKey);
      if (!dv.ok) return res.status(400).json({ success: false, error: dv.error });
      promoDiscount = computeDiscountAmount(dv.code, feeInfo.amount);
      promoCode = dv.code.code;
      promoCodeId = dv.code.id;
    }
    let groupDiscount = 0;
    const dgroup = await getDelegateGroup(phone);
    if (dgroup && dgroup.qualifies && dgroup.group.category_key === effectiveCategoryKey) {
      groupDiscount = computeDiscountAmount(dgroup.rule, feeInfo.amount);
    }
    // 'GROUP' is the sentinel stored in discount_code for a group discount, so
    // reports and the revoke logic can tell it apart from a promo code.
    let discountAmount = 0;
    let discountCodeApplied = null;
    if (groupDiscount >= promoDiscount && groupDiscount > 0) {
      discountAmount = groupDiscount; discountCodeApplied = 'GROUP';
    } else if (promoDiscount > 0) {
      discountAmount = promoDiscount; discountCodeApplied = promoCode;
    }
    const expectedAmount = feeInfo.amount - discountAmount;
    const isFree = expectedAmount <= 0;

    // Log a promo code as "used" only the first time this delegate applies it
    // -- a resubmission after rejection reuses the same code (and doesn't
    // consume a second max_uses slot), so re-logging it would inflate the
    // usage trail with duplicate entries for one delegate's one real use.
    const isFirstUseOfPromo = !!promoCodeId && (!prev || prev.discount_code !== promoCode);

    if (!isFree && (!utr || !screenshot)) {
      return res.status(400).json({ success: false, error: 'Missing required registration details.' });
    }

    // Once submitted, payment details are locked: no further edits while
    // under review or after verification. Only a rejection re-opens editing
    // (the delegate needs to fix and resubmit), and a fresh submission is
    // always allowed when nothing exists yet.
    if (prev && prev.bank_status !== 'REJECTED') {
      return res.status(409).json({
        success: false,
        error: prev.bank_status === 'BANK_VERIFIED'
          ? 'Your registration is already confirmed; payment details cannot be changed.'
          : 'Your payment details have already been submitted and are locked pending verification. Contact the finance team if a correction is needed.',
      });
    }

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

    // Student categories must upload an ID card, checked against the category
    // -- this is an eligibility check, not a payment one, so it still applies
    // even when the fee is fully discounted to ₹0.
    const needsId = !!STUDENT_CATEGORIES[effectiveCategoryKey];
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

    // A ₹0 registration (fully covered by a promo/group discount) has no
    // payment to verify -- skip the screenshot/OCR/bank-linking pipeline
    // entirely and confirm it outright, rather than creating an unlinkable
    // ₹0 payment_transactions row that would sit stuck forever waiting for a
    // bank credit that will never arrive.
    if (isFree) {
      const idPass = needsId ? await runIdCardCheck(idDecoded.buffer, effectiveCategoryKey) : null;
      const idMatch = needsId ? (idPass ? 1 : 0) : null;
      const idFilename = idDecoded ? await writeUploadBuffer(idDecoded.buffer, idDecoded.ext) : null;

      await dbRun(
        `INSERT INTO registrations
          (phone_number, delegate_name, category_key, category_label, workshop, qi_exposure, workshop_option_id, qi_option_id, expected_amount, paid_amount, utr_number, screenshot, id_card, ocr_amount_match, ocr_vpa_match, ocr_utr_match, ocr_id_match, is_flagged, bank_status, rejection_reason, rejection_note, payment_mode, submitted_at, discount_code, discount_amount)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, ?, NULL, NULL, NULL, ?, 0, 'BANK_VERIFIED', NULL, NULL, NULL, ?, ?, ?)
          ON CONFLICT(phone_number) DO UPDATE SET
            delegate_name = excluded.delegate_name,
            category_key = excluded.category_key,
            category_label = excluded.category_label,
            workshop = excluded.workshop,
            qi_exposure = excluded.qi_exposure,
            workshop_option_id = excluded.workshop_option_id,
            qi_option_id = excluded.qi_option_id,
            expected_amount = 0,
            paid_amount = 0,
            utr_number = NULL,
            screenshot = NULL,
            id_card = excluded.id_card,
            ocr_amount_match = NULL,
            ocr_vpa_match = NULL,
            ocr_utr_match = NULL,
            ocr_id_match = excluded.ocr_id_match,
            is_flagged = 0,
            bank_status = 'BANK_VERIFIED',
            rejection_reason = NULL,
            rejection_note = NULL,
            payment_mode = NULL,
            submitted_at = excluded.submitted_at,
            discount_code = excluded.discount_code,
            discount_amount = excluded.discount_amount`,
        [phone, name, effectiveCategoryKey, categoryLabel, ws.opt ? ws.opt.name : null, qi.opt ? qi.opt.name : null, ws.opt ? ws.opt.id : null, qi.opt ? qi.opt.id : null,
          idFilename, idMatch, Date.now(), discountCodeApplied, discountAmount]
      );

      if (prev && prev.screenshot) await deleteScreenshotFile(prev.screenshot);
      if (prev && prev.id_card && prev.id_card !== idFilename) await deleteScreenshotFile(prev.id_card);

      const regNo = await assignUserRegNumber(phone);
      await dbRun('UPDATE registrations SET registration_number = ? WHERE phone_number = ?', [regNo, phone]);

      if (isFirstUseOfPromo) {
        writeAuditRow('discount_code', promoCodeId, 'DISCOUNT_CODE_USED', null, `${promoCode} used by ${name} (${phone}), reg ${regNo}`, phone, name, 'DELEGATE').catch(() => {});
      }

      notifyDelegate(phone, 'Registration confirmed',
        emailWrap('Your registration is confirmed',
          `<p>Dear ${escapeHtml(name)},</p>
           <p>Your registration for the ${escapeHtml(CONFERENCE.name)} is <b>confirmed</b> — a discount code brought your fee to ₹0, so no payment was required.</p>
           <p>Registration number: <b>${escapeHtml(regNo)}</b></p>`));

      return res.json({ success: true, expectedAmount: 0, checks: {}, flagged: false });
    }

    // Validate the payment screenshot (in memory; not written to disk yet).
    const decoded = decodeScreenshot(screenshot);
    if (decoded.error) {
      return res.status(400).json({ success: false, error: decoded.error });
    }

    // Read the screenshot (amount / UPI ID / UTR) and, for students, the ID card.
    // The VPA check only applies to UPI payments -- an NEFT/RTGS receipt has
    // no UPI ID to find, so that check is not applicable (treated as passed).
    const checks = await runOcrChecks(decoded.buffer, { expectedAmount, utr });
    if (mode === 'NEFT_RTGS') checks.vpa = true;
    if (needsId) checks.id = await runIdCardCheck(idDecoded.buffer, effectiveCategoryKey);
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
        (phone_number, delegate_name, category_key, category_label, workshop, qi_exposure, workshop_option_id, qi_option_id, expected_amount, paid_amount, utr_number, screenshot, id_card, ocr_amount_match, ocr_vpa_match, ocr_utr_match, ocr_id_match, is_flagged, bank_status, rejection_reason, rejection_note, payment_mode, submitted_at, discount_code, discount_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, ?, ?, ?, ?)
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
          rejection_note = NULL,
          payment_mode = excluded.payment_mode,
          submitted_at = excluded.submitted_at,
          discount_code = excluded.discount_code,
          discount_amount = excluded.discount_amount`,
      [phone, name, effectiveCategoryKey, categoryLabel, ws.opt ? ws.opt.name : null, qi.opt ? qi.opt.name : null, ws.opt ? ws.opt.id : null, qi.opt ? qi.opt.id : null,
        expectedAmount, paidAmount, utr, filename, idFilename,
        checks.amount ? 1 : 0, checks.vpa ? 1 : 0, checks.utr ? 1 : 0, idMatch, flagged, mode, Date.now(), discountCodeApplied, discountAmount]
    );

    if (prev && prev.screenshot && prev.screenshot !== filename) {
      await deleteScreenshotFile(prev.screenshot);
    }
    if (prev && prev.id_card && prev.id_card !== idFilename) {
      await deleteScreenshotFile(prev.id_card);
    }

    // The upsert may have been an UPDATE (resubmission after rejection), so
    // result.lastID isn't reliable -- look the id up by phone.
    const regRow = await dbGet('SELECT id FROM registrations WHERE phone_number = ?', [phone]);
    const registrationId = regRow ? regRow.id : result.lastID;

    // Record this submission in the payment_transactions ledger as a new
    // PENDING transaction. A resubmission only happens after a rejection (the
    // guard above blocks it otherwise), and rejection marks the prior
    // transaction REJECTED, so a fresh PENDING row is always the right thing
    // here -- the ledger keeps every attempt rather than overwriting it the
    // way the inline registrations columns do.
    await dbRun(
      `INSERT INTO payment_transactions
        (registration_id, phone_number, amount, utr_number, screenshot, payment_mode,
         ocr_amount_match, ocr_vpa_match, ocr_utr_match, is_flagged, txn_status, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      [registrationId, phone, paidAmount, utr, filename, mode,
       checks.amount ? 1 : 0, checks.vpa ? 1 : 0, checks.utr ? 1 : 0, flagged, Date.now()]
    );

    // Stamp the registration with the delegate's signup-assigned number.
    const regNo = await assignUserRegNumber(phone);
    await dbRun('UPDATE registrations SET registration_number = ? WHERE phone_number = ?', [regNo, phone]);

    if (isFirstUseOfPromo) {
      writeAuditRow('discount_code', promoCodeId, 'DISCOUNT_CODE_USED', null, `${promoCode} used by ${name} (${phone}), reg ${regNo}`, phone, name, 'DELEGATE').catch(() => {});
    }

    // In case a matching statement transaction was already imported before
    // this submission arrived, try to link it immediately.
    await autoLinkTransactions();

    // Acknowledge the payment; registration is confirmed later on verification.
    notifyDelegate(phone, 'Payment received — verification pending',
      emailWrap('We’ve received your payment details',
        `<p>Dear ${escapeHtml(name)},</p>
         <p>Thank you for submitting your payment for the ${escapeHtml(CONFERENCE.name)}.</p>
         <p>Your payment reference (<b>UTR ${escapeHtml(utr)}</b>) has been received and is now <b>pending verification</b> by our team.</p>
         <p>Registration number: <b>${escapeHtml(regNo)}</b></p>
         <p>Your registration will be <b>confirmed once your payment is verified</b> — you’ll receive a confirmation email at that point. No further action is needed for now.</p>`));

    res.json({ success: true, id: result.lastID, expectedAmount, checks, flagged: !!flagged });
  } catch (err) {
    console.error('Database Insert Error:', err);
    res.status(500).json({ success: false, error: 'Database save failed.' });
  }
});

// Submit a top-up payment toward an outstanding balance. Unlike the main
// submission, this doesn't touch the category/workshop/fee -- those are fixed
// once a partial payment has been acknowledged -- it just adds a new PENDING
// transaction to the ledger for the remaining amount. Allowed only while the
// registration is in PARTIAL_PAYMENT with a balance still due.
app.post('/api/registrations/topup', requireAuth, async (req, res, next) => {
  try {
    const { amount, utr, screenshot, paymentMode, acknowledged } = req.body;
    if (!utr || !screenshot) {
      return res.status(400).json({ success: false, error: 'A payment reference (UTR) and screenshot are required.' });
    }
    const mode = paymentMode === 'NEFT_RTGS' ? 'NEFT_RTGS' : 'UPI';
    const phone = req.session.phone;
    const name = req.session.name;

    const reg = await dbGet('SELECT id, bank_status, expected_amount FROM registrations WHERE phone_number = ?', [phone]);
    if (!reg) {
      return res.status(404).json({ success: false, error: 'No registration found to top up.' });
    }
    const summary = await getPaymentSummary(reg.id, reg.expected_amount);
    if (summary.remaining <= 0) {
      return res.status(400).json({ success: false, error: 'There is no outstanding balance on your registration.' });
    }

    const decoded = decodeScreenshot(screenshot);
    if (decoded.error) return res.status(400).json({ success: false, error: decoded.error });

    // OCR the top-up screenshot against the OUTSTANDING balance (that's what
    // this payment should be for), plus the usual VPA/UTR checks.
    const checks = await runOcrChecks(decoded.buffer, { expectedAmount: summary.remaining, utr });
    if (mode === 'NEFT_RTGS') checks.vpa = true;
    const allChecksPass = checks.amount && checks.vpa && checks.utr;
    if (!allChecksPass && !acknowledged) {
      return res.json({ success: false, needsConfirmation: true, checks, expectedAmount: summary.remaining });
    }

    const claimedAmount = Number(amount);
    const paidAmount = Number.isFinite(claimedAmount) ? claimedAmount : null;
    const amountTampered = !Number.isFinite(claimedAmount) || Math.round(claimedAmount) !== Math.round(summary.remaining);
    const flagged = !allChecksPass || amountTampered ? 1 : 0;

    const filename = await writeScreenshotBuffer(decoded.buffer, decoded.ext);
    await dbRun(
      `INSERT INTO payment_transactions
        (registration_id, phone_number, amount, utr_number, screenshot, payment_mode,
         ocr_amount_match, ocr_vpa_match, ocr_utr_match, is_flagged, txn_status, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      [reg.id, phone, paidAmount, utr, filename, mode,
       checks.amount ? 1 : 0, checks.vpa ? 1 : 0, checks.utr ? 1 : 0, flagged, Date.now()]
    );
    // Move back to PENDING: there's now a new payment for the admin to link
    // (and linking is the acknowledgement). The worklist keys on PENDING.
    await dbRun("UPDATE registrations SET bank_status = 'PENDING' WHERE id = ?", [reg.id]);
    await autoLinkTransactions();

    notifyDelegate(phone, 'Top-up payment received — verification pending',
      emailWrap('We’ve received your top-up payment',
        `<p>Dear ${escapeHtml(name)},</p>
         <p>Your top-up payment (<b>UTR ${escapeHtml(utr)}</b>) has been received and is now <b>pending verification</b>.</p>
         <p>Your registration will be confirmed once the full fee is verified. No further action is needed for now.</p>`));

    res.json({ success: true, checks, flagged: !!flagged });
  } catch (err) {
    console.error('Top-up Insert Error:', err);
    res.status(500).json({ success: false, error: 'Could not save top-up payment.' });
  }
});

// Targeted correction of a rejected submission, for the two standardized
// rejection reasons that don't require re-selecting category or fee:
//   - WRONG_DETAILS: fix the payment reference (UTR) without a new screenshot.
//   - WRONG_SCREENSHOT: re-upload the correct screenshot, keeping the details.
// Either or both fields may be supplied. This updates the rejected transaction
// in place (re-running OCR when a new screenshot is given) and re-opens the
// registration for review, rather than making the delegate redo everything.
app.post('/api/registrations/me/correct', requireAuth, async (req, res, next) => {
  try {
    const { utr, screenshot, paymentMode, acknowledged } = req.body;
    const phone = req.session.phone;

    const reg = await dbGet('SELECT id, bank_status, rejection_reason, expected_amount FROM registrations WHERE phone_number = ?', [phone]);
    if (!reg) return res.status(404).json({ success: false, error: 'No registration found.' });
    if (reg.bank_status !== 'REJECTED') {
      return res.status(409).json({ success: false, error: 'This registration is not awaiting a correction.' });
    }
    const CORRECTABLE = ['WRONG_DETAILS', 'WRONG_SCREENSHOT'];
    if (!CORRECTABLE.includes(reg.rejection_reason)) {
      return res.status(400).json({ success: false, error: 'This rejection needs a full resubmission, not a quick correction.' });
    }

    // The transaction to fix is the most recent rejected one on this registration.
    const txn = await dbGet(
      "SELECT * FROM payment_transactions WHERE registration_id = ? AND txn_status = 'REJECTED' ORDER BY submitted_at DESC, id DESC LIMIT 1",
      [reg.id]);
    if (!txn) return res.status(404).json({ success: false, error: 'No rejected payment found to correct.' });

    const newUtr = utr != null && String(utr).trim() ? String(utr).trim() : txn.utr_number;
    const mode = paymentMode === 'NEFT_RTGS' ? 'NEFT_RTGS' : (txn.payment_mode || 'UPI');

    // OCR the amount this transaction was originally for (a correction doesn't
    // change the amount), plus VPA/UTR.
    const ocrExpected = txn.amount != null ? txn.amount : reg.expected_amount;
    let newScreenshotName = txn.screenshot;
    let checks = { amount: txn.ocr_amount_match === 1, vpa: txn.ocr_vpa_match === 1, utr: txn.ocr_utr_match === 1 };

    if (screenshot) {
      const decoded = decodeScreenshot(screenshot);
      if (decoded.error) return res.status(400).json({ success: false, error: decoded.error });
      checks = await runOcrChecks(decoded.buffer, { expectedAmount: ocrExpected, utr: newUtr });
      if (mode === 'NEFT_RTGS') checks.vpa = true;
      const allPass = checks.amount && checks.vpa && checks.utr;
      if (!allPass && !acknowledged) {
        return res.json({ success: false, needsConfirmation: true, checks, expectedAmount: ocrExpected });
      }
      newScreenshotName = await writeScreenshotBuffer(decoded.buffer, decoded.ext);
    } else if (reg.rejection_reason === 'WRONG_SCREENSHOT') {
      return res.status(400).json({ success: false, error: 'Please upload the corrected screenshot.' });
    }
    if (reg.rejection_reason === 'WRONG_DETAILS' && !utr) {
      return res.status(400).json({ success: false, error: 'Please enter the corrected transaction reference.' });
    }

    const flagged = !(checks.amount && checks.vpa && checks.utr) ? 1 : 0;
    await dbRun(
      `UPDATE payment_transactions
          SET utr_number = ?, screenshot = ?, payment_mode = ?, txn_status = 'PENDING',
              ocr_amount_match = ?, ocr_vpa_match = ?, ocr_utr_match = ?, is_flagged = ?,
              rejection_reason = NULL, rejection_note = NULL, reviewed_by = NULL, reviewed_at = NULL,
              submitted_at = ?
        WHERE id = ?`,
      [newUtr, newScreenshotName, mode, checks.amount ? 1 : 0, checks.vpa ? 1 : 0, checks.utr ? 1 : 0, flagged, Date.now(), txn.id]);

    // If we replaced the screenshot file, remove the old one.
    if (screenshot && txn.screenshot && txn.screenshot !== newScreenshotName) {
      await deleteScreenshotFile(txn.screenshot);
    }

    // Mirror the corrected details onto the registration's inline columns and
    // re-open it for review.
    await dbRun(
      "UPDATE registrations SET utr_number = ?, screenshot = ?, payment_mode = ?, bank_status = 'PENDING', is_flagged = ?, rejection_reason = NULL, rejection_note = NULL WHERE id = ?",
      [newUtr, newScreenshotName, mode, flagged, reg.id]);

    await autoLinkTransactions();
    res.json({ success: true, checks, flagged: !!flagged });
  } catch (err) {
    console.error('Correction Error:', err);
    res.status(500).json({ success: false, error: 'Could not save your correction.' });
  }
});

// Looks up the delegate's current salutation (from users, by phone) so it
// can be attached to a name for display. Kept as a separate column rather
// than concatenated in SQL because registrations.delegate_name is a
// point-in-time snapshot from signup that may *already* carry an embedded
// title (e.g. "Dr Abhishek Raut") -- blindly prepending here would double
// it up. withDelegateSalutation() below reconciles the two.
const DELEGATE_SALUTATION_COLUMN =
  `(SELECT salutation FROM users WHERE users.phone_number = registrations.phone_number) AS delegate_salutation`;

// Columns to expose for a registration -- everything except the raw
// screenshot filename, plus a boolean the client can use to build the link.
// Columns are qualified with the registrations table where the name also
// exists on users (registration_number, phone_number) -- the admin list query
// LEFT JOINs users, which would otherwise make those ambiguous.
const REGISTRATION_PUBLIC_COLUMNS =
  `registrations.id, registrations.registration_number, registrations.phone_number, delegate_name, ${DELEGATE_SALUTATION_COLUMN}, category_key, category_label, workshop,
   qi_exposure, expected_amount, paid_amount, utr_number, is_flagged, bank_status,
   ocr_amount_match, ocr_vpa_match, ocr_utr_match, ocr_id_match, rejection_reason, rejection_note,
   payment_mode, submitted_at, id_verified, id_verified_by, id_verified_at, category_locked,
   (screenshot IS NOT NULL AND screenshot != '') AS has_screenshot,
   (id_card IS NOT NULL AND id_card != '') AS has_id_card`;

// Reconciles a row's delegate_name + delegate_salutation into a single
// display name with exactly one salutation: the delegate's current
// users.salutation if set, else whatever title was embedded in the
// signup-time name snapshot -- never both.
function withDelegateSalutation(row) {
  if (!row || !('delegate_name' in row)) return row;
  const { salutation: embedded, name: clean } = splitSalutation(row.delegate_name);
  const sal = row.delegate_salutation || embedded;
  row.delegate_name = sal ? `${sal} ${clean}` : clean;
  delete row.delegate_salutation;
  return row;
}

// Fetch the caller's own registration (replaces the old IDOR-prone
// /api/registrations/user/:phone route).
app.get('/api/registrations/me', requireAuth, async (req, res, next) => {
  try {
    const row = await dbGet(
      `SELECT ${REGISTRATION_PUBLIC_COLUMNS} FROM registrations WHERE phone_number = ?`,
      [req.session.phone]
    );
    if (!row) return res.json({ registration: null });

    // Cumulative payment state so the dashboard can show the outstanding
    // balance and decide whether to offer a top-up.
    const summary = await getPaymentSummary(row.id, row.expected_amount);
    const reg = withDelegateSalutation(row);
    reg.verified_total = summary.verifiedTotal;
    reg.remaining = summary.remaining;
    reg.pending_txn_count = summary.txns.filter((t) => t.txn_status === 'PENDING').length;
    res.json({ registration: reg });
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
    const cats = await dbAll('SELECT category_key, label, subtitle, early_fee, regular_fee, late_fee, spot_fee FROM fee_categories WHERE active = 1 ORDER BY sort_order, id');
    res.json({
      phase,
      earlyUntil: config ? config.early_until : null,
      regularUntil: config ? config.regular_until : null,
      lateUntil: config ? config.late_until : null,
      categories: cats.map((c) => ({
        key: c.category_key,
        label: c.label,
        subtitle: c.subtitle || '',
        fee: { early: c.early_fee, regular: c.regular_fee, late: c.late_fee, spot: c.spot_fee }[phase],
      })),
      upi: { id: UPI.id, payeeName: UPI.payeeName },
    });
  } catch (err) {
    next(err);
  }
});

// Validate a promo code for the caller against a chosen category, and return
// the resulting discounted fee so the payment form can preview it.
app.post('/api/discounts/validate', requireAuth, async (req, res, next) => {
  try {
    const { code, categoryKey } = req.body;
    const feeInfo = await resolveFee(categoryKey);
    if (!feeInfo) return res.status(400).json({ success: false, error: 'Select a valid category first.' });
    const result = await validateDiscountCode(code, req.session.phone, categoryKey);
    if (!result.ok) return res.json({ success: false, error: result.error });
    const discountAmount = computeDiscountAmount(result.code, feeInfo.amount);
    res.json({
      success: true,
      code: result.code.code,
      discountType: result.code.discount_type,
      discountValue: result.code.discount_value,
      baseFee: feeInfo.amount,
      discountAmount,
      finalFee: feeInfo.amount - discountAmount,
    });
  } catch (err) {
    next(err);
  }
});

// --- GROUP DISCOUNTS (delegate) -----------------------------------------

// Build a rich view of a group: members with names + registration status, the
// rule, whether it qualifies, and the per-member discount.
async function groupView(group) {
  const members = await dbAll(
    `SELECT gm.phone_number, gm.joined_at, u.full_name,
            (SELECT bank_status FROM registrations r WHERE r.phone_number = gm.phone_number) AS bank_status
       FROM group_members gm LEFT JOIN users u ON u.phone_number = gm.phone_number
      WHERE gm.group_id = ? ORDER BY gm.joined_at ASC`, [group.id]);
  const rule = await dbGet('SELECT * FROM group_discount_rules WHERE category_key = ? AND active = 1', [group.category_key]);
  const size = members.length;
  const qualifies = !!rule && size >= rule.min_size;
  const cat = await dbGet('SELECT label FROM fee_categories WHERE category_key = ?', [group.category_key]);
  const allVerified = size > 0 && members.every((m) => m.bank_status === 'BANK_VERIFIED');
  return {
    id: group.id, name: group.name, categoryKey: group.category_key, categoryLabel: cat ? cat.label : group.category_key,
    leaderPhone: group.leader_phone, size,
    minSize: rule ? rule.min_size : null,
    discountType: rule ? rule.discount_type : null,
    discountValue: rule ? rule.discount_value : null,
    qualifies, allVerified,
    members: members.map((m) => ({ phone: m.phone_number, name: m.full_name || '—', status: m.bank_status || 'NOT_REGISTERED' })),
  };
}

// The caller's group (or null), from their own perspective.
app.get('/api/groups/me', requireAuth, async (req, res, next) => {
  try {
    const m = await dbGet('SELECT group_id FROM group_members WHERE phone_number = ?', [req.session.phone]);
    if (!m) return res.json({ group: null });
    const group = await dbGet('SELECT * FROM delegate_groups WHERE id = ?', [m.group_id]);
    if (!group) return res.json({ group: null });
    const view = await groupView(group);
    view.isLeader = group.leader_phone === req.session.phone;
    res.json({ group: view });
  } catch (err) {
    next(err);
  }
});

// Categories that currently have an active group-discount rule, for the
// "start a group" picker.
app.get('/api/groups/eligible-categories', requireAuth, async (req, res, next) => {
  try {
    const rows = await dbAll(`
      SELECT r.category_key, r.min_size, r.discount_type, r.discount_value, c.label
        FROM group_discount_rules r JOIN fee_categories c ON c.category_key = r.category_key
       WHERE r.active = 1 ORDER BY c.sort_order, c.id`);
    res.json({ categories: rows });
  } catch (err) {
    next(err);
  }
});

// Start a group for a category that has a group-discount rule. The caller
// becomes leader and first member.
app.post('/api/groups', requireAuth, async (req, res, next) => {
  try {
    const categoryKey = String(req.body.categoryKey || '').trim();
    const name = req.body.name ? String(req.body.name).trim().slice(0, 80) : null;
    const rule = await dbGet('SELECT * FROM group_discount_rules WHERE category_key = ? AND active = 1', [categoryKey]);
    if (!rule) return res.status(400).json({ success: false, error: 'This category has no group discount.' });
    const already = await dbGet('SELECT group_id FROM group_members WHERE phone_number = ?', [req.session.phone]);
    if (already) return res.status(409).json({ success: false, error: 'You are already in a group. Leave it first.' });
    // A verified/locked registration in a different category can't join a group
    // for this one.
    const reg = await dbGet('SELECT category_key, bank_status FROM registrations WHERE phone_number = ?', [req.session.phone]);
    if (reg && reg.bank_status === 'BANK_VERIFIED' && reg.category_key !== categoryKey) {
      return res.status(400).json({ success: false, error: 'Your registration is already confirmed under a different category.' });
    }
    const result = await dbRun(
      'INSERT INTO delegate_groups (name, category_key, leader_phone, created_at) VALUES (?, ?, ?, ?)',
      [name, categoryKey, req.session.phone, Date.now()]);
    await dbRun('INSERT INTO group_members (group_id, phone_number, joined_at) VALUES (?, ?, ?)',
      [result.lastID, req.session.phone, Date.now()]);
    res.json({ success: true, groupId: result.lastID });
  } catch (err) {
    next(err);
  }
});

// Add a registered delegate to the caller's group (leader only).
app.post('/api/groups/:id/members', requireAuth, async (req, res, next) => {
  try {
    const group = await dbGet('SELECT * FROM delegate_groups WHERE id = ?', [req.params.id]);
    if (!group) return res.status(404).json({ success: false, error: 'Group not found.' });
    if (group.leader_phone !== req.session.phone) return res.status(403).json({ success: false, error: 'Only the group leader can add members.' });
    const phone = String(req.body.phone || '').replace(/\D/g, '');
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ success: false, error: 'Enter a valid 10-digit mobile number.' });
    const user = await dbGet('SELECT full_name FROM users WHERE phone_number = ?', [phone]);
    if (!user) return res.status(404).json({ success: false, error: 'No registered delegate with that mobile number.' });
    const inGroup = await dbGet('SELECT group_id FROM group_members WHERE phone_number = ?', [phone]);
    if (inGroup) return res.status(409).json({ success: false, error: 'That delegate is already in a group.' });
    const reg = await dbGet('SELECT category_key, bank_status FROM registrations WHERE phone_number = ?', [phone]);
    if (reg && reg.bank_status === 'BANK_VERIFIED' && reg.category_key !== group.category_key) {
      return res.status(400).json({ success: false, error: 'That delegate is already confirmed under a different category.' });
    }
    await dbRun('INSERT INTO group_members (group_id, phone_number, joined_at) VALUES (?, ?, ?)', [group.id, phone, Date.now()]);
    notifyDelegate(phone, 'You’ve been added to a group registration',
      emailWrap('Added to a group registration',
        `<p>Dear ${escapeHtml(user.full_name || 'Delegate')},</p>
         <p>You have been added to a group for the ${escapeHtml(CONFERENCE.name)} under the <b>${escapeHtml(group.category_key)}</b> category. Once the group reaches the required size, a group discount applies to your registration fee.</p>
         <p>Log in to the delegate portal to see your group and pay your (discounted) fee.</p>`));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Remove a member (leader removing someone, or a member leaving). Handles
// leader departure (promote the next member, or disband if empty) and revokes
// the discount for anyone left if the group drops below the threshold.
app.delete('/api/groups/:id/members/:phone', requireAuth, async (req, res, next) => {
  try {
    const group = await dbGet('SELECT * FROM delegate_groups WHERE id = ?', [req.params.id]);
    if (!group) return res.status(404).json({ success: false, error: 'Group not found.' });
    const target = String(req.params.phone || '').replace(/\D/g, '');
    const isLeader = group.leader_phone === req.session.phone;
    const isSelf = target === req.session.phone;
    if (!isLeader && !isSelf) return res.status(403).json({ success: false, error: 'You can only remove yourself, unless you are the leader.' });
    const member = await dbGet('SELECT id FROM group_members WHERE group_id = ? AND phone_number = ?', [group.id, target]);
    if (!member) return res.status(404).json({ success: false, error: 'That delegate is not in this group.' });

    await dbRun('DELETE FROM group_members WHERE group_id = ? AND phone_number = ?', [group.id, target]);

    const remaining = await dbAll('SELECT phone_number FROM group_members WHERE group_id = ? ORDER BY joined_at ASC', [group.id]);
    if (remaining.length === 0) {
      await dbRun('DELETE FROM delegate_groups WHERE id = ?', [group.id]);
    } else {
      if (group.leader_phone === target) {
        await dbRun('UPDATE delegate_groups SET leader_phone = ? WHERE id = ?', [remaining[0].phone_number, group.id]);
      }
      await revokeGroupDiscountIfBelowThreshold(group.id);
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// If a group has dropped below its rule's minimum, the discount no longer
// applies. Any member who already paid the discounted fee and was verified now
// owes the difference: revert their fee to the full amount, which puts them in
// PARTIAL_PAYMENT (balance due) via the existing top-up flow, and notify them.
async function revokeGroupDiscountIfBelowThreshold(groupId) {
  const group = await dbGet('SELECT * FROM delegate_groups WHERE id = ?', [groupId]);
  if (!group) return;
  const members = await dbAll('SELECT phone_number FROM group_members WHERE group_id = ?', [groupId]);
  const rule = await dbGet('SELECT * FROM group_discount_rules WHERE category_key = ? AND active = 1', [group.category_key]);
  if (rule && members.length >= rule.min_size) return; // still qualifies

  for (const m of members) {
    const reg = await dbGet('SELECT id, category_key, expected_amount, discount_amount, discount_code, bank_status, delegate_name, phone_number FROM registrations WHERE phone_number = ?', [m.phone_number]);
    // Only registrations that actually took THIS group discount (the 'GROUP'
    // sentinel) on the group's category need reverting -- promo discounts are
    // left alone.
    if (!reg || reg.discount_code !== 'GROUP' || !(reg.discount_amount > 0) || reg.category_key !== group.category_key) continue;
    const feeInfo = await resolveFee(reg.category_key);
    if (!feeInfo) continue;
    const fullFee = feeInfo.amount;
    if (Math.round(reg.expected_amount) >= Math.round(fullFee)) continue; // no discount in effect
    const summary = await getPaymentSummary(reg.id, fullFee);
    const newStatus = reg.bank_status === 'REJECTED' ? 'REJECTED'
      : (summary.verifiedTotal >= fullFee ? reg.bank_status : (summary.verifiedTotal > 0 ? 'PARTIAL_PAYMENT' : 'PENDING'));
    await dbRun('UPDATE registrations SET expected_amount = ?, discount_amount = 0, discount_code = NULL, bank_status = ? WHERE id = ?',
      [fullFee, newStatus, reg.id]);
    notifyDelegate(reg.phone_number, 'Group discount no longer applies — balance due',
      emailWrap('Your group discount has been withdrawn',
        `<p>Dear ${escapeHtml(reg.delegate_name || 'Delegate')},</p>
         <p>Your group has dropped below the minimum size required for the group discount, so the full registration fee of <b>₹${inr(escapeHtml(fullFee))}</b> now applies.</p>
         <p>An outstanding balance of <b>₹${inr(escapeHtml(Math.max(0, fullFee - summary.verifiedTotal)))}</b> is due. Please log in to the delegate portal to pay it.</p>`));
  }
}

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
      <h1>${escapeHtml(CONFERENCE.name)}</h1>
      <p>${escapeHtml([formatConferenceDates(), CONFERENCE.location].filter(Boolean).join(' · '))}</p>
    </div>
    <div class="body">
      <div class="num">
        <span class="label">Registration No.</span>
        <span class="value">${escapeHtml(reg.registration_number)}</span>
      </div>
      <table>
        ${row('Status', 'Confirmed — Payment Verified')}
        ${row('Delegate', (() => {
          const { salutation: embedded, name: clean } = splitSalutation(reg.delegate_name);
          const sal = (user && user.salutation) || embedded;
          return sal ? `${sal} ${clean}` : clean;
        })())}
        ${row('Designation', user ? user.designation : '')}
        ${row('Institution', user ? user.institution : '')}
        ${row('Mobile', '+91 ' + reg.phone_number)}
        ${row('Category', reg.category_label)}
        ${row('Workshop', reg.workshop)}
        ${row('QI Exposure', reg.qi_exposure)}
        ${row('Amount Paid', '₹' + inr(reg.expected_amount != null ? reg.expected_amount : reg.paid_amount))}
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

    const isFinance = req.session.role === 'SUPER_ADMIN' || roleGrants(req.session.role).includes('FINANCE_ADMIN');
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
    const isFinance = req.session.role === 'SUPER_ADMIN' || roleGrants(req.session.role).includes('FINANCE_ADMIN');
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
         <p>Thank you for submitting your abstract, <b>"${escapeHtml(cleanTitle)}"</b>, for the ${escapeHtml(CONFERENCE.name)}.</p>
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
    const isReviewer = req.session.role === 'SUPER_ADMIN' || roleGrants(req.session.role).includes('ACADEMIC_REVIEWER');
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
// Delegate geographic distribution for the approval page's overview map:
// per-district counts split into registered (has a registrations row) vs
// signed-up-only. Keyed on district; the client maps districts to coords.
app.get('/api/admin/delegate-locations', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const rows = await dbAll(`
      SELECT LOWER(TRIM(u.district)) AS district, TRIM(u.state) AS state,
        SUM(CASE WHEN r.phone_number IS NOT NULL THEN 1 ELSE 0 END) AS registered,
        SUM(CASE WHEN r.phone_number IS NULL THEN 1 ELSE 0 END) AS signedup
      FROM users u
      LEFT JOIN registrations r ON r.phone_number = u.phone_number
      WHERE u.pincode IS NOT NULL AND u.pincode != '' AND u.district IS NOT NULL AND TRIM(u.district) != ''
      GROUP BY LOWER(TRIM(u.district))`);
    res.json({ locations: rows || [] });
  } catch (err) {
    next(err);
  }
});

app.get('/api/registrations', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const rows = await dbAll(`
      SELECT ${REGISTRATION_PUBLIC_COLUMNS},
        registrations.bank_txn_id,
        u.designation AS delegate_designation, u.institution AS delegate_institution,
        u.age AS delegate_age, u.gender AS delegate_gender,
        t.post_date AS bank_txn_date, t.description AS bank_txn_description,
        t.credit AS bank_txn_credit, t.extracted_ref AS bank_txn_ref,
        (SELECT actor_name FROM audit_log a
           WHERE a.entity_type = 'registration' AND a.entity_id = CAST(registrations.id AS TEXT)
           ORDER BY a.id DESC LIMIT 1) AS last_action_by,
        (SELECT created_at FROM audit_log a
           WHERE a.entity_type = 'registration' AND a.entity_id = CAST(registrations.id AS TEXT)
           ORDER BY a.id DESC LIMIT 1) AS last_action_at
      FROM registrations
      LEFT JOIN users u ON u.phone_number = registrations.phone_number
      LEFT JOIN bank_statement_transactions t ON t.id = registrations.bank_txn_id
      ORDER BY registrations.id DESC`);

    // Attach the payment_transactions ledger + cumulative summary to each
    // registration. Fetched in one query and grouped in JS to avoid a
    // per-row round trip.
    const allTxns = await dbAll(
      `SELECT pt.id, pt.registration_id, pt.amount, pt.verified_amount, pt.utr_number, pt.payment_mode,
              pt.txn_status, pt.is_flagged, pt.bank_txn_id, pt.rejection_reason, pt.rejection_note, pt.submitted_at,
              pt.reviewed_by, pt.reviewed_at,
              (pt.screenshot IS NOT NULL AND pt.screenshot != '') AS has_screenshot,
              b.post_date AS bank_txn_date, b.credit AS bank_txn_credit, b.description AS bank_txn_description
         FROM payment_transactions pt
         LEFT JOIN bank_statement_transactions b ON b.id = pt.bank_txn_id
        ORDER BY pt.submitted_at ASC, pt.id ASC`);
    const txnsByReg = {};
    for (const t of allTxns) (txnsByReg[t.registration_id] ||= []).push(t);

    const enriched = (rows || []).map((r) => {
      const txns = txnsByReg[r.id] || [];
      const verifiedTotal = txns
        .filter((t) => t.txn_status === 'VERIFIED')
        .reduce((s, t) => s + (t.verified_amount != null ? t.verified_amount : (t.amount || 0)), 0);
      const fee = r.expected_amount || 0;
      const row = withDelegateSalutation(r);
      row.transactions = txns;
      row.verified_total = verifiedTotal;
      row.remaining = Math.max(0, fee - verifiedTotal);
      row.pending_txn_count = txns.filter((t) => t.txn_status === 'PENDING').length;
      return row;
    });
    res.json({ registrations: enriched });
  } catch (err) {
    next(err);
  }
});

// Reads a stored screenshot/ID-card value (usually a filename in
// uploads/, occasionally a legacy base64 data URI that predates the
// move to on-disk storage) into a Buffer for re-running OCR against it.
async function readStoredUpload(value) {
  if (!value) return null;
  if (/^data:image\//i.test(value)) {
    const m = /^data:image\/[a-z]+;base64,(.*)$/i.exec(value);
    return m ? Buffer.from(m[1], 'base64') : null;
  }
  try {
    return await fs.promises.readFile(path.join(UPLOAD_DIR, path.basename(value)));
  } catch {
    return null;
  }
}

// Re-runs the automated screenshot/ID-card checks against every registration
// that's ever been flagged -- pending, already approved, or rejected -- against
// its *already-uploaded* files. For when the OCR matching logic itself changes
// (e.g. a bug fix) and past submissions should be re-judged against the
// corrected logic instead of staying flagged on a stale, since-fixed false
// negative. Only touches the ocr_*_match/is_flagged columns, never
// bank_status -- an approval or rejection already made stays made; this just
// cleans up the flag/check data behind it.
app.post('/api/admin/registrations/rescan-flagged', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const rows = await dbAll(
      `SELECT id, registration_number, category_key, expected_amount, paid_amount, utr_number,
              screenshot, id_card, payment_mode
         FROM registrations WHERE is_flagged = 1`);

    let rescanned = 0;
    let unflagged = 0;
    let stillFlagged = 0;
    let skippedNoFile = 0;

    for (const reg of rows) {
      const buffer = await readStoredUpload(reg.screenshot);
      if (!buffer) { skippedNoFile++; continue; }

      const checks = await runOcrChecks(buffer, { expectedAmount: reg.expected_amount, utr: reg.utr_number });
      if (reg.payment_mode === 'NEFT_RTGS') checks.vpa = true;

      const needsId = !!STUDENT_CATEGORIES[reg.category_key];
      let idMatch = null;
      if (needsId) {
        const idBuffer = await readStoredUpload(reg.id_card);
        idMatch = idBuffer ? await runIdCardCheck(idBuffer, reg.category_key) : false;
      }

      const allChecksPass = checks.amount && checks.vpa && checks.utr && (!needsId || idMatch);
      const amountTampered = reg.paid_amount == null || Math.round(reg.paid_amount) !== reg.expected_amount;
      const flagged = !allChecksPass || amountTampered ? 1 : 0;

      await dbRun(
        `UPDATE registrations SET ocr_amount_match = ?, ocr_vpa_match = ?, ocr_utr_match = ?, ocr_id_match = ?, is_flagged = ? WHERE id = ?`,
        [checks.amount ? 1 : 0, checks.vpa ? 1 : 0, checks.utr ? 1 : 0, needsId ? (idMatch ? 1 : 0) : null, flagged, reg.id]
      );

      rescanned++;
      if (flagged) stillFlagged++; else unflagged++;
    }

    res.json({ success: true, totalFlagged: rows.length, rescanned, unflagged, stillFlagged, skippedNoFile });
  } catch (err) {
    next(err);
  }
});

// Finance reconciliation: update bank verification status (audited).
app.put('/api/registrations/:id/status', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const { bankStatus, rejectionReason, rejectionNote } = req.body;
    const allowed = ['PENDING', 'BANK_VERIFIED', 'REJECTED', 'PARTIAL_PAYMENT'];
    if (!allowed.includes(bankStatus)) {
      return res.status(400).json({ success: false, error: 'Invalid bank status.' });
    }

    // A rejection must state why, so the delegate gets the right resolution
    // path on their dashboard. These are the standardized reasons (see
    // REJECTION_RESOLUTIONS on the client). A balance due is handled by the
    // category-lock flow (fee raised -> top up), not by rejection. Legacy
    // codes (PAYMENT/ID) remain understood elsewhere for already-rejected rows.
    const REJECTION_REASONS = ['WRONG_DETAILS', 'WRONG_SCREENSHOT', 'WRONG_CATEGORY', 'ID_DISCREPANCY', 'OTHER'];
    let reason = null;
    let note = null;
    if (bankStatus === 'REJECTED') {
      if (!REJECTION_REASONS.includes(rejectionReason)) {
        return res.status(400).json({ success: false, error: 'A valid rejection reason is required.' });
      }
      reason = rejectionReason;
      note = rejectionNote ? String(rejectionNote).slice(0, 500) : null;
      if (reason === 'OTHER' && !note) {
        return res.status(400).json({ success: false, error: 'Please describe the reason for an "Other" rejection.' });
      }
    }

    const existing = await dbGet('SELECT bank_status, bank_txn_id, category_key, id_verified, paid_amount, expected_amount FROM registrations WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Registration not found.' });
    }

    // Verification requires this registration to be linked to a specific
    // bank statement transaction first -- either auto-matched by UTR on
    // upload/submission, or picked manually. This is what actually confirms
    // money landed in the account, rather than trusting the delegate's
    // self-reported UTR alone. Now enforced per transaction: every pending
    // payment being verified must be individually linked to its own statement
    // credit (1-to-1). Rejection never needs a link.
    if (bankStatus === 'BANK_VERIFIED') {
      const unlinked = await dbGet(
        "SELECT COUNT(*) AS n FROM payment_transactions WHERE registration_id = ? AND txn_status = 'PENDING' AND bank_txn_id IS NULL",
        [req.params.id]);
      if (unlinked && unlinked.n > 0) {
        return res.status(400).json({
          success: false,
          error: 'Every payment must be linked to its own bank statement transaction before verifying. Link the outstanding payment(s) in the transaction ledger first.',
        });
      }
    }

    // Student categories additionally require an approver to have confirmed
    // the uploaded ID card verifies that status (the automated OCR check is
    // only advisory) -- see PUT .../verify-id.
    if (bankStatus === 'BANK_VERIFIED' && STUDENT_CATEGORIES[existing.category_key] && !existing.id_verified) {
      return res.status(400).json({
        success: false,
        error: 'This is a student registration and its ID card has not been verified by an approver yet. Verify the student ID before approving.',
      });
    }

    // Cumulative-coverage gate: every linked payment is already acknowledged
    // (linking verifies it), so the covered total is the verified total. Only
    // allow BANK_VERIFIED once that reaches the fee. A shortfall means a
    // balance is still due -- the delegate must top it up (e.g. after a
    // category correction raised the fee) before the registration can be
    // confirmed.
    if (bankStatus === 'BANK_VERIFIED') {
      const summary = await getPaymentSummary(req.params.id, existing.expected_amount);
      if (existing.expected_amount > 0 && summary.verifiedTotal + 0.5 < existing.expected_amount) {
        return res.status(400).json({
          success: false,
          error: `Only ₹${inr(summary.verifiedTotal)} of the ₹${inr(existing.expected_amount)} fee has been received. The delegate must pay the ₹${inr(existing.expected_amount - summary.verifiedTotal)} balance before this can be confirmed.`,
        });
      }
    }

    // Approval is the resolution of a flag, not a reason to keep showing it --
    // once an admin has reviewed and verified a flagged registration, the
    // "Flagged" badge should disappear from the worklist/verified list rather
    // than following it forever. Rejection/pending leave is_flagged as-is so
    // the reviewer still sees why it was raised while it's still unresolved.
    const clearFlagSql = bankStatus === 'BANK_VERIFIED' ? ', is_flagged = 0' : '';
    await dbRun(
      `UPDATE registrations SET bank_status = ?, rejection_reason = ?, rejection_note = ?${clearFlagSql} WHERE id = ?`,
      [bankStatus, reason, note, req.params.id]
    );

    // Keep the payment_transactions ledger in step with the registration's
    // decision. In today's single-payment reality there's exactly one pending
    // transaction, so this verifies/rejects that one; the sync is written to
    // handle >1 pending transaction too (all pending rows move together),
    // which is what the upcoming top-up flow will produce.
    if (bankStatus === 'BANK_VERIFIED') {
      // Acknowledge the full claimed amount for the pending transaction(s).
      // The registration's bank_txn_id stays the authoritative 1-to-1 link in
      // today's model; per-transaction bank linking (and populating the
      // ledger's own bank_txn_id, which has a UNIQUE index) arrives with the
      // reconciliation step, so it's deliberately left untouched here.
      await dbRun(
        `UPDATE payment_transactions
            SET txn_status = 'VERIFIED',
                verified_amount = COALESCE(verified_amount, amount, ?),
                reviewed_by = ?, reviewed_at = ?
          WHERE registration_id = ? AND txn_status = 'PENDING'`,
        [existing.expected_amount, req.session.name || req.session.phone, Date.now(), req.params.id]
      );
    } else if (bankStatus === 'REJECTED') {
      await dbRun(
        `UPDATE payment_transactions
            SET txn_status = 'REJECTED', rejection_reason = ?, rejection_note = ?,
                reviewed_by = ?, reviewed_at = ?
          WHERE registration_id = ? AND txn_status = 'PENDING'`,
        [reason, note, req.session.name || req.session.phone, Date.now(), req.params.id]
      );
    } else if (bankStatus === 'PENDING') {
      // Re-opening a decided registration: reset its decided transactions back
      // to pending review so the ledger matches.
      await dbRun(
        `UPDATE payment_transactions
            SET txn_status = 'PENDING', verified_amount = NULL, reviewed_by = NULL, reviewed_at = NULL
          WHERE registration_id = ? AND txn_status IN ('VERIFIED', 'REJECTED')`,
        [req.params.id]
      );
    }

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
        const reasonText = {
          WRONG_DETAILS: 'the payment reference details did not match',
          WRONG_SCREENSHOT: 'the payment screenshot was unclear or incorrect',
          WRONG_CATEGORY: 'the delegate category selected was incorrect',
          ID_DISCREPANCY: 'your student ID could not be verified',
          OTHER: 'the reason noted below',
          // legacy
          PAYMENT: 'a payment discrepancy', ID: 'an ID verification issue',
        }[reason] || 'a discrepancy';
        const action = {
          WRONG_DETAILS: 'Please log in to the delegate portal and correct your payment reference details.',
          WRONG_SCREENSHOT: 'Please log in to the delegate portal and re-upload the correct payment screenshot.',
          WRONG_CATEGORY: 'Please log in to the delegate portal to select the correct category and pay any balance due.',
          ID_DISCREPANCY: 'Please log in to the delegate portal to upload a valid student ID, or switch to an appropriate category.',
        }[reason] || 'Please log in to the delegate portal to review and resubmit.';
        notifyDelegate(reg.phone_number, 'Action needed on your registration',
          emailWrap('Your registration needs attention',
            `<p>Dear ${escapeHtml(reg.delegate_name)},</p>
             <p>Your registration could not be verified because ${escapeHtml(reasonText)}${note ? `: <i>${escapeHtml(note)}</i>` : ''}.</p>
             <p>${escapeHtml(action)}</p>`));
      }
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Un-approve (revert) a verified registration back to PENDING. Restricted to
// SUPER_ADMIN -- reversing a confirmed registration is a heavier action than
// the normal verify/reject decision (which finance admins can do), so it's
// deliberately locked to the top role. Reverts the payment_transactions ledger
// in step (verified rows -> pending, verified_amount cleared) so the ledger
// stays consistent with the registration's status. Keeps the assigned
// registration_number so any receipt/reference already shared stays stable if
// it's later re-approved.
app.put('/api/registrations/:id/unapprove', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const existing = await dbGet('SELECT id, bank_status, delegate_name, phone_number FROM registrations WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Registration not found.' });
    if (existing.bank_status !== 'BANK_VERIFIED') {
      return res.status(400).json({ success: false, error: 'Only a verified registration can be un-approved.' });
    }

    await dbRun("UPDATE registrations SET bank_status = 'PENDING' WHERE id = ?", [req.params.id]);
    // Keep the ledger in step: an approval's verified transactions revert to
    // pending review so the cumulative verified total drops back accordingly.
    await dbRun(
      "UPDATE payment_transactions SET txn_status = 'PENDING', verified_amount = NULL, reviewed_by = NULL, reviewed_at = NULL WHERE registration_id = ? AND txn_status = 'VERIFIED'",
      [req.params.id]
    );

    await recordAudit({
      req,
      entityType: 'registration',
      entityId: req.params.id,
      action: 'BANK_STATUS_CHANGE',
      oldValue: 'BANK_VERIFIED',
      newValue: 'PENDING (un-approved)',
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Lock a delegate into the correct category (Finance/Super Admin). Used when a
// delegate picked the wrong category: the admin sets the right one, the fee is
// recalculated from the fee master, and the delegate can no longer change it on
// the portal. Any payments already verified are preserved; the registration's
// status is re-derived from the new fee (PARTIAL_PAYMENT if a balance is now
// due, PENDING otherwise) so the delegate is prompted for the difference.
app.put('/api/registrations/:id/lock-category', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const { categoryKey } = req.body;
    const feeInfo = await resolveFee(categoryKey);
    if (!feeInfo) return res.status(400).json({ success: false, error: 'Invalid category.' });

    const reg = await dbGet('SELECT id, phone_number, delegate_name, category_key, category_label, expected_amount, bank_status FROM registrations WHERE id = ?', [req.params.id]);
    if (!reg) return res.status(404).json({ success: false, error: 'Registration not found.' });

    const newFee = feeInfo.amount;
    // Locking only changes the category and fee. It does NOT itself ask the
    // delegate for more money or move the registration to "balance due" -- the
    // admin does that explicitly via Revise Payment, once the existing payment
    // is linked. A rejected registration re-opens for review.
    const newStatus = reg.bank_status === 'REJECTED' ? 'PENDING' : reg.bank_status;
    await dbRun(
      'UPDATE registrations SET category_key = ?, category_label = ?, expected_amount = ?, category_locked = 1, bank_status = ?, rejection_reason = NULL, rejection_note = NULL WHERE id = ?',
      [categoryKey, feeInfo.label, newFee, newStatus, reg.id]);

    await recordAudit({
      req, entityType: 'registration', entityId: req.params.id,
      action: 'CATEGORY_LOCK',
      oldValue: `${reg.category_label} (₹${inr(reg.expected_amount)})`,
      newValue: `${feeInfo.label} (₹${inr(newFee)}) — locked`,
    });

    const summary = await getPaymentSummary(reg.id, newFee);
    res.json({ success: true, expectedAmount: newFee, remaining: Math.max(0, newFee - summary.verifiedTotal) });
  } catch (err) {
    next(err);
  }
});

// Ask the delegate to pay the outstanding balance after a fee change (e.g. a
// category correction). Gated: the delegate's existing payment(s) must be
// linked/acknowledged first, so the balance is computed against what they've
// actually paid -- not the full new fee. Moves the registration to
// PARTIAL_PAYMENT (the balance-due section) and emails the delegate.
app.post('/api/registrations/:id/revise-payment', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const reg = await dbGet('SELECT id, phone_number, delegate_name, category_label, expected_amount, bank_status FROM registrations WHERE id = ?', [req.params.id]);
    if (!reg) return res.status(404).json({ success: false, error: 'Registration not found.' });
    if (reg.bank_status === 'BANK_VERIFIED' || reg.bank_status === 'REJECTED') {
      return res.status(400).json({ success: false, error: 'This registration is not awaiting a revised payment.' });
    }
    const summary = await getPaymentSummary(reg.id, reg.expected_amount);
    const pendingUnlinked = summary.txns.filter((t) => t.txn_status === 'PENDING');
    if (pendingUnlinked.length > 0) {
      return res.status(400).json({ success: false, error: 'Link the delegate’s existing payment to its bank transaction before revising — that acknowledges what they’ve already paid.' });
    }
    if (summary.verifiedTotal <= 0) {
      return res.status(400).json({ success: false, error: 'No payment has been acknowledged yet. Link the existing payment first.' });
    }
    const remaining = reg.expected_amount - summary.verifiedTotal;
    if (remaining <= 0) {
      return res.status(400).json({ success: false, error: 'The acknowledged payment already covers the fee — use Accept & Verify instead.' });
    }

    await dbRun("UPDATE registrations SET bank_status = 'PARTIAL_PAYMENT' WHERE id = ?", [reg.id]);
    await recordAudit({
      req, entityType: 'registration', entityId: req.params.id, action: 'PAYMENT_REVISED',
      oldValue: reg.bank_status, newValue: `PARTIAL_PAYMENT (paid ₹${inr(summary.verifiedTotal)}, ₹${inr(remaining)} balance)`,
    });
    notifyDelegate(reg.phone_number, 'Revised payment required — balance due',
      emailWrap('A balance is due on your registration',
        `<p>Dear ${escapeHtml(reg.delegate_name)},</p>
         <p>Your registration category is now <b>${escapeHtml(reg.category_label)}</b> with a fee of <b>₹${inr(escapeHtml(reg.expected_amount))}</b>. We have received <b>₹${inr(escapeHtml(summary.verifiedTotal))}</b>.</p>
         <p>An outstanding balance of <b>₹${inr(escapeHtml(remaining))}</b> is due. Please log in to the delegate portal to pay it.</p>`));
    res.json({ success: true, remaining });
  } catch (err) {
    next(err);
  }
});

// Unlock a category (Super Admin only) -- lets the delegate choose again.
app.delete('/api/registrations/:id/lock-category', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const reg = await dbGet('SELECT id, category_label FROM registrations WHERE id = ?', [req.params.id]);
    if (!reg) return res.status(404).json({ success: false, error: 'Registration not found.' });
    await dbRun('UPDATE registrations SET category_locked = 0 WHERE id = ?', [reg.id]);
    await recordAudit({
      req, entityType: 'registration', entityId: req.params.id,
      action: 'CATEGORY_UNLOCK', oldValue: `${reg.category_label} — locked`, newValue: 'unlocked',
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Approver confirmation that a student registration's uploaded ID card
// actually verifies that status. Required (see PUT .../status) before a
// student registration can be marked BANK_VERIFIED; the automated OCR check
// alone is advisory and never sufficient on its own.
app.put('/api/registrations/:id/verify-id', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const verified = !!req.body.verified;
    const existing = await dbGet('SELECT id, category_key, id_verified FROM registrations WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Registration not found.' });
    if (!STUDENT_CATEGORIES[existing.category_key]) {
      return res.status(400).json({ success: false, error: 'This category does not require student ID verification.' });
    }
    await dbRun(
      'UPDATE registrations SET id_verified = ?, id_verified_by = ?, id_verified_at = ? WHERE id = ?',
      [verified ? 1 : 0, verified ? req.session.name : null, verified ? Date.now() : null, existing.id]
    );
    await recordAudit({
      req, entityType: 'registration', entityId: req.params.id,
      action: 'STUDENT_ID_VERIFICATION', oldValue: existing.id_verified ? 'verified' : 'unverified', newValue: verified ? 'verified' : 'unverified',
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Candidate statement transactions for manually linking a registration --
// unused credits, closest-amount-first, so the admin can eyeball date and
// description (e.g. an IMPS/NEFT credit with no machine-readable reference)
// and pick the right one.
app.get('/api/registrations/:id/candidate-transactions', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const reg = await dbGet('SELECT id, paid_amount, expected_amount FROM registrations WHERE id = ?', [req.params.id]);
    if (!reg) return res.status(404).json({ success: false, error: 'Registration not found.' });
    const targetAmount = reg.paid_amount != null ? reg.paid_amount : reg.expected_amount;
    const rows = await dbAll(
      `SELECT * FROM bank_statement_transactions
        WHERE credit IS NOT NULL AND credit > 0
          AND id NOT IN (SELECT bank_txn_id FROM registrations WHERE bank_txn_id IS NOT NULL)
        ORDER BY ABS(COALESCE(credit, 0) - ?) ASC, post_date DESC
        LIMIT 50`,
      [targetAmount || 0]
    );
    res.json({ transactions: rows });
  } catch (err) {
    next(err);
  }
});

// Manually link a registration to a specific statement transaction (e.g. an
// IMPS/NEFT credit that can't be auto-matched by reference number).
app.put('/api/registrations/:id/link-transaction', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const { transactionId } = req.body;
    const reg = await dbGet('SELECT id, bank_txn_id FROM registrations WHERE id = ?', [req.params.id]);
    if (!reg) return res.status(404).json({ success: false, error: 'Registration not found.' });
    const txn = await dbGet('SELECT id FROM bank_statement_transactions WHERE id = ?', [transactionId]);
    if (!txn) return res.status(404).json({ success: false, error: 'Statement transaction not found.' });
    const usedBy = await dbGet('SELECT id, registration_number FROM registrations WHERE bank_txn_id = ? AND id != ?', [transactionId, reg.id]);
    if (usedBy) {
      return res.status(409).json({ success: false, error: `That transaction is already linked to registration ${usedBy.registration_number || usedBy.id}.` });
    }
    await dbRun('UPDATE registrations SET bank_txn_id = ? WHERE id = ?', [transactionId, reg.id]);
    await recordAudit({
      req, entityType: 'registration', entityId: req.params.id,
      action: 'BANK_TXN_LINK', oldValue: reg.bank_txn_id, newValue: transactionId,
    });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ success: false, error: 'That transaction is already linked to another registration.' });
    }
    next(err);
  }
});

// Undo a link (auto- or manual), e.g. if the wrong transaction was picked.
app.delete('/api/registrations/:id/link-transaction', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const reg = await dbGet('SELECT id, bank_txn_id FROM registrations WHERE id = ?', [req.params.id]);
    if (!reg) return res.status(404).json({ success: false, error: 'Registration not found.' });
    await dbRun('UPDATE registrations SET bank_txn_id = NULL WHERE id = ?', [reg.id]);
    await recordAudit({
      req, entityType: 'registration', entityId: req.params.id,
      action: 'BANK_TXN_UNLINK', oldValue: reg.bank_txn_id, newValue: null,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// A bank statement credit is "used" if it's linked from either the legacy
// registration-level column OR a payment transaction. Per-transaction linking
// is the current mechanism; the registration column persists for older rows.
const USED_BANK_TXN_SUBQUERY =
  `(SELECT bank_txn_id FROM registrations WHERE bank_txn_id IS NOT NULL
    UNION SELECT bank_txn_id FROM payment_transactions WHERE bank_txn_id IS NOT NULL)`;

// Candidate statement credits for a specific payment transaction, nearest to
// its amount first, excluding any already linked (to a registration or another
// transaction).
app.get('/api/payment-transactions/:txnId/candidates', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const txn = await dbGet('SELECT id, amount FROM payment_transactions WHERE id = ?', [req.params.txnId]);
    if (!txn) return res.status(404).json({ success: false, error: 'Payment transaction not found.' });
    const rows = await dbAll(
      `SELECT * FROM bank_statement_transactions
        WHERE credit IS NOT NULL AND credit > 0
          AND id NOT IN ${USED_BANK_TXN_SUBQUERY}
        ORDER BY ABS(COALESCE(credit, 0) - ?) ASC, post_date DESC
        LIMIT 50`,
      [txn.amount || 0]);
    res.json({ transactions: rows });
  } catch (err) {
    next(err);
  }
});

// Link one payment transaction to one bank statement credit (1-to-1), which
// ALSO acknowledges (verifies) that payment: linking is the acknowledgement,
// so there's no separate "enter the amount received" step -- the amount is the
// transaction's own amount, confirmed against the linked credit. The UNIQUE
// index on payment_transactions.bank_txn_id is the final backstop; the explicit
// checks give a clearer error.
app.put('/api/payment-transactions/:txnId/link', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const { bankTxnId } = req.body;
    const txn = await dbGet('SELECT id, registration_id, bank_txn_id, amount, txn_status FROM payment_transactions WHERE id = ?', [req.params.txnId]);
    if (!txn) return res.status(404).json({ success: false, error: 'Payment transaction not found.' });
    if (txn.txn_status === 'REJECTED') {
      return res.status(400).json({ success: false, error: 'This payment was rejected and cannot be linked.' });
    }
    const bank = await dbGet('SELECT id FROM bank_statement_transactions WHERE id = ?', [bankTxnId]);
    if (!bank) return res.status(404).json({ success: false, error: 'Statement transaction not found.' });

    const usedByTxn = await dbGet('SELECT id FROM payment_transactions WHERE bank_txn_id = ? AND id != ?', [bankTxnId, txn.id]);
    const usedByReg = await dbGet('SELECT registration_number FROM registrations WHERE bank_txn_id = ? AND id != ?', [bankTxnId, txn.registration_id]);
    if (usedByTxn || usedByReg) {
      return res.status(409).json({ success: false, error: 'That bank transaction is already linked to another payment.' });
    }

    // Linking acknowledges the payment at its own claimed amount, so it must
    // not push the registration's cumulative verified total past the fee
    // actually due -- catches the exact bug found with Divya Selokar
    // (a duplicate resubmission transaction wrongly linked to a second, real
    // credit, over-crediting her registration and stranding someone else's
    // payment). Skipped for a registration with no fee on record.
    const reg = await dbGet('SELECT expected_amount FROM registrations WHERE id = ?', [txn.registration_id]);
    if (reg && reg.expected_amount > 0) {
      const summary = await getPaymentSummary(txn.registration_id, reg.expected_amount);
      const wouldBeTotal = summary.verifiedTotal + (txn.amount || 0);
      if (wouldBeTotal > reg.expected_amount + 0.5) {
        return res.status(400).json({
          success: false,
          error: `Linking this payment (₹${inr(txn.amount)}) would bring the total acknowledged to ₹${inr(wouldBeTotal)}, which is more than the ₹${inr(reg.expected_amount)} fee due. Check whether this credit really belongs to this registration.`,
        });
      }
    }

    // Linking acknowledges the payment at its own amount.
    await dbRun(
      `UPDATE payment_transactions
          SET bank_txn_id = ?, txn_status = 'VERIFIED', verified_amount = amount,
              reviewed_by = ?, reviewed_at = ?
        WHERE id = ?`,
      [bankTxnId, req.session.name || req.session.phone, Date.now(), txn.id]);
    await recordAudit({
      req, entityType: 'registration', entityId: String(txn.registration_id),
      action: 'BANK_TXN_LINK', oldValue: txn.bank_txn_id, newValue: `txn#${txn.id} → bank#${bankTxnId} (₹${inr(txn.amount)} acknowledged)`,
    });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ success: false, error: 'That bank transaction is already linked to another payment.' });
    }
    next(err);
  }
});

// Unlink a payment transaction, which also un-acknowledges it (back to pending).
app.delete('/api/payment-transactions/:txnId/link', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const txn = await dbGet('SELECT id, registration_id, bank_txn_id FROM payment_transactions WHERE id = ?', [req.params.txnId]);
    if (!txn) return res.status(404).json({ success: false, error: 'Payment transaction not found.' });
    await dbRun(
      `UPDATE payment_transactions
          SET bank_txn_id = NULL, txn_status = 'PENDING', verified_amount = NULL,
              reviewed_by = NULL, reviewed_at = NULL
        WHERE id = ? AND txn_status != 'REJECTED'`,
      [txn.id]);
    await recordAudit({
      req, entityType: 'registration', entityId: String(txn.registration_id),
      action: 'BANK_TXN_UNLINK', oldValue: `txn#${txn.id} → bank#${txn.bank_txn_id}`, newValue: null,
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
    const rows = await dbAll(
      `SELECT users.*, r.bank_status AS registration_status,
         r.workshop_option_id, r.workshop, r.qi_option_id, r.qi_exposure
         FROM users
         LEFT JOIN registrations r ON r.phone_number = users.phone_number`);
    res.json({ users: rows || [] });
  } catch (err) {
    next(err);
  }
});

// Full profile for the Users side-panel: demography, contact, registration +
// payment ledger, workshop/QI enrollment, and a best-effort signup date.
app.get('/api/users/:phone/detail', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const phone = req.params.phone;
    const user = await dbGet('SELECT * FROM users WHERE phone_number = ?', [phone]);
    if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

    const reg = await dbGet(
      `SELECT r.*, ws.name AS workshop_name, qi.name AS qi_name
         FROM registrations r
         LEFT JOIN program_options ws ON ws.id = r.workshop_option_id
         LEFT JOIN program_options qi ON qi.id = r.qi_option_id
        WHERE r.phone_number = ?`, [phone]);

    let payment = null;
    if (reg) payment = await getPaymentSummary(reg.id, reg.expected_amount);

    res.json({
      success: true,
      user,
      registration: reg || null,
      payment,
      signup_at: user.created_at || null,
    });
  } catch (err) {
    next(err);
  }
});

// Edit a user's demographic / contact details (super admin only). Role and
// registration data are managed through their own endpoints; this only
// touches the profile fields.
app.put('/api/users/:phone', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const phone = req.params.phone;
    const existing = await dbGet('SELECT phone_number FROM users WHERE phone_number = ?', [phone]);
    if (!existing) return res.status(404).json({ success: false, error: 'User not found.' });

    const b = req.body || {};
    const fields = ['salutation', 'full_name', 'designation', 'institution', 'email',
      'age', 'gender', 'pincode', 'state', 'district'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(b, f)) {
        sets.push(`${f} = ?`);
        params.push(b[f] === '' ? null : b[f]);
      }
    }
    if (!sets.length) return res.status(400).json({ success: false, error: 'Nothing to update.' });
    params.push(phone);
    await dbRun(`UPDATE users SET ${sets.join(', ')} WHERE phone_number = ?`, params);
    res.json({ success: true });
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
      'INSERT INTO users (phone_number, full_name, designation, institution, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [phone, name, designation, institute, role, Date.now()]
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

// --- REGISTRATION REMINDERS ----------------------------------------------
// "Signed up" (has a users row, created their account / OTP-verified) but
// never "registered" (no row in registrations at all -- they never
// submitted payment details, as distinct from a submitted-but-unverified
// PENDING registration).
const PENDING_SIGNUP_QUERY =
  `SELECT u.phone_number, u.salutation, u.full_name, u.email,
     (SELECT MAX(created_at) FROM audit_log a
        WHERE a.entity_type = 'reminder_email' AND a.action = 'REGISTRATION_REMINDER_SENT' AND a.entity_id = u.phone_number
     ) AS last_reminder_sent_at
     FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM registrations r WHERE r.phone_number = u.phone_number)
     ORDER BY u.full_name`;

app.get('/api/admin/reminders/pending-signups', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const rows = await dbAll(PENDING_SIGNUP_QUERY);
    res.json({ users: rows || [] });
  } catch (err) {
    next(err);
  }
});

// Sends the reminder to the caller's own email only, so wording/formatting
// can be checked before the irreversible bulk send below. {{name}} is
// substituted with the admin's own name, same as a real recipient would see.
app.post('/api/admin/reminders/test-send', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { subject, bodyHtml } = req.body;
    if (!subject || !String(subject).trim()) {
      return res.status(400).json({ success: false, error: 'Subject is required.' });
    }
    if (!bodyHtml || !String(bodyHtml).trim()) {
      return res.status(400).json({ success: false, error: 'Email body is required.' });
    }
    if (!emailEnabled()) {
      return res.status(400).json({ success: false, error: 'Email is not configured on this server.' });
    }

    const me = await dbGet('SELECT salutation, full_name, email FROM users WHERE phone_number = ?', [req.session.phone]);
    if (!me || !me.email) {
      return res.status(400).json({ success: false, error: 'No email on file for your own account.' });
    }

    const name = [me.salutation, me.full_name].filter(Boolean).join(' ') || 'Delegate';
    const personalizedBody = String(bodyHtml).split('{{name}}').join(escapeHtml(name));
    await sendEmail(me.email, `[TEST] ${subject}`, emailWrap(subject, personalizedBody));

    res.json({ success: true, sentTo: me.email });
  } catch (err) {
    next(err);
  }
});

// Sends a reminder email to everyone who's signed up but never registered.
// {{name}} in the body is replaced per-recipient with "Salutation Full Name".
// Deliberately SUPER_ADMIN only (unlike the read above) since this is a
// one-way bulk email blast to real delegates -- nothing to undo if wrong.
app.post('/api/admin/reminders/send', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { subject, bodyHtml, phones } = req.body;
    if (!subject || !String(subject).trim()) {
      return res.status(400).json({ success: false, error: 'Subject is required.' });
    }
    if (!bodyHtml || !String(bodyHtml).trim()) {
      return res.status(400).json({ success: false, error: 'Email body is required.' });
    }
    if (!emailEnabled()) {
      return res.status(400).json({ success: false, error: 'Email is not configured on this server.' });
    }
    // phones: an explicit list of who to send to (the admin's selection in
    // the UI). Required -- there's no implicit "everyone" fallback, so a
    // stale/empty selection can't silently turn into a full blast.
    if (!Array.isArray(phones) || !phones.length) {
      return res.status(400).json({ success: false, error: 'Select at least one delegate to send to.' });
    }
    const phoneSet = new Set(phones.map(String));

    // A reminder already sent to this phone number in the last 24 hours
    // (any admin, any wording) blocks sending another -- rolling window,
    // not calendar-day, so 11pm and 1am the next day still count as inside
    // the same 24h. One audit row per successful send (entity_id =
    // phone_number) is what makes this queryable.
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const sentRecentlyRows = await dbAll(
      `SELECT DISTINCT entity_id FROM audit_log
        WHERE entity_type = 'reminder_email' AND action = 'REGISTRATION_REMINDER_SENT' AND created_at >= ?`,
      [since]
    );
    const sentRecentlySet = new Set(sentRecentlyRows.map((r) => r.entity_id));

    const recipients = (await dbAll(PENDING_SIGNUP_QUERY)).filter((u) => phoneSet.has(u.phone_number));
    let sent = 0;
    let skippedNoEmail = 0;
    let skippedSentRecently = 0;
    for (const u of recipients) {
      if (sentRecentlySet.has(u.phone_number)) { skippedSentRecently++; continue; }
      if (!u.email) { skippedNoEmail++; continue; }
      const name = [u.salutation, u.full_name].filter(Boolean).join(' ') || 'Delegate';
      const personalizedBody = String(bodyHtml).split('{{name}}').join(escapeHtml(name));
      await sendEmail(u.email, subject, emailWrap(subject, personalizedBody));
      await recordAudit({
        req, entityType: 'reminder_email', entityId: u.phone_number,
        action: 'REGISTRATION_REMINDER_SENT', oldValue: null, newValue: subject,
      });
      sent++;
    }

    res.json({ success: true, sent, skippedNoEmail, skippedSentRecently, total: recipients.length });
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
    await recordAudit({
      req, entityType: 'program_option', entityId: result.lastID,
      action: 'PROGRAM_OPTION_CREATE', oldValue: null, newValue: `${type}: ${String(name).trim()} (capacity ${capacity})`,
    });
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

    const updated = {
      name: name !== undefined ? String(name).trim() : existing.name,
      capacity: capacity !== undefined ? capacity : existing.capacity,
      active: active !== undefined ? (active ? 1 : 0) : existing.active,
    };
    await dbRun(
      'UPDATE program_options SET name = ?, capacity = ?, active = ? WHERE id = ?',
      [updated.name, updated.capacity, updated.active, req.params.id]
    );
    await recordAudit({
      req, entityType: 'program_option', entityId: req.params.id,
      action: 'PROGRAM_OPTION_UPDATE',
      oldValue: `${existing.name} (capacity ${existing.capacity}, ${existing.active ? 'active' : 'inactive'})`,
      newValue: `${updated.name} (capacity ${updated.capacity}, ${updated.active ? 'active' : 'inactive'})`,
    });
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
    await recordAudit({
      req, entityType: 'program_option', entityId: req.params.id,
      action: 'PROGRAM_OPTION_DELETE', oldValue: `${opt.type}: ${opt.name}`, newValue: null,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// List delegates currently enrolled in one workshop/QI option (manual roster
// view, alongside the capacity count already shown in the list).
app.get('/api/admin/program-options/:id/enrolled', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const opt = await dbGet('SELECT * FROM program_options WHERE id = ?', [req.params.id]);
    if (!opt) return res.status(404).json({ success: false, error: 'Option not found.' });
    const col = opt.type === 'WORKSHOP' ? 'workshop_option_id' : 'qi_option_id';
    const facultyCol = opt.type === 'WORKSHOP' ? 'workshop_is_faculty' : 'qi_is_faculty';
    const rows = await dbAll(
      `SELECT id, phone_number, delegate_name, ${DELEGATE_SALUTATION_COLUMN}, registration_number, bank_status, ${facultyCol} AS is_faculty
         FROM registrations WHERE ${col} = ? AND bank_status != 'REJECTED' ORDER BY ${facultyCol} DESC, delegate_name`,
      [opt.id]
    );
    res.json({ option: opt, enrolled: rows.map(withDelegateSalutation) });
  } catch (err) {
    next(err);
  }
});

// Manually enroll a delegate (by phone) into a workshop/QI option, bypassing
// the normal self-service capacity check -- an admin override for edge cases
// (a delegate who paid offline, a late add, correcting a mistaken choice).
app.post('/api/admin/program-options/:id/enroll', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const opt = await dbGet('SELECT * FROM program_options WHERE id = ?', [req.params.id]);
    if (!opt) return res.status(404).json({ success: false, error: 'Option not found.' });
    const phone = String(req.body.phone || '').trim();
    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Invalid phone number.' });
    }
    const reg = await dbGet('SELECT id, workshop_option_id, qi_option_id FROM registrations WHERE phone_number = ?', [phone]);
    if (!reg) {
      return res.status(404).json({ success: false, error: 'This delegate has no payment registration yet -- they must register before being enrolled.' });
    }
    const col = opt.type === 'WORKSHOP' ? 'workshop_option_id' : 'qi_option_id';
    const nameCol = opt.type === 'WORKSHOP' ? 'workshop' : 'qi_exposure';
    const facultyCol = opt.type === 'WORKSHOP' ? 'workshop_is_faculty' : 'qi_is_faculty';
    // Reset the faculty flag on (re-)enroll: it belongs to a specific
    // option assignment, so moving someone to a different workshop/QI
    // shouldn't silently carry their old faculty status over.
    await dbRun(`UPDATE registrations SET ${col} = ?, ${nameCol} = ?, ${facultyCol} = 0 WHERE id = ?`, [opt.id, opt.name, reg.id]);
    await recordAudit({
      req, entityType: 'registration', entityId: reg.id,
      action: 'ADMIN_ENROLL', oldValue: opt.type === 'WORKSHOP' ? reg.workshop_option_id : reg.qi_option_id, newValue: opt.id,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Mark/unmark an enrolled delegate as faculty for this specific workshop/QI
// option. Faculty stay attached to the option (visible on its roster and
// report) but are excluded from the capacity count -- see
// fetchProgramOptions().
app.put('/api/admin/program-options/:id/enrolled/:phone/faculty', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const opt = await dbGet('SELECT * FROM program_options WHERE id = ?', [req.params.id]);
    if (!opt) return res.status(404).json({ success: false, error: 'Option not found.' });
    const col = opt.type === 'WORKSHOP' ? 'workshop_option_id' : 'qi_option_id';
    const facultyCol = opt.type === 'WORKSHOP' ? 'workshop_is_faculty' : 'qi_is_faculty';
    const reg = await dbGet(`SELECT id FROM registrations WHERE phone_number = ? AND ${col} = ?`, [req.params.phone, opt.id]);
    if (!reg) return res.status(404).json({ success: false, error: 'This delegate is not enrolled in this option.' });
    const isFaculty = req.body.isFaculty ? 1 : 0;
    await dbRun(`UPDATE registrations SET ${facultyCol} = ? WHERE id = ?`, [isFaculty, reg.id]);
    await recordAudit({
      req, entityType: 'registration', entityId: reg.id,
      action: 'ADMIN_SET_FACULTY', oldValue: opt.id, newValue: isFaculty ? 'FACULTY' : 'DELEGATE',
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Remove a delegate from a workshop/QI option's roster (clears their choice;
// does not touch their registration otherwise).
app.delete('/api/admin/program-options/:id/enroll/:phone', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const opt = await dbGet('SELECT * FROM program_options WHERE id = ?', [req.params.id]);
    if (!opt) return res.status(404).json({ success: false, error: 'Option not found.' });
    const col = opt.type === 'WORKSHOP' ? 'workshop_option_id' : 'qi_option_id';
    const nameCol = opt.type === 'WORKSHOP' ? 'workshop' : 'qi_exposure';
    const facultyCol = opt.type === 'WORKSHOP' ? 'workshop_is_faculty' : 'qi_is_faculty';
    const reg = await dbGet(`SELECT id FROM registrations WHERE phone_number = ? AND ${col} = ?`, [req.params.phone, opt.id]);
    if (!reg) return res.status(404).json({ success: false, error: 'This delegate is not enrolled in this option.' });
    await dbRun(`UPDATE registrations SET ${col} = NULL, ${nameCol} = NULL, ${facultyCol} = 0 WHERE id = ?`, [reg.id]);
    await recordAudit({
      req, entityType: 'registration', entityId: reg.id,
      action: 'ADMIN_UNENROLL', oldValue: opt.id, newValue: null,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- FEE MASTER ADMIN ---------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const feeFields = (b) => ({
  early: Number(b.earlyFee), regular: Number(b.regularFee), late: Number(b.lateFee), spot: Number(b.spotFee),
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

// --- DISCOUNT CODES (admin) ---------------------------------------------
// Each code is annotated with how many registrations currently hold it
// (applied) and how many of those are verified, so the admin sees real usage.
app.get('/api/admin/discount-codes', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const codes = await dbAll(`
      SELECT d.*,
        (SELECT COUNT(*) FROM registrations r WHERE UPPER(r.discount_code) = d.code AND r.bank_status != 'REJECTED') AS applied_count,
        (SELECT COUNT(*) FROM registrations r WHERE UPPER(r.discount_code) = d.code AND r.bank_status = 'BANK_VERIFIED') AS verified_count
      FROM discount_codes d ORDER BY d.created_at DESC`);
    res.json({ codes });
  } catch (err) {
    next(err);
  }
});

function parseDiscountBody(body) {
  const code = String(body.code || '').trim().toUpperCase();
  const discountType = body.discountType === 'FLAT' ? 'FLAT' : 'PERCENT';
  const discountValue = Number(body.discountValue);
  const scopeType = ['GLOBAL', 'CATEGORY', 'INDIVIDUAL'].includes(body.scopeType) ? body.scopeType : 'GLOBAL';
  let scopeValue = scopeType === 'GLOBAL' ? null : String(body.scopeValue || '').trim();
  if (scopeType === 'INDIVIDUAL') scopeValue = scopeValue.replace(/\D/g, ''); // phone digits
  // An individual code is single-delegate by nature, so a usage cap is
  // irrelevant -- always store it as unlimited (the scope check limits use).
  const maxUses = scopeType === 'INDIVIDUAL' ? null
    : (body.maxUses === '' || body.maxUses == null ? null : Math.max(0, parseInt(body.maxUses, 10) || 0));
  const expiresAt = body.expiresAt ? String(body.expiresAt).trim() : null; // YYYY-MM-DD
  return { code, discountType, discountValue, scopeType, scopeValue, maxUses, expiresAt };
}

function validateDiscountFields(f) {
  if (!f.code || !/^[A-Z0-9_-]{2,40}$/.test(f.code)) return 'Code must be 2–40 letters, digits, hyphens or underscores.';
  if (!Number.isFinite(f.discountValue) || f.discountValue <= 0) return 'Discount value must be greater than zero.';
  if (f.discountType === 'PERCENT' && f.discountValue > 100) return 'A percentage discount cannot exceed 100.';
  if (f.scopeType === 'CATEGORY' && !f.scopeValue) return 'Choose a category for a category-scoped code.';
  if (f.scopeType === 'INDIVIDUAL' && !/^\d{10}$/.test(f.scopeValue || '')) return 'Enter a valid 10-digit mobile number for an individual code.';
  return null;
}

app.post('/api/admin/discount-codes', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const f = parseDiscountBody(req.body);
    const err = validateDiscountFields(f);
    if (err) return res.status(400).json({ success: false, error: err });
    const result = await dbRun(
      `INSERT INTO discount_codes (code, discount_type, discount_value, scope_type, scope_value, max_uses, expires_at, active, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [f.code, f.discountType, f.discountValue, f.scopeType, f.scopeValue, f.maxUses, f.expiresAt, Date.now(), req.session.name || req.session.phone]);
    await recordAudit({
      req, entityType: 'discount_code', entityId: result.lastID, action: 'DISCOUNT_CODE_CREATE',
      oldValue: null, newValue: `${f.code} — ${f.discountType === 'PERCENT' ? f.discountValue + '%' : '₹' + inr(f.discountValue)} (${f.scopeType}${f.scopeValue ? ':' + f.scopeValue : ''})`,
    });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ success: false, error: 'A code with that name already exists.' });
    next(err);
  }
});

app.put('/api/admin/discount-codes/:id', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const existing = await dbGet('SELECT * FROM discount_codes WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Code not found.' });
    // Only active toggle and max_uses/expiry are editable after creation (the
    // code string and discount are fixed once delegates may have redeemed it).
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : existing.active;
    const maxUses = req.body.maxUses === undefined ? existing.max_uses
      : (req.body.maxUses === '' || req.body.maxUses == null ? null : Math.max(0, parseInt(req.body.maxUses, 10) || 0));
    const expiresAt = req.body.expiresAt === undefined ? existing.expires_at : (req.body.expiresAt ? String(req.body.expiresAt).trim() : null);
    await dbRun('UPDATE discount_codes SET active = ?, max_uses = ?, expires_at = ? WHERE id = ?', [active, maxUses, expiresAt, req.params.id]);
    await recordAudit({
      req, entityType: 'discount_code', entityId: req.params.id, action: 'DISCOUNT_CODE_UPDATE',
      oldValue: `${existing.active ? 'active' : 'inactive'}, max ${existing.max_uses || '∞'}`,
      newValue: `${active ? 'active' : 'inactive'}, max ${maxUses || '∞'}`,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/admin/discount-codes/:id', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const existing = await dbGet('SELECT * FROM discount_codes WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Code not found.' });
    const used = await dbGet("SELECT COUNT(*) AS n FROM registrations WHERE UPPER(discount_code) = ? AND bank_status != 'REJECTED'", [existing.code]);
    if (used && used.n > 0) {
      return res.status(409).json({ success: false, error: `This code is in use by ${used.n} registration(s). Deactivate it instead of deleting.` });
    }
    await dbRun('DELETE FROM discount_codes WHERE id = ?', [req.params.id]);
    await recordAudit({
      req, entityType: 'discount_code', entityId: req.params.id, action: 'DISCOUNT_CODE_DELETE',
      oldValue: existing.code, newValue: null,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Printable one-page voucher for a discount code -- same "open in a new tab,
// window.print() to save as PDF" pattern as reportHtml(), so no PDF library
// is needed. Also backs the admin's "Share" action alongside a copyable
// WhatsApp message (built client-side from the same /api/admin/discount-codes
// list data, so this endpoint only needs to handle the PDF/print path).
app.get('/api/admin/discount-codes/:id/share', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const code = await dbGet('SELECT * FROM discount_codes WHERE id = ?', [req.params.id]);
    if (!code) return res.status(404).send('Discount code not found.');

    let scopeLine = 'Valid for any delegate.';
    if (code.scope_type === 'CATEGORY') {
      const cat = await dbGet('SELECT label FROM fee_categories WHERE category_key = ?', [code.scope_value]);
      scopeLine = `Valid for the "${escapeHtml(cat ? cat.label : code.scope_value)}" category only.`;
    } else if (code.scope_type === 'INDIVIDUAL') {
      const u = await dbGet('SELECT full_name FROM users WHERE phone_number = ?', [code.scope_value]);
      scopeLine = `Reserved for ${escapeHtml(u ? u.full_name : 'this delegate')} (+91 ${escapeHtml(code.scope_value || '')}) only.`;
    }
    const discountLine = code.discount_type === 'PERCENT' ? `${Number(code.discount_value)}% off` : `₹${inr(Number(code.discount_value))} off`;
    const expiryLine = code.expires_at ? `Valid through ${escapeHtml(code.expires_at)}.` : 'No expiry date set.';

    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Discount Code ${escapeHtml(code.code)}</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;margin:2rem;display:flex;justify-content:center;}
  .card{max-width:420px;width:100%;border:2px dashed #4f46e5;border-radius:16px;padding:2rem;text-align:center;}
  .eyebrow{font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:#6366f1;font-weight:700;}
  h1{font-size:.95rem;margin:.35rem 0 1.25rem;color:#312e81;}
  .code{font-family:ui-monospace,Menlo,monospace;font-size:2.25rem;font-weight:800;letter-spacing:.1em;background:#eef2ff;border-radius:12px;padding:1rem;margin:0 0 1rem;color:#312e81;}
  .discount{font-size:1.1rem;font-weight:700;color:#047857;margin-bottom:.75rem;}
  p{font-size:.82rem;color:#475569;margin:.35rem 0;}
  .actions{margin-top:1.5rem;}
  button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:.6rem 1.4rem;font-weight:700;cursor:pointer;font-size:.85rem;}
  @media print{body{margin:0;}.actions{display:none;}.card{border-style:solid;}}
</style></head><body>
  <div class="card">
    <div class="eyebrow">NQOCN 2026 · Discount Code</div>
    <h1>${escapeHtml(CONFERENCE.name)}</h1>
    <div class="code">${escapeHtml(code.code)}</div>
    <div class="discount">${discountLine}</div>
    <p>${scopeLine}</p>
    <p>${expiryLine}</p>
    <p>Register at <b>${escapeHtml(PORTAL_URL)}</b> and enter this code under "Apply promo code" on the payment step.</p>
    <div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
  </div>
</body></html>`);
  } catch (err) {
    next(err);
  }
});

// --- GROUP DISCOUNT RULES (admin) ---------------------------------------
app.get('/api/admin/group-rules', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const rules = await dbAll('SELECT * FROM group_discount_rules ORDER BY created_at DESC');
    res.json({ rules });
  } catch (err) {
    next(err);
  }
});

// --- NOTIFICATION TOGGLES (super admin) ---------------------------------
// Settings → General: SMS/Email/UPI operational config plus the on/off
// toggles. Credentials (apiKey, AWS keys) are never included in the response
// -- only whether they're present, so the admin can tell why a channel is
// unavailable without the secret itself ever reaching the browser.
// Every env var the app knows how to read, beyond the SMS/Email/UPI fields
// already editable above -- shown read-only in Settings → General so an
// admin can see the full picture of what's actually running, not just
// what's in .env. None of these are secret, so the *effective* value is
// shown (the resolved runtime constant, same as what the server actually
// used at boot) rather than the raw env var -- most of these run on their
// coded-in default with nothing in .env at all, and showing "not set" for
// those would look broken even though it's accurate.
function describeOtherEnvVars() {
  return [
    { key: 'PORT', value: String(PORT), fromEnv: process.env.PORT !== undefined },
    { key: 'PORTAL_URL', value: PORTAL_URL, fromEnv: process.env.PORTAL_URL !== undefined },
    { key: 'NODE_ENV', value: process.env.NODE_ENV || '(unset)', fromEnv: process.env.NODE_ENV !== undefined },
    { key: 'COOKIE_SECURE', value: String(COOKIE_SECURE), fromEnv: process.env.COOKIE_SECURE !== undefined },
    { key: 'OTP_ECHO', value: String(OTP_ECHO), fromEnv: process.env.OTP_ECHO !== undefined },
  ];
}

app.get('/api/admin/general-settings', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    res.json({
      sms: {
        // The SMS API key is a bearer secret -- send only whether it's set, no
        // real bytes (not even a masked tail), so nothing sensitive reaches the
        // browser. See maskSecret's note on why the Access Key ID differs.
        enabled: notifyToggle.sms, available: smsEnabled(), hasApiKey: !!SMS.apiKey,
        sender: SMS.sender, url: SMS.url, entityId: SMS.entityId, templateId: SMS.templateId, headerId: SMS.headerId, type: SMS.type,
      },
      email: {
        enabled: notifyToggle.email, available: emailEnabled(), hasCredentials: awsCredsPresent(),
        // Access Key ID is not a bearer secret (it's the public half, like a
        // username), so a last-4 preview is fine and helps confirm which key is
        // active. The Secret Access Key IS a bearer secret -- send only a
        // boolean, never any real bytes.
        accessKeyMasked: maskSecret(process.env.AWS_ACCESS_KEY_ID), hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY,
        from: EMAIL.from, fromName: EMAIL.fromName, region: EMAIL.region,
      },
      upi: { id: UPI.id, payeeName: UPI.payeeName },
      conference: { name: CONFERENCE.name, acronym: CONFERENCE.acronym, startDate: CONFERENCE.startDate, endDate: CONFERENCE.endDate, location: CONFERENCE.location },
      otherEnvVars: describeOtherEnvVars(),
    });
  } catch (err) {
    next(err);
  }
});

app.put('/api/admin/general-settings', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { sms, email, upi, conference, notify } = req.body || {};

    // Reject line breaks in the credential fields up front, before anything is
    // persisted, so a bad paste can't inject extra .env lines and a malformed
    // request doesn't partially apply. (writeEnvVar also guards this, but this
    // returns a clean 400 instead of a generic 500.)
    for (const [label, raw] of [
      ['SMS API key', sms && sms.apiKey], ['AWS Access Key ID', email && email.awsAccessKeyId], ['AWS Secret Access Key', email && email.awsSecretAccessKey],
    ]) {
      if (raw !== undefined && raw !== null && /[\r\n]/.test(String(raw))) {
        return res.status(400).json({ success: false, error: `${label} must not contain line breaks.` });
      }
    }

    // Reject blanking a currently-set operational field, up front. The old
    // code silently skipped an empty value (treating "cleared" the same as
    // "untouched") yet still returned success -- so an admin who blanked a
    // field saw "saved" while the old value was quietly kept. These fields are
    // all required for their channel to work, so a clear is a mistake worth
    // surfacing rather than silently ignoring.
    for (const [group, target, labels] of [
      [sms, SMS, { sender: 'Sender ID', url: 'Gateway URL', entityId: 'DLT Entity ID', templateId: 'DLT Template ID', headerId: 'DLT Header ID', type: 'Message Type' }],
      [email, EMAIL, { from: 'From address', fromName: 'From name', region: 'AWS Region' }],
      [upi, UPI, { id: 'UPI ID', payeeName: 'Payee Name' }],
      [conference, CONFERENCE, { name: 'Conference Name' }], // acronym/dates/location are optional and may be cleared
    ]) {
      if (!group) continue;
      for (const field of Object.keys(labels)) {
        if (group[field] === undefined) continue;
        if (!String(group[field]).trim() && (target[field] || '')) {
          return res.status(400).json({ success: false, error: `${labels[field]} cannot be blank.` });
        }
      }
    }

    const changes = [];
    const setKV = (key, value) => dbRun(
      "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);

    // optionalFields: fields allowed to be cleared to blank (written and
    // logged as empty) rather than the default "blank means untouched, skip
    // it" behavior -- for fields that are genuinely optional (e.g. a
    // conference's dates/location before they're finalized), skipping a
    // deliberate clear would silently keep stale text, the same class of bug
    // as an unconditional blank-reject would be for a required field.
    async function applyFields(group, target, fieldToKey, optionalFields = new Set()) {
      if (!group) return;
      for (const [field, key] of Object.entries(fieldToKey)) {
        if (group[field] === undefined) continue;
        const val = String(group[field]).trim();
        if (val === target[field]) continue;
        if (!val && !optionalFields.has(field)) continue;
        changes.push(`${key}: "${target[field]}" → "${val || '(blank)'}"`);
        target[field] = val;
        await setKV(key, val);
      }
    }

    await applyFields(sms, SMS, { sender: 'sms_sender', url: 'sms_url', entityId: 'sms_entity_id', templateId: 'sms_template_id', headerId: 'sms_header_id', type: 'sms_type' });
    await applyFields(email, EMAIL, { from: 'email_from', fromName: 'email_from_name', region: 'email_region' });
    await applyFields(upi, UPI, { id: 'upi_id', payeeName: 'upi_payee_name' });
    await applyFields(conference, CONFERENCE,
      { name: 'conference_name', acronym: 'conference_acronym', startDate: 'conference_start_date', endDate: 'conference_end_date', location: 'conference_location' },
      new Set(['acronym', 'startDate', 'endDate', 'location']));

    // Credentials persist to .env, never to schema_meta. The change log records
    // only that a key changed, never any bytes of a bearer secret (SMS API key,
    // AWS secret); the Access Key ID isn't a bearer secret so its tail is fine.
    // Newlines were already rejected at the top of the handler.
    let credsChanged = false;
    if (sms && sms.apiKey !== undefined && String(sms.apiKey).trim()) {
      const val = String(sms.apiKey).trim();
      if (val !== SMS.apiKey) {
        SMS.apiKey = val;
        writeEnvVar('SMS_API_KEY', val);
        changes.push('SMS API key changed');
        credsChanged = true;
      }
    }
    if (email && email.awsAccessKeyId !== undefined && String(email.awsAccessKeyId).trim()) {
      const val = String(email.awsAccessKeyId).trim();
      if (val !== process.env.AWS_ACCESS_KEY_ID) {
        writeEnvVar('AWS_ACCESS_KEY_ID', val);
        changes.push(`AWS Access Key ID changed (now ends ${maskSecret(val)})`);
        credsChanged = true;
      }
    }
    if (email && email.awsSecretAccessKey !== undefined && String(email.awsSecretAccessKey).trim()) {
      const val = String(email.awsSecretAccessKey).trim();
      if (val !== process.env.AWS_SECRET_ACCESS_KEY) {
        writeEnvVar('AWS_SECRET_ACCESS_KEY', val);
        changes.push('AWS Secret Access Key changed');
        credsChanged = true;
      }
    }
    if (email || credsChanged) rebuildSesClient(); // region/from/credentials changed -- the old client is stale otherwise

    if (notify) {
      if (notify.sms !== undefined) {
        notifyToggle.sms = !!notify.sms;
        await setKV('notify_sms_enabled', notifyToggle.sms ? '1' : '0');
        changes.push(`SMS ${notifyToggle.sms ? 'on' : 'off'}`);
      }
      if (notify.email !== undefined) {
        notifyToggle.email = !!notify.email;
        await setKV('notify_email_enabled', notifyToggle.email ? '1' : '0');
        changes.push(`Email ${notifyToggle.email ? 'on' : 'off'}`);
      }
    }

    if (changes.length) {
      await recordAudit({ req, entityType: 'general_settings', entityId: 'general', action: 'GENERAL_SETTINGS_UPDATE', oldValue: null, newValue: changes.join('; ') });
    }
    res.json({ success: true, sms: notifyToggle.sms, email: notifyToggle.email });
  } catch (err) {
    next(err);
  }
});

// Admin monitoring: every group with its members and their verification states.
app.get('/api/admin/groups', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const groups = await dbAll('SELECT * FROM delegate_groups ORDER BY created_at DESC');
    const views = [];
    for (const g of groups) views.push(await groupView(g));
    res.json({ groups: views });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/group-rules', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const categoryKey = String(req.body.categoryKey || '').trim();
    const minSize = Math.max(2, parseInt(req.body.minSize, 10) || 5);
    const discountType = req.body.discountType === 'FLAT' ? 'FLAT' : 'PERCENT';
    const discountValue = Number(req.body.discountValue);
    const cat = await dbGet('SELECT category_key FROM fee_categories WHERE category_key = ?', [categoryKey]);
    if (!cat) return res.status(400).json({ success: false, error: 'Choose a valid category.' });
    if (!Number.isFinite(discountValue) || discountValue <= 0) return res.status(400).json({ success: false, error: 'Discount value must be greater than zero.' });
    if (discountType === 'PERCENT' && discountValue > 100) return res.status(400).json({ success: false, error: 'A percentage discount cannot exceed 100.' });
    await dbRun(
      `INSERT INTO group_discount_rules (category_key, min_size, discount_type, discount_value, active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(category_key) DO UPDATE SET min_size = excluded.min_size, discount_type = excluded.discount_type, discount_value = excluded.discount_value, active = 1`,
      [categoryKey, minSize, discountType, discountValue, Date.now()]);
    await recordAudit({
      req, entityType: 'group_rule', entityId: categoryKey, action: 'GROUP_RULE_SET',
      oldValue: null, newValue: `${categoryKey}: ≥${minSize} → ${discountType === 'PERCENT' ? discountValue + '%' : '₹' + inr(discountValue)}`,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.put('/api/admin/group-rules/:id', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const rule = await dbGet('SELECT * FROM group_discount_rules WHERE id = ?', [req.params.id]);
    if (!rule) return res.status(404).json({ success: false, error: 'Rule not found.' });
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : rule.active;
    await dbRun('UPDATE group_discount_rules SET active = ? WHERE id = ?', [active, req.params.id]);
    await recordAudit({
      req, entityType: 'group_rule', entityId: rule.category_key, action: 'GROUP_RULE_UPDATE',
      oldValue: rule.active ? 'active' : 'inactive', newValue: active ? 'active' : 'inactive',
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/admin/group-rules/:id', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const rule = await dbGet('SELECT * FROM group_discount_rules WHERE id = ?', [req.params.id]);
    if (!rule) return res.status(404).json({ success: false, error: 'Rule not found.' });
    await dbRun('DELETE FROM group_discount_rules WHERE id = ?', [req.params.id]);
    await recordAudit({
      req, entityType: 'group_rule', entityId: rule.category_key, action: 'GROUP_RULE_DELETE',
      oldValue: rule.category_key, newValue: null,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.put('/api/admin/fees/config', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { earlyUntil, regularUntil, lateUntil } = req.body;
    if ([earlyUntil, regularUntil, lateUntil].some((d) => d && !DATE_RE.test(d))) {
      return res.status(400).json({ success: false, error: 'Dates must be YYYY-MM-DD.' });
    }
    if (earlyUntil && regularUntil && earlyUntil > regularUntil) {
      return res.status(400).json({ success: false, error: 'Early cutoff must be on or before the regular cutoff.' });
    }
    if (regularUntil && lateUntil && regularUntil > lateUntil) {
      return res.status(400).json({ success: false, error: 'Regular cutoff must be on or before the late cutoff.' });
    }
    const existing = await getFeeConfig();
    await dbRun('UPDATE fee_config SET early_until = ?, regular_until = ?, late_until = ? WHERE id = 1',
      [earlyUntil || null, regularUntil || null, lateUntil || null]);
    await recordAudit({
      req, entityType: 'fee_config', entityId: 1,
      action: 'FEE_CONFIG_UPDATE',
      oldValue: existing ? `early≤${existing.early_until || '—'}, regular≤${existing.regular_until || '—'}, late≤${existing.late_until || '—'}` : null,
      newValue: `early≤${earlyUntil || '—'}, regular≤${regularUntil || '—'}, late≤${lateUntil || '—'}`,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/fees/categories', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { categoryKey, label, subtitle } = req.body;
    const f = feeFields(req.body);
    if (!categoryKey || !/^[a-z0-9_]+$/.test(categoryKey)) {
      return res.status(400).json({ success: false, error: 'Category key must be lowercase letters, digits, or underscores.' });
    }
    if (!label || !String(label).trim()) return res.status(400).json({ success: false, error: 'Label is required.' });
    if ([f.early, f.regular, f.late, f.spot].some((x) => !Number.isFinite(x) || x < 0)) {
      return res.status(400).json({ success: false, error: 'Fees must be non-negative numbers.' });
    }
    const max = await dbGet('SELECT COALESCE(MAX(sort_order), -1) AS m FROM fee_categories');
    const result = await dbRun(
      'INSERT INTO fee_categories (category_key, label, subtitle, early_fee, regular_fee, late_fee, spot_fee, active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
      [categoryKey, String(label).trim(), subtitle ? String(subtitle).trim() : '', f.early, f.regular, f.late, f.spot, max.m + 1]
    );
    await recordAudit({
      req, entityType: 'fee_category', entityId: result.lastID,
      action: 'FEE_CATEGORY_CREATE', oldValue: null,
      newValue: `${categoryKey} "${String(label).trim()}" — early ₹${inr(f.early)}, regular ₹${inr(f.regular)}, late ₹${inr(f.late)}, spot ₹${inr(f.spot)}`,
    });
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
    const { active } = req.body;
    const f = feeFields(req.body);
    if ([f.early, f.regular, f.late, f.spot].some((x) => !Number.isFinite(x) || x < 0)) {
      return res.status(400).json({ success: false, error: 'Fees must be non-negative numbers.' });
    }
    // Label and subtitle are set once at category creation and are not
    // editable afterwards -- only fees and active status can be updated here.
    const updated = {
      active: active !== undefined ? (active ? 1 : 0) : existing.active,
    };
    await dbRun(
      'UPDATE fee_categories SET early_fee = ?, regular_fee = ?, late_fee = ?, spot_fee = ?, active = ? WHERE id = ?',
      [f.early, f.regular, f.late, f.spot, updated.active, req.params.id]
    );
    await recordAudit({
      req, entityType: 'fee_category', entityId: req.params.id,
      action: 'FEE_CATEGORY_UPDATE',
      oldValue: `${existing.label} — early ₹${inr(existing.early_fee)}, regular ₹${inr(existing.regular_fee)}, late ₹${inr(existing.late_fee)}, spot ₹${inr(existing.spot_fee)}, ${existing.active ? 'active' : 'inactive'}`,
      newValue: `${existing.label} — early ₹${inr(f.early)}, regular ₹${inr(f.regular)}, late ₹${inr(f.late)}, spot ₹${inr(f.spot)}, ${updated.active ? 'active' : 'inactive'}`,
    });
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
    await recordAudit({
      req, entityType: 'fee_category', entityId: req.params.id,
      action: 'FEE_CATEGORY_DELETE', oldValue: `${cat.category_key} "${cat.label}"`, newValue: null,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- BANK STATEMENT RECONCILIATION --------------------------------------
// Parses admin-uploaded statement files (.xls/.xlsx, as downloaded from net
// banking) into transaction rows, dedupes them against what's already been
// imported (so overlapping re-uploads "compile into one" statement), and
// matches credits against registrations' payment references for finance to
// reconcile UTR-by-UTR.

// dd/mm/yyyy -> yyyy-mm-dd (sortable, filterable). Returns null if unparsable.
function parseStatementDate(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v || '').trim());
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// "  3,000.00 " / "3000.00" -> 3000. Returns null for blank/whitespace cells.
function parseStatementAmount(v) {
  const s = String(v || '').replace(/,/g, '').replace(/\s*(CR|DR)\s*$/i, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// A UPI transaction description embeds the RRN (the UTR delegates enter) as
// "UPI/RRN <digits>/...". Other modes (IMPS, NEFT) don't follow this pattern
// and are left unmatched by reference (still visible for manual reconciliation).
function extractStatementRef(description) {
  const m = /RRN\s*(\d{6,})/i.exec(String(description || ''));
  return m ? m[1] : null;
}

// Stable fingerprint of a statement row, used to dedupe across uploads of
// overlapping date ranges.
function statementRowHash(row) {
  return sha256([row.post_date, row.value_date, row.branch_code, row.cheque_number,
    row.description, row.debit, row.credit, row.balance].map((v) => (v == null ? '' : String(v).trim())).join('|'));
}

// Parse an uploaded statement workbook into transaction rows. The bank's
// export has a few metadata rows, then a header row starting "Post Date",
// then one data row per transaction, then trailer notes -- this locates the
// header by content rather than a fixed offset, and stops at the first row
// whose date column doesn't parse.
function parseStatementBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames.find((n) => /statement/i.test(n)) || wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

  const headerIdx = grid.findIndex((r) => String(r[0] || '').trim().toLowerCase() === 'post date');
  if (headerIdx === -1) throw new Error('Could not find the "Post Date" header row in this file. Is it a Central Bank of India account statement export?');

  const rows = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i];
    const postDate = parseStatementDate(r[0]);
    if (!postDate) break; // trailer text / end of table
    const row = {
      post_date: postDate,
      value_date: parseStatementDate(r[1]) || postDate,
      branch_code: String(r[2] || '').trim(),
      cheque_number: String(r[3] || '').trim(),
      description: String(r[4] || '').trim(),
      debit: parseStatementAmount(r[5]),
      credit: parseStatementAmount(r[6]),
      balance: parseStatementAmount(r[7]),
    };
    row.extracted_ref = extractStatementRef(row.description);
    rows.push(row);
  }
  return rows;
}

const digitsOnly = (v) => String(v || '').replace(/\D/g, '');

// Auto-link registrations to a statement transaction by UTR/RRN match.
// Never overrides an existing link (registration or transaction side), so
// it's safe to call opportunistically -- after every statement upload and
// after every payment submission -- to catch a match whichever arrives
// second. Returns the number of new links made.
async function autoLinkTransactions() {
  // Per-transaction auto-linking: match each unlinked, non-rejected payment
  // transaction to an unused statement credit by reference number. This is the
  // current mechanism -- linking lives on payment_transactions, not the
  // registration.
  const pend = await dbAll(
    `SELECT pt.id, pt.registration_id, pt.amount, pt.utr_number, r.expected_amount
       FROM payment_transactions pt JOIN registrations r ON r.id = pt.registration_id
      WHERE pt.bank_txn_id IS NULL AND pt.utr_number IS NOT NULL AND pt.utr_number != '' AND pt.txn_status != 'REJECTED'`);
  if (!pend.length) return 0;

  const credits = await dbAll(
    `SELECT id, extracted_ref FROM bank_statement_transactions
      WHERE credit IS NOT NULL AND credit > 0 AND extracted_ref IS NOT NULL
        AND id NOT IN ${USED_BANK_TXN_SUBQUERY}`);
  const byRef = new Map();
  credits.forEach((t) => byRef.set(digitsOnly(t.extracted_ref), t.id));

  // Running verified total per registration, so the "not more than what's
  // due" cap holds even when a batch links more than one transaction for the
  // same registration in this same pass. Seeded from already-VERIFIED rows.
  const regIds = [...new Set(pend.map((t) => t.registration_id))];
  const verifiedSoFar = new Map();
  if (regIds.length) {
    const rows = await dbAll(
      `SELECT registration_id, SUM(COALESCE(verified_amount, amount, 0)) AS total
         FROM payment_transactions WHERE registration_id IN (${regIds.map(() => '?').join(',')}) AND txn_status = 'VERIFIED'
        GROUP BY registration_id`, regIds);
    rows.forEach((r) => verifiedSoFar.set(r.registration_id, r.total || 0));
  }

  let linked = 0;
  for (const txn of pend) {
    const bankId = byRef.get(digitsOnly(txn.utr_number));
    if (!bankId) continue;
    // A UTR match acknowledges the payment at its own amount (same as a
    // manual link) -- don't let it push the registration's cumulative total
    // past the fee actually due. Leave it unlinked/pending for a human to
    // review rather than silently over-crediting (e.g. a genuine accidental
    // double payment, or a duplicate resubmission artifact).
    const already = verifiedSoFar.get(txn.registration_id) || 0;
    if (txn.expected_amount > 0 && already + (txn.amount || 0) > txn.expected_amount + 0.5) continue;
    // Guard against two transactions racing for the same still-unused credit
    // within this loop (the UNIQUE index is the final backstop).
    byRef.delete(digitsOnly(txn.utr_number));
    try {
      await dbRun(
        `UPDATE payment_transactions
            SET bank_txn_id = ?, txn_status = 'VERIFIED', verified_amount = amount,
                reviewed_by = 'auto (bank match)', reviewed_at = ?
          WHERE id = ? AND bank_txn_id IS NULL`,
        [bankId, Date.now(), txn.id]);
      verifiedSoFar.set(txn.registration_id, already + (txn.amount || 0));
      linked++;
    } catch (err) {
      if (err.code !== 'SQLITE_CONSTRAINT') throw err;
    }
  }
  return linked;
}

// Upload a statement file. Rows already imported (by an overlapping earlier
// upload) are silently skipped via the UNIQUE dedupe_hash; this is how
// re-uploading updated statements "compiles" into one running master.
app.post('/api/admin/bank-statement/upload', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'),
  statementUpload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded.' });
      if (!/\.(xls|xlsx)$/i.test(req.file.originalname || '')) {
        return res.status(400).json({ success: false, error: 'Please upload an .xls or .xlsx bank statement.' });
      }

      let rows;
      try {
        rows = parseStatementBuffer(req.file.buffer);
      } catch (parseErr) {
        return res.status(400).json({ success: false, error: parseErr.message });
      }
      if (!rows.length) {
        return res.status(400).json({ success: false, error: 'No transaction rows were found in this file.' });
      }

      // Keep a copy of the raw upload for audit purposes (never served over HTTP).
      const savedName = `${Date.now()}-${(req.file.originalname || 'statement').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      await fs.promises.writeFile(path.join(STATEMENT_DIR, savedName), req.file.buffer);

      let imported = 0;
      for (const row of rows) {
        const hash = statementRowHash(row);
        const result = await dbRun(
          `INSERT OR IGNORE INTO bank_statement_transactions
            (post_date, value_date, branch_code, cheque_number, description, debit, credit, balance, extracted_ref, dedupe_hash, source_file, imported_at, imported_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.post_date, row.value_date, row.branch_code, row.cheque_number, row.description,
            row.debit, row.credit, row.balance, row.extracted_ref, hash, savedName, Date.now(), req.session.name]
        );
        if (result.changes > 0) imported++;
      }
      const linked = await autoLinkTransactions();
      res.json({ success: true, total: rows.length, imported, duplicates: rows.length - imported, linked });
    } catch (err) {
      next(err);
    }
  });

app.get('/api/admin/bank-statement', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    const rows = await dbAll('SELECT * FROM bank_statement_transactions ORDER BY post_date DESC, id DESC');
    res.json({ transactions: rows || [] });
  } catch (err) {
    next(err);
  }
});

// Reconcile registrations' payment references against imported statement
// credits. A registration matches when a statement credit row's extracted
// reference equals its UTR/transaction number (digits-only comparison, so
// formatting differences don't break the match).
app.get('/api/admin/bank-statement/reconcile', requireRole('SUPER_ADMIN', 'FINANCE_ADMIN'), async (req, res, next) => {
  try {
    // Credit-centric reconciliation: walk EVERY statement credit and decide
    // whether it maps to a registration, so every credit is accounted for
    // exactly once (matched or unmatched) with no blind spot -- a registration
    // with two linked payments contributes two matched credits, and a credit
    // linked to a rejected registration still shows (flagged), rather than
    // vanishing from both lists.
    const txns = await dbAll(`SELECT * FROM bank_statement_transactions WHERE credit IS NOT NULL AND credit > 0`);

    // Every registration that carries a payment reference (including rejected,
    // so a rejected-but-linked credit resolves to its delegate).
    const allRegs = (await dbAll(
      `SELECT id, registration_number, delegate_name, ${DELEGATE_SALUTATION_COLUMN}, phone_number, utr_number, paid_amount, expected_amount, payment_mode, bank_status
         FROM registrations WHERE utr_number IS NOT NULL AND utr_number != ''`)).map(withDelegateSalutation);
    const regById = new Map(allRegs.map((r) => [r.id, r]));

    const digits = (v) => String(v || '').replace(/\D/g, '');
    // UTR fallback (for payments not yet per-transaction linked) only resolves
    // to a non-rejected registration.
    const regByUtr = new Map();
    allRegs.forEach((r) => { if (r.bank_status !== 'REJECTED') regByUtr.set(digits(r.utr_number), r); });

    // Which registration each credit is linked to (first payment wins if two
    // ever pointed at the same credit; the UNIQUE index makes that impossible).
    const links = await dbAll("SELECT registration_id, bank_txn_id, amount FROM payment_transactions WHERE bank_txn_id IS NOT NULL ORDER BY id ASC");
    const linkByCredit = new Map();
    links.forEach((l) => { if (!linkByCredit.has(l.bank_txn_id)) linkByCredit.set(l.bank_txn_id, l); });

    const matched = [];
    const unmatchedCredits = [];
    const matchedRegIds = new Set();
    for (const t of txns) {
      const link = linkByCredit.get(t.id);
      let reg = null;
      let txnAmount = null;
      if (link) { reg = regById.get(link.registration_id); txnAmount = link.amount; }
      else if (t.extracted_ref) { reg = regByUtr.get(digits(t.extracted_ref)); }
      if (!reg) { unmatchedCredits.push(t); continue; }
      matchedRegIds.add(reg.id);
      const claimedAmount = txnAmount != null ? txnAmount : (reg.paid_amount != null ? reg.paid_amount : reg.expected_amount);
      const amountOk = claimedAmount == null || Number(t.credit) === Number(claimedAmount);
      matched.push({ ...reg, transaction: t, amountOk });
    }

    // Registrations (non-rejected, with a reference) that didn't match any credit.
    const unmatched = allRegs
      .filter((r) => r.bank_status !== 'REJECTED' && !matchedRegIds.has(r.id))
      .map((r) => ({ ...r, reason: 'No matching transaction found in the statement.' }));

    res.json({
      matched,
      unmatched,
      unmatchedCredits,
      summary: {
        registrations: allRegs.filter((r) => r.bank_status !== 'REJECTED').length,
        matched: matched.length,
        amountMismatches: matched.filter((m) => !m.amountOk).length,
        unmatched: unmatched.length,
        unmatchedCredits: unmatchedCredits.length,
        credits: txns.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Consolidated "who did what, when" view across the admin surface --
// statement imports, transaction linking, registration approval decisions,
// abstract approval/allotment, and master-data (workshop/QI/fee) edits.
app.get('/api/admin/activity-log', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const imports = await dbAll(`
      SELECT source_file, imported_by, MIN(imported_at) AS imported_at, COUNT(*) AS rows_imported, SUM(credit) AS total_credit
      FROM bank_statement_transactions GROUP BY source_file, imported_by ORDER BY imported_at DESC`);

    const regAudit = await dbAll(`
      SELECT a.id, a.entity_id, a.action, a.old_value, a.new_value, a.actor_name, a.actor_role, a.created_at,
        r.registration_number, r.delegate_name
      FROM audit_log a
      LEFT JOIN registrations r ON CAST(r.id AS TEXT) = a.entity_id
      WHERE a.entity_type = 'registration'
      ORDER BY a.id DESC`);

    // ADMIN_ENROLL/ADMIN_UNENROLL store a program_options.id in old/new_value
    // -- resolve those to "Workshop: X" / "QI: Y" names for display.
    const optionRows = await dbAll('SELECT id, name, type FROM program_options');
    const optionName = new Map(optionRows.map((o) => [String(o.id), `${o.type === 'QI' ? 'QI: ' : 'Workshop: '}${o.name}`]));
    const resolveOption = (v) => (v != null && optionName.has(String(v))) ? optionName.get(String(v)) : v;
    regAudit.forEach((r) => {
      if (r.action === 'ADMIN_ENROLL' || r.action === 'ADMIN_UNENROLL') {
        r.old_value = resolveOption(r.old_value);
        r.new_value = resolveOption(r.new_value);
      }
    });

    const mapping = regAudit.filter((r) => r.action === 'BANK_TXN_LINK' || r.action === 'BANK_TXN_UNLINK');
    const approval = regAudit.filter((r) => !['BANK_TXN_LINK', 'BANK_TXN_UNLINK'].includes(r.action));

    const abstractAudit = await dbAll(`
      SELECT a.id, a.action, a.old_value, a.new_value, a.actor_name, a.actor_role, a.created_at,
        ab.title, ab.author_name
      FROM audit_log a
      LEFT JOIN abstracts ab ON CAST(ab.id AS TEXT) = a.entity_id
      WHERE a.entity_type = 'abstract'
      ORDER BY a.id DESC`);
    const abstractApproval = abstractAudit.filter((r) => r.action === 'ABSTRACT_STATUS_CHANGE');
    const abstractAllotment = abstractAudit.filter((r) => r.action === 'ABSTRACT_ALLOCATION');

    // "General Logs" (renamed from Master Changes): every change made from any
    // Settings page -- Workshop/QI Master, Fee Master, Discount Codes, Group
    // Discount Rules, and General (SMS/Email/UPI + toggles).
    const master = await dbAll(
      `SELECT id, action, entity_type, old_value, new_value, actor_name, actor_role, created_at
       FROM audit_log
       WHERE entity_type IN (${GENERAL_LOG_ENTITY_TYPES.map(() => '?').join(',')})
       ORDER BY id DESC`,
      GENERAL_LOG_ENTITY_TYPES);

    const login = await dbAll(`
      SELECT id, entity_id AS phone, actor_name, actor_role, created_at
      FROM audit_log WHERE entity_type = 'login' ORDER BY id DESC LIMIT 500`);

    const sms = await dbAll(`
      SELECT id, entity_id AS phone, action, new_value AS detail, created_at
      FROM audit_log WHERE entity_type = 'sms' ORDER BY id DESC LIMIT 500`);

    const email = await dbAll(`
      SELECT id, entity_id AS recipient, action, new_value AS detail, created_at
      FROM audit_log WHERE entity_type = 'email' ORDER BY id DESC LIMIT 500`);

    res.json({ imports, mapping, approval, abstractApproval, abstractAllotment, master, login, sms, email });
  } catch (err) {
    next(err);
  }
});

// --- REPORTS (Excel/CSV + printable PDF) --------------------------------

// Every report is { title, sections: [{ name, columns, rows }, ...] }. Most
// reports have a single unnamed section; the workshops report has one
// section per workshop/QI practice option so each can be viewed or exported
// on its own.
const PAYMENT_MODE_LABELS = { UPI: 'UPI', NEFT_RTGS: 'NEFT / RTGS' };
// Human-readable labels for a registration's bank_status, used everywhere it's
// displayed (reports, etc.) instead of the raw DB constant (e.g. BANK_VERIFIED).
const BANK_STATUS_LABELS = { PENDING: 'Pending', BANK_VERIFIED: 'Verified', REJECTED: 'Rejected', PARTIAL_PAYMENT: 'Partial Payment' };

async function buildReport(type, opts = {}) {
  if (type === 'delegates') {
    const rows = (await dbAll(
      `SELECT registrations.registration_number, delegate_name, ${DELEGATE_SALUTATION_COLUMN}, registrations.phone_number AS phone_number,
         u.age, u.gender, u.designation, u.institution, u.district, u.state, u.pincode, u.email
         FROM registrations
         LEFT JOIN users u ON u.phone_number = registrations.phone_number
         WHERE registrations.bank_status = 'BANK_VERIFIED'
         ORDER BY registrations.registration_number`)).map(withDelegateSalutation);
    return {
      title: 'Registered Delegates — Demography & Institute Details',
      sections: [{
        columns: ['Reg No', 'Name', 'Age', 'Gender', 'Mobile', 'Email', 'Designation', 'Institution', 'District', 'State', 'Pincode'],
        rows: rows.map((r) => [r.registration_number, r.delegate_name, r.age, r.gender, r.phone_number, r.email, r.designation, r.institution, r.district, r.state, r.pincode]),
      }],
    };
  }
  if (type === 'payments') {
    const rows = (await dbAll(
      `SELECT registration_number, delegate_name, ${DELEGATE_SALUTATION_COLUMN}, phone_number, category_label,
         payment_mode, utr_number, paid_amount, expected_amount, bank_status, submitted_at
         FROM registrations ORDER BY registration_number`)).map(withDelegateSalutation);
    const fmtDate = (ms) => ms ? new Date(Number(ms)).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '';
    return {
      title: 'Delegate Payment Details & Status',
      sections: [{
        columns: ['Reg No', 'Delegate', 'Mobile', 'Category', 'Mode', 'UTR / Txn No.', 'Amount Paid', 'Expected Amount', 'Status', 'Submitted'],
        rows: rows.map((r) => [r.registration_number, r.delegate_name, r.phone_number, r.category_label,
          PAYMENT_MODE_LABELS[r.payment_mode] || r.payment_mode, r.utr_number, r.paid_amount, r.expected_amount,
          BANK_STATUS_LABELS[r.bank_status] || r.bank_status, fmtDate(r.submitted_at)]),
      }],
    };
  }
  if (type === 'workshops') {
    const options = (await fetchProgramOptions({ activeOnly: false }))
      .filter((o) => !opts.optionId || String(o.id) === String(opts.optionId));
    const regs = (await dbAll(
      `SELECT workshop_option_id, qi_option_id, workshop_is_faculty, qi_is_faculty,
         registration_number, delegate_name, ${DELEGATE_SALUTATION_COLUMN}, phone_number, category_label, bank_status
         FROM registrations WHERE bank_status != 'REJECTED'`)).map(withDelegateSalutation);
    const columns = ['Reg No', 'Delegate', 'Mobile', 'Category', 'Status', 'Role'];
    // Faculty listed first within each section, ahead of the attendee list.
    const rowsFor = (col, id, facultyCol) => regs.filter((r) => r[col] === id)
      .sort((a, b) => (b[facultyCol] ? 1 : 0) - (a[facultyCol] ? 1 : 0))
      .map((r) => [r.registration_number, r.delegate_name, r.phone_number, r.category_label,
        BANK_STATUS_LABELS[r.bank_status] || r.bank_status, r[facultyCol] ? 'Faculty' : 'Delegate']);
    const sections = [
      ...options.filter((o) => o.type === 'WORKSHOP').map((o) => ({ name: `Workshop: ${o.name}`, columns, rows: rowsFor('workshop_option_id', o.id, 'workshop_is_faculty') })),
      ...options.filter((o) => o.type === 'QI').map((o) => ({ name: `QI Practice: ${o.name}`, columns, rows: rowsFor('qi_option_id', o.id, 'qi_is_faculty') })),
    ];
    return { title: opts.optionId && options[0] ? `Registrations — ${options[0].name}` : 'Registrations per Workshop / QI Practice', sections };
  }
  if (type === 'abstracts') {
    const rows = await dbAll(
      `SELECT title, author_name, format, phone_number FROM abstracts WHERE status = 'ACCEPTED' ORDER BY title`);
    return {
      title: 'Accepted Abstracts',
      sections: [{
        columns: ['Title', 'Author', 'Format', 'Mobile'],
        rows: rows.map((r) => [r.title, r.author_name, r.format, r.phone_number]),
      }],
    };
  }
  return null;
}

const REPORT_ROLES = {
  delegates: ['SUPER_ADMIN', 'FINANCE_ADMIN'],
  payments: ['SUPER_ADMIN', 'FINANCE_ADMIN'],
  workshops: ['SUPER_ADMIN', 'FINANCE_ADMIN'],
  abstracts: ['SUPER_ADMIN', 'ACADEMIC_REVIEWER'],
};

function toCsv(rep) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const multi = rep.sections.length > 1;
  return rep.sections.map((sec) => {
    const heading = multi && sec.name ? [[sec.name], []] : [];
    return [...heading, sec.columns, ...sec.rows].map((r) => r.map(cell).join(',')).join('\r\n');
  }).join('\r\n\r\n');
}

function reportHtml(rep) {
  const table = (sec) => {
    const th = sec.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
    const trs = sec.rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('') ||
      `<tr><td colspan="${sec.columns.length}" style="text-align:center;color:#94a3b8">No records</td></tr>`;
    return `${sec.name ? `<h2>${escapeHtml(sec.name)} <span class="count">(${sec.rows.length})</span></h2>` : ''}
      <table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
  };
  const now = new Date().toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' });
  const total = rep.sections.reduce((n, s) => n + s.rows.length, 0);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(rep.title)}</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;margin:2rem;}
  h1{font-size:1.2rem;margin:0 0 .25rem;}
  h2{font-size:.95rem;margin:1.5rem 0 .5rem;color:#312e81;}
  .count{color:#94a3b8;font-weight:400;font-size:.8rem;}
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
  <p class="sub">Generated ${escapeHtml(now)} · ${total} record(s)</p>
  <div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
  ${rep.sections.map(table).join('')}
</body></html>`;
}

// Lets the workshops report's "one at a time" picker populate without
// requiring the SUPER_ADMIN-only masters endpoint (FINANCE_ADMIN can run
// this report too, but can't see the masters tab).
app.get('/api/admin/reports/workshops/options', requireAuth, async (req, res, next) => {
  try {
    if (!roleGrants(req.session.role).some((r) => REPORT_ROLES.workshops.includes(r))) {
      return res.status(403).json({ success: false, error: 'You do not have permission for this report.' });
    }
    const options = await fetchProgramOptions({ activeOnly: false });
    res.json({ options: options.map((o) => ({ id: o.id, type: o.type, name: o.name })) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/admin/reports/:type', requireAuth, async (req, res, next) => {
  try {
    const type = req.params.type;
    const roles = REPORT_ROLES[type];
    if (!roles) return res.status(404).json({ success: false, error: 'Unknown report.' });
    if (!roleGrants(req.session.role).some((r) => roles.includes(r))) {
      return res.status(403).json({ success: false, error: 'You do not have permission for this report.' });
    }
    if (type === 'workshops' && !req.query.optionId) {
      return res.status(400).json({ success: false, error: 'Select a workshop or QI practice first.' });
    }
    const rep = await buildReport(type, { optionId: req.query.optionId });
    res.set('Cache-Control', 'private, no-store');
    if (req.query.format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="nqocn-${type}-report.csv"`);
      return res.send(toCsv(rep));
    }
    if (req.query.format === 'json') {
      return res.json({ success: true, report: rep });
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

// Step 1 of abstract review: Approval. Accept/reject/reset. Deliberately
// silent -- no delegate email fires here. Approval only unlocks the abstract
// for the separate Assignment step (below); the delegate hears from us once,
// when that step gives the final decision (accepted + oral/poster, or not
// accepted). This lets approval and assignment happen as two independent
// actions, in separate sessions, possibly by different reviewers.
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

    // Resetting away from ACCEPTED clears any assignment.
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

    // Rejecting at the approval step IS a final decision (there is no
    // assignment step to follow), so that's the one case this step emails.
    if (status === 'REJECTED' && existing.status !== 'REJECTED') {
      const a = await dbGet('SELECT phone_number, author_name, title FROM abstracts WHERE id = ?', [req.params.id]);
      if (a) notifyDelegate(a.phone_number, 'Your abstract submission — decision',
        emailWrap('Abstract decision',
          `<p>Dear ${escapeHtml(a.author_name)},</p>
           <p>Thank you for submitting your abstract, <b>"${escapeHtml(a.title)}"</b>. After review by the scientific committee, we regret that it has not been accepted for the ${escapeHtml(CONFERENCE.name)}.</p>`));
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Step 2 of abstract review: Assignment (oral/poster), for approved
// abstracts only. This is the delegate's one and only decision email --
// it states both that the abstract was accepted and the final format.
app.put('/api/abstracts/:id/allocation', requireRole('SUPER_ADMIN', 'ACADEMIC_REVIEWER'), async (req, res, next) => {
  try {
    const { allocation } = req.body;
    if (!['ORAL', 'POSTER'].includes(allocation)) {
      return res.status(400).json({ success: false, error: 'Allocation must be ORAL or POSTER.' });
    }
    const a = await dbGet('SELECT status, allocation, phone_number, author_name, title FROM abstracts WHERE id = ?', [req.params.id]);
    if (!a) return res.status(404).json({ success: false, error: 'Abstract not found.' });
    if (a.status !== 'ACCEPTED') {
      return res.status(400).json({ success: false, error: 'Only approved abstracts can be assigned a presentation format.' });
    }
    const isFirstAssignment = !a.allocation;
    await dbRun('UPDATE abstracts SET allocation = ? WHERE id = ?', [allocation, req.params.id]);
    await recordAudit({
      req, entityType: 'abstract', entityId: req.params.id,
      action: 'ABSTRACT_ALLOCATION', oldValue: a.allocation, newValue: allocation,
    });
    // Only email on the first assignment (or a change of format); re-saving
    // the same value shouldn't re-notify the delegate.
    if (isFirstAssignment || a.allocation !== allocation) {
      const kind = allocation === 'ORAL' ? 'oral' : 'poster';
      notifyDelegate(a.phone_number, 'Your abstract has been accepted',
        emailWrap('Abstract accepted', `<p>Dear ${escapeHtml(a.author_name)},</p>
           <p>We are pleased to inform you that your abstract <b>"${escapeHtml(a.title)}"</b> has been <b>accepted</b> for the ${escapeHtml(CONFERENCE.name)}, for <b>${kind} presentation</b>.</p>
           <p>Further details (time and venue) will be communicated separately.</p>`));
    }
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

// Run one-time-safe boot tasks to completion before opening the port: the
// Title Case backfill and the salutation split (both must not race a real
// signup -- see retitleNamesOnBoot) and a pass of bank-transaction
// auto-linking (picks up any statement rows imported before this boot that
// match already-submitted registrations). Bounded and logged rather than
// awaited unconditionally, so a DB hiccup doesn't block startup forever.
retitleNamesOnBoot()
  .catch((err) => console.error('Title-case backfill failed (continuing to start):', err.message))
  .then(() => splitSalutationsOnBoot().catch((err) => console.error('Salutation split failed (continuing to start):', err.message)))
  .then(() => backfillPaymentTransactionsOnBoot().catch((err) => console.error('Payment-transaction backfill failed (continuing to start):', err.message)))
  .then(() => autoLinkTransactions().catch((err) => console.error('Bank-transaction auto-link failed (continuing to start):', err.message)))
  .then(() => loadNotificationToggles().catch((err) => console.error('Notification-toggle load failed (continuing to start):', err.message)))
  .then(() => loadGeneralSettings().catch((err) => console.error('General-settings load failed (continuing to start):', err.message)))
  .then(startServer);

function startServer() {
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`SMS OTP: ${smsEnabled() ? 'ENABLED (Vynttra)' : 'disabled (no SMS_API_KEY)'}`);
  console.log(`Email: ${emailEnabled() ? `ENABLED (SES, from ${EMAIL.from})` : 'disabled (no AWS/SES config)'}`);
  if (OTP_ECHO && !smsEnabled()) console.log('[dev] OTP echo is ON — codes are returned to the client and logged here.');
});
}
