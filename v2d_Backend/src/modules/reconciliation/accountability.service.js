import { query, withTransaction } from "../../config/db.js";
import { clock } from "../../lib/clock.js";
import { conflict, forbidden, notFound, ruleViolation } from "../../lib/errors.js";
import { can } from "../../domain/permissions.js";
import { recordAudit } from "../audit/audit.service.js";
import { notify, notifySupervisors } from "../notifications/notify.js";
import { getInstitution, loadMess } from "../org/context.js";

const TIER_LABEL = { 1: "Reminder", 2: "Formal warning", 3: "Escalated for review" };

function warningView(w, appealWindowDays, now) {
  const deadline = new Date(w.issued_at.getTime() + appealWindowDays * 86_400_000);
  return {
    id: Number(w.id),
    kind: w.kind,
    tier: w.tier,
    tierLabel: TIER_LABEL[w.tier],
    reason: w.reason,
    status: w.status,
    issuedAt: w.issued_at,
    meal: { slotId: Number(w.meal_slot_id), serviceDate: w.service_date, mealType: w.meal_type_name, messName: w.mess_name },
    appealDeadline: deadline,
    canAppeal: w.status === "ACTIVE" && !w.appeal_id && now < deadline,
    appeal: w.appeal_id
      ? { id: Number(w.appeal_id), reason: w.appeal_reason, status: w.appeal_status, submittedAt: w.submitted_at, resolvedAt: w.resolved_at, resolutionNote: w.resolution_note }
      : null,
  };
}

const WARNING_SELECT = `
  SELECT w.*, ms.service_date, mt.name AS meal_type_name, m.name AS mess_name,
         a.id AS appeal_id, a.reason AS appeal_reason, a.status AS appeal_status, a.submitted_at, a.resolved_at, a.resolution_note
    FROM warnings w
    JOIN meal_slots ms ON ms.id = w.meal_slot_id
    JOIN meal_types mt ON mt.id = ms.meal_type_id
    JOIN messes m ON m.id = w.mess_id
    LEFT JOIN appeals a ON a.warning_id = w.id`;

/** A student's own warnings only. */
export async function myWarnings(principal) {
  if (!principal.student) throw forbidden();
  const inst = await getInstitution(principal.institutionId);
  const r = await query(`${WARNING_SELECT} WHERE w.student_user_id = $1 ORDER BY w.issued_at DESC`, [principal.userId]);
  const now = clock.now();
  return { policy: inst.settings.warnings, items: r.rows.map((w) => warningView(w, inst.settings.warnings.appealWindowDays, now)) };
}

export async function submitAppeal(principal, warningId, reason) {
  if (!principal.student) throw forbidden();
  return withTransaction(async (client) => {
    const w = (await query(`SELECT * FROM warnings WHERE id = $1 FOR UPDATE`, [warningId], client)).rows[0];
    // Another student's warning is indistinguishable from a missing one.
    if (!w || Number(w.student_user_id) !== principal.userId) throw notFound("Warning");
    const inst = await getInstitution(principal.institutionId, client);
    const existing = await query(`SELECT 1 FROM appeals WHERE warning_id = $1`, [w.id], client);
    if (existing.rowCount) throw conflict("You have already appealed this warning", "ALREADY_APPEALED");
    if (w.status !== "ACTIVE") throw ruleViolation(`This warning is ${w.status.toLowerCase()} and cannot be appealed`, "NOT_APPEALABLE");
    const now = clock.now();
    if (now > new Date(w.issued_at.getTime() + inst.settings.warnings.appealWindowDays * 86_400_000)) {
      throw ruleViolation(`Appeals must be submitted within ${inst.settings.warnings.appealWindowDays} days`, "APPEAL_WINDOW_CLOSED");
    }
    const a = await query(`INSERT INTO appeals (warning_id, student_user_id, reason, submitted_at) VALUES ($1, $2, $3, $4) RETURNING id`, [w.id, principal.userId, reason, now], client);
    await query(`UPDATE warnings SET status = 'APPEALED' WHERE id = $1`, [w.id], client);
    await notifySupervisors(client, w.mess_id, {
      kind: "APPEAL_SUBMITTED",
      title: "New warning appeal",
      body: reason.slice(0, 200),
      link: "/supervisor/appeals",
      dedupeKey: `appeal:${a.rows[0].id}`,
    });
    await recordAudit(client, { principal, messId: w.mess_id, action: "appeal.submitted", entityType: "appeal", entityId: a.rows[0].id, after: { warningId: Number(w.id) } });
    return { id: Number(a.rows[0].id), status: "PENDING" };
  });
}

