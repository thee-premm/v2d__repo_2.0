import { query } from "../../config/db.js";
import { clock } from "../../lib/clock.js";
import { toCsv } from "../../lib/csv.js";
import { assertAdmin, getInstitution, loadMess } from "../org/context.js";
import { can } from "../../domain/permissions.js";
import { aggregate, baselineComparison, mealMetrics, METRIC_DEFINITIONS, ratioOfSums } from "./metrics.js";

const DOW = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * One row per meal with every input a metric needs. Sums are taken in SQL;
 * whether a value is *known* is carried alongside (entry counts, completeness flags).
 */
const FACTS_SQL = `
  SELECT ms.id, ms.mess_id, ms.service_date, ms.status, extract(isodow FROM ms.service_date)::int AS iso_dow,
         mt.code AS meal_type_code, mt.name AS meal_type_name,
         ca.eligible_count, ca.yes_count, ca.no_count, ca.unvoted_count,
         pp.approved_servings, pp.is_override,
         f.predicted_attendance, f.method AS forecast_method,
         (rc.meal_slot_id IS NOT NULL) AS reconciled, rc.actual_attendance,
         oc.yes_attended, oc.yes_no_show, oc.no_walk_in, oc.unvoted_attended,
         pt.tasks_total, pt.tasks_done, pt.prepared_kg, pt.prepared_any_estimated,
         fl.reusable_entries, fl.reusable_kg, fl.discarded_surplus_entries, fl.discarded_surplus_kg,
         fl.plate_entries, fl.plate_kg, fl.kitchen_entries, fl.kitchen_kg, fl.waste_any_estimated,
         pc.plan_cost, pc.plan_cost_complete, ic.issued_cost, ic.issued_cost_complete
    FROM meal_slots ms
    JOIN meal_types mt ON mt.id = ms.meal_type_id
    LEFT JOIN cutoff_aggregates ca ON ca.meal_slot_id = ms.id
    LEFT JOIN preparation_plans pp ON pp.meal_slot_id = ms.id
    LEFT JOIN LATERAL (
      SELECT f.predicted_attendance, f.method FROM forecasts f
       WHERE f.meal_slot_id = ms.id AND (pp.forecast_id IS NULL OR f.id = pp.forecast_id)
       ORDER BY f.version DESC LIMIT 1) f ON true
    LEFT JOIN reconciliations rc ON rc.meal_slot_id = ms.id
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE classification = 'YES_ATTENDED') AS yes_attended,
             count(*) FILTER (WHERE classification = 'YES_NO_SHOW') AS yes_no_show,
             count(*) FILTER (WHERE classification = 'NO_WALK_IN') AS no_walk_in,
             count(*) FILTER (WHERE classification = 'UNVOTED_ATTENDED') AS unvoted_attended
        FROM attendance_outcomes o WHERE o.meal_slot_id = ms.id) oc ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS tasks_total, count(*) FILTER (WHERE status = 'DONE') AS tasks_done,
             sum(prepared_kg) AS prepared_kg, bool_or(prepared_measurement = 'ESTIMATED') AS prepared_any_estimated
        FROM prep_tasks t WHERE t.meal_slot_id = ms.id) pt ON true
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE category = 'REUSABLE_SURPLUS') AS reusable_entries,
             sum(quantity_kg) FILTER (WHERE category = 'REUSABLE_SURPLUS') AS reusable_kg,
             count(*) FILTER (WHERE category = 'DISCARDED_SURPLUS') AS discarded_surplus_entries,
             sum(quantity_kg) FILTER (WHERE category = 'DISCARDED_SURPLUS') AS discarded_surplus_kg,
             count(*) FILTER (WHERE category = 'PLATE_WASTE') AS plate_entries,
             sum(quantity_kg) FILTER (WHERE category = 'PLATE_WASTE') AS plate_kg,
             count(*) FILTER (WHERE category = 'KITCHEN_WASTE') AS kitchen_entries,
             sum(quantity_kg) FILTER (WHERE category = 'KITCHEN_WASTE') AS kitchen_kg,
             bool_or(measurement = 'ESTIMATED') FILTER (WHERE category IN ('DISCARDED_SURPLUS', 'PLATE_WASTE')) AS waste_any_estimated
        FROM food_logs fl WHERE fl.meal_slot_id = ms.id AND fl.voided_at IS NULL) fl ON true
    LEFT JOIN LATERAL (
      SELECT sum(r.required_qty * r.unit_cost) AS plan_cost, count(*) > 0 AND bool_and(r.unit_cost IS NOT NULL) AS plan_cost_complete
        FROM plan_ingredient_requirements r WHERE r.meal_slot_id = ms.id) pc ON true
    LEFT JOIN LATERAL (
      SELECT sum(-t.quantity * coalesce(t.unit_cost, i.cost_per_base_unit)) AS issued_cost,
             count(*) > 0 AND bool_and(coalesce(t.unit_cost, i.cost_per_base_unit) IS NOT NULL) AS issued_cost_complete
        FROM inventory_transactions t JOIN ingredients i ON i.id = t.ingredient_id
       WHERE t.meal_slot_id = ms.id AND t.kind = 'ISSUE') ic ON true
   WHERE ms.mess_id = ANY($1::bigint[]) AND ms.service_date BETWEEN $2 AND $3
     AND ms.status IN ('LOCKED', 'FORECAST_READY', 'APPROVED', 'IN_SERVICE', 'SERVICE_CLOSED', 'RECONCILED')
     AND ($4::bigint IS NULL OR ms.meal_type_id = $4)
   ORDER BY ms.service_date, mt.sort_order`;

