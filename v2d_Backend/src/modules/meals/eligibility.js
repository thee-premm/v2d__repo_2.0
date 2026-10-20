import { query } from "../../config/db.js";

/**
 * The single definition of meal eligibility, shared by voting, cutoff
 * snapshots, reminders and the counter:
 *
 *   A student is eligible for a meal slot when they hold a mess membership for
 *   the slot's mess covering the slot's service date, and their account is
 *   INVITED or ACTIVE. Invited (not yet activated) residents are eligible —
 *   they still eat — and count as UNVOTED until they vote.
 *
 * `eligibleStudentsCte(messParam, dateParam)` returns a CTE body selecting
 * `student_user_id`.
 */
export function eligibleStudentsCte(messParam, dateParam) {
  return `
    SELECT mm.student_user_id
      FROM mess_memberships mm
      JOIN users u ON u.id = mm.student_user_id
     WHERE mm.mess_id = ${messParam}
       AND mm.valid_from <= ${dateParam}
       AND (mm.valid_to IS NULL OR mm.valid_to >= ${dateParam})
       AND u.status IN ('INVITED', 'ACTIVE')`;
}

export async function isEligible(client, { studentUserId, messId, serviceDate }) {
  const r = await query(
    `WITH eligible AS (${eligibleStudentsCte("$1", "$2::date")}) SELECT 1 FROM eligible WHERE student_user_id = $3`,
    [messId, serviceDate, studentUserId],
    client,
  );
  return r.rowCount > 0;
}

/** Live counts for a slot still open for voting (not a snapshot). */
export async function liveVoteCounts(client, slot) {
  const r = await query(
    `WITH eligible AS (${eligibleStudentsCte("$1", "$2::date")})
     SELECT count(*)::int AS eligible,
            count(v.intent) FILTER (WHERE v.intent = 'YES')::int AS yes,
            count(v.intent) FILTER (WHERE v.intent = 'NO')::int AS no
       FROM eligible e LEFT JOIN votes v ON v.meal_slot_id = $3 AND v.student_user_id = e.student_user_id`,
    [slot.mess_id, slot.service_date, slot.id],
    client,
  );
  const { eligible, yes, no } = r.rows[0];
  return { eligible, yes, no, unvoted: eligible - yes - no };
}
