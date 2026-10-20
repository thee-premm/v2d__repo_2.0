import { parallel, query, withTransaction } from "../../config/db.js";
import { clock } from "../../lib/clock.js";
import { badRequest, notFound, ruleViolation } from "../../lib/errors.js";
import { applyOrderConstraints, BASE_UNIT, roundTo, toBaseUnits, UnitError } from "../../lib/units.js";
import { assertStatus, assertTransition } from "../../domain/lifecycle.js";
import { can } from "../../domain/permissions.js";
import { recordAudit } from "../audit/audit.service.js";
import { notify } from "../notifications/notify.js";
import { loadMess, loadSlot } from "../org/context.js";
import { getSlotDetail } from "../meals/meals.service.js";

/** Stock on hand per ingredient for a mess (sum of signed inventory transactions). */
async function stockOnHand(client, messId, ingredientIds = null) {
  const r = await query(
    `SELECT ingredient_id, sum(quantity)::numeric AS on_hand FROM inventory_transactions
      WHERE mess_id = $1 AND ($2::bigint[] IS NULL OR ingredient_id = ANY($2::bigint[])) GROUP BY ingredient_id`,
    [messId, ingredientIds],
    client,
  );
  return new Map(r.rows.map((x) => [Number(x.ingredient_id), Number(x.on_hand)]));
}

/**
 * Ingredient requirement for `servings` of a slot's menu:
 *   dish servings  = ceil(servings × uptake_fraction)
 *   raw quantity   = dish servings × quantity_per_serving ÷ yield_factor
 * Dishes without a recipe are reported, never guessed.
 */
export async function computeRequirements(client, slot, servings) {
  const lines = await query(
    `SELECT mi.dish_id, d.name AS dish_name, mi.uptake_fraction, di.ingredient_id, i.name AS ingredient_name, i.dimension,
            di.quantity_per_serving, di.yield_factor, i.cost_per_base_unit
       FROM meal_slot_menu_items mi
       JOIN dishes d ON d.id = mi.dish_id
       LEFT JOIN dish_ingredients di ON di.dish_id = d.id
       LEFT JOIN ingredients i ON i.id = di.ingredient_id
      WHERE mi.meal_slot_id = $1 ORDER BY mi.sort_order, i.name`,
    [slot.id],
    client,
  );
  const missingRecipes = [];
  const dishes = new Map();
  const byIngredient = new Map();
  for (const l of lines.rows) {
    const dishServings = Math.ceil(servings * Number(l.uptake_fraction));
    dishes.set(Number(l.dish_id), { dishId: Number(l.dish_id), name: l.dish_name, servings: dishServings });
    if (!l.ingredient_id) {
      missingRecipes.push({ dishId: Number(l.dish_id), name: l.dish_name });
      continue;
    }
    const qty = (dishServings * Number(l.quantity_per_serving)) / Number(l.yield_factor);
    const key = Number(l.ingredient_id);
    const cur = byIngredient.get(key) ?? {
      ingredientId: key,
      name: l.ingredient_name,
      dimension: l.dimension,
      unit: BASE_UNIT[l.dimension],
      required: 0,
      unitCost: l.cost_per_base_unit,
      usedIn: [],
    };
    cur.required += qty;
    cur.usedIn.push(l.dish_name);
    byIngredient.set(key, cur);
  }
  const ids = [...byIngredient.keys()];
  const [onHand, settings] = await parallel(client, [
    () => stockOnHand(client, slot.mess_id, ids.length ? ids : [0]),
    () => query(`SELECT * FROM mess_ingredient_settings WHERE mess_id = $1 AND ingredient_id = ANY($2::bigint[])`, [slot.mess_id, ids.length ? ids : [0]], client),
  ]);
  const settingsMap = new Map(settings.rows.map((s) => [Number(s.ingredient_id), s]));
  const ingredients = [...byIngredient.values()].map((i) => {
    const s = settingsMap.get(i.ingredientId);
    const have = onHand.get(i.ingredientId) ?? 0;
    const safety = s ? Number(s.safety_stock_qty) : 0;
    const shortfall = Math.max(0, i.required + safety - have);
    return {
      ...i,
      required: roundTo(i.required, 3),
      onHand: roundTo(have, 3),
      safetyStock: safety,
      shortfall: roundTo(shortfall, 3),
      recommendedProcurement: applyOrderConstraints(shortfall, { packSize: s?.pack_size_qty ? Number(s.pack_size_qty) : null, minOrder: s?.min_order_qty ? Number(s.min_order_qty) : null }),
      estimatedCost: i.unitCost === null ? null : roundTo(i.required * Number(i.unitCost), 2),
      usedIn: [...new Set(i.usedIn)],
    };
  });
  const costKnown = ingredients.every((i) => i.estimatedCost !== null);
  return {
    servings,
    dishes: [...dishes.values()],
    ingredients,
    missingRecipes: [...new Map(missingRecipes.map((m) => [m.dishId, m])).values()],
    estimatedIngredientCost: ingredients.length && costKnown ? roundTo(ingredients.reduce((s, i) => s + i.estimatedCost, 0), 2) : null,
    costComplete: costKnown && missingRecipes.length === 0,
  };
}