/** Warnings for a mess (supervisor of that mess, or institution admin). */
export async function messWarnings(principal, messId, { status, limit, offset }) {
  const mess = await loadMess(principal, messId, can.viewMessAnalytics);
  const inst = await getInstitution(principal.institutionId);
  const r = await query(
    `SELECT x.*, u.full_name AS student_name, sp.roll_number FROM (${WARNING_SELECT}) x
       JOIN users u ON u.id = x.student_user_id JOIN student_profiles sp ON sp.user_id = x.student_user_id
      WHERE x.mess_id = $1 AND ($2::warning_status IS NULL OR x.status = $2)
      ORDER BY x.issued_at DESC LIMIT $3 OFFSET $4`,
    [mess.id, status ?? null, limit, offset],
  );
  const now = clock.now();
  return r.rows.map((w) => ({ ...warningView(w, inst.settings.warnings.appealWindowDays, now), student: { userId: Number(w.student_user_id), name: w.student_name, rollNumber: w.roll_number } }));
}

/** Appeals with the evidence a fair decision needs: the vote history and counter records for that meal. */
export async function messAppeals(principal, messId, { status }) {
  const mess = await loadMess(principal, messId, can.viewMessAnalytics);
  const r = await query(
    `SELECT a.*, w.tier, w.reason AS warning_reason, w.meal_slot_id, w.issued_at, ms.service_date, mt.name AS meal_type_name,
            u.full_name AS student_name, sp.roll_number, rb.full_name AS resolved_by_name
       FROM appeals a JOIN warnings w ON w.id = a.warning_id JOIN meal_slots ms ON ms.id = w.meal_slot_id JOIN meal_types mt ON mt.id = ms.meal_type_id
       JOIN users u ON u.id = a.student_user_id JOIN student_profiles sp ON sp.user_id = a.student_user_id LEFT JOIN users rb ON rb.id = a.resolved_by
      WHERE w.mess_id = $1 AND ($2::appeal_status IS NULL OR a.status = $2)
      ORDER BY (a.status <> 'PENDING'), a.submitted_at DESC LIMIT 200`,
    [mess.id, status ?? null],
  );
  const evidence = async (slotId, studentId) => {
    const [votes, attendance, history] = await Promise.all([
      query(`SELECT intent, previous_intent, recorded_at FROM vote_events WHERE meal_slot_id = $1 AND student_user_id = $2 ORDER BY recorded_at`, [slotId, studentId]),
      query(
        `SELECT ae.verified_at, ae.voided_at, ae.void_reason, u.full_name AS verified_by FROM attendance_events ae JOIN users u ON u.id = ae.verified_by
          WHERE ae.meal_slot_id = $1 AND ae.student_user_id = $2`,
        [slotId, studentId],
      ),
      query(
        `SELECT count(*) FILTER (WHERE classification = 'YES_ATTENDED')::int AS attended, count(*) FILTER (WHERE classification = 'YES_NO_SHOW')::int AS no_shows
           FROM attendance_outcomes WHERE student_user_id = $1`,
        [studentId],
      ),
    ]);
    return { voteEvents: votes.rows, counterRecords: attendance.rows, yesVoteRecord: history.rows[0] };
  };
  return Promise.all(
    r.rows.map(async (a) => ({
      id: Number(a.id),
      status: a.status,
      reason: a.reason,
      submittedAt: a.submitted_at,
      resolvedAt: a.resolved_at,
      resolvedBy: a.resolved_by_name,
      resolutionNote: a.resolution_note,
      student: { userId: Number(a.student_user_id), name: a.student_name, rollNumber: a.roll_number },
      warning: { id: Number(a.warning_id), tier: a.tier, reason: a.warning_reason, issuedAt: a.issued_at },
      meal: { slotId: Number(a.meal_slot_id), serviceDate: a.service_date, mealType: a.meal_type_name },
      evidence: a.status === "PENDING" ? await evidence(a.meal_slot_id, a.student_user_id) : null,
    })),
  );
}

export async function resolveAppeal(principal, appealId, { decision, note }) {
  return withTransaction(async (client) => {
    const a = (await query(`SELECT a.*, w.mess_id, w.id AS w_id FROM appeals a JOIN warnings w ON w.id = a.warning_id WHERE a.id = $1 FOR UPDATE OF a, w`, [appealId], client)).rows[0];
    if (!a) throw notFound("Appeal");
    await loadMess(principal, a.mess_id, can.operateMess, client);
    if (a.status !== "PENDING") throw conflict(`This appeal was already ${a.status.toLowerCase()}`, "ALREADY_RESOLVED");
    const now = clock.now();
    await query(`UPDATE appeals SET status = $2, resolved_by = $3, resolved_at = $4, resolution_note = $5 WHERE id = $1`, [a.id, decision, principal.userId, now, note], client);
    await query(`UPDATE warnings SET status = $2 WHERE id = $1`, [a.w_id, decision], client);
    await notify(client, {
      userId: a.student_user_id,
      kind: "APPEAL_RESOLVED",
      title: decision === "WAIVED" ? "Your appeal was accepted" : "Your appeal was not accepted",
      body: note,
      link: "/student/warnings",
      dedupeKey: `appeal-resolved:${a.id}`,
    });
    await recordAudit(client, { principal, messId: a.mess_id, action: "appeal.resolved", entityType: "appeal", entityId: a.id, reason: note, before: { status: "PENDING" }, after: { status: decision } });
    return { id: Number(a.id), status: decision };
  });
}
