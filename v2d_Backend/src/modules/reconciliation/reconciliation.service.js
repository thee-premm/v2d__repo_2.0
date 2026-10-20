import { query, withTransaction } from "../../config/db.js";
import { clock } from "../../lib/clock.js";
import { badRequest, notFound, ruleViolation } from "../../lib/errors.js";
import { assertStatus, assertTransition } from "../../domain/lifecycle.js";
import { can } from "../../domain/permissions.js";
import { recordAudit } from "../audit/audit.service.js";
import { notify } from "../notifications/notify.js";
import { getInstitution, loadSlot } from "../org/context.js";

/**
 * Classification of one student for one meal. Declaration and attendance are
 * independent inputs; policy (excusal) is a third.
 */
export function classify(intent, attended, excused = false) {
  if (intent === "YES") {
    if (attended) return "YES_ATTENDED";
    return excused ? "EXCUSED" : "YES_NO_SHOW";
  }
  if (intent === "NO") return attended ? "NO_WALK_IN" : "NO_ABSENT";
  return attended ? "UNVOTED_ATTENDED" : "UNVOTED_ABSENT";
}

export const CLASSIFICATIONS = ["YES_ATTENDED", "YES_NO_SHOW", "NO_ABSENT", "NO_WALK_IN", "UNVOTED_ATTENDED", "UNVOTED_ABSENT", "EXCUSED"];

/** Snapshot students plus anyone verified who was not in the snapshot. */
async function computeRows(client, slotId) {
  const r = await query(
    `SELECT s.student_user_id, s.intent::text AS intent, true AS in_snapshot, (ae.id IS NOT NULL) AS attended
       FROM vote_snapshots s
       LEFT JOIN attendance_events ae ON ae.meal_slot_id = s.meal_slot_id AND ae.student_user_id = s.student_user_id AND ae.voided_at IS NULL
      WHERE s.meal_slot_id = $1
     UNION ALL
     SELECT ae.student_user_id, ae.intent::text, false, true
       FROM attendance_events ae
      WHERE ae.meal_slot_id = $1 AND ae.voided_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM vote_snapshots s WHERE s.meal_slot_id = ae.meal_slot_id AND s.student_user_id = ae.student_user_id)`,
    [slotId],
    client,
  );
  return r.rows.map((x) => ({ studentUserId: Number(x.student_user_id), intent: x.intent, inSnapshot: x.in_snapshot, attended: x.attended }));
}

function summarize(rows) {
  const counts = Object.fromEntries(CLASSIFICATIONS.map((c) => [c, 0]));
  for (const r of rows) counts[r.classification] += 1;
  return {
    counts,
    eligibleAtCutoff: rows.filter((r) => r.inSnapshot).length,
    notInSnapshot: rows.filter((r) => !r.inSnapshot).length,
    actualAttendance: rows.filter((r) => r.attended).length,
  };
}

async function priorWarningCounts(client, slot, studentIds, windowDays) {
  if (!studentIds.length) return new Map();
  const r = await query(
    `SELECT w.student_user_id, count(*)::int AS n
       FROM warnings w JOIN meal_slots ms ON ms.id = w.meal_slot_id
      WHERE w.student_user_id = ANY($1::bigint[]) AND w.status IN ('ACTIVE', 'APPEALED', 'UPHELD')
        AND ms.service_date > $2::date - $3::int AND ms.service_date <= $2::date AND w.meal_slot_id <> $4
      GROUP BY w.student_user_id`,
    [studentIds, slot.service_date, windowDays, slot.id],
    client,
  );
  return new Map(r.rows.map((x) => [Number(x.student_user_id), x.n]));
}

async function studentNames(client, ids) {
  if (!ids.length) return new Map();
  const r = await query(
    `SELECT u.id, u.full_name, sp.roll_number FROM users u JOIN student_profiles sp ON sp.user_id = u.id WHERE u.id = ANY($1::bigint[])`,
    [ids],
    client,
  );
  return new Map(r.rows.map((x) => [Number(x.id), { name: x.full_name, rollNumber: x.roll_number }]));
}

