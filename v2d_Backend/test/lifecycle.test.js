import "./helpers/setup.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers/server.js";
import { createWorld, DEFAULT_PASSWORD } from "./helpers/fixtures.js";
import { localDate, instantOf, advanceTo } from "./helpers/time.js";
import { pool } from "../src/config/db.js";
import { runSchedulerTick } from "../src/jobs/scheduler.js";

/**
 * The complete Vote2Dine operational loop, through the real HTTP API:
 * provision → schedule → vote → change vote → cutoff → forecast → approve →
 * prepare → verify → close → reconcile → appeal → analyze, plus the
 * authorization boundaries along the way.
 */
let srv;
let w;
const api = {};
let slotId;
let newStudent;
const serviceDate = () => state.serviceDate;
const state = {};

async function signIn(name, username, role) {
  const c = srv.client();
  const res = await c.login(username, DEFAULT_PASSWORD, role);
  assert.equal(res.status, 200, `${name} could not sign in: ${JSON.stringify(res.body)}`);
  api[name] = c;
  return c;
}

/** Sessions expire when the test clock jumps; sign everyone in again. */
async function signInAll() {
  await signIn("admin", w.admin.username);
  await signIn("supA", w.supervisorA.username);
  await signIn("supB", w.supervisorB.username);
  await signIn("kitchen", w.kitchenA.username);
  for (const [i, s] of w.studentsA.entries()) await signIn(`s${i}`, s.username);
  await signIn("sB", w.studentB.username);
  if (newStudent) {
    const c = srv.client();
    await c.login(newStudent.username, newStudent.password);
    api.newStudent = c;
  }
}

before(async () => {
  srv = await startTestServer();
  w = await createWorld({ students: 5 });
  state.serviceDate = localDate(1);
  await signInAll();
});
after(() => srv.stop());

