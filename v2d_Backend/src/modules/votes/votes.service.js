import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { query, withTransaction } from "../../config/db.js";
import { clock } from "../../lib/clock.js";
import { forbidden, notFound, ruleViolation } from "../../lib/errors.js";
import { requestContext } from "../../lib/requestContext.js";
import { STUDENT_VISIBLE } from "../../domain/lifecycle.js";
import { getInstitution } from "../org/context.js";
import { isEligible } from "../meals/eligibility.js";
import { menuFor } from "../meals/meals.service.js";

function requireStudent(principal) {
  if (!principal.student) throw forbidden("Only students can do this");
  return principal.student;
}

/** Voting state as the student sees it, computed from the server clock. */
export function votingState(slot, now) {
  if (slot.status === "CANCELLED") return "CANCELLED";
  if (slot.status !== "OPEN") return "CLOSED";
  if (now < slot.voting_opens_at) return "NOT_YET_OPEN";
  if (now >= slot.voting_closes_at) return "CLOSED";
  return "OPEN";
}

/**
 * Record or change a student's intention. Rules enforced here, server-side:
 *  - the student must be eligible for the slot's mess on its service date
 *  - the slot must be published (OPEN) and the server clock inside the voting window
 *  - repeating the same intention is a no-op (safe to retry)
 * The slot row is share-locked, so cutoff processing (which takes an exclusive
 * lock) waits for in-flight votes and then snapshots them.
 */
