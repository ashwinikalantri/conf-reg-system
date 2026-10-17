// Reminders: who an email can go to, and what can be filled in for them.
//
// One composer on the Reminders tab sends to any of these audiences. Each
// names:
//   key / label / group / description -- how it is listed;
//   action       -- the audit action one row per recipient is written under.
//                   It is also the 24-hour cooldown's key and what "last
//                   reminded" reads, so these must not change: the names of
//                   the audiences that existed before the composer are kept;
//   placeholders -- what {{...}} it can fill in per recipient;
//   required     -- placeholders an email to it must keep ({{codes}}: without
//                   it nobody would learn which code is theirs);
//   filters      -- what narrows it (an email domain, a category, a status);
//   cooldown     -- 'person': one email per person per 24 hours, whatever it
//                   says; 'message': the same subject not twice to an address
//                   in 24 hours (pasted addresses, which hear many different
//                   announcements).
// The database side -- who is in each audience today -- is in server.js
// (audienceRecipients); this file is pure, so it can be tested on its own.

const AUDIENCES = [
  { key: 'signups', label: 'Signed up, not registered', group: 'Not registered yet',
    description: 'Everyone with an account who has never submitted a registration.',
    action: 'REGISTRATION_REMINDER_SENT', placeholders: ['name'] },
  { key: 'faculty', label: 'Faculty, not registered', group: 'Not registered yet',
    description: 'Faculty on the Faculty list (not cancelled) who have not registered -- with or without an account.',
    action: 'FACULTY_REMINDER_SENT', placeholders: ['name'] },
  { key: 'domain', label: 'By email domain', group: 'Not registered yet',
    description: 'Accounts whose email address is at a domain you choose (e.g. mgims.ac.in) and who have not registered.',
    action: 'DOMAIN_REMINDER_SENT', placeholders: ['name'], filters: ['domain'] },
  { key: 'unverified', label: 'Email not verified', group: 'Not registered yet',
    description: 'Accounts that have not verified their email address and have not registered. A domain or personal code waits on a verified address.',
    action: 'EMAIL_UNVERIFIED_REMINDER_SENT', placeholders: ['name'] },
  { key: 'abstract', label: 'Abstract submitted, not registered', group: 'Not registered yet',
    description: 'Authors whose abstract is under review or approved, but who have not registered. Registration is mandatory for presentation.',
    action: 'ABSTRACT_UNREGISTERED_REMINDER_SENT', placeholders: ['name', 'title'] },
  { key: 'codes', label: 'Unused personal codes', group: 'Not registered yet',
    description: 'Everyone holding a personal code they can still use -- including codes waiting for someone to sign up with the address.',
    action: 'CODE_HOLDER_REMINDER_SENT', placeholders: ['name', 'codes'], required: ['codes'] },
  { key: 'registered', label: 'Registered delegates', group: 'Registered',
    description: 'Everyone who has registered, whatever their payment status. Narrow by category or status.',
    action: 'REGISTERED_DELEGATE_REMINDER_SENT', placeholders: ['name'], filters: ['category', 'status'] },
  { key: 'balance', label: 'Balance payment due', group: 'Registered',
    description: 'Registrations with a balance still to pay.',
    action: 'BALANCE_DUE_REMINDER_SENT', placeholders: ['name', 'amount'] },
  { key: 'paste', label: 'Pasted addresses', group: 'Anyone',
    description: 'Any email addresses you paste -- they need no account here. Nothing is known about them, so nothing is filled in.',
    action: 'CUSTOM_REMINDER_SENT', placeholders: [], cooldown: 'message' },
].map((a) => ({ required: [], filters: [], cooldown: 'person', ...a }));

const AUDIENCE_BY_KEY = Object.fromEntries(AUDIENCES.map((a) => [a.key, a]));
const AUDIENCE_BY_ACTION = Object.fromEntries(AUDIENCES.map((a) => [a.action, a]));

