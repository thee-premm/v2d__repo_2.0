import { query, withTransaction } from "../../config/db.js";
import { clock } from "../../lib/clock.js";
import { ruleViolation } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { assertStatus, assertTransition } from "../../domain/lifecycle.js";
import { can } from "../../domain/permissions.js";
import { recordAudit } from "../audit/audit.service.js";
import { notifySupervisors } from "../notifications/notify.js";
import { getInstitution, loadMess, loadSlot, slotSelect } from "../org/context.js";
import { eligibleStudentsCte } from "../meals/eligibility.js";
import { forecastView, getSlotDetail, menuFor } from "../meals/meals.service.js";
import { conservativeFallback, forecastAttendance } from "./model.js";

/**
 * Close voting: freeze every eligible student's intention into an immutable
 * snapshot and record the aggregate. Idempotent — a slot that is already
 * locked returns its existing aggregate. Must run inside a transaction.
 */
export async function lockSlot(client, slotId, { actorUserId = null } = {}) {
  const slot = (await query(`${slotSelect} WHERE ms.id = $1 FOR UPDATE OF ms`, [slotId], client)).rows[0];
  const existing = (await query(`SELECT * FROM cutoff_aggregates WHERE meal_slot_id = $1`, [slotId], client)).rows[0];
  if (existing) return { slot, aggregate: existing, alreadyLocked: true };
  assertTransition(slot.status, "LOCKED");
  const now = clock.now();
  if (now < slot.voting_closes_at) throw ruleViolation("Voting is still open; the cutoff has not been reached", "VOTING_STILL_OPEN");

  await query(
    `INSERT INTO vote_snapshots (meal_slot_id, student_user_id, intent)
     SELECT $3, e.student_user_id, COALESCE(v.intent::text, 'UNVOTED')::cutoff_intent
       FROM (${eligibleStudentsCte("$1", "$2::date")}) e
       LEFT JOIN votes v ON v.meal_slot_id = $3 AND v.student_user_id = e.student_user_id`,
    [slot.mess_id, slot.service_date, slot.id],
    client,
  );
  const aggregate = (
    await query(
      `INSERT INTO cutoff_aggregates (meal_slot_id, eligible_count, yes_count, no_count, unvoted_count, locked_at, locked_by)
       SELECT $1, count(*), count(*) FILTER (WHERE intent = 'YES'), count(*) FILTER (WHERE intent = 'NO'), count(*) FILTER (WHERE intent = 'UNVOTED'), $2, $3
         FROM vote_snapshots WHERE meal_slot_id = $1
       RETURNING *`,
      [slot.id, now, actorUserId],
      client,
    )
  ).rows[0];
  await query(`UPDATE meal_slots SET status = 'LOCKED', locked_at = $2 WHERE id = $1`, [slot.id, now], client);
  await recordAudit(client, {
    principal: actorUserId ? { userId: actorUserId } : null,
    institutionId: slot.institution_id,
    messId: slot.mess_id,
    action: "slot.locked",
    entityType: "meal_slot",
    entityId: slot.id,
    after: { eligible: aggregate.eligible_count, yes: aggregate.yes_count, no: aggregate.no_count, unvoted: aggregate.unvoted_count, automatic: !actorUserId },
  });
  return { slot: { ...slot, status: "LOCKED" }, aggregate, alreadyLocked: false };
}

/** Sum vote-group outcomes over this mess's reconciled history for the same meal type. */
export async function loadHistory(client, slot, settings) {
  const r = await query(
    `WITH hist AS (
       SELECT ms.id FROM meal_slots ms
        WHERE ms.mess_id = $1 AND ms.meal_type_id = $2 AND ms.status = 'RECONCILED'
          AND ms.service_date < $3::date AND ms.service_date >= $3::date - $4::int
          AND ms.is_holiday = false AND ms.is_special_event = false
        ORDER BY ms.service_date DESC LIMIT $5)
     SELECT (SELECT count(*) FROM hist)::int AS slot_count,
            (SELECT min(service_date)::text FROM meal_slots WHERE id IN (SELECT id FROM hist)) AS from_date,
            (SELECT max(service_date)::text FROM meal_slots WHERE id IN (SELECT id FROM hist)) AS to_date,
            count(*) FILTER (WHERE o.intent = 'YES')::int AS yes_total,
            count(*) FILTER (WHERE o.intent = 'YES' AND o.attended)::int AS yes_attended,
            count(*) FILTER (WHERE o.intent = 'NO')::int AS no_total,
            count(*) FILTER (WHERE o.intent = 'NO' AND o.attended)::int AS no_attended,
            count(*) FILTER (WHERE o.intent = 'UNVOTED')::int AS unvoted_total,
            count(*) FILTER (WHERE o.intent = 'UNVOTED' AND o.attended)::int AS unvoted_attended
       FROM attendance_outcomes o WHERE o.meal_slot_id IN (SELECT id FROM hist)`,
    [slot.mess_id, slot.meal_type_id, slot.service_date, settings.forecast.historyWindowDays, settings.forecast.maxHistorySlots],
    client,
  );
  const h = r.rows[0];
  return {
    slotCount: h.slot_count,
    from: h.from_date,
    to: h.to_date,
    yes: { total: h.yes_total, attended: h.yes_attended },
    no: { total: h.no_total, attended: h.no_attended },
    unvoted: { total: h.unvoted_total, attended: h.unvoted_attended },
  };
}

