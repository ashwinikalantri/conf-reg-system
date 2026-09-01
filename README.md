# Conference Registration Portal & RBAC Admin

A self-hosted registration portal for a conference: delegate signup by mobile
or email (OTP or password), payment collection with OCR-assisted verification,
workshop/QI-style program tracks with capacity limits, abstract submission and
review, discount codes, and a role-based admin panel with a full audit trail.
The conference's identity (name, acronym, dates, location), fee structure, and
program tracks have no built-in defaults — they're configured once, for
whichever event you're running, through the **first-run setup wizard** (see
below) and remain admin-editable afterward from **Settings → General**.

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

4. Visit <http://localhost:3000> — with no admin account yet, the base URL
   *is* the first-run setup wizard. There is no separate `/setup` URL (an
   old link to it just redirects here).

   Delegate portal / first-run setup (same URL): <http://localhost:3000>
   Admin panel: <http://localhost:3000/admin>

`conference.db` (SQLite) is created automatically on first run, with **no
admin account and no fee categories, workshops, or conference details** —
all of that is configured through the setup wizard described next.

## First-Run Setup

A brand-new `conference.db` has zero admin users, and every account-creation
route already requires being one — a deadlock with no way in through the app
itself. The setup wizard breaks that deadlock exactly once, by taking over
the base URL (`GET /`) in place of the normal delegate portal — reachable
with no token or credential of any kind, but only while
`isSetupModeActive()` holds: no admin-role user exists yet **and**
`schema_meta.setup_completed` is unset. There's no risk window to gate with
a secret, because the very first thing the wizard does is create that admin
account, and the moment it does, `isSetupModeActive()` flips to false and
stays false — checked fresh on every request, not cached in the session —
so `/` reverts to the normal portal permanently, for that browser and every
other one, even if the very session that just created the account reloads
mid-wizard. Anyone reaching the server before that has, by definition,
arrived before any real data or configuration exists to protect.

The wizard walks through, one screen at a time, each skippable and
finishable later from the admin panel:

