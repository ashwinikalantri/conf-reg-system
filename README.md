# Conference Registration Portal & RBAC Admin

A self-hosted registration portal for a conference: phone+OTP delegate
signup, payment collection with OCR-assisted verification, workshop/QI-style
program tracks with capacity limits, abstract submission and review, discount
codes, and a role-based admin panel with a full audit trail. Built for one
event (this deployment currently runs the *International Conference on
Healthcare Quality & Patient Safety 2026* / NQOCN 2026 at MGIMS Sevagram),
but the conference's identity, fee structure, and program tracks are all
admin-editable rather than hardcoded — see **Settings → General** below.

Which categories require a student ID upload is admin-editable per category
(Settings → Fees) rather than hardcoded, but the automated OCR check behind
it still only recognizes a nursing/medical × UG/PG vocabulary — see Student
ID verification below for what that means for a non-healthcare deployment.

## How to Run

1. Open your terminal in the project directory.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the server:

   ```bash
   npm start
   ```

4. Delegate portal: <http://localhost:3000>
   Admin panel: <http://localhost:3000/admin>

`conference.db` (SQLite) is created automatically on first run, seeded with
one `SUPER_ADMIN` and a starter set of fee categories and program options.

## SMS OTP (Vynttra)

OTPs are delivered by SMS via the Vynttra JSON API using a registered DLT
template. Set `SMS_API_KEY` to enable it; the sender/entity/template/header
IDs default to this deployment's registered values and are overridable via
env (`SMS_SENDER`, `SMS_ENTITY_ID`, `SMS_TEMPLATE_ID`, `SMS_HEADER_ID`,
`SMS_TYPE`, `SMS_URL`) — or, once the server is running, from **Settings →
General → SMS** in the admin panel (see below). Without an API key, SMS is
skipped and (outside production) the OTP is echoed for local testing.
Sending is fire-and-forget — failures are logged (console and the admin SMS
activity log), never blocking OTP issuance.

Swapping to a different SMS provider means replacing the request body in
`sendOtpSms()` (`server.js`) for that provider's API shape; the admin-editable
fields, the on/off toggle, and the activity log are otherwise provider-agnostic.

## Email notifications (AWS SES)

Delegates provide an email at signup. When SES is configured the portal emails
on payment verification, rejection, abstract acceptance, and abstract
allocation, using the AWS SES v2 SDK. Config comes from the environment
(loaded from a git-ignored `.env` via dotenv):
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and `SES_FROM`
(a verified sender) — the from-address, from-name, and region are also
editable from **Settings → General → Email** once the server is running (see
below). Dormant until set; sends are best-effort and never block a request.
**In your AWS account** you still need to verify the sender/domain, grant the
IAM user `ses:SendEmail`, and request production access to leave the SES
sandbox (in sandbox, only verified recipients receive mail).

## Settings → General (admin, `SUPER_ADMIN` only)

A single admin page (`/admin` → Settings → General) for everything that used
to require editing code and redeploying:

- **Conference Details** — full name, acronym, dates, location, and the
  registration-number prefix, used across confirmation emails, the payment
  receipt, printable reports, the discount-code voucher, and the public
  delegate landing page (dates render as "21–22 Nov 2026" or, spanning
  months, "28 Nov – 2 Dec 2026"). This is the main lever for retargeting the
  portal at a different event. Changing the registration-number prefix only
  affects registrations created after the change — see Registration number
  & receipt below.
- **SMS** — sender ID, gateway URL, DLT entity/template/header IDs, message
  type, and the API key itself, plus the on/off switch (turning SMS off also
  stops login OTPs).
- **Email** — From address, From name, AWS region, and the AWS Access Key ID
  / Secret Access Key, plus the on/off switch.
- **UPI** — the conference's UPI ID (VPA) and payee name shown on the payment
  QR code; the delegate form and the server's OCR screenshot check both read
  this live, so they can never drift apart.
- **Notifications** — the daily-digest recipient list (see below). Picked by
  searching name or phone over the Users table rather than typing raw
  numbers; only the phone number is actually persisted.
- **Other Environment Variables** — a read-only reference showing every other
  env var the server reads (`PORT`, `PORTAL_URL`, `NODE_ENV`, `COOKIE_NAME`,
  `COOKIE_SECURE`, `OTP_ECHO`), its effective value, and whether it came from
  `.env` or a coded-in default.

