# Testing

## Backend (`v2d_Backend`, Node's built-in test runner)

```bash
npm test            # everything (sequential; each file boots the real app on a random port)
npm run test:unit   # pure domain tests only, no database
```

- Tests run against **`v2d_test`** (or `TEST_DB_NAME`, which must end in `_test`). The database is created and migrated automatically and truncated at the start of each file. `test/helpers/setup.js` refuses any other database name.
- Requires a reachable PostgreSQL with the credentials in `.env` (or env vars).
- Time-dependent rules use the injectable server clock (`clock.advance` exists only when `NODE_ENV=test`).

| File | Covers |
|---|---|
| `test/auth.test.js` | Sessions and cookies, generic failures, role escalation at sign-in, lockout (including unknown identifiers), inactive accounts, logout revocation and cookie replay, CSRF and origin checks, idle expiry, deactivation, no public registration, activation and reset codes, no passwords in the audit trail, error contract |
| `test/lifecycle.test.js` | The full end-to-end loop through HTTP: admin provisioning + activation; recipes with unit checks; scheduling and publishing; voting, vote changes, idempotent repeats; cross-mess and role denials; cutoff rejection; scheduler lock + forecast; immutable snapshot; forecast explanation; override reasons; frozen ingredient requirements; kitchen board and preparation; service start; counter (YES, duplicate, NO-voter authorization, unvoted policy walk-in, outsider, unknown roll, signed vs forged meal pass); waste logging with plausibility check; service close; reconciliation preview, excusal, idempotency, warning tier; appeals (privacy, once only, evidence, resolution); audited correction; student history; supervisor and institution analytics values; baseline comparison; CSV export; audit trail |
| `test/authorization.test.js` | Cross-institution isolation (users, roles, operations, analytics, import), cross-mess isolation, kitchen limits, read-only admin operations, students' own-data-only, unauthenticated access, role revocation mid-session, admin self-protection |
| `test/concurrency.test.js` | Cutoff waits for an in-flight vote; parallel cutoff processing; parallel duplicate scans; parallel reconciliation; rapid vote toggling |
| `test/unit/domain.test.js` | Forecast maths, metric null-propagation and ratio-of-sums, baseline maths, units, CSV, lifecycle table, classification, security helpers, meal-pass signing, settings merge |

## Frontend (`v2d_Frontend`)

```bash
npm test               # Vitest + Testing Library (jsdom)
npm run typecheck      # TypeScript, strict
npm run build          # production build
```

`src/test/ui.test.tsx` covers formatting of missing values, voting (server-confirmed state, cutoff, rejection handling, post-cutoff view) and sign-in (validation, refused workspace guidance).

## Browser smoke test

```bash
# terminal 1 — API with demo data, serving the built app on one origin
npm --prefix v2d_Backend run db:seed:demo          # into a dev database
npm --prefix v2d_Frontend run build
APP_ORIGIN=http://localhost:5000 npm --prefix v2d_Backend start
# terminal 2
BASE_URL=http://localhost:5000 npm --prefix v2d_Frontend run e2e:screens
```

Signs in through the real form as each demo role, visits 29 screens at 1440×900 and 390×844, checks that a student URL-navigating to `/admin` is redirected, saves screenshots to `v2d_Frontend/e2e/out`, and fails on console errors, unexpected failed requests, or horizontal overflow. Uses the locally installed Chrome (`BROWSER_CHANNEL=msedge` for Edge).

## Last recorded results (2026-10-20)

| Suite | Result |
|---|---|
| Backend `npm test` | 85 passed, 0 failed |
| Frontend `npm test` | 8 passed, 0 failed |
| Typecheck / build | clean / built |
| Browser smoke test | 58 page renders (29 × 2 viewports), no console errors, failed requests or overflow |
