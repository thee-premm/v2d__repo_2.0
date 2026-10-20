import "./helpers/setup.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers/server.js";
import { createWorld, createUser, DEFAULT_PASSWORD } from "./helpers/fixtures.js";
import { localDate } from "./helpers/time.js";
import { pool } from "../src/config/db.js";

let srv;
let X; // institution X
let Y; // institution Y
const c = {};
let slotA; // OPEN lunch in X / mess A
let slotB; // OPEN lunch in X / mess B

async function as(name, username) {
  const client = srv.client();
  const res = await client.login(username, DEFAULT_PASSWORD);
  assert.equal(res.status, 200, `${name}: ${JSON.stringify(res.body)}`);
  c[name] = client;
}

async function openSlot(messId, mealTypeId) {
  const r = await pool.query(
    `INSERT INTO meal_slots (institution_id, mess_id, meal_type_id, service_date, voting_opens_at, voting_closes_at, service_starts_at, service_ends_at, status, published_at)
     SELECT institution_id, $1, $2, $3::date, now() - interval '1 hour', now() + interval '20 hours', now() + interval '22 hours', now() + interval '24 hours', 'OPEN', now()
       FROM messes WHERE id = $1 RETURNING id`,
    [messId, mealTypeId, localDate(1)],
  );
  return r.rows[0].id;
}

before(async () => {
  srv = await startTestServer();
  X = await createWorld({ students: 2 });
  Y = await createWorld({ students: 1 });
  await as("adminX", X.admin.username);
  await as("adminY", Y.admin.username);
  await as("supA", X.supervisorA.username);
  await as("supB", X.supervisorB.username);
  await as("kitA", X.kitchenA.username);
  await as("stuA", X.studentsA[0].username);
  slotA = await openSlot(X.messA, X.mealTypes.LUNCH);
  slotB = await openSlot(X.messB, X.mealTypes.LUNCH);
});
after(() => srv.stop());

