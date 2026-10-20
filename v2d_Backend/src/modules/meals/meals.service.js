import { parallel, query, withTransaction } from "../../config/db.js";
import { clock } from "../../lib/clock.js";
import { badRequest, notFound, ruleViolation } from "../../lib/errors.js";
import { assertStatus, assertTransition, MENU_EDITABLE } from "../../domain/lifecycle.js";
import { can } from "../../domain/permissions.js";
import { recordAudit } from "../audit/audit.service.js";
import { notify, notifySupervisors } from "../notifications/notify.js";
import { getInstitution, loadMess, loadSlot, slotSelect } from "../org/context.js";
import { camel } from "../org/org.service.js";
import { eligibleStudentsCte, liveVoteCounts } from "./eligibility.js";

const MAX_BULK_DAYS = 31;

/** Convert local wall-clock date/time in the institution's timezone into instants, in PostgreSQL (authoritative tz database). */
async function resolveTimes(client, tz, { serviceDate, serviceStart, serviceEnd, votingOpensAt, votingClosesAt, mealType }) {
  const r = await query(
    `SELECT ($1::date + $2::time) AT TIME ZONE $6 AS service_starts_at,
            ($1::date + $3::time) AT TIME ZONE $6 AS service_ends_at,
            CASE WHEN $4::timestamp IS NULL THEN ($1::date + $2::time - make_interval(hours => $8)) AT TIME ZONE $6
                 ELSE $4::timestamp AT TIME ZONE $6 END AS voting_opens_at,
            CASE WHEN $5::timestamp IS NULL THEN ($1::date + $2::time - make_interval(mins => $7)) AT TIME ZONE $6
                 ELSE $5::timestamp AT TIME ZONE $6 END AS voting_closes_at`,
    [serviceDate, serviceStart, serviceEnd, votingOpensAt ?? null, votingClosesAt ?? null, tz, mealType.default_cutoff_minutes, mealType.default_open_hours],
    client,
  );
  return r.rows[0];
}

function assertWindow(t) {
  const problems = [];
  if (!(t.service_starts_at < t.service_ends_at)) problems.push({ field: "serviceEnd", message: "Service must end after it starts" });
  if (!(t.voting_closes_at <= t.service_starts_at)) problems.push({ field: "votingClosesAt", message: "Voting must close before service starts" });
  if (!(t.voting_opens_at < t.voting_closes_at)) problems.push({ field: "votingOpensAt", message: "Voting must open before it closes" });
  if (problems.length) throw badRequest("The meal times are inconsistent", problems);
}

async function loadMealType(client, principal, mealTypeId) {
  const r = await query(
    `SELECT id, code, name, to_char(default_service_start, 'HH24:MI') AS default_service_start, to_char(default_service_end, 'HH24:MI') AS default_service_end,
            default_cutoff_minutes, default_open_hours, is_active
       FROM meal_types WHERE id = $1 AND institution_id = $2`,
    [mealTypeId, principal.institutionId],
    client,
  );
  if (!r.rows[0]) throw notFound("Meal type");
  return r.rows[0];
}

async function setMenu(client, principal, slotId, menu) {
  const dishIds = menu.map((m) => m.dishId);
  if (new Set(dishIds).size !== dishIds.length) throw badRequest("A dish appears more than once in the menu");
  if (dishIds.length) {
    const found = await query(`SELECT count(*)::int AS n FROM dishes WHERE id = ANY($1::bigint[]) AND institution_id = $2 AND is_active`, [dishIds, principal.institutionId], client);
    if (found.rows[0].n !== dishIds.length) throw badRequest("The menu contains an unknown or inactive dish");
  }
  await query(`DELETE FROM meal_slot_menu_items WHERE meal_slot_id = $1`, [slotId], client);
  for (const [i, m] of menu.entries()) {
    await query(`INSERT INTO meal_slot_menu_items (meal_slot_id, dish_id, uptake_fraction, sort_order) VALUES ($1, $2, $3, $4)`, [slotId, m.dishId, m.uptakeFraction ?? 1, i], client);
  }
}

