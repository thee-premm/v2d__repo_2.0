/**
 * Shared metric definitions and calculations for Analyze (supervisor and
 * institution views use the same functions, so totals always agree).
 *
 * Rules:
 *  - Missing data is `null`, never 0. A metric that needs a missing input is null.
 *  - Rates over many meals are ratios of sums (Σ numerator / Σ denominator)
 *    over meals where both are known — not averages of per-meal ratios.
 *  - Every metric declares its kind:
 *      MEASURED    counted/weighed records
 *      MANUAL      a person's decision or entry (e.g. approved target)
 *      ESTIMATE    model output or a conversion using assumed factors
 *      DERIVED     arithmetic on the above (inherits their limitations)
 */
export const METRIC_DEFINITIONS = Object.freeze([
  { id: "eligible", label: "Eligible at cutoff", unit: "students", kind: "MEASURED", source: "Vote snapshot (cutoff_aggregates)", formula: "Students with a valid mess membership on the service date when voting closed" },
  { id: "participationRate", label: "Voting participation", unit: "%", kind: "MEASURED", source: "cutoff_aggregates", formula: "(YES + NO) ÷ eligible at cutoff" },
  { id: "nonResponseRate", label: "Non-response", unit: "%", kind: "MEASURED", source: "cutoff_aggregates", formula: "UNVOTED ÷ eligible at cutoff" },
  { id: "actualAttendance", label: "Actual attendance", unit: "students", kind: "MEASURED", source: "Reconciled outcomes (counter verifications after corrections)", formula: "Students recorded as attended at reconciliation" },
  { id: "yesShowRate", label: "YES voters who attended", unit: "%", kind: "MEASURED", source: "attendance_outcomes", formula: "YES_ATTENDED ÷ YES voters" },
  { id: "noShowRate", label: "No-show rate", unit: "%", kind: "MEASURED", source: "attendance_outcomes", formula: "YES_NO_SHOW ÷ YES voters (excused cases excluded from numerator)" },
  { id: "walkInShare", label: "Walk-in share", unit: "%", kind: "MEASURED", source: "attendance_outcomes", formula: "(NO_WALK_IN + UNVOTED_ATTENDED) ÷ actual attendance" },
  { id: "predictedAttendance", label: "Predicted attendance", unit: "students", kind: "ESTIMATE", source: "Forecast used by the approved plan", formula: "Σ group size × group attendance rate (see forecast method)" },
  { id: "forecastError", label: "Forecast error", unit: "students", kind: "DERIVED", source: "Forecast vs reconciliation", formula: "predicted − actual (positive = over-prediction)" },
  { id: "meanAbsoluteError", label: "Mean absolute error", unit: "students", kind: "DERIVED", source: "Reconciled meals with a forecast", formula: "mean(|predicted − actual|)" },
  { id: "meanAbsolutePercentError", label: "Mean absolute % error", unit: "%", kind: "DERIVED", source: "Reconciled meals with a forecast and attendance > 0", formula: "mean(|predicted − actual| ÷ actual)" },
  { id: "forecastBias", label: "Forecast bias", unit: "students", kind: "DERIVED", source: "Reconciled meals with a forecast", formula: "mean(predicted − actual)" },
  { id: "approvedServings", label: "Approved servings", unit: "servings", kind: "MANUAL", source: "Supervisor-approved preparation plan", formula: "Target approved before cooking" },
  { id: "targetExcess", label: "Target above attendance", unit: "servings", kind: "DERIVED", source: "Plan vs reconciliation", formula: "approved servings − actual attendance" },
  { id: "preparedKg", label: "Food prepared", unit: "kg", kind: "MEASURED", source: "Kitchen preparation records", formula: "Σ prepared weight of every dish (only when every dish is recorded)" },
  { id: "reusableSurplusKg", label: "Reusable surplus", unit: "kg", kind: "MEASURED", source: "Food log: REUSABLE_SURPLUS", formula: "Σ entries" },
  { id: "discardedSurplusKg", label: "Discarded leftovers", unit: "kg", kind: "MEASURED", source: "Food log: DISCARDED_SURPLUS", formula: "Σ entries" },
  { id: "plateWasteKg", label: "Plate waste", unit: "kg", kind: "MEASURED", source: "Food log: PLATE_WASTE", formula: "Σ entries" },
  { id: "kitchenWasteKg", label: "Kitchen (prep) waste", unit: "kg", kind: "MEASURED", source: "Food log: KITCHEN_WASTE", formula: "Σ entries; reported separately, not in discarded food" },
  { id: "discardedFoodKg", label: "Discarded food", unit: "kg", kind: "MEASURED", source: "Food log", formula: "discarded leftovers + plate waste (requires both to be recorded)" },
  { id: "servedKg", label: "Food served", unit: "kg", kind: "DERIVED", source: "Preparation + food log", formula: "prepared − reusable surplus − discarded leftovers" },
  { id: "wastePerServingG", label: "Waste per serving", unit: "g", kind: "DERIVED", source: "Food log + reconciliation", formula: "discarded food × 1000 ÷ actual attendance" },
  { id: "wasteRate", label: "Waste rate", unit: "%", kind: "DERIVED", source: "Food log + preparation", formula: "discarded food ÷ prepared" },
  { id: "costPerKg", label: "Food cost per kg", unit: "currency/kg", kind: "ESTIMATE", source: "Issued ingredients, else planned ingredients, else configured rate", formula: "ingredient cost ÷ prepared kg" },
  { id: "wasteCost", label: "Estimated cost of discarded food", unit: "currency", kind: "ESTIMATE", source: "Discarded food × cost per kg", formula: "discarded food × cost per kg" },
  { id: "co2e", label: "Emissions of discarded food", unit: "kg CO2e", kind: "ESTIMATE", source: "Configured conversion factor", formula: "discarded food × kg CO2e per kg" },
  { id: "baselineChange", label: "Change vs baseline", unit: "%", kind: "DERIVED", source: "Admin-entered baseline + measured waste per serving", formula: "(baseline g/serving − observed g/serving) ÷ baseline g/serving. Describes change, not cause." },
  { id: "avoidedWasteKg", label: "Waste avoided vs baseline", unit: "kg", kind: "ESTIMATE", source: "Baseline + measured waste", formula: "(baseline − observed) g/serving × servings ÷ 1000 — assumes the baseline rate would otherwise have applied" },
  { id: "procurementVariance", label: "Ingredient use vs plan", unit: "%", kind: "DERIVED", source: "Inventory issues linked to meals vs frozen plan requirements", formula: "(issued − planned) ÷ planned" },
  { id: "measurementCompleteness", label: "Waste measurement completeness", unit: "%", kind: "MEASURED", source: "Closed meals", formula: "closed meals with discarded food recorded ÷ closed meals" },
]);