async function loadMeals(messIds, { from, to, mealTypeId }, settings) {
  const r = await query(FACTS_SQL, [messIds, from, to, mealTypeId ?? null]);
  return r.rows.map((f) => ({ messId: Number(f.mess_id), ...mealMetrics(f, { configuredCostPerKg: settings.analytics.foodCostPerKg }) }));
}

function groupBy(meals, keyFn) {
  const map = new Map();
  for (const m of meals) {
    const k = keyFn(m);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(m);
  }
  return map;
}

function trendRow(key, label, meals, co2eFactor) {
  const a = aggregate(meals, { co2eFactor });
  return {
    key,
    label,
    meals: a.meals,
    participationRate: a.participationRate,
    averageAttendance: a.averageAttendance,
    noShowRate: a.noShowRate,
    forecastBias: a.forecast.forecastBias,
    meanAbsolutePercentError: a.forecast.meanAbsolutePercentError,
    discardedFoodKg: a.discardedFoodKg.value,
    wastePerServingG: a.wastePerServingG.value,
    wasteRate: a.wasteRate.value,
    wasteMeasuredMeals: a.discardedFoodKg.meals,
  };
}

/** Menu-wise view: meals grouped by each dish they served. Correlational only. */
async function menuBreakdown(meals) {
  const ids = meals.map((m) => m.slotId);
  if (!ids.length) return [];
  const r = await query(
    `SELECT mi.meal_slot_id, d.id, d.name FROM meal_slot_menu_items mi JOIN dishes d ON d.id = mi.dish_id WHERE mi.meal_slot_id = ANY($1::bigint[])`,
    [ids],
  );
  const byDish = new Map();
  const mealById = new Map(meals.map((m) => [m.slotId, m]));
  for (const row of r.rows) {
    const k = Number(row.id);
    if (!byDish.has(k)) byDish.set(k, { name: row.name, meals: [] });
    byDish.get(k).meals.push(mealById.get(Number(row.meal_slot_id)));
  }
  return [...byDish.entries()]
    .map(([dishId, { name, meals: ms }]) => {
      const w = ratioOfSums(ms, "discardedFoodKg", "actualAttendance", 1000);
      return { dishId, name, meals: ms.length, wastePerServingG: w.value, wasteMeasuredMeals: w.meals };
    })
    .sort((a, b) => (b.wastePerServingG ?? -1) - (a.wastePerServingG ?? -1));
}