describe("institution isolation", () => {
  it("an admin cannot read or change another institution's users", async () => {
    const victim = X.supervisorA.id;
    assert.equal((await c.adminY.get(`/api/v1/admin/users/${victim}`)).status, 404);
    assert.equal((await c.adminY.patch(`/api/v1/admin/users/${victim}`, { fullName: "Hijacked" })).status, 404);
    assert.equal((await c.adminY.post(`/api/v1/admin/users/${victim}/status`, { status: "SUSPENDED", reason: "cross-tenant attempt" })).status, 404);
    assert.equal((await c.adminY.post(`/api/v1/admin/users/${victim}/codes`, { purpose: "PASSWORD_RESET" })).status, 404);
    const list = (await c.adminY.get(`/api/v1/admin/users?limit=200`)).body.data.items;
    assert.ok(list.every((u) => !String(u.username).startsWith(`supa${X.inst.id}`)), "listing never includes other tenants");
  });

  it("an admin cannot assign their users to another institution's mess", async () => {
    const res = await c.adminY.post(`/api/v1/admin/users/${Y.supervisorA.id}/roles`, { role: "SUPERVISOR", messId: X.messA });
    assert.equal(res.status, 404);
  });

  it("an admin cannot read another institution's operations or analytics", async () => {
    const q = `from=${localDate(-1)}&to=${localDate(2)}`;
    assert.equal((await c.adminY.get(`/api/v1/messes/${X.messA}/overview`)).status, 404);
    assert.equal((await c.adminY.get(`/api/v1/slots/${slotA}`)).status, 404);
    assert.equal((await c.adminY.get(`/api/v1/messes/${X.messA}/analytics?${q}`)).status, 404);
  });

  it("roster import cannot target another institution's mess codes", async () => {
    const code = (await pool.query(`SELECT code FROM messes WHERE id = $1`, [X.messA])).rows[0].code;
    await pool.query(`UPDATE messes SET code = 'XONLY' WHERE id = $1`, [X.messA]);
    const res = await c.adminY.post(`/api/v1/admin/students/import`, { csv: "roll_number,full_name,mess_code\nZZ001,Zed,XONLY\n", dryRun: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.valid, false);
    assert.match(res.body.data.errors[0].errors[0], /unknown mess_code/);
    await pool.query(`UPDATE messes SET code = $2 WHERE id = $1`, [X.messA, code]);
  });
});

describe("mess isolation", () => {
  it("a supervisor cannot operate another mess by changing IDs", async () => {
    assert.equal((await c.supA.get(`/api/v1/slots/${slotB}`)).status, 404);
    assert.equal((await c.supA.post(`/api/v1/slots/${slotB}/cancel`, { reason: "not my mess" })).status, 404);
    assert.equal((await c.supA.post(`/api/v1/messes/${X.messB}/slots`, { mealTypeId: X.mealTypes.DINNER, serviceDate: localDate(2) })).status, 404);
    assert.equal((await c.supA.get(`/api/v1/messes/${X.messB}/warnings`)).status, 404);
    assert.equal((await c.supA.get(`/api/v1/messes/${X.messB}/inventory`)).status, 404);
  });

  it("kitchen staff are limited to kitchen work in their own mess", async () => {
    assert.equal((await c.kitA.get(`/api/v1/slots/${slotA}`)).status, 200, "can read operations of own mess");
    assert.equal((await c.kitA.post(`/api/v1/slots/${slotA}/publish`)).status, 404);
    assert.equal((await c.kitA.post(`/api/v1/slots/${slotA}/approve`, { servings: 10, reason: "kitchen override" })).status, 404);
    assert.equal((await c.kitA.post(`/api/v1/slots/${slotA}/attendance`, { rollNumber: "ANY" })).status, 404);
    assert.equal((await c.kitA.get(`/api/v1/messes/${X.messA}/analytics?from=${localDate(-1)}&to=${localDate(1)}`)).status, 404);
    assert.equal((await c.kitA.post(`/api/v1/slots/${slotB}/food-logs`, { category: "PLATE_WASTE", quantity: 1, unit: "kg", measurement: "MEASURED" })).status, 404);
    assert.equal((await c.kitA.get(`/api/v1/admin/users`)).status, 403);
  });

  it("institution admins read operations but cannot run them", async () => {
    assert.equal((await c.adminX.get(`/api/v1/slots/${slotA}`)).status, 200);
    assert.deepEqual((await c.adminX.get(`/api/v1/slots/${slotA}`)).body.data.actions, []);
    assert.equal((await c.adminX.post(`/api/v1/slots/${slotA}/cancel`, { reason: "admin attempt" })).status, 404);
    assert.equal((await c.adminX.get(`/api/v1/messes/${X.messA}/analytics?from=${localDate(-1)}&to=${localDate(1)}`)).status, 200);
  });

  it("students have no staff API and only their own data", async () => {
    assert.equal((await c.stuA.get(`/api/v1/messes/${X.messA}/slots?from=${localDate(0)}&to=${localDate(2)}`)).status, 403);
    assert.equal((await c.stuA.get(`/api/v1/catalog/dishes`)).status, 403);
    assert.equal((await c.stuA.get(`/api/v1/admin/overview`)).status, 403);
    assert.equal((await c.stuA.get(`/api/v1/me/meals/${slotB}/pass`)).status, 404, "pass for another mess's meal");
    const n = await pool.query(
      `INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, 'TEST', 'private', 'for someone else') RETURNING id`,
      [X.studentsA[1].id],
    );
    assert.equal((await c.stuA.post(`/api/v1/me/notifications/${n.rows[0].id}/read`)).status, 404);
  });

  it("unauthenticated requests are rejected everywhere", async () => {
    const anon = srv.client();
    for (const path of [`/api/v1/slots/${slotA}`, "/api/v1/me/meals", "/api/v1/admin/users", "/api/v1/org/messes", "/api/v1/me/notifications"]) {
      assert.equal((await anon.get(path)).status, 401, path);
    }
  });
});

describe("role changes take effect immediately", () => {
  it("revoking a role mid-session removes its permissions on the next request", async () => {
    const dual = await createUser(X.inst, { username: `dual${X.inst.id}`, roles: [{ role: "SUPERVISOR", messId: X.messA }, { role: "KITCHEN_STAFF", messId: X.messA }] });
    const s = srv.client();
    await s.login(dual.username, DEFAULT_PASSWORD, "SUPERVISOR");
    assert.equal((await s.get(`/api/v1/messes/${X.messA}/warnings`)).status, 200);
    const detail = (await c.adminX.get(`/api/v1/admin/users/${dual.id}`)).body.data;
    const sup = detail.roles.find((r) => r.role === "SUPERVISOR" && !r.revokedAt);
    assert.equal((await c.adminX.post(`/api/v1/admin/users/${dual.id}/roles/${sup.id}/revoke`, { reason: "Transferred to kitchen duty" })).status, 200);
    assert.equal((await s.get(`/api/v1/messes/${X.messA}/warnings`)).status, 404, "supervisor scope gone");
    assert.equal((await s.get(`/api/v1/kitchen/board?messId=${X.messA}`)).status, 200, "kitchen scope remains");
    const session = (await s.get("/api/v1/auth/session")).body.data;
    assert.equal(session.activeRole, "KITCHEN_STAFF", "workspace falls back to a held role");
  });

  it("admins cannot remove their own admin role or the last admin", async () => {
    const me = (await c.adminX.get(`/api/v1/admin/users/${X.admin.id}`)).body.data;
    const a = me.roles.find((r) => r.role === "INSTITUTION_ADMIN" && !r.revokedAt);
    const res = await c.adminX.post(`/api/v1/admin/users/${X.admin.id}/roles/${a.id}/revoke`, { reason: "remove myself" });
    assert.equal(res.status, 422);
    const self = await c.adminX.post(`/api/v1/admin/users/${X.admin.id}/status`, { status: "DEACTIVATED", reason: "lock myself out" });
    assert.equal(self.status, 422);
  });

  it("public onboarding cannot create privileged accounts", async () => {
    const anon = srv.client();
    assert.equal((await anon.post("/api/v1/admin/users", { fullName: "Mallory", roles: [{ role: "INSTITUTION_ADMIN" }] })).status, 401);
    assert.equal((await anon.post("/api/v1/auth/register", { username: "mallory", password: "x", role: "INSTITUTION_ADMIN" })).status, 404);
  });
});