const PLACEHOLDERS = {
  name: 'Their name, with salutation',
  title: 'Their abstract\'s title',
  codes: 'Their own code(s): what each gives and its last date',
  amount: 'The balance they still owe',
};

// Every {{word}} in a text, once each, in order of appearance.
function placeholdersIn(text) {
  const seen = [];
  for (const m of String(text || '').matchAll(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g)) {
    const k = m[1].toLowerCase();
    if (!seen.includes(k)) seen.push(k);
  }
  return seen;
}

// What would go out wrong: a placeholder this audience cannot fill (it would
// arrive as a literal "{{name}}"), and a required one left out. Checked on
// the subject and body together, the way the recipient reads them.
function placeholderProblems(audience, subject, bodyHtml) {
  const a = typeof audience === 'string' ? AUDIENCE_BY_KEY[audience] : audience;
  const used = placeholdersIn(`${subject || ''}\n${bodyHtml || ''}`);
  return {
    unsupported: used.filter((p) => !a.placeholders.includes(p)),
    missing: a.required.filter((p) => !placeholdersIn(bodyHtml).includes(p)),
  };
}

// The error to send back for those problems, or null.
function placeholderError(audience, subject, bodyHtml) {
  const a = typeof audience === 'string' ? AUDIENCE_BY_KEY[audience] : audience;
  const { unsupported, missing } = placeholderProblems(a, subject, bodyHtml);
  if (missing.length) {
    return `Keep ${missing.map((p) => `{{${p}}}`).join(', ')} in the email -- it is where each person's own ${missing.includes('codes') ? 'code goes' : 'details go'}.`;
  }
  if (unsupported.length) {
    return `${unsupported.map((p) => `{{${p}}}`).join(', ')} cannot be filled in for "${a.label}" -- it would arrive as typed. Remove it, or choose an audience that has it.`;
  }
  return null;
}

// Fill each {{placeholder}} with its value. Values are HTML, already escaped
// by the caller (a name is text; {{codes}} is a block of markup). A
// placeholder with no value is left as it is -- placeholderError() has
// already refused to send one.
function fillPlaceholders(text, values) {
  return String(text || '').replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (whole, k) => {
    const v = values[k.toLowerCase()];
    return v == null ? whole : String(v);
  });
}

// An email domain as typed -- "@MGIMS.ac.in", " mgims.ac.in " -- stored bare
// and lower-case; null when it is not one.
function normaliseDomain(raw) {
  const d = String(raw || '').trim().replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

// Sends made before the Sent history existed are only in the activity log,
// one row per recipient. Group them back into sends: the same action, by the
// same person, with the same subject, each row within an hour of the last.
// Rows must arrive oldest first. Balance reminders logged "Subject (₹x due)"
// -- the amount is per person, so it is not part of the subject.
function groupLegacySends(rows) {
  const sends = [];
  const open = new Map();
  for (const r of rows) {
    const subject = String(r.new_value || '').replace(/ \(₹[\d,]+ due\)$/, '');
    const key = `${r.action}\u0000${r.actor_phone}\u0000${subject}`;
    const last = open.get(key);
    if (last && r.created_at - last.lastAt <= 60 * 60 * 1000) {
      last.count += 1;
      last.lastAt = r.created_at;
      last.recipients.push(r.entity_id);
      continue;
    }
    const a = AUDIENCE_BY_ACTION[r.action];
    const send = {
      id: `legacy-${r.id}`, legacy: true,
      audience: a ? a.key : null, audienceLabel: a ? a.label : r.action,
      subject, sentBy: r.actor_name || r.actor_phone, createdAt: r.created_at,
      count: 1, lastAt: r.created_at, recipients: [r.entity_id],
    };
    sends.push(send);
    open.set(key, send);
  }
  return sends;
}

module.exports = {
  AUDIENCES, AUDIENCE_BY_KEY, AUDIENCE_BY_ACTION, PLACEHOLDERS,
  placeholdersIn, placeholderProblems, placeholderError, fillPlaceholders, normaliseDomain, groupLegacySends,
};