/** Planned vs. issued quantities per ingredient for meals with recorded issues. */
async function ingredientVariance(messIds, { from, to }) {
  const r = await query(
    `WITH planned AS (
       SELECT r.ingredient_id, r.meal_slot_id, r.required_qty FROM plan_ingredient_requirements r
         JOIN meal_slots ms ON ms.id = r.meal_slot_id WHERE ms.mess_id = ANY($1::bigint[]) AND ms.service_date BETWEEN $2 AND $3),
     issued AS (
       SELECT t.ingredient_id, t.meal_slot_id, sum(-t.quantity) AS qty FROM inventory_transactions t
         JOIN meal_slots ms ON ms.id = t.meal_slot_id
        WHERE t.kind = 'ISSUE' AND ms.mess_id = ANY($1::bigint[]) AND ms.service_date BETWEEN $2 AND $3 GROUP BY 1, 2)
     SELECT i.id, i.name, i.dimension, i.cost_per_base_unit, sum(p.required_qty) AS planned, sum(iss.qty) AS issued, count(*)::int AS meals
       FROM planned p JOIN issued iss ON iss.ingredient_id = p.ingredient_id AND iss.meal_slot_id = p.meal_slot_id
       JOIN ingredients i ON i.id = p.ingredient_id
      GROUP BY i.id ORDER BY i.name`,
    [messIds, from, to],
  );
  const unit = { MASS: "kg", VOLUME: "l", COUNT: "unit" };
  return r.rows.map((x) => ({
    ingredientId: Number(x.id),
    name: x.name,
    unit: unit[x.dimension],
    meals: x.meals,
    planned: Math.round(x.planned * 1000) / 1000,
    issued: Math.round(x.issued * 1000) / 1000,
    variancePercent: x.planned > 0 ? Math.round(((x.issued - x.planned) / x.planned) * 1000) / 10 : null,
    varianceCost: x.cost_per_base_unit === null ? null : Math.round((x.issued - x.planned) * x.cost_per_base_unit * 100) / 100,
  }));
}

/**
 * Explainable, rule-based findings. Each states the evidence it rests on and
 * only fires with enough meals behind it.
 */