/** What reconciliation would do (before), or what it did (after). Supervisor/admin only — contains student names. */
export async function reconciliationView(principal, slotId) {
  const slot = await loadSlot(principal, slotId, can.viewMessAnalytics);
  if (slot.status === "RECONCILED") {
    const [rec, outcomes, warnings] = await Promise.all([
      query(`SELECT r.*, u.full_name AS reconciled_by_name FROM reconciliations r JOIN users u ON u.id = r.reconciled_by WHERE r.meal_slot_id = $1`, [slot.id]),
      query(
        `SELECT o.*, u.full_name, sp.roll_number, cb.full_name AS corrected_by_name
           FROM attendance_outcomes o JOIN users u ON u.id = o.student_user_id JOIN student_profiles sp ON sp.user_id = o.student_user_id
           LEFT JOIN users cb ON cb.id = o.corrected_by
          WHERE o.meal_slot_id = $1 ORDER BY o.classification, sp.roll_number`,
        [slot.id],
      ),
      query(`SELECT id, student_user_id, tier, status FROM warnings WHERE meal_slot_id = $1`, [slot.id]),
    ]);
    const wMap = new Map(warnings.rows.map((w) => [Number(w.student_user_id), { id: Number(w.id), tier: w.tier, status: w.status }]));
    const r = rec.rows[0];
    return {
      state: "RECONCILED",
      reconciledAt: r.reconciled_at,
      reconciledBy: r.reconciled_by_name,
      actualAttendance: r.actual_attendance,
      summary: r.summary,
      outcomes: outcomes.rows.map((o) => ({
        studentUserId: Number(o.student_user_id),
        name: o.full_name,
        rollNumber: o.roll_number,
        intent: o.intent,
        attended: o.attended,
        classification: o.classification,
        excuseReason: o.excuse_reason,
        correctedAt: o.corrected_at,
        correctedBy: o.corrected_by_name,
        correctionReason: o.correction_reason,
        warning: wMap.get(Number(o.student_user_id)) ?? null,
      })),
    };
  }
  assertStatus(slot, ["IN_SERVICE", "SERVICE_CLOSED"], "preview reconciliation");
  const inst = await getInstitution(principal.institutionId);
  const rows = (await computeRows(undefined, slot.id)).map((r) => ({ ...r, classification: classify(r.intent, r.attended) }));
  const candidates = rows.filter((r) => r.classification === "YES_NO_SHOW");
  const [names, prior] = await Promise.all([
    studentNames(undefined, candidates.map((c) => c.studentUserId)),
    priorWarningCounts(undefined, slot, candidates.map((c) => c.studentUserId), inst.settings.warnings.windowDays),
  ]);
  return {
    state: slot.status === "SERVICE_CLOSED" ? "READY" : "SERVICE_OPEN",
    summary: summarize(rows),
    warningPolicy: inst.settings.warnings,
    noShowCandidates: candidates.map((c) => ({
      studentUserId: c.studentUserId,
      ...names.get(c.studentUserId),
      priorWarningsInWindow: prior.get(c.studentUserId) ?? 0,
      wouldReceiveTier: inst.settings.warnings.enabled ? Math.min(3, (prior.get(c.studentUserId) ?? 0) + 1) : null,
    })),
  };
}

/**
 * Finalize a closed meal. Idempotent: repeating it returns the stored result
 * and never issues a second warning (also guaranteed by a unique constraint).
 */
