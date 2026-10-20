import { query, withTransaction } from "../../config/db.js";
import { clock } from "../../lib/clock.js";
import { badRequest, conflict, notFound, ruleViolation } from "../../lib/errors.js";
import { parseCsvRecords } from "../../lib/csv.js";
import { recordAudit } from "../audit/audit.service.js";
import { issueAccountCode, revokeUserSessions } from "../auth/auth.service.js";
import { camel } from "../org/org.service.js";

const ACTIVATION_TTL_HOURS = 24 * 14;
const ADMIN_RESET_TTL_HOURS = 24;

export const usernameFromRoll = (roll) => roll.toLowerCase().replace(/[^a-z0-9._-]/g, "-");

async function institutionMess(client, principal, messId) {
  const r = await query(`SELECT id FROM messes WHERE id = $1 AND institution_id = $2`, [messId, principal.institutionId], client);
  if (!r.rows[0]) throw notFound("Mess");
}

async function institutionHostel(client, principal, hostelId) {
  const r = await query(`SELECT id FROM hostels WHERE id = $1 AND institution_id = $2`, [hostelId, principal.institutionId], client);
  if (!r.rows[0]) throw notFound("Hostel");
}

async function lockUser(client, principal, userId) {
  const r = await query(`SELECT * FROM users WHERE id = $1 AND institution_id = $2 FOR UPDATE`, [userId, principal.institutionId], client);
  if (!r.rows[0]) throw notFound("User");
  return r.rows[0];
}

export async function listUsers(principal, { q, role, status, messId, limit, offset }) {
  const params = [principal.institutionId];
  const where = ["u.institution_id = $1"];
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(u.username LIKE $${params.length} OR lower(u.full_name) LIKE $${params.length} OR u.email LIKE $${params.length} OR lower(sp.roll_number) LIKE $${params.length})`);
  }
  if (status) {
    params.push(status);
    where.push(`u.status = $${params.length}`);
  }
  if (role) {
    params.push(role);
    where.push(`EXISTS (SELECT 1 FROM role_assignments r WHERE r.user_id = u.id AND r.revoked_at IS NULL AND r.role = $${params.length})`);
  }
  if (messId) {
    params.push(messId);
    where.push(`(EXISTS (SELECT 1 FROM role_assignments r WHERE r.user_id = u.id AND r.revoked_at IS NULL AND r.mess_id = $${params.length})
               OR mm.mess_id = $${params.length})`);
  }
  const base = `FROM users u
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    LEFT JOIN mess_memberships mm ON mm.student_user_id = u.id AND mm.valid_to IS NULL
    WHERE ${where.join(" AND ")}`;
  const total = (await query(`SELECT count(*)::int AS n ${base}`, params)).rows[0].n;
  params.push(limit, offset);
  const rows = (
    await query(
      `SELECT u.id, u.username, u.full_name, u.email, u.status, u.last_login_at, u.created_at,
              sp.roll_number, mm.mess_id AS student_mess_id,
              COALESCE((SELECT json_agg(json_build_object('id', r.id, 'role', r.role, 'messId', r.mess_id, 'messName', m.name) ORDER BY r.role)
                          FROM role_assignments r LEFT JOIN messes m ON m.id = r.mess_id
                         WHERE r.user_id = u.id AND r.revoked_at IS NULL), '[]') AS roles
         ${base}
        ORDER BY u.full_name, u.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
  ).rows.map(camel);
  return { items: rows, total, limit, offset };
}

export async function getUser(principal, userId) {
  const u = (
    await query(
      `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.status, u.last_login_at, u.created_at, u.failed_login_count, u.locked_until,
              sp.roll_number, sp.hostel_id, sp.room_number, sp.program, sp.year_of_study
         FROM users u LEFT JOIN student_profiles sp ON sp.user_id = u.id
        WHERE u.id = $1 AND u.institution_id = $2`,
      [userId, principal.institutionId],
    )
  ).rows[0];
  if (!u) throw notFound("User");
  const [roles, memberships, codes] = await Promise.all([
    query(
      `SELECT r.id, r.role, r.mess_id, m.name AS mess_name, r.granted_at, r.revoked_at
         FROM role_assignments r LEFT JOIN messes m ON m.id = r.mess_id WHERE r.user_id = $1 ORDER BY r.granted_at DESC`,
      [userId],
    ),
    query(
      `SELECT mm.id, mm.mess_id, m.name AS mess_name, mm.valid_from, mm.valid_to FROM mess_memberships mm JOIN messes m ON m.id = mm.mess_id
        WHERE mm.student_user_id = $1 ORDER BY mm.valid_from DESC`,
      [userId],
    ),
    query(
      `SELECT purpose, expires_at, created_at FROM account_tokens WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2`,
      [userId, clock.now()],
    ),
  ]);
  return {
    ...camel(u),
    roles: roles.rows.map(camel),
    memberships: memberships.rows.map(camel),
    pendingCodes: codes.rows.map(camel),
  };
}

