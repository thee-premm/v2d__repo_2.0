# Architecture

## Shape

A **modular monolith**: one Express API, one PostgreSQL database, one React app. At campus scale (hundreds to low thousands of students per mess) this keeps deployment simple and all invariants enforceable with database transactions.

```
Browser (React SPA) ──/api/v1──▶ Express API ──▶ PostgreSQL
                                     │
                                     └─ in-process scheduler (advisory-locked, idempotent ticks)
```

In development Vite proxies `/api` to the API; in production Express serves the built SPA. Either way the browser sees a **single origin**, which keeps cookies and CSRF simple and removes CORS from the normal path.

## Backend layout (`v2d_Backend/src`)

| Path | Responsibility |
|---|---|
| `config/` | Validated environment (`env.js`, fails fast in production), PostgreSQL pool and transactions (`db.js`) |
| `lib/` | Errors, structured logger with request IDs, HTTP helpers, password/code crypto, authoritative clock, units, CSV, mailer |
| `middleware/` | Request context + access log, session loading, CSRF/origin protection, rate limiting, guards, error handler |
| `domain/` | Pure rules: meal lifecycle state machine, permission model, institution policy settings |
| `db/migrator.js` | Versioned SQL migrations with checksums and an advisory lock |
| `modules/<domain>/` | One folder per domain: `*.service.js` (rules + SQL) and route definitions |
| `jobs/scheduler.js` | Time-driven lifecycle work |
| `routes.js` | The single place every router is mounted |

Modules: `auth`, `accounts`, `org`, `catalog`, `meals`, `votes`, `forecasting`, `planning`, `kitchen`, `attendance`, `reconciliation`, `notifications`, `analytics`, `overview`, `audit`.

## Request flow

1. `requestContext` assigns/propagates `X-Request-Id`, runs the request inside AsyncLocalStorage so every log line and audit row carries it.
2. `helmet` sets security headers (strict CSP: scripts from self only).
3. `session` resolves the `v2d_session` cookie (`__Host-` prefixed when Secure) to a server-side session row, **reloads the user's role assignments from the database**, and builds an immutable *principal*. Expired/revoked sessions and inactive accounts end here.
4. `csrf` rejects state-changing requests from foreign origins, requires JSON bodies, and checks `X-CSRF-Token` against the token bound to the session.
5. Route handlers validate input with zod, then call a service. Services authorize against the **resource's own mess** (`loadMess` / `loadSlot`) — never against IDs or roles from the client.
6. Errors of any kind become the JSON error contract in `errorHandler` (no stacks or SQL leak).

## Meal lifecycle

```
DRAFT → OPEN → LOCKED → FORECAST_READY → APPROVED → IN_SERVICE → SERVICE_CLOSED → RECONCILED
  └───────┴───────┴──────────┴───────────────┴──→ CANCELLED (before service only)
```

Transitions are validated in `domain/lifecycle.js` and executed under a row lock on the slot. Votes take a **share** lock on the slot and check the server clock; cutoff processing takes an **exclusive** lock, so an in-flight vote either commits before the snapshot (and is included) or sees the slot locked (and is rejected). This is covered by a concurrency test.

## Scheduler

`jobs/scheduler.js` runs every `SCHEDULER_INTERVAL_SECONDS` inside the API process. Each tick (guarded by `pg_try_advisory_lock`, so only one instance runs it):

1. locks OPEN slots past their cutoff, snapshots intentions, generates a forecast;
2. starts service for APPROVED slots at their start time; closes IN_SERVICE slots at their end time;
3. sends "voting open" and "closing soon" notices (deduplicated per student);
4. alerts supervisors about unapproved meals near service and drafts near cutoff.

Every step is idempotent, so ticks can be retried, run late, or overlap manual actions. A failed forecast falls back to a labelled conservative target — a forecasting outage never blocks a meal.

## Key decisions (and why)

| Decision | Reason |
|---|---|
| Server-side sessions in HttpOnly cookies, not bearer JWTs | Real logout and revocation; role changes and deactivation take effect on the next request; no tokens in JS-readable storage |
| Synchronizer CSRF token + Origin check + JSON-only bodies | Defence in depth for cookie auth, including login CSRF |
| Node `scrypt` for passwords | Memory-hard, no native build dependency (replaced `bcrypt` + `bcryptjs`) |
| No public sign-up | Accounts are provisioned by admins or roster import and activated with one-time codes; privileged roles can't be self-assigned |
| Out-of-scope resources answer 404 | IDs from other messes/institutions can't be probed for existence |
| Redis removed | It was a write-through cache with no reader; PostgreSQL is authoritative |
| Append-only triggers on snapshots, aggregates, forecasts, inventory, vote events, audit | History cannot be silently rewritten; corrections are new, audited records |
| Business time from `lib/clock.js`; local times converted by PostgreSQL | One authoritative clock (testable); correct IANA timezone handling |
| Forecast = vote-group rates with Beta–Binomial shrinkage | Transparent, testable baseline that uses votes and non-responders correctly; see ANALYTICS.md |
| Analytics computed from one shared metric layer (`analytics/metrics.js`) | Supervisor and institution numbers always agree; nulls propagate instead of becoming 0 |

## Frontend (`v2d_Frontend/src`)

| Path | Responsibility |
|---|---|
| `lib/api.ts` | Fetch wrapper: same-origin cookies, CSRF header, typed `ApiError`, session-expiry events, one retry on a stale CSRF token |
| `lib/session.tsx` | Session context from `GET /auth/session` (server-derived roles and scopes) |
| `lib/format.ts` | All dates/times rendered in the institution timezone; missing values render as "—" / "Not recorded" |
| `shell/` | Staff rail and student layouts, mess scope selector |
| `components/` | Design-system components and SVG charts |
| `pages/<workspace>/` | Route screens per role; `pages/analyze` is shared by supervisor and admin |

Route guards only decide what to render; every action is authorized again by the API.
