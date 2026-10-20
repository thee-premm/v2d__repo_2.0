import { query, withTransaction } from "../../config/db.js";
import { clock } from "../../lib/clock.js";
import { badRequest, notFound, ruleViolation } from "../../lib/errors.js";
import { toBaseUnits, UnitError } from "../../lib/units.js";
import { FOOD_LOG_OPEN } from "../../domain/lifecycle.js";
import { can, visibleMessIds } from "../../domain/permissions.js";
import { recordAudit } from "../audit/audit.service.js";
import { notifySupervisors } from "../notifications/notify.js";
import { getInstitution, loadMess, loadSlot, slotSelect } from "../org/context.js";
import { menuFor, slotView } from "../meals/meals.service.js";
import { camel } from "../org/org.service.js";

const KITCHEN_VISIBLE = ["LOCKED", "FORECAST_READY", "APPROVED", "IN_SERVICE", "SERVICE_CLOSED", "RECONCILED"];

/** The kitchen's day: every meal for the date with its approved target, menu and task progress. */
export async function board(principal, { messId, date }) {
  const allowed = visibleMessIds(principal);
  let messIds;
  if (messId) {
    await loadMess(principal, messId, can.viewOperations);
    messIds = [messId];
  } else {
    messIds = allowed ?? (await query(`SELECT id FROM messes WHERE institution_id = $1`, [principal.institutionId])).rows.map((r) => Number(r.id));
  }
  const inst = await getInstitution(principal.institutionId);
  const day = date ?? (await query(`SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS d`, [clock.now(), inst.timezone])).rows[0].d;
  const r = await query(
    `${slotSelect} WHERE ms.mess_id = ANY($1::bigint[]) AND ms.service_date = $2 AND ms.status = ANY($3::meal_slot_status[]) ORDER BY ms.service_starts_at`,
    [messIds, day, KITCHEN_VISIBLE],
  );
  const ids = r.rows.map((x) => Number(x.id));
  const [menus, plans, tasks, incidents, forecasts] = await Promise.all([
    menuFor(ids),
    query(`SELECT meal_slot_id, approved_servings, approved_at FROM preparation_plans WHERE meal_slot_id = ANY($1::bigint[])`, [ids]),
    query(`SELECT meal_slot_id, status, count(*)::int AS n FROM prep_tasks WHERE meal_slot_id = ANY($1::bigint[]) GROUP BY meal_slot_id, status`, [ids]),
    query(`SELECT meal_slot_id, count(*)::int AS n FROM kitchen_incidents WHERE meal_slot_id = ANY($1::bigint[]) AND status <> 'RESOLVED' GROUP BY meal_slot_id`, [ids]),
    query(`SELECT DISTINCT ON (meal_slot_id) meal_slot_id, recommended_servings FROM forecasts WHERE meal_slot_id = ANY($1::bigint[]) ORDER BY meal_slot_id, version DESC`, [ids]),
  ]);
  const by = (rows) => new Map(rows.map((x) => [Number(x.meal_slot_id), x]));
  const planMap = by(plans.rows);
  const incidentMap = by(incidents.rows);
  const forecastMap = by(forecasts.rows);
  return {
    date: day,
    timezone: inst.timezone,
    serverTime: clock.now(),
    meals: r.rows.map((s) => {
      const t = tasks.rows.filter((x) => Number(x.meal_slot_id) === Number(s.id));
      const count = (st) => t.find((x) => x.status === st)?.n ?? 0;
      return {
        ...slotView(s),
        menu: menus.get(Number(s.id)) ?? [],
        approvedServings: planMap.get(Number(s.id))?.approved_servings ?? null,
        approvedAt: planMap.get(Number(s.id))?.approved_at ?? null,
        // Shown so the kitchen can anticipate, clearly marked as not yet approved.
        pendingRecommendation: planMap.has(Number(s.id)) ? null : (forecastMap.get(Number(s.id))?.recommended_servings ?? null),
        tasks: { pending: count("PENDING"), inProgress: count("IN_PROGRESS"), done: count("DONE") },
        openIncidents: incidentMap.get(Number(s.id))?.n ?? 0,
      };
    }),
  };
}