**Where each kind of value lives:** non-secret operational fields (sender IDs,
URLs, from-address, region, UPI ID, conference details) persist to the
`schema_meta` DB table and take effect immediately. **Credentials**
(`SMS_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) are never
written to the database — saving one rewrites the line in the server's
`.env` file on disk (preserving everything else in it) and updates the
running process's environment immediately, so no restart is needed but the
change also survives one. The browser is only ever told whether a credential
is set (and, for the non-bearer-secret Access Key ID only, its last 4
characters) — no secret bytes are ever sent to or rendered in the admin UI.
Credential fields reject a value containing a line break, since one could
otherwise inject an unrelated new line into `.env`.

`scripts/daily-digest.js` (an optional cron-run daily summary email listing
pending-approval registrations) is a standalone process independent of the
running server, and re-reads `schema_meta` on every run for the conference
name, email from-address/name/region, and the digest recipient list, so it
stays in sync with changes made on this page. Its default recipient list —
used only if nothing has ever been saved from Settings → General →
Notifications — comes from `DIGEST_RECIPIENT_PHONES` (comma-separated
10-digit numbers) or, failing that, a coded-in default of three phone
numbers from
this deployment's finance/admin team. Recipients are matched by phone number
against Users & Roles (not stored as email addresses), so the list keeps
working if someone's email changes.

## Authentication & sessions

Login is phone + OTP. On success the server issues a server-side session
and sets an `httpOnly`, `SameSite=Lax` cookie (`COOKIE_NAME`, default
`nqocn_sid`, 12-hour life).
Only a hash of the session token and of the OTP is stored in the database.

- OTP is a random 6-digit code, valid for 5 minutes, single-use, capped at
  5 wrong attempts, with a 30-second resend throttle per number.
- Without `SMS_API_KEY` configured (see SMS OTP above), outside production the
  code is logged to the server console and returned in the API response
  (`devOtp`) so you can log in during development. Set `NODE_ENV=production`
  (or `OTP_ECHO=false`) to stop returning it — but then a working SMS gateway
  is required, or nobody can log in.

### Roles (enforced server-side)

| Role                | Access                                              |
| ------------------- | --------------------------------------------------- |
| `SUPER_ADMIN`       | Everything, including settings, user & role management |
| `FINANCE_ADMIN`     | Payment reconciliation, reminders, group discounts (view + verify) |
| `ACADEMIC_REVIEWER` | Abstract review & allotment                          |
| `FINANCE_ACADEMIC`  | Both of the above                                    |
| `DELEGATE`          | Own registration, payment, and abstract submission  |

Admins log in through the normal portal with their own phone number; their
DB role grants access. The database ships with one `SUPER_ADMIN`. Roles can
only be changed by a `SUPER_ADMIN` via the Users screen — they are never
accepted from a login or registration request body.

### Environment variables

| Variable        | Default        | Purpose                                        |
| --------------- | -------------- | ---------------------------------------------- |
| `PORT`               | `3000`         | HTTP port                                      |
| `NODE_ENV`           | –              | `production` disables the dev OTP echo         |
| `OTP_ECHO`           | on if not prod | Force the OTP echo on (`true`) or off (`false`)|
| `COOKIE_NAME`        | `nqocn_sid`    | Name of the session cookie                     |
| `COOKIE_SECURE`      | `false`        | Set `true` when served over HTTPS              |
| `PORTAL_URL`         | –              | Base URL used in emailed links                 |

Serve over HTTPS in production and set `COOKIE_SECURE=true` so the session
cookie is only sent over TLS. These, plus every SMS/Email/UPI/Conference
variable, are also listed live (with their effective value) under
**Settings → General → Other Environment Variables** once the server is
running — see above.

## Templates

Both pages are assembled at request time from a skeleton of `<%- include %>`
lines — one partial per section and modal — rather than one long HTML file:

```
views/admin.ejs              admin skeleton (head, body, include list)
views/admin/partials/        header (+ Settings dropdown), main nav tabs
views/admin/sections/        one file per tab: payments, abstracts, statement,
                             reports, reminders, activity, general, workshops,
                             qi, fees, discount, groupdiscount, users
views/admin/modals/          one file per modal / side panel

views/index.ejs              delegate-portal skeleton
views/portal/partials/       hero (conference name / dates / location)
views/portal/sections/       auth (login + signup), dashboard
views/portal/modals/         registration & payment, top-up, correct
                             submission, abstract, add group member, confirm
```

EJS is used *only* for includes — there is no server-rendered data in these
templates. Everything is still populated client-side by `public/app.js`
against the JSON API, exactly as before, so a section's markup and the code
that fills it stay in the two obvious places (`sections/<name>.ejs` and the
matching `render*()` in `app.js`).

Both are served by explicit routes (`GET /` and `GET /admin`) and live outside
the static root, so `express.static` is mounted with `index: false` — without
that it would auto-serve a `public/index.html` for `/` and shadow the route.
`public/` now holds only assets (`app.js`, `styles.css`, `data/`).

The admin panel records its active tab in the URL hash (`/admin#general`), so
a refresh or a bookmark returns to the same section; a hash the current role
can't open falls back to that role's default tab. The delegate portal needs no
equivalent — its two pages are chosen by login state, and `restoreSession()`
already puts a logged-in delegate back on the dashboard after a refresh.

## Route protection

| Route                                 | Access                          |
| ------------------------------------- | ------------------------------- |
| `POST /api/otp/request`               | Public (throttled)              |
| `POST /api/auth/register` / `login`   | Public (OTP-gated)              |
| `GET  /api/auth/me`                   | Authenticated                   |
| `POST /api/auth/logout`               | Authenticated                   |
| `POST /api/registrations`             | Authenticated (own record)      |
| `GET  /api/registrations/me`          | Authenticated (own record)      |
| `POST /api/abstracts`                 | Authenticated (own record)      |
| `GET  /admin`                         | Any admin role                  |
| `GET  /api/registrations`             | `SUPER_ADMIN`, `FINANCE_ADMIN`  |
| `PUT  /api/registrations/:id/status`  | `SUPER_ADMIN`, `FINANCE_ADMIN`  |
| `GET/POST /api/users`, `PUT .../role` | `SUPER_ADMIN`                   |
| `GET /api/registrations/:id/screenshot` | Owning delegate or finance admin |
| `GET /api/registrations/:id/audit`    | `SUPER_ADMIN`, `FINANCE_ADMIN`  |

## Audit trail

Every administrative status change — payment bank status and abstract review
status — is appended to an `audit_log` table recording the old and new value,
the acting admin (phone, name, role), and a timestamp. The admin tables show
who last changed each record and when; `GET /api/registrations/:id/audit`
returns a registration's full history. The log is append-only; nothing in the
app deletes or edits it.

The admin **Logs** tab (Settings menu) surfaces this from several angles:
Bank Reconciliation, Transaction Mapping, Registration Approval, Abstract
Approval, Abstract Allotment, **General Logs** (every change made from any
Settings page — Workshop/QI Master, Fee Master, Discount Codes, Group
Discount Rules, and Settings → General itself, including which credential
changed without ever showing its value), **Login** (every successful login),
**SMS**, and **Email** (every outgoing send attempt, success or failure).

## Payment screenshots

Uploaded screenshots are written to `uploads/` (git-ignored) and the database
stores only the generated filename. They are served exclusively through the
authenticated `GET /api/registrations/:id/screenshot` route — to the owning
delegate or a finance admin — never from the static root. Images must be PNG,
JPEG, GIF, or WebP and under 5 MB. On first start after upgrading, any
base64 screenshots still in the database are migrated to files automatically.

Back up `uploads/` alongside `conference.db`; it is not tracked in git.

## Screenshot OCR checks

On submission the server runs OCR (tesseract.js) over the payment screenshot
and checks three things against it:

1. **Amount** — the category fee appears in the image.
2. **UPI ID** — the conference's own VPA (set in Settings → General → UPI)
   appears.
3. **UTR** — the UTR the delegate typed appears in the image.

If any check fails the delegate sees a warning listing what could not be
verified and may submit anyway; the registration is then **flagged for manual
scrutiny** (`is_flagged`), and the three results are stored
(`ocr_amount_match`, `ocr_vpa_match`, `ocr_utr_match`) and shown in the finance
table. Checks run **server-side**, so the flag cannot be bypassed by a tampered
client. OCR is advisory — imperfect reads are expected, which is why failures
warn-and-flag rather than block, and manual finance verification remains the
real control.

The English language model (~15 MB) is downloaded once at runtime and cached
under `.ocr-cache/` (git-ignored). First OCR after a fresh deploy needs network
access to fetch it.

## Registration number & receipt

Each registration is assigned a stable unique number at submission: the
prefix set in Settings → General → Conference Details → Registration Number
Prefix (default `NQOCN2026`, letters/numbers only), plus a 4+-digit
zero-padded sequence shared by every registration regardless of prefix
(`assignUserRegNumber()` in `server.js`) — e.g. `NQOCN20261188`. Changing the
prefix only affects registrations created after the change; existing numbers
are never rewritten, so a deployment that retargets mid-event ends up with
old- and new-prefix numbers coexisting, by design. The number, the
chosen workshop and QI practice, and a **View / Download Receipt** button are
shown to the delegate only once the payment is verified; before that the
dashboard shows the register/pay action. `GET /api/registrations/me/receipt`
returns a printable HTML receipt (own registration, verified only).
Verification also backfills a number for any older row that lacked one.

## Reports

The admin **Reports** tab offers three exportable reports: verified
registrations, registrations per workshop (finance/super), and accepted
abstracts (reviewer/super). Each is available via `GET /api/admin/reports/:type`
as a **printable HTML page** (Print / Save as PDF) or, with `?format=csv`, as a
**CSV download** that opens in Excel. Role is enforced per report.

## Fees (categories × date tiers)

Category fees live in an admin-editable `fee_categories` master (per-category
early/regular/late fees) plus a global `fee_config` with the two cutoff dates.
The active phase is computed from today's date (on/before early cutoff = early;
on/before regular cutoff = regular; after = late). The delegate form and the
authoritative fee both come from the master via `GET /api/fees`; the admin
**Fees** tab edits the dates, per-category fees, and (see Student ID
verification below) whether a category requires a student ID upload.
Deleting a category in use is refused (deactivate instead).

