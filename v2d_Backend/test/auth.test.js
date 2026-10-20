import "./helpers/setup.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers/server.js";
import { createInstitution, createMess, createUser, issueCode, DEFAULT_PASSWORD } from "./helpers/fixtures.js";
import { pool } from "../src/config/db.js";
import { clock } from "../src/lib/clock.js";

let srv;
let inst;
let messId;

before(async () => {
  srv = await startTestServer();
  inst = await createInstitution();
  messId = await createMess(inst);
});
after(() => srv.stop());

describe("sign-in", () => {
  it("opens an HttpOnly session and returns server-derived roles", async () => {
    const user = await createUser(inst, { username: "sup.one", roles: [{ role: "SUPERVISOR", messId }] });
    const c = srv.client();
    const res = await c.login(user.username, DEFAULT_PASSWORD);
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie().find((s) => s.startsWith("v2d_session="));
    assert.ok(cookie, "session cookie set");
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.ok(res.body.data.csrfToken);

    const session = await c.get("/api/v1/auth/session");
    assert.equal(session.status, 200);
    assert.deepEqual(session.body.data.roles, ["SUPERVISOR"]);
    assert.equal(session.body.data.activeRole, "SUPERVISOR");
    assert.deepEqual(session.body.data.scopes.supervisorMessIds, [Number(messId)]);
  });

  it("rejects wrong passwords and unknown users with the same generic error", async () => {
    await createUser(inst, { username: "real.user", roles: [{ role: "INSTITUTION_ADMIN" }] });
    const c = srv.client();
    const wrong = await c.login("real.user", "not-the-password");
    const unknown = await c.login("ghost.user", "not-the-password");
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.error.code, "INVALID_CREDENTIALS");
    assert.deepEqual(wrong.body.error, unknown.body.error);
  });

  it("does not grant a role chosen at sign-in that the account does not hold", async () => {
    const student = await createUser(inst, { username: "stu.esc", student: { messId } });
    const c = srv.client();
    const res = await c.login(student.username, DEFAULT_PASSWORD, "INSTITUTION_ADMIN");
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "ROLE_NOT_ASSIGNED");
    assert.equal(res.headers.getSetCookie().length, 0, "no session issued");
    assert.equal((await c.get("/api/v1/auth/session")).status, 401);
  });

  it("honours a requested workspace the account does hold", async () => {
    const dual = await createUser(inst, { username: "dual.role", roles: [{ role: "KITCHEN_STAFF", messId }], student: { messId } });
    const c = srv.client();
    assert.equal((await c.login(dual.username, DEFAULT_PASSWORD, "STUDENT")).status, 200);
    const s = await c.get("/api/v1/auth/session");
    assert.equal(s.body.data.activeRole, "STUDENT");
    assert.deepEqual(s.body.data.roles.sort(), ["KITCHEN_STAFF", "STUDENT"]);
    const sw = await c.post("/api/v1/auth/switch-role", { role: "INSTITUTION_ADMIN" });
    assert.equal(sw.status, 403);
  });

  it("locks an identifier after five failures, even for the correct password", async () => {
    const u = await createUser(inst, { username: "lock.me", roles: [{ role: "INSTITUTION_ADMIN" }] });
    const c = srv.client();
    for (let i = 0; i < 5; i++) assert.equal((await c.login(u.username, "wrong-password")).status, 401);
    const blocked = await c.login(u.username, DEFAULT_PASSWORD);
    assert.equal(blocked.status, 429);
    const ghost = srv.client();
    for (let i = 0; i < 5; i++) await ghost.login("no.such.user", "wrong-password");
    assert.equal((await ghost.login("no.such.user", "wrong-password")).status, 429, "unknown identifiers lock out the same way");
  });

  it("refuses inactive accounts even with the correct password", async () => {
    const u = await createUser(inst, { username: "sus.pended", status: "SUSPENDED", roles: [{ role: "INSTITUTION_ADMIN" }] });
    const res = await srv.client().login(u.username, DEFAULT_PASSWORD);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "ACCOUNT_INACTIVE");
  });

  it("never writes passwords into the audit trail", async () => {
    const secret = "an-unmistakable-password-42";
    await createUser(inst, { username: "audit.check", password: secret, roles: [{ role: "INSTITUTION_ADMIN" }] });
    await srv.client().login("audit.check", "wrong-guess-password-99");
    await srv.client().login("audit.check", secret);
    const rows = await pool.query(`SELECT row_to_json(a)::text AS j FROM audit_events a`);
    assert.ok(rows.rowCount > 0);
    for (const r of rows.rows) {
      assert.ok(!r.j.includes(secret) && !r.j.includes("wrong-guess-password-99"), "password leaked into audit_events");
    }
  });
});