export async function slotKitchen(principal, slotId) {
  const slot = await loadSlot(principal, slotId, can.viewOperations);
  const [tasks, logs, incidents, plan] = await Promise.all([
    query(
      `SELECT t.*, d.name AS dish_name, d.category, d.portion_grams, sb.full_name AS started_by_name, cb.full_name AS completed_by_name
         FROM prep_tasks t JOIN dishes d ON d.id = t.dish_id LEFT JOIN users sb ON sb.id = t.started_by LEFT JOIN users cb ON cb.id = t.completed_by
        WHERE t.meal_slot_id = $1 ORDER BY t.id`,
      [slot.id],
    ),
    listFoodLogsRows(slot.id),
    query(
      `SELECT k.*, i.name AS ingredient_name, u.full_name AS reported_by_name FROM kitchen_incidents k LEFT JOIN ingredients i ON i.id = k.ingredient_id
         JOIN users u ON u.id = k.reported_by WHERE k.meal_slot_id = $1 ORDER BY k.reported_at DESC`,
      [slot.id],
    ),
    query(`SELECT approved_servings, approved_at FROM preparation_plans WHERE meal_slot_id = $1`, [slot.id]),
  ]);
  return {
    slot: slotView(slot),
    approvedServings: plan.rows[0]?.approved_servings ?? null,
    canRecord: can.workKitchen(principal, { id: slot.mess_id, institution_id: slot.institution_id }),
    tasks: tasks.rows.map((t) => ({
      id: Number(t.id),
      dishId: Number(t.dish_id),
      dishName: t.dish_name,
      category: t.category,
      plannedServings: t.planned_servings,
      // Expected cooked weight, only when the dish defines a portion size.
      expectedKg: t.portion_grams ? Math.round((t.planned_servings * t.portion_grams) / 10) / 100 : null,
      status: t.status,
      preparedKg: t.prepared_kg,
      preparedMeasurement: t.prepared_measurement,
      deviationNote: t.deviation_note,
      startedAt: t.started_at,
      startedBy: t.started_by_name,
      completedAt: t.completed_at,
      completedBy: t.completed_by_name,
    })),
    foodLogs: logs,
    incidents: incidents.rows.map(incidentView),
  };
}

async function loadTask(principal, taskId, client) {
  const t = (await query(`SELECT * FROM prep_tasks WHERE id = $1 FOR UPDATE`, [taskId], client)).rows[0];
  if (!t) throw notFound("Preparation task");
  const slot = await loadSlot(principal, t.meal_slot_id, can.workKitchen, client);
  return { task: t, slot };
}

export async function startTask(principal, taskId) {
  return withTransaction(async (client) => {
    const { task, slot } = await loadTask(principal, taskId, client);
    if (!["APPROVED", "IN_SERVICE"].includes(slot.status)) throw ruleViolation("Preparation starts once the target is approved", "INVALID_STATE");
    if (task.status !== "PENDING") return { id: Number(task.id), status: task.status, unchanged: true };
    await query(`UPDATE prep_tasks SET status = 'IN_PROGRESS', started_at = $2, started_by = $3 WHERE id = $1`, [task.id, clock.now(), principal.userId], client);
    await recordAudit(client, { principal, messId: slot.mess_id, action: "prep.started", entityType: "prep_task", entityId: task.id });
    return { id: Number(task.id), status: "IN_PROGRESS" };
  });
}

