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
const compression = require('compression');
const crypto = require('crypto');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { createWorker } = require('tesseract.js');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
// Node 16 has no global fetch; node-fetch (v2, CommonJS) provides it for SMS.
const fetch = require('node-fetch');
// What each admin route needs, and which roles hold it. One file rather than
// a role list repeated at every route -- see permissions.js.
const {
  PERMISSION_KEYS, ROUTE_PERMISSIONS, REPORT_PERMISSIONS, SYSTEM_ROLES, SECTION_PERMISSIONS,
  SECTIONS, PERMISSIONS,
  roleCan, permissionsForRole,
} = require('./permissions');

const multer = require('multer');
const XLSX = require('xlsx');

const app = express();
// `let`, not `const`: admin-editable from Settings → General (see
// GENERAL_SETTINGS_KEYS / RUNTIME_ENV_SETTERS below), same as COOKIE_NAME,
// COOKIE_SECURE, OTP_ECHO, and PORTAL_URL further down. This one is read
// exactly once, at process boot -- loadGeneralSettings() overlays any
// schema_meta value onto it before startServer() calls app.listen(PORT, ...),
// and nothing reads it again after that -- so a saved change here only takes
// effect on the next restart, never live.
let PORT = process.env.PORT || 3000;

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
// `let`, not `const` -- same admin-editable-with-restart pattern as PORT
// above. Read once at boot (loadGeneralSettings() overlays schema_meta
// before app.listen()); changing it later only takes effect on the next
// restart, and every currently-issued session cookie stops being recognized
// the moment it does (see the PUT handler's change note for this field).
let COOKIE_NAME = process.env.COOKIE_NAME || 'nqocn_sid';
// 15, not 5. A login OTP is typed within seconds of arriving, but signup
// asks for TWO codes and then a page of details -- country, address, age,
// designation, institution, a password -- and the first code has to survive
// all of it. At five minutes it routinely did not: the phone code expired
// while the form was still being filled, and the delegate was told to
// request an OTP they had already requested.
const OTP_TTL_MS = 15 * 60 * 1000;       // OTP valid for 15 minutes
const OTP_RESEND_MS = 30 * 1000;         // min gap between OTP requests
const OTP_MAX_ATTEMPTS = 5;              // wrong tries before OTP is burned
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // sessions last 12 hours

// Password login: a per-phone failed-attempt counter, in-memory rather than
// a DB table -- unlike OTPs (which are already short-lived, DB-backed rows
// with their own attempts column) a password is long-lived, so this only
// needs to survive as long as the process does; a restart resetting it is
// an acceptable trade for not needing a schema. Same shape of protection as
// OTP_MAX_ATTEMPTS above: lock out after too many wrong guesses.
const passwordLoginAttempts = new Map(); // phone -> { count, lockUntil }
const PASSWORD_MAX_ATTEMPTS = 5;
const PASSWORD_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

// Send the OTP back to the client when there is no real SMS gateway.
// Defaults on outside production so the app is usable out of the box;
// force it off with OTP_ECHO=false, or on with OTP_ECHO=true. `let`: also
// admin-editable (Settings → General), but unlike PORT/COOKIE_NAME/
// COOKIE_SECURE this one is read fresh on every OTP request, so a saved
// change applies immediately, no restart needed.
let OTP_ECHO = process.env.OTP_ECHO
  ? process.env.OTP_ECHO === 'true'
  : process.env.NODE_ENV !== 'production';

// Set COOKIE_SECURE=true when served over HTTPS (directly or via a proxy).
// `let`, restart-required -- see COOKIE_NAME above; app.set('trust proxy', 1)
// is applied after loadGeneralSettings() resolves instead of here, so it
// still reflects a schema_meta override by the time it matters (see the boot
// sequence near app.listen).
let COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

// The admin panel is assembled at request time from views/admin.ejs and its
// partials (one file per tab/section/modal under views/admin/) rather than
// being one 1,200-line HTML file. EJS is used only for <%- include %> --
// there's no server-rendered data in these templates; everything is still
// populated client-side by app.js against the JSON API.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Which roles may reach the admin panel at all. What each one may DO there
// is permissions.js's business, not this list's.
const ADMIN_ROLES = ['SUPER_ADMIN', 'FINANCE_ADMIN', 'ACADEMIC_REVIEWER', 'FINANCE_ACADEMIC', 'OPERATIONS'];

// ROLE_IMPLIES used to live here: FINANCE_ACADEMIC expanded into
// FINANCE_ADMIN + ACADEMIC_REVIEWER at every permission check, because a role
// was a string and the only way to say "both" was to say it at each guard.
// With roles held as permission sets, "both" is simply the union of the two
// sets, which is what the compound always meant -- so the special case is
// gone rather than reimplemented. See SYSTEM_ROLES in permissions.js.

// --- FIRST-RUN SETUP ------------------------------------------------------
// A brand-new deployment has zero admin users and no code path to create one:
// every account-creation route already requires being SUPER_ADMIN or
// OPERATIONS. GET /setup and its POST routes below break that deadlock
// exactly once. No token gate: the only thing that makes this safe to leave
// open is that it is IMPOSSIBLE to reach once a single admin account exists
// (see isSetupModeActive below) -- a deployment is expected to be set up
// immediately after it first comes up, before it is exposed to anyone else,
// same trust window as e.g. an unconfigured database with no auth at all
// briefly existing right after `docker compose up`.
//
// isSetupModeActive() is checked on every relevant request, not just at
// boot, and is permanently and irreversibly false the moment either
// condition below stops holding:
//   - schema_meta.setup_completed is set the instant the first admin account
//     is created (see POST /api/setup/create-admin) -- defense-in-depth so
//     that deleting the only admin account later does not silently reopen
//     account creation to the public internet.
//   - an admin-role user already exists.
async function isSetupModeActive() {
  const completed = await dbGet("SELECT value FROM schema_meta WHERE key = 'setup_completed'").catch(() => null);
  if (completed) return false;
  // Any role that isn't DELEGATE closes the setup window -- including a
  // custom one, which is exactly as capable of administering this app as
  // the five built-ins are.
  const roles = (roleCache && roleCache.size) ? [...roleCache.keys()] : ADMIN_ROLES;
  const admin = await dbGet(
    `SELECT 1 FROM users WHERE role IN (${roles.map(() => '?').join(',')}) LIMIT 1`, roles
  ).catch(() => null);
  return !admin;
}

// Admin-editable from Settings → General (see GENERAL_SETTINGS_KEYS below),
// persisted in schema_meta. name/acronym/dates/location are display-only text
// used across confirmation emails, reports, and printable pages -- nothing
// here gates any capability, so unlike SMS/EMAIL/UPI there's no *Enabled()
// check for it. regPrefix feeds assignUserRegNumber() below -- changing it
// only affects registrations created from that point on; existing
// registration numbers are never rewritten.
//
// Deliberately no defaults: this app is not tied to one specific conference,
// so every field here starts blank and is meant to be filled in during
// first-run setup (see GET /setup) rather than shipping a placeholder that
// could go live un-noticed.
const CONFERENCE = {
  name: '',
  acronym: '',
  startDate: '',
  endDate: '',
  location: '',
  regPrefix: '',
};
// `let`: admin-editable, applies immediately (read fresh wherever it's used).
let PORTAL_URL = process.env.PORTAL_URL || 'https://registration.mgims.ac.in';

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "21–22 Nov 2026" (same month) or "28 Nov – 2 Dec 2026" (spanning months),
// from the YYYY-MM-DD strings Settings → General's date inputs produce.
function formatConferenceDates() {
  const parse = (d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
    return m ? { year: m[1], month: SHORT_MONTHS[Number(m[2]) - 1], day: Number(m[3]) } : null;
  };
  const s = parse(CONFERENCE.startDate);
  const e = parse(CONFERENCE.endDate);
  if (!s && !e) return '';
  if (s && e) {
    if (CONFERENCE.startDate === CONFERENCE.endDate) return `${s.day} ${s.month} ${s.year}`;
    return (s.month === e.month && s.year === e.year)
      ? `${s.day}–${e.day} ${s.month} ${s.year}`
      : `${s.day} ${s.month}${s.year !== e.year ? ' ' + s.year : ''} – ${e.day} ${e.month} ${e.year}`;
  }
  const one = s || e;
  return `${one.day} ${one.month} ${one.year}`;
}

// "28 Aug 2026" from a YYYY-MM-DD string (the format HTML date inputs
// produce, e.g. discount_codes.expires_at). Returns '' on anything else --
// callers treat that the same as "no date" rather than printing garbage.
function formatDMY(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return '';
  return `${Number(m[3])} ${SHORT_MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

// --- .ENV FILE HELPERS ---------------------------------------------------
// Lets Settings → General persist a credential change to the actual .env
// file (not the database) so it survives a restart and stays wherever every
// other secret in this app already lives -- one source of truth, and
// nothing sensitive ever lands in conference.db or a backup of it. Updates
// process.env immediately too, so the change takes effect without a restart.
//
// Everything this process persists lives in ONE directory, resolved here:
// the database, .env, and the backup handshake files. DB_PATH overrides it so
// a test instance can be pointed at a fixture without writing into the
// checkout -- which is exactly what happened before this existed: a test run
// put Google Drive credentials into the repository's own .env.
//
// In the container all three resolve to /data anyway (conference.db and .env
// are symlinks into the volume), so nothing changes in production.
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'conference.db');
const DATA_DIR = (() => {
  try { return path.dirname(fs.realpathSync(DB_FILE)); } catch { return path.dirname(DB_FILE); }
})();
const ENV_PATH = path.join(DATA_DIR, '.env');
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
// digest is a separate switch from email -- delegate-facing verification/
// rejection/abstract emails can stay on while the daily internal digest
// (scripts/daily-digest.js, cron-run and independent of this process) is
// turned off, or vice versa.
const notifyToggle = { sms: true, email: true, digest: true };
async function loadNotificationToggles() {
  const s = await dbGet("SELECT value FROM schema_meta WHERE key = 'notify_sms_enabled'").catch(() => null);
  const e = await dbGet("SELECT value FROM schema_meta WHERE key = 'notify_email_enabled'").catch(() => null);
  const d = await dbGet("SELECT value FROM schema_meta WHERE key = 'notify_digest_enabled'").catch(() => null);
  if (s) notifyToggle.sms = s.value !== '0';
  if (e) notifyToggle.email = e.value !== '0';
  if (d) notifyToggle.digest = d.value !== '0';
}

// Maintenance mode: closes the portal to everyone except SUPER_ADMIN, so the
// conference team can work on a live deployment (DB edits, a migration, an OS
// window) without delegates half-completing registrations against it.
// Persisted in schema_meta and enforced server-side by maintenanceGate below
// -- the client-side screen is UX only, never the actual control.
const DEFAULT_MAINTENANCE_MESSAGE = 'The portal is temporarily unavailable for scheduled maintenance. Please check back shortly.';
const maintenance = { enabled: false, message: DEFAULT_MAINTENANCE_MESSAGE };
async function loadMaintenanceMode() {
  const on = await dbGet("SELECT value FROM schema_meta WHERE key = 'maintenance_enabled'").catch(() => null);
  const msg = await dbGet("SELECT value FROM schema_meta WHERE key = 'maintenance_message'").catch(() => null);
  if (on) maintenance.enabled = on.value === '1';
  if (msg && msg.value) maintenance.message = msg.value;
}

// Non-secret operational fields for SMS/Email/UPI, admin-editable from
// Settings → General, persisted in schema_meta and applied over the env
// defaults set on SMS/EMAIL/UPI above. Credentials (SMS_API_KEY, AWS keys)
// are intentionally not among these keys -- they only ever come from .env.
const GENERAL_SETTINGS_KEYS = {
  sms_sender: ['SMS', 'sender'], sms_url: ['SMS', 'url'], sms_entity_id: ['SMS', 'entityId'],
  sms_template_id: ['SMS', 'templateId'], sms_header_id: ['SMS', 'headerId'], sms_type: ['SMS', 'type'],
  email_from: ['EMAIL', 'from'], email_from_name: ['EMAIL', 'fromName'], email_region: ['EMAIL', 'region'],
  email_digest_recipients: ['EMAIL', 'digestRecipients'],
  email_digest_send_time: ['EMAIL', 'digestSendTime'],
  upi_id: ['UPI', 'id'], upi_payee_name: ['UPI', 'payeeName'],
  bank_account_name: ['BANK', 'accountName'], bank_account_number: ['BANK', 'accountNumber'],
  bank_ifsc: ['BANK', 'ifsc'], bank_branch: ['BANK', 'branch'],
  conference_name: ['CONFERENCE', 'name'], conference_acronym: ['CONFERENCE', 'acronym'],
  conference_start_date: ['CONFERENCE', 'startDate'], conference_end_date: ['CONFERENCE', 'endDate'],
  conference_location: ['CONFERENCE', 'location'], conference_reg_prefix: ['CONFERENCE', 'regPrefix'],
};

// The rest of "Other Environment Variables" -- PORT, PORTAL_URL, COOKIE_NAME,
// COOKIE_SECURE, OTP_ECHO. Each is its own top-level `let`, not a property on
// one of the SMS/EMAIL/UPI/CONFERENCE objects above, so it needs its own
// setter rather than a generic [object, prop] pair. NODE_ENV is deliberately
// not here -- it's a Node/process-launch convention read before any of this
// code runs, not application config, so it stays a real env var.
const RUNTIME_ENV_SETTERS = {
  portal_url: (v) => { PORTAL_URL = v; },
  otp_echo: (v) => { OTP_ECHO = v !== '0'; },
  port: (v) => { const n = Number(v); if (Number.isInteger(n) && n > 0 && n <= 65535) PORT = n; },
  cookie_name: (v) => { COOKIE_NAME = v; },
  cookie_secure: (v) => { COOKIE_SECURE = v !== '0'; },
};

async function loadGeneralSettings() {
  const keys = [...Object.keys(GENERAL_SETTINGS_KEYS), ...Object.keys(RUNTIME_ENV_SETTERS)];
  const rows = await dbAll(`SELECT key, value FROM schema_meta WHERE key IN (${keys.map(() => '?').join(',')})`, keys);
  const targets = { SMS, EMAIL, UPI, BANK, CONFERENCE };
  for (const row of rows) {
    const dest = GENERAL_SETTINGS_KEYS[row.key];
    if (dest) { if (row.value) targets[dest[0]][dest[1]] = row.value; continue; }
    const setter = RUNTIME_ENV_SETTERS[row.key];
    if (setter && row.value != null) setter(row.value);
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
        // Provider wants bare digits with the country code, no '+'. `phone`
        // arrives as E.164 (see issueOtp), so this is just the plus stripped
        // -- it used to hardcode 91 in front of a bare national number.
        message: [{ number: String(phone).replace(/^\+/, ''), text }],
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
// digestRecipients: comma-separated 10-digit phone numbers looked up in the
// users table by scripts/daily-digest.js (a standalone cron script, not part
// of this process) -- phone rather than a hardcoded email list, so it keeps
// working if someone updates their email address in Users & Roles.
const EMAIL = {
  from: (process.env.SES_FROM || '').trim(),
  fromName: process.env.SES_FROM_NAME || '',
  region: (process.env.AWS_REGION || '').trim(),
  digestRecipients: process.env.DIGEST_RECIPIENT_PHONES || '',
  // HH:MM, 24-hour, IST -- read by scripts/daily-digest.js (which cron now
  // invokes every 15 minutes rather than at one fixed hour, so this can
  // actually take effect without editing crontab -- see that script's
  // shouldSendNow()), not consumed by this process itself.
  digestSendTime: process.env.DIGEST_SEND_TIME || '09:00',
};
const awsCredsPresent = () => !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
const emailEnabled = () => awsCredsPresent() && !!EMAIL.region && !!EMAIL.from;
// RFC 5322 "Display Name <address>" form -- without a name SES sends with
// just the bare address, which is a legitimate look on its own, so an unset
// fromName degrades to that rather than to an empty, oddly-quoted "" <addr>.
const emailFromFormatted = () => (EMAIL.from && EMAIL.fromName) ? `"${EMAIL.fromName.replace(/"/g, '')}" <${EMAIL.from}>` : EMAIL.from;
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
       <div style="font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:#c7d2fe">${escapeHtml([CONFERENCE.acronym, CONFERENCE.location].filter(Boolean).join(' · '))}</div>
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
  id: process.env.OFFICIAL_UPI_ID || '',
  payeeName: process.env.UPI_PAYEE_NAME || '',
};

// Bank-transfer fallback shown alongside the UPI QR (the delegate payment
// and balance-top-up modals both offer "pay by bank transfer instead").
// Previously hardcoded straight into those two templates; now genuinely
// admin-editable/setup-configurable like UPI, since a bank account is just
// as conference-specific as a UPI ID.
const BANK = {
  accountName: process.env.BANK_ACCOUNT_NAME || '',
  accountNumber: process.env.BANK_ACCOUNT_NUMBER || '',
  ifsc: process.env.BANK_IFSC || '',
  branch: process.env.BANK_BRANCH || '',
};

// Whether a category must upload a student ID card -- admin-editable per
// category (Settings → Fees), persisted on fee_categories.requires_student_id
// rather than hardcoded.
//
// It used to also return the discipline/level the card was expected to show,
// for an OCR keyword check. That check is gone: it only ever recognised a
// fixed nursing/medical x UG/PG vocabulary, was advisory rather than a gate,
// and the real check has always been an approver looking at the card (see
// id_verified / PUT /api/registrations/:id/verify-id).
async function categoryRequiresStudentId(categoryKey) {
  if (!categoryKey) return false;
  const cat = await dbGet(
    'SELECT requires_student_id FROM fee_categories WHERE category_key = ?', [categoryKey]);
  return !!(cat && cat.requires_student_id);
}

// --- CRYPTO / COOKIE HELPERS --------------------------------------------
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Password hashing: scrypt (Node's own crypto, no new dependency) with a
// random 16-byte salt per password. Stored as "scrypt$<saltHex>$<hashHex>"
// so the salt travels with the hash and old rows stay verifiable even if the
// derived-key length or scrypt parameters ever change (a new format prefix
// would just live alongside this one, `hashPassword` need not touch old
// rows retroactively).
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Constant-time compare so a wrong guess can't be narrowed down by response
// timing. Used for both the password check below and (for the same reason)
// anywhere else two secrets need comparing.
function safeBufferEquals(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyPassword(plain, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(plain), salt, expected.length);
  return safeBufferEquals(actual, expected);
}

// The scrypt hash itself never has any business reaching the browser -- it's
// not needed for anything client-side, and offers nothing but attack
// surface sitting in a JS variable / dev-tools network tab. Every response
// that sends a full `SELECT *`-shaped user row runs it through this first.
// hasPassword is derived here (rather than left for the client to guess)
// so the dashboard can prompt an OTP-only delegate to set one.
function omitPasswordHash(user) {
  if (!user) return user;
  const { password_hash, ...rest } = user;
  return { ...rest, hasPassword: !!password_hash };
}

// A one-time password for a delegate registered at the desk (see POST
// /api/admin/registrations) -- meant to be read out loud or written down,
// not typed by anyone from a screenshot, so it deliberately excludes
// characters that are easy to misread aloud or on paper (0/O, 1/l/I) rather
// than drawing from the full alphanumeric range. Returned once in that
// endpoint's response and never stored or logged in plaintext -- only its
// scrypt hash (via hashPassword) ever reaches the database.
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateTempPassword(length = 8) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += TEMP_PASSWORD_ALPHABET[bytes[i] % TEMP_PASSWORD_ALPHABET.length];
  return out;
}

// Escape a value for safe interpolation into server-rendered HTML.
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Abstract section fields allow a small formatting toolbar (bold, italic,
// superscript, subscript -- enough for scientific notation like p<0.05,
// 10⁻³, cm²) without exposing raw HTML input to a non-technical delegate.
// Escape everything first (neutralizes any real markup/script the delegate
// typed or pasted), then selectively restore exactly these four tags, which
// only the toolbar itself ever inserts. Newlines are left alone -- rendered
// with white-space:pre-wrap wherever an abstract is shown, matching how the
// rest of this app already handles preserved line breaks, rather than
// converting to <br> here.
const ABSTRACT_ALLOWED_TAGS = ['b', 'i', 'sup', 'sub'];
function sanitizeAbstractHtml(v) {
  let s = escapeHtml(v);
  for (const tag of ABSTRACT_ALLOWED_TAGS) {
    s = s.replace(new RegExp(`&lt;${tag}&gt;`, 'g'), `<${tag}>`)
         .replace(new RegExp(`&lt;/${tag}&gt;`, 'g'), `</${tag}>`);
  }
  return s;
}

// Word count from the PLAIN text, so formatting tags never inflate it.
function plainTextWordCount(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
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
// How the amount on a slip compares with what was expected. Three outcomes,
// not two, because "the slip says something else" and "nothing legible was
// found" are different claims and only the first is evidence of a problem.
//
// Measured over all 190 approved slips: the old two-state check put a red
// cross on 37 of them (20%) whose amounts were perfectly correct, because a
// failure to read was indistinguishable from a mismatch. Most were Google Pay
// receipts in DARK MODE -- the amount is large light-grey text on near-black,
// which Tesseract's default binarisation erases while still reading the
// smaller body text around it.
const AMOUNT_MATCH = 'match';
const AMOUNT_MISMATCH = 'mismatch';
const AMOUNT_UNREADABLE = 'unreadable';

// OCR routinely reads "0" as "O" and "1" as "l"/"I" in the bold amount font;
// fix those look-alikes inside any digit-ish run so the zeroes count.
const normDigits = (s) => s.replace(/[0-9OolI]+/g, (run) => run.replace(/[OoIl]/g, (c) => (c === 'I' || c === 'l' ? '1' : '0')));

// Every money-shaped token in the text, with whether the slip presents it AS
// the amount. Scoped to a single line: nothing is joined across a line break,
// which is what used to let the matcher assemble the expected figure out of
// three unrelated numbers and call it a match.
// A line that is a date or a clock, not money. Checked on the LINE rather
// than by rejecting 2000-2099 outright: that shortcut also rejected every
// amount in that range, and 2,000 is one of this conference's fee tiers, so
// a slip plainly showing ₹2,000 against a ₹3,000 fee could never be reported
// as a discrepancy -- the check was silently blind to a whole price band.
const DATE_LINE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
const CLOCK = /\b\d{1,2}[:.]\d{2}\b/;

// `lettersPossible` is false for the digits-only second pass. "Alone on its
// line" infers confidence from the absence of letters, which is evidence
// only when letters COULD have been read; under a digits-only whitelist
// every line is letterless by construction, so account tails and clock
// digits all looked like confidently-read amounts. That pass keeps the
// currency marker as its only confidence signal (₹ is in its whitelist).
function amountCandidates(text, { lettersPossible = true } = {}) {
  const out = [];
  const lines = normDigits(text).split('\n');
  const nonEmpty = lines.filter((l) => l.trim()).length;
  let seen = 0;
  for (const line of lines) {
    if (line.trim()) seen++;
    const bare = line.trim();
    const hasMarker = /₹|rs\.?|inr/i.test(line);
    const looksTemporal = DATE_LINE.test(line) || CLOCK.test(line);
    // These receipts put the amount in the upper part of the screen, above
    // the bank and reference block.
    const high = seen <= Math.max(4, Math.ceil(nonEmpty * 0.4));
    // Digits, optionally grouped by commas or a space before a group of
    // three, optionally with one or two decimals.
    const toks = line.match(/[0-9](?:[0-9,]|[ ](?=[0-9]{3}\b))*(?:\.[0-9]{1,2})?/g) || [];
    for (const t of toks) {
      const int = t.split('.')[0].replace(/[^0-9]/g, '');
      if (!int || int.length > 7) continue;
      // "Alone" means the line holds nothing but this number and at most a
      // currency marker -- no letters. Stripping every non-digit instead was
      // wrong: it made "Bank of Baroda 3183" look like a line holding only
      // 3183, so account tails were read as amounts.
      const rest = bare.replace(/₹|rs\.?|inr/ig, '').replace(t, '').trim();
      const alone = lettersPossible && !/[a-z]/i.test(rest) && rest.replace(/[^0-9]/g, '') === '';
      const feeShaped = int.length >= 3 && Number(int) >= 100 && !looksTemporal;
      out.push({ int, confident: feeShaped && (hasMarker || (alone && high)) });
    }
  }
  return out;
}

// The smallest number that can be a fee. Shared by every confidence rule so
// they cannot drift apart: a value below this is noise whatever produced it.
const MIN_FEE = 100;

// Amounts written out in words -- "Three Thousand Rupees", "Rupees Seven
// Hundred Fifty Only". Bank and Paytm receipts print this under the figure,
// and it survives OCR far better than the stylised digits above it: one
// approved slip reads a perfectly clear "₹3,000" as "5000" and would still
// be flagged without this. Twelve of the 190 approved slips carry it, and
// every one of them parses to exactly the amount paid.
const WORD_VALUES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const WORD_SCALES = { hundred: 100, thousand: 1000, lakh: 100000, lac: 100000, million: 1000000 };

function amountsInWords(text) {
  const found = [];
  let running = 0;   // total across scales
  let current = 0;   // the group being built, before its scale word
  const flush = () => {
    const total = running + current;
    if (total > 0) found.push(total);
    running = 0; current = 0;
  };
  for (const word of String(text).toLowerCase().split(/[^a-z]+/)) {
    if (!word) continue;
    if (word in WORD_VALUES) { current += WORD_VALUES[word]; continue; }
    if (word in WORD_SCALES) {
      const scale = WORD_SCALES[word];
      if (scale === 100) current *= 100;
      else { running += (current || 1) * scale; current = 0; }
      continue;
    }
    // "and" joins a number; "rupees"/"only" bracket it; anything else ends it.
    if (word === 'and') continue;
    flush();
  }
  flush();
  return found;
}

// Does any candidate read as the expected amount?
function amountAppears(candidates, expectedAmount) {
  const E = String(expectedAmount);
  return candidates.some(({ int }) => (
    int === E
    // The rupee glyph fused onto the front of the number: "₹750" -> "2750".
    // Leading position only -- allowing the stray digit anywhere is what let
    // 850 satisfy 8500.
    || (int.length === E.length + 1 && int.slice(1) === E)
    // A trailing ".00" that lost its point: "750.00" -> "75000".
    || (int.length === E.length + 2 && int.slice(0, E.length) === E && int.slice(E.length) === '00')
  ));
}

const OCR_DEFAULT_PARAMS = { tessedit_pageseg_mode: '3', tessedit_char_whitelist: '', thresholding_method: '0' };
// Sparse text, Sauvola thresholding, digits only. Reads the big amount on a
// dark-mode receipt that the default pass renders as "EE" or "| sol |";
// recovers the amount on ~28 of the 37 slips the single pass misses. Digits
// only because this pass exists solely to find a number -- it is never used
// for the UPI id or the transaction reference.
const OCR_AMOUNT_PARAMS = { tessedit_pageseg_mode: '11', thresholding_method: '2', tessedit_char_whitelist: '0123456789.,₹' };

// One OCR pass at a time.
//
// There is a single worker for the whole process, and tesseract.js posts
// every job to it the moment it is called -- no per-caller queue -- while
// setParameters applies to the WORKER, not to a call. Two uploads at once
// could therefore interleave as A.setParameters(digits-only), B.recognize,
// A.recognize: B's slip would be read under A's whitelist, so B's text would
// hold no letters at all and B's UPI-id and UTR checks would both fail on a
// perfectly good screenshot -- flagged, with nothing in the logs to say why.
//
// Chaining on both settle paths, so one failed pass does not wedge the queue.
let ocrChain = Promise.resolve();
function serializeOcr(job) {
  const result = ocrChain.then(job, job);
  ocrChain = result.then(() => {}, () => {});
  return result;
}

async function recognizeText(buffer, params) {
  return serializeOcr(async () => {
    const worker = await getOcrWorker();
    // Every pass states its parameters in full rather than inheriting
    // whatever the previous one left behind. The old code restored defaults
    // in a `finally` and swallowed any failure of that restore -- which
    // would have left the worker digits-only for every later request until
    // the process restarted.
    await worker.setParameters({ ...OCR_DEFAULT_PARAMS, ...(params || {}) });
    // Bound the wait: a corrupt image can make the worker throw out-of-band
    // and never settle this promise, which would otherwise hang the request.
    const result = await Promise.race([
      worker.recognize(buffer),
      new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timed out')), 15000)),
    ]);
    return (result && result.data && result.data.text) || '';
  });
}

async function runOcrChecks(buffer, { expectedAmount, utr }) {
  let text = '';
  try {
    text = await recognizeText(buffer);
  } catch (err) {
    console.error('OCR failed:', err.message);
    ocrWorkerPromise = null; // drop a possibly-dead worker
    return { amount: false, amountStatus: AMOUNT_UNREADABLE, vpa: false, utr: false };
  }

  const compact = text.replace(/\s+/g, '').toLowerCase();
  const digitsOnly = text.replace(/[^0-9]/g, '');
  const enteredUtrDigits = String(utr || '').replace(/[^0-9]/g, '');

  let candidates = amountCandidates(text);
  // Words are their own evidence, and confident evidence: a slip that spells
  // out an amount is stating it, not incidentally printing a number.
  //
  // Fee-shaped ones only, the same bar every other candidate clears. "From:
  // ONE TOUCH SERVICES" parses to 1 and "To: Six Sigma Hospital" to 6, and
  // marking those confident turned an unreadable slip into a red cross on
  // the strength of a word in the payer's name.
  const inWords = amountsInWords(text)
    .filter((n) => n >= MIN_FEE)
    .map((n) => ({ int: String(n), confident: true }));
  candidates = candidates.concat(inWords);
  let found = amountAppears(candidates, expectedAmount);

  // Second pass, only when the first could not find the amount -- so the cost
  // falls on the ~20% of slips that need it, not on every upload.
  if (!found) {
    try {
      const retry = await recognizeText(buffer, OCR_AMOUNT_PARAMS);
      const more = amountCandidates(retry, { lettersPossible: false });
      candidates = candidates.concat(more);
      found = amountAppears(more, expectedAmount);
    } catch (err) {
      console.error('OCR amount pass failed:', err.message);
      ocrWorkerPromise = null;
    }
  }

  // Not found. A number the slip presents AS the amount, but a different one,
  // is a real discrepancy; no such number at all means the check simply could
  // not read it, and saying "the amount is wrong" on that basis is what put a
  // cross on 37 correct slips.
  const amountStatus = found ? AMOUNT_MATCH
    : (candidates.some((c) => c.confident) ? AMOUNT_MISMATCH : AMOUNT_UNREADABLE);

  // VPA: the conference UPI id appears (compare ignoring whitespace/case).
  const vpa = compact.includes(UPI.id.replace(/\s+/g, '').toLowerCase());

  // UTR: the entered UTR digits appear in the image text.
  const utrMatch = enteredUtrDigits.length >= 6 && digitsOnly.includes(enteredUtrDigits);

  return { amount: found, amountStatus, vpa, utr: utrMatch };
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
  'bank_statement_transaction', 'role',
  'settings', // legacy: pre-rename NOTIFICATION_TOGGLE rows only
];

// Login event -- entityId is the phone so the login log can be searched per
// delegate/admin like every other log.
async function recordLogin(phone, name, role) {
  await writeAuditRow('login', phone, 'LOGIN', null, null, phone, name, role).catch((err) => console.error('Login log failed:', err.message));
}

// Fetch program options (across every group) annotated with live enrollment
// counts, from registration_options -- the generalized join table that
// replaced the old fixed workshop_option_id/qi_option_id columns (see
// migrateProgramGroupsOnBoot). A slot is held by any non-rejected
// registration referencing the option -- except faculty, who are attached to
// the option (so they show on its roster/report) but don't occupy a
// capacity slot.
function fetchProgramOptions({ activeOnly } = {}) {
  return dbAll(`
    SELECT o.id, o.group_id, o.name, o.capacity, o.active, o.fee,
      (SELECT COUNT(*) FROM registration_options ro
         JOIN registrations r ON r.id = ro.registration_id
         WHERE ro.option_id = o.id AND ro.is_faculty = 0 AND r.bank_status != 'REJECTED') AS enrolled,
      (SELECT COUNT(*) FROM registration_options ro
         JOIN registrations r ON r.id = ro.registration_id
         WHERE ro.option_id = o.id AND ro.is_faculty = 1 AND r.bank_status != 'REJECTED') AS faculty_count
    FROM program_options o
    ${activeOnly ? 'WHERE o.active = 1' : ''}
    ORDER BY o.group_id, o.id`);
}

// Groups with their options nested, in sort order -- the shape the delegate
// form, admin Program Groups section, and setup wizard all build their UI
// from.
async function fetchProgramGroups({ activeOnly } = {}) {
  const [groups, options] = await Promise.all([
    dbAll(`SELECT * FROM program_groups ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort_order, id`),
    fetchProgramOptions({ activeOnly }),
  ]);
  return groups.map((g) => ({ ...g, options: options.filter((o) => o.group_id === g.id) }));
}

// Validate one chosen option and confirm it still has room. `ownRegId` is
// the caller's existing registration (excluded from the count on
// re-submission). Group membership (one-per-group vs. max_select, required
// groups) is enforced by the caller across the full set of selections --
// this only checks the single option in isolation.
async function resolveOption(id, ownRegId) {
  const opt = await dbGet('SELECT * FROM program_options WHERE id = ? AND active = 1', [id]);
  if (!opt) return { error: 'Please choose an available option.' };

  const { n } = await dbGet(
    `SELECT COUNT(*) AS n FROM registration_options ro
       JOIN registrations r ON r.id = ro.registration_id
       WHERE ro.option_id = ? AND ro.is_faculty = 0 AND r.bank_status != 'REJECTED' AND r.id != ?`,
    [id, ownRegId == null ? -1 : ownRegId]
  );
  if (n >= opt.capacity) return { error: `"${opt.name}" is full. Please choose another option.` };
  return { opt };
}

// Validate a full set of chosen option ids against every active group's
// required/max_select rules, and against each option's own capacity.
// Returns { error } on the first problem found, or { selections } -- an
// array of { groupId, optionId } ready to write to registration_options.
async function resolveSelections(optionIds, ownRegId) {
  const ids = [...new Set((optionIds || []).map((v) => Number(v)).filter(Number.isInteger))];
  const groups = await fetchProgramGroups({ activeOnly: true });
  const optionById = new Map(groups.flatMap((g) => g.options.map((o) => [o.id, o])));

  for (const id of ids) {
    if (!optionById.has(id)) return { error: 'One of the selected options is no longer available.' };
  }

  const selections = [];
  for (const group of groups) {
    const chosen = ids.filter((id) => optionById.get(id).group_id === group.id);
    if (group.required && chosen.length === 0) {
      return { error: `Please choose an option under "${group.name}".` };
    }
    if (chosen.length > group.max_select) {
      return { error: `You can choose at most ${group.max_select} option(s) under "${group.name}".` };
    }
    for (const id of chosen) {
      const resolved = await resolveOption(id, ownRegId);
      if (resolved.error) return { error: resolved.error };
      selections.push({ groupId: group.id, optionId: id, opt: resolved.opt });
    }
  }
  return { selections };
}

// Replace a registration's chosen options wholesale (self-service submission
// is never faculty -- that flag is only ever set by an admin, via the
// enroll/faculty endpoints below, and would otherwise be silently reset on
// every resubmission anyway since a delegate can't set it themselves).
async function saveRegistrationSelections(registrationId, selections) {
  await dbRun('DELETE FROM registration_options WHERE registration_id = ?', [registrationId]);
  for (const s of selections) {
    await dbRun(
      'INSERT INTO registration_options (registration_id, group_id, option_id, is_faculty) VALUES (?, ?, ?, 0)',
      [registrationId, s.groupId, s.optionId]
    );
  }
}

// A registration's chosen options, joined with their group/option names --
// what the dashboard, receipt, and admin user-detail panel all display.
// Ordered by group sort_order so it reads the same way everywhere.
async function fetchRegistrationSelections(registrationId) {
  return dbAll(
    `SELECT g.id AS group_id, g.name AS group_name, o.id AS option_id, o.name AS option_name, ro.is_faculty,
            o.fee AS option_fee
       FROM registration_options ro
       JOIN program_options o ON o.id = ro.option_id
       JOIN program_groups g ON g.id = ro.group_id
       WHERE ro.registration_id = ?
       ORDER BY g.sort_order, g.id, o.name`,
    [registrationId]
  );
}

// Today's calendar date in IST, as YYYY-MM-DD.
//
// Every cutoff in this app (pricing phases, promo expiry, conference dates)
// is an INDIAN calendar date -- "early bird ends 31 August" means the end of
// 31 August in Sevagram, not in UTC. The server, though, runs UTC in Docker,
// and toISOString() is UTC regardless of the host's timezone. Reading the
// date straight off it therefore reported yesterday for the 5.5 hours
// between midnight and 05:30 IST, which kept early-bird pricing alive for
// most of the night after it should have ended.
//
// toLocaleDateString('en-CA', {timeZone}) is the "correct" way to do this,
// but silently falls back to US M/D/YYYY on this Node build's limited ICU --
// no error, just the wrong format, which breaks the string comparisons these
// callers do. Shifting the clock by IST's fixed +5:30 and reading the UTC
// date is ICU-independent. India has no DST, so a fixed offset is exact.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istDateString(when = Date.now()) {
  return new Date(Number(when) + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// Which pricing phase is in effect today, from the configured cutoff dates.
// Four phases: early (<= early_until), regular (<= regular_until),
// late (<= late_until), spot (after late_until, or if no cutoffs are set).
function currentPhase(config, today = new Date()) {
  const d = istDateString(today); // YYYY-MM-DD, IST
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
    const today = istDateString();
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
// monotonic sequence at signup so it exists before any payment. The prefix
// is CONFERENCE.regPrefix (Settings → General → Conference Details) at the
// moment of assignment -- a later prefix change never touches numbers
// already assigned, only ones generated after the change.
async function assignUserRegNumber(phone) {
  const u = await dbGet('SELECT registration_number FROM users WHERE phone_number = ?', [phone]);
  if (u && u.registration_number) return u.registration_number;

  // No prefix, no number.
  //
  // On 28 August 2026 a deploy blanked the hardcoded conference defaults so
  // the app wouldn't be tied to one event, expecting first-run setup to
  // refill them. On an already-running instance nothing had ever written the
  // prefix to schema_meta, so for the four hours until Settings was saved
  // this concatenated an empty prefix and issued '1274' and '1275' to two
  // real delegates -- numbers that looked assigned, were carried onto their
  // receipts and confirmation emails, and had to be repaired by hand.
  //
  // Leaving it unassigned is the recoverable failure: the sequence is not
  // consumed, nothing wrong is stored, and the next call -- the next signup,
  // or this delegate submitting their registration -- issues a correct number
  // the moment a prefix exists. A bare sequence number repairs itself never,
  // and the boot-time backfills skip it because it isn't empty.
  const prefix = String(CONFERENCE.regPrefix || '').trim();
  if (!prefix) {
    console.error('[reg-number] No registration-number prefix is configured '
      + '(Settings -> General -> Conference Details). Leaving this delegate unnumbered '
      + 'rather than issuing a bare sequence number.');
    return null;
  }

  const seq = await dbRun('INSERT INTO reg_seq DEFAULT VALUES');
  const number = prefix + String(seq.lastID).padStart(4, '0');
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
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.error('Error connecting to SQLite:', err);
  else console.log('Connected to SQLite database.');
});

// Promise wrappers so the auth flow reads sequentially.
const dbGet = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
const dbAll = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const dbRun = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

// db.serialize() only orders statements relative to WHEN they're queued, not
// their position in this file. The additive migrations below queue their
// ALTER TABLE statements dynamically, from inside a PRAGMA callback -- so on
// an established database (nothing to add) they're a same-tick no-op, but on
// a genuinely fresh one (every column missing), that queueing happens well
// after boot code positioned "later" in this file has already been queued --
// and, empirically, after code that runs via a separate async chain (like the
// retitleNamesOnBoot()... sequence near the bottom of this file) has already
// STARTED EXECUTING, since that chain's first query gets queued essentially
// immediately once this synchronous block finishes, before any of these
// dynamically-nested ALTERs have even been added to the queue. Confirmed by
// tracing an actual fresh boot: retitleNamesOnBoot's first query fired before
// the "Connected to SQLite database" callback even printed.
//
// These two promises are the fix: every piece of boot-time code that reads a
// column added only by one of these two migrations awaits the matching
// promise first, instead of trusting queue-position timing. See where each
// resolves, below, for exactly what "done" means.
let resolveFeeCategoriesMigration, resolveRegistrationsMigration;
const feeCategoriesMigrationReady = new Promise((resolve) => { resolveFeeCategoriesMigration = resolve; });
const registrationsMigrationReady = new Promise((resolve) => { resolveRegistrationsMigration = resolve; });

db.serialize(() => {
  // USER KEY: phone_number is this app's account identifier -- the primary
  // key here and the join column in registrations, abstracts, sessions,
  // payment_transactions, group_members and the audit trail. Since email-only
  // signup exists, it is no longer necessarily a phone number: treat it as an
  // opaque key, and read the actual contact details from the `phone` and
  // `email` columns instead.
  //
  // It still HOLDS the phone number for every account created through the
  // phone flow (including all 300-odd that predate email signup), which is
  // why no data migration was needed and why admin screens and audit rows
  // still read naturally. Email-only accounts get a synthetic key instead
  // (see newUserKey) -- deliberately not the email address itself, so that
  // changing your email never has to cascade across every table that joins
  // on it.
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
   // Optional password login (see hashPassword/verifyPassword above), an
   // alternative to OTP for every account type. NULL until a user sets one;
   // OTP still works either way, and registration still requires OTP to
   // prove phone ownership regardless of whether a password is also set.
   'ALTER TABLE users ADD COLUMN password_hash TEXT',
   // --- IDENTITY MODEL (see USER KEY note on the users table above) --------
   // The actual phone number, as a contact channel rather than an identity.
   // Distinct from phone_number, which is now an opaque account key: for
   // every pre-existing account and every phone-based signup the two hold
   // the same 10-digit value (so nothing about existing data or joins
   // changes), but an email-only signup has a synthetic key in
   // phone_number and NULL here until they add a number.
   'ALTER TABLE users ADD COLUMN phone TEXT',
   // Which channels this account has actually proven control of, by
   // answering an OTP sent to them. At least one must be verified for the
   // account to be reachable at all -- see resolveLoginIdentifier(), which
   // refuses to send a login OTP to an unverified channel.
   'ALTER TABLE users ADD COLUMN phone_verified INTEGER DEFAULT 0',
   'ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0',
   // Where the delegate is. Needed to tell an international delegate apart
   // from an Indian one who simply has no PIN code on file -- without it the
   // address fields alone can't distinguish them, and neither can the
   // reports. Every account predating international support is Indian.
   'ALTER TABLE users ADD COLUMN country TEXT',
   // Present in long-running deployments but never created anywhere, so a
   // FRESH install had no such column while the Users report selected it --
   // that report would have failed on any new deployment. Found by building a
   // database from scratch for the test fixtures.
   'ALTER TABLE users ADD COLUMN post_office TEXT',
  ].forEach((sql) => db.run(sql, () => {}));

  db.run("UPDATE users SET country = 'India' WHERE country IS NULL OR country = ''", () => {});

  // One-time identity backfill for accounts predating the columns above.
  // Every such account signed up through the phone+OTP flow, which was the
  // only way in, so its phone_number is a real, OTP-proven number: copy it
  // into the new phone column and mark it verified. Emails are NOT marked
  // verified -- they were only ever self-asserted at signup, never proven,
  // which is exactly why existing users get asked to verify theirs at next
  // login. Guarded on phone IS NULL so it only ever runs once.
  db.run("UPDATE users SET phone = phone_number, phone_verified = 1 WHERE phone IS NULL AND phone_number GLOB '[0-9]*'", () => {});

  // Phone numbers are stored in E.164 (+<country><number>) so that Indian
  // and international numbers are the same kind of value everywhere. Every
  // account predating international support is Indian by construction --
  // signup was 10-digit-only -- so a bare 10-digit number is prefixed +91.
  // Guarded on the shape, so this runs once and is a no-op afterwards; the
  // account key (phone_number) is deliberately NOT touched, since eight
  // tables join on it.
  db.run("UPDATE users SET phone = '+91' || phone WHERE phone GLOB '[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'", () => {});

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

  // Additive migration for databases created before the review workflow
  // existed.
  db.all('PRAGMA table_info(abstracts)', async (err, cols) => {
    if (err) return console.error('Schema check failed:', err.message);
    const names = cols.map((c) => c.name);
    if (!names.includes('status')) db.run("ALTER TABLE abstracts ADD COLUMN status TEXT DEFAULT 'UNDER_REVIEW'");
    if (!names.includes('allocation')) db.run('ALTER TABLE abstracts ADD COLUMN allocation TEXT'); // ORAL | POSTER
    // Structured submission: one column per section. abstract_file (the old
    // PDF-upload column) and the never-used legacy `text` column are gone
    // from the app's own writes -- PDF upload/serving/conversion was
    // removed once every abstract had been migrated to this format -- but
    // an existing database keeps whatever value is already in those
    // columns (harmless leftover, same as `text` always was). Each of
    // these five holds sanitizeAbstractHtml() output (escaped text with
    // only <b>/<i>/<sup>/<sub> restored); word_count is computed from
    // their combined plain text (see plainTextWordCount) at submit time.
    if (!names.includes('background')) db.run('ALTER TABLE abstracts ADD COLUMN background TEXT');
    if (!names.includes('aim')) db.run('ALTER TABLE abstracts ADD COLUMN aim TEXT');
    if (!names.includes('methods')) db.run('ALTER TABLE abstracts ADD COLUMN methods TEXT');
    if (!names.includes('results')) db.run('ALTER TABLE abstracts ADD COLUMN results TEXT');
    if (!names.includes('conclusion')) db.run('ALTER TABLE abstracts ADD COLUMN conclusion TEXT');
    if (!names.includes('keywords')) db.run('ALTER TABLE abstracts ADD COLUMN keywords TEXT');
    // Reviewer's note when sending an abstract back for corrections (status
    // REVISION_REQUESTED) -- shown to the delegate, who can then edit and
    // resubmit through the same POST /api/abstracts endpoint (normally
    // blocked once an abstract exists at all; this is the one status that
    // reopens it). Cleared whenever the status moves away from
    // REVISION_REQUESTED, same as `allocation` clearing on a non-ACCEPTED
    // status change.
    if (!names.includes('revision_note')) db.run('ALTER TABLE abstracts ADD COLUMN revision_note TEXT');

    // Enforce one abstract per author: drop duplicates (keep the latest) BEFORE
    // creating the unique index. Sequenced so the index can't fail on dupes.
    try {
      await dbRun('DELETE FROM abstracts WHERE id NOT IN (SELECT MAX(id) FROM abstracts GROUP BY phone_number)');
      await dbRun('CREATE UNIQUE INDEX IF NOT EXISTS idx_abstracts_phone ON abstracts(phone_number)');
    } catch (e) {
      console.error('Abstract unique-index migration failed:', e.message);
    }
  });

  // One-time password codes, keyed by DESTINATION -- a phone number or an
  // email address (one active code per destination), since an OTP can now
  // be sent to either channel. `channel` is 'sms' or 'email', recorded so a
  // consuming endpoint can tell which contact method a code actually proves.
  //
  db.run(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      destination TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0,
      last_sent_at INTEGER NOT NULL
    )
  `);
  // The pre-email-signup table was keyed by phone_number and had no channel
  // column. Replace it in place, ONCE -- detected by looking for the old
  // column rather than dropping unconditionally, which would wipe live
  // in-flight codes on every restart. Nothing durable is lost either way:
  // OTPs are short-lived (OTP_TTL_MS) and single-use, so at worst someone
  // mid-login when this first deploys requests a fresh code.
  db.all('PRAGMA table_info(otp_codes)', (err, cols) => {
    if (err || !cols || !cols.some((c) => c.name === 'phone_number')) return;
    db.serialize(() => {
      db.run('DROP TABLE otp_codes');
      db.run(`
        CREATE TABLE otp_codes (
          destination TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          otp_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          attempts INTEGER DEFAULT 0,
          last_sent_at INTEGER NOT NULL
        )
      `);
    });
  });

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
  // per-option participant cap. Admin-editable. `type` is legacy (used to be
  // the only grouping mechanism, hardcoded to 'WORKSHOP' | 'QI' -- see
  // program_groups below, which replaced it) -- kept NOT NULL so old rows
  // stay readable, but nothing new reads it; group_id is the real grouping
  // key going forward, added below as an additive column.
  db.run(`
    CREATE TABLE IF NOT EXISTS program_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 50,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `);

  // Named, admin-configurable groups of program options (e.g. "Workshops",
  // "QI Practices", or any further group a conference wants) -- see the
  // migration below for how the two that used to be hardcoded (WORKSHOP/QI)
  // became rows here. `required` gates registration submission (see
  // POST /api/registrations); `max_select` bounds how many options within
  // the group one delegate may choose (1 today for both migrated groups,
  // but configurable per group so a future group can allow more).
  db.run(`
    CREATE TABLE IF NOT EXISTS program_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      required INTEGER NOT NULL DEFAULT 0,
      max_select INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `);
  db.run('ALTER TABLE program_options ADD COLUMN group_id INTEGER', () => {});
  // Per-option fee, added on top of the delegate's category fee when they
  // choose it (see resolveSelections/POST /api/registrations) -- e.g. a
  // paid pre-conference workshop alongside a free main registration.
  // Defaults to 0 so every existing option (and a fresh install's) costs
  // nothing until an admin sets otherwise.
  db.run('ALTER TABLE program_options ADD COLUMN fee REAL NOT NULL DEFAULT 0', () => {});

  // A delegate's chosen options across every group -- the generalized
  // replacement for the old fixed workshop_option_id/qi_option_id columns on
  // registrations (still physically present there, frozen, as a rollback
  // net -- see migrateProgramGroupsOnBoot). One row per (registration,
  // option); the PK also doubles as "can't pick the same option twice".
  // How many rows one registration may hold within a given group is
  // max_select on program_groups, enforced in application code (POST
  // /api/registrations), not by the schema, since SQLite can't express a
  // per-group row-count constraint declaratively.
  db.run(`
    CREATE TABLE IF NOT EXISTS registration_options (
      registration_id INTEGER NOT NULL,
      group_id INTEGER NOT NULL,
      option_id INTEGER NOT NULL,
      is_faculty INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (registration_id, option_id)
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
  // phase existed. feeCategoriesMigrationReady (see above) resolves once
  // every branch below has actually finished -- the fee-category seed block
  // further down awaits it before inserting a single row.
  db.all('PRAGMA table_info(fee_categories)', (err, cols) => {
    if (err) { console.error('Schema check failed:', err.message); return resolveFeeCategoriesMigration(); }
    const names = cols.map((c) => c.name);
    const pending = [];
    if (!names.includes('spot_fee')) {
      pending.push(new Promise((resolve) => {
        db.run('ALTER TABLE fee_categories ADD COLUMN spot_fee REAL NOT NULL DEFAULT 0', () => {
          // Default the new spot fee to the late fee so existing categories
          // keep charging something sane until an admin sets it explicitly.
          db.run('UPDATE fee_categories SET spot_fee = late_fee WHERE spot_fee = 0', resolve);
        });
      }));
    }
    if (!names.includes('subtitle')) {
      pending.push(new Promise((resolve) => {
        db.run("ALTER TABLE fee_categories ADD COLUMN subtitle TEXT NOT NULL DEFAULT ''", resolve);
      }));
    }
    // Student-ID requirement moved from the hardcoded STUDENT_CATEGORIES
    // object to per-category columns, admin-editable from the Fees tab.
    // id_discipline/id_level are dormant: they only ever told the ID-card
    // OCR which keywords to expect, and that check has been removed. Kept
    // rather than dropped, since a historical setting is harmless to retain
    // and dropping a column on a live SQLite database mid-event is not
    // worth the risk. Nothing reads or writes them.
    if (!names.includes('requires_student_id')) {
      pending.push(new Promise((resolve) => {
        db.run('ALTER TABLE fee_categories ADD COLUMN requires_student_id INTEGER NOT NULL DEFAULT 0', () => {
          db.run('ALTER TABLE fee_categories ADD COLUMN id_discipline TEXT', () => {
            db.run('ALTER TABLE fee_categories ADD COLUMN id_level TEXT', () => {
              // One-time backfill: the four categories STUDENT_CATEGORIES used to
              // hardcode already exist as fee_categories rows with these exact
              // keys (seeded below) -- carry their old discipline/level over so
              // behavior is unchanged for existing deployments.
              const legacy = [
                ['nursing_ug', 'nursing', 'UG'], ['nursing_pg', 'nursing', 'PG'],
                ['med_student', 'medical', 'UG'], ['pg_doctor', 'medical', 'PG'],
              ];
              for (const [key, discipline, level] of legacy) {
                db.run(
                  'UPDATE fee_categories SET requires_student_id = 1, id_discipline = ?, id_level = ? WHERE category_key = ? AND requires_student_id = 0',
                  [discipline, level, key]
                );
              }
              resolve();
            });
          });
        });
      }));
    }
    Promise.all(pending).then(resolveFeeCategoriesMigration);
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
  // Additive migration for statement tables created before non-registration
  // marking existed (e.g. bank charges, interest credit, an unrelated
  // transfer -- a real credit in the statement that will never belong to a
  // registration, so it shouldn't keep sitting in "unmatched" waiting for a
  // match that's never coming).
  db.all('PRAGMA table_info(bank_statement_transactions)', (err, cols) => {
    if (err) return console.error('Schema check failed:', err.message);
    if (!cols.map((c) => c.name).includes('is_non_registration')) {
      db.run('ALTER TABLE bank_statement_transactions ADD COLUMN is_non_registration INTEGER NOT NULL DEFAULT 0');
    }
  });

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
  // Used to be UNIQUE (a bank credit could back at most one payment
  // transaction). One credit can now be split across several delegates --
  // see allocatedForBankTxn() -- so the constraint moved from the schema
  // into application-level checks at link time (sum of allocations <= the
  // credit's own amount). Migrate an existing UNIQUE index down to a plain
  // one; a fresh install just gets the plain index directly.
  db.get("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_paytxn_bank_txn_id'", (err, row) => {
    if (err) return console.error('Schema check failed:', err.message);
    if (row && /UNIQUE/i.test(row.sql || '')) {
      db.run('DROP INDEX idx_paytxn_bank_txn_id', () => {
        db.run('CREATE INDEX IF NOT EXISTS idx_paytxn_bank_txn_id ON payment_transactions(bank_txn_id)');
      });
    } else if (!row) {
      db.run('CREATE INDEX IF NOT EXISTS idx_paytxn_bank_txn_id ON payment_transactions(bank_txn_id)');
    }
  });

  // Bookkeeping record of money sent back to a delegate who paid more than
  // their fee (e.g. two genuine transactions linked to one registration --
  // see the relaxed over-crediting guard above). This app has never moved
  // money in either direction; a row here means "we sent this back
  // manually and I'm recording it," not a trigger to transfer anything.
  // getPaymentSummary() nets this off verifiedTotal so a refunded
  // registration doesn't sit there looking permanently overpaid.
  db.run(`
    CREATE TABLE IF NOT EXISTS payment_refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registration_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      reference_note TEXT,
      refunded_by TEXT,
      refunded_at INTEGER NOT NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_payment_refunds_reg ON payment_refunds(registration_id)');
  // A refund must now be backed by an actual debit row from the imported
  // bank statement -- proof the money genuinely left the account, the same
  // way a payment must be backed by a credit row before it can be verified.
  // UNIQUE (not the split-friendly plain index payment_transactions.bank_txn_id
  // uses): one statement debit is one real outgoing transfer, so it can back
  // at most one refund record.
  db.run('ALTER TABLE payment_refunds ADD COLUMN bank_txn_id INTEGER', () => {});
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_refunds_bank_txn_id ON payment_refunds(bank_txn_id)');

  // Additive migrations: server-computed fee, OCR check results, registration
  // number, and the chosen program-option ids (for capacity accounting).
  // registrationsMigrationReady (see above) resolves once the two backfill
  // UPDATEs at the end of this callback complete -- by then every ALTER
  // above them has necessarily already finished too (db.serialize() runs the
  // statements THIS callback queues strictly in the order they're queued).
  db.all('PRAGMA table_info(registrations)', (err, cols) => {
    if (err) { console.error('Schema check failed:', err.message); return resolveRegistrationsMigration(); }
    const names = cols.map((c) => c.name);
    // Every conditional ALTER below is tracked in `pending` and explicitly
    // awaited before the two backfill UPDATEs run -- NOT just relied on as
    // "queued earlier, so it must finish first". Empirically, two sibling
    // db.run(sql) calls issued in the same synchronous callback are NOT
    // reliably ordered against each other by db.serialize() alone when
    // neither has a callback chaining to the other: tracing an actual fresh
    // boot showed the registration_number backfill UPDATE below running (and
    // failing with "no such column") before this block's OWN ALTER ADD
    // COLUMN registration_number had completed, despite both being queued in
    // the same callback invocation. Only an explicit completion signal
    // (a promise here, resolved from each statement's own callback) is safe.
    const alter = (sql) => new Promise((resolve) => db.run(sql, resolve));
    const pending = [];
    if (!names.includes('expected_amount')) pending.push(alter('ALTER TABLE registrations ADD COLUMN expected_amount REAL'));
    if (!names.includes('ocr_amount_match')) pending.push(alter('ALTER TABLE registrations ADD COLUMN ocr_amount_match INTEGER'));
    // 'match' | 'mismatch' | 'unreadable'. ocr_amount_match stays as it was
    // (1 only for a match) so nothing reading the old column changes meaning;
    // this says WHY it is not 1, which is the difference between a slip that
    // contradicts the fee and one whose amount simply could not be read.
    if (!names.includes('ocr_amount_status')) pending.push(alter("ALTER TABLE registrations ADD COLUMN ocr_amount_status TEXT"));
    if (!names.includes('ocr_vpa_match')) pending.push(alter('ALTER TABLE registrations ADD COLUMN ocr_vpa_match INTEGER'));
    if (!names.includes('ocr_utr_match')) pending.push(alter('ALTER TABLE registrations ADD COLUMN ocr_utr_match INTEGER'));
    if (!names.includes('registration_number')) pending.push(alter('ALTER TABLE registrations ADD COLUMN registration_number TEXT'));
    if (!names.includes('workshop_option_id')) pending.push(alter('ALTER TABLE registrations ADD COLUMN workshop_option_id INTEGER'));
    if (!names.includes('qi_option_id')) pending.push(alter('ALTER TABLE registrations ADD COLUMN qi_option_id INTEGER'));
    // Faculty for a workshop/QI practice are enrolled the same way as a
    // delegate (same option_id columns) but don't occupy a capacity slot and
    // are labeled "Faculty" instead of counted as an attendee -- see
    // fetchProgramOptions() and the workshops report.
    if (!names.includes('workshop_is_faculty')) pending.push(alter('ALTER TABLE registrations ADD COLUMN workshop_is_faculty INTEGER DEFAULT 0'));
    if (!names.includes('qi_is_faculty')) pending.push(alter('ALTER TABLE registrations ADD COLUMN qi_is_faculty INTEGER DEFAULT 0'));
    if (!names.includes('id_card')) pending.push(alter('ALTER TABLE registrations ADD COLUMN id_card TEXT'));
    // Dormant: held the ID-card OCR verdict, which no longer exists. Kept so
    // historical rows are not rewritten; nothing reads or writes it.
    if (!names.includes('ocr_id_match')) pending.push(alter('ALTER TABLE registrations ADD COLUMN ocr_id_match INTEGER'));
    if (!names.includes('rejection_reason')) pending.push(alter('ALTER TABLE registrations ADD COLUMN rejection_reason TEXT'));
    if (!names.includes('rejection_note')) pending.push(alter('ALTER TABLE registrations ADD COLUMN rejection_note TEXT'));
    if (!names.includes('payment_mode')) pending.push(alter("ALTER TABLE registrations ADD COLUMN payment_mode TEXT DEFAULT 'UPI'"));
    if (!names.includes('submitted_at')) pending.push(alter('ALTER TABLE registrations ADD COLUMN submitted_at INTEGER'));
    if (!names.includes('bank_txn_id')) {
      pending.push(new Promise((resolve) => {
        db.run('ALTER TABLE registrations ADD COLUMN bank_txn_id INTEGER', () => {
          // One statement transaction can back at most one registration. SQLite
          // treats each NULL as distinct in a UNIQUE index, so unlinked rows
          // (the common case) never collide with each other.
          db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_registrations_bank_txn_id ON registrations(bank_txn_id)', resolve);
        });
      }));
    }
    // Admin (approver) confirmation that a student category's uploaded ID
    // card actually verifies that status -- this is now the ONLY ID check,
    // which is only the automated advisory check. Required before a student
    // registration can be verified (see PUT .../status).
    if (!names.includes('id_verified')) pending.push(alter('ALTER TABLE registrations ADD COLUMN id_verified INTEGER DEFAULT 0'));
    if (!names.includes('id_verified_by')) pending.push(alter('ALTER TABLE registrations ADD COLUMN id_verified_by TEXT'));
    if (!names.includes('id_verified_at')) pending.push(alter('ALTER TABLE registrations ADD COLUMN id_verified_at INTEGER'));
    // Admin category lock: when set, the delegate cannot change their category
    // on the portal and the fee is fixed to the locked category (see the
    // lock-category endpoint).
    if (!names.includes('category_locked')) pending.push(alter('ALTER TABLE registrations ADD COLUMN category_locked INTEGER DEFAULT 0'));
    // Applied promo/discount code and the rupee amount it took off the fee.
    if (!names.includes('discount_code')) pending.push(alter('ALTER TABLE registrations ADD COLUMN discount_code TEXT'));
    if (!names.includes('discount_amount')) pending.push(alter('ALTER TABLE registrations ADD COLUMN discount_amount REAL DEFAULT 0'));

    Promise.all(pending).then(() => {
      // Backfill a number for any already-verified registration that predates
      // number assignment. Idempotent -- matches nothing once filled. Runs at
      // boot, before loadGeneralSettings() has read CONFERENCE.regPrefix from
      // schema_meta, and only ever repairs pre-existing legacy rows -- so it
      // intentionally stays on the literal historical prefix rather than
      // CONFERENCE.regPrefix (unlike assignUserRegNumber, which runs from
      // request handlers well after boot and does use the live value).
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
          WHERE registration_number LIKE 'NQOCN2026-%'`,
        resolveRegistrationsMigration
      );
    });
  });

  // No auto-seeded workshops, QI practices, or fee categories -- this app is
  // not tied to one specific conference, so a fresh install starts with
  // none of any of it and the first-run setup wizard (see GET /setup) walks
  // the operator through adding their own, the same way it already does for
  // Conference Details/UPI/SMS/Email. The row below is the one exception:
  // fee_config's schema requires exactly one row (id INTEGER PRIMARY KEY
  // CHECK (id = 1)), so an empty one with no dates is seeded rather than
  // left missing -- currentPhase() already treats null *_until fields as
  // "spot pricing", a safe default until the operator sets real phase dates.
  db.run('INSERT OR IGNORE INTO fee_config (id, early_until, regular_until, late_until) VALUES (1, NULL, NULL, NULL)');

  // --- ROLES -------------------------------------------------------------
  // A role stops being a constant and becomes a row. What a role may DO is
  // still the catalogue's business (permissions.js): the permission keys are
  // code, because each one has to correspond to a guard the server actually
  // applies. Which of them a role holds is data, because that is the part
  // worth editing without a deploy.
  //
  // grants_all is Super Admin's alone: it holds every permission including
  // ones added after it was written, which is what makes it the way back in
  // when another role is misconfigured. It is stored as a flag rather than as
  // 43 rows so that a permission added next year is covered without a
  // migration.
  //
  // event_id is null and unused today. The deferred multi-event work moves
  // roles per event, and one nullable column now is a great deal cheaper than
  // a second migration over the same table later.
  db.run(`
    CREATE TABLE IF NOT EXISTS roles (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      grants_all INTEGER NOT NULL DEFAULT 0,
      event_id INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_key TEXT NOT NULL,
      permission TEXT NOT NULL,
      PRIMARY KEY (role_key, permission)
    )
  `);
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

// One-time-ever: migrate the old hardcoded WORKSHOP/QI program_options.type
// pair into two rows in program_groups ("Workshops", "QI Practices" -- same
// names delegates already know), point every existing option at its new
// group_id, and copy every delegate's existing choice (from the frozen
// workshop_option_id/qi_option_id/*_is_faculty columns on registrations)
// into registration_options, the new join table everything reads from going
// forward -- see fetchProgramGroups/resolveOption/POST /api/registrations.
//
// A fresh install has no typed program_options rows yet (the setup wizard
// creates groups itself), so this is a no-op there -- it only matters for a
// deployment upgrading from before groups existed. Guarded by a schema_meta
// flag, same run-once-ever + pre-listen pattern as the backfills above (it
// must finish before a live self-service submission could race it), and the
// join-row inserts use INSERT OR IGNORE so a boot that dies partway through
// (before the flag is set) safely re-runs to completion next start rather
// than double-inserting.
async function migrateProgramGroupsOnBoot() {
  const already = await dbGet("SELECT value FROM schema_meta WHERE key = 'program_groups_migrated'");
  if (already) return;

  const typed = await dbAll("SELECT id, type FROM program_options WHERE group_id IS NULL AND type IN ('WORKSHOP','QI')");
  if (typed.length) {
    const groupIdFor = {};
    for (const [type, name] of [['WORKSHOP', 'Workshops'], ['QI', 'QI Practices']]) {
      if (!typed.some((o) => o.type === type)) continue;
      let row = await dbGet('SELECT id FROM program_groups WHERE name = ?', [name]);
      if (!row) {
        const sortOrder = type === 'WORKSHOP' ? 1 : 2;
        const result = await dbRun(
          'INSERT INTO program_groups (name, description, required, max_select, sort_order, active, created_at) VALUES (?, NULL, 0, 1, ?, 1, ?)',
          [name, sortOrder, Date.now()]
        );
        row = { id: result.lastID };
      }
      groupIdFor[type] = row.id;
    }
    for (const opt of typed) {
      await dbRun('UPDATE program_options SET group_id = ? WHERE id = ?', [groupIdFor[opt.type], opt.id]);
    }

    const regs = await dbAll(
      'SELECT id, workshop_option_id, qi_option_id, workshop_is_faculty, qi_is_faculty FROM registrations WHERE workshop_option_id IS NOT NULL OR qi_option_id IS NOT NULL'
    );
    for (const r of regs) {
      if (r.workshop_option_id) {
        await dbRun(
          'INSERT OR IGNORE INTO registration_options (registration_id, group_id, option_id, is_faculty) VALUES (?, ?, ?, ?)',
          [r.id, groupIdFor.WORKSHOP, r.workshop_option_id, r.workshop_is_faculty ? 1 : 0]
        );
      }
      if (r.qi_option_id) {
        await dbRun(
          'INSERT OR IGNORE INTO registration_options (registration_id, group_id, option_id, is_faculty) VALUES (?, ?, ?, ?)',
          [r.id, groupIdFor.QI, r.qi_option_id, r.qi_is_faculty ? 1 : 0]
        );
      }
    }

    // Verify before flagging done: a legacy selection must have produced
    // exactly one registration_options row, or this boot doesn't mark the
    // migration complete and will retry from scratch next start.
    const expected = regs.reduce((n, r) => n + (r.workshop_option_id ? 1 : 0) + (r.qi_option_id ? 1 : 0), 0);
    const { n: actual } = await dbGet(
      `SELECT COUNT(*) AS n FROM registration_options WHERE registration_id IN (${regs.map(() => '?').join(',') || 'NULL'})`,
      regs.map((r) => r.id)
    );
    if (actual < expected) {
      console.error(`Program-groups migration incomplete (expected >= ${expected} join rows, found ${actual}) -- will retry next boot.`);
      return;
    }
  }

  await dbRun("INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('program_groups_migrated', ?)", [String(Date.now())]);
}

// --- ROLE RESOLUTION ------------------------------------------------------
//
// Roles live in the database now, so every permission check would otherwise
// be a query. They are read once into memory and re-read whenever they
// change. Single process, so there is no cross-node invalidation problem --
// that assumption is written down here because it stops being true the day
// this runs as two containers, and the fix then is to key the cache on a
// version column rather than to hope.
let roleCache = null;   // Map<roleKey, { grantsAll, permissions:Set }>

async function loadRoles() {
  const rows = await dbAll('SELECT key, label, description, is_system, grants_all FROM roles');
  const perms = await dbAll('SELECT role_key, permission FROM role_permissions');
  const next = new Map();
  for (const r of rows) {
    next.set(r.key, {
      key: r.key,
      label: r.label,
      description: r.description,
      isSystem: !!r.is_system,
      grantsAll: !!r.grants_all,
      permissions: new Set(),
    });
  }
  for (const p of perms) {
    const role = next.get(p.role_key);
    // A permission naming a role that no longer exists, or a key that has
    // been retired from the catalogue, is ignored rather than trusted.
    if (role && PERMISSION_KEYS.includes(p.permission)) role.permissions.add(p.permission);
  }
  roleCache = next;
  return next;
}

// Seed the five built-in roles from the catalogue.
//
// Only ever inserts a role that is absent. Re-seeding an existing one every
// boot would silently undo an admin's edit the next time the app restarted,
// which is the sort of thing nobody notices until a role has quietly been
// wrong for a week.
async function seedRolesOnBoot() {
  const now = Date.now();
  let created = 0;
  for (const role of SYSTEM_ROLES) {
    const existing = await dbGet('SELECT key FROM roles WHERE key = ?', [role.key]);
    if (existing) continue;
    await dbRun(
      `INSERT INTO roles (key, label, description, is_system, grants_all, event_id, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, NULL, ?, ?)`,
      [role.key, role.label, role.description, role.all ? 1 : 0, now, now]);
    for (const permission of role.permissions || []) {
      await dbRun('INSERT OR IGNORE INTO role_permissions (role_key, permission) VALUES (?, ?)',
        [role.key, permission]);
    }
    created++;
  }
  await loadRoles();
  if (created) console.log(`Seeded ${created} built-in role(s) from the catalogue.`);
  return created;
}

// May this role do this? The only permission question the app asks.
//
// Falls back to the code catalogue when the cache is EMPTY -- meaning the
// load failed or the tables are missing -- because denying everything in
// that case would take the whole admin panel down mid-conference over a
// migration hiccup, and the answer the catalogue gives is the one the app
// shipped with. A role that is simply absent from a cache that DID load is
// denied: that is a role someone deleted, not a database that is broken, and
// the two must not be treated alike.
function can(roleKey, permission) {
  if (!roleCache || roleCache.size === 0) {
    if (!can.warned) {
      console.error('[roles] No roles loaded from the database -- falling back to the built-in catalogue.');
      can.warned = true;
    }
    return roleCan(roleKey, permission);
  }
  const role = roleCache.get(roleKey);
  if (!role) return false;
  if (role.grantsAll) return PERMISSION_KEYS.includes(permission);
  return role.permissions.has(permission);
}

// Is this a real, currently-existing admin role -- built-in or custom?
// POST /api/users, PUT /api/users/:phone/role and the /admin page's own
// access gate all used to check this against the five built-in role names
// directly. That was fine while those were the only roles that could ever
// exist; once the editor can create one, that check would silently refuse
// to assign a brand-new role to anyone, or lock out whoever it WAS assigned
// to when they next opened /admin -- a role editor whose roles can never
// actually be used. Checks the live cache, with the same empty-cache
// fallback can() uses: a broken load answers from the five built-in roles
// rather than refusing every admin wholesale over a migration hiccup.
function isKnownAdminRole(role) {
  if (!roleCache || roleCache.size === 0) return ADMIN_ROLES.includes(role);
  return roleCache.has(role);
}

// Everything a role holds, for the browser and for the role editor.
function permissionsOf(roleKey) {
  if (!roleCache || roleCache.size === 0) return permissionsForRole(roleKey);
  const role = roleCache.get(roleKey);
  if (!role) return [];
  return role.grantsAll ? PERMISSION_KEYS.slice() : [...role.permissions];
}

// May this role open that screen? Same rule as permissions.js's
// roleSeesSection, but asking the LIVE cache (can()) rather than the static
// catalogue -- a role edited through the database, or later the editor,
// changes what /api/auth/me reports without a deploy. SECTION_PERMISSIONS
// itself (which screen needs which permission) stays code: that mapping is
// about the shape of the admin panel, not something an admin edits.
function sectionVisible(roleKey, sectionKey) {
  const rule = SECTION_PERMISSIONS[sectionKey];
  if (!rule) return false;
  if (rule.anyOf) return rule.anyOf.some((k) => can(roleKey, k));
  return can(roleKey, rule.permission);
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
  const refunds = await dbAll(
    `SELECT payment_refunds.*, b.post_date AS bank_txn_date, b.description AS bank_txn_description
       FROM payment_refunds
       LEFT JOIN bank_statement_transactions b ON b.id = payment_refunds.bank_txn_id
      WHERE registration_id = ? ORDER BY refunded_at ASC, id ASC`,
    [registrationId]);
  const refundedTotal = refunds.reduce((sum, r) => sum + (r.amount || 0), 0);
  // What's actually still credited to this registration once recorded
  // refunds are netted out -- refundedTotal is 0 for every registration
  // until a refund is actually recorded, so this is verifiedTotal unchanged
  // for all existing data.
  const netVerifiedTotal = verifiedTotal - refundedTotal;
  const fee = expectedAmount || 0;
  const remaining = Math.max(0, fee - netVerifiedTotal);
  return {
    txns,
    refunds,
    verifiedTotal,
    refundedTotal,
    netVerifiedTotal,
    // How much is still sitting as unrefunded excess right now -- what a
    // "Record Refund" action defaults to.
    overpaid: Math.max(0, netVerifiedTotal - fee),
    remaining,
    fee,
    fullyPaid: fee > 0 && netVerifiedTotal >= fee,
    hasPartial: netVerifiedTotal > 0 && netVerifiedTotal < fee,
  };
}

// How much of one bank statement credit is already spoken for -- the cap a
// new allocation (regular link, admin-add-payment, or a future split) must
// stay under. optExcludeTxnId lets re-linking the same payment_transactions
// row not double-count its own prior allocation.
//
// The legacy registration-level link (registrations.bank_txn_id) never
// tracked a partial amount -- it was always all-or-nothing -- so any
// registration still using it treats the whole credit as allocated rather
// than trying to retrofit an amount onto data that never recorded one.
async function allocatedForBankTxn(bankTxnId, optExcludeTxnId) {
  const legacy = await dbGet('SELECT id, credit FROM bank_statement_transactions WHERE id = ?', [bankTxnId]);
  if (!legacy) return { allocated: 0, credit: 0, remaining: 0 };
  const legacyUser = await dbGet('SELECT id FROM registrations WHERE bank_txn_id = ?', [bankTxnId]);
  if (legacyUser) return { allocated: legacy.credit, credit: legacy.credit, remaining: 0 };

  const rows = await dbAll(
    `SELECT verified_amount, amount FROM payment_transactions
      WHERE bank_txn_id = ? AND txn_status = 'VERIFIED' AND id != ?`,
    [bankTxnId, optExcludeTxnId || -1]);
  const allocated = rows.reduce((sum, r) => sum + (r.verified_amount != null ? r.verified_amount : (r.amount || 0)), 0);
  return { allocated, credit: legacy.credit, remaining: Math.max(0, legacy.credit - allocated) };
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
// Same boot-time-ordering reasoning as the backfill above -- stays on the
// literal prefix rather than CONFERENCE.regPrefix, which isn't loaded yet.
// Waits for registrationsMigrationReady: the subquery below reads
// registrations.registration_number, which doesn't exist on a fresh install
// until that migration finishes.
registrationsMigrationReady.then(() => {
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
});

// Periodically purge expired OTPs and sessions. unref() so it never keeps
// the process (or a test run) alive on its own.
setInterval(() => {
  const now = Date.now();
  db.run('DELETE FROM otp_codes WHERE expires_at < ?', [now]);
  db.run('DELETE FROM sessions WHERE expires_at < ?', [now]);
}, 60 * 60 * 1000).unref();

// --- AUTH CORE ----------------------------------------------------------
// --- IDENTITY -----------------------------------------------------------
// A signup identifies itself by a phone number, an email address, or both.
// These helpers are the single place that decides which is which, so every
// endpoint agrees on what a given string is.
// --- PHONE NUMBERS ---------------------------------------------------
// Stored and compared as E.164 (+<country><number>), so an Indian and an
// international number are the same kind of value everywhere downstream.
// DEFAULT_PHONE_CC is what a bare national number is assumed to be: every
// account predating international support is Indian, and the delegate-facing
// forms still default to +91.
const DEFAULT_PHONE_CC = '91';
const E164_RE = /^\+[1-9]\d{7,14}$/;          // ITU-T E.164: up to 15 digits
const INDIAN_E164_RE = /^\+91[6-9]\d{9}$/;     // Indian mobiles start 6-9
// Pragmatic "good enough" email shape, not full RFC 5322 -- mirrored
// client-side in public/app.js. Used for every address this app accepts.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Anything a human might type -> E.164, or '' if it can't be one. Accepts
// "9823900641", "09823900641", "91 98239 00641", "+91-98239-00641" and
// "+44 7700 900123" alike, so a stored number and a typed one always compare
// equal regardless of how either was entered.
function toE164(v, defaultCc = DEFAULT_PHONE_CC) {
  let raw = String(v || '').trim().replace(/[\s()\-.]/g, '');
  if (!raw) return '';
  // A phone number never contains letters, and stripping them out rather than
  // rejecting the value was dangerous: an account key like u_4602062370abcd
  // has its letters removed, and whatever digits remain are read as a number.
  // When exactly ten survive, an account with NO phone at all displays a
  // fabricated mobile in reports and on its receipt.
  if (/[a-z]/i.test(raw)) return '';
  if (raw.startsWith('+')) return E164_RE.test(raw) ? raw : '';
  raw = raw.replace(/\D/g, '');
  if (!raw) return '';
  // A single leading 0 is the national trunk prefix, not part of the number.
  if (raw.length === 11 && raw.startsWith('0')) raw = raw.slice(1);
  // Already carries the default country code (e.g. "919823900641").
  if (raw.length > 10 && raw.startsWith(defaultCc)) {
    const withPlus = `+${raw}`;
    return E164_RE.test(withPlus) ? withPlus : '';
  }
  // Without an explicit country code we can only assume the default one,
  // and that assumption is only safe at the exact national length -- else
  // any short string of digits would silently become a "valid" number.
  if (raw.length !== 10) return '';
  const withCc = `+${defaultCc}${raw}`;
  return E164_RE.test(withCc) ? withCc : '';
}

// True for anything that can be turned into a usable phone number. Kept
// permissive on purpose: whether we can actually TEXT it is a separate
// question -- see isIndianPhone / the SMS guard in issueOtp.
const isPhoneValue = (v) => !!toE164(v);
// The only numbers we can send an SMS to: the gateway is an Indian DLT
// provider (see sendOtpSms), so a number outside +91 has no delivery path
// and must verify by email instead.
const isIndianPhone = (v) => INDIAN_E164_RE.test(toE164(v));
const isEmailValue = (v) => EMAIL_RE.test(String(v || '').trim());
// Emails are compared and stored case-insensitively: an OTP sent to
// Foo@Bar.com must satisfy a login as foo@bar.com, and the uniqueness check
// below must catch both as the same address.
const normalizeEmail = (v) => String(v || '').trim().toLowerCase();
const channelOf = (destination) => (isPhoneValue(destination) ? 'sms' : (isEmailValue(destination) ? 'email' : null));

// The account key for a signup with no phone number to use as one. Prefixed
// so it can never collide with, or be mistaken for, a real 10-digit number
// -- see the USER KEY note on the users table.
function newUserKey() {
  return `u_${crypto.randomBytes(9).toString('hex')}`;
}

// What to show in a "Mobile" column or on a receipt. Most rows carry the
// phone number in the account key itself, so this is usually just that
// value; an email-only account has a synthetic key there, which is an
// internal identifier and must never be printed as if it were a number.
// Falls back to the explicit `phone` column when a row carries one.
function displayPhone(row) {
  if (!row) return '';
  // Returns the full E.164 form INCLUDING the country code -- callers must
  // not prefix it themselves, which is what every "+91 " + displayPhone()
  // site used to do and what made an international number unprintable.
  if (row.phone) { const e = toE164(row.phone); if (e) return e; }
  const key = row.phone_number;
  return isPhoneValue(key) ? toE164(key) : '';
}

// Matching a phone number has to survive three shapes at once: the E.164
// form the backfill produced (+919823900641), a bare national number that
// somehow escaped it, and the legacy accounts whose `phone` is NULL but
// whose account key IS their number. Both sides are normalised to E.164
// first, so how the caller typed it never matters.
const PHONE_MATCH_SQL = '(phone = ? OR phone = ? OR (phone IS NULL AND phone_number = ?))';
function phoneMatchParams(v) {
  const e164 = toE164(v);
  if (!e164) return null;
  // The national form, for the two legacy shapes -- only meaningful for the
  // default country, which is the only one any pre-existing row can be.
  const national = e164.startsWith(`+${DEFAULT_PHONE_CC}`) ? e164.slice(1 + DEFAULT_PHONE_CC.length) : e164;
  return [e164, national, national];
}

// Look up the single account reachable at this phone/email, or explain why
// there isn't one. Email is matched case-insensitively against users.email.
//
// An email shared by more than one account is deliberately refused rather
// than resolved to an arbitrary one: two real delegates signed up twice with
// the same address before email was ever an identifier, and picking either
// would be a guess about whose account someone is logging into. They sign in
// by phone, which is unambiguous. New signups can't reuse an address at all
// (see emailTakenBy), so this only ever affects those pre-existing rows.
async function resolveAccountByIdentifier(identifier) {
  const id = String(identifier || '').trim();
  if (isPhoneValue(id)) {
    // Match the phone CHANNEL, not the account key -- an email-only account
    // that later added a number has it in `phone` while its key is synthetic.
    // COALESCE covers rows whose phone column predates the identity backfill.
    const params = phoneMatchParams(id);
    const rows = await dbAll(`SELECT * FROM users WHERE ${PHONE_MATCH_SQL}`, params);
    if (!rows.length) return { error: 'notRegistered' };
    // destination is the canonical E.164 form, so an OTP is always issued
    // against one spelling of the number no matter how it was typed.
    return { user: rows[0], channel: 'sms', destination: toE164(id) };
  }
  if (isEmailValue(id)) {
    const rows = await dbAll('SELECT * FROM users WHERE LOWER(email) = ?', [normalizeEmail(id)]);
    if (!rows.length) return { error: 'notRegistered' };
    if (rows.length > 1) return { error: 'ambiguousEmail' };
    return { user: rows[0], channel: 'email', destination: normalizeEmail(id) };
  }
  return { error: 'invalid' };
}

// Which account, if any, already holds this email -- the uniqueness gate for
// signup and for adding/changing an address. Optionally excludes one account
// key, so a user re-saving their own unchanged address isn't blocked by
// themselves.
async function emailTakenBy(email, exceptKey) {
  const row = await dbGet(
    'SELECT phone_number FROM users WHERE LOWER(email) = ? AND phone_number != ?',
    [normalizeEmail(email), exceptKey || '']
  );
  return row ? row.phone_number : null;
}

// --- OTP ----------------------------------------------------------------
// Signup OTPs are necessarily open -- no account exists yet to authorise
// against -- which means /api/otp/request will send an email to any address
// given to it. The per-destination throttle below doesn't bound that on its
// own, since an abuser just rotates addresses, and a flood of mail to
// strangers is what gets an SES sending domain throttled or suspended --
// taking receipts, reminders and digests down with it.
//
// So: a rolling hourly ceiling on OTP emails, well above anything this
// conference generates (a few hundred delegates in total) but low enough to
// stop the damage. SMS is deliberately not capped here -- it has a per
// message cost and the gateway enforces its own limits.
const OTP_EMAIL_HOURLY_CAP = 200;
let otpEmailWindowStart = Date.now();
let otpEmailsThisHour = 0;
function otpEmailBudgetAvailable() {
  const now = Date.now();
  if (now - otpEmailWindowStart >= 60 * 60 * 1000) {
    otpEmailWindowStart = now;
    otpEmailsThisHour = 0;
  }
  return otpEmailsThisHour < OTP_EMAIL_HOURLY_CAP;
}

// Generate, store and deliver a one-time code to either channel. Returns
// { ok, devOtp?, delivered } -- devOtp only when OTP_ECHO is on AND nothing
// was actually sent, exactly as the phone-only flow behaved.
async function issueOtp(destination) {
  const channel = channelOf(destination);
  if (!channel) return { ok: false, error: 'Enter a valid mobile number or email address.' };
  // Canonical form on both channels, so one destination has exactly one OTP
  // row however the caller spelled it.
  const dest = channel === 'email' ? normalizeEmail(destination) : toE164(destination);
  // The SMS gateway is an Indian DLT provider and has no route to anything
  // else, so refuse up front rather than storing a code that can never be
  // delivered and leaving the caller waiting for a message that isn't coming.
  if (channel === 'sms' && !isIndianPhone(dest)) {
    return {
      ok: false,
      error: 'We can only send SMS to Indian mobile numbers. Please verify your email address instead.',
    };
  }

  const existing = await dbGet('SELECT last_sent_at FROM otp_codes WHERE destination = ?', [dest]);
  if (existing && Date.now() - existing.last_sent_at < OTP_RESEND_MS) {
    const wait = Math.ceil((OTP_RESEND_MS - (Date.now() - existing.last_sent_at)) / 1000);
    return { ok: false, error: `Please wait ${wait}s before requesting another OTP.` };
  }

  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();
  await dbRun(
    `INSERT INTO otp_codes (destination, channel, otp_hash, expires_at, attempts, last_sent_at)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(destination) DO UPDATE SET
       channel = excluded.channel,
       otp_hash = excluded.otp_hash,
       expires_at = excluded.expires_at,
       attempts = 0,
       last_sent_at = excluded.last_sent_at`,
    [dest, channel, sha256(`${dest}:${otp}`), now + OTP_TTL_MS, now]
  );

  console.log(`[OTP] ${dest} -> ${otp} (valid ${OTP_TTL_MS / 60000} min, via ${channel})`);
  let delivered = false;
  if (channel === 'sms') {
    delivered = smsEnabled() && notifyToggle.sms;
    if (delivered) sendOtpSms(dest, otp); // fire-and-forget; logs on failure
  } else {
    if (!otpEmailBudgetAvailable()) {
      console.error(`[OTP] hourly email cap (${OTP_EMAIL_HOURLY_CAP}) reached -- refusing OTP to ${dest}`);
      return { ok: false, error: 'Too many verification emails have been sent recently. Please try again later, or use your mobile number.' };
    }
    delivered = emailEnabled() && notifyToggle.email;
    if (delivered) {
      otpEmailsThisHour++;
      sendEmail(dest, `Your ${CONFERENCE.acronym || 'conference'} verification code`,
        emailWrap('Your verification code',
          `<p>Use this code to verify your email address:</p>
           <p style="font-size:1.8rem;font-weight:800;letter-spacing:.25em;text-align:center;margin:1.25rem 0">${escapeHtml(otp)}</p>
           <p>It expires in ${OTP_TTL_MS / 60000} minutes. If you didn't request it, you can ignore this email.</p>`));
    }
  }

  // Never echo a code that was actually delivered -- same rule the
  // phone-only flow used, now applying to both channels.
  return { ok: true, delivered, devOtp: OTP_ECHO && !delivered ? otp : undefined };
}

// Validate an OTP without spending it. Returns { ok, channel } or
// { ok: false, error }.
//
// Separate from burning it because signup checks two codes and then several
// other things that can fail. Burning the phone code before the email code
// was even looked at meant any later failure -- a mistyped email code, an
// account that already exists -- destroyed a perfectly good verification and
// told the delegate to "request an OTP first" on their next attempt.
async function verifyOtp(destination, otp) {
  const channel = channelOf(destination);
  // Canonicalised EXACTLY as issueOtp does -- a code issued to
  // "9823900641" is stored under "+919823900641", so looking it up by the
  // raw string would never find it and every bare-national redemption
  // (which is what the signup form submits) would fail as "request an OTP
  // first".
  const dest = channel === 'email' ? normalizeEmail(destination) : (toE164(destination) || String(destination || '').trim());
  const row = await dbGet('SELECT * FROM otp_codes WHERE destination = ?', [dest]);
  // True whichever way we got here: never requested, already used, or swept
  // after expiring. The old wording asserted the first, which was usually
  // the one thing that had not happened.
  if (!row) return { ok: false, error: 'That code is no longer valid. Please request a new one.' };

  // Deliberately NOT deleted here. Removing the row made the very next
  // attempt report "Please request an OTP first" -- telling someone who had
  // just been told their code expired that they never asked for one. The
  // hourly sweep clears it, and a new request overwrites it.
  if (Date.now() > row.expires_at) {
    return { ok: false, error: 'That code has expired. Please request a new one.' };
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await dbRun('DELETE FROM otp_codes WHERE destination = ?', [dest]);
    return { ok: false, error: 'Too many incorrect attempts. Please request a new OTP.' };
  }
  if (!safeEqual(row.otp_hash, sha256(`${dest}:${otp}`))) {
    await dbRun('UPDATE otp_codes SET attempts = attempts + 1 WHERE destination = ?', [dest]);
    return { ok: false, error: 'Incorrect OTP.' };
  }

  return { ok: true, channel: row.channel };
}

// Spend an OTP. Single use: once this returns, the code is gone.
async function burnOtp(destination) {
  const channel = channelOf(destination);
  const dest = channel === 'email' ? normalizeEmail(destination) : (toE164(destination) || String(destination || '').trim());
  await dbRun('DELETE FROM otp_codes WHERE destination = ?', [dest]);
}

// Verify and spend in one step, for the flows that have nothing left to fail
// after the code checks out.
async function consumeOtp(destination, otp) {
  const result = await verifyOtp(destination, otp);
  if (result.ok) await burnOtp(destination);
  return result;
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

// API paths that stay open during maintenance. The auth trio is the important
// one: a super admin arriving at a portal already in maintenance has no
// session yet, so blocking OTP/login would lock the only role that can turn
// maintenance back off out of the app entirely. Registration is deliberately
// NOT here -- stopping new signups is the point of maintenance mode. The rest
// are read-only endpoints the login screen itself needs to render.
const MAINTENANCE_OPEN_PATHS = new Set([
  '/api/otp/request',
  '/api/auth/login',
  '/api/auth/login-password',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/maintenance',
  '/api/conference',
  // Same reasoning as the auth trio above: on the vanishingly unlikely fresh
  // instance where maintenance mode is somehow already on with zero admins,
  // blocking this would lock the deployment out permanently -- there'd be no
  // admin account able to turn maintenance back off either.
  '/api/setup/create-admin',
]);

// Server-side enforcement of maintenance mode. Mounted after loadSession (so
// req.session is populated) and before every API route. Page routes are left
// alone here and handle their own rendering -- GET / must keep serving the
// login form so a super admin can get in.
function maintenanceGate(req, res, next) {
  if (!maintenance.enabled) return next();
  if (req.session && req.session.role === 'SUPER_ADMIN') return next();
  if (!req.path.startsWith('/api/')) return next();
  if (MAINTENANCE_OPEN_PATHS.has(req.path)) return next();
  return res.status(503).json({ success: false, maintenance: true, error: maintenance.message });
}


// What a route needs, said as a capability rather than as a list of who
// happens to hold it today. Roles still come from the hardcoded catalogue
// (permissions.js), so this changes nothing about who can do what -- it
// changes where that fact is written down, from 83 separate lines to one
// file. Roles become editable rows in the next phase, and this middleware
// does not change again when they do.
function requirePermission(permission) {
  if (!PERMISSION_KEYS.includes(permission)) {
    // A typo here would silently guard a route with a permission nobody can
    // ever hold -- locked out rather than exposed, but still wrong, and
    // discovered by a user rather than by a deploy. Fail at load instead.
    throw new Error(`Unknown permission '${permission}' -- see permissions.js`);
  }
  const guard = (req, res, next) => {
    if (!req.session) return res.status(401).json({ success: false, error: 'Login required.' });
    if (!can(req.session.role, permission)) {
      return res.status(403).json({ success: false, error: 'You do not have permission for this action.' });
    }
    next();
  };
  // Read back by the boot audit below, so it can report which routes it
  // checked and catch one that carries no permission at all.
  guard.permission = permission;
  return guard;
}

// --- MIDDLEWARE ---------------------------------------------------------
// gzip everything compressible -- first, so it also covers the JSON API
// responses and EJS-rendered pages below, not just the static files. Biggest
// win is the two static topology/pincode datasets behind the delegate map
// (public/data/*.json, ~2.1MB uncompressed): gzip shrinks JSON like that by
// roughly 80-85%, and compression's default filter already skips anything
// already-compressed (images) or under 1KB where the gzip overhead isn't
// worth it.
app.use(compression());
// Body limit sized for a single base64 screenshot (5 MB image + ~33%
// encoding overhead + form fields), not the old 50 MB.
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ limit: '8mb', extended: true }));
// index: false -- the delegate portal is a template now (views/index.ejs plus
// its partials), served by the explicit GET / below. Without this, static
// would try to auto-serve public/index.html for '/' and shadow that route.
// Fingerprint for app.js, in its URL.
//
// This deployment sits behind Cloudflare, which caches /app.js for four hours
// regardless of the max-age=0 the origin sends. A deploy therefore did not
// reach anyone -- browser or edge -- until that expired, which is why fixes
// here have needed a hard refresh to show up. Putting the file's own hash in
// the URL makes each build a different resource: the new one is fetched
// immediately because nothing has ever cached it, and the long cache lifetime
// becomes a benefit rather than a delay.
//
// Computed once at startup: the file cannot change under a running process
// (the image is rebuilt and the container replaced on every deploy).
const ASSET_VERSION = (() => {
  try {
    return crypto.createHash('sha1')
      .update(fs.readFileSync(path.join(__dirname, 'public', 'app.js')))
      .digest('hex').slice(0, 10);
  } catch { return String(Date.now()); }
})();
app.locals.assetVersion = ASSET_VERSION;

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use(loadSession);
app.use(maintenanceGate);

// Public (pre-auth) maintenance state, so the login screen can show the
// notice before anyone has a session. Never returns anything sensitive.
app.get('/api/maintenance', (req, res) => {
  res.json({ enabled: maintenance.enabled, message: maintenance.message });
});

// First-run setup wizard. Reachable in two states: before the first admin
// exists (see isSetupModeActive -- no token, no OTP; simply unreachable
// once an admin exists), and by an already-logged-in Super Admin -- the
// latter matters because the wizard's later steps (conference/categories/
// workshops/UPI/SMS/Email) run AFTER account creation, on the same page;
// without this, reloading mid-wizard would 404 the moment the admin account
// (created in step 1) makes isSetupModeActive() go false. Harmless to leave
// reachable afterward too -- every later step just calls the same
// already-SUPER_ADMIN-gated endpoints Settings itself uses.
// Anonymous + setup-inactive gets a plain 404, no signal about which of
// "completed" / "never reachable" is true.
// The setup wizard used to live at its own /setup URL; it's now folded into
// '/' below (see there for why), so this is just a redirect for anyone who
// still has the old link bookmarked or documented somewhere.
app.get('/setup', (req, res) => {
  res.redirect('/');
});

// Delegate portal -- except on a deployment that hasn't finished first-run
// setup yet, where '/' *is* the setup wizard instead. There's no separate
// URL for it: isSetupModeActive() is the single source of truth (no
// admin-role user exists yet AND schema_meta.setup_completed is unset --
// see isSetupModeActive above), and it's checked fresh on every request, not
// cached in the session -- so once the wizard's own Step 1 creates the
// first admin account, setup_completed flips immediately and every
// subsequent load of '/' (including a mid-wizard refresh, from that same
// browser or any other) goes straight to the normal portal instead,
// permanently. That's deliberate, not a rough edge: the remaining wizard
// steps (conference details, fees, workshops, UPI, SMS, email) are each
// skippable and independently finishable afterward from Settings → General
// / Fees / Workshops -- see README -- so there is nothing to lose by not
// being able to return to the wizard itself, and no path back into it.
// Assembled from partials the same way as /admin; almost no server-rendered
// data (everything is still populated client-side by app.js) -- the page
// <title> is the one exception, so the browser tab shows something
// meaningful before the client-side fetch resolves.
app.get('/', async (req, res, next) => {
  try {
    if (await isSetupModeActive()) return res.render('setup');
    // Hand the delegate's own registration to the page so the status chip is
    // right on the first paint. The markup can only ship one status, and
    // shipping a real one showed "Registration Pending" to everyone --
    // including delegates confirmed weeks ago -- until the fetch came back.
    // The page still fetches and re-applies this, so a stale copy corrects
    // itself; this only removes the wrong-status flash.
    let bootstrapReg;
    if (req.session && req.session.phone) {
      bootstrapReg = await ownRegistration(req.session.phone); // null = not registered yet
      // Now personalised, so it must never sit in a shared cache.
      res.set('Cache-Control', 'private, no-store');
    }
    res.render('index', {
      conferenceName: CONFERENCE.name,
      // undefined => not logged in, so the page leaves the chip neutral and
      // waits for the fetch. null => logged in, no registration yet.
      bootstrapReg: bootstrapReg === undefined ? undefined : bootstrapReg,
    });
  } catch (err) {
    next(err);
  }
});

// Admin panel lives outside the static root and is only served to a
// logged-in admin. Anonymous users go to the portal to log in first.
app.get('/admin', (req, res) => {
  if (!req.session) return res.redirect('/');
  // During maintenance the admin panel is super-admin-only: every other role's
  // panel is driven by API calls that maintenanceGate is now 503ing, so it
  // would render as a shell of empty tables rather than anything usable.
  if (maintenance.enabled && req.session.role !== 'SUPER_ADMIN') {
    return res.status(503).send(
      '<!doctype html><meta charset="utf-8"><title>Under maintenance</title>' +
      '<body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;text-align:center">' +
      '<h1>🔧 Under maintenance</h1>' +
      `<p>${escapeHtml(maintenance.message)}</p>` +
      '<p><a href="/">Return to the delegate portal</a></p></body>'
    );
  }
  if (!isKnownAdminRole(req.session.role)) {
    return res.status(403).send(
      '<!doctype html><meta charset="utf-8"><title>Forbidden</title>' +
      '<body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;text-align:center">' +
      '<h1>403 — Not authorised</h1>' +
      '<p>Your account does not have administrative access.</p>' +
      '<p><a href="/">Return to the delegate portal</a></p></body>'
    );
  }
  res.render('admin');
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
// `destination` is a 10-digit phone or an email address; `phone` is still
// accepted as the old field name so nothing breaks mid-deploy.
//
// For SIGNUP this is deliberately open: proving control of any address is
// the point, and no account need exist yet. For LOGIN the client uses
// /api/auth/login-otp instead, which additionally refuses to send a code to
// a channel the target account hasn't verified.
app.post('/api/otp/request', async (req, res, next) => {
  try {
    const destination = req.body.destination || req.body.phone;
    const result = await issueOtp(destination);
    if (!result.ok) {
      return res.status(result.error.startsWith('Please wait') ? 429 : 400).json({ success: false, error: result.error });
    }
    res.json({
      success: true,
      channel: channelOf(destination),
      // smsSent kept for the existing client; delivered covers both channels.
      smsSent: channelOf(destination) === 'sms' && result.delivered,
      delivered: result.delivered,
      ...(result.devOtp ? { devOtp: result.devOtp } : {}),
    });
  } catch (err) {
    next(err);
  }
});

// Request a LOGIN code. Unlike /api/otp/request above, this resolves the
// identifier to a real account first and refuses to send unless that
// account has already verified the channel being used -- "login only with
// OTP from a verified mode". Without that check, an address someone merely
// typed into their profile (never proven) would be enough to sign in.
app.post('/api/auth/login-otp', async (req, res, next) => {
  try {
    const identifier = String(req.body.identifier || '').trim();
    const found = await resolveAccountByIdentifier(identifier);

    if (found.error === 'invalid') {
      return res.status(400).json({ success: false, error: 'Enter a valid mobile number or email address.' });
    }
    // Tells the client to switch to sign-up, same contract as /api/auth/login.
    if (found.error === 'notRegistered') return res.json({ success: false, notRegistered: true });
    if (found.error === 'ambiguousEmail') {
      return res.status(409).json({
        success: false,
        error: 'More than one account uses this email address. Please sign in with your mobile number instead.',
      });
    }

    const { user, channel, destination } = found;
    const verified = channel === 'sms' ? user.phone_verified : user.email_verified;
    if (!verified) {
      return res.status(403).json({
        success: false,
        error: channel === 'email'
          ? 'This email address has not been verified yet. Sign in with your mobile number, and you can verify your email right after.'
          : 'This mobile number has not been verified yet. Sign in with your email address instead.',
      });
    }

    const result = await issueOtp(destination);
    if (!result.ok) {
      return res.status(result.error.startsWith('Please wait') ? 429 : 400).json({ success: false, error: result.error });
    }
    res.json({
      success: true,
      channel,
      delivered: result.delivered,
      ...(result.devOtp ? { devOtp: result.devOtp } : {}),
    });
  } catch (err) {
    next(err);
  }
});

// Create the very first admin account and log straight in. See
// isSetupModeActive() -- unreachable once an admin already exists or once
// setup has ever been completed; that is the entire authorization check.
app.post('/api/setup/create-admin', async (req, res, next) => {
  try {
    if (!(await isSetupModeActive())) return res.status(404).json({ success: false, error: 'Setup is not available.' });

    const { name, phone, email, password } = req.body;
    // One-time bootstrap for the host institution's first admin: Indian, and
    // needs to be reachable by SMS. Same reasoning as POST /api/users.
    if (!phone || !isIndianPhone(phone)) {
      return res.status(400).json({ success: false, error: 'Enter a valid 10-digit Indian mobile number.' });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: 'Full name is required.' });
    }
    // Required, like every other account-creating path -- see POST
    // /api/auth/register. The first admin especially needs a reachable
    // address: they are the account every notification setting is tested
    // against.
    const emailVal = String(email || '').trim();
    if (!emailVal) {
      return res.status(400).json({ success: false, error: 'An email address is required.' });
    }
    if (!isEmailValue(emailVal)) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }
    if (password && String(password).length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
    }

    const nameVal = titleCase(String(name).trim());
    const passwordHash = password ? hashPassword(String(password)) : null;
    await dbRun(
      `INSERT INTO users (phone_number, phone, phone_verified, full_name, email, role, password_hash, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      [phone, toE164(phone), nameVal, normalizeEmail(emailVal), 'SUPER_ADMIN', passwordHash, Date.now()]
    );
    // Set the very moment the account exists, not deferred to the wizard's
    // last step -- the remaining steps (conference/UPI/SMS/Email) are just
    // convenience UI over the already-authenticated general-settings
    // endpoint below, not part of the security boundary this flag protects.
    await dbRun(
      "INSERT INTO schema_meta (key, value) VALUES ('setup_completed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [String(Date.now())]
    );
    await writeAuditRow('general_settings', 'general', 'SETUP_ADMIN_CREATED', null,
      `First-run setup created Super Admin "${nameVal}" (${phone})`, phone, nameVal, 'SUPER_ADMIN').catch(() => {});

    await startSession(phone, 'SUPER_ADMIN', res);
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ success: false, error: 'A user with that phone number already exists. Use a different number.' });
    }
    next(err);
  }
});

// Register (or update own profile) after OTP verification, then log in.
//
// A signup supplies a phone, an email, or both, and proves at least ONE of
// them with an OTP (phoneOtp / emailOtp). Whichever is proven is recorded as
// verified; the other is kept as an unverified contact detail the user can
// verify later (see /api/auth/verify-contact). A password is required --
// with email-only accounts there is no guaranteed SMS fallback, so an
// account with neither a password nor a verified channel would be
// unreachable.
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const { otp, phoneOtp, emailOtp, salutation, name, designation, institute, pincode, state, district, age, gender, password } = req.body;
    const phoneVal = String(req.body.phone || '').trim();
    const emailRaw = String(req.body.email || '').trim();

    // India is the default for anything that doesn't say otherwise, which
    // keeps every existing client and the whole pre-international history
    // behaving exactly as before.
    const countryVal = String(req.body.country || '').trim() || 'India';
    const isIndia = countryVal.toLowerCase() === 'india';

    if (phoneVal && !isPhoneValue(phoneVal)) {
      return res.status(400).json({ success: false, error: 'Please enter a valid mobile number, including the country code.' });
    }
    // A phone is required for an Indian delegate (it's their SMS channel and
    // their account key) but optional for everyone else -- we can't text an
    // international number anyway, so demanding one would only collect a
    // detail we can neither verify nor use.
    if (isIndia) {
      if (!phoneVal) {
        return res.status(400).json({ success: false, error: 'A mobile number is required.' });
      }
      if (!isIndianPhone(phoneVal)) {
        return res.status(400).json({ success: false, error: 'Enter a valid 10-digit Indian mobile number, or change your country.' });
      }
    } else if (phoneVal && isIndianPhone(phoneVal)) {
      // An Indian number under a non-Indian country is almost certainly the
      // country selector left untouched, and it would otherwise produce an
      // account that can be texted but is filed as international.
      return res.status(400).json({ success: false, error: 'That looks like an Indian mobile number — please set your country to India.' });
    }
    // An email address is always recorded, whether or not it ends up being
    // the verified channel: it's how receipts, reminders and every other
    // notification reach a delegate, and an account without one is
    // unreachable by any of them. Phone stays optional -- verification is
    // what's flexible here (see the phoneOk/emailOk check below), not
    // whether we hold an address at all.
    if (!emailRaw) {
      return res.status(400).json({ success: false, error: 'An email address is required.' });
    }
    if (!isEmailValue(emailRaw)) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }
    if (!name) {
      return res.status(400).json({ success: false, error: 'Full name is required.' });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ success: false, error: 'Please set a password of at least 8 characters.' });
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
    const emailVal = emailRaw ? normalizeEmail(emailRaw) : null;

    // Prove at least one channel. `otp` is the legacy single-code field and
    // is treated as the phone code, so an older client keeps working.
    const phoneCode = phoneOtp || otp;
    let phoneOk = false;
    let emailOk = false;
    // Verified, not yet spent -- see verifyOtp. Both codes, and every check
    // below them, have to pass before either is burned.
    if (phoneVal && phoneCode) {
      const c = await verifyOtp(phoneVal, phoneCode);
      if (!c.ok) return res.status(400).json({ success: false, error: `Mobile OTP: ${c.error}` });
      phoneOk = true;
    }
    if (emailVal && emailOtp) {
      const c = await verifyOtp(emailVal, emailOtp);
      if (!c.ok) return res.status(400).json({ success: false, error: `Email OTP: ${c.error}` });
      emailOk = true;
    }
    if (!phoneOk && !emailOk) {
      return res.status(400).json({ success: false, error: 'Verify your mobile number or your email address with an OTP to continue.' });
    }

    // Existing account for whichever channel was proven. An OTP proves
    // control of that channel, so updating the account reachable at it is
    // safe -- this is the same "re-register to update your profile" path the
    // phone-only flow had, now reachable from either side.
    const byPhone = phoneOk && phoneVal
      ? await dbGet(`SELECT * FROM users WHERE ${PHONE_MATCH_SQL}`, phoneMatchParams(phoneVal)) : null;
    const byEmailRows = emailOk && emailVal
      ? await dbAll('SELECT * FROM users WHERE LOWER(email) = ?', [emailVal]) : [];
    if (byEmailRows.length > 1) {
      return res.status(409).json({ success: false, error: 'More than one account already uses this email address. Please contact the organisers.' });
    }
    const existing = byPhone || byEmailRows[0] || null;

    // One address per account: without this, a new signup could claim an
    // address already on someone else's account and then log in as neither
    // (resolveAccountByIdentifier refuses an ambiguous email).
    if (emailVal) {
      const takenBy = await emailTakenBy(emailVal, existing ? existing.phone_number : null);
      if (takenBy) {
        return res.status(409).json({ success: false, error: 'An account with this email address already exists. Please sign in instead.' });
      }
    }
    // Same for the phone number, which additionally doubles as the account
    // key for phone signups.
    if (phoneVal) {
      const phoneTaken = await dbGet(
        `SELECT phone_number FROM users WHERE ${PHONE_MATCH_SQL} AND phone_number != ?`,
        [...phoneMatchParams(phoneVal), existing ? existing.phone_number : '']);
      if (phoneTaken) {
        return res.status(409).json({ success: false, error: 'An account with this mobile number already exists. Please sign in instead.' });
      }
    }

    // Account key: the bare national number for an Indian signup -- which
    // keeps every existing account and every Indian signup readable and
    // unchanged -- and a synthetic key for everyone else.
    //
    // The distinction matters because the key can never be edited (eight
    // tables join on it). An Indian number is SMS-verified at signup, so
    // it's known-good and safe to freeze. An international number can't be
    // verified, so it's exactly the kind of value that gets mistyped and
    // needs correcting later; keeping it out of the key leaves it editable
    // like any other column. See the USER KEY note on the users table.
    const userKey = existing
      ? existing.phone_number
      : (isIndianPhone(phoneVal) ? toE164(phoneVal).slice(1 + DEFAULT_PHONE_CC.length) : newUserKey());
    const passwordHash = hashPassword(String(password));

    // Verification is sticky: a channel already proven stays proven even if
    // this call only re-proved the other one.
    const phoneVerified = (phoneOk || (existing && existing.phone_verified)) ? 1 : 0;
    const emailVerified = (emailOk || (existing && existing.email_verified && normalizeEmail(existing.email) === emailVal)) ? 1 : 0;

    await dbRun(
      `INSERT INTO users (phone_number, phone, phone_verified, email_verified, salutation, full_name, designation, institution, country, pincode, state, district, age, gender, email, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DELEGATE', ?)
       ON CONFLICT(phone_number) DO UPDATE SET
         phone = excluded.phone,
         phone_verified = excluded.phone_verified,
         email_verified = excluded.email_verified,
         salutation = excluded.salutation,
         full_name = excluded.full_name,
         designation = excluded.designation,
         institution = excluded.institution,
         country = excluded.country,
         pincode = excluded.pincode,
         state = excluded.state,
         district = excluded.district,
         age = excluded.age,
         gender = excluded.gender,
         email = excluded.email,
         password_hash = excluded.password_hash,
         created_at = COALESCE(users.created_at, excluded.created_at)`,
      [userKey, phoneVal ? toE164(phoneVal) : null, phoneVerified, emailVerified, salutationVal, nameVal, designation, institute,
       countryVal, pincode || null, state || null, district || null, ageNum, genderVal, emailVal, passwordHash, Date.now()]
    );

    // The account exists now, so the codes have done their job. Spent here
    // rather than at the top: everything that could reject this registration
    // has already run, and a rejected attempt must leave the delegate's codes
    // usable for the retry.
    if (phoneOk) await burnOtp(phoneVal);
    if (emailOk) await burnOtp(emailVal);

    await assignUserRegNumber(userKey); // ensure a registration number exists
    const user = await dbGet('SELECT * FROM users WHERE phone_number = ?', [userKey]);
    await startSession(userKey, user.role, res);
    recordLogin(userKey, user.full_name, user.role); // fire-and-forget
    res.json({ success: true, user: omitPasswordHash(user) });
  } catch (err) {
    next(err);
  }
});

// Log in an existing user after OTP verification. `identifier` is a phone
// number or an email address (`phone` still accepted as the old field name).
// The channel must already be verified on that account -- re-checked here
// and not just in /api/auth/login-otp, since nothing stops a client from
// calling this endpoint directly with a code obtained elsewhere.
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const identifier = String(req.body.identifier || req.body.phone || '').trim();
    const { otp } = req.body;
    const found = await resolveAccountByIdentifier(identifier);

    if (found.error === 'invalid') {
      return res.status(400).json({ success: false, error: 'Enter a valid mobile number or email address.' });
    }
    // Tell the client to switch to sign-up. Done before consuming the OTP so
    // the same code remains valid there.
    if (found.error === 'notRegistered') return res.json({ success: false, notRegistered: true });
    if (found.error === 'ambiguousEmail') {
      return res.status(409).json({
        success: false,
        error: 'More than one account uses this email address. Please sign in with your mobile number instead.',
      });
    }

    const { user, channel, destination } = found;
    if (!(channel === 'sms' ? user.phone_verified : user.email_verified)) {
      return res.status(403).json({ success: false, error: 'That contact method has not been verified for this account.' });
    }

    const check = await consumeOtp(destination, otp);
    if (!check.ok) return res.status(400).json({ success: false, error: check.error });

    await startSession(user.phone_number, user.role, res);
    recordLogin(user.phone_number, user.full_name, user.role); // fire-and-forget
    res.json({ success: true, user: omitPasswordHash(user) });
  } catch (err) {
    next(err);
  }
});

// Log in with a password instead of OTP -- an alternative for any account
// that has one set (see hashPassword/verifyPassword and POST
// /api/auth/set-password). `identifier` is a phone number or an email
// address (`phone` still accepted as the old field name).
//
// Unlike OTP login this does NOT require the identifier's channel to be
// verified: the password itself is the proof of identity, and the channel is
// only being used to name the account. An unverified address can't be used
// to RECEIVE anything here, so there's nothing to hijack.
app.post('/api/auth/login-password', async (req, res, next) => {
  try {
    const identifier = String(req.body.identifier || req.body.phone || '').trim();
    const { password } = req.body;
    if (!isPhoneValue(identifier) && !isEmailValue(identifier)) {
      return res.status(400).json({ success: false, error: 'Enter a valid mobile number or email address.' });
    }
    if (!password) {
      return res.status(400).json({ success: false, error: 'Password is required.' });
    }

    const attemptKey = isEmailValue(identifier) ? normalizeEmail(identifier) : identifier;
    const attempt = passwordLoginAttempts.get(attemptKey);
    if (attempt && attempt.lockUntil && Date.now() < attempt.lockUntil) {
      const mins = Math.ceil((attempt.lockUntil - Date.now()) / 60000);
      return res.status(429).json({ success: false, error: `Too many attempts. Try again in ${mins} minute(s), or use OTP instead.` });
    }

    const found = await resolveAccountByIdentifier(identifier);
    const user = found.user;
    const ok = user && user.password_hash && verifyPassword(password, user.password_hash);
    if (!ok) {
      const count = (attempt ? attempt.count : 0) + 1;
      const next = { count, lockUntil: count >= PASSWORD_MAX_ATTEMPTS ? Date.now() + PASSWORD_LOCKOUT_MS : null };
      passwordLoginAttempts.set(attemptKey, next);
      // Same error either way -- an unregistered identifier and a wrong
      // password for a real one are indistinguishable from the outside, on
      // purpose. (An email shared by two accounts lands here too, rather
      // than leaking that it matched more than one.)
      return res.status(401).json({ success: false, error: 'Incorrect mobile number / email or password.' });
    }
    passwordLoginAttempts.delete(attemptKey);
    const phone = user.phone_number;

    await startSession(phone, user.role, res);
    recordLogin(phone, user.full_name, user.role); // fire-and-forget
    res.json({ success: true, user: omitPasswordHash(user) });
  } catch (err) {
    next(err);
  }
});

// Set or change the CALLER's own password. Deliberately does not require the
// current password: the session itself is already the proof of identity
// (same trust level OTP login grants), so this is reachable whether the
// caller signed in by OTP or by an existing password. Applies to every
// account type -- delegate or staff -- since login-password does too.
app.post('/api/auth/set-password', requireAuth, async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || String(password).length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
    }
    await dbRun('UPDATE users SET password_hash = ? WHERE phone_number = ?', [hashPassword(String(password)), req.session.phone]);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- VERIFY A CONTACT CHANNEL ON THE CALLER'S OWN ACCOUNT ----------------
// Two steps, both requiring a live session: request a code to an address,
// then confirm it. This is how the ~300 accounts that predate email
// verification get their address proven (prompted at next login), and how
// anyone adds or changes a phone/email afterwards.
//
// The address is taken from the REQUEST, not from the stored record, so the
// same flow covers "verify the address already on file" and "replace it with
// one I can actually receive mail at".
app.post('/api/auth/verify-contact/request', requireAuth, async (req, res, next) => {
  try {
    const channel = req.body.channel === 'sms' ? 'sms' : 'email';
    const value = String(req.body.value || '').trim();
    if (channel === 'email' && !isEmailValue(value)) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }
    if (channel === 'sms' && !isPhoneValue(value)) {
      return res.status(400).json({ success: false, error: 'Please enter a valid 10-digit mobile number.' });
    }

    // Can't claim a channel that already belongs to someone else.
    const taken = channel === 'email'
      ? await emailTakenBy(value, req.session.phone)
      : (await dbGet(`SELECT phone_number FROM users WHERE ${PHONE_MATCH_SQL} AND phone_number != ?`,
          [...phoneMatchParams(value), req.session.phone]) || {}).phone_number;
    if (taken) {
      return res.status(409).json({
        success: false,
        error: channel === 'email'
          ? 'Another account already uses this email address.'
          : 'Another account already uses this mobile number.',
      });
    }

    const result = await issueOtp(value);
    if (!result.ok) {
      return res.status(result.error.startsWith('Please wait') ? 429 : 400).json({ success: false, error: result.error });
    }
    res.json({ success: true, delivered: result.delivered, ...(result.devOtp ? { devOtp: result.devOtp } : {}) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/verify-contact/confirm', requireAuth, async (req, res, next) => {
  try {
    const channel = req.body.channel === 'sms' ? 'sms' : 'email';
    const value = String(req.body.value || '').trim();
    const { otp } = req.body;
    if (channelOf(value) !== channel) {
      return res.status(400).json({ success: false, error: 'That does not look like a valid contact detail.' });
    }

    // Re-checked at confirm time too: the request step's check could have
    // been won by another account in between.
    const taken = channel === 'email'
      ? await emailTakenBy(value, req.session.phone)
      : (await dbGet(`SELECT phone_number FROM users WHERE ${PHONE_MATCH_SQL} AND phone_number != ?`,
          [...phoneMatchParams(value), req.session.phone]) || {}).phone_number;
    if (taken) {
      return res.status(409).json({ success: false, error: 'Another account already uses that contact detail.' });
    }

    const check = await consumeOtp(value, otp);
    if (!check.ok) return res.status(400).json({ success: false, error: check.error });

    if (channel === 'email') {
      await dbRun('UPDATE users SET email = ?, email_verified = 1 WHERE phone_number = ?', [normalizeEmail(value), req.session.phone]);
    } else {
      await dbRun('UPDATE users SET phone = ?, phone_verified = 1 WHERE phone_number = ?', [value, req.session.phone]);
    }
    const user = await dbGet('SELECT * FROM users WHERE phone_number = ?', [req.session.phone]);
    res.json({ success: true, user: omitPasswordHash(user) });
  } catch (err) {
    next(err);
  }
});

// Current session, for restoring state on page load.
app.get('/api/auth/me', requireAuth, async (req, res, next) => {
  try {
    const user = await dbGet('SELECT * FROM users WHERE phone_number = ?', [req.session.phone]);
    // What this session may do, resolved server-side and shipped as data --
    // not the role name alone, which is what the browser used to re-derive
    // its own four booleans from and had already drifted from what the
    // server actually enforces (see permissions.js's header comment).
    //
    // `sections` rather than making the client re-implement
    // roleSeesSection(): a screen opens or it doesn't, and that decision
    // belongs with the one file that knows what each screen requires.
    const permissions = permissionsOf(user.role);
    const sections = {};
    for (const key of Object.keys(SECTION_PERMISSIONS)) sections[key] = sectionVisible(user.role, key);
    res.json({ success: true, user: omitPasswordHash(user), permissions, sections });
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
    const { categoryKey, optionIds, amount, utr, screenshot, idCard, acknowledged, paymentMode, discountCode } = req.body;
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

    // Validate the full set of chosen program options against every active
    // group's required/max_select rules and each option's own capacity
    // (before OCR so a full option or a missing required group fails fast).
    // Resolved before the fee below so a paid option's fee can be added in.
    const resolved = await resolveSelections(optionIds, ownRegId);
    if (resolved.error) return res.status(400).json({ success: false, error: resolved.error });
    const selections = resolved.selections;
    const optionsFee = selections.reduce((sum, s) => sum + (Number(s.opt.fee) || 0), 0);

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
    // Option fees (e.g. a paid pre-conference workshop) are added on top of
    // the category fee after the discount, not discounted themselves -- a
    // promo/group discount is validated against the category only.
    const expectedAmount = feeInfo.amount - discountAmount + optionsFee;
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

    // Student categories must upload an ID card, checked against the category
    // -- this is an eligibility check, not a payment one, so it still applies
    // even when the fee is fully discounted to ₹0.
    const needsId = !!(await categoryRequiresStudentId(effectiveCategoryKey));
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
      const idFilename = idDecoded ? await writeUploadBuffer(idDecoded.buffer, idDecoded.ext) : null;

      await dbRun(
        `INSERT INTO registrations
          (phone_number, delegate_name, category_key, category_label, expected_amount, paid_amount, utr_number, screenshot, id_card, ocr_amount_match, ocr_vpa_match, ocr_utr_match, is_flagged, bank_status, rejection_reason, rejection_note, payment_mode, submitted_at, discount_code, discount_amount)
          VALUES (?, ?, ?, ?, 0, 0, NULL, NULL, ?, NULL, NULL, NULL, 0, 'BANK_VERIFIED', NULL, NULL, NULL, ?, ?, ?)
          ON CONFLICT(phone_number) DO UPDATE SET
            delegate_name = excluded.delegate_name,
            category_key = excluded.category_key,
            category_label = excluded.category_label,
            expected_amount = 0,
            paid_amount = 0,
            utr_number = NULL,
            screenshot = NULL,
            id_card = excluded.id_card,
            ocr_amount_match = NULL,
            ocr_vpa_match = NULL,
            ocr_utr_match = NULL,
              is_flagged = 0,
            bank_status = 'BANK_VERIFIED',
            rejection_reason = NULL,
            rejection_note = NULL,
            payment_mode = NULL,
            submitted_at = excluded.submitted_at,
            discount_code = excluded.discount_code,
            discount_amount = excluded.discount_amount`,
        [phone, name, effectiveCategoryKey, categoryLabel,
          idFilename, Date.now(), discountCodeApplied, discountAmount]
      );
      const regRow = await dbGet('SELECT id FROM registrations WHERE phone_number = ?', [phone]);
      await saveRegistrationSelections(regRow.id, selections);

      if (prev && prev.screenshot) await deleteScreenshotFile(prev.screenshot);
      if (prev && prev.id_card && prev.id_card !== idFilename) await deleteScreenshotFile(prev.id_card);

      const regNo = await assignUserRegNumber(phone);
      // `if`: assignUserRegNumber returns null when no prefix is configured
      // (see there), and stamping that over the row's existing number would
      // turn a misconfiguration into data loss.
      if (regNo) await dbRun('UPDATE registrations SET registration_number = ? WHERE phone_number = ?', [regNo, phone]);

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

    // Read the payment screenshot (amount / UPI ID / UTR). The VPA check only
    // applies to UPI payments -- an NEFT/RTGS receipt has no UPI ID to find,
    // so that check is not applicable (treated as passed).
    //
    // The ID card is deliberately NOT machine-checked: an approver confirms
    // it by eye before the registration can be verified (see id_verified and
    // PUT /api/registrations/:id/verify-id), which was always the real gate.
    const checks = await runOcrChecks(decoded.buffer, { expectedAmount, utr });
    if (mode === 'NEFT_RTGS') checks.vpa = true;
    // `amountStatus !== 'mismatch'` rather than `checks.amount`: an amount
    // nobody could read is not a failed check, it is an absent one. Treating
    // the two the same is what put a red cross on 37 of 190 approved slips
    // whose amounts were correct.
    const allChecksPass = checks.amountStatus !== AMOUNT_MISMATCH && checks.vpa && checks.utr;

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

    const result = await dbRun(
      `INSERT INTO registrations
        (phone_number, delegate_name, category_key, category_label, expected_amount, paid_amount, utr_number, screenshot, id_card, ocr_amount_match, ocr_amount_status, ocr_vpa_match, ocr_utr_match, is_flagged, bank_status, rejection_reason, rejection_note, payment_mode, submitted_at, discount_code, discount_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, ?, ?, ?, ?)
        ON CONFLICT(phone_number) DO UPDATE SET
          delegate_name = excluded.delegate_name,
          category_key = excluded.category_key,
          category_label = excluded.category_label,
          expected_amount = excluded.expected_amount,
          paid_amount = excluded.paid_amount,
          utr_number = excluded.utr_number,
          screenshot = excluded.screenshot,
          id_card = excluded.id_card,
          ocr_amount_match = excluded.ocr_amount_match,
          ocr_amount_status = excluded.ocr_amount_status,
          ocr_vpa_match = excluded.ocr_vpa_match,
          ocr_utr_match = excluded.ocr_utr_match,
          is_flagged = excluded.is_flagged,
          bank_status = 'PENDING',
          rejection_reason = NULL,
          rejection_note = NULL,
          payment_mode = excluded.payment_mode,
          submitted_at = excluded.submitted_at,
          discount_code = excluded.discount_code,
          discount_amount = excluded.discount_amount`,
      [phone, name, effectiveCategoryKey, categoryLabel,
        expectedAmount, paidAmount, utr, filename, idFilename,
        checks.amount ? 1 : 0, checks.amountStatus, checks.vpa ? 1 : 0, checks.utr ? 1 : 0, flagged, mode, Date.now(), discountCodeApplied, discountAmount]
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
    await saveRegistrationSelections(registrationId, selections);

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
    if (regNo) await dbRun('UPDATE registrations SET registration_number = ? WHERE phone_number = ?', [regNo, phone]);

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
    // `amountStatus !== 'mismatch'` rather than `checks.amount`: an amount
    // nobody could read is not a failed check, it is an absent one. Treating
    // the two the same is what put a red cross on 37 of 190 approved slips
    // whose amounts were correct.
    const allChecksPass = checks.amountStatus !== AMOUNT_MISMATCH && checks.vpa && checks.utr;
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

    const flagged = !(checks.amountStatus !== AMOUNT_MISMATCH && checks.vpa && checks.utr) ? 1 : 0;
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
  `registrations.id, registrations.registration_number, registrations.phone_number, delegate_name, ${DELEGATE_SALUTATION_COLUMN}, category_key, category_label,
   expected_amount, paid_amount, utr_number, is_flagged, bank_status,
   ocr_amount_match, ocr_amount_status, ocr_vpa_match, ocr_utr_match, rejection_reason, rejection_note,
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
// One delegate's own registration, exactly as the portal consumes it. Shared
// by /api/registrations/me and by the page itself, which embeds the same
// object so the first paint already shows the right status instead of
// correcting itself once the fetch lands. Returns null when they haven't
// registered yet.
async function ownRegistration(phone) {
  const row = await dbGet(
    `SELECT ${REGISTRATION_PUBLIC_COLUMNS} FROM registrations WHERE phone_number = ?`, [phone]);
  if (!row) return null;
  // Cumulative payment state so the dashboard can show the outstanding
  // balance and decide whether to offer a top-up.
  const summary = await getPaymentSummary(row.id, row.expected_amount);
  const reg = withDelegateSalutation(row);
  reg.verified_total = summary.verifiedTotal;
  reg.remaining = summary.remaining;
  reg.pending_txn_count = summary.txns.filter((t) => t.txn_status === 'PENDING').length;
  reg.selections = await fetchRegistrationSelections(row.id);
  return reg;
}

app.get('/api/registrations/me', requireAuth, async (req, res, next) => {
  try {
    res.json({ registration: await ownRegistration(req.session.phone) });
  } catch (err) {
    next(err);
  }
});

// Active program groups (with their options and remaining capacity), for
// the payment form -- an arbitrary, admin-configured list rather than a
// fixed workshop/QI pair.
app.get('/api/program-options', requireAuth, async (req, res, next) => {
  try {
    const groups = await fetchProgramGroups({ activeOnly: true });
    res.json({
      groups: groups.map((g) => ({
        id: g.id, name: g.name, description: g.description, required: !!g.required, maxSelect: g.max_select,
        options: g.options.map((o) => {
          const remaining = Math.max(0, o.capacity - o.enrolled);
          return { id: o.id, name: o.name, capacity: o.capacity, remaining, full: remaining <= 0, fee: Number(o.fee) || 0 };
        }),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Conference name/acronym/dates/location, for both the pre-login delegate
// landing page and the admin header -- deliberately public (no requireAuth):
// none of this is sensitive, and the landing page needs it before anyone has
// logged in. Settings → General is the only way to change it.
app.get('/api/conference', (req, res) => {
  res.json({
    name: CONFERENCE.name,
    acronym: CONFERENCE.acronym,
    startDate: CONFERENCE.startDate,
    endDate: CONFERENCE.endDate,
    location: CONFERENCE.location,
    dateLabel: formatConferenceDates(),
  });
});

// Active fee categories with the fee at today's phase, for the payment form.
app.get('/api/fees', requireAuth, async (req, res, next) => {
  try {
    const config = await getFeeConfig();
    const phase = currentPhase(config);
    const cats = await dbAll('SELECT category_key, label, subtitle, early_fee, regular_fee, late_fee, spot_fee, requires_student_id FROM fee_categories WHERE active = 1 ORDER BY sort_order, id');
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
        requiresStudentId: !!c.requires_student_id,
      })),
      upi: { id: UPI.id, payeeName: UPI.payeeName },
      bank: { accountName: BANK.accountName, accountNumber: BANK.accountNumber, ifsc: BANK.ifsc, branch: BANK.branch },
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
    // A member is identified by mobile number OR email address. Digits-only
    // stripping would destroy an email, so it's applied only to a value that
    // isn't one. group_members.phone_number stores the resolved ACCOUNT KEY
    // (identical to the mobile for every phone-based account, which is why
    // existing groups are unaffected).
    const rawId = String(req.body.identifier || req.body.phone || '').trim();
    const identifier = isEmailValue(rawId) ? rawId : rawId.replace(/\D/g, '');
    const found = await resolveAccountByIdentifier(identifier);
    if (found.error === 'invalid') {
      return res.status(400).json({ success: false, error: 'Enter a valid mobile number or email address.' });
    }
    if (found.error === 'ambiguousEmail') {
      return res.status(409).json({ success: false, error: 'More than one account uses that email address. Use their mobile number instead.' });
    }
    if (found.error) {
      return res.status(404).json({ success: false, error: 'No registered delegate with that mobile number or email address.' });
    }
    const user = found.user;
    const phone = user.phone_number;
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

// Printable payment receipt. Only available once the payment has been
// verified.
//
// Two ways in, one document. A delegate reads their own (/me/receipt); the
// desk is regularly asked to reprint or re-send one, and until now the only
// way to see a delegate's receipt was over their shoulder. Deliberately the
// SAME renderer rather than an admin-flavoured copy: the point of looking is
// to see exactly what the delegate sees, and two renderers would drift.
const renderReceipt = async (req, res, next) => {
  try {
    // :id is the admin route (role-gated below); no :id means the caller's
    // own, keyed on the session rather than anything the client supplied.
    const reg = req.params.id
      ? await dbGet('SELECT * FROM registrations WHERE id = ?', [req.params.id])
      : await dbGet('SELECT * FROM registrations WHERE phone_number = ?', [req.session.phone]);
    if (!reg) {
      return res.status(404).send('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;margin-top:4rem">No registration found.</body>');
    }
    if (reg.bank_status !== 'BANK_VERIFIED') {
      return res.status(403).send('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;margin-top:4rem"><h2>Receipt not available yet</h2><p>A receipt is issued once the finance team verifies the payment.</p><p><a href="/">Return to portal</a></p></body>');
    }

    // From the registration, not the session: the admin route's caller is not
    // the delegate whose details belong on this document.
    const user = await dbGet('SELECT * FROM users WHERE phone_number = ?', [reg.phone_number]);
    const verifiedRow = await dbGet(
      `SELECT created_at FROM audit_log
        WHERE entity_type = 'registration' AND entity_id = ? AND new_value = 'BANK_VERIFIED'
        ORDER BY id DESC LIMIT 1`,
      [String(reg.id)]
    );
    const selections = await fetchRegistrationSelections(reg.id);
    const summary = await getPaymentSummary(reg.id, reg.expected_amount);
    const paidTxns = summary.txns.filter((t) => t.txn_status === 'VERIFIED');

    // Dates are formatted by hand from IST parts rather than through
    // toLocaleDateString: this Node build's ICU is limited and silently
    // returns US month-first ordering, which on a financial document is a
    // real ambiguity (03/09 is two different days depending on who reads it).
    const istParts = (ts) => {
      const d = new Date(Number(ts) + IST_OFFSET_MS);
      return {
        day: d.getUTCDate(), mon: SHORT_MONTHS[d.getUTCMonth()], year: d.getUTCFullYear(),
        hh: String(d.getUTCHours()).padStart(2, '0'), mm: String(d.getUTCMinutes()).padStart(2, '0'),
      };
    };
    const fmtDay = (ts) => { if (!ts) return '—'; const p = istParts(ts); return `${p.day} ${p.mon} ${p.year}`; };
    const fmtStamp = (ts) => { if (!ts) return '—'; const p = istParts(ts); return `${p.day} ${p.mon} ${p.year}, ${p.hh}:${p.mm} IST`; };
    const verifiedOn = verifiedRow ? fmtStamp(verifiedRow.created_at) : '—';

    const { salutation: embedded, name: cleanName } = splitSalutation(reg.delegate_name);
    const sal = (user && user.salutation) || embedded;
    const delegateName = sal ? `${sal} ${cleanName}` : cleanName;
    const roleLine = [user && user.designation, user && user.institution].filter(Boolean).join(' · ');

    const fee = Number(reg.expected_amount != null ? reg.expected_amount : reg.paid_amount) || 0;
    const received = Number(summary.netVerifiedTotal) || 0;
    const balance = Math.max(0, fee - received);
    const statusLabel = balance > 0 ? 'Part paid' : 'Paid in full';

    // How the payable amount was arrived at. expected_amount is stored NET --
    // category fee, less any discount, plus any paid programme options (see
    // the registration submit handler) -- so a discounted delegate's receipt
    // otherwise showed only the reduced figure and said nothing about the
    // concession they were given. Six verified registrations currently carry a
    // 1,000 promo discount and had no record of it on their receipt.
    //
    // The list price isn't stored, so it's reconstructed by reversing that
    // arithmetic. Option fees are read from the options actually selected;
    // they are added AFTER the discount because a promo applies to the
    // category fee only, never to a paid workshop.
    const discount = Number(reg.discount_amount) || 0;
    const optionsFee = selections.reduce((sum, o) => sum + (Number(o.option_fee) || 0), 0);
    const categoryFee = fee + discount - optionsFee;
    const discountLabel = reg.discount_code === 'GROUP'
      ? 'Group discount'
      : (reg.discount_code ? `Promo code ${reg.discount_code}` : 'Discount');
    // Only worth showing when there is actually something to break down.
    const showBreakdown = discount > 0 || optionsFee > 0;
    const paidOptions = selections.filter((o) => Number(o.option_fee) > 0);

    const items = paidTxns.map((t) => ({
      when: t.reviewed_at || t.submitted_at,
      mode: PAYMENT_MODE_LABELS[t.payment_mode] || t.payment_mode || '',
      ref: t.utr_number || '',
      amount: Number(t.verified_amount != null ? t.verified_amount : t.amount) || 0,
    }));
    const refunds = (summary.refunds || []).map((r) => ({
      when: r.refunded_at, note: r.reference_note || '', amount: Number(r.amount) || 0,
    }));

    const money = (n) => `₹${inr(Number(n) || 0)}`;
    const esc = escapeHtml;
    // A phone number on a printed document should be readable, so group the
    // Indian ones the way they're written (+91 86002 02692). Other country
    // codes are left exactly as stored: their grouping conventions differ and
    // guessing at one would be worse than not grouping at all.
    const prettyPhone = (e164) => {
      const m = /^\+91(\d{5})(\d{5})$/.exec(String(e164 || ''));
      return m ? `+91 ${m[1]} ${m[2]}` : String(e164 || '');
    };
    // Issuer identity, from Settings. There is no separate accounts address or
    // receipt-number sequence in the data model yet -- until there is, the
    // registration number is the document's reference and the conference
    // contact is the address of record.
    const issuer = [CONFERENCE.location, EMAIL.from].filter(Boolean);
    const confLine = [formatConferenceDates(), CONFERENCE.location].filter(Boolean).join(' · ');

    // ONE DOCUMENT PER AUDIENCE, rather than two layouts in one file behind
    // a @media print swap.
    //
    // Safari builds the print preview from the live DOM but generates the
    // actual print/PDF in a second pass, and in that pass it drops content
    // whose visibility comes from the print stylesheet: the preview showed
    // the statement correctly and the printed sheet came out blank. That was
    // true whether the statement was hidden with display:none or with
    // visibility -- the swap itself is what Safari mishandles. Chrome and
    // Firefox print either version fine, which is what made it look like a
    // CSS bug rather than a structural one.
    //
    // So there is no swap. The delegate gets the stub; Print / Save as PDF
    // opens the statement at ?print=1, which is an ordinary document with
    // nothing hidden in it and prints the same everywhere.
    const wantsPrint = String(req.query.print || '') === '1';
    const BASE_CSS = `
  /* One document, two layouts. The delegate reads the stub on a phone; the
     statement is what comes out of Print / Save as PDF, because that copy
     goes to a finance office and has to look like an accounting record.
     Neither is a resized version of the other -- they are different
     documents, so each is authored separately and CSS picks one. */
  :root {
    color-scheme: light;
    --white:#FFFFFF; --ink:#16181D; --soft:#494E5C; --muted:#767C8C;
    --rule:#DDDFE7; --rule-2:#EDEEF3; --indigo:#3B33A8; --indigo-2:#EDECFA;
    --green:#146B3E; --green-2:#E5F3EA; --ground:#EEF0F4; --red:#B3261E;
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:2rem 1rem 3rem; background:var(--ground); color:var(--ink);
         font-family:"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
         line-height:1.55; -webkit-font-smoothing:antialiased; }
  .money { font-variant-numeric:tabular-nums; white-space:nowrap; }`;
    const STUB_CSS = `  /* ---------------- Stub (screen) ---------------- */
  .stub { width:380px; max-width:100%; margin:0 auto; border-radius:18px; overflow:hidden;
          background:var(--white); font-family:"Manrope", system-ui, sans-serif;
          box-shadow:0 1px 2px rgba(20,22,28,.06), 0 14px 36px rgba(20,22,28,.10); }
  .stub .top { background:var(--indigo); color:var(--white); padding:22px 26px 26px; }
  .stub .kicker { display:flex; justify-content:space-between; align-items:center; gap:1rem;
                  font-size:10.5px; font-weight:700; letter-spacing:.13em; text-transform:uppercase; color:#C9C6F2; }
  .stub .kicker .chip { background:rgba(255,255,255,.16); color:var(--white); border-radius:99px; padding:3px 9px; letter-spacing:.1em; }
  .stub .amt { font-size:44px; font-weight:800; letter-spacing:-.03em; margin-top:16px; line-height:1; }
  .stub .amt-sub { font-size:12.5px; font-weight:600; color:#C9C6F2; margin-top:7px; }
  .stub .perf { position:relative; height:22px; background:var(--indigo); }
  .stub .perf::before, .stub .perf::after { content:""; position:absolute; top:0; width:22px; height:22px;
                                            border-radius:50%; background:var(--ground); }
  .stub .perf::before { left:-11px; } .stub .perf::after { right:-11px; }
  .stub .perf i { position:absolute; left:16px; right:16px; top:10px; border-top:2px dashed rgba(255,255,255,.42); }
  .stub .body { padding:22px 26px 24px; display:flex; flex-direction:column; gap:18px; }
  .stub .nm { font-size:17px; font-weight:800; letter-spacing:-.01em; }
  .stub .rl { font-size:12.5px; color:var(--soft); font-weight:500; margin-top:3px; }
  .stub .reg { display:flex; justify-content:space-between; align-items:center; gap:1rem;
               background:var(--indigo-2); border-radius:11px; padding:11px 14px; }
  .stub .reg .k { font-size:10px; font-weight:700; letter-spacing:.11em; text-transform:uppercase; color:var(--indigo); }
  .stub .reg .v { font-family:"IBM Plex Mono", ui-monospace, monospace; font-size:14px; font-weight:600; color:var(--indigo); }
  .stub .rw { display:flex; justify-content:space-between; gap:1rem; padding:8px 0;
              border-bottom:1px solid var(--rule-2); font-size:12.5px; }
  .stub .rw:last-child { border-bottom:0; }
  .stub .rw .k { color:var(--muted); font-weight:500; }
  .stub .rw .v { font-weight:600; text-align:right; }
  /* Not monospace: this carries the venue, not a reference number. The mono
     face is reserved for things you might have to read back digit by digit. */
  .stub .rw .v .sub { display:block; font-size:11px; font-weight:500; color:var(--muted); margin-top:1px; }
  .stub .split { background:#F7F7FB; border-radius:11px; padding:12px 14px; display:flex; flex-direction:column; gap:8px; }
  .stub .split .hd { font-size:10px; font-weight:700; letter-spacing:.11em; text-transform:uppercase; color:var(--muted); }
  .stub .split .ln { display:flex; justify-content:space-between; gap:1rem; font-size:12px; }
  .stub .split .ln .l { color:var(--soft); }
  .stub .split .ln .l em { font-style:normal; display:block; font-family:"IBM Plex Mono", monospace; font-size:10.5px; color:var(--muted); }
  .stub .split .ln .m { font-family:"IBM Plex Mono", monospace; font-weight:600; }
  .stub .split .ln .m.neg { color:var(--red); }
  .stub .note { background:#FBF1E0; border:1px solid #E4C489; color:#7A4B05; border-radius:10px;
                padding:10px 12px; font-size:11.5px; line-height:1.5; }
  .stub .foot { font-size:10.5px; color:var(--muted); line-height:1.5; text-align:center;
                border-top:1px solid var(--rule-2); padding-top:14px; }
  .actions { text-align:center; margin-top:1.5rem; }
  .actions button { font:inherit; font-weight:700; font-size:.85rem; background:var(--indigo); color:var(--white);
                    border:0; border-radius:10px; padding:.7rem 1.5rem; cursor:pointer; }
  .actions button:hover { background:#332B92; }
  .actions p { margin:.6rem 0 0; font-size:.72rem; color:var(--muted); }
  :focus-visible { outline:2px solid var(--indigo); outline-offset:3px; }`;
    const STMT_CSS = `  /* ---------------- Statement (its own document) ---------------- */
  .stmt { width:100%; background:var(--white); font-family:"IBM Plex Sans", system-ui, sans-serif; color:var(--ink); }
  .stmt .bar { display:flex; justify-content:space-between; align-items:flex-start; gap:2rem;
               padding-bottom:16px; border-bottom:1px solid var(--rule); }
  .stmt .bar .kd { font-family:"IBM Plex Mono", monospace; font-size:10px; letter-spacing:.15em;
                   text-transform:uppercase; color:var(--indigo); font-weight:600; }
  .stmt .bar .cf { font-size:15px; font-weight:600; line-height:1.3; max-width:36ch; margin-top:4px; }
  .stmt .bar .dt { font-family:"IBM Plex Mono", monospace; font-size:11px; color:var(--muted); margin-top:3px; }
  .stmt .bar .rgt { text-align:right; }
  .stmt .bar .rgt .k { font-family:"IBM Plex Mono", monospace; font-size:9.5px; letter-spacing:.12em;
                       text-transform:uppercase; color:var(--muted); display:block; }
  .stmt .bar .rgt .v { font-family:"IBM Plex Mono", monospace; font-size:14px; font-weight:600; display:block; margin-top:2px; }
  .stmt .bar .rgt .pill { display:inline-block; margin-top:6px; font-family:"IBM Plex Mono", monospace;
                          font-size:9.5px; letter-spacing:.1em; text-transform:uppercase; font-weight:600;
                          background:var(--green-2); color:var(--green); padding:3px 8px; border-radius:3px; }
  .stmt .hero { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap;
                padding:20px 0; border-bottom:1px solid var(--rule); }
  .stmt .hero .big { font-size:32px; font-weight:600; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
  .stmt .hero .cap { font-size:12.5px; color:var(--soft); }
  .stmt .hero .cap b { font-weight:600; color:var(--ink); }
  .stmt .grid { display:grid; grid-template-columns:118px 1fr; }
  .stmt .grid .k { font-family:"IBM Plex Mono", monospace; font-size:9.5px; letter-spacing:.1em;
                   text-transform:uppercase; color:var(--muted); padding:10px 0; border-bottom:1px solid var(--rule-2); }
  .stmt .grid .v { font-size:13px; padding:10px 0; border-bottom:1px solid var(--rule-2); }
  .stmt .grid .v .sub { display:block; font-size:11.5px; color:var(--muted); }
  .stmt .grid .v.mono { font-family:"IBM Plex Mono", monospace; }
  .stmt .lines { padding-top:18px; }
  .stmt .lines .hd { font-family:"IBM Plex Mono", monospace; font-size:9.5px; letter-spacing:.12em;
                     text-transform:uppercase; color:var(--muted); padding-bottom:9px; }
  .stmt .ln { display:grid; grid-template-columns:78px 1fr auto; gap:14px; align-items:baseline;
              padding:9px 0; border-top:1px solid var(--rule-2); font-size:12.5px; }
  .stmt .ln .d { font-family:"IBM Plex Mono", monospace; font-size:11px; color:var(--muted); }
  .stmt .ln .w .rf { font-family:"IBM Plex Mono", monospace; font-size:10.5px; color:var(--muted); }
  .stmt .ln .m { font-family:"IBM Plex Mono", monospace; font-weight:600; text-align:right; }
  .stmt .ln .m.neg { color:var(--red); }
  .stmt .ln.sum { border-top:1.5px solid var(--ink); margin-top:3px; font-size:13.5px; font-weight:600; }
  .stmt .bal { display:flex; justify-content:space-between; padding-top:9px; font-size:12px; color:var(--soft); }
  .stmt .bal .m { font-family:"IBM Plex Mono", monospace; }
  .stmt .note { margin-top:14px; border:1px solid #E4C489; background:#FBF1E0; color:#7A4B05;
                padding:9px 11px; font-size:11px; border-radius:3px; }
  .stmt .foot { margin-top:22px; padding-top:12px; border-top:1px solid var(--rule); font-size:10.5px;
                color:var(--muted); line-height:1.55; display:flex; justify-content:space-between; gap:1.5rem; }
  .stmt .foot .r { text-align:right; }`;

    const page = (css, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment Receipt — ${esc(reg.registration_number)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=Manrope:wght@500;600;700;800&display=swap">
<style>${css}</style></head>
<body>${body}</body></html>`;

    res.set('Cache-Control', 'private, no-store');

    if (wantsPrint) {
      return res.type('html').send(page(`${BASE_CSS}
${STMT_CSS}
  /* This document exists to be printed, so it is the page -- no wrapper, no
     card, no centring to fight the printer over. */
  body { background:var(--white); padding:24px; max-width:210mm; margin:0 auto; }
  .actions { text-align:center; margin-top:24px; }
  .actions button { font:inherit; font-weight:600; font-size:.85rem; background:var(--indigo); color:var(--white);
                    border:0; border-radius:8px; padding:.6rem 1.4rem; cursor:pointer; }
  @media print {
    @page { size:A4; margin:14mm; }
    html, body { background:#fff; padding:0; margin:0; max-width:none; }
    .actions { display:none; }
    /* The pill and the excess note carry meaning, so keep their fills. */
    * { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  }`, `<div class="stmt">
    <div class="bar">
      <div>
        <span class="kd">Payment receipt</span>
        <div class="cf">${esc(CONFERENCE.name)}</div>
        <div class="dt">${esc(confLine)}</div>
      </div>
      <div class="rgt">
        <span class="k">Registration no.</span>
        <span class="v">${esc(reg.registration_number)}</span>
        <span class="pill">${esc(statusLabel)}</span>
      </div>
    </div>

    <div class="hero">
      <span class="big money">${esc(money(received))}</span>
      <span class="cap">received against ${showBreakdown ? 'a payable amount of' : 'a fee of'} <b>${esc(money(fee))}</b>${discount > 0 ? ` (after a ${esc(money(discount))} discount)` : ''} · ${balance > 0 ? `<b>${esc(money(balance))}</b> outstanding` : 'nothing outstanding'}</span>
    </div>

    <div class="grid">
      <div class="k">Delegate</div>
      <div class="v">${esc(delegateName)}${roleLine ? `<span class="sub">${esc(roleLine)}</span>` : ''}</div>
      ${displayPhone(reg) ? `<div class="k">Mobile</div><div class="v mono">${esc(prettyPhone(displayPhone(reg)))}</div>` : ''}
      ${user && user.email ? `<div class="k">Email</div><div class="v mono">${esc(user.email)}</div>` : ''}
      <div class="k">Category</div>
      <div class="v">${esc(reg.category_label)}</div>
      ${selections.length ? `<div class="k">Includes</div><div class="v">${selections.map((s, i) => i === 0 ? esc(s.option_name) : `<span class="sub">${esc(s.option_name)}</span>`).join('')}</div>` : ''}
      <div class="k">Issued by</div>
      <div class="v">${esc(CONFERENCE.location)}${EMAIL.from ? `<span class="sub">${esc(EMAIL.from)}</span>` : ''}</div>
      <div class="k">Verified on</div>
      <div class="v mono">${esc(verifiedOn)}</div>
    </div>

    ${showBreakdown ? `<div class="lines">
      <div class="hd">Fee</div>
      <div class="ln"><span class="d"></span><span class="w">${esc(reg.category_label)}</span><span class="m money">${esc(money(categoryFee))}</span></div>
      ${paidOptions.map((o) => `<div class="ln"><span class="d"></span><span class="w">${esc(o.option_name)}</span><span class="m money">${esc(money(o.option_fee))}</span></div>`).join('')}
      ${discount > 0 ? `<div class="ln"><span class="d"></span><span class="w">${esc(discountLabel)}</span><span class="m money neg">− ${esc(money(discount))}</span></div>` : ''}
      <div class="ln sum"><span class="d"></span><span class="w">Amount payable</span><span class="m money">${esc(money(fee))}</span></div>
    </div>` : ''}

    <div class="lines">
      <div class="hd">Payments received</div>
      ${items.length ? items.map((i) => `<div class="ln">
        <span class="d">${esc(fmtDay(i.when))}</span>
        <span class="w">${esc(i.mode)}${i.ref ? ` <span class="rf">${esc(i.ref)}</span>` : ''}</span>
        <span class="m money">${esc(money(i.amount))}</span>
      </div>`).join('') : `<div class="ln"><span class="d">—</span><span class="w">No itemised transactions on record</span><span class="m">—</span></div>`}
      ${refunds.map((r) => `<div class="ln">
        <span class="d">${esc(fmtDay(r.when))}</span>
        <span class="w">Refunded${r.note ? ` <span class="rf">${esc(r.note)}</span>` : ''}</span>
        <span class="m money neg">− ${esc(money(r.amount))}</span>
      </div>`).join('')}
      <div class="ln sum"><span class="d"></span><span class="w">Total received</span><span class="m money">${esc(money(received))}</span></div>
      <div class="bal"><span>Balance due</span><span class="m money">${esc(money(balance))}</span></div>
    </div>

    ${summary.overpaid > 0 ? `<div class="note">Paid ${esc(money(summary.overpaid))} more than the ${esc(money(summary.fee))} fee. The excess is due to be refunded.</div>` : ''}

    <div class="foot">
      <span>Computer-generated receipt; valid without signature.<br>Quote ${esc(reg.registration_number)} in all correspondence.</span>
      <span class="r">${esc(CONFERENCE.acronym)}<br>${esc(CONFERENCE.location)}</span>
    </div>
  </div>
  <div class="actions"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
  <script>
    // Print once the webfonts have settled, so the paginated output matches
    // what was on screen; don't wait forever if they never resolve.
    (function () {
      var printed = false;
      function go() { if (printed) return; printed = true; window.print(); }
      if (document.fonts && document.fonts.ready) {
        Promise.race([document.fonts.ready, new Promise(function (r) { setTimeout(r, 1500); })]).then(go);
      } else { setTimeout(go, 400); }
      // Only closes when this was opened by the receipt's button; a directly
      // visited URL just stays put.
      window.onafterprint = function () { window.close(); };
    }());
  <\/script>`));
    }

    return res.type('html').send(page(`${BASE_CSS}
${STUB_CSS}`, `<div class="stub">
    <div class="top">
      <div class="kicker"><span>${esc(CONFERENCE.acronym)} · Receipt</span><span class="chip">${esc(statusLabel)}</span></div>
      <div class="amt money">${esc(money(received))}</div>
      <div class="amt-sub">${balance > 0 ? `${esc(money(balance))} still due` : 'Received in full'} · ${esc(fmtDay(verifiedRow && verifiedRow.created_at))}</div>
    </div>
    <div class="perf"><i></i></div>
    <div class="body">
      <div>
        <div class="nm">${esc(delegateName)}</div>
        ${roleLine ? `<div class="rl">${esc(roleLine)}</div>` : ''}
      </div>

      <div class="reg">
        <span class="k">Registration</span>
        <span class="v">${esc(reg.registration_number)}</span>
      </div>

      <div>
        <div class="rw"><span class="k">Category</span><span class="v">${esc(reg.category_label)}</span></div>
        ${selections.map((s) => `<div class="rw"><span class="k">${esc(s.group_name)}</span><span class="v">${esc(s.option_name)}</span></div>`).join('')}
        <div class="rw"><span class="k">Conference</span><span class="v">${esc(formatConferenceDates())}<span class="sub">${esc(CONFERENCE.location)}</span></span></div>
      </div>

      ${showBreakdown ? `<div class="split">
        <div class="hd">How the fee was worked out</div>
        <div class="ln"><span class="l">${esc(reg.category_label)}</span><span class="m money">${esc(money(categoryFee))}</span></div>
        ${paidOptions.map((o) => `<div class="ln"><span class="l">${esc(o.option_name)}</span><span class="m money">${esc(money(o.option_fee))}</span></div>`).join('')}
        ${discount > 0 ? `<div class="ln"><span class="l">${esc(discountLabel)}</span><span class="m money neg">− ${esc(money(discount))}</span></div>` : ''}
        <div class="ln" style="border-top:1px solid var(--rule);padding-top:7px;font-weight:700"><span class="l" style="color:var(--ink)">Payable</span><span class="m money">${esc(money(fee))}</span></div>
      </div>` : ''}

      ${items.length > 1 || refunds.length ? `<div class="split">
        <div class="hd">${esc(items.length > 1 ? `Paid in ${items.length} instalments` : 'Payment')}</div>
        ${items.map((i) => `<div class="ln"><span class="l">${esc(i.mode)}${i.ref ? `<em>${esc(i.ref)}</em>` : ''}</span><span class="m money">${esc(money(i.amount))}</span></div>`).join('')}
        ${refunds.map((r) => `<div class="ln"><span class="l">Refunded${r.note ? `<em>${esc(r.note)}</em>` : ''}</span><span class="m money neg">− ${esc(money(r.amount))}</span></div>`).join('')}
      </div>` : ''}

      ${summary.overpaid > 0 ? `<div class="note">You paid ${esc(money(summary.overpaid))} more than the ${esc(money(summary.fee))} fee. The excess is due to be refunded — contact the organisers if you have not received it.</div>` : ''}

      <div class="foot">
        Issued by ${esc(issuer.join(' · '))}<br>
        Quote ${esc(reg.registration_number)} in all correspondence.
      </div>
    </div>
  </div>
  <div class="actions">
    <button type="button" onclick="window.open('?print=1', '_blank')">Print / Save as PDF</button>
    <p>Opens a full statement, suitable for a reimbursement claim.</p>
  </div>`));
  } catch (err) {
    next(err);
  }
};

// 'me' first, so the literal path is never swallowed by :id.
app.get('/api/registrations/me/receipt', requireAuth, renderReceipt);
app.get('/api/registrations/:id/receipt', requirePermission('payments.view'), renderReceipt);

// Serve a payment screenshot to the owning delegate or a finance admin.
app.get('/api/registrations/:id/screenshot', requireAuth, async (req, res, next) => {
  try {
    const row = await dbGet('SELECT phone_number, screenshot FROM registrations WHERE id = ?', [req.params.id]);
    if (!row || !row.screenshot) {
      return res.status(404).json({ success: false, error: 'Screenshot not found.' });
    }

    // Whoever may read payments may read the evidence behind them; everyone
    // else only their own. Same set as before -- see permissions.js.
    const isFinance = can(req.session.role, 'payments.view');
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
    // Whoever may read payments may read the evidence behind them; everyone
    // else only their own. Same set as before -- see permissions.js.
    const isFinance = can(req.session.role, 'payments.view');
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

// Serve the payment slip attached to ONE ledger transaction, rather than the
// single registrations.screenshot column, which each new submission
// overwrites. A partial payment followed by a top-up therefore has two
// slips, and this is the only way to see the earlier one -- see the
// per-transaction "Slip" button in the review modal's reconciliation list.
app.get('/api/payment-transactions/:txnId/screenshot', requireAuth, async (req, res, next) => {
  try {
    const txn = await dbGet('SELECT phone_number, screenshot FROM payment_transactions WHERE id = ?', [req.params.txnId]);
    if (!txn || !txn.screenshot) {
      return res.status(404).json({ success: false, error: 'No payment slip on file for this transaction.' });
    }
    // Same access rule as the registration-level screenshot above: finance
    // staff, or the delegate whose own payment it is.
    // Whoever may read payments may read the evidence behind them; everyone
    // else only their own. Same set as before -- see permissions.js.
    const isFinance = can(req.session.role, 'payments.view');
    if (!isFinance && req.session.phone !== txn.phone_number) {
      return res.status(403).json({ success: false, error: 'You do not have permission to view this payment slip.' });
    }

    res.set('Cache-Control', 'private, no-store');
    // Defensive fallback for any legacy base64 value that escaped migration.
    if (/^data:image\//i.test(txn.screenshot)) {
      const m = /^data:(image\/[a-z]+);base64,(.*)$/i.exec(txn.screenshot);
      if (!m) return res.status(404).json({ success: false, error: 'Payment slip not found.' });
      res.type(m[1]);
      return res.send(Buffer.from(m[2], 'base64'));
    }
    const safeName = path.basename(txn.screenshot); // guard against traversal
    const ext = path.extname(safeName).slice(1).toLowerCase();
    if (EXT_MIME[ext]) res.type(EXT_MIME[ext]);
    res.sendFile(path.join(UPLOAD_DIR, safeName), (err) => {
      if (err && !res.headersSent) res.status(404).json({ success: false, error: 'Payment slip not found.' });
    });
  } catch (err) {
    next(err);
  }
});

// Submit an abstract under the caller's own identity. Structured sections
// (not a PDF upload) -- see sanitizeAbstractHtml/plainTextWordCount above,
// and the ABSTRACT_MAX_WORDS cap.
const ABSTRACT_FORMATS = ['Oral Paper', 'Poster Presentation'];
const ABSTRACT_SECTIONS = ['background', 'aim', 'methods', 'results', 'conclusion'];
const ABSTRACT_SECTION_LABELS = { background: 'Background', aim: 'Aim', methods: 'Methods', results: 'Results', conclusion: 'Conclusion' };
const ABSTRACT_MAX_WORDS = 400;

app.post('/api/abstracts', requireAuth, async (req, res, next) => {
  try {
    const { format, title } = req.body;
    if (!title || !String(title).trim()) {
      return res.status(400).json({ success: false, error: 'Abstract title is required.' });
    }
    if (!ABSTRACT_FORMATS.includes(format)) {
      return res.status(400).json({ success: false, error: 'Please choose a valid presentation format.' });
    }

    const sections = {};
    for (const key of ABSTRACT_SECTIONS) {
      const raw = req.body[key];
      if (!raw || !plainTextWordCount(raw)) {
        return res.status(400).json({ success: false, error: `${ABSTRACT_SECTION_LABELS[key]} is required.` });
      }
      sections[key] = sanitizeAbstractHtml(raw);
    }
    const keywords = String(req.body.keywords || '').trim();
    if (!keywords) {
      return res.status(400).json({ success: false, error: 'At least one keyword is required.' });
    }

    // Word count is server-authoritative -- the client's live counter is a
    // convenience, not the actual gate. Keywords aren't prose, so they're
    // not counted toward the cap.
    const wordCount = ABSTRACT_SECTIONS.reduce((sum, key) => sum + plainTextWordCount(sections[key]), 0);
    if (wordCount > ABSTRACT_MAX_WORDS) {
      return res.status(400).json({ success: false, error: `Your abstract is ${wordCount} words; the limit is ${ABSTRACT_MAX_WORDS}.` });
    }

    // One abstract per author, locked once submitted -- with one exception:
    // a reviewer sending it back for corrections (status REVISION_REQUESTED,
    // see PUT /api/abstracts/:id/status) reopens this same endpoint for that
    // delegate, as an update rather than blocking or requiring a second
    // insert. Any other existing status stays locked.
    const prev = await dbGet('SELECT id, status FROM abstracts WHERE phone_number = ?', [req.session.phone]);
    if (prev && prev.status !== 'REVISION_REQUESTED') {
      return res.status(409).json({ success: false, error: 'You have already submitted an abstract; it cannot be changed.' });
    }

    const cleanTitle = String(title).trim();
    const isResubmission = !!prev;
    if (isResubmission) {
      await dbRun(
        `UPDATE abstracts SET
           format = ?, title = ?, background = ?, aim = ?, methods = ?, results = ?, conclusion = ?,
           keywords = ?, word_count = ?, status = 'UNDER_REVIEW', revision_note = NULL
         WHERE id = ?`,
        [format, cleanTitle, sections.background, sections.aim, sections.methods, sections.results, sections.conclusion,
         keywords, wordCount, prev.id]
      );
      await recordAudit({
        req, entityType: 'abstract', entityId: prev.id,
        action: 'ABSTRACT_RESUBMITTED', oldValue: 'REVISION_REQUESTED', newValue: 'UNDER_REVIEW',
      });
    } else {
      await dbRun(
        `INSERT INTO abstracts
          (phone_number, author_name, format, title, background, aim, methods, results, conclusion, keywords, word_count, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNDER_REVIEW')`,
        [req.session.phone, req.session.name, format, cleanTitle,
         sections.background, sections.aim, sections.methods, sections.results, sections.conclusion,
         keywords, wordCount]
      );
    }

    // Acknowledge receipt; acceptance is communicated after committee review.
    notifyDelegate(req.session.phone, isResubmission ? 'Revised abstract received — under review' : 'Abstract received — under review',
      emailWrap('We’ve received your abstract',
        `<p>Dear ${escapeHtml(req.session.name)},</p>
         <p>Thank you for ${isResubmission ? 'resubmitting your revised abstract' : 'submitting your abstract'}, <b>"${escapeHtml(cleanTitle)}"</b>, for the ${escapeHtml(CONFERENCE.name)}.</p>
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
      `SELECT id, format, title, status, allocation, revision_note,
              background, aim, methods, results, conclusion, keywords, word_count
         FROM abstracts WHERE phone_number = ?`,
      [req.session.phone]
    );
    res.json({ abstract: row || null });
  } catch (err) {
    next(err);
  }
});

// --- ADMIN ENDPOINTS ----------------------------------------------------

// Finance reconciliation: view all registrations, each annotated with the
// most recent audit entry (who last changed its status, and when).
// Delegate geographic distribution for the approval page's overview map:
// counts split into registered (has a registrations row) vs signed-up-only.
//
// Grouped by PIN code as well as district name, because the client resolves a
// delegate to a map polygon by district name first and falls back to the PIN
// code's coordinates when that name isn't in the shapefile (see
// renderDelegateMap). A blank district is no longer filtered out here -- the
// PIN code alone is enough to place those delegates.
//
// State is grouped, not just selected. Six district names belong to two
// states each (Aurangabad, Bilaspur, Hamirpur, Pratapgarh, Balrampur,
// Raigarh), and the client needs the state to tell them apart -- so it has to
// be a real property of the group rather than whichever row SQLite happened
// to pick for a bare column.
app.get('/api/admin/delegate-locations', requirePermission('payments.view'), async (req, res, next) => {
  try {
    const rows = await dbAll(`
      SELECT TRIM(u.pincode) AS pincode, LOWER(TRIM(u.district)) AS district, TRIM(u.state) AS state,
        SUM(CASE WHEN r.phone_number IS NOT NULL THEN 1 ELSE 0 END) AS registered,
        SUM(CASE WHEN r.phone_number IS NULL THEN 1 ELSE 0 END) AS signedup
      FROM users u
      LEFT JOIN registrations r ON r.phone_number = u.phone_number
      WHERE u.pincode IS NOT NULL AND TRIM(u.pincode) != ''
        AND (u.country IS NULL OR TRIM(u.country) = '' OR LOWER(TRIM(u.country)) = 'india')
      GROUP BY TRIM(u.pincode), LOWER(TRIM(u.district)), LOWER(TRIM(u.state))`);

    // The choropleth is an Indian district map, so an international delegate
    // has nowhere to be drawn -- and the pincode filter above would drop
    // them silently, which is the one outcome worth avoiding. Counted
    // separately instead, per country, so they're visibly accounted for
    // rather than just missing from the total.
    const intl = await dbAll(`
      SELECT TRIM(u.country) AS country,
        SUM(CASE WHEN r.phone_number IS NOT NULL THEN 1 ELSE 0 END) AS registered,
        SUM(CASE WHEN r.phone_number IS NULL THEN 1 ELSE 0 END) AS signedup
      FROM users u
      LEFT JOIN registrations r ON r.phone_number = u.phone_number
      WHERE u.country IS NOT NULL AND TRIM(u.country) != '' AND LOWER(TRIM(u.country)) != 'india'
      GROUP BY TRIM(u.country)
      ORDER BY registered DESC, signedup DESC, country`);

    res.json({ locations: rows || [], international: intl || [] });
  } catch (err) {
    next(err);
  }
});

app.get('/api/registrations', requirePermission('payments.view'), async (req, res, next) => {
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

    // Same batched-fetch-then-group approach as transactions above, for
    // recorded refunds (see payment_refunds / getPaymentSummary).
    const allRefunds = await dbAll(
      `SELECT payment_refunds.*, b.post_date AS bank_txn_date, b.description AS bank_txn_description
         FROM payment_refunds
         LEFT JOIN bank_statement_transactions b ON b.id = payment_refunds.bank_txn_id
        ORDER BY refunded_at ASC, id ASC`);
    const refundsByReg = {};
    for (const r of allRefunds) (refundsByReg[r.registration_id] ||= []).push(r);

    const enriched = (rows || []).map((r) => {
      const txns = txnsByReg[r.id] || [];
      const verifiedTotal = txns
        .filter((t) => t.txn_status === 'VERIFIED')
        .reduce((s, t) => s + (t.verified_amount != null ? t.verified_amount : (t.amount || 0)), 0);
      const refunds = refundsByReg[r.id] || [];
      const refundedTotal = refunds.reduce((s, x) => s + (x.amount || 0), 0);
      const netVerifiedTotal = verifiedTotal - refundedTotal;
      const fee = r.expected_amount || 0;
      const row = withDelegateSalutation(r);
      row.transactions = txns;
      row.verified_total = verifiedTotal;
      row.refunds = refunds;
      row.refunded_total = refundedTotal;
      row.remaining = Math.max(0, fee - netVerifiedTotal);
      row.overpaid = Math.max(0, netVerifiedTotal - fee);
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

// Has this delegate put up enough money to cover the fee?
//
// The LEDGER answers that, not registrations.paid_amount: that column holds
// the most recent claim, so a delegate who paid a 2,000 fee as 750 + 1,250
// reads as having claimed 750, and comparing it against the whole fee marked
// four fully paid, verified delegates as having tampered with the amount. A
// legacy row with no ledger at all falls back to the column.
function amountShortOfFee(claimedTotal, paidAmount, expectedAmount) {
  const claimed = Number(claimedTotal) > 0 ? Number(claimedTotal) : paidAmount;
  if (claimed == null || !Number.isFinite(Number(claimed))) return true;
  return Math.round(Number(claimed)) + 0.5 < Number(expectedAmount || 0);
}

// Re-runs the automated screenshot/ID-card checks against every registration
// that's ever been flagged -- pending, already approved, or rejected -- against
// its *already-uploaded* files. For when the OCR matching logic itself changes
// (e.g. a bug fix) and past submissions should be re-judged against the
// corrected logic instead of staying flagged on a stale, since-fixed false
// negative. Only touches the ocr_*_match/is_flagged columns, never
// bank_status -- an approval or rejection already made stays made; this just
// cleans up the flag/check data behind it.
app.post('/api/admin/registrations/rescan-flagged', requirePermission('payments.rescan'), async (req, res, next) => {
  try {
    // `all` re-judges every registration that has a screenshot, not only the
    // ones currently flagged. Approving a registration clears is_flagged, so
    // a flagged-only rescan cannot reach the check results sitting behind an
    // already-approved row -- which is exactly what needs refreshing after
    // the matching logic changes, since those results are what the review
    // modal shows.
    const all = !!req.body.all;
    // One batch per request. Every row costs an OCR pass, and a second one
    // when the amount isn't found on the first -- around 190 rows takes
    // minutes, and this app sits behind a proxy that gives up at 100
    // seconds. The admin would have seen a failure while the server carried
    // on rewriting rows behind it. The client walks the batches instead, so
    // each request is short and the progress is real.
    const after = Number(req.body.after) || 0;
    const BATCH = 20;
    const scopeSql = all ? "r.screenshot IS NOT NULL AND r.screenshot != ''" : 'r.is_flagged = 1';

    // slip_amount, not expected_amount. registrations.screenshot is ONE
    // payment's slip, and a delegate who paid a 2,000 fee in instalments of
    // 750 and 1,250 has a slip that says 1,250 -- comparing it against the
    // full fee reports a discrepancy on a perfectly good screenshot. Five
    // registrations were flagged that way. The ledger row that owns this
    // screenshot knows what it was for; fall back to the fee only when no
    // row claims it (a legacy submission that predates the ledger).
    //
    // claimed_total is the same correction applied to the tamper test below:
    // the whole ledger, not the one claim that happens to sit on the
    // registration row. REJECTED rows are excluded -- a rejected payment is
    // not money the delegate has put up.
    const rows = await dbAll(
      `SELECT r.id, r.registration_number, r.category_key, r.expected_amount, r.paid_amount,
              r.utr_number, r.screenshot, r.payment_mode,
              COALESCE(
                (SELECT COALESCE(pt.verified_amount, pt.amount) FROM payment_transactions pt
                  WHERE pt.registration_id = r.id AND pt.screenshot = r.screenshot
                  ORDER BY pt.id DESC LIMIT 1),
                r.expected_amount) AS slip_amount,
              (SELECT COALESCE(SUM(COALESCE(pt.verified_amount, pt.amount)), 0)
                 FROM payment_transactions pt
                WHERE pt.registration_id = r.id AND pt.txn_status != 'REJECTED') AS claimed_total
         FROM registrations r
        WHERE ${scopeSql} AND r.id > ?
        ORDER BY r.id LIMIT ${BATCH}`, [after]);

    const remainingRow = await dbGet(
      `SELECT COUNT(*) AS n FROM registrations r WHERE ${scopeSql} AND r.id > ?`, [after]);
    const total = remainingRow ? remainingRow.n : rows.length;

    let rescanned = 0;
    let unflagged = 0;
    let stillFlagged = 0;
    let skippedNoFile = 0;

    for (const reg of rows) {
      const buffer = await readStoredUpload(reg.screenshot);
      if (!buffer) { skippedNoFile++; continue; }

      const checks = await runOcrChecks(buffer, { expectedAmount: reg.slip_amount, utr: reg.utr_number });
      if (reg.payment_mode === 'NEFT_RTGS') checks.vpa = true;

      // Only the payment screenshot is machine-checked; a student ID card is
      // confirmed by an approver, not by OCR, so a rescan has nothing to
      // re-judge about it.
      //
      // `amountStatus !== 'mismatch'` rather than `checks.amount`: an amount
      // nobody could read is not a failed check, it is an absent one.
      const allChecksPass = checks.amountStatus !== AMOUNT_MISMATCH && checks.vpa && checks.utr;
      const amountTampered = amountShortOfFee(reg.claimed_total, reg.paid_amount, reg.expected_amount);
      const flagged = !allChecksPass || amountTampered ? 1 : 0;

      await dbRun(
        `UPDATE registrations SET ocr_amount_match = ?, ocr_amount_status = ?, ocr_vpa_match = ?, ocr_utr_match = ?, is_flagged = ? WHERE id = ?`,
        [checks.amount ? 1 : 0, checks.amountStatus, checks.vpa ? 1 : 0, checks.utr ? 1 : 0, flagged, reg.id]
      );

      rescanned++;
      if (flagged) stillFlagged++; else unflagged++;
    }

    // nextAfter drives the client's loop; null means this was the last batch.
    const nextAfter = rows.length === BATCH ? rows[rows.length - 1].id : null;
    res.json({
      success: true, scope: all ? 'all' : 'flagged',
      totalFlagged: total, remaining: Math.max(0, total - rows.length),
      nextAfter, rescanned, unflagged, stillFlagged, skippedNoFile,
    });
  } catch (err) {
    next(err);
  }
});

// Finance reconciliation: update bank verification status (audited).
app.put('/api/registrations/:id/status', requirePermission('payments.decide'), async (req, res, next) => {
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
    if (bankStatus === 'BANK_VERIFIED' && (await categoryRequiresStudentId(existing.category_key)) && !existing.id_verified) {
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
app.put('/api/registrations/:id/unapprove', requirePermission('payments.unapprove'), async (req, res, next) => {
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
app.put('/api/registrations/:id/lock-category', requirePermission('payments.revise'), async (req, res, next) => {
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

// Ask the delegate to pay the outstanding balance -- whether that's because
// their category (and so the fee) changed, or their linked bank credit fell
// short of what they claimed (a genuine partial payment). Gated: the
// delegate's existing payment(s) must be linked/acknowledged first, so the
// balance is computed against what they've actually paid -- not the claim.
// Moves the registration to PARTIAL_PAYMENT (the balance-due section) and
// emails the delegate.
app.post('/api/registrations/:id/revise-payment', requirePermission('payments.revise'), async (req, res, next) => {
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
app.delete('/api/registrations/:id/lock-category', requirePermission('payments.unlock_category'), async (req, res, next) => {
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
app.put('/api/registrations/:id/verify-id', requirePermission('payments.verify_id'), async (req, res, next) => {
  try {
    const verified = !!req.body.verified;
    const existing = await dbGet('SELECT id, category_key, id_verified FROM registrations WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Registration not found.' });
    if (!(await categoryRequiresStudentId(existing.category_key))) {
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
app.get('/api/registrations/:id/candidate-transactions', requirePermission('payments.link'), async (req, res, next) => {
  try {
    const reg = await dbGet('SELECT id, paid_amount, expected_amount FROM registrations WHERE id = ?', [req.params.id]);
    if (!reg) return res.status(404).json({ success: false, error: 'Registration not found.' });
    const targetAmount = reg.paid_amount != null ? reg.paid_amount : reg.expected_amount;
    // A credit with SOME of its amount already spoken for still shows here
    // (with how much is left) rather than disappearing entirely -- see
    // allocatedForBankTxn(). Scans in closest-amount order and stops once 50
    // have any remaining amount, same cap as before.
    const raw = await dbAll(
      `SELECT * FROM bank_statement_transactions
        WHERE credit IS NOT NULL AND credit > 0 AND is_non_registration = 0
        ORDER BY ABS(COALESCE(credit, 0) - ?) ASC, post_date DESC`,
      [targetAmount || 0]
    );
    const rows = [];
    for (const t of raw) {
      const { remaining } = await allocatedForBankTxn(t.id);
      if (remaining > 0) rows.push({ ...t, remaining });
      if (rows.length >= 50) break;
    }
    res.json({ transactions: rows });
  } catch (err) {
    next(err);
  }
});

// Manually link a registration to a specific statement transaction (e.g. an
// IMPS/NEFT credit that can't be auto-matched by reference number). Legacy
// mechanism (registrations.bank_txn_id) -- it never tracked a partial
// amount, so unlike the per-transaction endpoints below it can't take part
// in a split; any existing allocation at all (even partial, via the current
// per-transaction mechanism) blocks it.
app.put('/api/registrations/:id/link-transaction', requirePermission('payments.link'), async (req, res, next) => {
  try {
    const { transactionId } = req.body;
    const reg = await dbGet('SELECT id, bank_txn_id FROM registrations WHERE id = ?', [req.params.id]);
    if (!reg) return res.status(404).json({ success: false, error: 'Registration not found.' });
    const txn = await dbGet('SELECT id, is_non_registration FROM bank_statement_transactions WHERE id = ?', [transactionId]);
    if (!txn) return res.status(404).json({ success: false, error: 'Statement transaction not found.' });
    if (txn.is_non_registration) {
      return res.status(400).json({ success: false, error: 'This transaction is marked as non-registration and cannot be linked to a registration.' });
    }
    const { allocated } = await allocatedForBankTxn(transactionId);
    if (allocated > 0) {
      return res.status(409).json({ success: false, error: 'That transaction already has an allocation and cannot be linked this way.' });
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
app.delete('/api/registrations/:id/link-transaction', requirePermission('payments.link'), async (req, res, next) => {
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
app.get('/api/payment-transactions/:txnId/candidates', requirePermission('payments.link'), async (req, res, next) => {
  try {
    const txn = await dbGet('SELECT id, amount FROM payment_transactions WHERE id = ?', [req.params.txnId]);
    if (!txn) return res.status(404).json({ success: false, error: 'Payment transaction not found.' });
    // Same "still has remaining room" listing as the registration-level
    // picker above, not a flat used/unused split -- see allocatedForBankTxn().
    const raw = await dbAll(
      `SELECT * FROM bank_statement_transactions
        WHERE credit IS NOT NULL AND credit > 0 AND is_non_registration = 0
        ORDER BY ABS(COALESCE(credit, 0) - ?) ASC, post_date DESC`,
      [txn.amount || 0]);
    const rows = [];
    for (const t of raw) {
      const { remaining } = await allocatedForBankTxn(t.id, txn.id);
      if (remaining > 0) rows.push({ ...t, remaining });
      if (rows.length >= 50) break;
    }
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
app.put('/api/payment-transactions/:txnId/link', requirePermission('payments.link'), async (req, res, next) => {
  try {
    const { bankTxnId } = req.body;
    const txn = await dbGet('SELECT id, registration_id, bank_txn_id, amount, verified_amount, txn_status FROM payment_transactions WHERE id = ?', [req.params.txnId]);
    if (!txn) return res.status(404).json({ success: false, error: 'Payment transaction not found.' });
    if (txn.txn_status === 'REJECTED') {
      return res.status(400).json({ success: false, error: 'This payment was rejected and cannot be linked.' });
    }
    const bank = await dbGet('SELECT id, is_non_registration FROM bank_statement_transactions WHERE id = ?', [bankTxnId]);
    if (!bank) return res.status(404).json({ success: false, error: 'Statement transaction not found.' });
    if (bank.is_non_registration) {
      return res.status(400).json({ success: false, error: 'This transaction is marked as non-registration and cannot be linked to a payment.' });
    }

    // One credit can now back several payment_transactions (see
    // allocatedForBankTxn) -- the only real blocker is nothing left to
    // allocate at all. A claim bigger than what's left is not an error on
    // its own: a genuine partial payment (the delegate paid less than the
    // fee due) looks exactly like this -- a real credit smaller than the
    // claimed amount -- and it must still be linkable so the registration
    // can move to PARTIAL_PAYMENT rather than sit stuck unlinkable forever.
    const { remaining } = await allocatedForBankTxn(bankTxnId, txn.id);
    if (remaining <= 0) {
      return res.status(409).json({ success: false, error: 'That bank transaction is already fully allocated to other payments.' });
    }

    // Linking acknowledges the payment at whatever the credit actually
    // covers -- its own claimed amount if the credit is big enough, or the
    // credit's remaining balance if the claim is larger (a partial payment).
    // This used to hard-block once the registration's cumulative verified
    // total would pass the fee due (the bug that guard caught: a duplicate
    // resubmission transaction wrongly linked to a second, real credit,
    // over-crediting a registration and stranding someone else's payment --
    // see Divya Selokar). Deliberately no longer a hard block on the
    // over-fee side either: two genuine transactions legitimately linked to
    // one delegate can leave them overpaid, and that's fine now -- the
    // excess is tracked for the refund feature rather than refused outright.
    // The audit trail records both an overpayment and a short-covered link,
    // so either is visible without a dedicated UI badge yet.
    const acknowledged = Math.min(txn.amount || 0, remaining);
    const reg = await dbGet('SELECT expected_amount FROM registrations WHERE id = ?', [txn.registration_id]);
    let noteSuffix = '';
    if (reg && reg.expected_amount > 0) {
      const summary = await getPaymentSummary(txn.registration_id, reg.expected_amount);
      // This link may be re-linking a transaction that's already VERIFIED
      // (e.g. correcting a wrongly-sized auto-link) -- summary.verifiedTotal
      // above still counts that stale contribution, so back it out before
      // adding the freshly-computed acknowledged amount, or a re-link would
      // double-count itself and falsely report an overpayment.
      const priorContribution = txn.txn_status === 'VERIFIED'
        ? (txn.verified_amount != null ? txn.verified_amount : (txn.amount || 0)) : 0;
      const wouldBeTotal = summary.verifiedTotal - priorContribution + acknowledged;
      if (wouldBeTotal > reg.expected_amount + 0.5) {
        noteSuffix = ` — ₹${inr(wouldBeTotal - reg.expected_amount)} over the ₹${inr(reg.expected_amount)} fee due (pending refund)`;
      } else if (acknowledged + 0.5 < (txn.amount || 0)) {
        noteSuffix = ` — claimed ₹${inr(txn.amount)}, credit only covers ₹${inr(acknowledged)} (partial)`;
      }
    }

    await dbRun(
      `UPDATE payment_transactions
          SET bank_txn_id = ?, txn_status = 'VERIFIED', verified_amount = ?,
              reviewed_by = ?, reviewed_at = ?
        WHERE id = ?`,
      [bankTxnId, acknowledged, req.session.name || req.session.phone, Date.now(), txn.id]);
    await recordAudit({
      req, entityType: 'registration', entityId: String(txn.registration_id),
      action: 'BANK_TXN_LINK', oldValue: txn.bank_txn_id, newValue: `txn#${txn.id} → bank#${bankTxnId} (₹${inr(acknowledged)} acknowledged)${noteSuffix}`,
    });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ success: false, error: 'That bank transaction is already linked to another payment.' });
    }
    next(err);
  }
});

// Admin-initiated: attach a bank credit to a registration that never
// submitted a matching claim for it (e.g. a second bank transfer the
// delegate didn't mention in the app). Every other path to a
// payment_transactions row starts with the delegate (registration submission
// or top-up); this is the one place an admin creates one directly instead of
// just linking an existing PENDING row -- same acknowledgement semantics as
// PUT .../link above (full credit amount, VERIFIED, reviewed_by/at stamped),
// just without a pre-existing row to attach it to. Takes the credit's whole
// amount, not a partial split -- splitting one credit across several
// registrations is a separate, not-yet-built feature.
app.post('/api/registrations/:id/admin-add-payment', requirePermission('payments.add_payment'), async (req, res, next) => {
  try {
    const { bankTxnId } = req.body;
    const reg = await dbGet('SELECT id, phone_number, expected_amount FROM registrations WHERE id = ?', [req.params.id]);
    if (!reg) return res.status(404).json({ success: false, error: 'Registration not found.' });

    const bank = await dbGet('SELECT id, credit, extracted_ref, is_non_registration FROM bank_statement_transactions WHERE id = ?', [bankTxnId]);
    if (!bank) return res.status(404).json({ success: false, error: 'Statement transaction not found.' });
    if (!(bank.credit > 0)) return res.status(400).json({ success: false, error: 'That statement row has no credit amount.' });
    if (bank.is_non_registration) {
      return res.status(400).json({ success: false, error: 'This transaction is marked as non-registration and cannot be linked to a payment.' });
    }

    // One credit can now back several payment_transactions -- see
    // allocatedForBankTxn(). `amount` lets the admin claim only part of a
    // credit for this delegate (splitting the rest to others); omitted, it
    // defaults to whatever's still unallocated, so attaching a wholly free
    // credit to one delegate (the common case) needs no extra input, exactly
    // as before.
    const { remaining } = await allocatedForBankTxn(bankTxnId);
    if (remaining <= 0) {
      return res.status(409).json({ success: false, error: 'That bank transaction is already fully allocated to other payments.' });
    }
    const amount = req.body.amount !== undefined ? Number(req.body.amount) : remaining;
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount.' });
    }
    if (amount > remaining + 0.5) {
      return res.status(409).json({ success: false, error: `Only ₹${inr(remaining)} of that bank transaction is still unallocated.` });
    }

    // No longer a hard block when this would push the registration's
    // cumulative acknowledged total past its fee due -- two genuine credits
    // legitimately belonging to one delegate can leave them overpaid, and
    // that's fine now; the excess is tracked for the refund feature (not yet
    // built) instead of being refused outright. Still noted in the audit
    // trail so it's visible without a UI yet. See the same change on the
    // regular link endpoint above.
    let overpayNote = '';
    if (reg.expected_amount > 0) {
      const summary = await getPaymentSummary(reg.id, reg.expected_amount);
      const wouldBeTotal = summary.verifiedTotal + amount;
      if (wouldBeTotal > reg.expected_amount + 0.5) {
        overpayNote = ` — ₹${inr(wouldBeTotal - reg.expected_amount)} over the ₹${inr(reg.expected_amount)} fee due (pending refund)`;
      }
    }

    const now = Date.now();
    const result = await dbRun(
      `INSERT INTO payment_transactions
        (registration_id, phone_number, amount, verified_amount, utr_number, payment_mode, txn_status, bank_txn_id, submitted_at, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, ?, ?, 'NEFT_RTGS', 'VERIFIED', ?, ?, ?, ?)`,
      [reg.id, reg.phone_number, amount, amount, bank.extracted_ref || null, bankTxnId, now, req.session.name || req.session.phone, now]
    );
    await recordAudit({
      req, entityType: 'registration', entityId: req.params.id,
      action: 'PAYMENT_ADMIN_ADDED', oldValue: null,
      newValue: `txn#${result.lastID} ← bank#${bankTxnId} (₹${inr(amount)} of ₹${inr(bank.credit)} credit added by admin, no prior claim)${overpayNote}`,
    });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ success: false, error: 'That bank transaction is already linked to another payment.' });
    }
    next(err);
  }
});

// Candidate statement credits for a brand-new admin-created registration --
// unlinked rows nearest to a target amount, same shape/reasoning as
// /api/payment-transactions/:txnId/candidates, but not anchored to an
// existing payment_transactions row (there isn't one yet: this is used
// while filling out the "Register Delegate" form, before the registration
// itself exists). ?amount= is the fee being registered for; omit it to sort
// by date instead.
app.get('/api/admin/bank-credit-candidates', requirePermission('payments.link'), async (req, res, next) => {
  try {
    const target = Number(req.query.amount) || 0;
    const raw = await dbAll(
      `SELECT * FROM bank_statement_transactions
        WHERE credit IS NOT NULL AND credit > 0 AND is_non_registration = 0
        ORDER BY ${target > 0 ? 'ABS(COALESCE(credit, 0) - ?) ASC, ' : ''}post_date DESC`,
      target > 0 ? [target] : []);
    const rows = [];
    for (const t of raw) {
      const { remaining } = await allocatedForBankTxn(t.id);
      if (remaining > 0) rows.push({ ...t, remaining });
      if (rows.length >= 50) break;
    }
    res.json({ transactions: rows });
  } catch (err) {
    next(err);
  }
});

// Register a delegate from the admin panel -- a walk-in at the desk, not the
// self-service phone+OTP flow. Creates the account (if it doesn't already
// exist) and the registration in one step, with the payment already
// resolved rather than left PENDING for a later Review: either CASH (the
// admin's own presence substitutes for the screenshot/OCR proof every other
// mode requires -- there is deliberately no self-service path to this mode)
// or BANK_TRANSFER, linking a credit the admin can already see in the
// imported statement (see /api/admin/bank-credit-candidates above), the
// same 1-to-1 link the Review modal uses, just made at creation time instead
// of after a PENDING submission.
//
// Reuses every piece of the delegate's own submission logic (resolveFee,
// resolveSelections, discount/group-discount resolution, assignUserRegNumber)
// rather than reimplementing it, so a walk-in registration is priced and
// validated identically to a self-service one -- same phase, same capacity
// limits, same discount rules.
app.post('/api/admin/registrations', requirePermission('payments.desk_register'), async (req, res, next) => {
  try {
    const phone = String(req.body.phone || '').trim();
    // Desk registrations stay Indian-only for now, same reasoning as
    // POST /api/users: the number becomes the account key here.
    if (!isIndianPhone(phone)) {
      return res.status(400).json({ success: false, error: 'Enter a valid 10-digit Indian mobile number.' });
    }
    const paymentMode = req.body.paymentMode;
    if (!['CASH', 'BANK_TRANSFER'].includes(paymentMode)) {
      return res.status(400).json({ success: false, error: 'Payment mode must be CASH or BANK_TRANSFER.' });
    }

    const existingUser = await dbGet('SELECT * FROM users WHERE phone_number = ?', [phone]);
    const existingReg = await dbGet('SELECT id FROM registrations WHERE phone_number = ?', [phone]);
    if (existingReg) {
      return res.status(409).json({ success: false, error: 'This delegate already has a registration.' });
    }
    const name = existingUser ? existingUser.full_name : String(req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, error: 'Full name is required.' });
    }
    // Every account carries an address -- see POST /api/auth/register. A
    // walk-in especially: this delegate is being confirmed on the spot, and
    // their receipt has nowhere to go without one. An existing account's
    // address is reused; only a brand-new one needs it typed in.
    const emailVal = existingUser && existingUser.email
      ? existingUser.email
      : String(req.body.email || '').trim();
    if (!emailVal) {
      return res.status(400).json({ success: false, error: 'An email address is required.' });
    }
    if (!isEmailValue(emailVal)) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }
    if (await emailTakenBy(emailVal, phone)) {
      return res.status(409).json({ success: false, error: 'Another account already uses that email address.' });
    }

    const feeInfo = await resolveFee(req.body.categoryKey);
    if (!feeInfo) {
      return res.status(400).json({ success: false, error: 'Invalid delegate category.' });
    }

    // Student ID: no upload here -- the admin is looking at the physical
    // card at the desk, so a checkbox stands in for the OCR check the
    // self-service form runs against an uploaded photo. Same gate as the
    // one PUT /api/registrations/:id/status already enforces before letting
    // any BANK_VERIFIED status through for a student category.
    const needsId = !!(await categoryRequiresStudentId(req.body.categoryKey));
    if (needsId && !req.body.idVerifiedByAdmin) {
      return res.status(400).json({ success: false, error: 'Confirm the student ID card before registering this category.' });
    }

    const resolved = await resolveSelections(req.body.optionIds, null);
    if (resolved.error) return res.status(400).json({ success: false, error: resolved.error });
    const selections = resolved.selections;
    const optionsFee = selections.reduce((sum, s) => sum + (Number(s.opt.fee) || 0), 0);

    // Same discount resolution as the self-service path: a promo code the
    // admin enters, or the delegate's group discount if they're already in a
    // qualifying group -- whichever is larger, they don't stack.
    let promoDiscount = 0, promoCode = null, promoCodeId = null;
    if (req.body.discountCode && String(req.body.discountCode).trim()) {
      const dv = await validateDiscountCode(req.body.discountCode, phone, req.body.categoryKey);
      if (!dv.ok) return res.status(400).json({ success: false, error: dv.error });
      promoDiscount = computeDiscountAmount(dv.code, feeInfo.amount);
      promoCode = dv.code.code;
      promoCodeId = dv.code.id;
    }
    let groupDiscount = 0;
    const dgroup = await getDelegateGroup(phone);
    if (dgroup && dgroup.qualifies && dgroup.group.category_key === req.body.categoryKey) {
      groupDiscount = computeDiscountAmount(dgroup.rule, feeInfo.amount);
    }
    let discountAmount = 0, discountCodeApplied = null;
    if (groupDiscount >= promoDiscount && groupDiscount > 0) {
      discountAmount = groupDiscount; discountCodeApplied = 'GROUP';
    } else if (promoDiscount > 0) {
      discountAmount = promoDiscount; discountCodeApplied = promoCode;
    }
    const expectedAmount = feeInfo.amount - discountAmount + optionsFee;

    // Resolve the payment itself before writing anything, so a bad bank
    // link can't leave a half-created registration behind.
    // BANK_TRANSFER has two variants: linked now (an unclaimed credit the
    // admin can already see in the imported statement, same as before) or
    // linked later (the delegate says they've paid but the transaction
    // hasn't shown up in the statement yet -- the registration still goes
    // through today, and the payment sits PENDING, exactly like a
    // self-service submission, until an admin reconciles it via the normal
    // Review flow once the statement catches up).
    const linkLater = paymentMode === 'BANK_TRANSFER' && !!req.body.linkLater;
    let bank = null;
    let paidAmount;
    let utrNumber = null;
    if (linkLater) {
      paidAmount = Number(req.body.amount);
      if (!Number.isFinite(paidAmount) || paidAmount <= 0) return res.status(400).json({ success: false, error: 'Enter a valid amount.' });
      utrNumber = req.body.utrNumber ? String(req.body.utrNumber).trim() : null;
    } else if (paymentMode === 'BANK_TRANSFER') {
      const bankTxnId = req.body.bankTxnId;
      if (!bankTxnId) return res.status(400).json({ success: false, error: 'Select the bank credit this delegate already paid.' });
      bank = await dbGet('SELECT * FROM bank_statement_transactions WHERE id = ?', [bankTxnId]);
      if (!bank || !(bank.credit > 0)) return res.status(400).json({ success: false, error: 'That statement row has no credit amount.' });
      if (bank.is_non_registration) return res.status(400).json({ success: false, error: 'This transaction is marked as non-registration.' });
      const { remaining } = await allocatedForBankTxn(bankTxnId);
      if (remaining <= 0) return res.status(409).json({ success: false, error: 'That bank transaction is already fully allocated.' });
      paidAmount = req.body.amount !== undefined ? Number(req.body.amount) : Math.min(remaining, expectedAmount);
      if (!Number.isFinite(paidAmount) || paidAmount <= 0) return res.status(400).json({ success: false, error: 'Enter a valid amount.' });
      if (paidAmount > remaining + 0.5) return res.status(409).json({ success: false, error: `Only ₹${inr(remaining)} of that bank transaction is still unallocated.` });
      utrNumber = bank.extracted_ref || null;
    } else {
      paidAmount = req.body.amount !== undefined ? Number(req.body.amount) : expectedAmount;
      if (expectedAmount > 0 && (!Number.isFinite(paidAmount) || paidAmount <= 0)) {
        return res.status(400).json({ success: false, error: 'Enter a valid cash amount.' });
      }
      paidAmount = Math.max(0, paidAmount || 0);
    }
    // Fully covers the fee -> confirmed outright, same as the self-service
    // free-registration path; short of it -> PARTIAL_PAYMENT, same meaning
    // it already has everywhere else (something verified, balance still due).
    // A deferred link is neither -- nothing is actually verified yet, so it
    // sits PENDING (the same status a self-service submission starts in)
    // regardless of how the claimed amount compares to the fee.
    const bankStatus = linkLater ? 'PENDING' : (paidAmount >= expectedAmount ? 'BANK_VERIFIED' : 'PARTIAL_PAYMENT');

    // Account: create it if this phone has never been seen before, including
    // a temporary password so the delegate can log in today without waiting
    // on an OTP -- they're expected to change it via Set Password. An
    // account that already exists but has no password gets one too, for the
    // same reason; one that already has a password is left untouched rather
    // than silently overwritten.
    let tempPassword = null;
    if (!existingUser) {
      tempPassword = generateTempPassword();
      await dbRun(
        `INSERT INTO users (phone_number, phone, phone_verified, full_name, email, designation, institution, role, password_hash, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        [phone, toE164(phone), name, normalizeEmail(emailVal), req.body.designation || null, req.body.institute || null, 'DELEGATE', hashPassword(tempPassword), Date.now()]
      );
    } else if (!existingUser.password_hash) {
      tempPassword = generateTempPassword();
      await dbRun('UPDATE users SET password_hash = ? WHERE phone_number = ?', [hashPassword(tempPassword), phone]);
    }

    const now = Date.now();
    const result = await dbRun(
      `INSERT INTO registrations
        (phone_number, delegate_name, category_key, category_label, expected_amount, paid_amount, utr_number,
         id_verified, id_verified_by, id_verified_at, bank_status, payment_mode, submitted_at,
         discount_code, discount_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [phone, name, req.body.categoryKey, feeInfo.label, expectedAmount, paidAmount, utrNumber,
       needsId ? 1 : 0, needsId ? (req.session.name || req.session.phone) : null, needsId ? now : null,
       bankStatus, paymentMode, now, discountCodeApplied, discountAmount]
    );
    const registrationId = result.lastID;
    await saveRegistrationSelections(registrationId, selections);

    const regNo = await assignUserRegNumber(phone);
    if (regNo) await dbRun('UPDATE registrations SET registration_number = ? WHERE phone_number = ?', [regNo, phone]);

    // Ledger row, same as every other payment path -- the Review modal's
    // per-transaction reconciliation and the Payments report both assume
    // every registration has one. A deferred link goes in PENDING with no
    // verified_amount/reviewer yet, same shape as a self-service submission's
    // first ledger row, so the existing Review modal can reconcile it later
    // exactly as it would for one of those.
    if (linkLater) {
      await dbRun(
        `INSERT INTO payment_transactions
          (registration_id, phone_number, amount, utr_number, payment_mode, txn_status, submitted_at)
         VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`,
        [registrationId, phone, paidAmount, utrNumber, paymentMode, now]
      );
      // In case a matching statement transaction was already imported under
      // this reference before this registration was created.
      await autoLinkTransactions();
    } else {
      await dbRun(
        `INSERT INTO payment_transactions
          (registration_id, phone_number, amount, verified_amount, utr_number, payment_mode, txn_status, bank_txn_id, submitted_at, reviewed_by, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'VERIFIED', ?, ?, ?, ?)`,
        [registrationId, phone, paidAmount, paidAmount, utrNumber, paymentMode,
         bank ? bank.id : null, now, req.session.name || req.session.phone, now]
      );
    }

    await recordAudit({
      req, entityType: 'registration', entityId: registrationId,
      action: 'ADMIN_REGISTERED',
      oldValue: null,
      newValue: `${name} (${phone}) — ${feeInfo.label}, ₹${inr(paidAmount)} via ${PAYMENT_MODE_LABELS[paymentMode]}${
        linkLater ? ' — pending bank-statement linkage'
        : bankStatus === 'PARTIAL_PAYMENT' ? ` (₹${inr(expectedAmount - paidAmount)} balance due)` : ''}`,
    });

    // No prior registration exists here (this endpoint refuses if one does),
    // so any promo code applied is inherently a first use -- unlike the
    // self-service path, there's no "resubmitting after rejection" case to
    // guard against re-logging.
    if (promoCodeId) {
      writeAuditRow('discount_code', promoCodeId, 'DISCOUNT_CODE_USED', null, `${promoCode} used by ${name} (${phone}), reg ${regNo}`, phone, name, 'DELEGATE').catch(() => {});
    }

    if (linkLater) {
      notifyDelegate(phone, 'Payment received — verification pending',
        emailWrap('We’ve received your payment details',
          `<p>Dear ${escapeHtml(name)},</p>
           <p>Your registration for the ${escapeHtml(CONFERENCE.name)} has been recorded and your payment is now <b>pending verification</b> by our team.</p>
           <p>Registration number: <b>${escapeHtml(regNo)}</b></p>
           <p>Your registration will be <b>confirmed once your payment is verified</b> against our bank statement — you’ll receive a confirmation email at that point.</p>`));
    } else {
      notifyDelegate(phone, 'Registration confirmed',
        emailWrap('Your registration is confirmed',
          `<p>Dear ${escapeHtml(name)},</p>
           <p>Your registration for the ${escapeHtml(CONFERENCE.name)} is <b>confirmed</b>.</p>
           <p>Registration number: <b>${escapeHtml(regNo)}</b></p>`));
    }

    res.json({ success: true, registrationId, registrationNumber: regNo, tempPassword, expectedAmount, paidAmount, bankStatus });
  } catch (err) {
    next(err);
  }
});

// Candidate statement debits for refunding one registration's excess --
// unlinked debit rows, nearest to the outstanding overpaid amount first.
// Same shape/reasoning as /api/payment-transactions/:txnId/candidates for
// credits, but 1-to-1 (see the UNIQUE index on payment_refunds.bank_txn_id)
// rather than split-capable, since a refund debit is one real transfer out.
app.get('/api/registrations/:id/refund-candidates', requirePermission('payments.refund'), async (req, res, next) => {
  try {
    const reg = await dbGet('SELECT id, expected_amount FROM registrations WHERE id = ?', [req.params.id]);
    if (!reg) return res.status(404).json({ success: false, error: 'Registration not found.' });
    const summary = await getPaymentSummary(reg.id, reg.expected_amount);
    const rows = await dbAll(
      `SELECT * FROM bank_statement_transactions
        WHERE debit IS NOT NULL AND debit > 0
          AND id NOT IN (SELECT bank_txn_id FROM payment_refunds WHERE bank_txn_id IS NOT NULL)
        ORDER BY ABS(COALESCE(debit, 0) - ?) ASC, post_date DESC
        LIMIT 50`,
      [summary.overpaid]);
    res.json({ transactions: rows, overpaid: summary.overpaid });
  } catch (err) {
    next(err);
  }
});

// Record that excess a delegate paid (see getPaymentSummary's overpaid) was
// sent back to them. Bookkeeping only -- this app has never moved money in
// either direction, it verifies bank statements; a row here means "we sent
// this back and it shows in the statement as an actual debit, and I'm
// recording it," not a trigger to transfer anything. A refund must now be
// backed by a real, unlinked debit row (bankTxnId) -- the same proof-via-
// statement requirement payments already have, applied to the outgoing
// side. Nets off verifiedTotal in getPaymentSummary going forward, so a
// refunded registration doesn't sit there looking permanently overpaid.
// Allows a partial refund (amount less than the full outstanding excess) --
// the rest stays recorded as still-outstanding excess for a later refund
// against a different debit row.
app.post('/api/registrations/:id/refund', requirePermission('payments.refund'), async (req, res, next) => {
  try {
    const reg = await dbGet('SELECT id, expected_amount FROM registrations WHERE id = ?', [req.params.id]);
    if (!reg) return res.status(404).json({ success: false, error: 'Registration not found.' });
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Enter a valid refund amount.' });
    }
    const bankTxnId = req.body.bankTxnId;
    if (!bankTxnId) {
      return res.status(400).json({ success: false, error: 'Select the debit transaction from the bank statement that this refund was paid out on.' });
    }
    const bank = await dbGet('SELECT id, debit FROM bank_statement_transactions WHERE id = ?', [bankTxnId]);
    if (!bank || !bank.debit || bank.debit <= 0) {
      return res.status(400).json({ success: false, error: 'That statement transaction is not a debit.' });
    }
    const alreadyLinked = await dbGet('SELECT id FROM payment_refunds WHERE bank_txn_id = ?', [bankTxnId]);
    if (alreadyLinked) {
      return res.status(409).json({ success: false, error: 'That debit transaction is already linked to another refund.' });
    }
    if (amount > bank.debit + 0.5) {
      return res.status(400).json({ success: false, error: `The refund amount can't exceed the debit's own amount (₹${inr(bank.debit)}).` });
    }
    const note = req.body.note ? String(req.body.note).trim().slice(0, 300) : null;

    const summary = await getPaymentSummary(reg.id, reg.expected_amount);
    if (amount > summary.overpaid + 0.5) {
      return res.status(400).json({
        success: false,
        error: `Only ₹${inr(summary.overpaid)} is currently outstanding as excess for this registration.`,
      });
    }

    const now = Date.now();
    let result;
    try {
      result = await dbRun(
        'INSERT INTO payment_refunds (registration_id, amount, reference_note, refunded_by, refunded_at, bank_txn_id) VALUES (?, ?, ?, ?, ?, ?)',
        [reg.id, amount, note, req.session.name || req.session.phone, now, bankTxnId]
      );
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT') {
        return res.status(409).json({ success: false, error: 'That debit transaction is already linked to another refund.' });
      }
      throw err;
    }
    await recordAudit({
      req, entityType: 'registration', entityId: req.params.id,
      action: 'PAYMENT_REFUNDED', oldValue: null,
      newValue: `refund#${result.lastID} ₹${inr(amount)} (debit#${bankTxnId})${note ? ` — ${note}` : ''}`,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Undo a refund record, e.g. it was logged in error or for the wrong amount.
app.delete('/api/registrations/:id/refund/:refundId', requirePermission('payments.refund'), async (req, res, next) => {
  try {
    const refund = await dbGet('SELECT id, amount, reference_note FROM payment_refunds WHERE id = ? AND registration_id = ?', [req.params.refundId, req.params.id]);
    if (!refund) return res.status(404).json({ success: false, error: 'Refund record not found.' });
    await dbRun('DELETE FROM payment_refunds WHERE id = ?', [refund.id]);
    await recordAudit({
      req, entityType: 'registration', entityId: req.params.id,
      action: 'PAYMENT_REFUND_DELETED', oldValue: `refund#${refund.id} ₹${inr(refund.amount)}${refund.reference_note ? ` — ${refund.reference_note}` : ''}`, newValue: null,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- CASH AT THE DESK -> BULK BANK DEPOSIT ------------------------------
// Cash taken at the desk (see POST /api/admin/registrations, mode CASH) is
// real money already in hand: it is VERIFIED the moment it's taken, and the
// admin's presence is the proof. What it ISN'T is banked -- it sits with no
// bank_txn_id, unaccounted for against the statement, until someone walks a
// day's takings to the bank as ONE deposit covering many registrations.
//
// That deposit arrives in the statement as a single credit, so the link is
// many payments -> one credit. payment_transactions.bank_txn_id already
// supports that (its index is deliberately plain, not UNIQUE -- see the
// migration above), and allocatedForBankTxn() already caps the total against
// the credit.
//
// Deliberately NOT reusing PUT /api/payment-transactions/:txnId/link: that
// endpoint overwrites verified_amount with min(amount, remaining), which is
// right for a bank payment (linking IS the acknowledgement, and you can only
// acknowledge what actually arrived) but wrong for cash. The delegate handed
// over their fee in full; if the admin later banks less than they collected,
// that discrepancy belongs to the cash handling, not to the delegate, and
// must not quietly reduce what a fully-paid delegate is recorded as having
// paid. Linking cash records WHERE it was banked and changes nothing else.
app.get('/api/admin/cash-in-hand', requirePermission('statement.cash_deposit'), async (req, res, next) => {
  try {
    const rows = await dbAll(`
      SELECT pt.id, pt.registration_id, pt.phone_number,
             COALESCE(pt.verified_amount, pt.amount) AS amount,
             pt.submitted_at, pt.reviewed_by,
             r.registration_number, r.delegate_name, r.category_label
        FROM payment_transactions pt
        LEFT JOIN registrations r ON r.id = pt.registration_id
       WHERE pt.payment_mode = 'CASH'
         AND pt.txn_status = 'VERIFIED'
         AND pt.bank_txn_id IS NULL
       ORDER BY pt.submitted_at ASC, pt.id ASC`);
    const total = rows.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    res.json({ transactions: rows, total, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// Link a batch of cash collections to the single bank credit they were
// deposited as. All-or-nothing: either every selected payment is attached to
// this deposit or none is, so a partially-applied batch can't leave the
// desk's books half-reconciled.
app.post('/api/admin/cash-deposit', requirePermission('statement.cash_deposit'), async (req, res, next) => {
  try {
    const bankTxnId = req.body.bankTxnId;
    const txnIds = Array.isArray(req.body.txnIds) ? req.body.txnIds.map(Number).filter(Number.isFinite) : [];
    if (!bankTxnId) return res.status(400).json({ success: false, error: 'Select the bank deposit to link these to.' });
    if (!txnIds.length) return res.status(400).json({ success: false, error: 'Select at least one cash collection.' });

    const bank = await dbGet('SELECT * FROM bank_statement_transactions WHERE id = ?', [bankTxnId]);
    if (!bank) return res.status(404).json({ success: false, error: 'Statement transaction not found.' });
    if (!(bank.credit > 0)) return res.status(400).json({ success: false, error: 'That statement row has no credit amount.' });
    if (bank.is_non_registration) {
      return res.status(400).json({ success: false, error: 'This transaction is marked as non-registration and cannot be linked.' });
    }

    // Every selected row must still be unbanked cash. Re-checked here rather
    // than trusted from the client, since the list could have been rendered
    // before another admin banked some of it.
    const placeholders = txnIds.map(() => '?').join(',');
    const rows = await dbAll(
      `SELECT id, COALESCE(verified_amount, amount) AS amount, payment_mode, txn_status, bank_txn_id
         FROM payment_transactions WHERE id IN (${placeholders})`, txnIds);
    if (rows.length !== txnIds.length) {
      return res.status(404).json({ success: false, error: 'One or more of those payments no longer exists.' });
    }
    const bad = rows.find((t) => t.payment_mode !== 'CASH' || t.txn_status !== 'VERIFIED' || t.bank_txn_id != null);
    if (bad) {
      return res.status(409).json({
        success: false,
        error: bad.bank_txn_id != null
          ? 'One of those cash collections has already been banked — reload and try again.'
          : 'Only verified cash collections can be added to a deposit.',
      });
    }

    // The deposit has to be big enough to hold what's being attributed to it.
    const selectedTotal = rows.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    const { remaining } = await allocatedForBankTxn(bankTxnId);
    if (selectedTotal > remaining + 0.5) {
      return res.status(409).json({
        success: false,
        error: `Those collections total ₹${inr(selectedTotal)}, but only ₹${inr(remaining)} of that deposit is still unallocated.`,
      });
    }

    await dbRun(
      `UPDATE payment_transactions SET bank_txn_id = ?
        WHERE id IN (${placeholders}) AND bank_txn_id IS NULL`,
      [bankTxnId, ...txnIds]);

    await recordAudit({
      req, entityType: 'bank_txn', entityId: String(bankTxnId),
      action: 'CASH_DEPOSIT_LINK', oldValue: null,
      newValue: `${rows.length} cash collection(s) totalling ₹${inr(selectedTotal)} banked as ${bank.post_date} deposit of ₹${inr(bank.credit)}`
        + (selectedTotal + 0.5 < bank.credit ? ` — ₹${inr(bank.credit - selectedTotal)} of the deposit still unaccounted` : ''),
    });
    res.json({ success: true, linked: rows.length, total: selectedTotal, depositRemaining: Math.max(0, remaining - selectedTotal) });
  } catch (err) {
    next(err);
  }
});

// Detach cash from a deposit -- back to unbanked, not un-verified. The money
// was still collected; only the claim about where it was banked is undone.
app.post('/api/admin/cash-deposit/unlink', requirePermission('statement.cash_deposit'), async (req, res, next) => {
  try {
    const txnIds = Array.isArray(req.body.txnIds) ? req.body.txnIds.map(Number).filter(Number.isFinite) : [];
    if (!txnIds.length) return res.status(400).json({ success: false, error: 'Select at least one cash collection.' });
    const placeholders = txnIds.map(() => '?').join(',');
    const rows = await dbAll(
      `SELECT id, bank_txn_id, COALESCE(verified_amount, amount) AS amount
         FROM payment_transactions WHERE id IN (${placeholders}) AND payment_mode = 'CASH'`, txnIds);
    if (!rows.length) return res.status(404).json({ success: false, error: 'No matching cash collections.' });

    await dbRun(
      `UPDATE payment_transactions SET bank_txn_id = NULL
        WHERE id IN (${placeholders}) AND payment_mode = 'CASH'`, txnIds);
    await recordAudit({
      req, entityType: 'bank_txn', entityId: String(rows[0].bank_txn_id || ''),
      action: 'CASH_DEPOSIT_UNLINK', oldValue: String(rows[0].bank_txn_id || ''),
      newValue: `${rows.length} cash collection(s) returned to unbanked (still verified)`,
    });
    res.json({ success: true, unlinked: rows.length });
  } catch (err) {
    next(err);
  }
});

// Unlink a payment transaction, which also un-acknowledges it (back to pending).
app.delete('/api/payment-transactions/:txnId/link', requirePermission('payments.link'), async (req, res, next) => {
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
app.get('/api/registrations/:id/audit', requirePermission('payments.view'), async (req, res, next) => {
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
// Re-read the roles from the database.
//
// Every permission check answers from an in-memory copy, so a role changed
// underneath the app -- by the editor in a later phase, or by hand during an
// incident -- takes effect when this is called. The editor will call it
// itself; it exists separately because "the database is right and the app is
// stale" is a real situation someone has to be able to fix without a restart.
app.post('/api/admin/roles/reload', requirePermission('users.manage_roles'), async (req, res, next) => {
  try {
    const loaded = await loadRoles();
    await recordAudit({
      req, entityType: 'role', entityId: 'all', action: 'ROLES_RELOADED',
      oldValue: null, newValue: `${loaded.size} role(s) re-read from the database`,
    });
    res.json({ success: true, roles: loaded.size });
  } catch (err) {
    next(err);
  }
});

// A role's key is its permanent identifier -- users.role stores it directly,
// and role_permissions keys off it -- so it is validated once, here, and
// never editable afterward. Uppercase with underscores, matching the shape
// of the five built-in roles, so a custom one reads the same way in a badge
// or a dropdown. DELEGATE is reserved: it is not a row in `roles` at all
// (see ADMIN_ROLES), and every role-changing endpoint treats it as its own
// special case, so a role actually named DELEGATE would collide with that.
const ROLE_KEY_RE = /^[A-Z][A-Z0-9_]{2,39}$/;
function validateRoleKey(key) {
  if (key === 'DELEGATE') return 'DELEGATE is reserved for the non-admin default and cannot be used as a role key.';
  if (!ROLE_KEY_RE.test(key)) return 'Role key must be 3-40 characters, uppercase letters, digits and underscores, starting with a letter.';
  return null;
}

// Every permission in the submitted set has to be one the catalogue actually
// defines -- silently dropping an unknown one would let a typo look like it
// took effect, and silently keeping it would let a retired permission linger
// forever in role_permissions with nothing left to mean.
function validateRolePermissions(list) {
  if (!Array.isArray(list)) return 'Permissions must be a list.';
  const bad = list.filter((p) => !PERMISSION_KEYS.includes(p));
  if (bad.length) return `Unknown permission(s): ${bad.join(', ')}`;
  return null;
}

// The full detail an editor needs: every role, what each holds, how many
// accounts currently hold it (so the UI can refuse to delete one in use
// without a round trip), and the catalogue itself -- sections and
// permissions, with their descriptions -- so the matrix has one source for
// both what exists and what each checkbox means.
app.get('/api/admin/roles', requirePermission('users.manage_roles'), async (req, res, next) => {
  try {
    const roles = await dbAll('SELECT key, label, description, is_system, grants_all FROM roles ORDER BY is_system DESC, label');
    const permRows = await dbAll('SELECT role_key, permission FROM role_permissions');
    const userCounts = await dbAll('SELECT role, COUNT(*) AS n FROM users GROUP BY role');
    const countByRole = new Map(userCounts.map((r) => [r.role, r.n]));
    const permsByRole = new Map();
    for (const r of permRows) {
      if (!permsByRole.has(r.role_key)) permsByRole.set(r.role_key, []);
      permsByRole.get(r.role_key).push(r.permission);
    }
    const shaped = roles.map((r) => ({
      key: r.key, label: r.label, description: r.description,
      isSystem: !!r.is_system, grantsAll: !!r.grants_all,
      permissions: r.grants_all ? PERMISSION_KEYS.slice() : (permsByRole.get(r.key) || []),
      userCount: countByRole.get(r.key) || 0,
    }));
    res.json({
      success: true, roles: shaped,
      catalogue: { sections: SECTIONS, permissions: PERMISSIONS },
    });
  } catch (err) {
    next(err);
  }
});

// The light version: key/label/isSystem only, for a role-assignment picker.
// Held by anyone who can assign a role (users.assign_role), not only someone
// who can redesign one (users.manage_roles) -- Operations has the former but
// not the latter, and still needs a role list to hand out.
app.get('/api/admin/roles/options', requirePermission('users.assign_role'), async (req, res, next) => {
  try {
    const roles = await dbAll('SELECT key, label, is_system FROM roles ORDER BY is_system DESC, label');
    res.json({ success: true, roles: roles.map((r) => ({ key: r.key, label: r.label, isSystem: !!r.is_system })) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/roles', requirePermission('users.manage_roles'), async (req, res, next) => {
  try {
    const key = String(req.body.key || '').trim().toUpperCase();
    const label = String(req.body.label || '').trim();
    const description = req.body.description != null ? String(req.body.description).trim() : null;
    const permissions = [...new Set(req.body.permissions || [])];

    const keyError = validateRoleKey(key);
    if (keyError) return res.status(400).json({ success: false, error: keyError });
    if (!label) return res.status(400).json({ success: false, error: 'A label is required.' });
    const permError = validateRolePermissions(permissions);
    if (permError) return res.status(400).json({ success: false, error: permError });

    const existing = await dbGet('SELECT key FROM roles WHERE key = ?', [key]);
    if (existing) return res.status(409).json({ success: false, error: `A role named ${key} already exists.` });

    const now = Date.now();
    await dbRun(
      `INSERT INTO roles (key, label, description, is_system, grants_all, event_id, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, NULL, ?, ?)`,
      [key, label, description, now, now]);
    for (const permission of permissions) {
      await dbRun('INSERT OR IGNORE INTO role_permissions (role_key, permission) VALUES (?, ?)', [key, permission]);
    }
    await loadRoles();

    await recordAudit({
      req, entityType: 'role', entityId: key, action: 'ROLE_CREATED',
      oldValue: null, newValue: `${label} — ${permissions.length} permission(s): ${permissions.join(', ')}`,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.put('/api/admin/roles/:key', requirePermission('users.manage_roles'), async (req, res, next) => {
  try {
    const key = req.params.key;
    const role = await dbGet('SELECT key, label, is_system, grants_all FROM roles WHERE key = ?', [key]);
    if (!role) return res.status(404).json({ success: false, error: 'Role not found.' });
    // Super Admin holds every permission by the grants_all flag, not by rows,
    // and is not up for negotiation -- it is the way back in when another
    // role is misconfigured, which only works if nothing can misconfigure IT.
    if (role.grants_all) {
      return res.status(403).json({ success: false, error: 'Super Admin cannot be edited.' });
    }

    const label = req.body.label != null ? String(req.body.label).trim() : role.label;
    const description = req.body.description != null ? String(req.body.description).trim() : null;
    const permissions = [...new Set(req.body.permissions || [])];
    if (!label) return res.status(400).json({ success: false, error: 'A label is required.' });
    const permError = validateRolePermissions(permissions);
    if (permError) return res.status(400).json({ success: false, error: permError });

    // The lock-out this exists to prevent: an admin editing the very role
    // they are logged in as, and removing their own ability to fix it back.
    // Every other role stays fully editable, including down to zero
    // permissions -- it's only the role the ACTOR currently holds, and only
    // this one permission, that is protected.
    if (req.session.role === key && !permissions.includes('users.manage_roles')) {
      return res.status(409).json({
        success: false,
        error: 'You cannot remove your own ability to manage roles. Have another Super Admin or role manager make this change instead.',
      });
    }

    const before = await dbAll('SELECT permission FROM role_permissions WHERE role_key = ?', [key]);
    const beforeSet = new Set(before.map((r) => r.permission));
    const added = permissions.filter((p) => !beforeSet.has(p));
    const removed = [...beforeSet].filter((p) => !permissions.includes(p));

    await dbRun('UPDATE roles SET label = ?, description = ?, updated_at = ? WHERE key = ?',
      [label, description, Date.now(), key]);
    await dbRun('DELETE FROM role_permissions WHERE role_key = ?', [key]);
    for (const permission of permissions) {
      await dbRun('INSERT OR IGNORE INTO role_permissions (role_key, permission) VALUES (?, ?)', [key, permission]);
    }
    await loadRoles();

    await recordAudit({
      req, entityType: 'role', entityId: key, action: 'ROLE_UPDATED',
      oldValue: `${role.label}`,
      newValue: `${label}` + (added.length ? ` — added: ${added.join(', ')}` : '')
        + (removed.length ? ` — removed: ${removed.join(', ')}` : ''),
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/admin/roles/:key', requirePermission('users.manage_roles'), async (req, res, next) => {
  try {
    const key = req.params.key;
    const role = await dbGet('SELECT key, label, is_system FROM roles WHERE key = ?', [key]);
    if (!role) return res.status(404).json({ success: false, error: 'Role not found.' });
    if (role.is_system) return res.status(403).json({ success: false, error: 'A built-in role cannot be deleted.' });

    const holders = await dbGet('SELECT COUNT(*) AS n FROM users WHERE role = ?', [key]);
    if (holders.n > 0) {
      return res.status(409).json({
        success: false,
        error: `${holders.n} user(s) still hold this role. Reassign them first.`,
      });
    }

    await dbRun('DELETE FROM role_permissions WHERE role_key = ?', [key]);
    await dbRun('DELETE FROM roles WHERE key = ?', [key]);
    await loadRoles();

    await recordAudit({
      req, entityType: 'role', entityId: key, action: 'ROLE_DELETED',
      oldValue: role.label, newValue: null,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.get('/api/users', requirePermission('users.view'), async (req, res, next) => {
  try {
    const rows = await dbAll(
      `SELECT users.*, r.id AS registration_id, r.bank_status AS registration_status
         FROM users
         LEFT JOIN registrations r ON r.phone_number = users.phone_number`);
    // One batched query for every registration's chosen options, rather than
    // one join per group -- works the same regardless of how many groups
    // exist. Grouped in JS by registration_id below.
    const selRows = await dbAll(
      `SELECT ro.registration_id, g.name AS group_name, o.name AS option_name
         FROM registration_options ro
         JOIN program_options o ON o.id = ro.option_id
         JOIN program_groups g ON g.id = ro.group_id
         ORDER BY g.sort_order, g.id, o.name`);
    const selByReg = new Map();
    for (const s of selRows) {
      if (!selByReg.has(s.registration_id)) selByReg.set(s.registration_id, []);
      selByReg.get(s.registration_id).push(`${s.group_name}: ${s.option_name}`);
    }
    const shaped = (rows || []).map((u) => ({
      ...u,
      program_selections: u.registration_id ? (selByReg.get(u.registration_id) || []) : [],
    }));
    res.json({ users: shaped.map(omitPasswordHash) });
  } catch (err) {
    next(err);
  }
});

// Full profile for the Users side-panel: demography, contact, registration +
// payment ledger, program-group enrollment, and a best-effort signup date.
app.get('/api/users/:phone/detail', requirePermission('users.view'), async (req, res, next) => {
  try {
    const phone = req.params.phone;
    const user = await dbGet('SELECT * FROM users WHERE phone_number = ?', [phone]);
    if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

    const reg = await dbGet('SELECT * FROM registrations WHERE phone_number = ?', [phone]);

    let payment = null;
    let selections = [];
    if (reg) {
      payment = await getPaymentSummary(reg.id, reg.expected_amount);
      selections = await fetchRegistrationSelections(reg.id);
    }

    res.json({
      success: true,
      user: omitPasswordHash(user),
      registration: reg || null,
      selections,
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
// Demographic edits (salutation, age, district, etc.) stay Super-Admin-only
// -- OPERATIONS gets user listing/detail, creating staff accounts, and role
// changes (see the routes below), but editing a delegate's personal details
// is a separate capability the "reports + user and role" request didn't ask
// for, so it's left narrower on purpose.
app.put('/api/users/:phone', requirePermission('users.edit'), async (req, res, next) => {
  try {
    const phone = req.params.phone;
    const existing = await dbGet('SELECT phone_number FROM users WHERE phone_number = ?', [phone]);
    if (!existing) return res.status(404).json({ success: false, error: 'User not found.' });

    const b = req.body || {};

    // Email needs the same treatment here as everywhere else it can be
    // written. Editing it from the admin panel used to be a plain column
    // write, which could both re-create the duplicate addresses this system
    // now refuses to resolve at login, AND leave email_verified = 1 against
    // an address nobody ever proved -- enough, since email became a login
    // channel, to send a sign-in code somewhere it doesn't belong.
    let emailChanged = false;
    if (Object.prototype.hasOwnProperty.call(b, 'email')) {
      const raw = String(b.email || '').trim();
      if (raw && !isEmailValue(raw)) {
        return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
      }
      if (raw && await emailTakenBy(raw, phone)) {
        return res.status(409).json({ success: false, error: 'Another account already uses that email address.' });
      }
      const current = await dbGet('SELECT email FROM users WHERE phone_number = ?', [phone]);
      emailChanged = normalizeEmail(current && current.email) !== normalizeEmail(raw);
      // Stored normalised, so the uniqueness check above can't be sidestepped
      // by case and LOWER(email) lookups keep matching.
      b.email = raw ? normalizeEmail(raw) : null;
    }

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
    // Back to unproven whenever the address actually changes: the delegate
    // verifies the new one themselves (the dashboard banner prompts them)
    // rather than inheriting the old address's verified standing.
    if (emailChanged) sets.push('email_verified = 0');
    if (!sets.length) return res.status(400).json({ success: false, error: 'Nothing to update.' });

    params.push(phone);
    await dbRun(`UPDATE users SET ${sets.join(', ')} WHERE phone_number = ?`, params);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/users', requirePermission('users.create'), async (req, res, next) => {
  try {
    const { name, phone, designation, institute, role, password } = req.body;
    // Staff accounts stay Indian-only: this creates an account whose key IS
    // the number, and whose holder is expected to be reachable by SMS.
    // International delegates arrive through signup (see Phase 2), not here.
    if (!phone || !isIndianPhone(phone)) {
      return res.status(400).json({ success: false, error: 'Enter a valid 10-digit Indian mobile number.' });
    }
    // Every account carries an address, however it was created -- see the
    // note in POST /api/auth/register. Recorded unverified: an admin typing
    // it in is not proof the person controls it, so they still verify it
    // themselves before it can receive a login code.
    const emailVal = String(req.body.email || '').trim();
    if (!emailVal) {
      return res.status(400).json({ success: false, error: 'An email address is required.' });
    }
    if (!isEmailValue(emailVal)) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }
    if (await emailTakenBy(emailVal, phone)) {
      return res.status(409).json({ success: false, error: 'Another account already uses that email address.' });
    }
    if (!isKnownAdminRole(role) && role !== 'DELEGATE') {
      return res.status(400).json({ success: false, error: 'Invalid role.' });
    }
    // OPERATIONS gets Users & Roles so it can manage staff accounts, but not
    // so it can hand out (or hand itself) the one role above it -- only an
    // existing SUPER_ADMIN can create another.
    if (role === 'SUPER_ADMIN' && req.session.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ success: false, error: 'Only a Super Admin can grant Super Admin.' });
    }
    if (password && String(password).length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
    }
    // Optional: gives the new staff member a password to log in with right
    // away instead of waiting on their first OTP. Purely a convenience --
    // they can set/change it themselves later via Set Password regardless.
    const passwordHash = password ? hashPassword(String(password)) : null;
    // phone_verified = 1: an admin creating this account is vouching for the
    // number in person, the same standing the desk-side "eyes on the
    // physical ID card" check already has. It also has to be 1 for the
    // account to be usable at all -- OTP login refuses unverified channels,
    // so a staff member created without a password would otherwise have no
    // way in whatsoever.
    await dbRun(
      `INSERT INTO users (phone_number, phone, phone_verified, full_name, email, designation, institution, role, password_hash, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      [phone, toE164(phone), name, normalizeEmail(emailVal), designation, institute, role, passwordHash, Date.now()]
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ success: false, error: 'A user with that phone number already exists.' });
    }
    next(err);
  }
});

app.put('/api/users/:phone/role', requirePermission('users.assign_role'), async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!isKnownAdminRole(role) && role !== 'DELEGATE') {
      return res.status(400).json({ success: false, error: 'Invalid role.' });
    }
    // Same escalation boundary as user creation: OPERATIONS can move anyone
    // between the other roles, but can't grant Super Admin, and can't touch
    // an existing Super Admin's role (grant OR demote) -- both directions
    // would otherwise let OPERATIONS tamper with the role above it.
    if (req.session.role !== 'SUPER_ADMIN') {
      if (role === 'SUPER_ADMIN') {
        return res.status(403).json({ success: false, error: 'Only a Super Admin can grant Super Admin.' });
      }
      const target = await dbGet('SELECT role FROM users WHERE phone_number = ?', [req.params.phone]);
      if (target && target.role === 'SUPER_ADMIN') {
        return res.status(403).json({ success: false, error: 'Only a Super Admin can change another Super Admin\'s role.' });
      }
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

app.get('/api/admin/reminders/pending-signups', requirePermission('comms.reminders_view'), async (req, res, next) => {
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
app.post('/api/admin/reminders/test-send', requirePermission('comms.reminders_test'), async (req, res, next) => {
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
app.post('/api/admin/reminders/send', requirePermission('comms.reminders_send'), async (req, res, next) => {
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

// Same shape as the pending-signup reminders above, for the other worklist
// that benefits from a nudge: PARTIAL_PAYMENT registrations, where the admin
// has revised the payment after a fee change and the delegate owes a
// balance (see isBalanceDue() client-side / the Awaiting Balance Payment
// section). registrations.phone_number is not aliased here because
// DELEGATE_SALUTATION_COLUMN's subquery hardcodes that table name.
const BALANCE_DUE_QUERY =
  `SELECT registrations.id, registrations.phone_number, registrations.registration_number, delegate_name, ${DELEGATE_SALUTATION_COLUMN},
     category_label, expected_amount, u.email,
     (SELECT MAX(created_at) FROM audit_log a
        WHERE a.entity_type = 'reminder_email' AND a.action = 'BALANCE_DUE_REMINDER_SENT' AND a.entity_id = registrations.phone_number
     ) AS last_reminder_sent_at
     FROM registrations
     LEFT JOIN users u ON u.phone_number = registrations.phone_number
     WHERE registrations.bank_status = 'PARTIAL_PAYMENT'
     ORDER BY delegate_name`;

app.get('/api/admin/reminders/balance-due', requirePermission('comms.reminders_view'), async (req, res, next) => {
  try {
    const regs = (await dbAll(BALANCE_DUE_QUERY)).map(withDelegateSalutation);
    const rows = [];
    for (const r of regs) {
      const summary = await getPaymentSummary(r.id, r.expected_amount);
      rows.push({ ...r, paid: summary.verifiedTotal, remaining: summary.remaining });
    }
    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

// {{name}} -> "Salutation Full Name", {{amount}} -> the caller's own last
// PARTIAL_PAYMENT balance if they have one (else ₹0, just so the preview
// shows something plausible rather than a literal placeholder).
app.post('/api/admin/reminders/balance-due/test-send', requirePermission('comms.reminders_test'), async (req, res, next) => {
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

    const myReg = await dbGet(
      `SELECT id, expected_amount FROM registrations WHERE phone_number = ? AND bank_status = 'PARTIAL_PAYMENT'`,
      [req.session.phone]);
    const remaining = myReg ? (await getPaymentSummary(myReg.id, myReg.expected_amount)).remaining : 0;

    const name = [me.salutation, me.full_name].filter(Boolean).join(' ') || 'Delegate';
    const personalizedBody = String(bodyHtml).split('{{name}}').join(escapeHtml(name)).split('{{amount}}').join(`₹${inr(remaining)}`);
    await sendEmail(me.email, `[TEST] ${subject}`, emailWrap(subject, personalizedBody));

    res.json({ success: true, sentTo: me.email });
  } catch (err) {
    next(err);
  }
});

// Deliberately SUPER_ADMIN only, same reasoning as /reminders/send: a
// one-way bulk email blast to real delegates, nothing to undo if wrong.
app.post('/api/admin/reminders/balance-due/send', requirePermission('comms.reminders_send'), async (req, res, next) => {
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
    if (!Array.isArray(phones) || !phones.length) {
      return res.status(400).json({ success: false, error: 'Select at least one delegate to send to.' });
    }
    const phoneSet = new Set(phones.map(String));

    // Same rolling 24h dedupe as the registration reminders, keyed to this
    // reminder's own action name so the two reminder types never suppress
    // each other.
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const sentRecentlyRows = await dbAll(
      `SELECT DISTINCT entity_id FROM audit_log
        WHERE entity_type = 'reminder_email' AND action = 'BALANCE_DUE_REMINDER_SENT' AND created_at >= ?`,
      [since]
    );
    const sentRecentlySet = new Set(sentRecentlyRows.map((r) => r.entity_id));

    const regs = (await dbAll(BALANCE_DUE_QUERY)).map(withDelegateSalutation).filter((r) => phoneSet.has(r.phone_number));
    let sent = 0;
    let skippedNoEmail = 0;
    let skippedSentRecently = 0;
    for (const r of regs) {
      if (sentRecentlySet.has(r.phone_number)) { skippedSentRecently++; continue; }
      if (!r.email) { skippedNoEmail++; continue; }
      const summary = await getPaymentSummary(r.id, r.expected_amount);
      // r.delegate_name already has its salutation folded in by
      // withDelegateSalutation() above, unlike PENDING_SIGNUP_QUERY's
      // separate salutation/full_name fields.
      const name = r.delegate_name || 'Delegate';
      const personalizedBody = String(bodyHtml).split('{{name}}').join(escapeHtml(name)).split('{{amount}}').join(`₹${inr(summary.remaining)}`);
      await sendEmail(r.email, subject, emailWrap(subject, personalizedBody));
      await recordAudit({
        req, entityType: 'reminder_email', entityId: r.phone_number,
        action: 'BALANCE_DUE_REMINDER_SENT', oldValue: null, newValue: `${subject} (₹${inr(summary.remaining)} due)`,
      });
      sent++;
    }

    res.json({ success: true, sent, skippedNoEmail, skippedSentRecently, total: regs.length });
  } catch (err) {
    next(err);
  }
});

// Send a reminder to an admin-supplied list of raw email addresses, not tied
// to any existing account -- for reaching people who haven't signed up yet
// at all (e.g. an external mailing list, "early bird ends today"), which the
// two reminder tools above can't do since they only ever address existing
// users/registrations. No {{name}}/{{amount}} substitution: there's no
// record behind these addresses to personalize from. Deliberately
// SUPER_ADMIN only and rolling-24h-deduped per address, same reasoning as
// the other two: a one-way bulk blast, nothing to undo if wrong.
app.post('/api/admin/reminders/custom-send', requirePermission('comms.custom_send'), async (req, res, next) => {
  try {
    const { subject, bodyHtml, emails } = req.body;
    if (!subject || !String(subject).trim()) {
      return res.status(400).json({ success: false, error: 'Subject is required.' });
    }
    if (!bodyHtml || !String(bodyHtml).trim()) {
      return res.status(400).json({ success: false, error: 'Email body is required.' });
    }
    if (!emailEnabled()) {
      return res.status(400).json({ success: false, error: 'Email is not configured on this server.' });
    }
    if (!Array.isArray(emails) || !emails.length) {
      return res.status(400).json({ success: false, error: 'Enter at least one email address.' });
    }

    // Dedupe (case-insensitive) and split valid-looking addresses from junk,
    // rather than hard-failing the whole pasted list over one typo.
    const seen = new Set();
    const valid = [];
    let skippedInvalid = 0;
    for (const raw of emails) {
      const addr = String(raw || '').trim();
      if (!addr) continue;
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (EMAIL_RE.test(addr)) valid.push(addr); else skippedInvalid++;
    }
    if (!valid.length) {
      return res.status(400).json({ success: false, error: 'None of the entered addresses look valid.' });
    }

    // The 24h cooldown is PER ANNOUNCEMENT, not per address: it exists to stop
    // the same message going out twice to someone, not to stop a person
    // hearing two different things in one day. Scoping it to the address alone
    // meant an "early bird extended" notice was silently dropped for everyone
    // who had been sent "early bird ends today" the day before -- exactly the
    // people who most needed the correction.
    //
    // The subject is the identity of the announcement here: it is what the
    // audit trail records, and the templates put the deadline in it, so a
    // genuinely different message is a genuinely different subject. Matched
    // case-insensitively and trimmed, since that is how it is deduped
    // elsewhere.
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const sentRecentlyRows = await dbAll(
      `SELECT DISTINCT entity_id FROM audit_log
        WHERE entity_type = 'reminder_email' AND action = 'CUSTOM_REMINDER_SENT' AND created_at >= ?
          AND LOWER(TRIM(COALESCE(new_value, ''))) = ?`,
      [since, String(subject).trim().toLowerCase()]
    );
    const sentRecentlySet = new Set(sentRecentlyRows.map((r) => (r.entity_id || '').toLowerCase()));

    let sent = 0;
    let skippedSentRecently = 0;
    for (const addr of valid) {
      if (sentRecentlySet.has(addr.toLowerCase())) { skippedSentRecently++; continue; }
      await sendEmail(addr, subject, emailWrap(subject, bodyHtml));
      await recordAudit({
        req, entityType: 'reminder_email', entityId: addr,
        action: 'CUSTOM_REMINDER_SENT', oldValue: null, newValue: subject,
      });
      sent++;
    }

    res.json({ success: true, sent, skippedInvalid, skippedSentRecently, total: emails.length });
  } catch (err) {
    next(err);
  }
});

// --- BACKUPS (admin-triggered) --------------------------------------------
//
// The app does NOT take the backup itself, and deliberately cannot: the
// Google Drive credential is kept out of this long-running, internet-facing
// container (see scripts/backup.sh), and handing this process the Docker
// socket to work around that would be strictly worse than the problem.
//
// So "Back up now" is a request, not an action. This writes a small file into
// the data volume; a cron entry runs `backup.sh --if-requested` every few
// minutes, sees it, takes a real backup and writes back a status file. The
// credential stays where it is and the button costs a few minutes of latency.
//
// The handshake files sit beside the database, wherever that actually is.
// Resolved by following conference.db's own symlink rather than testing for
// /data: inside the container that resolves to the mounted volume (which is
// what the backup script reads), and outside one it resolves to the working
// copy. Testing for a /data directory would have been wrong on this host,
// which has an unrelated /data of its own.
const BACKUP_DIR = DATA_DIR;
const BACKUP_REQUEST_FILE = path.join(BACKUP_DIR, '.backup-request.json');
const BACKUP_STATUS_FILE = path.join(BACKUP_DIR, '.backup-status.json');
const DRIVE_LINK_FILE = path.join(BACKUP_DIR, '.drive-link-request.json');
const DRIVE_CHECK_FILE = path.join(BACKUP_DIR, '.drive-check-request.json');
const DRIVE_STATUS_FILE = path.join(BACKUP_DIR, '.drive-status.json');

const readJsonFile = async (file) => {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return null; }
};

app.get('/api/admin/backup/status', requirePermission('system.backups'), async (req, res, next) => {
  try {
    const [request, last, drive, linkPending, checkPending] = await Promise.all([
      readJsonFile(BACKUP_REQUEST_FILE), readJsonFile(BACKUP_STATUS_FILE),
      readJsonFile(DRIVE_STATUS_FILE), readJsonFile(DRIVE_LINK_FILE), readJsonFile(DRIVE_CHECK_FILE),
    ]);
    res.json({
      success: true,
      pending: !!request, request, last,
      // The Drive picture is written by the backup script, which is the only
      // thing here that holds the credential. Never includes the token.
      drive, drivePending: !!linkPending || !!checkPending,
      // What the Connect button needs to know: whether an OAuth client is
      // configured, and the redirect URI to register against it.
      driveOauth: {
        configured: driveOauthConfigured(),
        clientId: process.env.DRIVE_CLIENT_ID || '',   // not a secret
        redirectUri: driveRedirectUri(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// Link (or re-link) Google Drive from the panel.
//
// The token is obtained by the admin running `rclone authorize "drive"` on any
// machine with a browser and pasting the result here. It is handed to the
// backup script through the data volume and wiped as that script consumes it,
// so the credential is never stored anywhere this container can read at rest
// -- the same reason the app cannot take a backup itself.
app.post('/api/admin/backup/drive-link', requirePermission('system.backups'), async (req, res, next) => {
  try {
    const token = String(req.body.token || '').trim();
    if (!token) return res.status(400).json({ success: false, error: 'Paste the token from rclone authorize.' });

    // rclone prints the token between marker lines:
    //
    //   Paste the following into your remote machine --->
    //   {"access_token":"...","refresh_token":"...","expiry":"..."}
    //   <---End paste
    //
    // Anyone copying what they see will bring those markers along, so the
    // object is lifted out of whatever was pasted rather than demanding
    // exactly the JSON. Checking the shape at all turns "the backup quietly
    // stopped working" into an error the admin sees while the output is still
    // on their screen.
    let parsed = null;
    const firstBrace = token.indexOf('{');
    const lastBrace = token.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try { parsed = JSON.parse(token.slice(firstBrace, lastBrace + 1)); } catch { parsed = null; }
    }
    if (!parsed) {
      return res.status(400).json({ success: false, error: 'No token found in that. Paste everything rclone printed, including the {"access_token":...} line.' });
    }
    if (!parsed || typeof parsed !== 'object' || (!parsed.access_token && !parsed.refresh_token)) {
      return res.status(400).json({ success: false, error: 'That JSON has no access_token or refresh_token in it.' });
    }

    const folder = String(req.body.folder || '').trim();
    if (folder && /["'\\]/.test(folder)) {
      return res.status(400).json({ success: false, error: 'The folder name cannot contain quotes or backslashes.' });
    }
    const clientId = String(req.body.clientId || '').trim();
    const clientSecret = String(req.body.clientSecret || '').trim();
    if (/["'\\]/.test(clientId) || /["'\\]/.test(clientSecret)) {
      return res.status(400).json({ success: false, error: 'The client ID and secret cannot contain quotes or backslashes.' });
    }

    await fs.promises.writeFile(DRIVE_LINK_FILE, JSON.stringify({
      token: JSON.stringify(parsed), clientId, clientSecret, folder,
      requestedAt: Date.now(), requestedBy: req.session.name || req.session.phone || 'admin',
    }), { encoding: 'utf8', mode: 0o600 });

    // The token itself is deliberately absent from the audit trail.
    await recordAudit({
      req, entityType: 'backup', entityId: 'google-drive', action: 'DRIVE_LINK_SUBMITTED',
      oldValue: null, newValue: folder ? `Folder: ${folder}` : 'Google Drive link submitted',
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- GOOGLE DRIVE OAUTH (the "Connect" button) -----------------------------
//
// Why the app does the OAuth itself rather than driving `rclone authorize`:
// rclone's redirect URI is hardcoded to http://127.0.0.1:53682/, a loopback
// address. Google always sends the browser back to whatever machine the
// browser is on, so an admin clicking a button here would have their consent
// redirected to their own laptop, where nothing is listening. Running rclone
// on the server cannot receive that. The only way to finish the flow in a
// remote browser is to own the redirect URI, which means our own OAuth client.
//
// The client secret is not itself a Drive credential -- it is useless without
// a user completing consent -- so it lives in .env like the other secrets.
// The refresh token that IS a credential still goes straight to the backup
// script and is never stored here.
const driveOauthConfigured = () => !!process.env.DRIVE_CLIENT_ID && !!process.env.DRIVE_CLIENT_SECRET;
const driveRedirectUri = () => `${String(PORTAL_URL || '').replace(/\/+$/, '')}/api/admin/backup/drive-callback`;

// Exchange an authorization code for tokens. Uses the node-fetch already in
// this file rather than global fetch, so it behaves the same on the Node 16 a
// test instance may run and the Node 24 in the image.
async function driveExchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.DRIVE_CLIENT_ID,
      client_secret: process.env.DRIVE_CLIENT_SECRET,
      redirect_uri: driveRedirectUri(),
      grant_type: 'authorization_code',
    }).toString(),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* handled below */ }
  if (!res.ok || !parsed) {
    throw new Error((parsed && (parsed.error_description || parsed.error)) || `Google returned ${res.status}`);
  }
  return parsed;
}

// Save the OAuth client. Kept out of the database with the other secrets.
app.post('/api/admin/backup/drive-oauth/config', requirePermission('system.backups'), async (req, res, next) => {
  try {
    const clientId = String(req.body.clientId || '').trim();
    const clientSecret = String(req.body.clientSecret || '').trim();
    if (!clientId || !clientSecret) {
      return res.status(400).json({ success: false, error: 'Both the client ID and the client secret are needed.' });
    }
    if (/[\r\n]/.test(clientId) || /[\r\n]/.test(clientSecret)) {
      return res.status(400).json({ success: false, error: 'Those values cannot contain line breaks.' });
    }
    writeEnvVar('DRIVE_CLIENT_ID', clientId);
    writeEnvVar('DRIVE_CLIENT_SECRET', clientSecret);
    await recordAudit({
      req, entityType: 'backup', entityId: 'google-drive', action: 'DRIVE_OAUTH_CLIENT_SET',
      oldValue: null, newValue: `Client ID ${clientId.slice(0, 12)}…`,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Send the admin to Google. A browser navigation, not a fetch, so the session
// cookie rides along and the callback can tell it is the same person.
app.get('/api/admin/backup/drive-oauth/start', requirePermission('system.backups'), (req, res) => {
  if (!driveOauthConfigured()) {
    return res.status(400).send(driveResultPage('Google Drive is not set up yet', 'Add the OAuth client ID and secret in Settings first.', false));
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.driveOauthState = state;
  const url = 'https://accounts.google.com/o/oauth2/auth?' + new URLSearchParams({
    client_id: process.env.DRIVE_CLIENT_ID,
    redirect_uri: driveRedirectUri(),
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive',
    // offline + consent so Google always returns a refresh token; without it a
    // second authorisation of the same account returns none, and rclone cannot
    // renew access once the first hour is up.
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString();
  res.redirect(url);
});

// A plain page, because this is a browser landing rather than an API call.
function driveResultPage(title, detail, ok) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f1f5f9;margin:0;padding:3rem 1rem;color:#0f172a">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:2rem;text-align:center">
    <div style="font-size:2.5rem">${ok ? '✅' : '⚠️'}</div>
    <h1 style="font-size:1.15rem;margin:.75rem 0 .5rem">${escapeHtml(title)}</h1>
    <p style="font-size:.9rem;color:#475569;line-height:1.6;margin:0 0 1.5rem">${escapeHtml(detail)}</p>
    <a href="/admin#general" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-weight:700;font-size:.85rem;padding:.7rem 1.4rem;border-radius:10px">Back to Settings</a>
  </div>
</body></html>`;
}

// Google returns the admin here as a top-level GET from accounts.google.com.
// That is cross-site, so this route only sees the session because the cookie
// is sameSite:'lax' -- lax sends cookies on top-level navigations. Tightening
// that to 'strict' would make this 403 with no obvious cause.
app.get('/api/admin/backup/drive-callback', requirePermission('system.backups'), async (req, res, next) => {
  try {
    if (req.query.error) {
      return res.status(400).send(driveResultPage('Google Drive was not connected',
        `Google reported: ${req.query.error}. Nothing has changed.`, false));
    }
    const state = req.session.driveOauthState;
    delete req.session.driveOauthState;
    if (!state || state !== String(req.query.state || '')) {
      return res.status(400).send(driveResultPage('That link has expired',
        'Start again from Settings so the request can be matched to your session.', false));
    }
    const code = String(req.query.code || '');
    if (!code) return res.status(400).send(driveResultPage('Google sent no authorisation code', 'Nothing has changed. Try again from Settings.', false));

    const tok = await driveExchangeCode(code);
    if (!tok.refresh_token) {
      return res.status(400).send(driveResultPage('Google did not return a refresh token',
        'Backups need one to keep working after the first hour. Remove this app from your Google account permissions and connect again.', false));
    }

    // The shape rclone stores. expiry is RFC3339, which is what Go parses.
    const token = {
      access_token: tok.access_token,
      token_type: tok.token_type || 'Bearer',
      refresh_token: tok.refresh_token,
      expiry: new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000).toISOString(),
    };
    await fs.promises.writeFile(DRIVE_LINK_FILE, JSON.stringify({
      token: JSON.stringify(token),
      clientId: process.env.DRIVE_CLIENT_ID,
      clientSecret: process.env.DRIVE_CLIENT_SECRET,
      folder: '',
      requestedAt: Date.now(),
      requestedBy: req.session.name || req.session.phone || 'admin',
    }), { encoding: 'utf8', mode: 0o600 });

    await recordAudit({
      req, entityType: 'backup', entityId: 'google-drive', action: 'DRIVE_LINK_SUBMITTED',
      oldValue: null, newValue: 'Connected through Google sign-in',
    });
    res.send(driveResultPage('Google Drive connected',
      'The backup job will apply and test it within a few minutes. Settings will then show which account it is using.', true));
  } catch (err) {
    // Never leak the exchange error verbatim into a page; log it and say enough.
    console.error('Drive OAuth exchange failed:', err.message);
    res.status(400).send(driveResultPage('Could not complete the connection', err.message, false));
  }
});

// Ask the backup script to test the link and report back.
app.post('/api/admin/backup/drive-check', requirePermission('system.backups'), async (req, res, next) => {
  try {
    await fs.promises.writeFile(DRIVE_CHECK_FILE, JSON.stringify({ requestedAt: Date.now() }), 'utf8');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/backup/request', requirePermission('system.backups'), async (req, res, next) => {
  try {
    // A second request while one is queued would just be the same backup, so
    // say so rather than letting an impatient click look like it did nothing.
    const existing = await readJsonFile(BACKUP_REQUEST_FILE);
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'A backup is already queued and will start within a few minutes.',
        request: existing,
      });
    }
    const request = {
      requestedAt: Date.now(),
      requestedBy: req.session.name || req.session.phone || 'admin',
    };
    await fs.promises.writeFile(BACKUP_REQUEST_FILE, JSON.stringify(request), 'utf8');
    await recordAudit({
      req, entityType: 'backup', entityId: String(request.requestedAt),
      action: 'BACKUP_REQUESTED', oldValue: null, newValue: 'Manual backup requested from Settings',
    });
    res.json({ success: true, request });
  } catch (err) {
    next(err);
  }
});

// --- PROGRAM GROUPS ADMIN (Workshops, QI Practices, or any further group) --

function validGroupInput({ name, required, maxSelect }, { partial } = {}) {
  if (!partial || name !== undefined) {
    if (!name || !String(name).trim()) return 'Group name is required.';
  }
  if (maxSelect !== undefined) {
    if (!Number.isInteger(maxSelect) || maxSelect < 1) return 'Max selections must be a positive integer.';
  }
  return null;
}

app.get('/api/admin/program-groups', requirePermission('masters.programs_view'), async (req, res, next) => {
  try {
    res.json({ groups: await fetchProgramGroups({ activeOnly: false }) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/program-groups', requirePermission('masters.programs_manage'), async (req, res, next) => {
  try {
    const { name, description, required, maxSelect, sortOrder } = req.body;
    const bad = validGroupInput({ name, maxSelect: maxSelect !== undefined ? Number(maxSelect) : 1 });
    if (bad) return res.status(400).json({ success: false, error: bad });
    const result = await dbRun(
      'INSERT INTO program_groups (name, description, required, max_select, sort_order, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      [String(name).trim(), description ? String(description).trim() : null, required ? 1 : 0, maxSelect !== undefined ? Number(maxSelect) : 1, Number(sortOrder) || 0, Date.now()]
    );
    await recordAudit({
      req, entityType: 'program_group', entityId: result.lastID,
      action: 'PROGRAM_GROUP_CREATE', oldValue: null, newValue: String(name).trim(),
    });
    res.json({ success: true, id: result.lastID });
  } catch (err) {
    next(err);
  }
});

app.put('/api/admin/program-groups/:id', requirePermission('masters.programs_manage'), async (req, res, next) => {
  try {
    const { name, description, required, maxSelect, sortOrder, active } = req.body;
    const bad = validGroupInput({ name, maxSelect: maxSelect !== undefined ? Number(maxSelect) : undefined }, { partial: true });
    if (bad) return res.status(400).json({ success: false, error: bad });

    const existing = await dbGet('SELECT * FROM program_groups WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Group not found.' });

    const updated = {
      name: name !== undefined ? String(name).trim() : existing.name,
      description: description !== undefined ? (description ? String(description).trim() : null) : existing.description,
      required: required !== undefined ? (required ? 1 : 0) : existing.required,
      max_select: maxSelect !== undefined ? Number(maxSelect) : existing.max_select,
      sort_order: sortOrder !== undefined ? Number(sortOrder) : existing.sort_order,
      active: active !== undefined ? (active ? 1 : 0) : existing.active,
    };
    await dbRun(
      'UPDATE program_groups SET name = ?, description = ?, required = ?, max_select = ?, sort_order = ?, active = ? WHERE id = ?',
      [updated.name, updated.description, updated.required, updated.max_select, updated.sort_order, updated.active, req.params.id]
    );
    await recordAudit({
      req, entityType: 'program_group', entityId: req.params.id,
      action: 'PROGRAM_GROUP_UPDATE', oldValue: existing.name, newValue: updated.name,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Delete a group, but only if it has no options left in it (remove those
// first -- each option's own delete is already refused while anyone is
// enrolled, so this transitively can't orphan a delegate's selection).
app.delete('/api/admin/program-groups/:id', requirePermission('masters.programs_manage'), async (req, res, next) => {
  try {
    const group = await dbGet('SELECT * FROM program_groups WHERE id = ?', [req.params.id]);
    if (!group) return res.status(404).json({ success: false, error: 'Group not found.' });
    const { n } = await dbGet('SELECT COUNT(*) AS n FROM program_options WHERE group_id = ?', [req.params.id]);
    if (n > 0) return res.status(409).json({ success: false, error: `This group still has ${n} option(s) in it. Remove them first.` });
    await dbRun('DELETE FROM program_groups WHERE id = ?', [req.params.id]);
    await recordAudit({
      req, entityType: 'program_group', entityId: req.params.id,
      action: 'PROGRAM_GROUP_DELETE', oldValue: group.name, newValue: null,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- PROGRAM OPTIONS ADMIN (options within a group) ----------------------

function validProgramInput({ groupId, name, capacity, fee }, { partial } = {}) {
  if (!partial || groupId !== undefined) {
    if (!Number.isInteger(groupId)) return 'A program group is required.';
  }
  if (!partial || name !== undefined) {
    if (!name || !String(name).trim()) return 'Name is required.';
  }
  if (!partial || capacity !== undefined) {
    if (!Number.isInteger(capacity) || capacity < 0) return 'Capacity must be a non-negative integer.';
  }
  if (fee !== undefined) {
    if (!Number.isFinite(fee) || fee < 0) return 'Fee must be a non-negative amount.';
  }
  return null;
}

// List every option (active or not) with enrollment counts.
app.get('/api/admin/program-options', requirePermission('masters.programs_view'), async (req, res, next) => {
  try {
    res.json({ options: await fetchProgramOptions({ activeOnly: false }) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/program-options', requirePermission('masters.programs_manage'), async (req, res, next) => {
  try {
    const groupId = Number(req.body.groupId);
    const { name, capacity } = req.body;
    const fee = req.body.fee !== undefined ? Number(req.body.fee) : 0;
    const bad = validProgramInput({ groupId, name, capacity, fee });
    if (bad) return res.status(400).json({ success: false, error: bad });
    const group = await dbGet('SELECT id, name FROM program_groups WHERE id = ?', [groupId]);
    if (!group) return res.status(400).json({ success: false, error: 'Program group not found.' });
    // `type` is legacy (see program_options table comment) -- kept NOT NULL
    // for old rows' sake, so new rows just carry the group name into it;
    // nothing reads it going forward.
    const result = await dbRun(
      'INSERT INTO program_options (type, group_id, name, capacity, fee, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      [group.name, groupId, String(name).trim(), capacity, fee, Date.now()]
    );
    await recordAudit({
      req, entityType: 'program_option', entityId: result.lastID,
      action: 'PROGRAM_OPTION_CREATE', oldValue: null, newValue: `${group.name}: ${String(name).trim()} (capacity ${capacity}, fee ₹${fee})`,
    });
    res.json({ success: true, id: result.lastID });
  } catch (err) {
    next(err);
  }
});

app.put('/api/admin/program-options/:id', requirePermission('masters.programs_manage'), async (req, res, next) => {
  try {
    const { name, capacity, active } = req.body;
    const fee = req.body.fee !== undefined ? Number(req.body.fee) : undefined;
    const bad = validProgramInput({ name, capacity, fee }, { partial: true });
    if (bad) return res.status(400).json({ success: false, error: bad });

    const existing = await dbGet('SELECT * FROM program_options WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Option not found.' });

    const updated = {
      name: name !== undefined ? String(name).trim() : existing.name,
      capacity: capacity !== undefined ? capacity : existing.capacity,
      fee: fee !== undefined ? fee : existing.fee,
      active: active !== undefined ? (active ? 1 : 0) : existing.active,
    };
    await dbRun(
      'UPDATE program_options SET name = ?, capacity = ?, fee = ?, active = ? WHERE id = ?',
      [updated.name, updated.capacity, updated.fee, updated.active, req.params.id]
    );
    await recordAudit({
      req, entityType: 'program_option', entityId: req.params.id,
      action: 'PROGRAM_OPTION_UPDATE',
      oldValue: `${existing.name} (capacity ${existing.capacity}, fee ₹${existing.fee}, ${existing.active ? 'active' : 'inactive'})`,
      newValue: `${updated.name} (capacity ${updated.capacity}, fee ₹${updated.fee}, ${updated.active ? 'active' : 'inactive'})`,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Delete an option, but only if nobody is enrolled (otherwise deactivate it).
app.delete('/api/admin/program-options/:id', requirePermission('masters.programs_manage'), async (req, res, next) => {
  try {
    const opt = await dbGet('SELECT * FROM program_options WHERE id = ?', [req.params.id]);
    if (!opt) return res.status(404).json({ success: false, error: 'Option not found.' });

    const used = await dbGet(
      `SELECT COUNT(*) AS n FROM registration_options ro
         JOIN registrations r ON r.id = ro.registration_id
         WHERE ro.option_id = ? AND r.bank_status != 'REJECTED'`,
      [opt.id]
    );
    if (used.n > 0) {
      return res.status(409).json({ success: false, error: `Cannot delete: ${used.n} delegate(s) enrolled. Deactivate it instead.` });
    }
    await dbRun('DELETE FROM program_options WHERE id = ?', [req.params.id]);
    await recordAudit({
      req, entityType: 'program_option', entityId: req.params.id,
      action: 'PROGRAM_OPTION_DELETE', oldValue: opt.name, newValue: null,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// List delegates currently enrolled in one option (manual roster view,
// alongside the capacity count already shown in the list).
app.get('/api/admin/program-options/:id/enrolled', requirePermission('masters.programs_view'), async (req, res, next) => {
  try {
    const opt = await dbGet('SELECT * FROM program_options WHERE id = ?', [req.params.id]);
    if (!opt) return res.status(404).json({ success: false, error: 'Option not found.' });
    const rows = await dbAll(
      `SELECT registrations.id, registrations.phone_number, delegate_name, ${DELEGATE_SALUTATION_COLUMN}, registrations.registration_number, registrations.bank_status, ro.is_faculty
         FROM registration_options ro
         JOIN registrations ON registrations.id = ro.registration_id
         WHERE ro.option_id = ? AND bank_status != 'REJECTED' ORDER BY ro.is_faculty DESC, delegate_name`,
      [opt.id]
    );
    res.json({ option: opt, enrolled: rows.map(withDelegateSalutation) });
  } catch (err) {
    next(err);
  }
});

// Manually enroll a delegate (by phone) into an option, bypassing the normal
// self-service capacity check -- an admin override for edge cases (a
// delegate who paid offline, a late add, correcting a mistaken choice).
// Replaces any existing choice the delegate has in the SAME group (a
// delegate can only hold one option per group here too, regardless of that
// group's max_select -- this endpoint is a single-slot override, not a bulk
// selection tool); other groups are untouched.
app.post('/api/admin/program-options/:id/enroll', requirePermission('masters.programs_manage'), async (req, res, next) => {
  try {
    const opt = await dbGet('SELECT * FROM program_options WHERE id = ?', [req.params.id]);
    if (!opt) return res.status(404).json({ success: false, error: 'Option not found.' });
    // Identified by number OR email, and resolved to the account first:
    // registrations join on the account KEY, which is only the number for a
    // phone-based signup -- looking the number up directly would silently
    // miss anyone whose key is synthetic.
    const identifier = String(req.body.identifier || req.body.phone || '').trim();
    const found = await resolveAccountByIdentifier(identifier);
    if (found.error === 'ambiguousEmail') {
      return res.status(409).json({ success: false, error: 'More than one account uses that email address. Use their mobile number instead.' });
    }
    if (found.error) {
      return res.status(404).json({ success: false, error: 'No delegate found with that mobile number or email address.' });
    }
    const phone = found.user.phone_number;
    const reg = await dbGet('SELECT id FROM registrations WHERE phone_number = ?', [phone]);
    if (!reg) {
      return res.status(404).json({ success: false, error: 'This delegate has no payment registration yet -- they must register before being enrolled.' });
    }
    const prevOption = await dbGet(
      'SELECT option_id FROM registration_options WHERE registration_id = ? AND group_id = ?',
      [reg.id, opt.group_id]
    );
    // Reset the faculty flag on (re-)enroll: it belongs to a specific option
    // assignment, so moving someone to a different option in this group
    // shouldn't silently carry their old faculty status over.
    await dbRun('DELETE FROM registration_options WHERE registration_id = ? AND group_id = ?', [reg.id, opt.group_id]);
    await dbRun(
      'INSERT INTO registration_options (registration_id, group_id, option_id, is_faculty) VALUES (?, ?, ?, 0)',
      [reg.id, opt.group_id, opt.id]
    );
    await recordAudit({
      req, entityType: 'registration', entityId: reg.id,
      action: 'ADMIN_ENROLL', oldValue: prevOption ? prevOption.option_id : null, newValue: opt.id,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Mark/unmark an enrolled delegate as faculty for this specific option.
// Faculty stay attached to the option (visible on its roster and report)
// but are excluded from the capacity count -- see fetchProgramOptions().
app.put('/api/admin/program-options/:id/enrolled/:phone/faculty', requirePermission('masters.programs_manage'), async (req, res, next) => {
  try {
    const opt = await dbGet('SELECT * FROM program_options WHERE id = ?', [req.params.id]);
    if (!opt) return res.status(404).json({ success: false, error: 'Option not found.' });
    const reg = await dbGet(
      `SELECT r.id FROM registrations r
         JOIN registration_options ro ON ro.registration_id = r.id
         WHERE r.phone_number = ? AND ro.option_id = ?`,
      [req.params.phone, opt.id]
    );
    if (!reg) return res.status(404).json({ success: false, error: 'This delegate is not enrolled in this option.' });
    const isFaculty = req.body.isFaculty ? 1 : 0;
    await dbRun('UPDATE registration_options SET is_faculty = ? WHERE registration_id = ? AND option_id = ?', [isFaculty, reg.id, opt.id]);
    await recordAudit({
      req, entityType: 'registration', entityId: reg.id,
      action: 'ADMIN_SET_FACULTY', oldValue: opt.id, newValue: isFaculty ? 'FACULTY' : 'DELEGATE',
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Remove a delegate from an option's roster (clears their choice in that
// group; does not touch their registration or other groups otherwise).
app.delete('/api/admin/program-options/:id/enroll/:phone', requirePermission('masters.programs_manage'), async (req, res, next) => {
  try {
    const opt = await dbGet('SELECT * FROM program_options WHERE id = ?', [req.params.id]);
    if (!opt) return res.status(404).json({ success: false, error: 'Option not found.' });
    const reg = await dbGet(
      `SELECT r.id FROM registrations r
         JOIN registration_options ro ON ro.registration_id = r.id
         WHERE r.phone_number = ? AND ro.option_id = ?`,
      [req.params.phone, opt.id]
    );
    if (!reg) return res.status(404).json({ success: false, error: 'This delegate is not enrolled in this option.' });
    await dbRun('DELETE FROM registration_options WHERE registration_id = ? AND option_id = ?', [reg.id, opt.id]);
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

// Whether this category requires a student ID card. It used to also carry a
// discipline/level pair, which existed solely to tell the ID-card OCR what
// keywords to look for; with that check gone there is nothing to constrain,
// so any category can require an ID and an approver judges the card.
function studentIdFields(b) {
  return { requiresStudentId: !!b.requiresStudentId };
}

app.get('/api/admin/fees', requirePermission('masters.fees_view'), async (req, res, next) => {
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
app.get('/api/admin/discount-codes', requirePermission('discounts.view'), async (req, res, next) => {
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
  // INDIVIDUAL: a mobile number OR an email address identifying the
  // delegate. Digits-only stripping would destroy an email, so only a value
  // that already looks like a phone is normalised that way; the POST handler
  // resolves whichever it is to that delegate's account key before storing.
  if (scopeType === 'INDIVIDUAL' && !isEmailValue(scopeValue)) scopeValue = scopeValue.replace(/\D/g, '');
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
  if (f.scopeType === 'INDIVIDUAL' && !isPhoneValue(f.scopeValue) && !isEmailValue(f.scopeValue)) {
    return 'Enter the delegate\u2019s mobile number or email address for an individual code.';
  }
  return null;
}

app.post('/api/admin/discount-codes', requirePermission('discounts.manage'), async (req, res, next) => {
  try {
    const f = parseDiscountBody(req.body);
    const err = validateDiscountFields(f);
    if (err) return res.status(400).json({ success: false, error: err });

    // scope_value for an INDIVIDUAL code is matched against the session's
    // account key (see validateDiscountCode), so resolve whatever the admin
    // typed -- mobile or email -- to that key before storing. For a
    // phone-based account the two are the same value, which is why every
    // code issued before email signup existed keeps working untouched.
    if (f.scopeType === 'INDIVIDUAL') {
      const found = await resolveAccountByIdentifier(f.scopeValue);
      if (found.error === 'ambiguousEmail') {
        return res.status(409).json({ success: false, error: 'More than one account uses that email address. Use the delegate\u2019s mobile number instead.' });
      }
      if (found.error) {
        return res.status(404).json({ success: false, error: 'No delegate found with that mobile number or email address.' });
      }
      f.scopeValue = found.user.phone_number;
    }

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

app.put('/api/admin/discount-codes/:id', requirePermission('discounts.manage'), async (req, res, next) => {
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

app.delete('/api/admin/discount-codes/:id', requirePermission('discounts.manage'), async (req, res, next) => {
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
// Shared by the printable voucher, the emailed voucher, and (client-side,
// from this same /discount-codes list data) the WhatsApp message -- one
// place computing what a discount code's scope/discount/expiry actually say.
async function discountCodeLines(code) {
  let scopeLine = 'Valid for any delegate.';
  if (code.scope_type === 'CATEGORY') {
    const cat = await dbGet('SELECT label FROM fee_categories WHERE category_key = ?', [code.scope_value]);
    scopeLine = `Valid for the "${escapeHtml(cat ? cat.label : code.scope_value)}" category only.`;
  } else if (code.scope_type === 'INDIVIDUAL') {
    // scope_value is the delegate's account key, which is only a real
    // number for phone-based accounts -- show the email for an email-only
    // one rather than printing a synthetic key as "+91 u_...".
    const u = await dbGet('SELECT full_name, phone, email FROM users WHERE phone_number = ?', [code.scope_value]);
    const shownPhone = displayPhone({ ...(u || {}), phone_number: code.scope_value });
    const contact = shownPhone || ((u && u.email) || '');
    scopeLine = `Reserved for ${escapeHtml(u ? u.full_name : 'this delegate')}${contact ? ` (${escapeHtml(contact)})` : ''} only.`;
  }
  const discountLine = code.discount_type === 'PERCENT' ? `${Number(code.discount_value)}% off` : `₹${inr(Number(code.discount_value))} off`;
  const expiryLine = code.expires_at ? `Valid through ${escapeHtml(formatDMY(code.expires_at))}.` : 'No expiry date set.';
  return { scopeLine, discountLine, expiryLine };
}

app.get('/api/admin/discount-codes/:id/share', requirePermission('discounts.view'), async (req, res, next) => {
  try {
    const code = await dbGet('SELECT * FROM discount_codes WHERE id = ?', [req.params.id]);
    if (!code) return res.status(404).send('Discount code not found.');

    const { scopeLine, discountLine, expiryLine } = await discountCodeLines(code);

    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Discount Code ${escapeHtml(code.code)}</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;margin:2rem;}
  .card{max-width:420px;width:100%;margin:0 auto;border:2px dashed #4f46e5;border-radius:16px;padding:2rem;text-align:center;box-sizing:border-box;}
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
    <div class="eyebrow">${escapeHtml(CONFERENCE.acronym)} · Discount Code</div>
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

// Emails the same voucher card as /share (HTML/print) and the WhatsApp
// message -- to any address the admin types in, not just a delegate already
// on file, so a code can be sent to a fresh contact before they've even
// signed up. Fire-and-forget like every other email in this app (see
// sendEmail); the admin is told up front if email isn't configured at all,
// rather than getting a false "sent" for something that silently no-ops.
app.post('/api/admin/discount-codes/:id/email', requirePermission('discounts.manage'), async (req, res, next) => {
  try {
    const to = String(req.body.email || '').trim();
    if (!EMAIL_RE.test(to)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address.' });
    }
    if (!emailEnabled() || !notifyToggle.email) {
      return res.status(400).json({ success: false, error: 'Email is not enabled (Settings → General → Email).' });
    }
    const code = await dbGet('SELECT * FROM discount_codes WHERE id = ?', [req.params.id]);
    if (!code) return res.status(404).json({ success: false, error: 'Discount code not found.' });

    const { scopeLine, discountLine, expiryLine } = await discountCodeLines(code);
    const body = `
      <div style="text-align:center;border:2px dashed #4f46e5;border-radius:12px;padding:1.5rem;margin:0 0 1rem">
        <div style="font-family:ui-monospace,Menlo,monospace;font-size:1.75rem;font-weight:800;letter-spacing:.08em;background:#eef2ff;border-radius:10px;padding:.85rem;margin:0 0 .75rem;color:#312e81">${escapeHtml(code.code)}</div>
        <p style="font-size:1rem;font-weight:700;color:#047857;margin:0 0 .5rem">${discountLine}</p>
        <p style="font-size:.82rem;color:#475569;margin:.3rem 0">${scopeLine}</p>
        <p style="font-size:.82rem;color:#475569;margin:.3rem 0">${expiryLine}</p>
      </div>
      <p style="font-size:.85rem;color:#334155">Register at <b>${escapeHtml(PORTAL_URL)}</b> and enter this code under "Apply promo code" on the payment step.</p>`;
    const subject = `${CONFERENCE.acronym} — Your Discount Code`;
    await sendEmail(to, subject, emailWrap(subject, body));

    await recordAudit({
      req, entityType: 'discount_code', entityId: code.id, action: 'DISCOUNT_CODE_EMAILED',
      oldValue: null, newValue: `${code.code} emailed to ${to}`,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- GROUP DISCOUNT RULES (admin) ---------------------------------------
app.get('/api/admin/group-rules', requirePermission('discounts.group_view'), async (req, res, next) => {
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
// already editable above. Five of these six are now admin-editable from
// Settings → General (persisted to schema_meta, same as everything else on
// this page) -- NODE_ENV is the one exception, shown read-only since it's a
// Node/process-launch convention, not application config (see
// RUNTIME_ENV_SETTERS). None of these are secret, so the *effective* value is
// shown (the resolved runtime constant, same as what the server actually
// used at boot) rather than the raw env var -- most of these run on their
// coded-in default with nothing set anywhere, and showing "not set" for
// those would look broken even though it's accurate.
async function describeOtherEnvVars() {
  const keys = Object.keys(RUNTIME_ENV_SETTERS);
  const rows = await dbAll(`SELECT key FROM schema_meta WHERE key IN (${keys.map(() => '?').join(',')})`, keys);
  const inDb = new Set(rows.map((r) => r.key));
  // DB (if an admin has ever saved it) beats .env beats the coded-in default
  // -- same precedence loadGeneralSettings() already applies when it overlays
  // schema_meta on top of the process.env-seeded value at boot.
  const source = (key, envVar) => inDb.has(key) ? 'database' : (process.env[envVar] !== undefined ? 'env' : 'default');
  return [
    { key: 'PORT', value: String(PORT), source: source('port', 'PORT'), editable: true, restartRequired: true },
    { key: 'PORTAL_URL', value: PORTAL_URL, source: source('portal_url', 'PORTAL_URL'), editable: true, restartRequired: false },
    { key: 'NODE_ENV', value: process.env.NODE_ENV || '(unset)', source: process.env.NODE_ENV !== undefined ? 'env' : 'default', editable: false, restartRequired: false },
    { key: 'COOKIE_NAME', value: COOKIE_NAME, source: source('cookie_name', 'COOKIE_NAME'), editable: true, restartRequired: true },
    { key: 'COOKIE_SECURE', value: String(COOKIE_SECURE), source: source('cookie_secure', 'COOKIE_SECURE'), editable: true, restartRequired: true },
    { key: 'OTP_ECHO', value: String(OTP_ECHO), source: source('otp_echo', 'OTP_ECHO'), editable: true, restartRequired: false },
  ];
}

app.get('/api/admin/general-settings', requirePermission('system.settings_view'), async (req, res, next) => {
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
        from: EMAIL.from, fromName: EMAIL.fromName, region: EMAIL.region, digestRecipients: EMAIL.digestRecipients,
        digestEnabled: notifyToggle.digest, digestSendTime: EMAIL.digestSendTime,
      },
      upi: { id: UPI.id, payeeName: UPI.payeeName },
      bank: { accountName: BANK.accountName, accountNumber: BANK.accountNumber, ifsc: BANK.ifsc, branch: BANK.branch },
      conference: { name: CONFERENCE.name, acronym: CONFERENCE.acronym, startDate: CONFERENCE.startDate, endDate: CONFERENCE.endDate, location: CONFERENCE.location, regPrefix: CONFERENCE.regPrefix },
      maintenance: { enabled: maintenance.enabled, message: maintenance.message },
      otherEnvVars: await describeOtherEnvVars(),
    });
  } catch (err) {
    next(err);
  }
});

app.put('/api/admin/general-settings', requirePermission('system.settings_edit'), async (req, res, next) => {
  try {
    const { sms, email, upi, bank, conference, notify, maintenance: maintenanceBody, otherEnv } = req.body || {};

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
      [email, EMAIL, { from: 'From address', fromName: 'From name', region: 'AWS Region', digestSendTime: 'Digest Send Time' }],
      [upi, UPI, { id: 'UPI ID', payeeName: 'Payee Name' }],
      [conference, CONFERENCE, { name: 'Conference Name', regPrefix: 'Registration Number Prefix' }], // acronym/dates/location are optional and may be cleared
    ]) {
      if (!group) continue;
      for (const field of Object.keys(labels)) {
        if (group[field] === undefined) continue;
        if (!String(group[field]).trim() && (target[field] || '')) {
          return res.status(400).json({ success: false, error: `${labels[field]} cannot be blank.` });
        }
      }
    }

    // Digest recipients is a comma-separated list of 10-digit phone numbers
    // (looked up in the users table by the standalone daily-digest script),
    // not a single free-text field, so it needs its own shape check rather
    // than the generic blank/newline guards above.
    if (email && email.digestRecipients !== undefined) {
      const parts = String(email.digestRecipients).split(',').map((p) => p.trim()).filter(Boolean);
      // Staff numbers, resolved by the standalone digest script against the
      // users table -- deliberately still Indian-only, since a digest
      // recipient is host-institution staff, not a delegate.
      if (parts.some((p) => !isIndianPhone(p))) {
        return res.status(400).json({ success: false, error: 'Digest recipients must be a comma-separated list of 10-digit mobile numbers.' });
      }
    }
    if (email && email.digestSendTime !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(email.digestSendTime).trim())) {
      return res.status(400).json({ success: false, error: 'Digest send time must be in HH:MM (24-hour) format.' });
    }

    // Registration prefix is concatenated directly in front of a zero-padded
    // sequence number to form every new registration number (see
    // assignUserRegNumber) and is printed on receipts/reports, so it's
    // restricted to plain alphanumerics -- no spaces, punctuation, or line
    // breaks that could look broken or, worse, get misread when quoted back.
    if (conference && conference.regPrefix !== undefined && String(conference.regPrefix).trim()
      && !/^[A-Za-z0-9]{1,20}$/.test(String(conference.regPrefix).trim())) {
      return res.status(400).json({ success: false, error: 'Registration Number Prefix must be 1-20 letters/numbers only.' });
    }

    // Conference dates: a deployment is always being set up for an event
    // that hasn't happened yet, so the start date can't be in the past, and
    // the end date can't be before the (possibly just-changed) start date.
    // Compared as YYYY-MM-DD strings, which sort the same as dates.
    if (conference) {
      const todayStr = istDateString(); // IST: these are Indian calendar dates
      const startDate = conference.startDate !== undefined ? String(conference.startDate).trim() : CONFERENCE.startDate;
      const endDate = conference.endDate !== undefined ? String(conference.endDate).trim() : CONFERENCE.endDate;
      if (conference.startDate !== undefined && startDate && !DATE_RE.test(startDate)) {
        return res.status(400).json({ success: false, error: 'Start Date must be YYYY-MM-DD.' });
      }
      if (conference.endDate !== undefined && endDate && !DATE_RE.test(endDate)) {
        return res.status(400).json({ success: false, error: 'End Date must be YYYY-MM-DD.' });
      }
      if (conference.startDate !== undefined && startDate && startDate < todayStr) {
        return res.status(400).json({ success: false, error: 'Start Date cannot be in the past.' });
      }
      if (startDate && endDate && endDate < startDate) {
        return res.status(400).json({ success: false, error: 'End Date cannot be before Start Date.' });
      }
    }

    // "Other Environment Variables". portalUrl/port/cookieName are required
    // text fields (all three have a coded-in default, never legitimately
    // blank); cookieSecure/otpEcho are booleans, validated separately below.
    // Shape-checked up front, same as everything above, so nothing partially
    // applies on a bad request.
    if (otherEnv && otherEnv.portalUrl !== undefined && !String(otherEnv.portalUrl).trim()) {
      return res.status(400).json({ success: false, error: 'Portal URL cannot be blank.' });
    }
    let otherEnvPort = null;
    if (otherEnv && otherEnv.port !== undefined) {
      const raw = String(otherEnv.port).trim();
      otherEnvPort = Number(raw);
      if (!raw || !Number.isInteger(otherEnvPort) || otherEnvPort < 1 || otherEnvPort > 65535) {
        return res.status(400).json({ success: false, error: 'Port must be a whole number between 1 and 65535.' });
      }
    }
    if (otherEnv && otherEnv.cookieName !== undefined) {
      const val = String(otherEnv.cookieName).trim();
      // A valid cookie-name token per RFC 6265 -- anything outside this could
      // silently fail to set the cookie (or worse, break the Set-Cookie header
      // outright) once it takes effect after a restart.
      if (!val || !/^[A-Za-z0-9_.-]{1,64}$/.test(val)) {
        return res.status(400).json({ success: false, error: 'Cookie name may only contain letters, numbers, underscore, dot, and hyphen.' });
      }
    }

    const changes = [];
    // Set alongside `changes` whenever a saved field only takes effect on the
    // next restart (PORT/COOKIE_NAME/COOKIE_SECURE) -- included in the
    // response so the UI can say so explicitly instead of implying it's live.
    let restartRequired = false;
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
    await applyFields(email, EMAIL, { from: 'email_from', fromName: 'email_from_name', region: 'email_region', digestRecipients: 'email_digest_recipients', digestSendTime: 'email_digest_send_time' },
      new Set(['digestRecipients']));
    await applyFields(upi, UPI, { id: 'upi_id', payeeName: 'upi_payee_name' });
    // Bank transfer is a fallback alongside UPI, not a required channel on
    // its own, so every field here may be cleared (unlike UPI's id/payeeName
    // above, which are required once set).
    await applyFields(bank, BANK, { accountName: 'bank_account_name', accountNumber: 'bank_account_number', ifsc: 'bank_ifsc', branch: 'bank_branch' },
      new Set(['accountName', 'accountNumber', 'ifsc', 'branch']));
    await applyFields(conference, CONFERENCE,
      { name: 'conference_name', acronym: 'conference_acronym', startDate: 'conference_start_date', endDate: 'conference_end_date', location: 'conference_location', regPrefix: 'conference_reg_prefix' },
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
      if (notify.digest !== undefined) {
        notifyToggle.digest = !!notify.digest;
        await setKV('notify_digest_enabled', notifyToggle.digest ? '1' : '0');
        changes.push(`Daily digest ${notifyToggle.digest ? 'on' : 'off'}`);
      }
    }

    // Maintenance mode. This route is already SUPER_ADMIN-only, which is the
    // access control that matters -- it's the one role that can still use the
    // portal once this is on, so no other role can strand itself (or everyone
    // else) by flipping it.
    if (maintenanceBody) {
      if (maintenanceBody.message !== undefined) {
        const msg = String(maintenanceBody.message).trim() || DEFAULT_MAINTENANCE_MESSAGE;
        if (msg !== maintenance.message) {
          maintenance.message = msg;
          await setKV('maintenance_message', msg);
          changes.push('Maintenance message updated');
        }
      }
      if (maintenanceBody.enabled !== undefined) {
        const on = !!maintenanceBody.enabled;
        if (on !== maintenance.enabled) {
          maintenance.enabled = on;
          await setKV('maintenance_enabled', on ? '1' : '0');
          changes.push(`Maintenance mode ${on ? 'ON — portal closed to everyone except super admins' : 'OFF — portal reopened'}`);
        }
      }
    }

    // "Other Environment Variables". PORTAL_URL and OTP_ECHO are mutated in
    // memory immediately, same as every field above -- applies without a
    // restart. PORT/COOKIE_NAME/COOKIE_SECURE are deliberately NOT mutated
    // here: they're read once at process boot (see the `let` declarations
    // and loadGeneralSettings()), so writing only to schema_meta and leaving
    // the live value untouched is what makes "takes effect on next restart"
    // true rather than a UI claim that doesn't match reality.
    if (otherEnv) {
      if (otherEnv.portalUrl !== undefined) {
        const val = String(otherEnv.portalUrl).trim();
        if (val !== PORTAL_URL) {
          PORTAL_URL = val;
          await setKV('portal_url', val);
          changes.push(`Portal URL: "${PORTAL_URL}" → "${val}"`);
        }
      }
      if (otherEnv.otpEcho !== undefined) {
        const on = !!otherEnv.otpEcho;
        if (on !== OTP_ECHO) {
          OTP_ECHO = on;
          await setKV('otp_echo', on ? '1' : '0');
          changes.push(`OTP Echo ${on ? 'ON — OTP codes will be returned in the login API response' : 'OFF'}`);
        }
      }
      if (otherEnvPort !== null && otherEnvPort !== PORT) {
        await setKV('port', String(otherEnvPort));
        changes.push(`Port: ${PORT} → ${otherEnvPort} (takes effect on next restart)`);
        restartRequired = true;
      }
      if (otherEnv.cookieName !== undefined) {
        const val = String(otherEnv.cookieName).trim();
        if (val !== COOKIE_NAME) {
          await setKV('cookie_name', val);
          changes.push(`Cookie name: "${COOKIE_NAME}" → "${val}" (takes effect on next restart — every current session will be signed out)`);
          restartRequired = true;
        }
      }
      if (otherEnv.cookieSecure !== undefined) {
        const on = !!otherEnv.cookieSecure;
        if (on !== COOKIE_SECURE) {
          await setKV('cookie_secure', on ? '1' : '0');
          changes.push(`Cookie Secure (HTTPS-only) ${on ? 'ON' : 'OFF'} (takes effect on next restart — every current session will be signed out)`);
          restartRequired = true;
        }
      }
    }

    if (changes.length) {
      await recordAudit({ req, entityType: 'general_settings', entityId: 'general', action: 'GENERAL_SETTINGS_UPDATE', oldValue: null, newValue: changes.join('; ') });
    }
    res.json({ success: true, sms: notifyToggle.sms, email: notifyToggle.email, digest: notifyToggle.digest, maintenance: maintenance.enabled, restartRequired });
  } catch (err) {
    next(err);
  }
});

// Admin monitoring: every group with its members and their verification states.
app.get('/api/admin/groups', requirePermission('discounts.group_view'), async (req, res, next) => {
  try {
    const groups = await dbAll('SELECT * FROM delegate_groups ORDER BY created_at DESC');
    const views = [];
    for (const g of groups) views.push(await groupView(g));
    res.json({ groups: views });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/group-rules', requirePermission('discounts.group_manage'), async (req, res, next) => {
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

app.put('/api/admin/group-rules/:id', requirePermission('discounts.group_manage'), async (req, res, next) => {
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

app.delete('/api/admin/group-rules/:id', requirePermission('discounts.group_manage'), async (req, res, next) => {
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

app.put('/api/admin/fees/config', requirePermission('masters.fees_manage'), async (req, res, next) => {
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
    // A cutoff in the past makes that pricing phase unreachable the moment
    // it's saved, and a cutoff after the conference has already started
    // makes no sense either (an "early bird" rate that lasts past day one).
    // Compared as YYYY-MM-DD strings, which sort the same as dates.
    const todayStr = istDateString(); // IST: these are Indian calendar dates
    for (const [label, d] of [['Early', earlyUntil], ['Regular', regularUntil], ['Late', lateUntil]]) {
      if (!d) continue;
      if (d < todayStr) return res.status(400).json({ success: false, error: `${label} cutoff cannot be before today.` });
      if (CONFERENCE.startDate && d > CONFERENCE.startDate) {
        return res.status(400).json({ success: false, error: `${label} cutoff cannot be after the conference start date.` });
      }
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

app.post('/api/admin/fees/categories', requirePermission('masters.fees_manage'), async (req, res, next) => {
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
    const sid = studentIdFields(req.body);
    if (!sid) return res.status(400).json({ success: false, error: 'Choose a discipline and level for the student ID requirement.' });
    const max = await dbGet('SELECT COALESCE(MAX(sort_order), -1) AS m FROM fee_categories');
    const result = await dbRun(
      'INSERT INTO fee_categories (category_key, label, subtitle, early_fee, regular_fee, late_fee, spot_fee, active, sort_order, requires_student_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
      [categoryKey, String(label).trim(), subtitle ? String(subtitle).trim() : '', f.early, f.regular, f.late, f.spot, max.m + 1, sid.requiresStudentId ? 1 : 0]
    );
    await recordAudit({
      req, entityType: 'fee_category', entityId: result.lastID,
      action: 'FEE_CATEGORY_CREATE', oldValue: null,
      newValue: `${categoryKey} "${String(label).trim()}" — early ₹${inr(f.early)}, regular ₹${inr(f.regular)}, late ₹${inr(f.late)}, spot ₹${inr(f.spot)}`
        + (sid.requiresStudentId ? ', requires student ID' : ''),
    });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ success: false, error: 'A category with that key already exists.' });
    }
    next(err);
  }
});

app.put('/api/admin/fees/categories/:id', requirePermission('masters.fees_manage'), async (req, res, next) => {
  try {
    const existing = await dbGet('SELECT * FROM fee_categories WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Category not found.' });
    const { active } = req.body;
    const f = feeFields(req.body);
    if ([f.early, f.regular, f.late, f.spot].some((x) => !Number.isFinite(x) || x < 0)) {
      return res.status(400).json({ success: false, error: 'Fees must be non-negative numbers.' });
    }
    // Label and subtitle are set once at category creation and are not
    // editable afterwards -- only fees, active status, and the student-ID
    // requirement can be updated here. requiresStudentId is left untouched
    // when the field is absent from the body (same "absent = no change"
    // convention as active), so a plain fee edit never has to resend it.
    let sid = { requiresStudentId: !!existing.requires_student_id };
    if (req.body.requiresStudentId !== undefined) {
      const parsed = studentIdFields(req.body);
      if (!parsed) return res.status(400).json({ success: false, error: 'Choose a discipline and level for the student ID requirement.' });
      sid = parsed;
    }
    const updated = {
      active: active !== undefined ? (active ? 1 : 0) : existing.active,
    };
    await dbRun(
      'UPDATE fee_categories SET early_fee = ?, regular_fee = ?, late_fee = ?, spot_fee = ?, active = ?, requires_student_id = ? WHERE id = ?',
      [f.early, f.regular, f.late, f.spot, updated.active, sid.requiresStudentId ? 1 : 0, req.params.id]
    );
    const idNote = (v) => v.requiresStudentId ? ', requires student ID' : '';
    await recordAudit({
      req, entityType: 'fee_category', entityId: req.params.id,
      action: 'FEE_CATEGORY_UPDATE',
      oldValue: `${existing.label} — early ₹${inr(existing.early_fee)}, regular ₹${inr(existing.regular_fee)}, late ₹${inr(existing.late_fee)}, spot ₹${inr(existing.spot_fee)}, ${existing.active ? 'active' : 'inactive'}${idNote({ requiresStudentId: !!existing.requires_student_id })}`,
      newValue: `${existing.label} — early ₹${inr(f.early)}, regular ₹${inr(f.regular)}, late ₹${inr(f.late)}, spot ₹${inr(f.spot)}, ${updated.active ? 'active' : 'inactive'}${idNote(sid)}`,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/admin/fees/categories/:id', requirePermission('masters.fees_manage'), async (req, res, next) => {
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
    `SELECT id, extracted_ref, credit FROM bank_statement_transactions
      WHERE credit IS NOT NULL AND credit > 0 AND extracted_ref IS NOT NULL AND is_non_registration = 0
        AND id NOT IN ${USED_BANK_TXN_SUBQUERY}`);
  const byRef = new Map();
  credits.forEach((t) => byRef.set(digitsOnly(t.extracted_ref), t));

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
    const bank = byRef.get(digitsOnly(txn.utr_number));
    if (!bank) continue;
    // A UTR match acknowledges the payment at whatever the credit actually
    // covers -- its own claimed amount if the credit is big enough, or the
    // credit's own amount if the claim is larger (a genuine partial
    // payment), same capping principle as a manual link. Then don't let the
    // acknowledged amount push the registration's cumulative total past the
    // fee actually due -- leave it unlinked/pending for a human to review
    // rather than silently over-crediting (e.g. a genuine accidental double
    // payment, or a duplicate resubmission artifact).
    const acknowledged = Math.min(txn.amount || 0, bank.credit);
    const already = verifiedSoFar.get(txn.registration_id) || 0;
    if (txn.expected_amount > 0 && already + acknowledged > txn.expected_amount + 0.5) continue;
    // Guard against two transactions racing for the same still-unused credit
    // within this loop (the UNIQUE index is the final backstop).
    byRef.delete(digitsOnly(txn.utr_number));
    try {
      await dbRun(
        `UPDATE payment_transactions
            SET bank_txn_id = ?, txn_status = 'VERIFIED', verified_amount = ?,
                reviewed_by = 'auto (bank match)', reviewed_at = ?
          WHERE id = ? AND bank_txn_id IS NULL`,
        [bank.id, acknowledged, Date.now(), txn.id]);
      verifiedSoFar.set(txn.registration_id, already + acknowledged);
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
app.post('/api/admin/bank-statement/upload', requirePermission('statement.import'),
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

app.get('/api/admin/bank-statement', requirePermission('statement.view'), async (req, res, next) => {
  try {
    const rows = await dbAll('SELECT * FROM bank_statement_transactions ORDER BY post_date DESC, id DESC');
    res.json({ transactions: rows || [] });
  } catch (err) {
    next(err);
  }
});

// Mark/unmark a statement credit as not belonging to any registration (bank
// charges, interest, an unrelated transfer) -- pulls it out of "Bank Credits
// Not Matched to a Registration" into its own list, and makes it ineligible
// to link to a registration/payment going forward (see the is_non_registration
// checks in the link endpoints and candidate pickers below/above). Refuses to
// mark a credit that's currently linked -- unlink it first, so a credit is
// never simultaneously "belongs to registration X" and "belongs to no one."
app.put('/api/admin/bank-statement/:id/non-registration', requirePermission('statement.mark_non_registration'), async (req, res, next) => {
  try {
    const value = !!req.body.value;
    const txn = await dbGet('SELECT id, is_non_registration FROM bank_statement_transactions WHERE id = ?', [req.params.id]);
    if (!txn) return res.status(404).json({ success: false, error: 'Statement transaction not found.' });

    if (value) {
      const linkedTxn = await dbGet('SELECT id FROM payment_transactions WHERE bank_txn_id = ?', [req.params.id]);
      const linkedReg = await dbGet('SELECT id FROM registrations WHERE bank_txn_id = ?', [req.params.id]);
      if (linkedTxn || linkedReg) {
        return res.status(400).json({ success: false, error: 'This transaction is currently linked to a registration. Unlink it first.' });
      }
    }

    await dbRun('UPDATE bank_statement_transactions SET is_non_registration = ? WHERE id = ?', [value ? 1 : 0, req.params.id]);
    await recordAudit({
      req, entityType: 'bank_statement_transaction', entityId: req.params.id,
      action: 'BANK_TXN_NON_REGISTRATION_UPDATE',
      oldValue: txn.is_non_registration ? 'Non-registration' : 'Registration',
      newValue: value ? 'Non-registration' : 'Registration',
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Reconcile registrations' payment references against imported statement
// credits. A registration matches when a statement credit row's extracted
// reference equals its UTR/transaction number (digits-only comparison, so
// formatting differences don't break the match).
app.get('/api/admin/bank-statement/reconcile', requirePermission('statement.view'), async (req, res, next) => {
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

    // Which registration(s) each credit is linked to -- a list per credit,
    // not a single value, since one credit can now be split across several
    // delegates (see allocatedForBankTxn). Only VERIFIED rows count as an
    // actual allocation; a PENDING claim that happens to carry a bank_txn_id
    // shouldn't (it never should in practice, but this keeps the two
    // concepts -- "linked" and "verified" -- from silently diverging here).
    const links = await dbAll(
      "SELECT registration_id, bank_txn_id, verified_amount, amount FROM payment_transactions WHERE bank_txn_id IS NOT NULL AND txn_status = 'VERIFIED' ORDER BY id ASC");
    const linksByCredit = new Map();
    links.forEach((l) => {
      if (!linksByCredit.has(l.bank_txn_id)) linksByCredit.set(l.bank_txn_id, []);
      linksByCredit.get(l.bank_txn_id).push(l);
    });

    // registrations.utr_number is never cleared on unlink (unlinking only
    // touches payment_transactions.bank_txn_id -- see DELETE .../link), so
    // without this guard the UTR fallback below would immediately re-match a
    // credit an admin just deliberately unlinked, as long as its statement
    // reference still happens to equal that registration's own UTR digits.
    // The fallback exists for registrations that predate per-transaction
    // linking and have no ledger row to link at all; once seeded (every
    // registration gets one on submit, and a boot-time backfill covers
    // anything older -- see backfillPaymentTransactionsOnBoot), a
    // registration always has a ledger to explicitly link/unlink instead,
    // so the fallback should defer to that rather than override it.
    const regIdsWithTxnRows = new Set(
      (await dbAll('SELECT DISTINCT registration_id FROM payment_transactions')).map((r) => r.registration_id));

    const matched = [];
    const unmatchedCredits = [];
    const nonRegistrationCredits = [];
    const matchedRegIds = new Set();
    for (const t of txns) {
      // Marked non-registration (bank charges, interest, an unrelated
      // transfer) -- pulled out before matching runs at all, so it can never
      // land in either matched or unmatched no matter what its reference
      // happens to look like.
      if (t.is_non_registration) { nonRegistrationCredits.push(t); continue; }
      const creditLinks = linksByCredit.get(t.id);
      if (creditLinks && creditLinks.length) {
        // Split credits: one matched row per delegate it's linked to, not
        // just the first (that used to be the case when this only ever
        // tracked a single link per credit -- a second allocation on the
        // same credit would silently vanish from this whole view). amountOk
        // now describes the CREDIT as a whole -- is it fully and exactly
        // accounted for across every delegate it's split between, no
        // leftover, no double-count -- rather than one delegate's claim
        // against the full credit, which stopped being a meaningful
        // comparison once a credit can legitimately back more than one
        // registration at less than its full amount each.
        //
        // Summed on verified_amount, NOT amount: the question here is whether
        // the CREDIT is fully accounted for, which is about what was
        // allocated against it, not what the delegate originally claimed.
        // Those differ whenever a claim was only partly covered -- a delegate
        // claiming 2000 whose transfer was actually 750 has amount 2000 and
        // verified_amount 750 against a 750 credit, and summing the claim made
        // a perfectly reconciled credit report as a mismatch. Same precedence
        // as allocatedForBankTxn(), the authority on what a credit has left.
        const totalLinked = creditLinks.reduce(
          (sum, l) => sum + (l.verified_amount != null ? l.verified_amount : (l.amount || 0)), 0);
        const amountOk = Math.abs(Number(t.credit) - totalLinked) < 0.5;
        for (const link of creditLinks) {
          const reg = regById.get(link.registration_id);
          if (!reg) continue; // linked to a registration with no UTR on file -- shouldn't happen, skip defensively
          matchedRegIds.add(reg.id);
          // This delegate's own PORTION of the credit -- what was allocated from
          // it, not what they claimed. Sending the claim made a partly-covered
          // payment render as "2,000 of 750".
          matched.push({
            ...reg, transaction: t, amountOk,
            linkedAmount: link.verified_amount != null ? link.verified_amount : link.amount,
          });
        }
        continue;
      }
      let reg = null;
      if (t.extracted_ref) {
        const candidate = regByUtr.get(digits(t.extracted_ref));
        if (candidate && !regIdsWithTxnRows.has(candidate.id)) reg = candidate;
      }
      if (!reg) { unmatchedCredits.push(t); continue; }
      matchedRegIds.add(reg.id);
      const claimedAmount = reg.paid_amount != null ? reg.paid_amount : reg.expected_amount;
      const amountOk = claimedAmount == null || Number(t.credit) === Number(claimedAmount);
      matched.push({ ...reg, transaction: t, amountOk, linkedAmount: t.credit });
    }

    // Debits -- money OUT. The reconciliation above is credit-centric by
    // design (it answers "has every rupee in been accounted for"), which
    // means nothing on this page has ever shown a debit at all: they are
    // imported from the statement and then only ever surface inside one
    // registration's refund picker. So a bank charge, a wrong transfer, or a
    // refund paid out against a delegate who was later deleted is money that
    // has left the account with no view that admits it exists.
    //
    // A debit is either a refund we made (linked 1-to-1 to a payment_refunds
    // row -- see the UNIQUE index on bank_txn_id) or it is something else,
    // and "something else" is exactly what is worth showing. The LEFT JOIN
    // keeps unlinked debits rather than dropping them, since those are the
    // ones that need an explanation.
    const debitRows = await dbAll(`
      SELECT bt.*,
             pr.id AS refund_id, pr.amount AS refund_amount, pr.reference_note,
             pr.refunded_by, pr.refunded_at,
             r.id AS refund_registration_id, r.registration_number, r.delegate_name
        FROM bank_statement_transactions bt
        LEFT JOIN payment_refunds pr ON pr.bank_txn_id = bt.id
        LEFT JOIN registrations r ON r.id = pr.registration_id
       WHERE bt.debit IS NOT NULL AND bt.debit > 0
       ORDER BY bt.post_date DESC, bt.id DESC`);
    const debits = debitRows.map((d) => ({
      id: d.id, post_date: d.post_date, value_date: d.value_date,
      description: d.description, debit: d.debit, balance: d.balance,
      extracted_ref: d.extracted_ref,
      // A refund whose registration has since been deleted still shows as a
      // refund -- the money left the account either way. The delegate is
      // reported as null rather than the row being demoted to unexplained.
      refund: d.refund_id ? {
        id: d.refund_id, amount: d.refund_amount, note: d.reference_note,
        refundedBy: d.refunded_by, refundedAt: d.refunded_at,
        registrationId: d.refund_registration_id,
        registrationNumber: d.registration_number, delegateName: d.delegate_name,
      } : null,
    }));
    const debitTotal = debits.reduce((sum, d) => sum + (Number(d.debit) || 0), 0);
    const refundedDebitTotal = debits.reduce(
      (sum, d) => sum + (d.refund ? Number(d.debit) || 0 : 0), 0);

    // Registrations (non-rejected, with a reference) that didn't match any credit.
    const unmatched = allRegs
      .filter((r) => r.bank_status !== 'REJECTED' && !matchedRegIds.has(r.id))
      .map((r) => ({ ...r, reason: 'No matching transaction found in the statement.' }));

    res.json({
      matched,
      unmatched,
      unmatchedCredits,
      nonRegistrationCredits,
      debits,
      summary: {
        registrations: allRegs.filter((r) => r.bank_status !== 'REJECTED').length,
        matched: matched.length,
        amountMismatches: matched.filter((m) => !m.amountOk).length,
        unmatched: unmatched.length,
        unmatchedCredits: unmatchedCredits.length,
        nonRegistrationCredits: nonRegistrationCredits.length,
        credits: txns.length,
        debits: debits.length,
        debitTotal,
        refundedDebits: debits.filter((d) => d.refund).length,
        refundedDebitTotal,
        unexplainedDebits: debits.filter((d) => !d.refund).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Consolidated "who did what, when" view across the admin surface --
// statement imports, transaction linking, registration approval decisions,
// abstract approval/allotment, and master-data (workshop/QI/fee) edits.
app.get('/api/admin/activity-log', requirePermission('system.activity_log'), async (req, res, next) => {
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
    // -- resolve those to "<Group>: <Option>" names for display.
    const optionRows = await dbAll(
      `SELECT o.id, o.name, g.name AS group_name FROM program_options o LEFT JOIN program_groups g ON g.id = o.group_id`);
    const optionName = new Map(optionRows.map((o) => [String(o.id), `${o.group_name ? o.group_name + ': ' : ''}${o.name}`]));
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
// CASH and BANK_TRANSFER only ever appear on a registration created via
// POST /api/admin/registrations (the delegate self-service form never
// offers either) -- CASH because the admin's own presence at the desk
// substitutes for the screenshot/OCR proof every other mode requires, and
// BANK_TRANSFER because the admin is linking a credit already visible in
// the imported statement rather than a specific UPI/NEFT method the
// delegate declared themselves.
const PAYMENT_MODE_LABELS = { UPI: 'UPI', NEFT_RTGS: 'NEFT / RTGS', CASH: 'Cash / At Desk', BANK_TRANSFER: 'Bank Transfer (Admin-Linked)' };
// Human-readable labels for a registration's bank_status, used everywhere it's
// displayed (reports, etc.) instead of the raw DB constant (e.g. BANK_VERIFIED).
const BANK_STATUS_LABELS = { PENDING: 'Pending', BANK_VERIFIED: 'Verified', REJECTED: 'Rejected', PARTIAL_PAYMENT: 'Partial Payment' };

async function buildReport(type, opts = {}) {
  if (type === 'delegates') {
    const rows = (await dbAll(
      `SELECT registrations.registration_number, delegate_name, ${DELEGATE_SALUTATION_COLUMN}, registrations.phone_number AS phone_number,
         u.age, u.gender, u.designation, u.institution, u.district, u.state, u.pincode, u.country, u.email, u.phone
         FROM registrations
         LEFT JOIN users u ON u.phone_number = registrations.phone_number
         WHERE registrations.bank_status = 'BANK_VERIFIED'
         ORDER BY registrations.registration_number`)).map(withDelegateSalutation);
    return {
      title: 'Registered Delegates — Demography & Institute Details',
      sections: [{
        columns: ['Reg No', 'Name', 'Age', 'Gender', 'Mobile', 'Email', 'Designation', 'Institution', 'District', 'State', 'Pincode', 'Country'],
        rows: rows.map((r) => [r.registration_number, r.delegate_name, r.age, r.gender, displayPhone(r), r.email, r.designation, r.institution, r.district, r.state, r.pincode, r.country || 'India']),
      }],
    };
  }
  // One row per delegate, one COLUMN per program group -- the complement to
  // the 'workshops' report above, which is one section per option. This
  // shape is what you want for a spreadsheet (sort/filter/pivot by group);
  // that one is what you want for a printed door list.
  //
  // Scope is every non-rejected registration, matching how enrollment is
  // counted everywhere else (fetchProgramOptions holds a capacity slot for
  // any non-rejected registration) -- so the per-group totals here reconcile
  // with the per-option rosters. A Status column keeps that unambiguous,
  // since it means pending registrations are included too.
  if (type === 'delegate-programs') {
    const groups = await fetchProgramGroups({ activeOnly: false });
    const rows = (await dbAll(
      `SELECT registrations.id, registrations.registration_number, delegate_name, ${DELEGATE_SALUTATION_COLUMN},
         registrations.phone_number AS phone_number, category_label, bank_status,
         u.email, u.designation, u.institution
         FROM registrations
         LEFT JOIN users u ON u.phone_number = registrations.phone_number
         WHERE registrations.bank_status != 'REJECTED'
         ORDER BY registrations.registration_number`)).map(withDelegateSalutation);

    // One batched query rather than a join per group -- works the same
    // whether there are two groups or ten.
    const selRows = await dbAll(
      `SELECT ro.registration_id, ro.group_id, ro.is_faculty, o.name AS option_name
         FROM registration_options ro
         JOIN program_options o ON o.id = ro.option_id
         ORDER BY o.name`);
    const byReg = new Map();
    for (const s of selRows) {
      if (!byReg.has(s.registration_id)) byReg.set(s.registration_id, new Map());
      const perGroup = byReg.get(s.registration_id);
      // Faculty are attached to an option without occupying a capacity slot
      // (see fetchProgramOptions), so the roster has to say which they are.
      const label = s.option_name + (s.is_faculty ? ' (Faculty)' : '');
      perGroup.set(s.group_id, [...(perGroup.get(s.group_id) || []), label]);
    }

    return {
      title: 'Delegates & Program Selections',
      sections: [{
        columns: ['Reg No', 'Name', 'Mobile', 'Email', 'Designation', 'Institution', 'Category', 'Status',
          ...groups.map((g) => g.name)],
        rows: rows.map((r) => {
          const perGroup = byReg.get(r.id) || new Map();
          return [r.registration_number, r.delegate_name, displayPhone(r), r.email, r.designation, r.institution,
            r.category_label, BANK_STATUS_LABELS[r.bank_status] || r.bank_status,
            // join, not [0]: a group configured with max_select > 1 can
            // legitimately hold several options for one delegate.
            ...groups.map((g) => (perGroup.get(g.id) || []).join('; '))];
        }),
      }],
    };
  }
  if (type === 'payments') {
    const rows = (await dbAll(
      `SELECT id, registration_number, delegate_name, ${DELEGATE_SALUTATION_COLUMN}, phone_number, category_label,
         payment_mode, utr_number, paid_amount, expected_amount, bank_status, submitted_at
         FROM registrations ORDER BY registration_number`)).map(withDelegateSalutation);
    // Same verified-total-minus-refunds computation as GET /api/registrations
    // and getPaymentSummary -- paid_amount above is just the claimed amount
    // at submission, not the cumulative verified total across every linked
    // bank credit, so it can't show excess on its own.
    const allVerifiedTxns = await dbAll(
      "SELECT registration_id, amount, verified_amount FROM payment_transactions WHERE txn_status = 'VERIFIED'");
    const verifiedByReg = {};
    for (const t of allVerifiedTxns) {
      verifiedByReg[t.registration_id] = (verifiedByReg[t.registration_id] || 0) + (t.verified_amount != null ? t.verified_amount : (t.amount || 0));
    }
    const allRefunds = await dbAll('SELECT registration_id, amount FROM payment_refunds');
    const refundedByReg = {};
    for (const r of allRefunds) refundedByReg[r.registration_id] = (refundedByReg[r.registration_id] || 0) + (r.amount || 0);

    const fmtDate = (ms) => ms ? new Date(Number(ms)).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '';
    return {
      title: 'Delegate Payment Details & Status',
      sections: [{
        columns: ['Reg No', 'Delegate', 'Mobile', 'Category', 'Mode', 'UTR / Txn No.', 'Amount Paid', 'Expected Amount', 'Excess Paid', 'Status', 'Submitted'],
        rows: rows.map((r) => {
          const netVerified = (verifiedByReg[r.id] || 0) - (refundedByReg[r.id] || 0);
          const overpaid = Math.max(0, netVerified - (r.expected_amount || 0));
          return [r.registration_number, r.delegate_name, displayPhone(r), r.category_label,
            PAYMENT_MODE_LABELS[r.payment_mode] || r.payment_mode, r.utr_number, r.paid_amount, r.expected_amount,
            overpaid > 0 ? overpaid : '', BANK_STATUS_LABELS[r.bank_status] || r.bank_status, fmtDate(r.submitted_at)];
        }),
      }],
    };
  }
  if (type === 'workshops') {
    const groups = await fetchProgramGroups({ activeOnly: false });
    const allOptions = groups.flatMap((g) => g.options.map((o) => ({ ...o, group_name: g.name })));
    const options = allOptions.filter((o) => !opts.optionId || String(o.id) === String(opts.optionId));
    const columns = ['Reg No', 'Delegate', 'Mobile', 'Category', 'Status', 'Role'];
    // Faculty listed first within each section, ahead of the attendee list.
    const rowsFor = async (optionId) => {
      const rows = (await dbAll(
        `SELECT registrations.registration_number, delegate_name, ${DELEGATE_SALUTATION_COLUMN}, registrations.phone_number, category_label, bank_status, ro.is_faculty
           FROM registration_options ro
           JOIN registrations ON registrations.id = ro.registration_id
           WHERE ro.option_id = ? AND bank_status != 'REJECTED'
           ORDER BY ro.is_faculty DESC, delegate_name`,
        [optionId]
      )).map(withDelegateSalutation);
      return rows.map((r) => [r.registration_number, r.delegate_name, displayPhone(r), r.category_label,
        BANK_STATUS_LABELS[r.bank_status] || r.bank_status, r.is_faculty ? 'Faculty' : 'Delegate']);
    };
    const sections = [];
    for (const o of options) {
      sections.push({ name: `${o.group_name}: ${o.name}`, columns, rows: await rowsFor(o.id) });
    }
    return { title: opts.optionId && options[0] ? `Registrations — ${options[0].name}` : 'Registrations per Program Option', sections };
  }
  if (type === 'users') {
    // Every column the users table actually has, plus the registration
    // snapshot already joined in for the Users tab (see GET /api/users) --
    // same source of truth, just exported wholesale instead of paginated in
    // a table.
    const rows = await dbAll(`
      SELECT users.*, r.id AS registration_id, r.bank_status AS registration_status
        FROM users
        LEFT JOIN registrations r ON r.phone_number = users.phone_number
       ORDER BY users.created_at ASC, users.full_name ASC`);
    const selRows = await dbAll(
      `SELECT ro.registration_id, g.name AS group_name, o.name AS option_name
         FROM registration_options ro
         JOIN program_options o ON o.id = ro.option_id
         JOIN program_groups g ON g.id = ro.group_id
         ORDER BY g.sort_order, g.id, o.name`);
    const selByReg = new Map();
    for (const s of selRows) {
      const line = `${s.group_name}: ${s.option_name}`;
      selByReg.set(s.registration_id, [...(selByReg.get(s.registration_id) || []), line]);
    }
    const fmtDate = (ms) => ms ? new Date(Number(ms)).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '';
    return {
      title: 'All Users — Full Directory',
      sections: [{
        columns: ['Reg No', 'Salutation', 'Name', 'Mobile', 'Role', 'Age', 'Gender', 'Email',
          'Designation', 'Institution', 'Post Office', 'District', 'State', 'Pincode', 'Country', 'Signed Up',
          'Registration Status', 'Program Selections'],
        rows: rows.map((u) => [u.registration_number, u.salutation, u.full_name, displayPhone(u), u.role,
          u.age, u.gender, u.email, u.designation, u.institution, u.post_office, u.district, u.state, u.pincode,
          u.country || 'India',
          fmtDate(u.created_at), u.registration_status ? (BANK_STATUS_LABELS[u.registration_status] || u.registration_status) : 'Not Registered',
          (selByReg.get(u.registration_id) || []).join('; ')]),
      }],
    };
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

// Filename-safe conference tag for report downloads, e.g. "nqocn2026" ->
// nqocn2026-delegates-report.csv. regPrefix is tried first because it's
// already validated to [A-Za-z0-9]{1,20} (see the general-settings PUT), so
// it needs no cleaning; acronym is free text and does. The fallback matters:
// a fresh install has both blank by design, and without it the download
// would be named "-delegates-report.csv".
//
// Slugifying also keeps admin-supplied text out of the raw header -- acronym
// is editable from Settings → General, and a value containing a quote or a
// line break would otherwise break (or inject into) Content-Disposition.
function reportFilePrefix() {
  const slug = String(CONFERENCE.regPrefix || CONFERENCE.acronym || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'conference';
}

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
  <h1>${escapeHtml(CONFERENCE.acronym)} · ${escapeHtml(rep.title)}</h1>
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
    if (!can(req.session.role, REPORT_PERMISSIONS.workshops)) {
      return res.status(403).json({ success: false, error: 'You do not have permission for this report.' });
    }
    const groups = await fetchProgramGroups({ activeOnly: false });
    const options = groups.flatMap((g) => g.options.map((o) => ({ id: o.id, groupName: g.name, name: o.name })));
    res.json({ options });
  } catch (err) {
    next(err);
  }
});

app.get('/api/admin/reports/:type', requireAuth, async (req, res, next) => {
  try {
    const type = req.params.type;
    const permission = REPORT_PERMISSIONS[type];
    if (!permission) return res.status(404).json({ success: false, error: 'Unknown report.' });
    if (!can(req.session.role, permission)) {
      return res.status(403).json({ success: false, error: 'You do not have permission for this report.' });
    }
    if (type === 'workshops' && !req.query.optionId) {
      return res.status(400).json({ success: false, error: 'Select a workshop or QI practice first.' });
    }
    const rep = await buildReport(type, { optionId: req.query.optionId });
    res.set('Cache-Control', 'private, no-store');
    if (req.query.format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${reportFilePrefix()}-${type}-report.csv"`);
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
app.get('/api/abstracts', requirePermission('abstracts.view'), async (req, res, next) => {
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

// Step 1 of abstract review: Approval. Accept/reject/reset/send-back-for-
// corrections. Deliberately silent for UNDER_REVIEW/ACCEPTED -- no delegate
// email fires there. Approval only unlocks the abstract for the separate
// Assignment step (below); the delegate hears from us once, when that step
// gives the final decision (accepted + oral/poster, or not accepted). This
// lets approval and assignment happen as two independent actions, in
// separate sessions, possibly by different reviewers. REVISION_REQUESTED is
// the exception: it emails immediately (the delegate needs to act) and,
// unlike the other statuses, reopens POST /api/abstracts for that one
// delegate to edit and resubmit (see there).
app.put('/api/abstracts/:id/status', requirePermission('abstracts.review'), async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowed = ['UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'REVISION_REQUESTED'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid abstract status.' });
    }
    // A note is the whole point here -- without it the delegate has no idea
    // what to fix, and the reviewer's own review cycle just repeats.
    const note = status === 'REVISION_REQUESTED' ? String(req.body.note || '').trim() : null;
    if (status === 'REVISION_REQUESTED' && !note) {
      return res.status(400).json({ success: false, error: 'Enter a note explaining what the delegate needs to correct.' });
    }

    const existing = await dbGet('SELECT status, phone_number, author_name, title FROM abstracts WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Abstract not found.' });
    }

    // Resetting away from ACCEPTED clears any assignment; moving to any
    // status other than REVISION_REQUESTED clears its note, the same way
    // allocation only ever means something while status is ACCEPTED.
    if (status === 'ACCEPTED') {
      await dbRun('UPDATE abstracts SET status = ?, revision_note = NULL WHERE id = ?', [status, req.params.id]);
    } else {
      await dbRun('UPDATE abstracts SET status = ?, allocation = NULL, revision_note = ? WHERE id = ?', [status, note, req.params.id]);
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
      notifyDelegate(existing.phone_number, 'Your abstract submission — decision',
        emailWrap('Abstract decision',
          `<p>Dear ${escapeHtml(existing.author_name)},</p>
           <p>Thank you for submitting your abstract, <b>"${escapeHtml(existing.title)}"</b>. After review by the scientific committee, we regret that it has not been accepted for the ${escapeHtml(CONFERENCE.name)}.</p>`));
    }
    if (status === 'REVISION_REQUESTED') {
      notifyDelegate(existing.phone_number, 'Your abstract needs corrections',
        emailWrap('Corrections requested',
          `<p>Dear ${escapeHtml(existing.author_name)},</p>
           <p>The scientific committee has reviewed your abstract, <b>"${escapeHtml(existing.title)}"</b>, and requests some corrections before it can be considered further:</p>
           <blockquote style="margin:0.75rem 0;padding:0.5rem 1rem;border-left:3px solid #c7d2fe;color:#334155">${escapeHtml(note)}</blockquote>
           <p>Please log in to the portal, update your abstract, and resubmit it for review.</p>`));
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Step 2 of abstract review: Assignment (oral/poster), for approved
// abstracts only. This is the delegate's one and only decision email --
// it states both that the abstract was accepted and the final format.
app.put('/api/abstracts/:id/allocation', requirePermission('abstracts.review'), async (req, res, next) => {
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
//
// Waits for registrationsMigrationReady first -- backfillPaymentTransactionsOnBoot
// further down this chain reads several columns (expected_amount, the ocr_*
// matches, payment_mode, submitted_at, bank_txn_id, rejection_reason/note)
// that only exist once that migration has actually run; on a fresh install,
// this chain's own query would otherwise be queued (and would start
// executing) before that migration even begins -- see the promise's
// declaration, above the big db.serialize() block, for why.
registrationsMigrationReady.then(retitleNamesOnBoot)
  .catch((err) => console.error('Title-case backfill failed (continuing to start):', err.message))
  .then(() => splitSalutationsOnBoot().catch((err) => console.error('Salutation split failed (continuing to start):', err.message)))
  .then(() => migrateProgramGroupsOnBoot().catch((err) => console.error('Program-groups migration failed (continuing to start):', err.message)))
  .then(() => backfillPaymentTransactionsOnBoot().catch((err) => console.error('Payment-transaction backfill failed (continuing to start):', err.message)))
  .then(() => autoLinkTransactions().catch((err) => console.error('Bank-transaction auto-link failed (continuing to start):', err.message)))
  .then(() => loadNotificationToggles().catch((err) => console.error('Notification-toggle load failed (continuing to start):', err.message)))
  .then(() => loadMaintenanceMode().catch((err) => console.error('Maintenance-mode load failed (continuing to start):', err.message)))
  .then(() => loadGeneralSettings().catch((err) => console.error('General-settings load failed (continuing to start):', err.message)))
  // Before the server accepts a request: every permission check reads this
  // cache, and an empty one falls back to the built-in catalogue with a loud
  // line in the log rather than refusing everybody.
  .then(() => seedRolesOnBoot().catch((err) => console.error('Role seed failed (falling back to the built-in catalogue):', err.message)))
  // COOKIE_SECURE may have just been overlaid from schema_meta above, so this
  // has to run after loadGeneralSettings(), not at module-load time.
  .then(() => { if (COOKIE_SECURE) app.set('trust proxy', 1); })
  .then(startServer);

// Every admin route must state a permission.
//
// The dangerous failure in this migration is not a route guarded by the
// wrong permission -- that locks someone out, loudly, and is fixed in
// minutes. It is a route that ends up guarded by NOTHING, which is silently
// reachable by anyone with a session. So the router is walked at boot and
// audited against the catalogue, and a route that carries no permission
// stops the server rather than serving unguarded.
//
// Deliberately reads the live router rather than the source: a route added
// tomorrow is covered without anyone remembering this exists.
function auditRoutePermissions() {
  const stack = (app._router && app._router.stack) || [];
  const unguarded = [];
  let guarded = 0;
  for (const layer of stack) {
    if (!layer.route) continue;
    const routePath = layer.route.path;
    if (typeof routePath !== 'string') continue;
    // Admin surface: everything under /api/admin, plus the /api/users and
    // /api/abstracts trees, which are admin-only despite the path.
    const isAdmin = routePath.startsWith('/api/admin')
      || routePath.startsWith('/api/users')
      || routePath.startsWith('/api/abstracts');
    const handlers = layer.route.stack.map((h) => h.handle);
    const permission = handlers.map((h) => h.permission).find(Boolean);
    if (permission) { guarded++; continue; }
    if (!isAdmin) continue;
    // A few routes on admin-looking paths gate inside the handler instead:
    // the two report routes, which choose their rule by report name, and the
    // delegate's own abstract endpoints, which are scoped to the caller's own
    // session rather than to a role. Listed rather than inferred, so adding
    // one is a deliberate act someone has to write down -- and listed by
    // METHOD as well as path, because GET /api/abstracts is the admin list
    // while POST /api/abstracts is a delegate submitting their own.
    const GATED_INSIDE = new Set([
      'GET /api/admin/reports/:type',
      'GET /api/admin/reports/workshops/options',
      'POST /api/abstracts',
      'GET /api/abstracts/me',
    ]);
    const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase());
    const unlisted = methods.filter((m) => !GATED_INSIDE.has(`${m} ${routePath}`));
    if (!unlisted.length) continue;
    unguarded.push(`${unlisted.join('/')} ${routePath}`);
  }
  if (unguarded.length) {
    console.error('\nFATAL: admin route(s) with no permission:\n  ' + unguarded.join('\n  ')
      + '\n\nGive each one a requirePermission(), or add it to GATED_INSIDE with a reason.\n');
    process.exit(1);
  }
  return guarded;
}

function startServer() {
const guardedRoutes = auditRoutePermissions();
app.listen(PORT, () => {
  const roleCount = roleCache ? roleCache.size : 0;
  console.log(`Access control: ${guardedRoutes} routes guarded by permission, `
    + `${PERMISSION_KEYS.length} permissions, ${roleCount} role(s) loaded`
    + (roleCount ? '' : ' — FALLING BACK to the built-in catalogue'));
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`SMS OTP: ${smsEnabled() ? 'ENABLED (Vynttra)' : 'disabled (no SMS_API_KEY)'}`);
  console.log(`Email: ${emailEnabled() ? `ENABLED (SES, from ${EMAIL.from})` : 'disabled (no AWS/SES config)'}`);
  if (OTP_ECHO && !smsEnabled()) console.log('[dev] OTP echo is ON — codes are returned to the client and logged here.');
});
}
