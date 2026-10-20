# API reference (`/api/v1`)

## Conventions

- **Auth:** HttpOnly session cookie set by `POST /auth/login`. Send `X-CSRF-Token: <csrfToken>` (from login or `GET /auth/session`) on every non-GET request. Bodies must be JSON.
- **Success:** `{ "success": true, "data": …, "meta"?: … }`
- **Error:** `{ "success": false, "error": { "code", "message", "details"? }, "requestId" }`. `details` holds per-field issues for `VALIDATION_FAILED`.
- **Status codes:** 400 invalid input · 401 `UNAUTHENTICATED`/`SESSION_EXPIRED`/`INVALID_CREDENTIALS` · 403 role missing, CSRF, origin · 404 not found **or outside your scope** · 409 conflicts (`ALREADY_VERIFIED`, `WALK_IN_AUTHORIZATION_REQUIRED`, `ALREADY_APPEALED`…) · 422 business rules (`VOTING_CLOSED`, `INVALID_TRANSITION`, `SERVICE_NOT_STARTED`…) · 429 rate limited.
- **Times:** instants are ISO-8601 UTC. Inputs marked *local* (`YYYY-MM-DD`, `HH:MM`, `YYYY-MM-DDTHH:MM`) are interpreted in the institution timezone.
- Every response carries `X-Request-Id`.

