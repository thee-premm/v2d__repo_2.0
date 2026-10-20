import { query, withTransaction } from "../../config/db.js";
import { clock } from "../../lib/clock.js";
import { AppError, conflict, notFound, ruleViolation } from "../../lib/errors.js";
import { can } from "../../domain/permissions.js";
import { recordAudit } from "../audit/audit.service.js";
import { getInstitution, loadSlot } from "../org/context.js";
import { isEligible } from "../meals/eligibility.js";
import { readPassToken } from "../votes/votes.service.js";

const INTENT_POLICY_KEY = { NO: "noVoter", UNVOTED: "unvoted" };

async function resolveStudent(client, principal, slot, { rollNumber, passToken }) {
  if (passToken) {
    const pass = readPassToken(passToken);
    if (!pass) throw new AppError(400, "INVALID_PASS", "This meal pass is not valid or has expired. Enter the roll number instead.");
    if (pass.slotId !== Number(slot.id)) throw ruleViolation("This pass is for a different meal", "PASS_FOR_OTHER_MEAL");
    const r = await query(
      `SELECT sp.user_id, sp.roll_number, u.full_name, u.status FROM student_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.user_id = $1 AND sp.institution_id = $2`,
      [pass.userId, principal.institutionId],
      client,
    );
    if (!r.rows[0]) throw notFound("Student");
    return r.rows[0];
  }
  const r = await query(
    `SELECT sp.user_id, sp.roll_number, u.full_name, u.status FROM student_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.institution_id = $1 AND sp.roll_number = $2`,
    [principal.institutionId, rollNumber.trim().toUpperCase()],
    client,
  );
  if (!r.rows[0]) throw new AppError(404, "STUDENT_NOT_FOUND", `No student with roll number ${rollNumber.trim().toUpperCase()}`);
  return r.rows[0];
}

async function counterCounts(client, slotId) {
  const r = await query(
    `SELECT count(*)::int AS verified,
            count(*) FILTER (WHERE intent = 'YES')::int AS yes_voters,
            count(*) FILTER (WHERE walk_in <> 'NOT_WALK_IN')::int AS walk_ins
       FROM attendance_events WHERE meal_slot_id = $1 AND voided_at IS NULL`,
    [slotId],
    client,
  );
  return r.rows[0];
}

/**
 * Verify a student at the counter. Declaration (intent at cutoff), attendance
 * (this event) and policy (walk-in basis) are recorded separately.
 *
 *  - The meal must be IN_SERVICE (or SERVICE_CLOSED for an explicit late entry with a reason).
 *  - The student must have been eligible at cutoff, or be eligible now.
 *  - A second successful verification is rejected (also enforced by a unique index).
 *  - NO voters and non-voters follow the institution's walk-in policy; where
 *    authorization is required the counter must supply a reason.
 */