/**
 * Produce and persist a new forecast version for a locked slot. A model
 * failure is caught and replaced by the labelled conservative fallback, so
 * a forecasting outage never blocks a meal.
 */
export async function generateForecast(client, slotId, { actorUserId = null } = {}) {
  const slot = (await query(`${slotSelect} WHERE ms.id = $1 FOR UPDATE OF ms`, [slotId], client)).rows[0];
  assertStatus(slot, ["LOCKED", "FORECAST_READY"], "generate a forecast");
  const agg = (await query(`SELECT * FROM cutoff_aggregates WHERE meal_slot_id = $1`, [slotId], client)).rows[0];
  const counts = { eligible: agg.eligible_count, yes: agg.yes_count, no: agg.no_count, unvoted: agg.unvoted_count };
  const inst = await getInstitution(slot.institution_id, client);
  const menu = (await menuFor([slot.id], client)).get(Number(slot.id)) ?? [];

  let result;
  let history = null;
  try {
    history = await loadHistory(client, slot, inst.settings);
    result = forecastAttendance(counts, history, inst.settings.forecast, {
      specialEvent: slot.is_special_event,
      holiday: slot.is_holiday,
      examPeriod: slot.is_exam_period,
      menuMissing: menu.length === 0,
    });
  } catch (err) {
    logger.error("Forecast model failed; using conservative fallback", { err, slotId });
    result = conservativeFallback(counts, err.message?.slice(0, 120) ?? "unknown error");
  }

  const version = (await query(`SELECT coalesce(max(version), 0) + 1 AS v FROM forecasts WHERE meal_slot_id = $1`, [slot.id], client)).rows[0].v;
  const now = clock.now();
  const inputs = {
    counts,
    history,
    priors: inst.settings.forecast.priors,
    posterior: result.posterior,
    standardDeviation: result.standardDeviation,
    z: result.z,
    flags: { specialEvent: slot.is_special_event, holiday: slot.is_holiday, examPeriod: slot.is_exam_period },
    explanation:
      result.method === "CONSERVATIVE_FALLBACK"
        ? "Model unavailable: target = YES voters + non-responders."
        : `Expected attendance = ${counts.yes} YES × ${result.rates.yes} + ${counts.no} NO × ${result.rates.no} + ${counts.unvoted} unvoted × ${result.rates.unvoted}.`,
  };
  const f = (
    await query(
      `INSERT INTO forecasts (meal_slot_id, version, method, model_version, eligible_count, yes_count, no_count, unvoted_count,
                              rate_yes, rate_no, rate_unvoted, predicted_attendance, interval_low, interval_high, interval_level,
                              service_level, recommended_servings, safety_buffer_servings, history_slot_count, inputs, warnings, generated_at, generated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) RETURNING *`,
      [
        slot.id,
        version,
        result.method,
        result.modelVersion,
        counts.eligible,
        counts.yes,
        counts.no,
        counts.unvoted,
        result.rates.yes,
        result.rates.no,
        result.rates.unvoted,
        result.predictedAttendance,
        result.interval?.low ?? null,
        result.interval?.high ?? null,
        result.interval?.level ?? null,
        result.serviceLevel,
        result.recommendedServings,
        result.safetyBufferServings,
        history?.slotCount ?? 0,
        JSON.stringify(inputs),
        JSON.stringify(result.warnings),
        now,
        actorUserId,
      ],
      client,
    )
  ).rows[0];
  if (slot.status === "LOCKED") await query(`UPDATE meal_slots SET status = 'FORECAST_READY' WHERE id = $1`, [slot.id], client);
  await recordAudit(client, {
    principal: actorUserId ? { userId: actorUserId } : null,
    institutionId: slot.institution_id,
    messId: slot.mess_id,
    action: "forecast.generated",
    entityType: "meal_slot",
    entityId: slot.id,
    after: { version, method: result.method, predicted: result.predictedAttendance, recommended: result.recommendedServings },
  });
  return f;
}