describe("sessions", () => {
  it("logout revokes the session server-side; the old cookie stops working", async () => {
    const u = await createUser(inst, { username: "log.out", roles: [{ role: "INSTITUTION_ADMIN" }] });
    const c = srv.client();
    await c.login(u.username, DEFAULT_PASSWORD);
    const stolenCookie = c.cookieHeader();
    assert.equal((await c.post("/api/v1/auth/logout")).status, 200);
    assert.equal((await c.get("/api/v1/auth/session")).status, 401);
    const replay = await fetch(`${srv.baseUrl}/api/v1/auth/session`, { headers: { cookie: stolenCookie } });
    assert.equal(replay.status, 401);
  });

  it("requires the CSRF token for state changes and rejects foreign origins", async () => {
    const u = await createUser(inst, { username: "csrf.user", roles: [{ role: "INSTITUTION_ADMIN" }] });
    const c = srv.client();
    await c.login(u.username, DEFAULT_PASSWORD);
    const noToken = await c.post("/api/v1/auth/logout", {}, { csrf: false });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.body.error.code, "CSRF_TOKEN_INVALID");
    const foreign = await c.post("/api/v1/auth/logout", {}, { headers: { origin: "https://evil.example" } });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error.code, "ORIGIN_REJECTED");
    assert.equal((await c.get("/api/v1/auth/session")).status, 200, "session survived both forged attempts");
  });

  it("expires idle sessions", async () => {
    const u = await createUser(inst, { username: "idle.user", roles: [{ role: "INSTITUTION_ADMIN" }] });
    const c = srv.client();
    await c.login(u.username, DEFAULT_PASSWORD);
    clock.advance(3 * 60 * 60 * 1000);
    try {
      const res = await c.get("/api/v1/auth/session");
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, "SESSION_EXPIRED");
    } finally {
      clock.reset();
    }
  });

  it("ends sessions immediately when the account is deactivated", async () => {
    const u = await createUser(inst, { username: "deact.user", roles: [{ role: "INSTITUTION_ADMIN" }] });
    const c = srv.client();
    await c.login(u.username, DEFAULT_PASSWORD);
    await pool.query(`UPDATE users SET status = 'DEACTIVATED' WHERE id = $1`, [u.id]);
    assert.equal((await c.get("/api/v1/auth/session")).status, 401);
  });
});

describe("onboarding", () => {
  it("has no public self-registration endpoint", async () => {
    const res = await srv.client().post("/api/v1/auth/register", { username: "x", password: "y", role: "INSTITUTION_ADMIN" });
    assert.equal(res.status, 404);
  });

  it("activates an invited account with a one-time code, exactly once", async () => {
    const u = await createUser(inst, { username: "new.student", status: "INVITED", student: { messId } });
    const { code } = await issueCode(u.id, "ACTIVATION");
    const c = srv.client();
    const weak = await c.post("/api/v1/auth/activate", { identifier: u.username, code, password: "short" });
    assert.equal(weak.status, 400);
    const bad = await c.post("/api/v1/auth/activate", { identifier: u.username, code: "AAAA-BBBB-CCCC", password: "a-long-enough-password" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "INVALID_CODE");
    const ok = await c.post("/api/v1/auth/activate", { identifier: u.username, code: code.toLowerCase(), password: "a-long-enough-password" });
    assert.equal(ok.status, 200);
    assert.equal((await c.login(u.username, "a-long-enough-password")).status, 200);
    const reuse = await srv.client().post("/api/v1/auth/activate", { identifier: u.username, code, password: "another-long-password" });
    assert.equal(reuse.status, 400);
  });

  it("password reset with an issued code revokes existing sessions", async () => {
    const u = await createUser(inst, { username: "reset.me", roles: [{ role: "INSTITUTION_ADMIN" }] });
    const old = srv.client();
    await old.login(u.username, DEFAULT_PASSWORD);
    const { code } = await issueCode(u.id, "PASSWORD_RESET");
    const res = await srv.client().post("/api/v1/auth/password-reset/confirm", { identifier: u.username, code, password: "brand-new-password-1" });
    assert.equal(res.status, 200);
    assert.equal((await old.get("/api/v1/auth/session")).status, 401);
    assert.equal((await srv.client().login(u.username, "brand-new-password-1")).status, 200);
  });

  it("answers reset requests identically for known and unknown accounts", async () => {
    await createUser(inst, { username: "known.reset", email: "known.reset@example.edu", roles: [{ role: "INSTITUTION_ADMIN" }] });
    const a = await srv.client().post("/api/v1/auth/password-reset/request", { identifier: "known.reset" });
    const b = await srv.client().post("/api/v1/auth/password-reset/request", { identifier: "nobody.here" });
    assert.equal(a.status, 202);
    assert.deepEqual(a.body, b.body);
  });
});

describe("error contract", () => {
  it("returns JSON errors without stack traces", async () => {
    const res = await fetch(`${srv.baseUrl}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error.code, "MALFORMED_JSON");
    assert.ok(body.requestId);
    assert.ok(!JSON.stringify(body).includes("node_modules"));
  });

  it("validates input with field-level messages", async () => {
    const res = await srv.client().post("/api/v1/auth/login", { identifier: "", password: "" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "VALIDATION_FAILED");
    assert.ok(res.body.error.details.some((d) => d.field === "identifier"));
  });
});