## Health

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/health/ready` | Database reachable, pending migrations, scheduler status (503 if not ready) |

## Auth (public unless noted)

| Method | Path | Body / notes |
|---|---|---|
| POST | `/auth/login` | `{ identifier, password, role? }` → cookie + `{ csrfToken }`. `role` must be assigned (else 403 `ROLE_NOT_ASSIGNED`). Rate-limited per IP and per identifier |
| GET | `/auth/session` | 🔒 user, institution, roles, active role, scopes, messes, `csrfToken` |
| POST | `/auth/logout` | 🔒 revokes the session |
| POST | `/auth/switch-role` | 🔒 `{ role }` (must be held) |
| POST | `/auth/activate` | `{ identifier, code, password }` — invited accounts |
| POST | `/auth/password-reset/request` | `{ identifier }` → always 202, same response for unknown accounts |
| POST | `/auth/password-reset/confirm` | `{ identifier, code, password }` — revokes all sessions |
| POST | `/auth/password/change` | 🔒 `{ currentPassword, newPassword }` — revokes other sessions |

There is no registration endpoint.

## Student (`/me`, STUDENT role)

| Method | Path | Notes |
|---|---|---|
| GET | `/me/meals?days=7` | Upcoming meals of the current mess, menu, own vote, `votingState`, `serverTime` |
| PUT | `/me/meals/:slotId/vote` | `{ intent: "YES"\|"NO" }`; idempotent; 422 `VOTING_CLOSED`/`VOTING_NOT_OPEN`/`MEAL_CANCELLED` |
| GET | `/me/meals/:slotId/pass` | Signed QR token after voting closes |
| GET | `/me/history?limit&offset` | Intent at cutoff, counter record, classification, warning |
| GET | `/me/warnings` | Own warnings, appeal state, `canAppeal` |
| POST | `/me/warnings/:id/appeal` | `{ reason }` (10–2000 chars), once, within the appeal window |
| GET | `/me/notifications?unreadOnly&limit` | Any role |
| POST | `/me/notifications/:id/read`, `/me/notifications/read-all` | Any role |

## Organisation (any signed-in user)

`GET /org/institution` · `GET /org/messes` (messes visible to you) · `GET /org/meal-types`

## Catalogue

| Method | Path | Notes |
|---|---|---|
| GET | `/catalog/ingredients`, `/catalog/dishes`, `/catalog/dishes/:id` | Staff |
| POST/PATCH | `/catalog/ingredients[/:id]` | Supervisor or admin. `dimension` fixed at creation |
| POST/PATCH | `/catalog/dishes[/:id]` | Supervisor or admin |
| PUT | `/catalog/dishes/:id/ingredients` | `{ ingredients: [{ ingredientId, quantity, unit, yieldFactor? }] }`; unit must match the ingredient's dimension |

## Meal operations (supervisor; kitchen/admin read where noted)

| Method | Path | Notes |
|---|---|---|
| GET | `/messes/:messId/overview?date` | Today, next two days, items needing attention |
| GET | `/messes/:messId/slots?from&to&status` | Read: supervisor, kitchen, admin |
| POST | `/messes/:messId/slots` | `{ mealTypeId, serviceDate, serviceStart?, serviceEnd?, votingOpensAt?, votingClosesAt?, notes?, isSpecialEvent?, isExamPeriod?, isHoliday?, menu? }` (local times) → DRAFT |
| POST | `/messes/:messId/schedule` | `{ fromDate, toDate, mealTypeIds, copyMenuFromDaysBefore? }` → drafts from defaults |
| GET | `/slots/:slotId` | Detail: votes (live or snapshot), forecast, plan, service summary, allowed `actions` |
| PATCH | `/slots/:slotId` | Times/notes/flags (DRAFT or OPEN; students notified of changes) |
| PUT | `/slots/:slotId/menu` | `{ menu: [{ dishId, uptakeFraction? }] }` until approval |
| POST | `/slots/:slotId/publish` | DRAFT → OPEN (menu required, cutoff in future) |
| POST | `/slots/:slotId/cancel` | `{ reason }` (before service) |
| POST | `/slots/:slotId/lock` | After cutoff; idempotent; snapshot + forecast |
| POST | `/slots/:slotId/forecast` | Re-run forecast (new version) |
| GET | `/slots/:slotId/forecasts` | All versions |
| GET | `/slots/:slotId/requirements?servings` | Frozen after approval, preview before |
| POST | `/slots/:slotId/approve` | `{ servings?, reason? }`; reason required for overrides and revisions |
| POST | `/slots/:slotId/start-service`, `/close-service` | |
| GET | `/messes/:messId/forecast-accuracy?mealTypeId&limit` | Predicted vs actual |

## Counter and reconciliation (supervisor)

| Method | Path | Notes |
|---|---|---|
| GET | `/slots/:slotId/attendance?q` | Verifications with student details |
| POST | `/slots/:slotId/attendance` | `{ rollNumber \| passToken, walkInReason?, lateEntryReason?, note? }`; 409 `ALREADY_VERIFIED`; 409 `WALK_IN_AUTHORIZATION_REQUIRED` (resubmit with `walkInReason`); 422 `NOT_ELIGIBLE` |
| POST | `/attendance/:id/void` | `{ reason }` before reconciliation |
| GET | `/slots/:slotId/reconciliation` | Preview (counts, no-show candidates, would-be tiers) or final result |
| POST | `/slots/:slotId/reconcile` | `{ excusals: [{ studentUserId, reason }] }`; idempotent |
| POST | `/slots/:slotId/outcomes/:studentUserId/correct` | `{ attended?, excuseReason?, reason }`; warnings follow the correction |
| GET | `/messes/:messId/warnings?status`, `/messes/:messId/appeals?status` | Supervisor or admin |
| POST | `/appeals/:id/resolve` | `{ decision: "UPHELD"\|"WAIVED", note }` |

## Kitchen and stock (kitchen or supervisor of the mess)

| Method | Path | Notes |
|---|---|---|
| GET | `/kitchen/board?messId&date` | Meals for the day, approved targets, task progress |
| GET | `/slots/:slotId/kitchen` | Tasks, food logs, incidents |
| POST | `/prep-tasks/:id/start`, `/prep-tasks/:id/complete` | complete: `{ preparedQuantity, unit: "kg"\|"g", measurement, deviationNote? }` |
| GET/POST | `/slots/:slotId/food-logs` | `{ category, quantity, unit, measurement, dishId?, note? }` |
| POST | `/food-logs/:id/void` | `{ reason }` |
| GET/POST | `/messes/:messId/incidents` | Report `{ kind, description, mealSlotId?, ingredientId? }` |
| POST | `/incidents/:id` | Supervisor: `{ status: "ACKNOWLEDGED"\|"RESOLVED", resolutionNote? }` |
| GET | `/messes/:messId/inventory`, `/inventory/transactions` | Stock on hand, movements |
| POST | `/messes/:messId/inventory/transactions` | `{ ingredientId, kind, direction?, quantity, unit, unitCost?, mealSlotId?, note? }` |
| PUT | `/messes/:messId/inventory/settings/:ingredientId` | Supervisor: `{ safetyStock, packSize?, minOrder? }` |
| GET | `/messes/:messId/procurement?from&to` | Procurement outlook |

## Analytics

| Method | Path | Notes |
|---|---|---|
| GET | `/messes/:messId/analytics?from&to&mealTypeId` | Supervisor of the mess or admin |
| GET | `/messes/:messId/analytics/export.csv?…` | CSV with metadata and definitions |
| GET | `/admin/analytics?from&to&mealTypeId`, `/admin/analytics/export.csv` | Admin |
| GET | `/definitions/metrics` | Metric definitions |

## Administration (INSTITUTION_ADMIN)

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/overview` | Messes, accounts, exceptions, data quality |
| GET/POST | `/admin/users` | List (q, role, status, messId, paging) / create staff or student → one-time activation code |
| GET/PATCH | `/admin/users/:id` | Detail / edit profile |
| POST | `/admin/users/:id/status` | `{ status, reason }` |
| POST | `/admin/users/:id/roles`, `/admin/users/:id/roles/:assignmentId/revoke` | Grant `{ role, messId? }` / revoke `{ reason }` |
| POST | `/admin/users/:id/codes` | `{ purpose: "ACTIVATION"\|"PASSWORD_RESET" }` → code shown once |
| PUT | `/admin/users/:id/membership` | `{ messId, validFrom }` |
| POST | `/admin/students/import` | `{ csv, dryRun }` — all-or-nothing |
| GET/PATCH | `/admin/institution` · PUT `/admin/settings` | Name/timezone/currency · policy settings |
| GET | `/admin/structure` · POST/PATCH `/admin/campuses`, `/admin/hostels`, `/admin/messes` | |
| POST/PATCH | `/admin/meal-types[/:id]` | |
| GET/POST | `/admin/baselines` | Waste baselines |
| GET | `/admin/audit?action&entityType&messId&actorId&from&to` | Audit trail |