export async function reconcile(principal, slotId, { excusals }) {
  const result = await withTransaction(async (client) => {
    const slot = await loadSlot(principal, slotId, can.operateMess, client, { forUpdate: true });
    if (slot.status === "RECONCILED") return { alreadyReconciled: true };
    assertTransition(slot.status, "RECONCILED");
    const inst = await getInstitution(principal.institutionId, client);
    const now = clock.now();

    const rows = await computeRows(client, slot.id);
    const excuseMap = new Map(excusals.map((e) => [Number(e.studentUserId), e.reason]));
    for (const id of excuseMap.keys()) {
      const row = rows.find((r) => r.studentUserId === id);
      if (!row || row.intent !== "YES" || row.attended) throw badRequest("Only YES voters without verified attendance can be excused", [{ field: "excusals", message: `Student ${id} is not a no-show candidate` }]);
    }
    for (const r of rows) r.classification = classify(r.intent, r.attended, excuseMap.has(r.studentUserId));

    const noShows = rows.filter((r) => r.classification === "YES_NO_SHOW");
    const prior = await priorWarningCounts(client, slot, noShows.map((r) => r.studentUserId), inst.settings.warnings.windowDays);
    const summary = summarize(rows);
    summary.excused = excuseMap.size;
    summary.warningsIssued = 0;

    await query(`INSERT INTO reconciliations (meal_slot_id, reconciled_at, reconciled_by, actual_attendance, summary) VALUES ($1, $2, $3, $4, $5)`, [
      slot.id,
      now,
      principal.userId,
      summary.actualAttendance,
      JSON.stringify(summary),
    ], client);
    for (const r of rows) {
      await query(
        `INSERT INTO attendance_outcomes (meal_slot_id, student_user_id, intent, attended, classification, excuse_reason) VALUES ($1, $2, $3, $4, $5, $6)`,
        [slot.id, r.studentUserId, r.intent, r.attended, r.classification, excuseMap.get(r.studentUserId) ?? null],
        client,
      );
    }
    if (inst.settings.warnings.enabled) {
      for (const r of noShows) {
        const tier = Math.min(3, (prior.get(r.studentUserId) ?? 0) + 1);
        const w = await query(
          `INSERT INTO warnings (institution_id, mess_id, meal_slot_id, student_user_id, kind, tier, reason, issued_at)
           VALUES ($1, $2, $3, $4, 'NO_SHOW', $5, $6, $7)
           ON CONFLICT (meal_slot_id, student_user_id, kind) DO NOTHING RETURNING id`,
          [principal.institutionId, slot.mess_id, slot.id, r.studentUserId, tier, `Voted YES for ${slot.meal_type_name} on ${slot.service_date} but attendance was not verified.`, now],
          client,
        );
        if (w.rowCount) {
          summary.warningsIssued += 1;
          await notify(client, {
            userId: r.studentUserId,
            kind: "WARNING_ISSUED",
            title: `${["", "Reminder", "Formal warning", "Escalated warning"][tier]}: missed ${slot.meal_type_name}, ${slot.service_date}`,
            body: `You voted YES but your attendance was not verified. If this is wrong, you can appeal within ${inst.settings.warnings.appealWindowDays} days.`,
            link: "/student/warnings",
            dedupeKey: `warning:${w.rows[0].id}`,
          });
        }
      }
    }
    await query(`UPDATE reconciliations SET summary = $2 WHERE meal_slot_id = $1`, [slot.id, JSON.stringify(summary)], client);
    await query(`UPDATE meal_slots SET status = 'RECONCILED', reconciled_at = $2 WHERE id = $1`, [slot.id, now], client);
    await recordAudit(client, {
      principal,
      messId: slot.mess_id,
      action: "slot.reconciled",
      entityType: "meal_slot",
      entityId: slot.id,
      after: { ...summary, excusals: excusals.map((e) => ({ studentUserId: e.studentUserId, reason: e.reason })) },
    });
    return { alreadyReconciled: false };
  });
  return { ...(await reconciliationView(principal, slotId)), alreadyReconciled: result.alreadyReconciled };
}