/** Cutoff processing as one unit of work: lock, then forecast (separately committed so a forecast failure never undoes the lock). */
export async function processCutoff(slotId, { actorUserId = null } = {}) {
  const locked = await withTransaction((client) => lockSlot(client, slotId, { actorUserId }));
  if (!locked.alreadyLocked) {
    await withTransaction(async (client) => {
      const f = await generateForecast(client, slotId, { actorUserId });
      await notifySupervisors(client, locked.slot.mess_id, {
        kind: "FORECAST_READY",
        title: `Forecast ready: ${locked.slot.meal_type_name}, ${locked.slot.service_date}`,
        body: `Recommended ${f.recommended_servings} servings (expected ${f.predicted_attendance}). Review and approve the preparation target.`,
        link: `/supervisor/meals/${slotId}`,
        dedupeKey: `forecast-ready:${slotId}`,
      });
    });
  }
  return locked;
}

export async function lockFromRequest(principal, slotId) {
  await loadSlot(principal, slotId, can.operateMess);
  await processCutoff(slotId, { actorUserId: principal.userId });
  return getSlotDetail(principal, slotId);
}

export async function regenerateForecast(principal, slotId) {
  await withTransaction(async (client) => {
    await loadSlot(principal, slotId, can.operateMess, client, { forUpdate: true });
    await generateForecast(client, slotId, { actorUserId: principal.userId });
  });
  return getSlotDetail(principal, slotId);
}

export async function listForecasts(principal, slotId) {
  const slot = await loadSlot(principal, slotId, can.viewMessAnalytics);
  const r = await query(`SELECT * FROM forecasts WHERE meal_slot_id = $1 ORDER BY version DESC`, [slot.id]);
  return r.rows.map(forecastView);
}

/** Predicted vs. actual for reconciled meals: the forecast that the approved plan used (else the latest). */
export async function forecastAccuracy(principal, messId, { mealTypeId, limit }) {
  const mess = await loadMess(principal, messId, can.viewMessAnalytics);
  const r = await query(
    `SELECT ms.id, ms.service_date, mt.code AS meal_type, f.predicted_attendance, f.interval_low, f.interval_high, f.recommended_servings, f.method,
            pp.approved_servings, rc.actual_attendance
       FROM meal_slots ms
       JOIN meal_types mt ON mt.id = ms.meal_type_id
       JOIN reconciliations rc ON rc.meal_slot_id = ms.id
       LEFT JOIN preparation_plans pp ON pp.meal_slot_id = ms.id
       LEFT JOIN LATERAL (
         SELECT * FROM forecasts f WHERE f.meal_slot_id = ms.id AND (pp.forecast_id IS NULL OR f.id = pp.forecast_id) ORDER BY f.version DESC LIMIT 1
       ) f ON true
      WHERE ms.mess_id = $1 AND ($2::bigint IS NULL OR ms.meal_type_id = $2)
      ORDER BY ms.service_date DESC, mt.sort_order LIMIT $3`,
    [mess.id, mealTypeId ?? null, limit],
  );
  const rows = r.rows
    .filter((x) => x.predicted_attendance !== null)
    .map((x) => ({
      slotId: Number(x.id),
      serviceDate: x.service_date,
      mealType: x.meal_type,
      method: x.method,
      predicted: x.predicted_attendance,
      interval: x.interval_low === null ? null : { low: x.interval_low, high: x.interval_high },
      recommended: x.recommended_servings,
      approved: x.approved_servings,
      actual: x.actual_attendance,
      error: Math.round((x.predicted_attendance - x.actual_attendance) * 100) / 100,
      withinInterval: x.interval_low === null ? null : x.actual_attendance >= x.interval_low && x.actual_attendance <= x.interval_high,
      covered: x.approved_servings === null ? null : x.approved_servings >= x.actual_attendance,
    }));
  const n = rows.length;
  const mae = n ? rows.reduce((s, x) => s + Math.abs(x.error), 0) / n : null;
  const bias = n ? rows.reduce((s, x) => s + x.error, 0) / n : null;
  const withActual = rows.filter((x) => x.actual > 0);
  const mape = withActual.length ? (100 * withActual.reduce((s, x) => s + Math.abs(x.error) / x.actual, 0)) / withActual.length : null;
  const intervalRows = rows.filter((x) => x.withinInterval !== null);
  const coverageRows = rows.filter((x) => x.covered !== null);
  return {
    summary: {
      meals: n,
      meanAbsoluteError: mae === null ? null : Math.round(mae * 100) / 100,
      meanBias: bias === null ? null : Math.round(bias * 100) / 100,
      meanAbsolutePercentError: mape === null ? null : Math.round(mape * 10) / 10,
      intervalHitRate: intervalRows.length ? Math.round((1000 * intervalRows.filter((x) => x.withinInterval).length) / intervalRows.length) / 10 : null,
      targetCoverageRate: coverageRows.length ? Math.round((1000 * coverageRows.filter((x) => x.covered).length) / coverageRows.length) / 10 : null,
    },
    rows,
  };
}