async function insertUser(client, principal, { username, fullName, email, phone }) {
  const exists = await query(`SELECT 1 FROM users WHERE username = $1 OR ($2::text IS NOT NULL AND email = $2)`, [username, email ?? null], client);
  if (exists.rowCount) throw conflict("That username or email is already in use", "DUPLICATE_IDENTIFIER");
  const r = await query(
    `INSERT INTO users (institution_id, username, email, full_name, phone, status, created_by)
     VALUES ($1, $2, $3, $4, $5, 'INVITED', $6) RETURNING id, username, full_name, email, status`,
    [principal.institutionId, username, email ?? null, fullName, phone ?? null, principal.userId],
    client,
  );
  return r.rows[0];
}

async function insertStudent(client, principal, userId, s, today) {
  if (s.hostelId) await institutionHostel(client, principal, s.hostelId);
  await institutionMess(client, principal, s.messId);
  const dup = await query(`SELECT 1 FROM student_profiles WHERE institution_id = $1 AND roll_number = $2`, [principal.institutionId, s.rollNumber], client);
  if (dup.rowCount) throw conflict(`Roll number ${s.rollNumber} is already registered`, "DUPLICATE_ROLL_NUMBER");
  await query(
    `INSERT INTO student_profiles (user_id, institution_id, roll_number, hostel_id, room_number, program, year_of_study) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, principal.institutionId, s.rollNumber, s.hostelId ?? null, s.roomNumber ?? null, s.program ?? null, s.yearOfStudy ?? null],
    client,
  );
  await query(
    `INSERT INTO mess_memberships (institution_id, student_user_id, mess_id, valid_from, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [principal.institutionId, userId, s.messId, s.validFrom ?? today, principal.userId],
    client,
  );
  await query(`INSERT INTO role_assignments (user_id, institution_id, role, granted_by) VALUES ($1, $2, 'STUDENT', $3)`, [userId, principal.institutionId, principal.userId], client);
}

async function insertStaffRole(client, principal, userId, { role, messId }) {
  if (role === "STUDENT") throw badRequest("Students are created with a student profile, not a bare role");
  if ((role === "SUPERVISOR" || role === "KITCHEN_STAFF") && !messId) throw badRequest(`${role} requires a mess`);
  if (role === "INSTITUTION_ADMIN" && messId) throw badRequest("Institution admins are not scoped to a mess");
  if (messId) await institutionMess(client, principal, messId);
  const r = await query(
    `INSERT INTO role_assignments (user_id, institution_id, role, mess_id, granted_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING RETURNING id`,
    [userId, principal.institutionId, role, messId ?? null, principal.userId],
    client,
  );
  if (!r.rowCount) throw conflict("This role is already assigned", "ROLE_ALREADY_ASSIGNED");
  return r.rows[0].id;
}

async function localToday(client, principal) {
  return (await query(`SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM institutions WHERE id = $1`, [principal.institutionId], client)).rows[0].d;
}

/** Create a staff member or a student. Returns a one-time activation code (shown once). */
export async function createUser(principal, input) {
  return withTransaction(async (client) => {
    const username = input.username ?? (input.student ? usernameFromRoll(input.student.rollNumber) : null);
    if (!username) throw badRequest("A username is required");
    const user = await insertUser(client, principal, { ...input, username });
    if (input.student) await insertStudent(client, principal, user.id, input.student, await localToday(client, principal));
    for (const r of input.roles ?? []) await insertStaffRole(client, principal, user.id, r);
    if (!input.student && !(input.roles ?? []).length) throw badRequest("Assign at least one role");
    const activation = await issueAccountCode(client, { userId: user.id, purpose: "ACTIVATION", createdBy: principal.userId, ttlHours: ACTIVATION_TTL_HOURS });
    await recordAudit(client, {
      principal,
      action: "user.created",
      entityType: "user",
      entityId: user.id,
      after: { username, fullName: input.fullName, roles: input.roles ?? [], student: input.student ? { rollNumber: input.student.rollNumber, messId: input.student.messId } : null },
    });
    return { user: camel(user), activation };
  });
}

export async function updateUser(principal, userId, patch) {
  return withTransaction(async (client) => {
    const before = await lockUser(client, principal, userId);
    if (patch.email) {
      const dup = await query(`SELECT 1 FROM users WHERE email = $1 AND id <> $2`, [patch.email, userId], client);
      if (dup.rowCount) throw conflict("That email is already in use", "DUPLICATE_IDENTIFIER");
    }
    await query(
      `UPDATE users SET full_name = COALESCE($2, full_name), email = CASE WHEN $3::boolean THEN $4 ELSE email END, phone = CASE WHEN $5::boolean THEN $6 ELSE phone END WHERE id = $1`,
      [userId, patch.fullName ?? null, patch.email !== undefined, patch.email ?? null, patch.phone !== undefined, patch.phone ?? null],
      client,
    );
    if (patch.student) {
      const sp = await query(`SELECT 1 FROM student_profiles WHERE user_id = $1`, [userId], client);
      if (!sp.rowCount) throw badRequest("This user has no student profile");
      if (patch.student.hostelId) await institutionHostel(client, principal, patch.student.hostelId);
      await query(
        `UPDATE student_profiles SET hostel_id = COALESCE($2, hostel_id), room_number = COALESCE($3, room_number),
                program = COALESCE($4, program), year_of_study = COALESCE($5, year_of_study) WHERE user_id = $1`,
        [userId, patch.student.hostelId ?? null, patch.student.roomNumber ?? null, patch.student.program ?? null, patch.student.yearOfStudy ?? null],
        client,
      );
    }
    await recordAudit(client, {
      principal,
      action: "user.updated",
      entityType: "user",
      entityId: userId,
      before: { fullName: before.full_name, email: before.email, phone: before.phone },
      after: patch,
    });
  });
}

export async function setStatus(principal, userId, { status, reason }) {
  if (Number(userId) === principal.userId) throw ruleViolation("You cannot change the status of your own account", "SELF_STATUS_CHANGE");
  return withTransaction(async (client) => {
    const before = await lockUser(client, principal, userId);
    if (status === "ACTIVE" && !before.password_hash) {
      throw ruleViolation("This account has not been activated yet. Issue an activation code instead.", "NOT_ACTIVATED");
    }
    await query(`UPDATE users SET status = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1`, [userId, status], client);
    if (status !== "ACTIVE") await revokeUserSessions(client, userId, `STATUS_${status}`);
    await recordAudit(client, { principal, action: "user.status_changed", entityType: "user", entityId: userId, reason, before: { status: before.status }, after: { status } });
    return { status };
  });
}

export async function grantRole(principal, userId, { role, messId }) {
  return withTransaction(async (client) => {
    await lockUser(client, principal, userId);
    const assignmentId = await insertStaffRole(client, principal, userId, { role, messId });
    await recordAudit(client, { principal, action: "role.granted", entityType: "user", entityId: userId, messId, after: { role, messId: messId ?? null, assignmentId } });
    return { assignmentId };
  });
}

export async function revokeRole(principal, userId, assignmentId, { reason }) {
  return withTransaction(async (client) => {
    await lockUser(client, principal, userId);
    const a = (
      await query(`SELECT * FROM role_assignments WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL FOR UPDATE`, [assignmentId, userId], client)
    ).rows[0];
    if (!a) throw notFound("Role assignment");
    if (a.role === "INSTITUTION_ADMIN") {
      if (Number(userId) === principal.userId) throw ruleViolation("You cannot remove your own administrator role", "SELF_ADMIN_REVOKE");
      const admins = await query(
        `SELECT count(*)::int AS n FROM role_assignments WHERE institution_id = $1 AND role = 'INSTITUTION_ADMIN' AND revoked_at IS NULL`,
        [principal.institutionId],
        client,
      );
      if (admins.rows[0].n <= 1) throw ruleViolation("An institution must keep at least one administrator", "LAST_ADMIN");
    }
    if (a.role === "STUDENT") throw ruleViolation("End the student's mess membership or deactivate the account instead", "STUDENT_ROLE_FIXED");
    await query(`UPDATE role_assignments SET revoked_at = $2, revoked_by = $3 WHERE id = $1`, [assignmentId, clock.now(), principal.userId], client);
    await recordAudit(client, {
      principal,
      action: "role.revoked",
      entityType: "user",
      entityId: userId,
      messId: a.mess_id,
      reason,
      before: { role: a.role, messId: a.mess_id, assignmentId: a.id },
    });
  });
}

export async function issueCode(principal, userId, purpose) {
  return withTransaction(async (client) => {
    const user = await lockUser(client, principal, userId);
    if (purpose === "ACTIVATION" && user.status !== "INVITED") throw ruleViolation("This account is already activated", "ALREADY_ACTIVE");
    if (purpose === "PASSWORD_RESET" && user.status !== "ACTIVE") throw ruleViolation("Only active accounts can reset a password", "NOT_ACTIVE");
    const issued = await issueAccountCode(client, {
      userId,
      purpose,
      createdBy: principal.userId,
      ttlHours: purpose === "ACTIVATION" ? ACTIVATION_TTL_HOURS : ADMIN_RESET_TTL_HOURS,
    });
    await recordAudit(client, { principal, action: purpose === "ACTIVATION" ? "user.activation_code_issued" : "user.reset_code_issued", entityType: "user", entityId: userId });
    return { username: user.username, ...issued };
  });
}

/** Move a student to another mess from a date; closes the current membership the day before. */
export async function changeMembership(principal, userId, { messId, validFrom }) {
  return withTransaction(async (client) => {
    await lockUser(client, principal, userId);
    await institutionMess(client, principal, messId);
    const sp = await query(`SELECT 1 FROM student_profiles WHERE user_id = $1`, [userId], client);
    if (!sp.rowCount) throw badRequest("This user has no student profile");
    const current = (await query(`SELECT * FROM mess_memberships WHERE student_user_id = $1 AND valid_to IS NULL FOR UPDATE`, [userId], client)).rows[0];
    if (current && current.valid_from >= validFrom) {
      throw ruleViolation("The new membership must start after the current one began", "MEMBERSHIP_OVERLAP");
    }
    if (current) {
      await query(`UPDATE mess_memberships SET valid_to = ($2::date - 1) WHERE id = $1`, [current.id, validFrom], client);
    }
    await query(
      `INSERT INTO mess_memberships (institution_id, student_user_id, mess_id, valid_from, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [principal.institutionId, userId, messId, validFrom, principal.userId],
      client,
    );
    await recordAudit(client, {
      principal,
      action: "student.membership_changed",
      entityType: "user",
      entityId: userId,
      messId,
      before: current ? { messId: current.mess_id, validFrom: current.valid_from } : null,
      after: { messId, validFrom },
    });
  });
}

const IMPORT_COLUMNS = ["roll_number", "full_name", "mess_code"];

/**
 * Roster import. Validates every row first; writes nothing unless the whole
 * file is valid and `dryRun` is false. Returns activation codes once.
 */
export async function importStudents(principal, { csv, dryRun }) {
  const { headers, records } = parseCsvRecords(csv);
  const missing = IMPORT_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length) throw badRequest(`Missing required column(s): ${missing.join(", ")}`, { required: IMPORT_COLUMNS, optional: ["email", "hostel_code", "room_number", "program", "year_of_study", "username"] });
  if (records.length === 0) throw badRequest("The file has no data rows");
  if (records.length > 5000) throw badRequest("Import at most 5,000 students per file");

  const [messes, hostels] = await Promise.all([
    query(`SELECT id, code FROM messes WHERE institution_id = $1`, [principal.institutionId]),
    query(`SELECT id, code FROM hostels WHERE institution_id = $1`, [principal.institutionId]),
  ]);
  const messByCode = new Map(messes.rows.map((m) => [m.code, m.id]));
  const hostelByCode = new Map(hostels.rows.map((h) => [h.code, h.id]));
  const seenRoll = new Set();
  const seenUser = new Set();
  const seenEmail = new Set();
  const errors = [];
  const rows = [];

  for (const { line, values } of records) {
    const rowErrors = [];
    const rollNumber = values.roll_number.toUpperCase();
    const username = (values.username || usernameFromRoll(rollNumber)).toLowerCase();
    const email = values.email ? values.email.toLowerCase() : null;
    if (!/^[A-Z0-9][A-Z0-9/_-]{1,31}$/.test(rollNumber)) rowErrors.push("roll_number is invalid");
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) rowErrors.push("username is invalid");
    if (!values.full_name || values.full_name.length > 160) rowErrors.push("full_name is required");
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) rowErrors.push("email is invalid");
    const messId = messByCode.get(values.mess_code.toUpperCase());
    if (!messId) rowErrors.push(`unknown mess_code "${values.mess_code}"`);
    const hostelId = values.hostel_code ? hostelByCode.get(values.hostel_code.toUpperCase()) : null;
    if (values.hostel_code && !hostelId) rowErrors.push(`unknown hostel_code "${values.hostel_code}"`);
    const year = values.year_of_study ? Number(values.year_of_study) : null;
    if (year !== null && !(Number.isInteger(year) && year >= 1 && year <= 10)) rowErrors.push("year_of_study must be 1–10");
    if (seenRoll.has(rollNumber)) rowErrors.push("duplicate roll_number in file");
    if (seenUser.has(username)) rowErrors.push("duplicate username in file");
    if (email && seenEmail.has(email)) rowErrors.push("duplicate email in file");
    seenRoll.add(rollNumber);
    seenUser.add(username);
    if (email) seenEmail.add(email);
    if (rowErrors.length) errors.push({ line, rollNumber: values.roll_number, errors: rowErrors });
    rows.push({ line, rollNumber, username, email, fullName: values.full_name, messId, hostelId, roomNumber: values.room_number || null, program: values.program || null, yearOfStudy: year });
  }

  // Conflicts with existing accounts.
  const existing = await query(
    `SELECT u.username, u.email, sp.roll_number FROM users u LEFT JOIN student_profiles sp ON sp.user_id = u.id AND sp.institution_id = $4
      WHERE u.username = ANY($1::text[]) OR u.email = ANY($2::text[]) OR sp.roll_number = ANY($3::text[])`,
    [rows.map((r) => r.username), rows.map((r) => r.email).filter(Boolean), rows.map((r) => r.rollNumber), principal.institutionId],
  );
  const takenUser = new Set(existing.rows.map((r) => r.username));
  const takenEmail = new Set(existing.rows.map((r) => r.email).filter(Boolean));
  const takenRoll = new Set(existing.rows.map((r) => r.roll_number).filter(Boolean));
  for (const r of rows) {
    const e = [];
    if (takenRoll.has(r.rollNumber)) e.push("roll_number already registered");
    else if (takenUser.has(r.username)) e.push("username already in use");
    if (r.email && takenEmail.has(r.email)) e.push("email already in use");
    if (e.length) {
      const existingErr = errors.find((x) => x.line === r.line);
      if (existingErr) existingErr.errors.push(...e);
      else errors.push({ line: r.line, rollNumber: r.rollNumber, errors: e });
    }
  }
  errors.sort((a, b) => a.line - b.line);

  if (errors.length || dryRun) {
    return { valid: errors.length === 0, committed: false, rowCount: rows.length, errors };
  }

  return withTransaction(async (client) => {
    const today = await localToday(client, principal);
    const created = [];
    for (const r of rows) {
      const user = await insertUser(client, principal, r);
      await insertStudent(client, principal, user.id, { ...r, validFrom: today }, today);
      const activation = await issueAccountCode(client, { userId: user.id, purpose: "ACTIVATION", createdBy: principal.userId, ttlHours: ACTIVATION_TTL_HOURS });
      created.push({ userId: user.id, rollNumber: r.rollNumber, username: r.username, fullName: r.fullName, activationCode: activation.code, expiresAt: activation.expiresAt });
    }
    await recordAudit(client, { principal, action: "students.imported", entityType: "institution", entityId: principal.institutionId, after: { count: created.length } });
    return { valid: true, committed: true, rowCount: rows.length, errors: [], created };
  });
}