/** Requirements for a slot: frozen at approval, otherwise computed for the recommended (or a given) number of servings. */
export async function slotRequirements(principal, slotId, { servings } = {}) {
  const slot = await loadSlot(principal, slotId, can.viewOperations);
  const plan = (await query(`SELECT approved_servings FROM preparation_plans WHERE meal_slot_id = $1`, [slot.id])).rows[0];
  if (plan && servings === undefined) {
    const frozen = await query(
      `SELECT r.*, i.name, i.dimension FROM plan_ingredient_requirements r JOIN ingredients i ON i.id = r.ingredient_id WHERE r.meal_slot_id = $1 ORDER BY i.name`,
      [slot.id],
    );
    const live = await computeRequirements(undefined, slot, plan.approved_servings);
    return {
      basis: "APPROVED_PLAN",
      ...live,
      ingredients: frozen.rows.map((r) => ({
        ingredientId: Number(r.ingredient_id),
        name: r.name,
        unit: BASE_UNIT[r.dimension],
        required: r.required_qty,
        onHandAtApproval: r.on_hand_qty,
        safetyStock: r.safety_stock_qty,
        recommendedProcurement: r.recommended_procurement_qty,
        unitCost: r.unit_cost,
        estimatedCost: r.unit_cost === null ? null : roundTo(r.required_qty * r.unit_cost, 2),
        usedIn: live.ingredients.find((x) => x.ingredientId === Number(r.ingredient_id))?.usedIn ?? [],
      })),
    };
  }
  let target = servings;
  let basis = "REQUESTED_SERVINGS";
  if (target === undefined) {
    const f = (await query(`SELECT recommended_servings FROM forecasts WHERE meal_slot_id = $1 ORDER BY version DESC LIMIT 1`, [slot.id])).rows[0];
    if (!f) return { basis: "NONE", servings: null, dishes: [], ingredients: [], missingRecipes: [], estimatedIngredientCost: null, costComplete: false };
    target = f.recommended_servings;
    basis = "FORECAST_RECOMMENDATION";
  }
  return { basis, ...(await computeRequirements(undefined, slot, target)) };
}

/**
 * Approve (or revise) the preparation target. Differing from the current
 * forecast recommendation is an override and needs a reason; revising an
 * already-approved target always needs a reason. Freezes ingredient
 * requirements and creates the kitchen's preparation tasks.
 */