1. **Admin account** — name, phone, email, and an optional password (no OTP
   needed here, since there's no admin session yet to authenticate against).
2. **Conference Details** — name, acronym, dates, location, registration
   number prefix.
3. **Delegate Categories & Fees** — add one or more fee categories with
   their early/regular/late/spot pricing and the phase cutoff dates.
4. **Workshops** — two steps: create a group (a named bucket a delegate
   picks one option from — the step suggests "Workshops" as a starting
   point, but nothing is built in beyond what's added here), then add
   options into it, picked from a dropdown of groups already created. Add as
   many groups as the conference needs. Finer settings like "required" or
   "allow more than one" are configured afterward from Settings → Program
   Groups — see below.
5. **UPI & Bank Transfer** — the conference's UPI VPA/payee name and bank
   transfer details shown to delegates as a payment option.
6. **SMS** and **Email** — provider credentials, both optional at this stage.

Everything from Step 2 onward happens client-side against the same admin
endpoints Settings → General / Fees / Program Groups already use
(`PUT /api/admin/general-settings`, `POST /api/admin/fees/categories`,
`POST /api/admin/program-groups`, `POST /api/admin/program-options`, etc.)
without another page load — so
anything set here can be edited or added to later exactly the same way, and
skipping a step just means doing it from the admin panel afterward. Because
Step 1 already flipped `setup_completed`, a refresh partway through drops
you onto the normal portal instead of back into the wizard; nothing already
saved is lost, and the rest is one `/admin` login away.

Recovering a fully locked-out deployment (every admin account gone) is a
manual database operation, same as it always was — the wizard deliberately
does not reopen for that. Existing deployments (which already have an
admin) are entirely unaffected — `/` just serves the normal portal, same as
it always has.

## Docker

```bash
# 1. Build and start (defaults to host port 3000; override with HOST_PORT=...)
docker compose up -d --build

# 2. Visit http://localhost:3000 and create the first Super Admin -- see
#    First-Run Setup above. No token or extra .env step is needed; a fresh
#    container has no admin account, so the base URL is the setup wizard.
```

Everything the app writes to at runtime — `.env` (the admin panel writes
secrets like the SMS API key back into it), `conference.db`, `uploads/`,
`bank-statements/`, and the OCR language-model cache — lives on one named
Docker volume (`data`, mounted at `/data` and symlinked from inside the
image; see the Dockerfile) so all of it survives `docker compose down` and
an image rebuild together. It's gone only after `docker compose down -v`.

To add or rotate a credential directly (rather than through Settings →
General once the admin panel is up): `docker compose exec app sh -c "echo
'AWS_ACCESS_KEY_ID=...' >> .env"`, then `docker compose restart` — same as
editing `.env` on a bare-metal install, just via `exec` instead of a text
editor, since the file lives on the container's filesystem rather than the
host's.

This is packaging only — it doesn't replace or affect any non-Docker
deployment of this app; a `pm2`-managed instance and a Docker Compose
instance are independent, each with their own `.env`/database/uploads.

## Tests

```bash
npm test                      # the whole suite
npm test -- receipt drive     # only files whose names contain these
KEEP=1 npm test               # leave the workspace behind to poke at
```

Around 680 assertions across 38 files, in roughly fifteen seconds. Exit code
is 0 or 1, so it works as a gate.

Each run builds a fresh SQLite fixture, starts the app against a throwaway
copy of it on a free port, runs every `tests/*.test.js` as its own process,
then stops the server and deletes the workspace. Nothing is left behind and
nothing touches your checkout — the app is given `DB_PATH`, and its database,
`.env` and backup handshake files all live beside it in the temporary
directory. A run that is killed rather than finished never reaches its own
cleanup, so each run also sweeps workspaces more than two hours old.

The files run **sequentially**. They share one server, and the OTP resend
throttle is per destination, so running them at once makes the suite fail for
reasons that have nothing to do with what it tests.

### The fixture

`tests/seed.js` builds the database. It does **not** contain a copy of the
schema: it boots the app against an empty directory, lets the app create its
own tables, and then writes rows. A fixture therefore cannot drift from the
real schema, and starting from nothing is how three genuine bugs surfaced —
a column the Users report selected but no migration created, a database
resolved from the working directory while everything else resolved from the
app's own, and `.env` being written into the checkout.

It seeds a cast covering every shape the tests look for: staff in each role,
a delegate who paid once, one who paid a deposit and topped up, one with a
promo discount, one whose earlier payment was rejected, a pending
registration, student registrations with the ID both confirmed and not, a
signed-up-but-never-registered account, an unverified email, an account with
no password, an email-only (international) account, bank credits to
reconcile against, an unclaimed credit and a debit to refund from.

Two details worth knowing:

- **Dates are relative to today.** Early-bird pricing is always in effect in
  the fixture. A fixed date once quietly went past and took a test with it.
- **The seed checks itself.** It asserts 25 required shapes are present and
  fails loudly if one is missing. Before this, an absent fixture just made a
  test pass without testing anything — ten assertions were doing exactly
  that.

Everyone in the fixture is invented. No real delegate, number or address
appears anywhere in `tests/`.

### Writing a test

```js
const { call, check, report, adminLogin, openDb } = require('./harness');

(async () => {
  const cookie = await adminLogin();
  const res = await call('GET', '/api/admin/fees', null, cookie);
  check('the fee categories are served', res.status === 200, res.status);
  check('and there is at least one', (res.body.categories || []).length > 0, res.body);
  report();
})();
```

Name the file after what it covers — `receipt.test.js`, `drive-oauth.test.js`
— and the runner picks it up. `tests/harness.js` provides:

| | |
|---|---|
| `call(method, path, body, cookie)` | one request; `.body` is parsed JSON or the response text, plus `.raw`, `.buf`, `.status`, `.headers`, `.cookie` |
| `check(name, ok, detail)` | one assertion; `detail` is printed only on failure |
| `report()` | prints the tally and sets the exit code |
| `adminLogin()` / `loginOtp()` / `loginPassword()` | sign in |
| `openDb()` | the fixture database, for setting up or confirming state |
| `appFile(...parts)` | a path into the application, for tests that read its source |
| `dataDir()` | where the running instance keeps its files |

`adminLogin()` signs in as **this file's own** super admin, taken from a pool
of 60 seeded accounts by position in the sorted file list. That is not
incidental: the OTP throttle is per destination, and files sharing an account
throttle each other. Sign admins in by password unless the OTP path is the
thing under test.

### What it does not do

There is no "run against a copy of production" mode. The tests address
fixture identities by name, so pointing them at real data fails around 160
assertions purely because those people are not there — no signal. Making that
mode useful means layering fixtures on top of real rows, tolerating the
categories and programme groups already present, which is a piece of work
rather than a flag. Worth having: real data catches things a fixture never
will, such as a duplicated email address or a delegate whose institution
field holds their job title.

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
- **UPI & Bank Transfer** — the conference's UPI ID (VPA) and payee name
  shown on the payment QR code (the delegate form and the server's OCR
  screenshot check both read this live, so they can never drift apart), plus
  the bank account name/number, IFSC, and branch shown as the NEFT/RTGS
  fallback on the payment and top-up modals.
- **Notifications** — an on/off switch for the daily digest (independent of
  the Email channel toggle above, which also gates delegate-facing
  verification/rejection/abstract emails), the time of day it's sent, and
  its recipient list (see below). Recipients are picked by searching name or
  phone over the Users table rather than typing raw numbers; only the phone
  number is actually persisted.
- **Maintenance Mode** — close the portal to everyone except super admins,
  with an editable notice. See Maintenance mode below.
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

`scripts/daily-digest.js` (an optional cron-run daily summary email covering
pending-approval, partial-payment, and verified registration counts plus
abstract submission/review counts) is a standalone process independent of
the running server, and re-reads `schema_meta` on every run for the
conference name, email from-address/name/region, the on/off switch, the
send time, and the digest recipient list, so it stays in sync with changes
made on this page. Its recipient list — used only if nothing has ever been
saved from Settings → General → Notifications — comes from
`DIGEST_RECIPIENT_PHONES` (comma-separated 10-digit numbers) and is
otherwise empty by default; there's no coded-in fallback list. Recipients
are matched by phone number against Users (not stored as email
addresses), so the list keeps working if someone's email changes.

Cron invokes this script every 15 minutes (not once at a fixed hour); the
script itself decides whether to actually send, by comparing the current
time against the configured send time and a last-sent marker file
(`/data/.digest-last-sent`, alongside `conference.db` on the same persistent
volume) that ensures it only sends once per calendar day. That's what lets
the send time be changed from Settings → General without anyone needing to
edit crontab. Turning the digest off there makes every invocation a no-op
immediately. Run `node scripts/daily-digest.js --force` to send one
immediately regardless of the on/off switch or the configured time — useful
for testing a config change.

## Authentication & sessions

An account is identified by a **mobile number or an email address** — both at
login and at signup — and either can carry the OTP. On success the server
issues a server-side session and sets an `httpOnly`, `SameSite=Lax` cookie
(`COOKIE_NAME`, default `nqocn_sid`, 12-hour life). Only a hash of the
session token and of the OTP is stored in the database.

- OTP is a random 6-digit code, valid for 5 minutes, single-use, capped at
  5 wrong attempts, with a 30-second resend throttle per destination.
- Without `SMS_API_KEY` configured (see SMS OTP above), outside production the
  code is logged to the server console and returned in the API response
  (`devOtp`) so you can log in during development. Set `NODE_ENV=production`
  (or `OTP_ECHO=false`) to stop returning it — but then a working SMS gateway
  is required, or nobody can log in.
- OTP emails are additionally capped globally at 200/hour. Signup OTPs are
  necessarily open (no account exists yet to authorise against), so without
  that ceiling the endpoint could be used to mail strangers at volume and
  get the SES sending domain throttled — taking receipts, reminders and
  digests down with it.

### Verified channels

An address or number is **verified** only by answering an OTP sent to it.
Every account must have at least one verified channel, and **a login OTP is
only ever sent to a channel that account has already verified** — otherwise
an address someone merely typed into their profile would be enough to sign
in as them. Password login does not require a verified channel: the password
is itself the proof, and the identifier is only naming the account.

Accounts predating email verification were marked phone-verified (they all
passed phone OTP at signup, the only route that existed) and email-
UNVERIFIED, since those addresses were only ever self-asserted. Those
delegates are prompted to verify at next login, and a standing banner on the
dashboard offers it any time — it also doubles as the way to *correct* an
address you can't receive mail at, since the code goes to whatever is in the
field rather than to whatever is on file.

An **email address is mandatory** on every account-creating path (signup,
admin create-user, desk registration, first-run setup). Verifying it is
optional; recording it is not, because it's how receipts, reminders and every
other notification reach a delegate. One address per account is enforced;
an address already held by another account is refused.

### Identity: the account key

`users.phone_number` is the account key — the primary key here and the join
column in `registrations`, `abstracts`, `sessions`, `payment_transactions`,
`group_members`, `delegate_groups` and the audit trail. **It is not
necessarily a phone number.** It holds the number for every account created
through the Indian phone flow (which is why existing data, admin screens and
audit rows still read naturally), and a synthetic `u_<hex>` key otherwise.

The distinction matters because the key can never be edited — every one of
those tables points at it. An Indian number is SMS-verified at signup, so it is known-good
and safe to freeze; an international number can't be verified, so it is
exactly the kind of value that gets mistyped and needs correcting later, and
keeping it out of the key leaves it editable like any other column. Read the
actual contact details from `users.phone` and `users.email`; use
`displayPhone()` (server) / `delegateDisplayPhone()` (client) wherever a
number is shown, so a synthetic key can never print as if it were one.

### International delegates

Phone numbers are stored in **E.164** (`+919823900641`). `toE164()` accepts
anything a human types — `9823900641`, `09823900641`, `919823900641`,
`+91 98239 00641`, `+44 7700 900123` — and both sides of every comparison are
normalised through it, so how a number was entered never decides whether it
matches.

Signup asks for a **country**, and that answer drives the form:

| | India | Elsewhere |
| --- | --- | --- |
| Mobile number | **required**, 10-digit, SMS-verified, becomes the account key | optional; stored as an unverifiable contact detail |
| Verified by | SMS or email | email only |
| Address | PIN code drives the India Post lookup (state/district readonly) | free-text city and region |
| Account key | the number | synthetic `u_<hex>` |

**We cannot send SMS outside India** — the gateway is an Indian DLT provider
with no route elsewhere — so `issueOtp()` refuses a non-Indian SMS
destination up front rather than storing a code that can never be delivered.
An international number therefore can't receive a login code, which the
verified-channel rule enforces without special-casing. A country/number
mismatch is refused in both directions: an Indian number under a foreign
country is almost always the selector left untouched.

Delegate signup is the only international route. Admin create-user, desk
registration and first-run setup remain Indian-only, since each makes the
number the account key and expects the holder to be reachable by SMS.

### Password login

A password is **required at signup**, and is an alternative to OTP for every
account type. Registration still proves a channel by OTP regardless
(`POST /api/auth/register` always calls `consumeOtp()`); the password is for
next time. Once registered, a delegate or admin can change it
(`POST /api/auth/set-password`, self-service, no current password required —
being logged in already is the proof) and log in with either OTP or
`POST /api/auth/login-password`.

Passwords are hashed with scrypt (random 16-byte salt per password) and
compared in constant time; the login-password endpoint is rate-limited
in-memory (5 attempts, 15 minute lockout per identifier) separately from the
DB-backed OTP attempt counter. A wrong password and an unknown identifier
return the same error, so neither confirms whether an account exists. An
admin can also set an initial password for a staff account at creation time
(`POST /api/users`), and a desk registration issues a one-time temporary
password shown once (see Desk registration below).

Accounts predating the requirement have no password. They get a **blocking**
prompt at next login — the close button is removed for that case only — after
which the email-verification prompt follows. The dashboard's 🔑 button opens
the same modal voluntarily, where dismissing is fine. Neither modal is in the
admin panel: staff passwords are set at account creation or via
`set-password` while already logged in.

### Roles (enforced server-side)

| Role                | Access                                              |
| ------------------- | --------------------------------------------------- |
| `SUPER_ADMIN`       | Everything, including settings, user & role management |
| `FINANCE_ADMIN`     | Payment reconciliation, reminders, group discounts (view + verify) |
| `ACADEMIC_REVIEWER` | Abstract review & allotment                          |
| `FINANCE_ACADEMIC`  | Both of the above                                    |
| `OPERATIONS`        | All reports, plus Users (view/create/change role — not demographic edits, still `SUPER_ADMIN`-only) |
| `DELEGATE`          | Own registration, payment, and abstract submission  |

`OPERATIONS` cannot grant `SUPER_ADMIN` to anyone (including itself) and
cannot change an existing `SUPER_ADMIN`'s role in either direction —
enforced in both `POST /api/users` and `PUT /api/users/:phone/role`, not
just hidden in the UI, so it can't be bypassed by calling the API directly.

Admins log in through the normal portal with their own phone number; their
DB role grants access. The database ships with one `SUPER_ADMIN`. Roles can
only be changed by a `SUPER_ADMIN` or `OPERATIONS` admin via the Users
screen — they are never accepted from a login or registration request body.

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

## Maintenance mode

A super admin can close the portal from **Settings → General → Maintenance
Mode** (toggle plus an editable message). While it's on:

- **Delegates** get a maintenance notice instead of the login form or
  dashboard, and every delegate API call returns `503` with
  `{ maintenance: true }`. New signups (`POST /api/auth/register`) are
  blocked — stopping registrations mid-flight is the point.
- **Finance and reviewer admins** are locked out too: `/admin` serves a
  maintenance page rather than a panel of empty tables, since the API calls
  behind it are being 503'd.
- **Super admins** keep full access, so the maintenance can actually be done.

Enforcement is server-side in `maintenanceGate` (`server.js`), mounted after
`loadSession` and ahead of every API route; the delegate-facing screen is UX
only and is never the control. The state persists in `schema_meta`, so it
survives a restart — **a crash mid-maintenance comes back up still closed**,
which is the safe direction but worth remembering.

The OTP/login endpoints stay open during maintenance by design
(`MAINTENANCE_OPEN_PATHS`). A super admin arriving at an already-closed
portal has no session yet, so gating login would lock the only role that can
lift maintenance out of the app entirely. A delegate can therefore still log
in while it's on — they just land on the maintenance notice.

Both toggling and message edits are written to the audit log
(`GENERAL_SETTINGS_UPDATE`) with the acting super admin's name and role.

## Route protection

| Route                                 | Access                          |
| ------------------------------------- | ------------------------------- |
| `POST /api/otp/request`               | Public (throttled)              |
| `POST /api/auth/register` / `login`   | Public (OTP-gated)              |
| `POST /api/auth/login-password`       | Public (rate-limited per phone) |
| `POST /api/auth/set-password`         | Authenticated (self-service)    |
| `GET  /api/auth/me`                   | Authenticated                   |
| `POST /api/auth/logout`               | Authenticated                   |
| `POST /api/registrations`             | Authenticated (own record)      |
| `GET  /api/registrations/me`          | Authenticated (own record)      |
| `POST /api/abstracts`                 | Authenticated (own record)      |
| `GET  /admin`                         | Any admin role                  |
| `GET  /api/registrations`             | `SUPER_ADMIN`, `FINANCE_ADMIN`  |
| `PUT  /api/registrations/:id/status`  | `SUPER_ADMIN`, `FINANCE_ADMIN`  |
| `GET/POST /api/users`, `PUT .../role` | `SUPER_ADMIN`, `OPERATIONS` (see Roles above for the escalation limits on `OPERATIONS`) |
| `PUT /api/users/:phone` (demographic edit) | `SUPER_ADMIN`             |
| `GET /api/admin/reports/:type`        | Per report type — see Reports below |
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

Each payment keeps its **own** slip in `payment_transactions.screenshot`,
served by `GET /api/payment-transactions/:txnId/screenshot` under the same
access rule. That's what makes the earlier slip of a partial payment still
viewable after a top-up — the registration's single `screenshot` column is
overwritten by each new submission. Every row in the review modal's
Transactions & Bank Reconciliation list has a **Payment Slip** button
alongside that payment's date, so two slips from the same delegate are
tellable apart. A slip whose file is missing from disk (an older rejected
payment cleaned up on resubmission) says so rather than showing a blank pane.

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
Prefix (letters/numbers only, no built-in default — set during first-run
setup or Settings → General), plus a 4+-digit
zero-padded sequence shared by every registration regardless of prefix
(`assignUserRegNumber()` in `server.js`) — e.g. `CONF20261188`. Changing the
prefix only affects registrations created after the change; existing numbers
are never rewritten, so a deployment that retargets mid-event ends up with
old- and new-prefix numbers coexisting, by design. The number, the
delegate's chosen program-group selections, and a **View / Download
Receipt** button are shown to the delegate only once the payment is
verified; before that the
dashboard shows the register/pay action. `GET /api/registrations/me/receipt`
returns a printable HTML receipt (own registration, verified only).
Verification also backfills a number for any older row that lacked one.

The receipt **itemises every verified payment** — date, mode and reference
per line, with a total — rather than a single amount and reference. A
delegate who paid a partial amount and later topped up has two real
transactions, and the registration's own `utr_number` column only holds
whichever submission wrote it last. Rejected and still-pending attempts are
excluded (they aren't money received), recorded refunds appear as negative
lines and reduce the total, and an overpayment adds a note that the excess is
due to be refunded — otherwise a total exceeding the fee just reads as an
error.

## Reports

The admin **Reports** tab offers six exportable reports, each independently
role-gated in `REPORT_ROLES` (`server.js`):

| Report | Roles |
| --- | --- |
| Registered delegates (demography & institute) | `SUPER_ADMIN`, `FINANCE_ADMIN`, `OPERATIONS` |
| Delegates & program selections (one row per delegate, one column per group) | `SUPER_ADMIN`, `FINANCE_ADMIN`, `OPERATIONS` |
| Payment details & status | `SUPER_ADMIN`, `FINANCE_ADMIN`, `OPERATIONS` |
| Registrations per program option (any group) | `SUPER_ADMIN`, `FINANCE_ADMIN`, `OPERATIONS` |
| Accepted abstracts | `SUPER_ADMIN`, `ACADEMIC_REVIEWER`, `OPERATIONS` |
| All users | `SUPER_ADMIN`, `OPERATIONS` (the roles that can see the Users tab at all) |

The delegates and users reports carry a **Country** column; mobile numbers
render in E.164, and an account without one (an email-only international
delegate) shows a blank rather than its internal key.

Each is available via `GET /api/admin/reports/:type` as a **printable HTML
page** (Print / Save as PDF) or, with `?format=csv`, as a **CSV download**
that opens in Excel.

## Fees (categories × date tiers)

Category fees live in an admin-editable `fee_categories` master (per-category
early/regular/late fees) plus a global `fee_config` with the two cutoff dates.
The active phase is computed from today's date (on/before early cutoff = early;
on/before regular cutoff = regular; after = late). The delegate form and the
authoritative fee both come from the master via `GET /api/fees`; the admin
**Fees** tab edits the dates, per-category fees, and (see Student ID
verification below) whether a category requires a student ID upload.
Deleting a category in use is refused (deactivate instead).

## Program groups (capacity-limited, admin-defined)

Optional tracks a delegate can enroll in alongside their main registration
are organized into **groups** — a group is a named bucket a delegate picks
from (e.g. "Workshops", "QI Practices"), and any number of groups can exist,
each with its own options (`program_groups` / `program_options`, admin-
editable). Per group, a super admin sets:

- **Required or optional** — a required group blocks registration submission
  until the delegate picks something in it.
- **Max selections** — how many options within the group one delegate may
  choose (1 by default, so "pick one" is the common case; set higher to
  allow choosing more than one).
- **Per-option fee** — optional, defaults to ₹0. When set, it's added on top
  of the delegate's category fee (not itself discounted by a promo/group
  discount code, which only apply to the category) — e.g. a paid
  pre-conference workshop alongside a free main registration.

Managed under **Settings → Program Groups** (add/rename/require/delete a
group; within it, add options with a capacity and fee, edit, activate/
deactivate, delete — delete is refused while anyone is enrolled, or while a
group still has options in it). The delegate payment form is populated from
`GET /api/program-options`, one control per active group (a `<select>` when
it only allows one choice, checkboxes when it allows more), showing
remaining spots, disabling full options, and totaling any option fees into
the amount due. On submit the server re-validates every group's
required/max-selections rule and each option's capacity — a slot is held by
any non-rejected registration, and a full option is rejected — then records
the choices in `registration_options` (one row per registration × option).
An enrolled delegate can be marked **Faculty** for a specific option from
its roster, which excludes them from the capacity count and labels them
accordingly on reports.

A deployment upgrading from before groups existed has this handled
automatically: on first boot, the two program types that used to be
hardcoded (workshops and QI practices) become two groups of that name, and
every existing delegate's choice is carried over — see
`migrateProgramGroupsOnBoot()` in `server.js`. Nothing needs to be redone by
hand, and a fresh install just starts with no groups until the setup wizard
or Settings → Program Groups creates some.

## Student ID verification

Whether a category requires a student ID upload is set per category from
Settings → Fees (a **Required** checkbox next to its fees). A category so
flagged must upload a student ID card with registration, and an approver
confirms it by eye before the registration can be verified
(`PUT /api/registrations/:id/verify-id`) — that human check is the gate.

There is deliberately no OCR of the ID card. An earlier version ran one, but
it only ever recognised a fixed nursing/medical x UG/PG vocabulary, which
made it useless to a conference with any other student population, and it was
advisory rather than a gate — a miss merely flagged the registration for the
same manual review that happens anyway. Removing it also removed the closed
discipline/level enum that existed only to feed it, so **any** category can
now require an ID with no constraint on what kind of student it is.

At the desk, the walk-in flow substitutes an "I have checked this delegate's
physical card" confirmation for the upload (see Desk registration below) —
the same human judgement, made in person.

The card is stored in `uploads/` and served only through the authed
`GET /api/registrations/:id/id-card` route (owner or finance admin).

## Discount codes & group discounts

Super admins can create promo codes (percent or flat, scoped globally, to a
category, or to one delegate identified by **mobile number or email**, with
an optional max-use cap and expiry) under **Discount Code**, and per-category group-registration
discounts (unlocked once a group reaches a minimum size) under **Group
Discount**. A code that discounts a registration to ₹0 skips the payment
step entirely — no screenshot or UTR required, confirmed immediately. Every
code's usage is logged (first use only, not resubmissions of the same
registration) and codes can be shared as a WhatsApp message, a printable
voucher, or emailed straight from the Discount Code table to any address
typed in — not limited to a delegate already on file, so a code can go out
before someone has even signed up. Emailing reuses the same voucher content
as the printable version and is gated behind Email being configured and
turned on (Settings → General → Email).