## Workshops & QI practices (capacity-limited)

Workshops and QI practice tracks live in an admin-editable `program_options`
master (type, name, capacity, active). A super admin manages them under the
**Workshop Master** / **QI Practice Master** tabs (add, edit capacity,
activate/deactivate, delete — delete is refused while anyone is enrolled).
The delegate payment form is populated from `GET /api/program-options`,
showing remaining spots and disabling full options. On submit the server
records the chosen option ids and enforces capacity: a slot is held by any
non-rejected registration, and a full option is rejected. An enrolled
delegate can be marked **Faculty** for a specific option from its roster,
which excludes them from the capacity count and labels them accordingly on
reports.

## Student ID verification

Whether a category requires a student ID upload is set per category from
Settings → Fees (a "Student ID" dropdown next to its fees: **Not required**,
or one of **Nursing UG/PG** / **Medical UG/PG**). A category so flagged must
upload a student ID card with registration; the server OCRs the card and does
a preliminary check that its discipline and level match. Like the payment
checks this is advisory: a mismatch flags the registration for manual review
rather than blocking it — an approver still confirms the ID before the
registration can be verified (`PUT /api/registrations/:id/verify-id`).

The four dropdown options are a closed set (the API rejects anything else)
because the OCR keyword matcher (`detectIdAttributes()` in `server.js`) only
recognizes nursing/medical UG/PG vocabulary — the one piece of this still
specific to a healthcare-education audience. Any category can be flagged as
requiring an ID and matched against one of the four combos, but a
conference with a genuinely different student population (e.g. engineering,
law) can't add its own discipline/level through this UI — extending
`detectIdAttributes()`'s keyword patterns is a code change, not an admin
setting.

