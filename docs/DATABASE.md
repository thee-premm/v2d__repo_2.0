# Data model and migrations

## Migrations

SQL files in `v2d_Backend/migrations/NNN_name.sql` are applied in order by `npm run db:migrate`, each in its own transaction, recorded in `schema_migrations` with a SHA-256 checksum, under a PostgreSQL advisory lock. Editing an applied migration is detected and refused — add a new migration instead. `npm run db:status` lists state. `GET /api/v1/health/ready` reports pending migrations.

The runner refuses a database that contains the legacy pre-migration schema (from the old `initDb.js`) rather than mixing the two.

## Entities

| Area | Tables |
|---|---|
| Organisation | `institutions` (timezone, currency, policy `settings` JSONB, `is_demo`), `campuses`, `hostels`, `messes`, `meal_types` |
| Identity | `users`, `role_assignments`, `student_profiles`, `mess_memberships`, `sessions`, `account_tokens` |
| Catalogue | `ingredients` (dimension: MASS/VOLUME/COUNT, cost per base unit), `dishes`, `dish_ingredients` (qty per serving in base unit, yield) |
| Meals | `meal_slots` (lifecycle `status`), `meal_slot_menu_items` (uptake fraction) |
| Voting | `votes` (current intent), `vote_events` (history), `vote_snapshots` (frozen at cutoff), `cutoff_aggregates` |
| Planning | `forecasts` (versioned), `preparation_plans`, `plan_ingredient_requirements` (frozen at approval) |
| Inventory | `inventory_transactions` (signed, append-only), `mess_ingredient_settings` (safety stock, pack size, minimum order) |
| Kitchen | `prep_tasks`, `food_logs` (surplus/waste categories, measured vs estimated, voidable), `kitchen_incidents` |
| Accountability | `attendance_events`, `reconciliations`, `attendance_outcomes`, `warnings`, `appeals` |
| Other | `notifications` (deduplicated), `waste_baselines`, `audit_events` |

Every tenant-owned table carries `institution_id`; composite foreign keys `(id, institution_id)` make cross-institution references impossible at the database level.

## Invariants enforced by the database

| Invariant | Mechanism |
|---|---|
| One current vote per student per meal | `votes` primary key `(meal_slot_id, student_user_id)` |
| One active meal per mess, date and meal type | partial unique index excluding `CANCELLED` |
| Consistent meal windows | `CHECK opens < closes ≤ service start < service end` |
| Locked snapshots/aggregates/forecasts never change | `forbid_mutation()` triggers (append-only) |
| No duplicate successful attendance | partial unique index on `attendance_events` where not voided |
| No duplicate warning from a retried reconciliation | unique `(meal_slot_id, student_user_id, kind)` on `warnings` |
| One reconciliation per meal | `reconciliations` primary key `meal_slot_id` |
| One appeal per warning | unique `appeals.warning_id` |
| Overrides carry a reason | `CHECK` on `preparation_plans` |
| Stock movements have the right sign | `CHECK` per `inventory_transactions.kind` |
| Snapshot counts add up | `CHECK yes + no + unvoted = eligible` |
| Active accounts have a password | `CHECK` on `users` |

Rules that need several rows (lifecycle transitions, cutoff timing, eligibility, walk-in policy, unit dimensions) are enforced in services inside transactions with row locks.

## Units, money and time

- Ingredient quantities are stored in base units (kg, l, unit). Conversions only happen within a dimension (`lib/units.js`); g→l and similar are rejected.
- Weights are `NUMERIC(10,3)` kg; money is `NUMERIC(12,4)`; rates `NUMERIC(6,5)`.
- Instants are `TIMESTAMPTZ`. Service dates are `DATE` in the institution timezone. Local wall-clock inputs are converted with PostgreSQL's `AT TIME ZONE` (IANA database).
- A `food_logs` category with no entry means "not recorded" — never zero. A recorded `0 kg` is a real measurement.

## Eligibility

A student is eligible for a meal when they hold a mess membership for the meal's mess covering its service date and their account is `INVITED` or `ACTIVE` (not-yet-activated residents still eat; they count as UNVOTED). One definition (`modules/meals/eligibility.js`) is shared by voting, snapshots, reminders and the counter.