/** Audited correction of one student's reconciled outcome. Warnings follow the corrected classification. */
export async function correctOutcome(principal, slotId, studentUserId, { attended, excuseReason, reason }) {
  await withTransaction(async (client) => {
    const slot = await loadSlot(principal, slotId, can.operateMess, client, { forUpdate: true });
    assertStatus(slot, ["RECONCILED"], "correct an outcome");
    const o = (await query(`SELECT * FROM attendance_outcomes WHERE meal_slot_id = $1 AND student_user_id = $2 FOR UPDATE`, [slot.id, studentUserId], client)).rows[0];
    if (!o) throw notFound("Outcome");
    const newAttended = attended ?? o.attended;
    const excused = excuseReason ? true : o.classification === "EXCUSED" && attended === undefined;
    const newClass = classify(o.intent, newAttended, excused && !newAttended);
    if (newClass === o.classification && newAttended === o.attended) throw ruleViolation("This correction does not change the outcome", "NO_CHANGE");
    const now = clock.now();
    await query(
      `UPDATE attendance_outcomes SET attended = $3, classification = $4, excuse_reason = $5, corrected_at = $6, corrected_by = $7, correction_reason = $8
        WHERE meal_slot_id = $1 AND student_user_id = $2`,
      [slot.id, studentUserId, newAttended, newClass, newClass === "EXCUSED" ? (excuseReason ?? o.excuse_reason) : null, now, principal.userId, reason],
      client,
    );
    const warning = (await query(`SELECT * FROM warnings WHERE meal_slot_id = $1 AND student_user_id = $2 AND kind = 'NO_SHOW' FOR UPDATE`, [slot.id, studentUserId], client)).rows[0];
    if (o.classification === "YES_NO_SHOW" && newClass !== "YES_NO_SHOW" && warning && ["ACTIVE", "APPEALED", "UPHELD"].includes(warning.status)) {
      await query(`UPDATE warnings SET status = 'VOIDED' WHERE id = $1`, [warning.id], client);
      await query(
        `UPDATE appeals SET status = 'WAIVED', resolved_at = $2, resolved_by = $3, resolution_note = 'Warning withdrawn after an attendance correction.' WHERE warning_id = $1 AND status = 'PENDING'`,
        [warning.id, now, principal.userId],
        client,
      );
      await notify(client, {
        userId: studentUserId,
        kind: "WARNING_WITHDRAWN",
        title: `Warning withdrawn: ${slot.meal_type_name}, ${slot.service_date}`,
        body: "Your attendance record was corrected and the warning no longer applies.",
        link: "/student/warnings",
        dedupeKey: `warning-void:${warning.id}:${now.getTime()}`,
      });
    }
    if (newClass === "YES_NO_SHOW" && o.classification !== "YES_NO_SHOW") {
      const inst = await getInstitution(principal.institutionId, client);
      if (inst.settings.warnings.enabled) {
        if (warning) {
          await query(`UPDATE warnings SET status = 'ACTIVE', issued_at = $2 WHERE id = $1`, [warning.id, now], client);
        } else {
          const prior = await priorWarningCounts(client, slot, [studentUserId], inst.settings.warnings.windowDays);
          await query(
            `INSERT INTO warnings (institution_id, mess_id, meal_slot_id, student_user_id, kind, tier, reason, issued_at) VALUES ($1, $2, $3, $4, 'NO_SHOW', $5, $6, $7)`,
            [principal.institutionId, slot.mess_id, slot.id, studentUserId, Math.min(3, (prior.get(studentUserId) ?? 0) + 1), `Voted YES for ${slot.meal_type_name} on ${slot.service_date}; attendance corrected to absent: ${reason}`, now],
            client,
          );
        }
      }
    }
    // Keep the stored summary consistent with the outcomes.
    const all = (await query(`SELECT intent, attended, classification, (student_user_id IN (SELECT student_user_id FROM vote_snapshots WHERE meal_slot_id = $1)) AS in_snapshot FROM attendance_outcomes WHERE meal_slot_id = $1`, [slot.id], client)).rows.map(
      (x) => ({ intent: x.intent, attended: x.attended, classification: x.classification, inSnapshot: x.in_snapshot }),
    );
    const prev = (await query(`SELECT summary FROM reconciliations WHERE meal_slot_id = $1`, [slot.id], client)).rows[0].summary;
    const summary = { ...prev, ...summarize(all), corrections: (prev.corrections ?? 0) + 1 };
    await query(`UPDATE reconciliations SET summary = $2, actual_attendance = $3 WHERE meal_slot_id = $1`, [slot.id, JSON.stringify(summary), summary.actualAttendance], client);
    await recordAudit(client, {
      principal,
      messId: slot.mess_id,
      action: "outcome.corrected",
      entityType: "attendance_outcome",
      entityId: `${slot.id}:${studentUserId}`,
      reason,
      before: { attended: o.attended, classification: o.classification },
      after: { attended: newAttended, classification: newClass },
    });
  });
  return reconciliationView(principal, slotId);
}
