import "../helpers/setup.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalQuantile, forecastAttendance, conservativeFallback } from "../../src/modules/forecasting/model.js";
import { mealMetrics, aggregate, baselineComparison } from "../../src/modules/analytics/metrics.js";
import { toBaseUnits, applyOrderConstraints, UnitError } from "../../src/lib/units.js";
import { parseCsv, parseCsvRecords, toCsv } from "../../src/lib/csv.js";
import { canTransition } from "../../src/domain/lifecycle.js";
import { classify } from "../../src/modules/reconciliation/reconciliation.service.js";
import { resolveSettings, DEFAULT_SETTINGS } from "../../src/domain/settings.js";
import { passwordProblems, generateOneTimeCode, normalizeOneTimeCode, hashPassword, verifyPassword } from "../../src/lib/security.js";
import { createPassToken, readPassToken, votingState } from "../../src/modules/votes/votes.service.js";

const priors = DEFAULT_SETTINGS.forecast.priors;
const noHistory = { slotCount: 0, yes: { total: 0, attended: 0 }, no: { total: 0, attended: 0 }, unvoted: { total: 0, attended: 0 } };

describe("forecast model", () => {
  it("normal quantile matches reference values", () => {
    assert.ok(Math.abs(normalQuantile(0.5)) < 1e-9);
    assert.ok(Math.abs(normalQuantile(0.975) - 1.959964) < 1e-5);
    assert.ok(Math.abs(normalQuantile(0.9) - 1.281552) < 1e-5);
    assert.ok(Math.abs(normalQuantile(0.01) + 2.326348) < 1e-5);
  });

  it("counts each student exactly once (groups partition the eligible set)", () => {
    const f = forecastAttendance({ eligible: 100, yes: 60, no: 30, unvoted: 10 }, noHistory, { serviceLevel: 0.9, priors });
    assert.equal(f.predictedAttendance, Math.round((60 * 0.9 + 30 * 0.03 + 10 * 0.4) * 100) / 100);
    assert.equal(f.method, "VOTE_RATES_PRIOR_ONLY");
    assert.ok(f.warnings.some((w) => w.code === "NO_HISTORY"));
  });

  it("does not treat non-responders as absent or YES voters as certain", () => {
    const f = forecastAttendance({ eligible: 10, yes: 0, no: 0, unvoted: 10 }, noHistory, { serviceLevel: 0.9, priors });
    assert.ok(f.predictedAttendance > 0, "unvoted students still have an attendance rate");
    const g = forecastAttendance({ eligible: 10, yes: 10, no: 0, unvoted: 0 }, noHistory, { serviceLevel: 0.5, priors });
    assert.ok(g.rates.yes < 1);
  });

  it("learns from history and shrinks toward the prior when data is thin", () => {
    const history = { slotCount: 20, yes: { total: 2000, attended: 1600 }, no: { total: 500, attended: 50 }, unvoted: { total: 300, attended: 60 } };
    const f = forecastAttendance({ eligible: 300, yes: 200, no: 60, unvoted: 40 }, history, { serviceLevel: 0.9, priors });
    assert.equal(f.method, "VOTE_RATES_WITH_HISTORY");
    assert.ok(Math.abs(f.rates.yes - 0.8) < 0.01, `yes rate ${f.rates.yes}`);
    assert.ok(Math.abs(f.rates.no - 0.1) < 0.01);
    const thin = { slotCount: 1, yes: { total: 5, attended: 0 }, no: { total: 0, attended: 0 }, unvoted: { total: 0, attended: 0 } };
    const t = forecastAttendance({ eligible: 10, yes: 10, no: 0, unvoted: 0 }, thin, { serviceLevel: 0.9, priors });
    assert.ok(t.rates.yes > 0.5, "five no-shows do not override a 20-observation prior");
  });

  it("recommends a buffer above the mean, capped at eligible students", () => {
    const f = forecastAttendance({ eligible: 50, yes: 40, no: 5, unvoted: 5 }, noHistory, { serviceLevel: 0.95, priors });
    assert.ok(f.recommendedServings >= Math.ceil(f.predictedAttendance));
    assert.ok(f.recommendedServings <= 50);
    assert.equal(f.safetyBufferServings, f.recommendedServings - Math.ceil(f.predictedAttendance));
    const tiny = forecastAttendance({ eligible: 2, yes: 2, no: 0, unvoted: 0 }, noHistory, { serviceLevel: 0.995, priors });
    assert.ok(tiny.recommendedServings <= 2);
  });

  it("the fallback is explicit and conservative", () => {
    const f = conservativeFallback({ eligible: 10, yes: 4, no: 3, unvoted: 3 }, "boom");
    assert.equal(f.method, "CONSERVATIVE_FALLBACK");
    assert.equal(f.recommendedServings, 7);
    assert.equal(f.warnings[0].code, "MODEL_FAILURE");
  });
});

