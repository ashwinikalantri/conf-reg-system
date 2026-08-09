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

## Authentication & sessions

Login is phone + OTP. On success the server issues a server-side session
and sets an `httpOnly`, `SameSite=Lax` cookie (`nqocn_sid`, 12-hour life).
Only a hash of the session token and of the OTP is stored in the database.

- OTP is a random 6-digit code, valid for 5 minutes, single-use, capped at
  5 wrong attempts, with a 30-second resend throttle per number.
- There is **no SMS gateway wired up yet.** Outside production the code is
  logged to the server console and returned in the API response
  (`devOtp`) so you can log in during development. Set `NODE_ENV=production`
  (or `OTP_ECHO=false`) to stop returning it — but then you must integrate a
  real SMS provider first, or nobody can log in.

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
| `REGISTRATION_PHASE` | `early`        | Fee column in effect: `early`/`regular`/`late` |

Serve over HTTPS in production and set `COOKIE_SECURE=true` so the session
cookie is only sent over TLS.

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
2. **UPI ID** — the conference VPA (`OFFICIAL_UPI_ID`, default `abhishekraut@cbin`) appears.
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

## Workshops & QI practices (capacity-limited)

Workshops and QI practice tracks live in an admin-editable `program_options`
master (type, name, capacity, active). A super admin manages them under the
**Workshops & QI Practices** tab (add, edit capacity, activate/deactivate,
delete — delete is refused while anyone is enrolled). The delegate payment form
is populated from `GET /api/program-options`, showing remaining spots and
disabling full options. On submit the server records the chosen option ids and
enforces capacity: a slot is held by any non-rejected registration, and a full
option is rejected. The default eight options are seeded on first run.

## Robustness notes

OCR runs on delegate-supplied images, which may be corrupt. tesseract.js can
throw out-of-band on a bad image; the server guards this (bounded recognize
timeout, worker reset, and an uncaught-exception safety net) so a malformed
upload results in all-false checks and a flagged registration rather than a
crash.

## Known limitations

Still outstanding (tracked for follow-up work):

- No SMS gateway; OTP delivery is console/echo only (see above).
- The displayed fee (`calculateFee`) always uses the `early` column; if
  `REGISTRATION_PHASE` is changed, the client display and QR will lag the
  server's expected fee until a pricing endpoint is added.