export async function completeTask(principal, taskId, { preparedQuantity, unit, measurement, deviationNote }) {
  return withTransaction(async (client) => {
    const { task, slot } = await loadTask(principal, taskId, client);
    if (!["APPROVED", "IN_SERVICE", "SERVICE_CLOSED"].includes(slot.status)) throw ruleViolation("This meal is not in preparation", "INVALID_STATE");
    let kg;
    try {
      kg = toBaseUnits(preparedQuantity, unit, "MASS");
    } catch (err) {
      if (err instanceof UnitError) throw badRequest(err.message, [{ field: "unit", message: err.message }]);
      throw err;
    }
    if (kg > 10000) throw badRequest("Prepared quantity is implausibly large");
    const dish = (await query(`SELECT portion_grams FROM dishes WHERE id = $1`, [task.dish_id], client)).rows[0];
    const expected = dish.portion_grams ? (task.planned_servings * dish.portion_grams) / 1000 : null;
    // A large gap from the expected cooked weight must be explained.
    if (expected && expected > 0 && (kg > expected * 3 || kg < expected * 0.2) && !deviationNote) {
      throw badRequest(`${kg} kg is far from the expected ~${Math.round(expected)} kg. Check the quantity or explain the deviation.`, [
        { field: "deviationNote", message: "Required for a large deviation" },
      ]);
    }
    const now = clock.now();
    await query(
      `UPDATE prep_tasks SET status = 'DONE', prepared_kg = $2, prepared_measurement = $3, deviation_note = $4,
              started_at = COALESCE(started_at, $5), started_by = COALESCE(started_by, $6), completed_at = $5, completed_by = $6
        WHERE id = $1`,
      [task.id, kg, measurement, deviationNote ?? null, now, principal.userId],
      client,
    );
    await recordAudit(client, {
      principal,
      messId: slot.mess_id,
      action: task.status === "DONE" ? "prep.corrected" : "prep.completed",
      entityType: "prep_task",
      entityId: task.id,
      before: task.status === "DONE" ? { preparedKg: task.prepared_kg, measurement: task.prepared_measurement } : undefined,
      after: { preparedKg: kg, measurement, deviationNote },
    });
    return { id: Number(task.id), status: "DONE", preparedKg: kg };
  });
}

// ---------------------------------------------------------------------------
// Food & waste ledger
// ---------------------------------------------------------------------------
async function listFoodLogsRows(slotId) {
  const r = await query(
    `SELECT f.*, d.name AS dish_name, u.full_name AS recorded_by_name, v.full_name AS voided_by_name
       FROM food_logs f LEFT JOIN dishes d ON d.id = f.dish_id JOIN users u ON u.id = f.recorded_by LEFT JOIN users v ON v.id = f.voided_by
      WHERE f.meal_slot_id = $1 ORDER BY f.recorded_at DESC`,
    [slotId],
  );
  return r.rows.map((f) => ({
    id: Number(f.id),
    category: f.category,
    quantityKg: f.quantity_kg,
    measurement: f.measurement,
    dishName: f.dish_name,
    note: f.note,
    recordedAt: f.recorded_at,
    recordedBy: f.recorded_by_name,
    voided: Boolean(f.voided_at),
    voidedAt: f.voided_at,
    voidedBy: f.voided_by_name,
    voidReason: f.void_reason,
  }));
}

