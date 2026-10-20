# Implementation progress

Status key: **Done** = implemented, tested and verified · **Partial** = implemented, with stated gaps · **Not done** = not implemented.

## Phase log (2026-10-20)

| Phase | Status | Evidence |
|---|---|---|
| 0 Audit | Done | [AUDIT.md](AUDIT.md): unmounted routers, broken import, plaintext passwords in the audit log, public admin self-registration, unscoped data access, invented baselines |
| 1 Foundation | Done | Validated config, request IDs, JSON logs with redaction, error contract, checksummed migrations, health/readiness, test harness |
| 2 Design system & auth | Done | Tokens, light/dark modes, shells for 4 roles; sessions, CSRF, lockout, activation/reset codes, role escalation refused (auth suite 17/17) |
| 3 Student flow | Done | Meals, menus, vote/change, cutoff, meal pass, history, warnings, appeals |
| 4 Supervisor ops | Done | Scheduling, menus, publish, cutoff snapshot, forecast review, approval/override, counter + walk-ins, reconciliation, corrections, appeals |
| 5 Kitchen | Done | Preparation board, tasks with prepared weights, recipe quantities, food/waste ledger, incidents, stock movements, procurement outlook |
| 6 Analyze | Done | Shared metric layer, mess + institution views, findings, completeness, baseline comparison, CSV exports |
| 7 Forecasting & notifications | Partial | Forecast model, versions, accuracy; scheduler auto-lock/forecast/service windows/reminders; **in-app** notifications only (no email/SMS/push delivery) |
| 8 Hardening | Partial | E2E, authorization, concurrency, UI and browser suites pass; see open items |

Verification run: backend 85/85, frontend 8/8, TypeScript clean, production build OK, browser smoke test 58/58 renders with no console errors, failed requests or horizontal overflow (desktop 1440×900 and phone 390×844).

## Known limitations

1. **Outbound delivery.** Notifications are in-app. Email exists only as a development log transport; no SMTP/SMS/push provider is integrated. Password reset in production relies on admin-issued codes.
2. **Rate limits are per process** (in memory). Account lockout is persisted, but per-IP limits multiply with several instances.
3. **Forecast features.** Day-of-week, menu, exam-calendar and weather effects are not modelled; history excludes holidays and special events. The model reports this uncertainty rather than hiding it.
4. **Recipes are per serving.** No batch recipes, substitutions as recipe variants, or supplier lead times; procurement suggestions do not place orders.
5. **Eligibility is mess membership.** Leave/vacation calendars (students away for a period) are not modelled; such students appear as UNVOTED unless they vote NO.
6. **Counter camera scanning** uses the browser `BarcodeDetector` API (Chromium/Android); elsewhere use a keyboard-wedge scanner or the roll number.
7. **Accessibility** was reviewed by construction (semantics, focus, labels, contrast tokens, reduced motion) and smoke-tested in Chrome; no screen-reader or full WCAG audit has been performed.
8. **Single locale** (English, `en-IN` number/date formats).
9. **Demo data is simulated.** `db:seed:demo` creates a flagged institution; its numbers are not evidence of real-world impact.

## Decisions taken (and open questions)

| Topic | Decision taken | Open for the product owner |
|---|---|---|
| Who verifies attendance | Supervisors (add counter staff as supervisors of that mess) | A separate "counter" role with fewer rights? |
| Walk-in default | NO voters need authorization with a reason; non-voters admitted under policy | Institution-specific rules |
| Warnings | Tiered reminders over 30 days, appeal within 7 days, no fines | Escalation process after tier 3 |
| Admins and operations | Admins read operations and analytics but do not run them | Should admins be able to act in an emergency? |
| Login identifier | Username (roll number by default) or email | Single sign-on with the campus identity provider |

## Next steps

1. Integrate an email/SMS provider behind `src/lib/mailer.js` and add a delivery queue with retries.
2. Shared rate-limit store before running more than one API instance.
3. Add day-of-week and menu effects to the forecast once enough reconciled history exists, evaluated against the current model with walk-forward validation.
4. Student leave calendar feeding eligibility.
5. Screen-reader audit (NVDA/VoiceOver) of the voting and counter flows.