describe("analytics metrics", () => {
  const base = {
    id: 1, service_date: "2026-10-01", status: "RECONCILED", iso_dow: 4, meal_type_code: "LUNCH", meal_type_name: "Lunch",
    eligible_count: 100, yes_count: 70, no_count: 20, unvoted_count: 10, approved_servings: 85, is_override: false,
    predicted_attendance: 80, reconciled: true, actual_attendance: 75, yes_attended: 65, yes_no_show: 5, no_walk_in: 2, unvoted_attended: 8,
    tasks_total: 2, tasks_done: 2, prepared_kg: 40, prepared_any_estimated: false,
    reusable_entries: 1, reusable_kg: 3, discarded_surplus_entries: 1, discarded_surplus_kg: 4, plate_entries: 1, plate_kg: 3.5, kitchen_entries: 0, kitchen_kg: null,
    waste_any_estimated: false, plan_cost: 2000, plan_cost_complete: true, issued_cost: null, issued_cost_complete: false,
  };

  it("computes per-meal metrics from records", () => {
    const m = mealMetrics(base);
    assert.equal(m.participationRate, 90);
    assert.equal(m.discardedFoodKg, 7.5);
    assert.equal(m.servedKg, 33);
    assert.equal(m.wastePerServingG, 100);
    assert.equal(m.wasteRate, 18.8);
    assert.equal(m.forecastError, 5);
    assert.equal(m.costBasis, "PLANNED_INGREDIENTS");
    assert.equal(m.costPerKg, 50);
    assert.equal(m.wasteCost, 375);
    assert.equal(m.kitchenWasteKg, null, "no kitchen-waste entry means unknown, not zero");
  });

  it("missing measurements stay missing", () => {
    const m = mealMetrics({ ...base, plate_entries: 0, plate_kg: null, tasks_done: 1 });
    assert.equal(m.discardedFoodKg, null);
    assert.equal(m.wastePerServingG, null);
    assert.equal(m.preparedKg, null, "prep not complete");
    assert.equal(m.wasteCost, null);
    assert.equal(m.quality.waste, "PARTIAL");
    const none = mealMetrics({ ...base, eligible_count: null, yes_count: null, no_count: null, unvoted_count: null });
    assert.equal(none.participationRate, null, "no snapshot is not 0 % participation");
  });

  it("an explicit 0 kg measurement is a real zero", () => {
    const m = mealMetrics({ ...base, discarded_surplus_kg: 0, plate_kg: 0 });
    assert.equal(m.discardedFoodKg, 0);
    assert.equal(m.wastePerServingG, 0);
  });

  it("aggregates use ratio of sums over meals where data exists", () => {
    const a = mealMetrics(base);
    const b = mealMetrics({ ...base, id: 2, actual_attendance: 25, discarded_surplus_kg: 1, plate_kg: 1.5 });
    const c = mealMetrics({ ...base, id: 3, plate_entries: 0, plate_kg: null });
    const agg = aggregate([a, b, c], { co2eFactor: 2.5 });
    assert.equal(agg.discardedFoodKg.value, 10);
    assert.equal(agg.discardedFoodKg.meals, 2);
    assert.equal(agg.wastePerServingG.value, 100); // 10 kg / 100 diners, not mean(100 g, 100 g)
    assert.equal(agg.co2eKg.value, 25);
    assert.equal(agg.completeness.wasteMissing, 0);
    assert.equal(agg.completeness.wastePartial, 1);
  });

  it("baseline comparison reports change and labels it non-causal", () => {
    const agg = aggregate([mealMetrics(base)]);
    const cmp = baselineComparison({ discarded_g_per_serving: 125, label: "x", period_start: "a", period_end: "b", basis: "MEASURED", source_note: "s" }, agg);
    assert.equal(cmp.changePercent, 20);
    assert.equal(cmp.avoidedWasteKg, 1.9); // 25 g × 75 servings
    assert.match(cmp.interpretation, /not proof/);
    assert.equal(baselineComparison(null, agg).available, false);
  });
});

describe("units", () => {
  it("converts within a dimension", () => {
    assert.equal(toBaseUnits(250, "g", "MASS"), 0.25);
    assert.equal(toBaseUnits(15, "ml", "VOLUME"), 0.015);
    assert.equal(toBaseUnits(2, "dozen", "COUNT"), 24);
  });
  it("refuses cross-dimension conversions", () => {
    assert.throws(() => toBaseUnits(1, "g", "VOLUME"), UnitError);
    assert.throws(() => toBaseUnits(1, "l", "MASS"), UnitError);
    assert.throws(() => toBaseUnits(1, "cup", "VOLUME"), UnitError);
    assert.throws(() => toBaseUnits(-1, "kg", "MASS"), UnitError);
  });
  it("rounds procurement to packs and minimum orders", () => {
    assert.equal(applyOrderConstraints(0, { packSize: 25 }), 0);
    assert.equal(applyOrderConstraints(26, { packSize: 25 }), 50);
    assert.equal(applyOrderConstraints(3, { minOrder: 10 }), 10);
    assert.equal(applyOrderConstraints(50, { packSize: 25 }), 50);
  });
});

