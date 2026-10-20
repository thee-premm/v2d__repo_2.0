# Roles and permissions

Permissions are the **union of a user's active role assignments**, reloaded from the database on every request. The workspace chosen at sign-in only orients the interface; choosing a role you don't hold is refused (`403 ROLE_NOT_ASSIGNED`) and no session is created.

Scopes:

- **STUDENT** — own records only; meal eligibility comes from an open mess membership.
- **KITCHEN_STAFF** and **SUPERVISOR** — assigned per mess (one assignment row per mess).
- **INSTITUTION_ADMIN** — whole institution; never another institution.

Resources outside the caller's scope return **404** (not 403), so IDs cannot be probed. A role the caller lacks entirely returns **403**.

| Capability | Student | Kitchen (mess) | Supervisor (mess) | Admin (institution) |
|---|:-:|:-:|:-:|:-:|
| Vote / change vote before cutoff (eligible meals) | ✓ | | | |
| Own meal history, warnings, appeals, meal pass | ✓ | | | |
| Notifications, own account, password change | ✓ | ✓ | ✓ | ✓ |
| View meal operations (aggregates only) | | ✓ | ✓ | ✓ read-only |
| Create / edit / publish / cancel meals, menus | | | ✓ | |
| Close voting, re-run forecast, approve/override target | | | ✓ | |
| Start / close service, counter verification, walk-in authorization | | | ✓ | |
| Reconcile, excuse, correct outcomes, resolve appeals | | | ✓ | |
| Student-level attendance and warnings | | | ✓ | ✓ read-only |
| Preparation tasks, food & waste logs, incidents, stock movements | | ✓ | ✓ | read-only |
| Resolve kitchen incidents, stock settings | | | ✓ | |
| Dish & ingredient catalogue | read | read | ✓ | ✓ |
| Mess analytics + export | | | ✓ | ✓ (any mess) |
| Institution analytics + export | | | | ✓ |
| Accounts, roles, roster import, activation/reset codes | | | | ✓ |
| Campuses, hostels, messes, meal types, policies, baselines | | | | ✓ |
| Audit trail | | | | ✓ |

Guard rails:

- An admin cannot change their own status or remove their own admin role, and an institution always keeps at least one admin.
- Student roles come only with a student profile; they cannot be granted bare.
- Deactivating or suspending a user revokes all their sessions immediately.
- Revoking a role mid-session takes effect on the next request; if the session's workspace role is gone, it falls back to another held role.

These rules are exercised by `v2d_Backend/test/authorization.test.js` and `test/lifecycle.test.js`.
