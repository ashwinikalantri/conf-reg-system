#!/usr/bin/env node
// Daily 9am email to the finance/admin team: how many registrations are
// pending approval (with a preview list) and how many are paid & verified
// so far. Runs standalone (via cron), not through the Express app, the same
// way backup.sh talks to the DB directly rather than going through PM2 --
// keeps this independent of whether the app process is healthy.
'use strict';

const path = require('path');
const APP_DIR = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(APP_DIR, '.env') });

// Node 16 exposes node:crypto as globalThis.crypto, which lacks the Web
// Crypto getRandomValues the AWS SDK v3 (SES) requires -- same polyfill as
// server.js's top-of-file fix (Node 20+ has this natively).
const { webcrypto } = require('crypto');
if (typeof (globalThis.crypto && globalThis.crypto.getRandomValues) !== 'function') {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
}

const sqlite3 = require('sqlite3').verbose();
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');

// These five start from the .env-derived defaults but are overridden in
// main() by whatever's in schema_meta -- the server's Settings > General page
// persists conference name / email from-address / from-name / region there
// (not to .env), and this script runs standalone via cron with no other way
// to see a change made through that UI. Without this resync, a super admin
// updating "From address" in the portal would see it apply immediately to
// the live app but never to this digest, which would keep sending from the
// stale address indefinitely.
let CONFERENCE_NAME = 'International Conference on Healthcare Quality & Patient Safety 2026';
const PORTAL_URL = process.env.PORTAL_URL || 'https://registration.mgims.ac.in';
let EMAIL_FROM = (process.env.SES_FROM || '').trim();
let EMAIL_FROM_NAME = process.env.SES_FROM_NAME || 'NQOCN 2026';
let EMAIL_REGION = (process.env.AWS_REGION || '').trim();
let EMAIL_FROM_FORMATTED = EMAIL_FROM ? `"${EMAIL_FROM_NAME.replace(/"/g, '')}" <${EMAIL_FROM}>` : EMAIL_FROM;

// Pulls the same schema_meta keys server.js's loadGeneralSettings() applies,
// and re-derives the two values computed from them.
async function resyncFromSchemaMeta(db) {
  const keys = ['conference_name', 'email_from', 'email_from_name', 'email_region'];
  const rows = await dbAll(db, `SELECT key, value FROM schema_meta WHERE key IN (${keys.map(() => '?').join(',')})`, keys);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (byKey.conference_name) CONFERENCE_NAME = byKey.conference_name;
  if (byKey.email_from) EMAIL_FROM = byKey.email_from;
  if (byKey.email_from_name) EMAIL_FROM_NAME = byKey.email_from_name;
  if (byKey.email_region) EMAIL_REGION = byKey.email_region;
  EMAIL_FROM_FORMATTED = EMAIL_FROM ? `"${EMAIL_FROM_NAME.replace(/"/g, '')}" <${EMAIL_FROM}>` : EMAIL_FROM;
}

// Recipients are looked up by phone number (stable identifier) rather than
// a hardcoded email list, so this keeps working if someone updates their
// email address in Users & Roles.
const RECIPIENT_PHONES = ['7440977777', '7083170552', '9167565576']; // Ashwini Kalantri, Abhishek V. Raut, Dipak Kumar Das

const MAX_ROWS_SHOWN = 10;

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Rupee amount with Indian digit grouping (100000 -> 1,00,000). Manual, since
// toLocaleString('en-IN') falls back to Western grouping without full ICU.
const inr = (v) => {
  const num = typeof v === 'number' ? v : Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  if (!isFinite(num)) return v == null ? '' : String(v);
  const s = String(Math.round(Math.abs(num)));
  const grouped = s.length <= 3 ? s : s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3);
  return (num < 0 ? '-' : '') + grouped;
};