export async function menuFor(slotIds, client) {
  if (!slotIds.length) return new Map();
  const r = await query(
    `SELECT mi.meal_slot_id, d.id AS dish_id, d.name, d.category, d.is_vegetarian, d.portion_grams, mi.uptake_fraction, mi.sort_order,
            EXISTS (SELECT 1 FROM dish_ingredients di WHERE di.dish_id = d.id) AS has_recipe
       FROM meal_slot_menu_items mi JOIN dishes d ON d.id = mi.dish_id
      WHERE mi.meal_slot_id = ANY($1::bigint[]) ORDER BY mi.sort_order`,
    [slotIds],
    client,
  );
  const map = new Map();
  for (const row of r.rows) {
    const list = map.get(Number(row.meal_slot_id)) ?? [];
    list.push({
      dishId: Number(row.dish_id),
      name: row.name,
      category: row.category,
      isVegetarian: row.is_vegetarian,
      portionGrams: row.portion_grams,
      uptakeFraction: row.uptake_fraction,
      hasRecipe: row.has_recipe,
    });
    map.set(Number(row.meal_slot_id), list);
  }
  return map;
}

export function slotView(row) {
  return {
    id: Number(row.id),
    messId: Number(row.mess_id),
    messName: row.mess_name,
    mealType: { id: Number(row.meal_type_id), code: row.meal_type_code, name: row.meal_type_name },
    serviceDate: row.service_date,
    votingOpensAt: row.voting_opens_at,
    votingClosesAt: row.voting_closes_at,
    serviceStartsAt: row.service_starts_at,
    serviceEndsAt: row.service_ends_at,
    status: row.status,
    notes: row.notes,
    flags: { specialEvent: row.is_special_event, examPeriod: row.is_exam_period, holiday: row.is_holiday },
    publishedAt: row.published_at,
    lockedAt: row.locked_at,
    serviceStartedAt: row.service_started_at,
    serviceClosedAt: row.service_closed_at,
    reconciledAt: row.reconciled_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
  };
}

