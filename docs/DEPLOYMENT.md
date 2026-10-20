# Deployment

Nothing in this repository deploys anything automatically. This guide describes a single-server deployment; adapt it to your platform.

## Build

```bash
npm --prefix v2d_Backend ci --omit=dev
npm --prefix v2d_Frontend ci && npm --prefix v2d_Frontend run build
```

Express serves `v2d_Frontend/dist` (or `FRONTEND_DIST`) and the API from one origin.

## Required configuration (`NODE_ENV=production`)

The API **refuses to start** unless:

- `APP_SECRET` is a random string of ≥ 32 characters (signs meal passes; keys one-time codes). Rotating it invalidates outstanding activation/reset codes and meal passes, not sessions.
- `DATABASE_URL` or `DB_PASSWORD` is set.
- `APP_ORIGIN` is the public `https://` URL.
- `COOKIE_SECURE` is not `false` (cookies are `__Host-` prefixed, Secure, HttpOnly, SameSite=Lax).

Also set: `TRUST_PROXY=1` behind one reverse proxy (needed for correct client IPs in rate limiting and audit), `DB_SSL=true` for managed databases, `LOG_LEVEL=info`.

Use a dedicated database role that owns the schema; it does not need `CREATEDB` in production (create the database once, out of band).

## Database

```bash
NODE_ENV=production npm --prefix v2d_Backend run db:migrate   # before starting a new version
```

Migrations are transactional, checksummed and advisory-locked, so concurrent deploys cannot double-apply. Take a backup before migrating (`pg_dump -Fc`). Never run the demo seed or the test suite against production; both refuse to.

## Process

```bash
NODE_ENV=production node v2d_Backend/server.js
```

- Health: `GET /api/v1/health` (liveness), `GET /api/v1/health/ready` (database + migrations + scheduler).
- Graceful shutdown on SIGTERM/SIGINT (stops the scheduler, drains HTTP, closes the pool).
- Logs are JSON lines on stdout/stderr with `requestId` and `userId`; secrets and passwords are redacted by key.
- Put TLS and HTTP compression in the reverse proxy.

## Scaling notes

- The scheduler uses a PostgreSQL advisory lock, so running several API instances is safe — only one runs each tick.
- **Rate-limit counters are in memory per instance.** Per-account lockout is also persisted in the database, but with several instances, per-IP limits multiply. Move the counters to a shared store (e.g. Redis or a PostgreSQL table) before scaling out.
- Sessions are in PostgreSQL; consider a periodic cleanup of revoked/expired rows (`DELETE FROM sessions WHERE absolute_expires_at < now() - interval '30 days'`).

## Email

No SMTP provider is integrated. `MAIL_TRANSPORT=log` writes reset emails to the log in development only; production defaults to `disabled`, in which case "forgot password" tells users to ask an administrator, who issues a one-time reset code. Integrating a provider means implementing `sendMail` in `src/lib/mailer.js`.

## Operational checklist

- [ ] `APP_SECRET`, database credentials and `APP_ORIGIN` set via the platform's secret store (never committed)
- [ ] `npm run db:migrate` run; `/health/ready` returns 200
- [ ] First institution and admin created (see below)
- [ ] Institution timezone, currency, policies and meal types reviewed
- [ ] Waste baselines recorded only from genuine measurements
- [ ] Backups scheduled and a restore tested

### Bootstrapping the first institution

There is intentionally no public sign-up. The operator creates each institution, its first campus and an invited administrator with:

```bash
cd v2d_Backend
NODE_ENV=production npm run bootstrap -- --code RIT --name "Riverside Institute of Technology" \
  --timezone Asia/Kolkata --currency INR \
  --admin-username it.admin --admin-name "IT Administrator" --admin-email it.admin@example.edu
```

It prints a one-time activation code (valid 72 hours, keyed with `APP_SECRET`, so set that first). The administrator activates at `/activate` and provisions everyone else from the app. The script refuses duplicate institution codes, usernames or emails.