A group leader adds members by **mobile number or email** too. Both lookups
resolve the identifier to an account and store that account's key, so an
email-only delegate is reachable by either — matching an account key against
a typed number would silently miss anyone whose key is synthetic. An address
shared by more than one account is refused with a "use their mobile instead"
message rather than resolved to an arbitrary one.

## Reminder emails

**Settings → Reminders** has three cards, all Super-Admin-only to send (a
one-way bulk blast with nothing to undo) and all offering a test-send to
your own address first:

| Card | Recipients |
| --- | --- |
| Signed Up but Not Registered | accounts with no payment registration |
| Balance Payment Awaited | `PARTIAL_PAYMENT` registrations, with `{{amount}}` per recipient |
| Custom Recipients | any addresses pasted in — they need no account here |

The first two pick recipients from a checklist and substitute `{{name}}`
per person. The third exists because the other two can only reach people
already in the system; it takes a pasted list (one per line or
comma-separated), skips anything malformed or duplicated rather than failing
the whole batch, and offers no `{{name}}` substitution since there's no
record behind those addresses. Its body is pre-filled with an "early bird
ends today" message built from the live conference details and fee cutoff,
so the copy can't drift from the actual settings.

All three apply a rolling 24-hour per-recipient dedupe, so a repeated send
or an accidental double-click can't mail anyone twice.

