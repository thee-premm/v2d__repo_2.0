# Phase 0 — Repository Audit (baseline as found)

Audit date: 2026-10-20 · Branch: `updates` (identical to `origin/main`, commit `a54d227`)

## What exists

| Area | Finding |
|---|---|
| Layout | Single `v2d_Backend/` folder. No frontend on any branch (root `.gitignore` already anticipates `v2d_Frontend/`). |
| Stack | Node 24, Express 5, `pg`, ES modules. Deps also include `bcrypt` *and* `bcryptjs`, `jsonwebtoken`, `ioredis`, `cors`, `dotenv`. |
| Schema | `scripts/initDb.js` — `CREATE TABLE IF NOT EXISTS` DDL (14 tables), ad-hoc `ALTER … IF NOT EXISTS`. No migration history. |
| Seeds | `seedData.js` (1 hostel, 1 mess, admin/supervisor/10 students with known passwords), `seedHistoricalData.js` (30 days of *synthetic* attendance/waste). |
| Tests | `npm test` is the npm stub (`exit 1`). `test-auth.js`, `test-db.js`, `scripts/proofOfWork.js` are manual scripts that require a running server and seeded DB. |
| Database | Configured database `v2d_db` **does not exist** on the local PostgreSQL 17 server. Redis is not running. |

## Baseline run (evidence)

* `node server.js` starts and `/health` returns 200.
* Only `/api/v1/auth` and `/api/v1/meals` are mounted. Vote, attendance, exception, forecasting, impact and notification routers exist but are **never mounted** (e.g. `POST /api/v1/votes/cast` → 404).
* `attendaceRoutes.js` fails to import: controller imports `services/attendanceService.js`, file is named `attendaceService.js`.
* With the DB missing, `POST /auth/login` returns an **HTML stack trace with absolute server paths** — the error handler is never registered.
* `npm test` → exit 1 (no tests).

## Security findings

| Severity | Issue |
|---|---|
| Critical | `auditLogger` stores `req.body` for `USER_LOGIN`/`USER_REGISTER` → **plaintext passwords persisted** in `auth_and_system_audit_logs`. |
| Critical | Public `POST /auth/register` accepts any `role`, including `ADMIN`/`SUPERVISOR` (self-escalation). |
| High | Hard-coded JWT fallback secret in `src/config/env.js`; no production validation of secrets. |
| High | Logout is a no-op; 24 h bearer JWTs cannot be revoked; role/mess claims baked into the token stay valid after role changes or deactivation. |
| High | No resource-scope checks: supervisors can read/modify any mess's slots, attendance, waste and analytics by changing IDs (`messId` query param, slot IDs). |
| High | `getTodaySlots`/`getMenus` default to `messId = 1` and accept arbitrary `messId` from any authenticated user. |
| Medium | Notification logs: supervisors can read any user's logs (`?userId=`). |
| Medium | `cors()` wide open; no rate limiting; no security headers. |
| Medium | Login distinguishes "deactivated" from "invalid credentials" (account-state disclosure). |
| Low | `getMe` throws status `44` (typo) → 500. |

## Business-logic / data findings

* **UNVOTED treated as zero demand**: `expected_attendance = yes_votes`; forecasting ignores votes entirely (moving average of past attendance).
* NO voter who attends is recorded as `EXCUSED_OVERRIDE` automatically — no walk-in policy.
* `verifyAttendance` uses `ON CONFLICT DO UPDATE` → duplicate scans silently overwrite instead of being rejected; no check that the student belongs to the slot's mess or that service is running.
* `reconcileNoShows` is not idempotent: re-running increments `consecutive_no_shows` again and issues duplicate penalties; no review window.
* `createMealSlot` upsert silently **unlocks** a locked slot (`is_locked = FALSE`) when re-posted.
* Lifecycle is a single `is_locked` boolean — no forecast/approval/service/reconciliation states.
* Forecast cold-start assumes 75 % of enrolment; enrolment defaults to `10` when the query returns 0.
* `ai_forecast_logs` upsert uses `ON CONFLICT (meal_slot_id)` but the table has no unique constraint on that column → runtime error.
* Impact service **invents** baselines (25 % of cooked mass) and a `$3.50/kg` cost; missing waste logs are reported as `0`; "waste reduction" is computed against the invented baseline.
* Notification "delivery" is a mock that fabricates provider message IDs.
* Timezone: "today" computed with `toISOString()` (UTC), wrong for IST campuses before 05:30.
* No institution/campus concept, no kitchen-staff role, no recipes/ingredients, no inventory, no appeals workflow beyond a status flip, no audit of who changed what.

## Decisions

1. **Modular monolith** in `v2d_Backend/src/modules/<domain>`; keep Express 5 + `pg` (sound choices).
2. **Versioned SQL migrations** (`v2d_Backend/migrations`, `schema_migrations` table, advisory lock) replace `initDb.js`. New schema designed from the product rules; the legacy schema never existed in the configured DB, so no data migration is required.
3. **Server-side sessions** (opaque random token in an `HttpOnly` cookie, SHA-256 hashed at rest, idle + absolute expiry, revocable) + double-submit CSRF token, replacing bearer JWTs. Roles/scopes are re-read from the DB on every request.
4. **Redis removed**: PostgreSQL is authoritative; the "write-through buffer" added a dependency without a consumer.
5. Password hashing with Node's built-in `scrypt` (removes `bcrypt` + `bcryptjs`).
6. **No public self-signup.** Accounts are provisioned by institution admins (single or CSV roster import) and activated with a one-time code.
7. Frontend: new `v2d_Frontend/` (React + Vite + TypeScript, plain CSS design tokens, TanStack Query). In production Express serves the built frontend (same origin → simple cookie/CSRF story).
8. Tests: `node:test` + real PostgreSQL test database (`*_test`, guarded), Vitest for UI.

## Phase plan

| Phase | Scope |
|---|---|
| 1 Foundation | env validation, logger w/ request IDs, error contract, migrations, health/readiness, test harness |
| 2 Auth & design system | sessions, CSRF, rate limiting, provisioning/activation, RBAC + scope, tokens, sign-in, shell |
| 3 Student flow | menus, voting, cutoff enforcement, history |
| 4 Supervisor ops | slot lifecycle, snapshots, forecast review, approval, counter, walk-ins, reconciliation, appeals |
| 5 Kitchen | prep checklist, ingredient requirements, prep records, incidents, food/waste logs, inventory |
| 6 Analyze | shared metric definitions, mess + institution analytics, data quality, CSV export |
| 7 Forecasting & notifications | evaluation, scheduler (auto-lock, auto-forecast, reminders), in-app notifications |
| 8 Hardening | E2E flow, authorization sweep, responsive/a11y review, docs |
