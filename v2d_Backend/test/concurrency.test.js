import "./helpers/setup.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers/server.js";
import { createWorld, DEFAULT_PASSWORD } from "./helpers/fixtures.js";
import { localDate } from "./helpers/time.js";
import { pool } from "../src/config/db.js";
import { processCutoff } from "../src/modules/forecasting/forecasting.service.js";

let srv;
let w;

async function insertSlot(status, { closesInHours, startsInHours, endsInHours, date = localDate(0), mealType = "LUNCH" }) {
  const r = await pool.query(
    `INSERT INTO meal_slots (institution_id, mess_id, meal_type_id, service_date, voting_opens_at, voting_closes_at, service_starts_at, service_ends_at, status, published_at)
     SELECT institution_id, $1, $2, $3::date, now() - interval '30 hours', now() + $4::float8 * interval '1 hour', now() + $5::float8 * interval '1 hour', now() + $6::float8 * interval '1 hour', $7, now()
       FROM messes WHERE id = $1 RETURNING id`,
    [w.messA, w.mealTypes[mealType], date, closesInHours, startsInHours, endsInHours, status],
  );
  return r.rows[0].id;
}

before(async () => {
  srv = await startTestServer();
  w = await createWorld({ students: 12 });
});
after(() => srv.stop());

describe("concurrency", () => {
  it("cutoff waits for an in-flight vote and includes it in the snapshot", async () => {
    const slot = await insertSlot("OPEN", { closesInHours: -0.01, startsInHours: 2, endsInHours: 4, mealType: "BREAKFAST" });
    const student = w.studentsA[0].id;
    const voter = await pool.connect();
    try {
      // Simulate a vote that passed its time check just before the cutoff and has not committed yet.
      await voter.query("BEGIN");
      await voter.query("SELECT id FROM meal_slots WHERE id = $1 FOR SHARE", [slot]);
      await voter.query(`INSERT INTO votes (meal_slot_id, student_user_id, intent, first_cast_at, updated_at) VALUES ($1, $2, 'YES', now(), now())`, [slot, student]);
      let settled = false;
      const lock = processCutoff(slot).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(settled, false, "cutoff must wait for the in-flight vote");
      await voter.query("COMMIT");
      await lock;
    } finally {
      voter.release();
    }
    const snap = await pool.query(`SELECT intent FROM vote_snapshots WHERE meal_slot_id = $1 AND student_user_id = $2`, [slot, student]);
    assert.equal(snap.rows[0].intent, "YES");
  });

  it("concurrent cutoff processing produces exactly one snapshot and one forecast", async () => {
    const slot = await insertSlot("OPEN", { closesInHours: -0.01, startsInHours: 3, endsInHours: 5, mealType: "DINNER" });
    await Promise.all(Array.from({ length: 6 }, () => processCutoff(slot)));
    const agg = await pool.query(`SELECT count(*)::int AS n FROM cutoff_aggregates WHERE meal_slot_id = $1`, [slot]);
    const forecasts = await pool.query(`SELECT count(*)::int AS n FROM forecasts WHERE meal_slot_id = $1`, [slot]);
    assert.equal(agg.rows[0].n, 1);
    assert.equal(forecasts.rows[0].n, 1);
  });

  it("parallel scans of the same student record exactly one attendance", async () => {
    const slot = await insertSlot("IN_SERVICE", { closesInHours: -3, startsInHours: -0.5, endsInHours: 1, date: localDate(-1) });
    await pool.query(`INSERT INTO vote_snapshots (meal_slot_id, student_user_id, intent) VALUES ($1, $2, 'YES')`, [slot, w.studentsA[1].id]);
    const sup = srv.client();
    await sup.login(w.supervisorA.username, DEFAULT_PASSWORD);
    const roll = `I${w.inst.id}A001`;
    const results = await Promise.all(Array.from({ length: 10 }, () => sup.post(`/api/v1/slots/${slot}/attendance`, { rollNumber: roll })));
    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 201).length, 1, JSON.stringify(statuses));
    assert.ok(statuses.filter((s) => s !== 201).every((s) => s === 409));
    const rows = await pool.query(`SELECT count(*)::int AS n FROM attendance_events WHERE meal_slot_id = $1 AND voided_at IS NULL`, [slot]);
    assert.equal(rows.rows[0].n, 1);
  });

  it("parallel reconciliation requests apply their effects once", async () => {
    const slot = await insertSlot("SERVICE_CLOSED", { closesInHours: -6, startsInHours: -4, endsInHours: -2, date: localDate(-2) });
    for (const s of w.studentsA.slice(0, 5)) {
      await pool.query(`INSERT INTO vote_snapshots (meal_slot_id, student_user_id, intent) VALUES ($1, $2, 'YES')`, [slot, s.id]);
    }
    const sup = srv.client();
    await sup.login(w.supervisorA.username, DEFAULT_PASSWORD);
    const results = await Promise.all(Array.from({ length: 5 }, () => sup.post(`/api/v1/slots/${slot}/reconcile`, { excusals: [] })));
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.body)));
    assert.equal(results.filter((r) => r.body.data.alreadyReconciled === false).length, 1);
    const warnings = await pool.query(`SELECT count(*)::int AS n FROM warnings WHERE meal_slot_id = $1`, [slot]);
    assert.equal(warnings.rows[0].n, 5);
    const outcomes = await pool.query(`SELECT count(*)::int AS n FROM attendance_outcomes WHERE meal_slot_id = $1`, [slot]);
    assert.equal(outcomes.rows[0].n, 5);
  });

  it("rapid vote toggling leaves one current vote consistent with its history", async () => {
    const slot = await insertSlot("OPEN", { closesInHours: 5, startsInHours: 7, endsInHours: 9, date: localDate(2) });
    const s = srv.client();
    await s.login(w.studentsA[2].username, DEFAULT_PASSWORD);
    const intents = Array.from({ length: 12 }, (_, i) => (i % 2 ? "NO" : "YES"));
    const res = await Promise.all(intents.map((intent) => s.put(`/api/v1/me/meals/${slot}/vote`, { intent })));
    assert.ok(res.every((r) => r.status === 200));
    const vote = (await pool.query(`SELECT intent, change_count FROM votes WHERE meal_slot_id = $1`, [slot])).rows;
    assert.equal(vote.length, 1);
    const events = (await pool.query(`SELECT intent FROM vote_events WHERE meal_slot_id = $1 ORDER BY id`, [slot])).rows;
    assert.equal(events.at(-1).intent, vote[0].intent, "last recorded event equals the current vote");
    assert.equal(events.length, vote[0].change_count + 1);
  });
});