describe("csv", () => {
  it("parses quoted fields and embedded commas/newlines", () => {
    const rows = parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n');
    assert.deepEqual(rows, [["a", "b"], ["x, y", 'say "hi"\nthere']]);
    const { headers, records } = parseCsvRecords("Roll Number,Full Name\nR1,Asha\n\n");
    assert.deepEqual(headers, ["roll_number", "full_name"]);
    assert.equal(records.length, 1);
  });
  it("neutralises spreadsheet formulas on export", () => {
    assert.equal(toCsv(["h"], [["=HYPERLINK(1)"]]), "h\r\n'=HYPERLINK(1)");
    assert.equal(toCsv(["h"], [[-5]]), "h\r\n-5", "negative numbers are not formulas");
  });
});

describe("lifecycle and classification", () => {
  it("allows only the documented transitions", () => {
    assert.ok(canTransition("DRAFT", "OPEN"));
    assert.ok(canTransition("OPEN", "LOCKED"));
    assert.ok(canTransition("APPROVED", "IN_SERVICE"));
    assert.ok(!canTransition("OPEN", "APPROVED"));
    assert.ok(!canTransition("IN_SERVICE", "CANCELLED"), "a meal being served cannot be cancelled");
    assert.ok(!canTransition("RECONCILED", "SERVICE_CLOSED"));
    assert.ok(!canTransition("CANCELLED", "OPEN"));
  });
  it("classifies every intent × attendance combination", () => {
    assert.equal(classify("YES", true), "YES_ATTENDED");
    assert.equal(classify("YES", false), "YES_NO_SHOW");
    assert.equal(classify("YES", false, true), "EXCUSED");
    assert.equal(classify("NO", true), "NO_WALK_IN");
    assert.equal(classify("NO", false), "NO_ABSENT");
    assert.equal(classify("UNVOTED", true), "UNVOTED_ATTENDED");
    assert.equal(classify("UNVOTED", false), "UNVOTED_ABSENT");
  });
  it("voting state follows the server clock", () => {
    const slot = { status: "OPEN", voting_opens_at: new Date("2026-01-01T00:00:00Z"), voting_closes_at: new Date("2026-01-02T00:00:00Z") };
    assert.equal(votingState(slot, new Date("2025-12-31T23:59:59Z")), "NOT_YET_OPEN");
    assert.equal(votingState(slot, new Date("2026-01-01T12:00:00Z")), "OPEN");
    assert.equal(votingState(slot, new Date("2026-01-02T00:00:00Z")), "CLOSED", "the cutoff instant itself is closed");
  });
});

describe("security helpers", () => {
  it("hashes and verifies passwords", async () => {
    const h = await hashPassword("a-perfectly-fine-password");
    assert.match(h, /^scrypt\$/);
    assert.ok(await verifyPassword("a-perfectly-fine-password", h));
    assert.ok(!(await verifyPassword("a-perfectly-fine-passworD", h)));
    assert.ok(!(await verifyPassword("x", null)));
  });
  it("enforces the password policy", () => {
    assert.ok(passwordProblems("short").length);
    assert.ok(passwordProblems("aaaaaaaaaaaa").length);
    assert.ok(passwordProblems("asha2026-password", { username: "asha2026" }).length);
    assert.equal(passwordProblems("tea-leaves-in-monsoon").length, 0);
  });
  it("one-time codes are typeable and normalise", () => {
    const code = generateOneTimeCode();
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(normalizeOneTimeCode(code.toLowerCase().replace(/-/g, " ")), code.replace(/-/g, ""));
  });
  it("meal passes are signed, slot-bound and expire", () => {
    const exp = new Date(Date.now() + 60_000);
    const t = createPassToken(7, 42, exp);
    assert.deepEqual(readPassToken(t), { slotId: 7, userId: 42 });
    assert.equal(readPassToken(t.replace(".7.", ".8.")), null, "tampered slot id");
    assert.equal(readPassToken(t, new Date(Date.now() + 120_000)), null, "expired");
    assert.equal(readPassToken("garbage"), null);
  });
});

describe("settings", () => {
  it("merges stored overrides over documented defaults", () => {
    const s = resolveSettings({ walkIn: { noVoter: "ALLOW" } });
    assert.equal(s.walkIn.noVoter, "ALLOW");
    assert.equal(s.walkIn.unvoted, DEFAULT_SETTINGS.walkIn.unvoted);
    assert.equal(s.forecast.serviceLevel, 0.9);
  });
  it("falls back to defaults when stored settings are invalid", () => {
    assert.deepEqual(resolveSettings({ forecast: { serviceLevel: 7 } }), resolveSettings({}));
  });
});