export async function createSlot(principal, messId, input) {
  return withTransaction(async (client) => {
    const mess = await loadMess(principal, messId, can.operateMess, client);
    const inst = await getInstitution(principal.institutionId, client);
    const mealType = await loadMealType(client, principal, input.mealTypeId);
    if (!mealType.is_active) throw ruleViolation("This meal type is inactive", "MEAL_TYPE_INACTIVE");
    const times = await resolveTimes(client, inst.timezone, {
      ...input,
      serviceStart: input.serviceStart ?? mealType.default_service_start,
      serviceEnd: input.serviceEnd ?? mealType.default_service_end,
      mealType,
    });
    assertWindow(times);
    if (times.voting_closes_at <= clock.now()) throw ruleViolation("Voting for this meal would already be closed. Choose a later cutoff.", "CUTOFF_IN_PAST");
    const exists = await query(
      `SELECT id FROM meal_slots WHERE mess_id = $1 AND service_date = $2 AND meal_type_id = $3 AND status <> 'CANCELLED'`,
      [mess.id, input.serviceDate, mealType.id],
      client,
    );
    if (exists.rowCount) throw ruleViolation(`${mealType.name} on ${input.serviceDate} already exists for this mess`, "SLOT_EXISTS", { slotId: exists.rows[0].id });
    const r = await query(
      `INSERT INTO meal_slots (institution_id, mess_id, meal_type_id, service_date, voting_opens_at, voting_closes_at, service_starts_at, service_ends_at,
                               notes, is_special_event, is_exam_period, is_holiday, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        principal.institutionId,
        mess.id,
        mealType.id,
        input.serviceDate,
        times.voting_opens_at,
        times.voting_closes_at,
        times.service_starts_at,
        times.service_ends_at,
        input.notes ?? null,
        Boolean(input.isSpecialEvent),
        Boolean(input.isExamPeriod),
        Boolean(input.isHoliday),
        principal.userId,
      ],
      client,
    );
    const slotId = r.rows[0].id;
    if (input.menu?.length) await setMenu(client, principal, slotId, input.menu);
    await recordAudit(client, { principal, messId: mess.id, action: "slot.created", entityType: "meal_slot", entityId: slotId, after: { ...input, ...times } });
    return getSlotDetail(principal, slotId, client);
  });
}

/** Create DRAFT slots for a date range from meal-type defaults; optionally copy each menu from N days earlier. */
export async function createSchedule(principal, messId, { fromDate, toDate, mealTypeIds, copyMenuFromDaysBefore }) {
  return withTransaction(async (client) => {
    const mess = await loadMess(principal, messId, can.operateMess, client);
    const inst = await getInstitution(principal.institutionId, client);
    const days = (await query(`SELECT d::date::text AS d FROM generate_series($1::date, $2::date, '1 day') d`, [fromDate, toDate], client)).rows.map((r) => r.d);
    if (days.length > MAX_BULK_DAYS) throw badRequest(`Schedule at most ${MAX_BULK_DAYS} days at a time`);
    const created = [];
    const skipped = [];
    for (const mealTypeId of mealTypeIds) {
      const mealType = await loadMealType(client, principal, mealTypeId);
      for (const serviceDate of days) {
        const times = await resolveTimes(client, inst.timezone, {
          serviceDate,
          serviceStart: mealType.default_service_start,
          serviceEnd: mealType.default_service_end,
          mealType,
        });
        if (times.voting_closes_at <= clock.now()) {
          skipped.push({ serviceDate, mealType: mealType.code, reason: "CUTOFF_IN_PAST" });
          continue;
        }
        const ins = await query(
          `INSERT INTO meal_slots (institution_id, mess_id, meal_type_id, service_date, voting_opens_at, voting_closes_at, service_starts_at, service_ends_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (mess_id, service_date, meal_type_id) WHERE status <> 'CANCELLED' DO NOTHING RETURNING id`,
          [principal.institutionId, mess.id, mealType.id, serviceDate, times.voting_opens_at, times.voting_closes_at, times.service_starts_at, times.service_ends_at, principal.userId],
          client,
        );
        if (!ins.rowCount) {
          skipped.push({ serviceDate, mealType: mealType.code, reason: "ALREADY_SCHEDULED" });
          continue;
        }
        const slotId = ins.rows[0].id;
        if (copyMenuFromDaysBefore) {
          await query(
            `INSERT INTO meal_slot_menu_items (meal_slot_id, dish_id, uptake_fraction, sort_order)
             SELECT $1, mi.dish_id, mi.uptake_fraction, mi.sort_order
               FROM meal_slots src JOIN meal_slot_menu_items mi ON mi.meal_slot_id = src.id
              WHERE src.mess_id = $2 AND src.meal_type_id = $3 AND src.service_date = ($4::date - $5::int) AND src.status <> 'CANCELLED'`,
            [slotId, mess.id, mealType.id, serviceDate, copyMenuFromDaysBefore],
            client,
          );
        }
        created.push({ id: Number(slotId), serviceDate, mealType: mealType.code });
      }
    }
    await recordAudit(client, { principal, messId: mess.id, action: "slot.schedule_created", entityType: "mess", entityId: mess.id, after: { fromDate, toDate, mealTypeIds, created: created.length } });
    return { created, skipped };
  });
}

export async function listSlots(principal, messId, { from, to, status }) {
  const mess = await loadMess(principal, messId, can.viewOperations);
  const r = await query(
    `${slotSelect}
      WHERE ms.mess_id = $1 AND ms.service_date BETWEEN $2 AND $3 AND ($4::meal_slot_status IS NULL OR ms.status = $4)
      ORDER BY ms.service_date, mt.sort_order`,
    [mess.id, from, to, status ?? null],
  );
  const ids = r.rows.map((row) => Number(row.id));
  const [menus, counts] = await Promise.all([
    menuFor(ids),
    query(
      `SELECT ms.id,
              ca.eligible_count, ca.yes_count, ca.no_count, ca.unvoted_count,
              (SELECT count(*) FROM votes v WHERE v.meal_slot_id = ms.id AND v.intent = 'YES')::int AS live_yes,
              (SELECT count(*) FROM votes v WHERE v.meal_slot_id = ms.id AND v.intent = 'NO')::int AS live_no,
              pp.approved_servings,
              (SELECT f.recommended_servings FROM forecasts f WHERE f.meal_slot_id = ms.id ORDER BY f.version DESC LIMIT 1) AS recommended_servings,
              (SELECT count(*) FROM attendance_events ae WHERE ae.meal_slot_id = ms.id AND ae.voided_at IS NULL)::int AS attended
         FROM meal_slots ms
         LEFT JOIN cutoff_aggregates ca ON ca.meal_slot_id = ms.id
         LEFT JOIN preparation_plans pp ON pp.meal_slot_id = ms.id
        WHERE ms.id = ANY($1::bigint[])`,
      [ids],
    ),
  ]);
  const countMap = new Map(counts.rows.map((c) => [Number(c.id), c]));
  return r.rows.map((row) => {
    const c = countMap.get(Number(row.id));
    return {
      ...slotView(row),
      menu: menus.get(Number(row.id)) ?? [],
      summary: {
        snapshot: c.eligible_count === null ? null : { eligible: c.eligible_count, yes: c.yes_count, no: c.no_count, unvoted: c.unvoted_count },
        liveYes: c.live_yes,
        liveNo: c.live_no,
        recommendedServings: c.recommended_servings,
        approvedServings: c.approved_servings,
        attended: c.attended,
      },
    };
  });
}

/** Full operational picture of one slot (aggregates only — no student-level data). */
export async function getSlotDetail(principal, slotId, client) {
  const slot = await loadSlot(principal, slotId, can.viewOperations, client);
  const [menu, aggregate, forecast, plan, attendance, reconciliation, prep, food, inst] = await parallel(client, [
    () => menuFor([slot.id], client),
    () => query(`SELECT eligible_count, yes_count, no_count, unvoted_count, locked_at FROM cutoff_aggregates WHERE meal_slot_id = $1`, [slot.id], client),
    () => query(`SELECT * FROM forecasts WHERE meal_slot_id = $1 ORDER BY version DESC LIMIT 1`, [slot.id], client),
    () => query(
      `SELECT pp.*, u.full_name AS approved_by_name FROM preparation_plans pp JOIN users u ON u.id = pp.approved_by WHERE pp.meal_slot_id = $1`,
      [slot.id],
      client,
    ),
    () => query(
      `SELECT count(*) FILTER (WHERE voided_at IS NULL)::int AS verified,
              count(*) FILTER (WHERE voided_at IS NULL AND walk_in <> 'NOT_WALK_IN')::int AS walk_ins
         FROM attendance_events WHERE meal_slot_id = $1`,
      [slot.id],
      client,
    ),
    () => query(`SELECT reconciled_at, actual_attendance, summary FROM reconciliations WHERE meal_slot_id = $1`, [slot.id], client),
    () => query(`SELECT status, count(*)::int AS n FROM prep_tasks WHERE meal_slot_id = $1 GROUP BY status`, [slot.id], client),
    () => query(`SELECT category, sum(quantity_kg)::numeric AS kg FROM food_logs WHERE meal_slot_id = $1 AND voided_at IS NULL GROUP BY category`, [slot.id], client),
    () => getInstitution(principal.institutionId, client),
  ]);
  const live = slot.status === "OPEN" || slot.status === "DRAFT" ? await liveVoteCounts(client, slot) : null;
  const a = aggregate.rows[0];
  const f = forecast.rows[0];
  const p = plan.rows[0];
  const now = clock.now();
  return {
    ...slotView(slot),
    timezone: inst.timezone,
    serverTime: now,
    menu: menu.get(Number(slot.id)) ?? [],
    votes: live ? { source: "LIVE", ...live } : a ? { source: "CUTOFF_SNAPSHOT", eligible: a.eligible_count, yes: a.yes_count, no: a.no_count, unvoted: a.unvoted_count, lockedAt: a.locked_at } : null,
    forecast: f ? forecastView(f) : null,
    plan: p
      ? {
          approvedServings: p.approved_servings,
          recommendedServings: p.recommended_servings,
          isOverride: p.is_override,
          overrideReason: p.override_reason,
          approvedBy: p.approved_by_name,
          approvedAt: p.approved_at,
          forecastId: p.forecast_id,
        }
      : null,
    attendance: attendance.rows[0],
    reconciliation: reconciliation.rows[0] ? camel(reconciliation.rows[0]) : null,
    prep: Object.fromEntries(prep.rows.map((r) => [r.status, r.n])),
    foodLogs: Object.fromEntries(food.rows.map((r) => [r.category, Number(r.kg)])),
    actions: allowedActions(principal, slot, now),
  };
}

export function forecastView(f) {
  return {
    id: Number(f.id),
    version: f.version,
    method: f.method,
    modelVersion: f.model_version,
    counts: { eligible: f.eligible_count, yes: f.yes_count, no: f.no_count, unvoted: f.unvoted_count },
    rates: { yes: f.rate_yes, no: f.rate_no, unvoted: f.rate_unvoted },
    predictedAttendance: f.predicted_attendance,
    interval: f.interval_low === null ? null : { low: f.interval_low, high: f.interval_high, level: f.interval_level },
    serviceLevel: f.service_level,
    recommendedServings: f.recommended_servings,
    safetyBufferServings: f.safety_buffer_servings,
    historySlotCount: f.history_slot_count,
    inputs: f.inputs,
    warnings: f.warnings,
    generatedAt: f.generated_at,
    generatedBy: f.generated_by,
  };
}

/** Which lifecycle actions the caller may take now — the UI renders these; the API re-checks each one. */
function allowedActions(principal, slot, now) {
  const operate = can.operateMess(principal, { id: slot.mess_id, institution_id: slot.institution_id });
  if (!operate) return [];
  const s = slot.status;
  const actions = [];
  if (s === "DRAFT") actions.push("EDIT", "PUBLISH", "CANCEL");
  if (s === "OPEN") actions.push("EDIT", "CANCEL");
  if (MENU_EDITABLE.includes(s)) actions.push("EDIT_MENU");
  if (s === "OPEN" && now >= slot.voting_closes_at) actions.push("LOCK");
  if (s === "LOCKED" || s === "FORECAST_READY") actions.push("FORECAST", "APPROVE", "CANCEL");
  if (s === "APPROVED") actions.push("APPROVE", "START_SERVICE", "CANCEL");
  if (s === "IN_SERVICE") actions.push("VERIFY_ATTENDANCE", "CLOSE_SERVICE");
  if (s === "SERVICE_CLOSED") actions.push("RECONCILE");
  return actions;
}

export async function updateSlot(principal, slotId, patch) {
  return withTransaction(async (client) => {
    const slot = await loadSlot(principal, slotId, can.operateMess, client, { forUpdate: true });
    assertStatus(slot, ["DRAFT", "OPEN"], "edit the schedule");
    const inst = await getInstitution(principal.institutionId, client);
    const mealType = await loadMealType(client, principal, slot.meal_type_id);
    const local = (
      await query(
        `SELECT to_char($1::timestamptz AT TIME ZONE $5, 'HH24:MI') AS start, to_char($2::timestamptz AT TIME ZONE $5, 'HH24:MI') AS "end",
                to_char($3::timestamptz AT TIME ZONE $5, 'YYYY-MM-DD"T"HH24:MI') AS opens, to_char($4::timestamptz AT TIME ZONE $5, 'YYYY-MM-DD"T"HH24:MI') AS closes`,
        [slot.service_starts_at, slot.service_ends_at, slot.voting_opens_at, slot.voting_closes_at, inst.timezone],
        client,
      )
    ).rows[0];
    const times = await resolveTimes(client, inst.timezone, {
      serviceDate: slot.service_date,
      serviceStart: patch.serviceStart ?? local.start,
      serviceEnd: patch.serviceEnd ?? local.end,
      votingOpensAt: patch.votingOpensAt ?? local.opens,
      votingClosesAt: patch.votingClosesAt ?? local.closes,
      mealType,
    });
    assertWindow(times);
    const now = clock.now();
    if (slot.status === "OPEN") {
      if (times.voting_closes_at <= now) throw ruleViolation("The new cutoff is already in the past", "CUTOFF_IN_PAST");
      if (patch.votingOpensAt && times.voting_opens_at > now && slot.voting_opens_at <= now) {
        throw ruleViolation("Voting has already opened; its opening time can no longer move later", "VOTING_ALREADY_OPEN");
      }
    }
    await query(
      `UPDATE meal_slots SET voting_opens_at = $2, voting_closes_at = $3, service_starts_at = $4, service_ends_at = $5,
              notes = CASE WHEN $6::boolean THEN $7 ELSE notes END,
              is_special_event = COALESCE($8, is_special_event), is_exam_period = COALESCE($9, is_exam_period), is_holiday = COALESCE($10, is_holiday)
        WHERE id = $1`,
      [slot.id, times.voting_opens_at, times.voting_closes_at, times.service_starts_at, times.service_ends_at, patch.notes !== undefined, patch.notes ?? null, patch.isSpecialEvent ?? null, patch.isExamPeriod ?? null, patch.isHoliday ?? null],
      client,
    );
    const timesChanged = ["voting_closes_at", "service_starts_at", "service_ends_at"].some((k) => +times[k] !== +slot[k]);
    if (slot.status === "OPEN" && timesChanged) {
      await notifyEligible(client, slot, {
        kind: "SCHEDULE_CHANGED",
        title: `${slot.meal_type_name} on ${slot.service_date} has new times`,
        body: "The meal or voting times changed. Check the updated schedule.",
        dedupe: `schedule:${slot.id}:${+times.voting_closes_at}:${+times.service_starts_at}`,
      });
    }
    await recordAudit(client, {
      principal,
      messId: slot.mess_id,
      action: "slot.updated",
      entityType: "meal_slot",
      entityId: slot.id,
      before: { votingOpensAt: slot.voting_opens_at, votingClosesAt: slot.voting_closes_at, serviceStartsAt: slot.service_starts_at, serviceEndsAt: slot.service_ends_at, notes: slot.notes },
      after: { ...times, notes: patch.notes },
    });
    return getSlotDetail(principal, slot.id, client);
  });
}

export async function updateMenu(principal, slotId, menu) {
  return withTransaction(async (client) => {
    const slot = await loadSlot(principal, slotId, can.operateMess, client, { forUpdate: true });
    assertStatus(slot, MENU_EDITABLE, "change the menu");
    const before = (await menuFor([slot.id], client)).get(Number(slot.id)) ?? [];
    await setMenu(client, principal, slot.id, menu);
    if (slot.status === "OPEN" && slot.voting_opens_at <= clock.now()) {
      await notifyEligible(client, slot, {
        kind: "MENU_CHANGED",
        title: `Menu updated: ${slot.meal_type_name}, ${slot.service_date}`,
        body: "The menu changed after voting opened. You can still change your vote before the cutoff.",
        dedupe: `menu:${slot.id}:${clock.now().getTime()}`,
      });
    }
    await recordAudit(client, { principal, messId: slot.mess_id, action: "slot.menu_updated", entityType: "meal_slot", entityId: slot.id, before, after: menu });
    return getSlotDetail(principal, slot.id, client);
  });
}

export async function publishSlot(principal, slotId) {
  return withTransaction(async (client) => {
    const slot = await loadSlot(principal, slotId, can.operateMess, client, { forUpdate: true });
    assertTransition(slot.status, "OPEN");
    if (slot.voting_closes_at <= clock.now()) throw ruleViolation("The voting cutoff has passed. Edit the times or cancel this draft.", "CUTOFF_IN_PAST");
    const menu = (await menuFor([slot.id], client)).get(Number(slot.id)) ?? [];
    if (menu.length === 0) throw ruleViolation("Add at least one dish before publishing so students know what they are voting for", "MENU_REQUIRED");
    await query(`UPDATE meal_slots SET status = 'OPEN', published_at = $2 WHERE id = $1`, [slot.id, clock.now()], client);
    await recordAudit(client, { principal, messId: slot.mess_id, action: "slot.published", entityType: "meal_slot", entityId: slot.id, before: { status: slot.status }, after: { status: "OPEN" } });
    return getSlotDetail(principal, slot.id, client);
  });
}

export async function cancelSlot(principal, slotId, { reason }) {
  return withTransaction(async (client) => {
    const slot = await loadSlot(principal, slotId, can.operateMess, client, { forUpdate: true });
    assertTransition(slot.status, "CANCELLED");
    await query(`UPDATE meal_slots SET status = 'CANCELLED', cancelled_at = $2, cancel_reason = $3 WHERE id = $1`, [slot.id, clock.now(), reason], client);
    if (slot.status !== "DRAFT") {
      await notifyEligible(client, slot, {
        kind: "MEAL_CANCELLED",
        title: `${slot.meal_type_name} on ${slot.service_date} is cancelled`,
        body: reason,
        dedupe: `cancel:${slot.id}`,
      });
    }
    await recordAudit(client, { principal, messId: slot.mess_id, action: "slot.cancelled", entityType: "meal_slot", entityId: slot.id, reason, before: { status: slot.status }, after: { status: "CANCELLED" } });
    return getSlotDetail(principal, slot.id, client);
  });
}

export async function startService(principal, slotId) {
  return withTransaction(async (client) => {
    const slot = await loadSlot(principal, slotId, can.operateMess, client, { forUpdate: true });
    if (slot.status === "LOCKED" || slot.status === "FORECAST_READY") {
      throw ruleViolation("Approve a preparation target before starting service", "APPROVAL_REQUIRED");
    }
    assertTransition(slot.status, "IN_SERVICE");
    const inst = await getInstitution(principal.institutionId, client);
    const earliest = new Date(slot.service_starts_at.getTime() - inst.settings.service.earlyStartMinutes * 60_000);
    if (clock.now() < earliest) throw ruleViolation(`Service can open at most ${inst.settings.service.earlyStartMinutes} minutes before the scheduled start`, "TOO_EARLY");
    await transitionToService(client, slot, principal);
    return getSlotDetail(principal, slot.id, client);
  });
}

export async function transitionToService(client, slot, principal = null) {
  await query(`UPDATE meal_slots SET status = 'IN_SERVICE', service_started_at = $2 WHERE id = $1`, [slot.id, clock.now()], client);
  await recordAudit(client, {
    principal,
    institutionId: slot.institution_id,
    messId: slot.mess_id,
    action: "slot.service_started",
    entityType: "meal_slot",
    entityId: slot.id,
    before: { status: slot.status },
    after: { status: "IN_SERVICE", automatic: !principal },
  });
}

export async function closeService(principal, slotId) {
  return withTransaction(async (client) => {
    const slot = await loadSlot(principal, slotId, can.operateMess, client, { forUpdate: true });
    assertTransition(slot.status, "SERVICE_CLOSED");
    await transitionToClosed(client, slot, principal);
    return getSlotDetail(principal, slot.id, client);
  });
}

export async function transitionToClosed(client, slot, principal = null) {
  await query(`UPDATE meal_slots SET status = 'SERVICE_CLOSED', service_closed_at = $2 WHERE id = $1`, [slot.id, clock.now()], client);
  await recordAudit(client, {
    principal,
    institutionId: slot.institution_id,
    messId: slot.mess_id,
    action: "slot.service_closed",
    entityType: "meal_slot",
    entityId: slot.id,
    before: { status: slot.status },
    after: { status: "SERVICE_CLOSED", automatic: !principal },
  });
  await notifySupervisors(client, slot.mess_id, {
    kind: "RECONCILIATION_DUE",
    title: `Reconcile ${slot.meal_type_name}, ${slot.service_date}`,
    body: "Service has closed. Review attendance and no-show candidates, then reconcile.",
    link: `/supervisor/meals/${slot.id}/reconcile`,
    dedupeKey: `reconcile-due:${slot.id}`,
  });
}

/** Notify every eligible student of a slot (deduplicated per student). */
export async function notifyEligible(client, slot, { kind, title, body, dedupe }) {
  const students = await query(`WITH eligible AS (${eligibleStudentsCte("$1", "$2::date")}) SELECT student_user_id FROM eligible`, [slot.mess_id, slot.service_date], client);
  for (const { student_user_id: userId } of students.rows) {
    await notify(client, { userId, kind, title, body, link: `/student/meals`, data: { slotId: Number(slot.id) }, dedupeKey: `${dedupe}:${userId}` });
  }
}