export async function castVote(principal, slotId, intent) {
  const student = requireStudent(principal);
  return withTransaction(async (client) => {
    const slot = (
      await query(
        `SELECT id, institution_id, mess_id, service_date, status, voting_opens_at, voting_closes_at FROM meal_slots WHERE id = $1 FOR SHARE`,
        [slotId],
        client,
      )
    ).rows[0];
    if (!slot || Number(slot.institution_id) !== principal.institutionId || slot.status === "DRAFT") throw notFound("Meal");
    if (!(await isEligible(client, { studentUserId: student.userId, messId: slot.mess_id, serviceDate: slot.service_date }))) throw notFound("Meal");

    const now = clock.now();
    const state = votingState(slot, now);
    if (state === "NOT_YET_OPEN") throw ruleViolation("Voting for this meal has not opened yet", "VOTING_NOT_OPEN", { opensAt: slot.voting_opens_at });
    if (state === "CANCELLED") throw ruleViolation("This meal has been cancelled", "MEAL_CANCELLED");
    if (state === "CLOSED") throw ruleViolation("Voting for this meal has closed", "VOTING_CLOSED", { closedAt: slot.voting_closes_at });

    const existing = (await query(`SELECT intent FROM votes WHERE meal_slot_id = $1 AND student_user_id = $2 FOR UPDATE`, [slot.id, student.userId], client)).rows[0];
    let vote;
    let changed = true;
    if (existing && existing.intent === intent) {
      changed = false;
      vote = (await query(`SELECT * FROM votes WHERE meal_slot_id = $1 AND student_user_id = $2`, [slot.id, student.userId], client)).rows[0];
    } else {
      vote = (
        await query(
          `INSERT INTO votes (meal_slot_id, student_user_id, intent, first_cast_at, updated_at, change_count) VALUES ($1, $2, $3, $4, $4, 0)
           ON CONFLICT (meal_slot_id, student_user_id) DO UPDATE SET intent = EXCLUDED.intent, updated_at = EXCLUDED.updated_at, change_count = votes.change_count + 1
           RETURNING *`,
          [slot.id, student.userId, intent, now],
          client,
        )
      ).rows[0];
      await query(
        `INSERT INTO vote_events (meal_slot_id, student_user_id, intent, previous_intent, recorded_at, request_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [slot.id, student.userId, intent, existing?.intent ?? null, now, requestContext.get()?.requestId ?? null],
        client,
      );
    }
    return {
      slotId: Number(slot.id),
      intent: vote.intent,
      changed,
      updatedAt: vote.updated_at,
      changeCount: vote.change_count,
      votingClosesAt: slot.voting_closes_at,
      serverTime: now,
    };
  });
}

/** Upcoming and recent meals for the student's current mess, with their own vote. */
export async function myMeals(principal, { days }) {
  const student = requireStudent(principal);
  if (!student.messId) return { timezone: null, serverTime: clock.now(), meals: [], membership: null };
  const inst = await getInstitution(principal.institutionId);
  const r = await query(
    `SELECT ms.id, ms.institution_id, ms.mess_id, ms.service_date, ms.status, ms.voting_opens_at, ms.voting_closes_at, ms.service_starts_at, ms.service_ends_at,
            ms.notes, ms.is_special_event, ms.cancel_reason, mt.code AS meal_type_code, mt.name AS meal_type_name, m.name AS mess_name,
            v.intent AS my_vote, v.updated_at AS my_vote_updated_at, vs.intent AS intent_at_cutoff,
            ae.verified_at AS attended_at
       FROM meal_slots ms
       JOIN meal_types mt ON mt.id = ms.meal_type_id
       JOIN messes m ON m.id = ms.mess_id
       LEFT JOIN votes v ON v.meal_slot_id = ms.id AND v.student_user_id = $1
       LEFT JOIN vote_snapshots vs ON vs.meal_slot_id = ms.id AND vs.student_user_id = $1
       LEFT JOIN attendance_events ae ON ae.meal_slot_id = ms.id AND ae.student_user_id = $1 AND ae.voided_at IS NULL
      WHERE ms.mess_id = $2 AND ms.status = ANY($3::meal_slot_status[])
        AND ms.service_date BETWEEN ($6::timestamptz AT TIME ZONE $4)::date - 1 AND ($6::timestamptz AT TIME ZONE $4)::date + $5::int
      ORDER BY ms.service_starts_at`,
    [student.userId, student.messId, STUDENT_VISIBLE, inst.timezone, days, clock.now()],
  );
  const menus = await menuFor(r.rows.map((x) => Number(x.id)));
  const now = clock.now();
  return {
    timezone: inst.timezone,
    serverTime: now,
    meals: r.rows.map((x) => ({
      id: Number(x.id),
      messName: x.mess_name,
      mealType: { code: x.meal_type_code, name: x.meal_type_name },
      serviceDate: x.service_date,
      votingOpensAt: x.voting_opens_at,
      votingClosesAt: x.voting_closes_at,
      serviceStartsAt: x.service_starts_at,
      serviceEndsAt: x.service_ends_at,
      status: x.status,
      notes: x.notes,
      specialEvent: x.is_special_event,
      cancelReason: x.cancel_reason,
      votingState: votingState(x, now),
      myVote: x.my_vote,
      myVoteUpdatedAt: x.my_vote_updated_at,
      intentAtCutoff: x.intent_at_cutoff,
      attendedAt: x.attended_at,
      menu: (menus.get(Number(x.id)) ?? []).map((d) => ({ name: d.name, category: d.category, isVegetarian: d.isVegetarian })),
    })),
  };
}

/** The student's own past meals: declared intention vs. verified attendance, kept separate. */
export async function myHistory(principal, { limit, offset }) {
  const student = requireStudent(principal);
  const params = [student.userId, limit, offset];
  const base = `
    FROM meal_slots ms
    JOIN meal_types mt ON mt.id = ms.meal_type_id
    JOIN messes m ON m.id = ms.mess_id
    LEFT JOIN vote_snapshots vs ON vs.meal_slot_id = ms.id AND vs.student_user_id = $1
    LEFT JOIN attendance_events ae ON ae.meal_slot_id = ms.id AND ae.student_user_id = $1 AND ae.voided_at IS NULL
    LEFT JOIN attendance_outcomes ao ON ao.meal_slot_id = ms.id AND ao.student_user_id = $1
    LEFT JOIN warnings w ON w.meal_slot_id = ms.id AND w.student_user_id = $1
   WHERE ms.status IN ('LOCKED', 'FORECAST_READY', 'APPROVED', 'IN_SERVICE', 'SERVICE_CLOSED', 'RECONCILED')
     AND (vs.student_user_id IS NOT NULL OR ae.id IS NOT NULL)`;
  const total = (await query(`SELECT count(*)::int AS n ${base}`, [student.userId])).rows[0].n;
  const r = await query(
    `SELECT ms.id, ms.service_date, ms.status, mt.name AS meal_type_name, mt.code AS meal_type_code, m.name AS mess_name,
            vs.intent AS intent_at_cutoff, ae.verified_at AS attended_at, ae.walk_in, ao.classification, ao.excuse_reason, ao.correction_reason,
            w.id AS warning_id, w.tier AS warning_tier, w.status AS warning_status
       ${base}
      ORDER BY ms.service_starts_at DESC LIMIT $2 OFFSET $3`,
    params,
  );
  return {
    total,
    items: r.rows.map((x) => ({
      slotId: Number(x.id),
      serviceDate: x.service_date,
      mealType: { code: x.meal_type_code, name: x.meal_type_name },
      messName: x.mess_name,
      status: x.status,
      intentAtCutoff: x.intent_at_cutoff ?? "NOT_ELIGIBLE_AT_CUTOFF",
      attended: Boolean(x.attended_at),
      attendedAt: x.attended_at,
      walkIn: x.walk_in && x.walk_in !== "NOT_WALK_IN" ? x.walk_in : null,
      classification: x.classification,
      note: x.excuse_reason ?? x.correction_reason ?? null,
      warning: x.warning_id ? { id: Number(x.warning_id), tier: x.warning_tier, status: x.warning_status } : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Meal pass (QR). A signed, slot-specific token the counter can scan instead
// of typing a roll number. It identifies; it does not authorize — the counter
// still applies every eligibility and walk-in rule.
// ---------------------------------------------------------------------------
const PASS_PREFIX = "V2D1";
const sign = (payload) => crypto.createHmac("sha256", env.appSecret).update(payload).digest("base64url").slice(0, 22);

export function createPassToken(slotId, userId, expiresAt) {
  const payload = `${PASS_PREFIX}.${slotId}.${userId}.${Math.floor(expiresAt.getTime() / 1000)}`;
  return `${payload}.${sign(payload)}`;
}

export function readPassToken(token, now = clock.now()) {
  const parts = String(token ?? "").trim().split(".");
  if (parts.length !== 5 || parts[0] !== PASS_PREFIX) return null;
  const payload = parts.slice(0, 4).join(".");
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(parts[4]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  if (Number(parts[3]) * 1000 < now.getTime()) return null;
  return { slotId: Number(parts[1]), userId: Number(parts[2]) };
}

export async function myPass(principal, slotId) {
  const student = requireStudent(principal);
  const slot = (await query(`SELECT id, institution_id, mess_id, service_date, status, service_ends_at FROM meal_slots WHERE id = $1`, [slotId])).rows[0];
  if (!slot || Number(slot.institution_id) !== principal.institutionId) throw notFound("Meal");
  if (!(await isEligible(undefined, { studentUserId: student.userId, messId: slot.mess_id, serviceDate: slot.service_date }))) throw notFound("Meal");
  if (!["APPROVED", "IN_SERVICE", "FORECAST_READY", "LOCKED"].includes(slot.status)) {
    throw ruleViolation("A meal pass is available once voting has closed", "PASS_NOT_AVAILABLE");
  }
  return { token: createPassToken(slot.id, student.userId, slot.service_ends_at), expiresAt: slot.service_ends_at, rollNumber: student.rollNumber };
}