export async function verify(principal, slotId, input) {
  return withTransaction(async (client) => {
    const slot = await loadSlot(principal, slotId, can.operateMess, client, { forShare: true });
    const late = slot.status === "SERVICE_CLOSED";
    if (slot.status === "APPROVED") throw ruleViolation("Start service before verifying attendance", "SERVICE_NOT_STARTED");
    if (!late && slot.status !== "IN_SERVICE") throw ruleViolation(`Attendance cannot be recorded while the meal is ${slot.status}`, "SERVICE_NOT_OPEN");
    if (late && !input.lateEntryReason) {
      throw ruleViolation("Service has closed. Recording attendance now is a correction and needs a reason.", "LATE_ENTRY_REASON_REQUIRED");
    }

    const student = await resolveStudent(client, principal, slot, input);
    const studentView = { userId: Number(student.user_id), name: student.full_name, rollNumber: student.roll_number };

    const snap = (await query(`SELECT intent FROM vote_snapshots WHERE meal_slot_id = $1 AND student_user_id = $2`, [slot.id, student.user_id], client)).rows[0];
    let intent = snap?.intent;
    if (!snap) {
      const eligibleNow = await isEligible(client, { studentUserId: student.user_id, messId: slot.mess_id, serviceDate: slot.service_date });
      if (!eligibleNow) throw ruleViolation(`${student.full_name} is not a member of this mess for this meal`, "NOT_ELIGIBLE", { student: studentView });
      intent = "UNVOTED"; // joined after cutoff: no declaration exists
    }

    const existing = (
      await query(
        `SELECT ae.verified_at, u.full_name AS verified_by FROM attendance_events ae JOIN users u ON u.id = ae.verified_by
          WHERE ae.meal_slot_id = $1 AND ae.student_user_id = $2 AND ae.voided_at IS NULL`,
        [slot.id, student.user_id],
        client,
      )
    ).rows[0];
    if (existing) throw conflict(`${student.full_name} was already verified for this meal`, "ALREADY_VERIFIED", { student: studentView, verifiedAt: existing.verified_at, verifiedBy: existing.verified_by });

    let walkIn = "NOT_WALK_IN";
    let note = input.note ?? null;
    if (intent !== "YES") {
      const inst = await getInstitution(principal.institutionId, client);
      const policy = inst.settings.walkIn[INTENT_POLICY_KEY[intent]];
      if (policy === "ALLOW") {
        walkIn = "POLICY_PERMITTED";
      } else if (input.walkInReason) {
        walkIn = "AUTHORIZED_EXCEPTION";
        note = input.walkInReason;
      } else {
        throw conflict(
          intent === "NO" ? `${student.full_name} voted NO for this meal. Admitting them needs your authorization.` : `${student.full_name} did not vote. Admitting them needs your authorization.`,
          "WALK_IN_AUTHORIZATION_REQUIRED",
          { student: studentView, intent, policy },
        );
      }
    }
    if (late) note = [note, `Late entry: ${input.lateEntryReason}`].filter(Boolean).join(" · ");

    const now = clock.now();
    const ins = await query(
      `INSERT INTO attendance_events (meal_slot_id, student_user_id, intent, in_snapshot, walk_in, method, note, verified_by, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (meal_slot_id, student_user_id) WHERE voided_at IS NULL DO NOTHING
       RETURNING id`,
      [slot.id, student.user_id, intent, Boolean(snap), walkIn, input.passToken ? "QR" : late ? "MANUAL" : input.method ?? "ROLL_NUMBER", note, principal.userId, now],
      client,
    );
    if (!ins.rowCount) throw conflict(`${student.full_name} was already verified for this meal`, "ALREADY_VERIFIED", { student: studentView });
    if (walkIn === "AUTHORIZED_EXCEPTION" || late) {
      await recordAudit(client, {
        principal,
        messId: slot.mess_id,
        action: late ? "attendance.late_entry" : "attendance.walk_in_authorized",
        entityType: "attendance_event",
        entityId: ins.rows[0].id,
        reason: late ? input.lateEntryReason : input.walkInReason,
        after: { studentUserId: Number(student.user_id), intent, walkIn },
      });
    }
    return {
      id: Number(ins.rows[0].id),
      student: studentView,
      intent,
      inSnapshot: Boolean(snap),
      walkIn,
      verifiedAt: now,
      counts: await counterCounts(client, slot.id),
    };
  });
}

export async function voidAttendance(principal, eventId, { reason }) {
  return withTransaction(async (client) => {
    const ev = (await query(`SELECT * FROM attendance_events WHERE id = $1 FOR UPDATE`, [eventId], client)).rows[0];
    if (!ev) throw notFound("Attendance record");
    const slot = await loadSlot(principal, ev.meal_slot_id, can.operateMess, client, { forShare: true });
    if (!["IN_SERVICE", "SERVICE_CLOSED"].includes(slot.status)) {
      throw ruleViolation("After reconciliation, correct the student's outcome instead", "USE_OUTCOME_CORRECTION");
    }
    if (ev.voided_at) return { id: Number(ev.id), voided: true, unchanged: true };
    await query(`UPDATE attendance_events SET voided_at = $2, voided_by = $3, void_reason = $4 WHERE id = $1`, [ev.id, clock.now(), principal.userId, reason], client);
    await recordAudit(client, { principal, messId: slot.mess_id, action: "attendance.voided", entityType: "attendance_event", entityId: ev.id, reason, before: { studentUserId: ev.student_user_id, verifiedAt: ev.verified_at } });
    return { id: Number(ev.id), voided: true };
  });
}

export async function listAttendance(principal, slotId, { q }) {
  const slot = await loadSlot(principal, slotId, can.operateMess);
  const r = await query(
    `SELECT ae.id, ae.intent, ae.in_snapshot, ae.walk_in, ae.method, ae.note, ae.verified_at, ae.voided_at, ae.void_reason,
            sp.roll_number, u.full_name AS student_name, sp.user_id, vb.full_name AS verified_by
       FROM attendance_events ae JOIN student_profiles sp ON sp.user_id = ae.student_user_id JOIN users u ON u.id = sp.user_id
       JOIN users vb ON vb.id = ae.verified_by
      WHERE ae.meal_slot_id = $1 AND ($2::text IS NULL OR sp.roll_number LIKE upper($2) OR lower(u.full_name) LIKE lower($2))
      ORDER BY ae.verified_at DESC LIMIT 500`,
    [slot.id, q ? `%${q}%` : null],
  );
  return {
    counts: await counterCounts(undefined, slot.id),
    items: r.rows.map((x) => ({
      id: Number(x.id),
      student: { userId: Number(x.user_id), name: x.student_name, rollNumber: x.roll_number },
      intent: x.intent,
      inSnapshot: x.in_snapshot,
      walkIn: x.walk_in,
      method: x.method,
      note: x.note,
      verifiedAt: x.verified_at,
      verifiedBy: x.verified_by,
      voided: Boolean(x.voided_at),
      voidReason: x.void_reason,
    })),
  };
}