The card is stored in `uploads/` and served only through the authed
`GET /api/registrations/:id/id-card` route (owner or finance admin). Finance
sees the ID check result and a link to view the card.

## Discount codes & group discounts

Super admins can create promo codes (percent or flat, scoped globally, to a
category, or to one delegate by phone, with an optional max-use cap and
expiry) under **Discount Code**, and per-category group-registration
discounts (unlocked once a group reaches a minimum size) under **Group
Discount**. A code that discounts a registration to ₹0 skips the payment
step entirely — no screenshot or UTR required, confirmed immediately. Every
code's usage is logged (first use only, not resubmissions of the same
registration) and codes can be shared as a WhatsApp message or a printable
voucher from the Discount Code table.

## Rejection workflow

When rejecting a registration the admin picks a reason — **Payment discrepancy**,
**ID discrepancy**, or **Other** (with a typed note) — stored on the row and
shown in the audit trail. The delegate's dashboard then shows the reason and the
matching next step: an ID rejection prompts them to change category or re-upload
the ID card; a payment rejection prompts them to resubmit payment details; both
reopen the registration form. Re-submitting clears the rejection and returns the
row to PENDING.

## Robustness notes

OCR runs on delegate-supplied images, which may be corrupt. tesseract.js can
throw out-of-band on a bad image; the server guards this (bounded recognize
timeout, worker reset, and an uncaught-exception safety net) so a malformed
upload results in all-false checks and a flagged registration rather than a
crash.

## Known limitations

- Credentials (`SMS_API_KEY`, AWS keys) are stored in plaintext in the
  server's `.env` file, whether set at deploy time or later edited from
  Settings → General. This matches how every other secret in this app is
  already handled, but is worth knowing if you're evaluating this for an
  environment that requires a managed secrets store.
- The session cookie name, the daily-digest recipient list, the
  registration-number prefix, and which categories require a student ID are
  all admin-configurable — see Authentication & sessions, Settings →
  General, Registration number & receipt, and Student ID verification
  above. Conference name/acronym/dates/location, fee structure, program
  tracks, discount codes, SMS/Email provider config, and the UPI payment ID
  are all admin-editable too, without a code change.
- The student-ID OCR check itself is still limited to a fixed
  nursing/medical × UG/PG vocabulary (`detectIdAttributes()` in
  `server.js`) — any category can require an ID and be matched against one
  of those four combos, but a conference with a different student
  population can't teach it new keywords without a code change. See Student
  ID verification above.