export async function addFoodLog(principal, slotId, input) {
  return withTransaction(async (client) => {
    const slot = await loadSlot(principal, slotId, can.workKitchen, client, { forUpdate: true });
    const allowed = input.category === "KITCHEN_WASTE" ? FOOD_LOG_OPEN : FOOD_LOG_OPEN.filter((s) => s !== "APPROVED");
    if (!allowed.includes(slot.status)) {
      throw ruleViolation(
        input.category === "KITCHEN_WASTE" ? "Kitchen waste can be logged once preparation is approved" : "Leftovers and plate waste are logged once service has started",
        "INVALID_STATE",
      );
    }
    let kg;
    try {
      kg = toBaseUnits(input.quantity, input.unit, "MASS");
    } catch (err) {
      if (err instanceof UnitError) throw badRequest(err.message, [{ field: "unit", message: err.message }]);
      throw err;
    }
    if (input.dishId) {
      const d = await query(`SELECT 1 FROM meal_slot_menu_items WHERE meal_slot_id = $1 AND dish_id = $2`, [slot.id, input.dishId], client);
      if (!d.rowCount) throw badRequest("That dish is not on this meal's menu");
    }
    // Leftovers cannot exceed what was recorded as prepared (when preparation was recorded).
    if (["REUSABLE_SURPLUS", "DISCARDED_SURPLUS"].includes(input.category)) {
      const p = (
        await query(
          `SELECT count(*) FILTER (WHERE status <> 'DONE')::int AS open, coalesce(sum(prepared_kg), 0)::numeric AS kg FROM prep_tasks WHERE meal_slot_id = $1`,
          [slot.id],
          client,
        )
      ).rows[0];
      const surplus = (
        await query(
          `SELECT coalesce(sum(quantity_kg), 0)::numeric AS kg FROM food_logs WHERE meal_slot_id = $1 AND voided_at IS NULL AND category IN ('REUSABLE_SURPLUS', 'DISCARDED_SURPLUS')`,
          [slot.id],
          client,
        )
      ).rows[0];
      if (p.open === 0 && Number(p.kg) > 0 && Number(surplus.kg) + kg > Number(p.kg) * 1.02) {
        throw ruleViolation(`Leftovers (${Number(surplus.kg) + kg} kg) would exceed the ${Number(p.kg)} kg recorded as prepared`, "EXCEEDS_PREPARED");
      }
    }
    const r = await query(
      `INSERT INTO food_logs (meal_slot_id, dish_id, category, quantity_kg, measurement, note, recorded_by, recorded_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [slot.id, input.dishId ?? null, input.category, kg, input.measurement, input.note ?? null, principal.userId, clock.now()],
      client,
    );
    await recordAudit(client, { principal, messId: slot.mess_id, action: "food_log.recorded", entityType: "food_log", entityId: r.rows[0].id, after: { ...input, quantityKg: kg } });
    return { id: Number(r.rows[0].id), quantityKg: kg };
  });
}

export async function voidFoodLog(principal, logId, { reason }) {
  return withTransaction(async (client) => {
    const log = (await query(`SELECT * FROM food_logs WHERE id = $1 FOR UPDATE`, [logId], client)).rows[0];
    if (!log) throw notFound("Food log");
    const slot = await loadSlot(principal, log.meal_slot_id, can.workKitchen, client);
    if (log.voided_at) return { id: Number(log.id), voided: true, unchanged: true };
    await query(`UPDATE food_logs SET voided_at = $2, voided_by = $3, void_reason = $4 WHERE id = $1`, [log.id, clock.now(), principal.userId, reason], client);
    await recordAudit(client, { principal, messId: slot.mess_id, action: "food_log.voided", entityType: "food_log", entityId: log.id, reason, before: camel(log) });
    return { id: Number(log.id), voided: true };
  });
}

export async function listFoodLogs(principal, slotId) {
  const slot = await loadSlot(principal, slotId, can.viewOperations);
  return listFoodLogsRows(slot.id);
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------
function incidentView(k) {
  return {
    id: Number(k.id),
    messId: Number(k.mess_id),
    mealSlotId: k.meal_slot_id ? Number(k.meal_slot_id) : null,
    kind: k.kind,
    ingredient: k.ingredient_name ?? null,
    description: k.description,
    status: k.status,
    reportedBy: k.reported_by_name,
    reportedAt: k.reported_at,
    acknowledgedAt: k.acknowledged_at,
    resolvedAt: k.resolved_at,
    resolutionNote: k.resolution_note,
  };
}

export async function listIncidents(principal, messId, { status }) {
  const mess = await loadMess(principal, messId, can.viewOperations);
  const r = await query(
    `SELECT k.*, i.name AS ingredient_name, u.full_name AS reported_by_name, mt.name AS meal_type_name, ms.service_date
       FROM kitchen_incidents k LEFT JOIN ingredients i ON i.id = k.ingredient_id JOIN users u ON u.id = k.reported_by
       LEFT JOIN meal_slots ms ON ms.id = k.meal_slot_id LEFT JOIN meal_types mt ON mt.id = ms.meal_type_id
      WHERE k.mess_id = $1 AND ($2::incident_status IS NULL OR k.status = $2)
      ORDER BY (k.status = 'RESOLVED'), k.reported_at DESC LIMIT 200`,
    [mess.id, status ?? null],
  );
  return r.rows.map((k) => ({ ...incidentView(k), meal: k.meal_slot_id ? { mealType: k.meal_type_name, serviceDate: k.service_date } : null }));
}

export async function reportIncident(principal, messId, input) {
  return withTransaction(async (client) => {
    const mess = await loadMess(principal, messId, can.workKitchen, client);
    if (input.mealSlotId) {
      const s = await query(`SELECT 1 FROM meal_slots WHERE id = $1 AND mess_id = $2`, [input.mealSlotId, mess.id], client);
      if (!s.rowCount) throw notFound("Meal");
    }
    if (input.ingredientId) {
      const i = await query(`SELECT 1 FROM ingredients WHERE id = $1 AND institution_id = $2`, [input.ingredientId, principal.institutionId], client);
      if (!i.rowCount) throw notFound("Ingredient");
    }
    const r = await query(
      `INSERT INTO kitchen_incidents (institution_id, mess_id, meal_slot_id, kind, ingredient_id, description, reported_by, reported_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [principal.institutionId, mess.id, input.mealSlotId ?? null, input.kind, input.ingredientId ?? null, input.description, principal.userId, clock.now()],
      client,
    );
    await notifySupervisors(client, mess.id, {
      kind: "KITCHEN_INCIDENT",
      title: `Kitchen reported: ${input.kind.toLowerCase().replace("_", " ")}`,
      body: input.description.slice(0, 200),
      link: `/supervisor/incidents`,
      dedupeKey: `incident:${r.rows[0].id}`,
    });
    await recordAudit(client, { principal, messId: mess.id, action: "incident.reported", entityType: "kitchen_incident", entityId: r.rows[0].id, after: input });
    return { id: Number(r.rows[0].id), status: "OPEN" };
  });
}

export async function updateIncident(principal, incidentId, { status, resolutionNote }) {
  return withTransaction(async (client) => {
    const k = (await query(`SELECT * FROM kitchen_incidents WHERE id = $1 FOR UPDATE`, [incidentId], client)).rows[0];
    if (!k) throw notFound("Incident");
    await loadMess(principal, k.mess_id, can.operateMess, client);
    const order = { OPEN: 0, ACKNOWLEDGED: 1, RESOLVED: 2 };
    if (order[status] <= order[k.status]) throw ruleViolation(`Incident is already ${k.status}`, "INVALID_TRANSITION");
    if (status === "RESOLVED" && !resolutionNote) throw badRequest("Describe how the incident was resolved", [{ field: "resolutionNote", message: "Required" }]);
    const now = clock.now();
    await query(
      `UPDATE kitchen_incidents SET status = $2,
              acknowledged_at = COALESCE(acknowledged_at, $3), acknowledged_by = COALESCE(acknowledged_by, $4),
              resolved_at = CASE WHEN $2 = 'RESOLVED' THEN $3 ELSE resolved_at END, resolved_by = CASE WHEN $2 = 'RESOLVED' THEN $4 ELSE resolved_by END,
              resolution_note = COALESCE($5, resolution_note)
        WHERE id = $1`,
      [k.id, status, now, principal.userId, resolutionNote ?? null],
      client,
    );
    await recordAudit(client, { principal, messId: k.mess_id, action: `incident.${status.toLowerCase()}`, entityType: "kitchen_incident", entityId: k.id, before: { status: k.status }, after: { status, resolutionNote } });
    return { id: Number(k.id), status };
  });
}
