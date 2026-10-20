/**
 * Authorization model.
 *
 * A principal is rebuilt from the database on every request (never from the
 * client or a long-lived token), so role and scope changes take effect
 * immediately.
 *
 *   STUDENT            own votes, history, warnings, appeals, notifications
 *   KITCHEN_STAFF      preparation, food/waste logs, inventory, incidents — assigned messes only
 *   SUPERVISOR         all meal operations + analytics — assigned messes only
 *   INSTITUTION_ADMIN  accounts, structure, policy, audit, read-only operations and analytics — own institution
 *
 * The "workspace" a user picks at sign-in only orients the UI; permissions are
 * the union of their active role assignments.
 */
export const ROLES = Object.freeze(["STUDENT", "SUPERVISOR", "KITCHEN_STAFF", "INSTITUTION_ADMIN"]);

export function buildPrincipal({ user, assignments, student, activeRole, sessionId }) {
  const roles = new Set(assignments.map((a) => a.role));
  const messIdsFor = (role) => new Set(assignments.filter((a) => a.role === role && a.mess_id).map((a) => Number(a.mess_id)));
  return Object.freeze({
    sessionId,
    userId: Number(user.id),
    institutionId: Number(user.institution_id),
    username: user.username,
    fullName: user.full_name,
    email: user.email,
    roles,
    activeRole,
    isAdmin: roles.has("INSTITUTION_ADMIN"),
    supervisorMessIds: messIdsFor("SUPERVISOR"),
    kitchenMessIds: messIdsFor("KITCHEN_STAFF"),
    student:
      roles.has("STUDENT") && student
        ? Object.freeze({
            userId: Number(user.id),
            rollNumber: student.roll_number,
            messId: student.mess_id ? Number(student.mess_id) : null,
            hostelId: student.hostel_id ? Number(student.hostel_id) : null,
          })
        : null,
  });
}

const sameInstitution = (p, mess) => Number(mess.institution_id) === p.institutionId;

/** Capability checks against a mess row ({ id, institution_id }). */
export const can = {
  /** Run meal operations: schedule, approve, counter, reconcile, appeals. */
  operateMess: (p, mess) => sameInstitution(p, mess) && p.supervisorMessIds.has(Number(mess.id)),
  /** Record kitchen work: prep, food logs, inventory, incidents. */
  workKitchen: (p, mess) =>
    sameInstitution(p, mess) && (p.kitchenMessIds.has(Number(mess.id)) || p.supervisorMessIds.has(Number(mess.id))),
  /** Read the operational state of a mess. */
  viewOperations: (p, mess) =>
    sameInstitution(p, mess) &&
    (p.isAdmin || p.supervisorMessIds.has(Number(mess.id)) || p.kitchenMessIds.has(Number(mess.id))),
  /** Read mess analytics and student accountability records. */
  viewMessAnalytics: (p, mess) => sameInstitution(p, mess) && (p.isAdmin || p.supervisorMessIds.has(Number(mess.id))),
  /** Manage the shared dish/ingredient catalogue. */
  manageCatalog: (p) => p.isAdmin || p.supervisorMessIds.size > 0,
  viewCatalog: (p) => p.isAdmin || p.supervisorMessIds.size > 0 || p.kitchenMessIds.size > 0,
};

/** Mess IDs whose operations the principal may see. `null` = every mess in the institution. */
export function visibleMessIds(p) {
  if (p.isAdmin) return null;
  return [...new Set([...p.supervisorMessIds, ...p.kitchenMessIds])];
}
