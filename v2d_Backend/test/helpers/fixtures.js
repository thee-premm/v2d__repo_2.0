import { pool } from "../../src/config/db.js";
import { hashPassword } from "../../src/lib/security.js";
import { issueAccountCode } from "../../src/modules/auth/auth.service.js";

export const DEFAULT_PASSWORD = "correct-horse-battery";
const hashCache = new Map();
async function cachedHash(password) {
  if (!hashCache.has(password)) hashCache.set(password, await hashPassword(password));
  return hashCache.get(password);
}

let seq = 0;
const next = () => ++seq;

/** Institution with one campus and one hostel. */
export async function createInstitution({ code, name, timezone = "Asia/Kolkata", settings = {} } = {}) {
  const n = next();
  const inst = (
    await pool.query(`INSERT INTO institutions (code, name, timezone, settings) VALUES ($1, $2, $3, $4) RETURNING id`, [
      code ?? `INST${n}`,
      name ?? `Institute ${n}`,
      timezone,
      JSON.stringify(settings),
    ])
  ).rows[0];
  const campus = (await pool.query(`INSERT INTO campuses (institution_id, code, name) VALUES ($1, 'MAIN', 'Main campus') RETURNING id`, [inst.id])).rows[0];
  const hostel = (
    await pool.query(`INSERT INTO hostels (institution_id, campus_id, code, name, capacity) VALUES ($1, $2, 'H1', 'Hostel One', 400) RETURNING id`, [
      inst.id,
      campus.id,
    ])
  ).rows[0];
  return { id: inst.id, campusId: campus.id, hostelId: hostel.id };
}

export async function createMess(inst, { code, name } = {}) {
  const n = next();
  const r = await pool.query(
    `INSERT INTO messes (institution_id, campus_id, hostel_id, code, name, seating_capacity) VALUES ($1, $2, $3, $4, $5, 300) RETURNING id`,
    [inst.id, inst.campusId, inst.hostelId, code ?? `M${n}`, name ?? `Mess ${n}`],
  );
  return r.rows[0].id;
}

export async function createMealTypes(inst) {
  const types = [
    ["BREAKFAST", "Breakfast", "07:30", "09:30", 0],
    ["LUNCH", "Lunch", "12:30", "14:30", 1],
    ["DINNER", "Dinner", "19:30", "21:30", 2],
  ];
  const out = {};
  for (const [code, name, start, end, order] of types) {
    const r = await pool.query(
      `INSERT INTO meal_types (institution_id, code, name, default_service_start, default_service_end, default_cutoff_minutes, default_open_hours, sort_order)
       VALUES ($1, $2, $3, $4, $5, 120, 36, $6) RETURNING id`,
      [inst.id, code, name, start, end, order],
    );
    out[code] = r.rows[0].id;
  }
  return out;
}

/**
 * roles: [{ role, messId? }], student: { rollNumber, messId, validFrom? }
 */
export async function createUser(inst, { username, fullName, email, password = DEFAULT_PASSWORD, status = "ACTIVE", roles = [], student } = {}) {
  const n = next();
  const uname = username ?? `user${n}`;
  const u = (
    await pool.query(
      `INSERT INTO users (institution_id, username, email, full_name, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [inst.id, uname, email ?? null, fullName ?? `User ${n}`, status === "INVITED" ? null : await cachedHash(password), status],
    )
  ).rows[0];
  for (const r of roles) {
    await pool.query(`INSERT INTO role_assignments (user_id, institution_id, role, mess_id) VALUES ($1, $2, $3, $4)`, [
      u.id,
      inst.id,
      r.role,
      r.messId ?? null,
    ]);
  }
  if (student) {
    await pool.query(`INSERT INTO role_assignments (user_id, institution_id, role) VALUES ($1, $2, 'STUDENT')`, [u.id, inst.id]);
    await pool.query(`INSERT INTO student_profiles (user_id, institution_id, roll_number, hostel_id, room_number) VALUES ($1, $2, $3, $4, 'A-101')`, [
      u.id,
      inst.id,
      student.rollNumber ?? `R${String(n).padStart(6, "0")}`,
      inst.hostelId,
    ]);
    if (student.messId) {
      await pool.query(`INSERT INTO mess_memberships (institution_id, student_user_id, mess_id, valid_from) VALUES ($1, $2, $3, $4)`, [
        inst.id,
        u.id,
        student.messId,
        student.validFrom ?? "2020-01-01",
      ]);
    }
  }
  return { id: u.id, username: uname, password };
}

export async function issueCode(userId, purpose = "ACTIVATION", ttlHours = 24) {
  const client = await pool.connect();
  try {
    return await issueAccountCode(client, { userId, purpose, ttlHours });
  } finally {
    client.release();
  }
}

/** A typical tenant: institution, two messes, meal types, admin, supervisor, kitchen, students. */
export async function createWorld({ students = 5, settings } = {}) {
  const inst = await createInstitution({ settings });
  const messA = await createMess(inst, { code: "MA", name: "North Mess" });
  const messB = await createMess(inst, { code: "MB", name: "South Mess" });
  const mealTypes = await createMealTypes(inst);
  const admin = await createUser(inst, { username: `admin${inst.id}`, roles: [{ role: "INSTITUTION_ADMIN" }] });
  const supervisorA = await createUser(inst, { username: `supa${inst.id}`, roles: [{ role: "SUPERVISOR", messId: messA }] });
  const supervisorB = await createUser(inst, { username: `supb${inst.id}`, roles: [{ role: "SUPERVISOR", messId: messB }] });
  const kitchenA = await createUser(inst, { username: `kita${inst.id}`, roles: [{ role: "KITCHEN_STAFF", messId: messA }] });
  const studentsA = [];
  for (let i = 0; i < students; i++) {
    studentsA.push(await createUser(inst, { username: `s${inst.id}a${i}`, student: { rollNumber: `I${inst.id}A${String(i).padStart(3, "0")}`, messId: messA } }));
  }
  const studentB = await createUser(inst, { username: `s${inst.id}b0`, student: { rollNumber: `I${inst.id}B000`, messId: messB } });
  return { inst, messA, messB, mealTypes, admin, supervisorA, supervisorB, kitchenA, studentsA, studentB };
}
