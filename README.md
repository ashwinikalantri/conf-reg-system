# NQOCN 2026 Conference Portal & RBAC Operations

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

`conference.db` is created automatically on first run.

## SMS OTP (Vynttra)

OTPs are delivered by SMS via the Vynttra JSON API using the registered DLT
template. Set `SMS_API_KEY` to enable it; the sender/entity/template/header IDs
default to the NQOCN values and are overridable via env (`SMS_SENDER`,
`SMS_ENTITY_ID`, `SMS_TEMPLATE_ID`, `SMS_HEADER_ID`, `SMS_TYPE`, `SMS_URL`) —
or, once the server is running, from **Settings → General → SMS** in the admin
panel (see below). Without an API key, SMS is skipped and (outside production)
the OTP is echoed for local testing. Sending is fire-and-forget — failures are
logged (console and the admin SMS activity log), never blocking OTP issuance.

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

- **SMS** — sender ID, gateway URL, DLT entity/template/header IDs, message
  type, and the API key itself, plus the on/off switch (turning SMS off also
  stops login OTPs).
- **Email** — From address, From name, AWS region, and the AWS Access Key ID /
  Secret Access Key, plus the on/off switch.
- **UPI** — the conference's UPI ID (VPA) and payee name shown on the payment
  QR code; the delegate form and the server's OCR screenshot check both read
  this live, so they can never drift apart.
- **Conference Details** — full name, acronym, dates, and location, used
  across confirmation emails, the payment receipt, and printable reports and
  voucher pages (dates render as "21–22 Nov 2026" or, spanning months,
  "28 Nov – 2 Dec 2026"). The public delegate landing page (`public/index.html`)
  is static and not wired to these yet.
- **Other Environment Variables** — a read-only reference showing every other
  env var the server reads (`PORT`, `PORTAL_URL`, `NODE_ENV`,
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

`scripts/daily-digest.js` (the cron-run daily summary email) is a standalone
process independent of the running server, and re-reads `schema_meta` for the
conference name and email from-address/name/region on every run, so it stays
in sync with changes made on this page.

## Authentication & sessions

Login is phone + OTP. On success the server issues a server-side session
and sets an `httpOnly`, `SameSite=Lax` cookie (`nqocn_sid`, 12-hour life).
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
| `SUPER_ADMIN`       | Everything, including user & role management        |
| `FINANCE_ADMIN`     | Payment reconciliation (view + verify)              |
| `ACADEMIC_REVIEWER` | Admin panel (abstract desk — not yet built)         |
| `DELEGATE`          | Own registration, payment, and abstract submission  |

Admins log in through the normal portal with their own phone number; their
DB role grants access. The database ships with one `SUPER_ADMIN`. Roles can
only be changed by a `SUPER_ADMIN` via the user-management screen — they are
never accepted from a login or registration request body.

### Environment variables

| Variable        | Default        | Purpose                                        |
| --------------- | -------------- | ---------------------------------------------- |
| `PORT`               | `3000`         | HTTP port                                      |
| `NODE_ENV`           | –              | `production` disables the dev OTP echo         |
| `OTP_ECHO`           | on if not prod | Force the OTP echo on (`true`) or off (`false`)|
| `COOKIE_SECURE`      | `false`        | Set `true` when served over HTTPS              |

Serve over HTTPS in production and set `COOKIE_SECURE=true` so the session
cookie is only sent over TLS. These five, plus every SMS/Email/UPI/Conference
variable, are also listed live (with their effective value) under
**Settings → General → Other Environment Variables** once the server is
running — see below.

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
2. **UPI ID** — the conference VPA (set in Settings → General → UPI, default
   `abhishekraut@cbin`) appears.
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

Each registration is assigned a stable unique number (`NQOCN2026-000N`, derived
from its row id) at submission. The number, the chosen workshop and QI practice,
and a **View / Download Receipt** button are shown to the delegate only once the
payment is verified; before that the dashboard shows the register/pay action.
`GET /api/registrations/me/receipt` returns a printable HTML receipt (own
registration, verified only). Verification also backfills a number for any
older row that lacked one.

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
**Fees** tab edits the dates and per-category fees. Deleting a category in use
is refused (deactivate instead). This replaces the old hardcoded price table
and `REGISTRATION_PHASE` env.

## Workshops & QI practices (capacity-limited)

Workshops and QI practice tracks live in an admin-editable `program_options`
master (type, name, capacity, active). A super admin manages them under the
**Workshops & QI Practices** tab (add, edit capacity, activate/deactivate,
delete — delete is refused while anyone is enrolled). The delegate payment form
is populated from `GET /api/program-options`, showing remaining spots and
disabling full options. On submit the server records the chosen option ids and
enforces capacity: a slot is held by any non-rejected registration, and a full
option is rejected. The default eight options are seeded on first run.

## Student ID verification

Nursing UG/PG, Medical UG, and PG/Resident categories must upload a student ID
card with their registration. The server OCRs the card and does a preliminary
check that its discipline (nursing vs medical) and level (UG vs PG) match the
chosen category. Like the payment checks this is advisory: a mismatch flags the
registration for manual review rather than blocking it. The card is stored in
`uploads/` and served only through the authed `GET /api/registrations/:id/id-card`
route (owner or finance admin). Finance sees the ID check result and a link to
view the card.

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