const n = (v) => (v === null || v === undefined ? null : Number(v));
const div = (a, b) => (a === null || b === null || b === 0 ? null : a / b);
const r = (v, d = 2) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
// Null-safe percentage: a missing numerator or denominator stays missing (never 0 %).
const pct = (a, b, d = 1) => {
  const v = div(a, b);
  return v === null ? null : r(v * 100, d);
};

/** Per-meal metrics from one fact row (see analytics.service factsQuery). */
export function mealMetrics(f, { configuredCostPerKg = null } = {}) {
  const eligible = n(f.eligible_count);
  const yes = n(f.yes_count);
  const no = n(f.no_count);
  const unvoted = n(f.unvoted_count);
  const attendance = f.reconciled ? n(f.actual_attendance) : null;
  const predicted = n(f.predicted_attendance);

  const tasksTotal = n(f.tasks_total) ?? 0;
  const preparedKg = tasksTotal > 0 && n(f.tasks_done) === tasksTotal ? n(f.prepared_kg) : null;
  const cat = (key) => (n(f[`${key}_entries`]) > 0 ? n(f[`${key}_kg`]) : null);
  const reusable = cat("reusable");
  const discardedSurplus = cat("discarded_surplus");
  const plate = cat("plate");
  const kitchen = cat("kitchen");
  const discarded = discardedSurplus !== null && plate !== null ? discardedSurplus + plate : null;
  const served = preparedKg !== null && reusable !== null && discardedSurplus !== null ? preparedKg - reusable - discardedSurplus : null;

  let costPerKg = null;
  let costBasis = null;
  if (f.issued_cost_complete && n(f.issued_cost) > 0 && preparedKg) {
    costPerKg = n(f.issued_cost) / preparedKg;
    costBasis = "ISSUED_INGREDIENTS";
  } else if (f.plan_cost_complete && n(f.plan_cost) > 0 && preparedKg) {
    costPerKg = n(f.plan_cost) / preparedKg;
    costBasis = "PLANNED_INGREDIENTS";
  } else if (configuredCostPerKg !== null) {
    costPerKg = configuredCostPerKg;
    costBasis = "CONFIGURED_RATE";
  }

  const wasteRecorded = discardedSurplus !== null || plate !== null;
  return {
    slotId: Number(f.id),
    serviceDate: f.service_date,
    mealType: f.meal_type_code,
    mealTypeName: f.meal_type_name,
    dayOfWeek: n(f.iso_dow),
    status: f.status,
    eligible,
    yes,
    no,
    unvoted,
    participationRate: pct(yes !== null ? yes + no : null, eligible),
    nonResponseRate: pct(unvoted, eligible),
    predictedAttendance: predicted,
    forecastMethod: f.forecast_method,
    approvedServings: n(f.approved_servings),
    planOverride: f.is_override,
    actualAttendance: attendance,
    yesAttended: f.reconciled ? n(f.yes_attended) : null,
    yesNoShow: f.reconciled ? n(f.yes_no_show) : null,
    walkIns: f.reconciled ? n(f.no_walk_in) + n(f.unvoted_attended) : null,
    forecastError: predicted !== null && attendance !== null ? r(predicted - attendance) : null,
    targetExcess: n(f.approved_servings) !== null && attendance !== null ? n(f.approved_servings) - attendance : null,
    preparedKg: r(preparedKg, 3),
    reusableSurplusKg: r(reusable, 3),
    discardedSurplusKg: r(discardedSurplus, 3),
    plateWasteKg: r(plate, 3),
    kitchenWasteKg: r(kitchen, 3),
    discardedFoodKg: r(discarded, 3),
    servedKg: r(served, 3),
    wastePerServingG: discarded !== null && attendance ? r((discarded * 1000) / attendance, 1) : null,
    wasteRate: discarded !== null && preparedKg ? r((discarded / preparedKg) * 100, 1) : null,
    costPerKg: r(costPerKg),
    costBasis,
    wasteCost: discarded !== null && costPerKg !== null ? r(discarded * costPerKg) : null,
    quality: {
      reconciled: Boolean(f.reconciled),
      prepared: preparedKg === null ? "MISSING" : f.prepared_any_estimated ? "ESTIMATED" : "MEASURED",
      waste: discarded !== null ? (f.waste_any_estimated ? "ESTIMATED" : "MEASURED") : wasteRecorded ? "PARTIAL" : "MISSING",
    },
  };
}