describe("1. onboarding", () => {
  it("admin provisions a student who activates with a one-time code", async () => {
    const res = await api.admin.post("/api/v1/admin/users", {
      fullName: "Asha Verma",
      student: { rollNumber: "new2026x01", messId: w.messA },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.user.username, "new2026x01");
    assert.equal(res.body.data.user.status, "INVITED");
    const code = res.body.data.activation.code;

    const c = srv.client();
    const act = await c.post("/api/v1/auth/activate", { identifier: "new2026x01", code, password: "asha-strong-password" });
    assert.equal(act.status, 200);
    newStudent = { username: "new2026x01", password: "asha-strong-password" };
    assert.equal((await c.login(newStudent.username, newStudent.password)).status, 200);
    api.newStudent = c;
  });

  it("a supervisor cannot provision accounts", async () => {
    const res = await api.supA.post("/api/v1/admin/users", { fullName: "Sneaky", roles: [{ role: "INSTITUTION_ADMIN" }] });
    assert.equal(res.status, 403);
  });
});

describe("2. catalogue and scheduling", () => {
  it("supervisor builds dishes with unit-checked recipes", async () => {
    const rice = await api.supA.post("/api/v1/catalog/ingredients", { name: "Rice", dimension: "MASS", costPerBaseUnit: 50 });
    const dal = await api.supA.post("/api/v1/catalog/ingredients", { name: "Toor dal", dimension: "MASS", costPerBaseUnit: 120 });
    const oil = await api.supA.post("/api/v1/catalog/ingredients", { name: "Oil", dimension: "VOLUME", costPerBaseUnit: 150 });
    assert.equal(rice.status, 201);
    state.ing = { rice: rice.body.data.id, dal: dal.body.data.id, oil: oil.body.data.id };

    const riceDish = await api.supA.post("/api/v1/catalog/dishes", { name: "Steamed rice", category: "RICE", isVegetarian: true, portionGrams: 250 });
    const dalDish = await api.supA.post("/api/v1/catalog/dishes", { name: "Dal tadka", category: "MAIN", isVegetarian: true, portionGrams: 200 });
    state.dish = { rice: riceDish.body.data.id, dal: dalDish.body.data.id };

    const bad = await api.supA.put(`/api/v1/catalog/dishes/${state.dish.dal}/ingredients`, {
      ingredients: [{ ingredientId: state.ing.dal, quantity: 50, unit: "ml" }],
    });
    assert.equal(bad.status, 400, "grams-of-dal measured in ml must be rejected");

    const ok1 = await api.supA.put(`/api/v1/catalog/dishes/${state.dish.rice}/ingredients`, { ingredients: [{ ingredientId: state.ing.rice, quantity: 120, unit: "g" }] });
    const ok2 = await api.supA.put(`/api/v1/catalog/dishes/${state.dish.dal}/ingredients`, {
      ingredients: [
        { ingredientId: state.ing.dal, quantity: 50, unit: "g", yieldFactor: 0.95 },
        { ingredientId: state.ing.oil, quantity: 10, unit: "ml" },
      ],
    });
    assert.equal(ok1.status, 200);
    assert.equal(ok2.status, 200);
    assert.equal(ok1.body.data.ingredients[0].quantityPerServing, 0.12);
  });

  it("supervisor creates and publishes a lunch with a menu", async () => {
    const res = await api.supA.post(`/api/v1/messes/${w.messA}/slots`, {
      mealTypeId: w.mealTypes.LUNCH,
      serviceDate: serviceDate(),
      serviceStart: "12:30",
      serviceEnd: "14:30",
      votingOpensAt: `${localDate(0)}T00:00`,
      votingClosesAt: `${serviceDate()}T10:30`,
      menu: [{ dishId: state.dish.rice }, { dishId: state.dish.dal, uptakeFraction: 0.9 }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    slotId = res.body.data.id;
    assert.equal(res.body.data.status, "DRAFT");

    const dup = await api.supA.post(`/api/v1/messes/${w.messA}/slots`, { mealTypeId: w.mealTypes.LUNCH, serviceDate: serviceDate() });
    assert.equal(dup.status, 422);
    assert.equal(dup.body.error.code, "SLOT_EXISTS");

    const pub = await api.supA.post(`/api/v1/slots/${slotId}/publish`);
    assert.equal(pub.status, 200);
    assert.equal(pub.body.data.status, "OPEN");
  });

  it("students cannot see drafts or other messes; other supervisors cannot reach this slot", async () => {
    assert.equal((await api.supB.get(`/api/v1/slots/${slotId}`)).status, 404, "supervisor of another mess");
    assert.equal((await api.supB.post(`/api/v1/slots/${slotId}/cancel`, { reason: "hostile cancel" })).status, 404);
    assert.equal((await api.kitchen.post(`/api/v1/slots/${slotId}/cancel`, { reason: "kitchen cancel" })).status, 404, "kitchen cannot run lifecycle");
    assert.equal((await api.s0.get(`/api/v1/slots/${slotId}`)).status, 403, "students have no operations API");
    const bMeals = await api.sB.get("/api/v1/me/meals");
    assert.ok(!bMeals.body.data.meals.some((m) => m.id === slotId));
  });
});

describe("3. voting", () => {
  it("records, changes and de-duplicates votes before the cutoff", async () => {
    const cast = (c, intent) => c.put(`/api/v1/me/meals/${slotId}/vote`, { intent });
    assert.equal((await cast(api.s0, "YES")).status, 200);
    assert.equal((await cast(api.s1, "YES")).status, 200);
    const changed = await cast(api.s1, "NO");
    assert.equal(changed.body.data.intent, "NO");
    assert.equal(changed.body.data.changeCount, 1);
    const repeat = await cast(api.s1, "NO");
    assert.equal(repeat.body.data.changed, false, "same intent twice is a no-op");
    await cast(api.s2, "NO");
    await cast(api.s3, "YES");
    await cast(api.newStudent, "YES");
    // s4 never votes: UNVOTED, not NO.

    const meals = await api.s1.get("/api/v1/me/meals");
    const m = meals.body.data.meals.find((x) => x.id === slotId);
    assert.equal(m.myVote, "NO");
    assert.equal(m.votingState, "OPEN");
    assert.equal(m.menu.length, 2);

    const live = await api.supA.get(`/api/v1/slots/${slotId}`);
    assert.deepEqual(
      { source: live.body.data.votes.source, eligible: live.body.data.votes.eligible, yes: live.body.data.votes.yes, no: live.body.data.votes.no, unvoted: live.body.data.votes.unvoted },
      { source: "LIVE", eligible: 6, yes: 3, no: 2, unvoted: 1 },
    );
  });

  it("rejects votes from students outside the mess", async () => {
    const res = await api.sB.put(`/api/v1/me/meals/${slotId}/vote`, { intent: "YES" });
    assert.equal(res.status, 404);
    const staff = await api.supA.put(`/api/v1/me/meals/${slotId}/vote`, { intent: "YES" });
    assert.equal(staff.status, 403);
  });

  it("rejects votes after the cutoff and locks a stable snapshot", async () => {
    const closes = await instantOf(serviceDate(), "10:30");
    advanceTo(closes, 1);
    await signInAll();
    const late = await api.s4.put(`/api/v1/me/meals/${slotId}/vote`, { intent: "YES" });
    assert.equal(late.status, 422);
    assert.equal(late.body.error.code, "VOTING_CLOSED");

    const tick = await runSchedulerTick();
    assert.equal(tick.locked, 1, JSON.stringify(tick));
    assert.equal((await runSchedulerTick()).locked, 0, "cutoff processing is idempotent");

    const d = (await api.supA.get(`/api/v1/slots/${slotId}`)).body.data;
    assert.equal(d.status, "FORECAST_READY");
    assert.deepEqual({ ...d.votes, lockedAt: undefined }, { source: "CUTOFF_SNAPSHOT", eligible: 6, yes: 3, no: 2, unvoted: 1, lockedAt: undefined });

    await assert.rejects(pool.query(`UPDATE vote_snapshots SET intent = 'YES' WHERE meal_slot_id = $1`, [slotId]), /append-only/);
    const manual = await api.supA.post(`/api/v1/slots/${slotId}/lock`);
    assert.equal(manual.status, 200, "manual lock after automatic lock is a no-op");
  });
});

describe("4. forecast and approval", () => {
  it("produces an explainable forecast that labels its lack of history", async () => {
    const d = (await api.supA.get(`/api/v1/slots/${slotId}`)).body.data;
    const f = d.forecast;
    assert.equal(f.method, "VOTE_RATES_PRIOR_ONLY");
    assert.equal(f.historySlotCount, 0);
    assert.ok(f.warnings.some((x) => x.code === "NO_HISTORY"));
    // 3 YES × 0.9 + 2 NO × 0.03 + 1 UNVOTED × 0.4
    assert.equal(f.predictedAttendance, 3.16);
    assert.ok(f.recommendedServings >= 4 && f.recommendedServings <= 6);
    assert.match(f.inputs.explanation, /3 YES/);
  });

  it("requires a reason to override and blocks kitchen staff from approving", async () => {
    assert.equal((await api.kitchen.post(`/api/v1/slots/${slotId}/approve`, { servings: 5, reason: "kitchen wants more" })).status, 404);
    const f = (await api.supA.get(`/api/v1/slots/${slotId}`)).body.data.forecast;
    const override = f.recommendedServings === 5 ? 6 : 5;
    state.approved = override;
    const noReason = await api.supA.post(`/api/v1/slots/${slotId}/approve`, { servings: override });
    assert.equal(noReason.status, 400);
    const ok = await api.supA.post(`/api/v1/slots/${slotId}/approve`, { servings: override, reason: "Guests from the sports meet" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.status, "APPROVED");
    assert.equal(ok.body.data.plan.isOverride, true);

    const req = (await api.kitchen.get(`/api/v1/slots/${slotId}/requirements`)).body.data;
    assert.equal(req.basis, "APPROVED_PLAN");
    const rice = req.ingredients.find((i) => i.name === "Rice");
    assert.equal(rice.required, Math.round(override * 0.12 * 1000) / 1000);
    const dal = req.ingredients.find((i) => i.name === "Toor dal");
    assert.equal(dal.required, Math.round((Math.ceil(override * 0.9) * 0.05) / 0.95 * 1000) / 1000);
  });
});

describe("5. kitchen", () => {
  it("shows the approved target on the board and records preparation", async () => {
    const board = (await api.kitchen.get(`/api/v1/kitchen/board?messId=${w.messA}&date=${serviceDate()}`)).body.data;
    const meal = board.meals.find((m) => m.id === slotId);
    assert.equal(meal.approvedServings, state.approved);
    const view = (await api.kitchen.get(`/api/v1/slots/${slotId}/kitchen`)).body.data;
    assert.equal(view.tasks.length, 2);
    state.prepared = 0;
    for (const t of view.tasks) {
      assert.equal((await api.kitchen.post(`/api/v1/prep-tasks/${t.id}/start`)).status, 200);
      const kg = t.expectedKg;
      const done = await api.kitchen.post(`/api/v1/prep-tasks/${t.id}/complete`, { preparedQuantity: kg, unit: "kg", measurement: "MEASURED" });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      state.prepared += kg;
    }
    const implausible = await api.kitchen.post(`/api/v1/prep-tasks/${view.tasks[0].id}/complete`, { preparedQuantity: 500, unit: "kg", measurement: "MEASURED" });
    assert.equal(implausible.status, 400, "a 100× deviation needs an explanation");
  });

  it("the kitchen cannot see student-level attendance", async () => {
    assert.equal((await api.kitchen.get(`/api/v1/slots/${slotId}/attendance`)).status, 404);
    assert.equal((await api.kitchen.get(`/api/v1/messes/${w.messA}/warnings`)).status, 404);
  });
});

describe("6. counter verification", () => {
  it("refuses verification before service starts", async () => {
    const res = await api.supA.post(`/api/v1/slots/${slotId}/attendance`, { rollNumber: "x" });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "SERVICE_NOT_STARTED");
  });

  it("verifies YES voters, enforces walk-in policy and prevents duplicates", async () => {
    advanceTo(await instantOf(serviceDate(), "12:30"), 1);
    await signInAll();
    assert.equal((await runSchedulerTick()).serviceStarted, 1);
    const roll = (i) => `I${w.inst.id}A00${i}`;
    const verify = (body) => api.supA.post(`/api/v1/slots/${slotId}/attendance`, body);

    const s0 = await verify({ rollNumber: roll(0).toLowerCase() });
    assert.equal(s0.status, 201, JSON.stringify(s0.body));
    assert.equal(s0.body.data.intent, "YES");
    assert.equal(s0.body.data.walkIn, "NOT_WALK_IN");

    const dup = await verify({ rollNumber: roll(0) });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, "ALREADY_VERIFIED");

    const noVoter = await verify({ rollNumber: roll(2) });
    assert.equal(noVoter.status, 409);
    assert.equal(noVoter.body.error.code, "WALK_IN_AUTHORIZATION_REQUIRED");
    assert.equal(noVoter.body.error.details.intent, "NO");
    const authorized = await verify({ rollNumber: roll(2), walkInReason: "Exam schedule changed, came back early" });
    assert.equal(authorized.status, 201);
    assert.equal(authorized.body.data.walkIn, "AUTHORIZED_EXCEPTION");

    const unvoted = await verify({ rollNumber: roll(4) });
    assert.equal(unvoted.status, 201);
    assert.equal(unvoted.body.data.intent, "UNVOTED");
    assert.equal(unvoted.body.data.walkIn, "POLICY_PERMITTED");

    const outsider = await verify({ rollNumber: `I${w.inst.id}B000` });
    assert.equal(outsider.status, 422);
    assert.equal(outsider.body.error.code, "NOT_ELIGIBLE");
    assert.equal((await verify({ rollNumber: "NOPE999" })).status, 404);
    assert.equal(s0.body.data.counts.verified, 1);
  });

  it("accepts a signed meal pass and rejects a forged one", async () => {
    const pass = await api.s0.get(`/api/v1/me/meals/${slotId}/pass`);
    assert.equal(pass.status, 200);
    const forged = pass.body.data.token.replace(/\.[^.]+$/, ".AAAAAAAAAAAAAAAAAAAAAA");
    const bad = await api.supA.post(`/api/v1/slots/${slotId}/attendance`, { passToken: forged });
    assert.equal(bad.status, 400);
    const again = await api.supA.post(`/api/v1/slots/${slotId}/attendance`, { passToken: pass.body.data.token });
    assert.equal(again.status, 409, "pass identifies an already-verified student");
  });

  it("logs leftovers and plate waste separately, measured", async () => {
    const log = (category, quantity) => api.kitchen.post(`/api/v1/slots/${slotId}/food-logs`, { category, quantity, unit: "g", measurement: "MEASURED" });
    assert.equal((await log("REUSABLE_SURPLUS", 300)).status, 201);
    assert.equal((await log("DISCARDED_SURPLUS", 400)).status, 201);
    assert.equal((await log("PLATE_WASTE", 200)).status, 201);
    const tooMuch = await log("DISCARDED_SURPLUS", state.prepared * 1000 * 5);
    assert.equal(tooMuch.status, 422, "leftovers cannot exceed what was prepared");
  });
});

describe("7. reconciliation and accountability", () => {
  it("closes service on schedule and previews no-show candidates", async () => {
    advanceTo(await instantOf(serviceDate(), "14:30"), 1);
    await signInAll();
    assert.equal((await runSchedulerTick()).serviceClosed, 1);
    const preview = (await api.supA.get(`/api/v1/slots/${slotId}/reconciliation`)).body.data;
    assert.equal(preview.state, "READY");
    const names = preview.noShowCandidates.map((c) => c.studentUserId).sort();
    assert.deepEqual(names, [Number(w.studentsA[3].id), (await pool.query(`SELECT id FROM users WHERE username = 'new2026x01'`)).rows[0].id].sort());
    assert.equal(preview.summary.counts.NO_WALK_IN, 1);
    assert.equal(preview.summary.counts.UNVOTED_ATTENDED, 1);
    assert.equal(preview.summary.counts.NO_ABSENT, 1);
  });

  it("reconciles once, honours excusals, and never issues duplicate warnings", async () => {
    const newId = (await pool.query(`SELECT id FROM users WHERE username = 'new2026x01'`)).rows[0].id;
    const res = await api.supA.post(`/api/v1/slots/${slotId}/reconcile`, { excusals: [{ studentUserId: newId, reason: "Medical certificate submitted" }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.state, "RECONCILED");
    assert.equal(res.body.data.actualAttendance, 3);
    assert.equal(res.body.data.summary.warningsIssued, 1);
    const again = await api.supA.post(`/api/v1/slots/${slotId}/reconcile`, { excusals: [] });
    assert.equal(again.body.data.alreadyReconciled, true);
    const count = await pool.query(`SELECT count(*)::int AS n FROM warnings WHERE meal_slot_id = $1`, [slotId]);
    assert.equal(count.rows[0].n, 1);
  });

  it("students see only their own warnings and can appeal once", async () => {
    const mine = (await api.s3.get("/api/v1/me/warnings")).body.data.items;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].tier, 1);
    assert.equal(mine[0].canAppeal, true);
    state.warningId = mine[0].id;
    assert.equal((await api.s0.get("/api/v1/me/warnings")).body.data.items.length, 0);
    assert.equal((await api.s0.post(`/api/v1/me/warnings/${state.warningId}/appeal`, { reason: "This is not my warning at all" })).status, 404);

    const appeal = await api.s3.post(`/api/v1/me/warnings/${state.warningId}/appeal`, { reason: "I was at the counter but the scanner was down" });
    assert.equal(appeal.status, 201);
    assert.equal((await api.s3.post(`/api/v1/me/warnings/${state.warningId}/appeal`, { reason: "Trying to appeal a second time" })).status, 409);
  });

  it("the supervisor resolves the appeal with the evidence in front of them", async () => {
    const appeals = (await api.supA.get(`/api/v1/messes/${w.messA}/appeals?status=PENDING`)).body.data;
    assert.equal(appeals.length, 1);
    assert.ok(appeals[0].evidence.voteEvents.length >= 1);
    assert.equal((await api.supB.post(`/api/v1/appeals/${appeals[0].id}/resolve`, { decision: "WAIVED", note: "Other mess cannot" })).status, 404);
    const res = await api.supA.post(`/api/v1/appeals/${appeals[0].id}/resolve`, { decision: "WAIVED", note: "Scanner outage confirmed in the incident log" });
    assert.equal(res.status, 200);
    const mine = (await api.s3.get("/api/v1/me/warnings")).body.data.items[0];
    assert.equal(mine.status, "WAIVED");
    assert.equal(mine.appeal.status, "WAIVED");
  });

  it("an audited correction updates the outcome and the stored summary", async () => {
    const res = await api.supA.post(`/api/v1/slots/${slotId}/outcomes/${w.studentsA[3].id}/correct`, { attended: true, reason: "Paper register shows attendance" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.actualAttendance, 4);
    const o = res.body.data.outcomes.find((x) => x.studentUserId === Number(w.studentsA[3].id));
    assert.equal(o.classification, "YES_ATTENDED");
    assert.equal(o.correctionReason, "Paper register shows attendance");
  });

  it("student history separates intention from attendance", async () => {
    const h = (await api.s2.get("/api/v1/me/history")).body.data.items.find((x) => x.slotId === slotId);
    assert.equal(h.intentAtCutoff, "NO");
    assert.equal(h.attended, true);
    assert.equal(h.classification, "NO_WALK_IN");
    const h4 = (await api.s4.get("/api/v1/me/history")).body.data.items.find((x) => x.slotId === slotId);
    assert.equal(h4.intentAtCutoff, "UNVOTED");
  });
});

describe("8. analyze", () => {
  it("supervisor analytics trace back to the recorded data", async () => {
    const q = `from=${localDate(-3)}&to=${localDate(3)}`;
    const res = await api.supA.get(`/api/v1/messes/${w.messA}/analytics?${q}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const s = res.body.data.summary;
    assert.equal(s.reconciledMeals, 1);
    assert.equal(s.actualAttendance, 4);
    assert.equal(s.participationRate, 83.3); // (3 + 2) / 6
    assert.equal(s.discardedFoodKg.value, 0.6); // 0.4 leftovers + 0.2 plate
    assert.equal(s.wastePerServingG.value, 150); // 600 g / 4 diners
    assert.equal(s.reusableSurplusKg.value, 0.3);
    assert.equal(s.completeness.wasteMeasured, 1);
    assert.equal(s.forecast.forecastBias, -0.84); // 3.16 predicted − 4 actual
    const meal = res.body.data.meals[0];
    assert.equal(meal.costBasis, "PLANNED_INGREDIENTS");
    assert.ok(meal.wasteCost > 0);
    assert.equal(res.body.data.baseline.available, false, "no baseline entered: no reduction claimed");
  });

  it("supervisors cannot read another mess's analytics", async () => {
    const q = `from=${localDate(-3)}&to=${localDate(3)}`;
    assert.equal((await api.supB.get(`/api/v1/messes/${w.messA}/analytics?${q}`)).status, 404);
    assert.equal((await api.supB.get(`/api/v1/admin/analytics?${q}`)).status, 403);
  });

  it("institution analytics aggregate the same numbers and keep missing data null", async () => {
    await api.admin.post("/api/v1/admin/baselines", {
      messId: w.messA,
      label: "Pre-deployment audit",
      periodStart: localDate(-60),
      periodEnd: localDate(-31),
      discardedGPerServing: 250,
      basis: "MEASURED",
      sourceNote: "Two-week weighing exercise by the mess committee",
    });
    const q = `from=${localDate(-3)}&to=${localDate(3)}`;
    const res = await api.admin.get(`/api/v1/admin/analytics?${q}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const a = res.body.data.messes.find((m) => m.messId === Number(w.messA));
    const b = res.body.data.messes.find((m) => m.messId === Number(w.messB));
    assert.equal(a.discardedFoodKg, 0.6);
    assert.equal(a.wastePerServingG, 150);
    assert.equal(a.baselineChangePercent, 40); // (250 − 150) / 250
    assert.equal(a.avoidedWasteKg, 0.4); // (250 − 150) g × 4 servings
    assert.equal(b.discardedFoodKg, null, "a mess with no records reports null, not 0");
    assert.equal(b.wastePerServingG, null);
    assert.equal(res.body.data.impact.avoidedWasteKg, 0.4);

    const csv = await api.admin.get(`/api/v1/admin/analytics/export.csv?${q}`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type"), /text\/csv/);
    assert.match(csv.text, /Blank cells mean the value was not recorded/);
    assert.match(csv.text, /Metric definitions/);
  });

  it("the audit trail records overrides with their reasons, for admins only", async () => {
    const res = await api.admin.get("/api/v1/admin/audit?action=plan.");
    assert.equal(res.status, 200);
    const ev = res.body.data.items.find((e) => e.action === "plan.approved_override");
    assert.equal(ev.reason, "Guests from the sports meet");
    assert.equal((await api.supA.get("/api/v1/admin/audit")).status, 403);
  });
});