## Desk registration (walk-ins)

`POST /api/admin/registrations` (Super Admin / Finance Admin, **+ Register
Delegate** on the Payments tab) registers someone in person at the desk. It
reuses the delegate's own submission logic end to end — fee resolution,
program-group capacity and required-group rules, promo and group discounts,
registration numbering — so a walk-in is priced and validated identically to
a self-service registration.

The payment is recorded as already settled rather than left pending, by one
of three routes:

- **Cash** — the admin's own presence at the desk substitutes for the
  screenshot/OCR proof every other mode requires. There is deliberately no
  self-service path to this mode.
- **Existing bank transfer** — linking a credit already visible in the
  imported statement, the same 1-to-1 link the review modal uses, made at
  creation time instead of after a pending submission.
- **Link later** — the delegate says they've paid but the credit hasn't been
  imported yet. The registration is created now and the payment sits
  `PENDING`, in exactly the shape a self-service submission starts in, so it
  reconciles later through the normal review flow.

A student category needs no ID upload here: the admin confirms the physical
card with a checkbox, the same standing the desk has for vouching a phone
number. A brand-new account (or an existing one with no password) is issued a
**temporary password, shown once** and never stored in plaintext — only its
scrypt hash reaches the database — for the admin to hand over.

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
- The OTP SMS message text itself (`sendOtpSms()` in `server.js`) is a fixed
  English string, not admin-editable. This is deliberate, not an oversight:
  India's DLT regulations require the sent text to match a template
  registered in advance with the telecom provider, so freely rewording it
  risks silently breaking OTP delivery in a way that's hard to diagnose
  without a real DLT rejection. A deployment using a different registered
  template needs to edit that string in code to match it.
- **An international delegate can register but cannot pay.** The payment
  step offers UPI and NEFT/RTGS, both domestic Indian rails; fees are held
  and displayed in INR only; and the receipt OCR looks for rupee markers. So
  international signup works end to end right up to payment, and then stops.
  The practical route today is for them to wire the money and for an admin
  to record it through the desk registration flow above (which accepts an
  admin-linked bank credit, so an international wire landing in the account
  reconciles normally) — but nothing in the portal tells the delegate that,
  so it needs saying out of band. Worth settling before international
  registration is publicised.
- SMS cannot be sent outside India (the gateway is an Indian DLT provider),
  so an international delegate's only verifiable channel is email, and any
  number they give is a contact detail that can never receive a login code.
  See International delegates above.