/** Sum of a field over meals where it is known. Returns { value, meals } or value null when no meal has it. */
function sumKnown(meals, key) {
  const known = meals.filter((m) => m[key] !== null);
  return { value: known.length ? r(known.reduce((s, m) => s + m[key], 0), 3) : null, meals: known.length };
}

/** Ratio of sums over meals where both numerator and denominator are known. */
function ratioOfSums(meals, numKey, denKey, scale = 1) {
  const both = meals.filter((m) => m[numKey] !== null && m[denKey] !== null && m[denKey] > 0);
  if (!both.length) return { value: null, meals: 0, numerator: null, denominator: null };
  const num = both.reduce((s, m) => s + m[numKey], 0);
  const den = both.reduce((s, m) => s + m[denKey], 0);
  return { value: r((num / den) * scale, 2), meals: both.length, numerator: r(num, 3), denominator: r(den, 3) };
}

/** Aggregate a set of meals into the KPI block shown in Analyze. */
export function aggregate(meals, { co2eFactor = null } = {}) {
  const closed = meals.filter((m) => ["SERVICE_CLOSED", "RECONCILED"].includes(m.status));
  const reconciled = meals.filter((m) => m.quality.reconciled);
  const forecasted = reconciled.filter((m) => m.forecastError !== null);
  const withActual = forecasted.filter((m) => m.actualAttendance > 0);
  const voting = meals.filter((m) => m.eligible !== null);
  const eligibleSum = voting.reduce((s, m) => s + m.eligible, 0);
  const discarded = sumKnown(closed, "discardedFoodKg");
  const wasteCost = sumKnown(closed, "wasteCost");
  const yesSum = reconciled.reduce((s, m) => s + (m.yes ?? 0), 0);
  const attendanceSum = reconciled.reduce((s, m) => s + (m.actualAttendance ?? 0), 0);
  return {
    meals: meals.length,
    closedMeals: closed.length,
    reconciledMeals: reconciled.length,
    participationRate: eligibleSum ? r((voting.reduce((s, m) => s + m.yes + m.no, 0) / eligibleSum) * 100, 1) : null,
    nonResponseRate: eligibleSum ? r((voting.reduce((s, m) => s + m.unvoted, 0) / eligibleSum) * 100, 1) : null,
    actualAttendance: reconciled.length ? attendanceSum : null,
    averageAttendance: reconciled.length ? r(attendanceSum / reconciled.length, 1) : null,
    yesShowRate: yesSum ? r((reconciled.reduce((s, m) => s + (m.yesAttended ?? 0), 0) / yesSum) * 100, 1) : null,
    noShowRate: yesSum ? r((reconciled.reduce((s, m) => s + (m.yesNoShow ?? 0), 0) / yesSum) * 100, 1) : null,
    walkInShare: attendanceSum ? r((reconciled.reduce((s, m) => s + (m.walkIns ?? 0), 0) / attendanceSum) * 100, 1) : null,
    forecast: {
      meals: forecasted.length,
      meanAbsoluteError: forecasted.length ? r(forecasted.reduce((s, m) => s + Math.abs(m.forecastError), 0) / forecasted.length) : null,
      forecastBias: forecasted.length ? r(forecasted.reduce((s, m) => s + m.forecastError, 0) / forecasted.length) : null,
      meanAbsolutePercentError: withActual.length ? r((withActual.reduce((s, m) => s + Math.abs(m.forecastError) / m.actualAttendance, 0) / withActual.length) * 100, 1) : null,
    },
    targetExcess: sumKnown(reconciled, "targetExcess"),
    shortfallMeals: reconciled.filter((m) => m.targetExcess !== null && m.targetExcess < 0).length,
    preparedKg: sumKnown(closed, "preparedKg"),
    reusableSurplusKg: sumKnown(closed, "reusableSurplusKg"),
    discardedSurplusKg: sumKnown(closed, "discardedSurplusKg"),
    plateWasteKg: sumKnown(closed, "plateWasteKg"),
    kitchenWasteKg: sumKnown(closed, "kitchenWasteKg"),
    discardedFoodKg: discarded,
    servedKg: sumKnown(closed, "servedKg"),
    wastePerServingG: ratioOfSums(closed, "discardedFoodKg", "actualAttendance", 1000),
    wasteRate: ratioOfSums(closed, "discardedFoodKg", "preparedKg", 100),
    wasteCost,
    co2eKg: discarded.value !== null && co2eFactor !== null ? { value: r(discarded.value * co2eFactor, 1), meals: discarded.meals } : { value: null, meals: 0 },
    completeness: {
      closedMeals: closed.length,
      wasteMeasured: closed.filter((m) => m.quality.waste === "MEASURED").length,
      wasteEstimated: closed.filter((m) => m.quality.waste === "ESTIMATED").length,
      wastePartial: closed.filter((m) => m.quality.waste === "PARTIAL").length,
      wasteMissing: closed.filter((m) => m.quality.waste === "MISSING").length,
      preparedRecorded: closed.filter((m) => m.quality.prepared !== "MISSING").length,
      reconciled: closed.filter((m) => m.quality.reconciled).length,
      wasteCompletenessRate: closed.length ? r((closed.filter((m) => m.discardedFoodKg !== null).length / closed.length) * 100, 1) : null,
    },
  };
}

/** Compare observed waste per serving against a documented baseline. */
export function baselineComparison(baseline, agg) {
  if (!baseline) return { available: false, reason: "NO_BASELINE" };
  const observed = agg.wastePerServingG.value;
  if (observed === null) return { available: false, reason: "NO_MEASURED_WASTE", baseline };
  const base = Number(baseline.discarded_g_per_serving);
  // Servings (attendance) over exactly the meals used for the observed rate.
  const servings = agg.wastePerServingG.denominator;
  const change = base > 0 ? ((base - observed) / base) * 100 : null;
  return {
    available: true,
    baseline: {
      label: baseline.label,
      periodStart: baseline.period_start,
      periodEnd: baseline.period_end,
      gPerServing: base,
      basis: baseline.basis,
      sourceNote: baseline.source_note,
    },
    observedGPerServing: observed,
    changePercent: r(change, 1),
    avoidedWasteKg: servings !== null ? r(((base - observed) * servings) / 1000, 1) : null,
    interpretation:
      "Observed change compared with the baseline period. It is not proof that Vote2Dine caused the change: menus, enrolment and season also differ.",
  };
}

export { ratioOfSums, sumKnown };