// Mirrors server.js's splitSalutation()/withDelegateSalutation(): the users
// table holds the canonical salutation separately, but delegate_name on the
// registration itself may already carry an embedded title from signup --
// prefer the users.salutation column, and don't double it up if the name
// already starts with one.
function formatDelegateName(name, salutation) {
  const s = String(name == null ? '' : name).trim();
  const m = /^(mrs|mr|ms|dr|prof)[.\s]+(.*)$/i.exec(s);
  const clean = m && m[2].trim() ? m[2].trim() : s;
  const sal = salutation || (m ? m[1] : null);
  return sal ? `${sal} ${clean}` : clean;
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
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

function buildDigestHtml(pending, pendingCount, verifiedCount, dateLabel) {
  const rows = pending.slice(0, MAX_ROWS_SHOWN).map((r) => `
    <tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:.4rem .3rem;font-family:monospace">${escapeHtml(r.registration_number)}</td>
      <td style="padding:.4rem .3rem">${escapeHtml(formatDelegateName(r.delegate_name, r.delegate_salutation))}</td>
      <td style="padding:.4rem .3rem;color:#64748b">${escapeHtml(r.category_label)}</td>
      <td style="padding:.4rem .3rem;text-align:right">₹${inr(escapeHtml(r.expected_amount))}</td>
      <td style="padding:.4rem .3rem;text-align:center">${r.is_flagged ? '⚠️' : '—'}</td>
    </tr>`).join('');
  const moreRow = pending.length > MAX_ROWS_SHOWN
    ? `<tr><td colspan="5" style="padding:.5rem .3rem;color:#94a3b8;font-style:italic">…and ${pending.length - MAX_ROWS_SHOWN} more</td></tr>`
    : '';

  const body = `
    <div style="display:flex;gap:12px;margin:0 0 1.25rem">
      <div style="flex:1;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:.85rem 1rem">
        <div style="font-size:1.5rem;font-weight:700;color:#92400e">${pendingCount}</div>
        <div style="font-size:.72rem;color:#92400e;font-weight:600">Pending Approval</div>
      </div>
      <div style="flex:1;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:.85rem 1rem">
        <div style="font-size:1.5rem;font-weight:700;color:#065f46">${verifiedCount}</div>
        <div style="font-size:.72rem;color:#065f46;font-weight:600">Paid &amp; Verified</div>
      </div>
    </div>
    ${pending.length ? `
    <p style="font-size:.85rem;margin:0 0 .5rem;font-weight:600;color:#334155">Registrations awaiting approval</p>
    <table style="width:100%;border-collapse:collapse;font-size:.78rem">
      <thead>
        <tr style="text-align:left;color:#64748b;border-bottom:1px solid #e2e8f0">
          <th style="padding:.4rem .3rem;font-weight:600">Reg No</th>
          <th style="padding:.4rem .3rem;font-weight:600">Name</th>
          <th style="padding:.4rem .3rem;font-weight:600">Category</th>
          <th style="padding:.4rem .3rem;font-weight:600;text-align:right">Amount</th>
          <th style="padding:.4rem .3rem;font-weight:600;text-align:center">Flag</th>
        </tr>
      </thead>
      <tbody>${rows}${moreRow}</tbody>
    </table>` : `<p style="font-size:.85rem;color:#64748b">Nothing pending approval right now.</p>`}
    <div style="text-align:center;margin:1.25rem 0 .5rem">
      <a href="${PORTAL_URL}/admin" style="display:inline-block;background:#4338ca;color:#fff;text-decoration:none;font-size:.8rem;font-weight:600;padding:.6rem 1.4rem;border-radius:8px">Open Registration Approval →</a>
    </div>`;

  return emailWrap(`Daily Registration Summary — ${dateLabel}`, body);
}

async function main() {
  const db = new sqlite3.Database(path.join(APP_DIR, 'conference.db'), sqlite3.OPEN_READONLY);
  try {
    await resyncFromSchemaMeta(db);

    const pending = await dbAll(db,
      `SELECT registration_number, delegate_name,
              (SELECT salutation FROM users WHERE users.phone_number = registrations.phone_number) AS delegate_salutation,
              category_label, expected_amount, is_flagged, submitted_at
         FROM registrations WHERE bank_status = 'PENDING' ORDER BY submitted_at ASC`);
    const verified = await dbGet(db, `SELECT COUNT(*) AS n FROM registrations WHERE bank_status = 'BANK_VERIFIED'`);
    const recipients = await dbAll(db,
      `SELECT email, full_name FROM users WHERE phone_number IN (${RECIPIENT_PHONES.map(() => '?').join(',')}) AND email IS NOT NULL AND email != ''`,
      RECIPIENT_PHONES);

    const dateLabel = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const html = buildDigestHtml(pending, pending.length, verified.n, dateLabel);
    const subject = `Daily Registration Summary — ${dateLabel}`;

    if (!EMAIL_FROM || !process.env.AWS_ACCESS_KEY_ID || !EMAIL_REGION) {
      console.error('Email not configured (missing SES_FROM/AWS credentials); nothing sent.');
      process.exit(1);
    }
    if (!recipients.length) {
      console.error('No recipient emails found for the configured phone numbers; nothing sent.');
      process.exit(1);
    }

    const sesClient = new SESv2Client({ region: EMAIL_REGION });
    for (const r of recipients) {
      try {
        await sesClient.send(new SendEmailCommand({
          FromEmailAddress: EMAIL_FROM_FORMATTED,
          Destination: { ToAddresses: [r.email] },
          Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Html: { Data: html, Charset: 'UTF-8' } } } },
        }));
        console.log(`Sent to ${r.full_name} <${r.email}>`);
      } catch (err) {
        console.error(`Failed to send to ${r.email}:`, err.message);
      }
    }
    console.log(`Digest: ${pending.length} pending, ${verified.n} verified.`);
  } finally {
    db.close();
  }
}

main().catch((err) => { console.error('Daily digest failed:', err); process.exit(1); });