export function recommendations(meals, overall, byMealType, byDow, byDish, incidents = 0) {
  const out = [];
  for (const [code, list] of byMealType) {
    const a = aggregate(list);
    const n = a.forecast.meals;
    if (n >= 5 && a.forecast.forecastBias !== null && a.averageAttendance) {
      const share = Math.abs(a.forecast.forecastBias) / a.averageAttendance;
      if (Math.abs(a.forecast.forecastBias) >= 3 && share >= 0.05) {
        out.push({
          severity: share >= 0.1 ? "HIGH" : "MEDIUM",
          code: a.forecast.forecastBias > 0 ? "FORECAST_OVER_PREDICTS" : "FORECAST_UNDER_PREDICTS",
          title: `${list[0].mealTypeName} forecasts ${a.forecast.forecastBias > 0 ? "over" : "under"}-predict by ${Math.abs(a.forecast.forecastBias)} students on average`,
          detail: `Across ${n} reconciled ${list[0].mealTypeName.toLowerCase()} meals the forecast was ${Math.round(share * 100)}% ${a.forecast.forecastBias > 0 ? "above" : "below"} actual attendance. As more meals are reconciled the model's rates adapt; if the gap persists, review the service level or walk-in policy.`,
          evidence: { meals: n, meanBias: a.forecast.forecastBias, averageAttendance: a.averageAttendance },
        });
      }
    }
    if (a.reconciledMeals >= 5 && a.nonResponseRate !== null && a.nonResponseRate >= 30) {
      out.push({
        severity: a.nonResponseRate >= 45 ? "HIGH" : "MEDIUM",
        code: "HIGH_NON_RESPONSE",
        title: `${a.nonResponseRate}% of students do not vote for ${list[0].mealTypeName.toLowerCase()}`,
        detail: "Non-responders make the forecast depend on assumed behaviour. Consider an earlier closing reminder for this meal or reviewing its cutoff time.",
        evidence: { meals: a.meals, nonResponseRate: a.nonResponseRate },
      });
    }
  }
  if (overall.reconciledMeals >= 5 && overall.targetExcess.meals >= 5 && overall.averageAttendance) {
    const avgExcess = overall.targetExcess.value / overall.targetExcess.meals;
    if (avgExcess / overall.averageAttendance >= 0.08) {
      out.push({
        severity: "MEDIUM",
        code: "TARGETS_ABOVE_ATTENDANCE",
        title: `Approved targets exceeded attendance by ${Math.round(avgExcess)} servings per meal`,
        detail: `${Math.round((avgExcess / overall.averageAttendance) * 100)}% above average attendance across ${overall.targetExcess.meals} meals. Check whether overrides are adding unnecessary buffer.`,
        evidence: { meals: overall.targetExcess.meals, averageExcess: Math.round(avgExcess * 10) / 10 },
      });
    }
  }
  if (overall.shortfallMeals > 0) {
    out.push({
      severity: overall.shortfallMeals >= 3 ? "HIGH" : "MEDIUM",
      code: "TARGET_SHORTFALL",
      title: `${overall.shortfallMeals} meal(s) had more diners than the approved target`,
      detail: "Attendance exceeded the planned servings. Review these meals for walk-in surges or an overly tight target.",
      evidence: { meals: overall.shortfallMeals },
    });
  }
  if (overall.closedMeals >= 3 && overall.completeness.wasteCompletenessRate !== null && overall.completeness.wasteCompletenessRate < 80) {
    out.push({
      severity: "HIGH",
      code: "WASTE_DATA_INCOMPLETE",
      title: `Discarded food was recorded for ${overall.completeness.wasteCompletenessRate}% of closed meals`,
      detail: `Leftovers and plate waste are missing for ${overall.closedMeals - overall.discardedFoodKg.meals} of ${overall.closedMeals} closed meals. Totals and savings below cover recorded meals only.`,
      evidence: overall.completeness,
    });
  }
  const overallWps = overall.wastePerServingG.value;
  if (overallWps) {
    for (const row of byDow) {
      if (row.wasteMeasuredMeals >= 2 && row.wastePerServingG !== null && row.wastePerServingG >= overallWps * 1.5) {
        out.push({
          severity: "LOW",
          code: "HIGH_WASTE_DAY",
          title: `Waste per serving on ${row.label}s is ${Math.round((row.wastePerServingG / overallWps) * 10) / 10}× the average`,
          detail: `${row.wastePerServingG} g vs ${overallWps} g overall, over ${row.wasteMeasuredMeals} measured meals.`,
          evidence: row,
        });
      }
    }
    for (const d of byDish) {
      if (d.wasteMeasuredMeals >= 3 && d.wastePerServingG !== null && d.wastePerServingG >= overallWps * 1.5) {
        out.push({
          severity: "LOW",
          code: "HIGH_WASTE_DISH",
          title: `Meals serving ${d.name} show higher waste`,
          detail: `${d.wastePerServingG} g per serving vs ${overallWps} g overall across ${d.wasteMeasuredMeals} measured meals. Correlation only: the dish may not be the cause.`,
          evidence: d,
        });
      }
    }
  }
  const overrides = meals.filter((m) => m.planOverride !== null && m.planOverride !== undefined);
  if (overrides.length >= 5) {
    const share = overrides.filter((m) => m.planOverride).length / overrides.length;
    if (share >= 0.3) {
      out.push({
        severity: "LOW",
        code: "FREQUENT_OVERRIDES",
        title: `${Math.round(share * 100)}% of targets were overridden`,
        detail: "Frequent overrides suggest the recommendation does not match local knowledge. Record clear reasons so the pattern can be reviewed.",
        evidence: { approvals: overrides.length, overrideShare: Math.round(share * 1000) / 10 },
      });
    }
  }
  if (incidents > 0) {
    out.push({ severity: "LOW", code: "OPEN_INCIDENTS", title: `${incidents} kitchen incident(s) are unresolved`, detail: "Shortages and substitutions affect both waste and forecast accuracy.", evidence: { openIncidents: incidents } });
  }
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function breakdowns(meals, co2eFactor) {
  const byMealType = groupBy(meals, (m) => m.mealType);
  return {
    byMealType,
    rows: {
      byMealType: [...byMealType.entries()].map(([k, list]) => trendRow(k, list[0].mealTypeName, list, co2eFactor)),
      byDayOfWeek: [...groupBy(meals, (m) => m.dayOfWeek).entries()].sort((a, b) => a[0] - b[0]).map(([k, list]) => trendRow(k, DOW[k], list, co2eFactor)),
      byDate: [...groupBy(meals, (m) => m.serviceDate).entries()].map(([k, list]) => trendRow(k, k, list, co2eFactor)),
    },
  };
}

async function latestBaseline(messId) {
  return (await query(`SELECT * FROM waste_baselines WHERE mess_id = $1 ORDER BY created_at DESC LIMIT 1`, [messId])).rows[0] ?? null;
}

export async function messAnalytics(principal, messId, filters) {
  const mess = await loadMess(principal, messId, can.viewMessAnalytics);
  const inst = await getInstitution(principal.institutionId);
  const co2eFactor = inst.settings.analytics.co2ePerKgFoodWaste;
  const meals = await loadMeals([mess.id], filters, inst.settings);
  const overall = aggregate(meals, { co2eFactor });
  const { byMealType, rows } = breakdowns(meals, co2eFactor);
  const [byDish, variance, incidents, baseline] = await Promise.all([
    menuBreakdown(meals),
    ingredientVariance([mess.id], filters),
    query(`SELECT count(*)::int AS n FROM kitchen_incidents WHERE mess_id = $1 AND status <> 'RESOLVED'`, [mess.id]),
    latestBaseline(mess.id),
  ]);
  return {
    scope: { type: "MESS", messId: Number(mess.id), messName: mess.name, institution: inst.name },
    filters,
    generatedAt: clock.now(),
    currency: inst.currency,
    assumptions: {
      co2ePerKgFoodWaste: co2eFactor,
      co2eFactorSource: inst.settings.analytics.co2eFactorSource,
      configuredFoodCostPerKg: inst.settings.analytics.foodCostPerKg,
    },
    summary: overall,
    baseline: baselineComparison(baseline, overall),
    trends: { ...rows, byDish },
    ingredientVariance: variance,
    recommendations: recommendations(meals, overall, byMealType, rows.byDayOfWeek, byDish, incidents.rows[0].n),
    meals,
  };
}

export async function institutionAnalytics(principal, filters) {
  assertAdmin(principal);
  const inst = await getInstitution(principal.institutionId);
  const co2eFactor = inst.settings.analytics.co2ePerKgFoodWaste;
  const messes = (await query(`SELECT id, code, name, seating_capacity FROM messes WHERE institution_id = $1 ORDER BY name`, [principal.institutionId])).rows;
  const meals = await loadMeals(messes.map((m) => m.id), filters, inst.settings);
  const overall = aggregate(meals, { co2eFactor });
  const byMess = groupBy(meals, (m) => m.messId);
  const baselines = await query(
    `SELECT DISTINCT ON (mess_id) * FROM waste_baselines WHERE institution_id = $1 ORDER BY mess_id, created_at DESC`,
    [principal.institutionId],
  );
  const baselineMap = new Map(baselines.rows.map((b) => [Number(b.mess_id), b]));
  const messRows = messes.map((m) => {
    const list = byMess.get(Number(m.id)) ?? [];
    const a = aggregate(list, { co2eFactor });
    const cmp = baselineComparison(baselineMap.get(Number(m.id)) ?? null, a);
    return {
      messId: Number(m.id),
      code: m.code,
      name: m.name,
      meals: a.meals,
      reconciledMeals: a.reconciledMeals,
      averageAttendance: a.averageAttendance,
      participationRate: a.participationRate,
      noShowRate: a.noShowRate,
      meanAbsolutePercentError: a.forecast.meanAbsolutePercentError,
      forecastBias: a.forecast.forecastBias,
      discardedFoodKg: a.discardedFoodKg.value,
      wastePerServingG: a.wastePerServingG.value,
      wasteRate: a.wasteRate.value,
      wasteCost: a.wasteCost.value,
      wasteCompletenessRate: a.completeness.wasteCompletenessRate,
      baselineChangePercent: cmp.available ? cmp.changePercent : null,
      avoidedWasteKg: cmp.available ? cmp.avoidedWasteKg : null,
    };
  });
  const avoided = messRows.filter((m) => m.avoidedWasteKg !== null);
  const avoidedKg = avoided.length ? Math.round(avoided.reduce((s, m) => s + m.avoidedWasteKg, 0) * 10) / 10 : null;
  // Monetise avoided waste with each mess's own cost basis where known.
  const costPerKg = overall.wasteCost.value !== null && overall.discardedFoodKg.value ? overall.wasteCost.value / overall.discardedFoodKg.value : inst.settings.analytics.foodCostPerKg;
  const monthly = [...groupBy(meals, (m) => m.serviceDate.slice(0, 7)).entries()].map(([k, list]) => trendRow(k, k, list, co2eFactor));
  return {
    scope: { type: "INSTITUTION", institution: inst.name, messes: messes.length },
    filters,
    generatedAt: clock.now(),
    currency: inst.currency,
    assumptions: {
      co2ePerKgFoodWaste: co2eFactor,
      co2eFactorSource: inst.settings.analytics.co2eFactorSource,
      configuredFoodCostPerKg: inst.settings.analytics.foodCostPerKg,
    },
    summary: overall,
    impact: {
      messesWithBaseline: avoided.length,
      avoidedWasteKg: avoidedKg,
      estimatedSavings: avoidedKg !== null && costPerKg ? Math.round(avoidedKg * costPerKg * 100) / 100 : null,
      savingsCostPerKg: costPerKg ? Math.round(costPerKg * 100) / 100 : null,
      avoidedCo2eKg: avoidedKg !== null ? Math.round(avoidedKg * co2eFactor * 10) / 10 : null,
      method:
        "For each mess with a baseline: (baseline g/serving − observed g/serving) × measured servings. Savings use the observed cost per kg of discarded food (or the configured rate). These are estimates of change against a reference period, not proof of cause.",
    },
    messes: messRows,
    trends: { monthly, byMealType: breakdowns(meals, co2eFactor).rows.byMealType },
  };
}

function fmt(v) {
  return v === null || v === undefined ? "" : v;
}

const MEAL_COLUMNS = [
  ["serviceDate", "Date"],
  ["mealTypeName", "Meal"],
  ["status", "Status"],
  ["eligible", "Eligible at cutoff"],
  ["yes", "YES"],
  ["no", "NO"],
  ["unvoted", "Unvoted"],
  ["participationRate", "Participation %"],
  ["predictedAttendance", "Predicted (estimate)"],
  ["approvedServings", "Approved servings"],
  ["actualAttendance", "Actual attendance"],
  ["forecastError", "Forecast error"],
  ["preparedKg", "Prepared kg"],
  ["reusableSurplusKg", "Reusable surplus kg"],
  ["discardedSurplusKg", "Discarded leftovers kg"],
  ["plateWasteKg", "Plate waste kg"],
  ["kitchenWasteKg", "Kitchen waste kg"],
  ["discardedFoodKg", "Discarded food kg"],
  ["wastePerServingG", "Waste g/serving"],
  ["wasteCost", "Estimated waste cost"],
  ["costBasis", "Cost basis"],
];

function exportPreamble(title, report, principal) {
  return [
    ["Report", title],
    ["Scope", report.scope.type === "MESS" ? `${report.scope.messName} (${report.scope.institution})` : report.scope.institution],
    ["Period", `${report.filters.from} to ${report.filters.to}`],
    ["Meal type filter", report.filters.mealTypeId ?? "All"],
    ["Generated at (UTC)", report.generatedAt.toISOString()],
    ["Generated by", principal.fullName],
    ["Currency", report.currency],
    ["Note", "Blank cells mean the value was not recorded; they are not zero."],
    [],
  ];
}

function definitionsBlock() {
  return [[], ["Metric definitions"], ["Metric", "Unit", "Kind", "Formula", "Source"], ...METRIC_DEFINITIONS.map((d) => [d.label, d.unit, d.kind, d.formula, d.source])];
}

export async function messExportCsv(principal, messId, filters) {
  const report = await messAnalytics(principal, messId, filters);
  const rows = [
    ...exportPreamble("Vote2Dine mess analytics", report, principal),
    MEAL_COLUMNS.map(([, h]) => h),
    ...report.meals.map((m) => MEAL_COLUMNS.map(([k]) => fmt(m[k]))),
    ...definitionsBlock(),
  ];
  return { filename: `v2d-${report.scope.messName.replace(/\W+/g, "-").toLowerCase()}-${filters.from}-${filters.to}.csv`, csv: toCsv(rows[0], rows.slice(1)) };
}

export async function institutionExportCsv(principal, filters) {
  const report = await institutionAnalytics(principal, filters);
  const cols = [
    ["name", "Mess"],
    ["meals", "Meals"],
    ["reconciledMeals", "Reconciled"],
    ["averageAttendance", "Avg attendance"],
    ["participationRate", "Participation %"],
    ["noShowRate", "No-show %"],
    ["meanAbsolutePercentError", "Forecast MAPE %"],
    ["forecastBias", "Forecast bias"],
    ["discardedFoodKg", "Discarded food kg"],
    ["wastePerServingG", "Waste g/serving"],
    ["wasteRate", "Waste rate %"],
    ["wasteCost", "Estimated waste cost"],
    ["wasteCompletenessRate", "Waste data completeness %"],
    ["baselineChangePercent", "Change vs baseline %"],
    ["avoidedWasteKg", "Avoided waste kg (estimate)"],
  ];
  const rows = [
    ...exportPreamble("Vote2Dine institution analytics", report, principal),
    ["Estimated avoided waste kg", fmt(report.impact.avoidedWasteKg)],
    ["Estimated savings", fmt(report.impact.estimatedSavings)],
    ["Method", report.impact.method],
    [],
    cols.map(([, h]) => h),
    ...report.messes.map((m) => cols.map(([k]) => fmt(m[k]))),
    ...definitionsBlock(),
  ];
  return { filename: `v2d-institution-${filters.from}-${filters.to}.csv`, csv: toCsv(rows[0], rows.slice(1)) };
}

export { METRIC_DEFINITIONS };