export async function approvePlan(principal, slotId, { servings, reason }) {
  return withTransaction(async (client) => {
    const slot = await loadSlot(principal, slotId, can.operateMess, client, { forUpdate: true });
    assertStatus(slot, ["LOCKED", "FORECAST_READY", "APPROVED"], "approve a preparation target");
    const forecast = (await query(`SELECT * FROM forecasts WHERE meal_slot_id = $1 ORDER BY version DESC LIMIT 1`, [slot.id], client)).rows[0];
    const previous = (await query(`SELECT * FROM preparation_plans WHERE meal_slot_id = $1 FOR UPDATE`, [slot.id], client)).rows[0];

    const target = servings ?? forecast?.recommended_servings;
    if (target === undefined || target === null) throw badRequest("No forecast exists yet: enter the number of servings and a reason");
    const agg = (await query(`SELECT eligible_count FROM cutoff_aggregates WHERE meal_slot_id = $1`, [slot.id], client)).rows[0];
    if (agg && target > Math.max(agg.eligible_count * 1.5, agg.eligible_count + 50)) {
      throw ruleViolation(`${target} servings is implausibly high for ${agg.eligible_count} eligible students`, "IMPLAUSIBLE_TARGET");
    }
    const isOverride = !forecast || target !== forecast.recommended_servings;
    if (isOverride && !reason) throw badRequest("Explain why the target differs from the recommendation", [{ field: "reason", message: "A reason is required for an override" }]);
    if (previous && !reason) throw badRequest("Changing an approved target requires a reason", [{ field: "reason", message: "A reason is required" }]);
    if (slot.status !== "APPROVED") assertTransition(slot.status, "APPROVED");

    const now = clock.now();
    await query(
      `INSERT INTO preparation_plans (meal_slot_id, forecast_id, recommended_servings, approved_servings, is_override, override_reason, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (meal_slot_id) DO UPDATE SET forecast_id = EXCLUDED.forecast_id, recommended_servings = EXCLUDED.recommended_servings,
         approved_servings = EXCLUDED.approved_servings, is_override = EXCLUDED.is_override, override_reason = EXCLUDED.override_reason,
         approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at`,
      [slot.id, forecast?.id ?? null, forecast?.recommended_servings ?? null, target, isOverride, reason ?? null, principal.userId, now],
      client,
    );
    const req = await computeRequirements(client, slot, target);
    await query(`DELETE FROM plan_ingredient_requirements WHERE meal_slot_id = $1`, [slot.id], client);
    for (const i of req.ingredients) {
      await query(
        `INSERT INTO plan_ingredient_requirements (meal_slot_id, ingredient_id, required_qty, on_hand_qty, safety_stock_qty, recommended_procurement_qty, unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [slot.id, i.ingredientId, i.required, i.onHand, i.safetyStock, i.recommendedProcurement, i.unitCost],
        client,
      );
    }
    for (const d of req.dishes) {
      await query(
        `INSERT INTO prep_tasks (meal_slot_id, dish_id, planned_servings) VALUES ($1, $2, $3)
         ON CONFLICT (meal_slot_id, dish_id) DO UPDATE SET planned_servings = CASE WHEN prep_tasks.status = 'PENDING' THEN EXCLUDED.planned_servings ELSE prep_tasks.planned_servings END`,
        [slot.id, d.dishId, d.servings],
        client,
      );
    }
    if (slot.status !== "APPROVED") await query(`UPDATE meal_slots SET status = 'APPROVED' WHERE id = $1`, [slot.id], client);

    await recordAudit(client, {
      principal,
      messId: slot.mess_id,
      action: previous ? "plan.revised" : isOverride ? "plan.approved_override" : "plan.approved",
      entityType: "meal_slot",
      entityId: slot.id,
      reason,
      before: previous ? { approvedServings: previous.approved_servings } : { status: slot.status },
      after: { approvedServings: target, recommendedServings: forecast?.recommended_servings ?? null, forecastVersion: forecast?.version ?? null, isOverride },
    });
    const kitchen = await query(
      `SELECT DISTINCT user_id FROM role_assignments WHERE mess_id = $1 AND role = 'KITCHEN_STAFF' AND revoked_at IS NULL`,
      [slot.mess_id],
      client,
    );
    for (const { user_id: userId } of kitchen.rows) {
      await notify(client, {
        userId,
        kind: "PREP_TARGET_APPROVED",
        title: `${previous ? "Revised" : "Approved"}: ${target} servings · ${slot.meal_type_name}, ${slot.service_date}`,
        body: req.missingRecipes.length ? `${req.missingRecipes.length} dish(es) have no recipe; quantities for them are not calculated.` : "Ingredient quantities are ready.",
        link: `/kitchen/meals/${slot.id}`,
        dedupeKey: `prep-approved:${slot.id}:${target}:${userId}`,
      });
    }
    return getSlotDetail(principal, slot.id, client);
  });
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------
export async function inventory(principal, messId) {
  const mess = await loadMess(principal, messId, can.viewOperations);
  const r = await query(
    `SELECT i.id, i.name, i.dimension, i.category, i.cost_per_base_unit,
            coalesce(sum(t.quantity), 0)::numeric AS on_hand, max(t.recorded_at) AS last_movement,
            s.safety_stock_qty, s.pack_size_qty, s.min_order_qty
       FROM ingredients i
       LEFT JOIN inventory_transactions t ON t.ingredient_id = i.id AND t.mess_id = $1
       LEFT JOIN mess_ingredient_settings s ON s.ingredient_id = i.id AND s.mess_id = $1
      WHERE i.institution_id = $2 AND i.is_active
      GROUP BY i.id, s.safety_stock_qty, s.pack_size_qty, s.min_order_qty
      ORDER BY i.name`,
    [mess.id, principal.institutionId],
  );
  return r.rows.map((x) => ({
    ingredientId: Number(x.id),
    name: x.name,
    category: x.category,
    unit: BASE_UNIT[x.dimension],
    dimension: x.dimension,
    onHand: roundTo(Number(x.on_hand), 3),
    lastMovement: x.last_movement,
    safetyStock: x.safety_stock_qty,
    packSize: x.pack_size_qty,
    minOrder: x.min_order_qty,
    belowSafetyStock: x.safety_stock_qty !== null && Number(x.on_hand) < Number(x.safety_stock_qty),
  }));
}

const SIGN = { RECEIPT: 1, ISSUE: -1, SPOILAGE: -1 };

export async function recordTransaction(principal, messId, t) {
  return withTransaction(async (client) => {
    const mess = await loadMess(principal, messId, can.workKitchen, client);
    const ing = (await query(`SELECT id, name, dimension FROM ingredients WHERE id = $1 AND institution_id = $2`, [t.ingredientId, principal.institutionId], client)).rows[0];
    if (!ing) throw notFound("Ingredient");
    let qty;
    try {
      qty = toBaseUnits(t.quantity, t.unit, ing.dimension);
    } catch (err) {
      if (err instanceof UnitError) throw badRequest(err.message, [{ field: "unit", message: err.message }]);
      throw err;
    }
    if (qty <= 0) throw badRequest("Quantity must be greater than zero");
    const signed = t.kind === "ADJUSTMENT" ? (t.direction === "OUT" ? -qty : qty) : SIGN[t.kind] * qty;
    if (t.mealSlotId) {
      const s = (await query(`SELECT id FROM meal_slots WHERE id = $1 AND mess_id = $2`, [t.mealSlotId, mess.id], client)).rows[0];
      if (!s) throw notFound("Meal");
    }
    const before = (await stockOnHand(client, mess.id, [ing.id])).get(Number(ing.id)) ?? 0;
    const r = await query(
      `INSERT INTO inventory_transactions (institution_id, mess_id, ingredient_id, kind, quantity, unit_cost, meal_slot_id, note, recorded_by, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [principal.institutionId, mess.id, ing.id, t.kind, signed, t.unitCost ?? null, t.mealSlotId ?? null, t.note ?? null, principal.userId, clock.now()],
      client,
    );
    const after = roundTo(before + signed, 4);
    await recordAudit(client, { principal, messId: mess.id, action: "inventory.recorded", entityType: "inventory_transaction", entityId: r.rows[0].id, after: { ingredient: ing.name, kind: t.kind, quantity: signed } });
    return {
      id: Number(r.rows[0].id),
      onHand: after,
      unit: BASE_UNIT[ing.dimension],
      // Recorded anyway: real stock may include unrecorded receipts. Flagged for follow-up.
      warnings: after < 0 ? [{ code: "STOCK_NEGATIVE", message: `Recorded stock of ${ing.name} is now negative (${after} ${BASE_UNIT[ing.dimension]}). Check for unrecorded receipts.` }] : [],
    };
  });
}

export async function listTransactions(principal, messId, { ingredientId, limit, offset }) {
  const mess = await loadMess(principal, messId, can.viewOperations);
  const r = await query(
    `SELECT t.id, t.kind, t.quantity, t.unit_cost, t.meal_slot_id, t.note, t.recorded_at, i.name AS ingredient_name, i.dimension, u.full_name AS recorded_by
       FROM inventory_transactions t JOIN ingredients i ON i.id = t.ingredient_id JOIN users u ON u.id = t.recorded_by
      WHERE t.mess_id = $1 AND ($2::bigint IS NULL OR t.ingredient_id = $2)
      ORDER BY t.recorded_at DESC, t.id DESC LIMIT $3 OFFSET $4`,
    [mess.id, ingredientId ?? null, limit, offset],
  );
  return r.rows.map((x) => ({
    id: Number(x.id),
    kind: x.kind,
    quantity: x.quantity,
    unit: BASE_UNIT[x.dimension],
    unitCost: x.unit_cost,
    mealSlotId: x.meal_slot_id,
    note: x.note,
    recordedAt: x.recorded_at,
    ingredient: x.ingredient_name,
    recordedBy: x.recorded_by,
  }));
}

export async function updateStockSettings(principal, messId, ingredientId, s) {
  return withTransaction(async (client) => {
    const mess = await loadMess(principal, messId, can.operateMess, client);
    const ing = (await query(`SELECT id FROM ingredients WHERE id = $1 AND institution_id = $2`, [ingredientId, principal.institutionId], client)).rows[0];
    if (!ing) throw notFound("Ingredient");
    await query(
      `INSERT INTO mess_ingredient_settings (mess_id, ingredient_id, safety_stock_qty, pack_size_qty, min_order_qty) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (mess_id, ingredient_id) DO UPDATE SET safety_stock_qty = EXCLUDED.safety_stock_qty, pack_size_qty = EXCLUDED.pack_size_qty, min_order_qty = EXCLUDED.min_order_qty`,
      [mess.id, ing.id, s.safetyStock, s.packSize ?? null, s.minOrder ?? null],
      client,
    );
    await recordAudit(client, { principal, messId: mess.id, action: "inventory.settings_updated", entityType: "ingredient", entityId: ing.id, after: s });
    return { updated: true };
  });
}

/**
 * Procurement outlook across upcoming meals: total requirement (approved
 * targets, else forecast recommendations) minus current stock, once.
 */
export async function procurementOutlook(principal, messId, { from, to }) {
  const mess = await loadMess(principal, messId, can.viewOperations);
  const slots = await query(
    `SELECT ms.id, ms.mess_id, ms.service_date, ms.status, mt.name AS meal_type_name,
            pp.approved_servings,
            (SELECT recommended_servings FROM forecasts f WHERE f.meal_slot_id = ms.id ORDER BY version DESC LIMIT 1) AS recommended
       FROM meal_slots ms JOIN meal_types mt ON mt.id = ms.meal_type_id LEFT JOIN preparation_plans pp ON pp.meal_slot_id = ms.id
      WHERE ms.mess_id = $1 AND ms.service_date BETWEEN $2 AND $3 AND ms.status IN ('LOCKED', 'FORECAST_READY', 'APPROVED')
      ORDER BY ms.service_starts_at`,
    [mess.id, from, to],
  );
  const totals = new Map();
  const included = [];
  const excluded = [];
  for (const s of slots.rows) {
    const servings = s.approved_servings ?? s.recommended;
    if (servings === null) {
      excluded.push({ slotId: Number(s.id), serviceDate: s.service_date, mealType: s.meal_type_name, reason: "NO_TARGET" });
      continue;
    }
    const req = await computeRequirements(undefined, s, servings);
    included.push({ slotId: Number(s.id), serviceDate: s.service_date, mealType: s.meal_type_name, servings, basis: s.approved_servings !== null ? "APPROVED" : "FORECAST", missingRecipes: req.missingRecipes.length });
    for (const i of req.ingredients) {
      const cur = totals.get(i.ingredientId) ?? { ingredientId: i.ingredientId, name: i.name, unit: i.unit, required: 0, unitCost: i.unitCost };
      cur.required += i.required;
      totals.set(i.ingredientId, cur);
    }
  }
  const ids = [...totals.keys()];
  const onHand = await stockOnHand(undefined, mess.id, ids.length ? ids : [0]);
  const settings = await query(`SELECT * FROM mess_ingredient_settings WHERE mess_id = $1`, [mess.id]);
  const sMap = new Map(settings.rows.map((s) => [Number(s.ingredient_id), s]));
  return {
    from,
    to,
    meals: included,
    excluded,
    ingredients: [...totals.values()].map((t) => {
      const s = sMap.get(t.ingredientId);
      const have = onHand.get(t.ingredientId) ?? 0;
      const safety = s ? Number(s.safety_stock_qty) : 0;
      const shortfall = Math.max(0, t.required + safety - have);
      return {
        ...t,
        required: roundTo(t.required, 3),
        onHand: roundTo(have, 3),
        safetyStock: safety,
        recommendedProcurement: applyOrderConstraints(shortfall, { packSize: s?.pack_size_qty ? Number(s.pack_size_qty) : null, minOrder: s?.min_order_qty ? Number(s.min_order_qty) : null }),
        estimatedCost: t.unitCost === null ? null : roundTo(applyOrderConstraints(shortfall, {}) * Number(t.unitCost), 2),
      };
    }),
  };
}
