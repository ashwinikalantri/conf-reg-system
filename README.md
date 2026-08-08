# NQOCN 2026 Conference Portal & RBAC Operations

## How to Run (Automatic Database Setup on First Run)

1. Open your terminal in the project directory.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Set the admin credentials and start the server:

   ```bash
   ADMIN_USER=admin ADMIN_PASSWORD='<a-long-random-password>' npm start
   ```

4. Delegate portal: <http://localhost:3000>
   Admin panel: <http://localhost:3000/admin>

`conference.db` is created automatically on first run.

## Admin access

The admin panel and its APIs are behind HTTP Basic auth, configured entirely
through two environment variables:

| Variable         | Purpose                          |
| ---------------- | -------------------------------- |
| `ADMIN_USER`     | Admin username                   |
| `ADMIN_PASSWORD` | Admin password                   |
| `PORT`           | Optional, defaults to `3000`     |

If either credential is missing the server still starts and serves the
delegate portal, but **every admin route returns 401** — it fails closed.
The browser will prompt for the credentials when you open `/admin`.

Generate a password with:

```bash
openssl rand -base64 24
```

Never commit credentials. `.env` is git-ignored.

### Protected routes

| Route                             | Access    |
| --------------------------------- | --------- |
| `GET /admin`                      | Admin     |
| `GET /api/registrations`          | Admin     |
| `PUT /api/registrations/:id/status` | Admin   |
| `GET /api/users`                  | Admin     |
| `POST /api/users`                 | Admin     |
| `PUT /api/users/:phone/role`      | Admin     |
| everything else                   | Public    |

## Known limitations

This is a prototype. Before handling real delegate data at scale, note:

- Delegate login uses a hardcoded OTP (`123456`) that the API returns to the
  client. Anyone who knows a mobile number can log in as that delegate.
- `GET /api/registrations/user/:phone` is unauthenticated — any phone number
  can be queried for its registration.
- Basic auth gates the admin panel as a whole; the per-role permissions
  (`FINANCE_ADMIN` vs `ACADEMIC_REVIEWER` vs `SUPER_ADMIN`) shown in the UI
  are not enforced server-side.
- Registration fee amounts are supplied by the client and not re-checked
  against the server's price list.
- Admin tables render database values as raw HTML (XSS risk).
- Payment screenshots are stored as base64 inside SQLite.
