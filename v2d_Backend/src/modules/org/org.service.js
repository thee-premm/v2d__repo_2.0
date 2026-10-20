import { query, withTransaction } from "../../config/db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/audit.service.js";
import { deepMerge, resolveSettings, settingsSchema, DEFAULT_SETTINGS } from "../../domain/settings.js";
import { visibleMessIds } from "../../domain/permissions.js";

const camel = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]));

export async function assertValidTimezone(tz) {
  const r = await query(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [tz]);
  if (!r.rowCount) throw badRequest(`Unknown timezone "${tz}"`);
}

export async function institutionSummary(principal) {
  const r = await query(`SELECT id, code, name, timezone, currency FROM institutions WHERE id = $1`, [principal.institutionId]);
  return camel(r.rows[0]);
}

export async function institutionForAdmin(principal) {
  const r = await query(`SELECT id, code, name, timezone, currency, settings, updated_at FROM institutions WHERE id = $1`, [principal.institutionId]);
  const row = r.rows[0];
  return { ...camel(row), settings: resolveSettings(row.settings), defaults: DEFAULT_SETTINGS };
}

export async function updateInstitution(principal, patch) {
  if (patch.timezone) await assertValidTimezone(patch.timezone);
  return withTransaction(async (client) => {
    const before = (await query(`SELECT name, timezone, currency FROM institutions WHERE id = $1 FOR UPDATE`, [principal.institutionId], client)).rows[0];
    const r = await query(
      `UPDATE institutions SET name = COALESCE($2, name), timezone = COALESCE($3, timezone), currency = COALESCE($4, currency)
        WHERE id = $1 RETURNING name, timezone, currency`,
      [principal.institutionId, patch.name ?? null, patch.timezone ?? null, patch.currency ?? null],
      client,
    );
    await recordAudit(client, { principal, action: "institution.updated", entityType: "institution", entityId: principal.institutionId, before, after: r.rows[0] });
    return camel(r.rows[0]);
  });
}

export async function updateSettings(principal, patch) {
  return withTransaction(async (client) => {
    const row = (await query(`SELECT settings FROM institutions WHERE id = $1 FOR UPDATE`, [principal.institutionId], client)).rows[0];
    const before = resolveSettings(row.settings);
    const merged = deepMerge(before, patch);
    const parsed = settingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw badRequest("Settings are invalid", parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })));
    }
    await query(`UPDATE institutions SET settings = $2 WHERE id = $1`, [principal.institutionId, JSON.stringify(parsed.data)], client);
    await recordAudit(client, { principal, action: "institution.settings_updated", entityType: "institution", entityId: principal.institutionId, before, after: parsed.data });
    return parsed.data;
  });
}

export async function listVisibleMesses(principal) {
  if (principal.isAdmin) {
    return (
      await query(
        `SELECT m.id, m.code, m.name, m.campus_id, m.hostel_id, m.seating_capacity, m.is_active, c.name AS campus_name, h.name AS hostel_name
           FROM messes m JOIN campuses c ON c.id = m.campus_id LEFT JOIN hostels h ON h.id = m.hostel_id
          WHERE m.institution_id = $1 ORDER BY m.name`,
        [principal.institutionId],
      )
    ).rows.map(camel);
  }
  const ids = [...(visibleMessIds(principal) ?? []), ...(principal.student?.messId ? [principal.student.messId] : [])];
  if (!ids.length) return [];
  return (
    await query(
      `SELECT m.id, m.code, m.name, m.campus_id, m.hostel_id, m.seating_capacity, m.is_active, c.name AS campus_name, h.name AS hostel_name
         FROM messes m JOIN campuses c ON c.id = m.campus_id LEFT JOIN hostels h ON h.id = m.hostel_id
        WHERE m.id = ANY($1::bigint[]) AND m.institution_id = $2 ORDER BY m.name`,
      [ids, principal.institutionId],
    )
  ).rows.map(camel);
}

export async function structure(principal) {
  const [campuses, hostels, messes] = await Promise.all([
    query(`SELECT id, code, name FROM campuses WHERE institution_id = $1 ORDER BY name`, [principal.institutionId]),
    query(`SELECT id, campus_id, code, name, capacity FROM hostels WHERE institution_id = $1 ORDER BY name`, [principal.institutionId]),
    query(
      `SELECT m.id, m.campus_id, m.hostel_id, m.code, m.name, m.seating_capacity, m.is_active,
              (SELECT count(*) FROM mess_memberships mm WHERE mm.mess_id = m.id AND mm.valid_to IS NULL)::int AS member_count,
              (SELECT count(*) FROM role_assignments ra WHERE ra.mess_id = m.id AND ra.role = 'SUPERVISOR' AND ra.revoked_at IS NULL)::int AS supervisor_count,
              (SELECT count(*) FROM role_assignments ra WHERE ra.mess_id = m.id AND ra.role = 'KITCHEN_STAFF' AND ra.revoked_at IS NULL)::int AS kitchen_count
         FROM messes m WHERE m.institution_id = $1 ORDER BY m.name`,
      [principal.institutionId],
    ),
  ]);
  return { campuses: campuses.rows.map(camel), hostels: hostels.rows.map(camel), messes: messes.rows.map(camel) };
}

async function ownedRow(client, table, id, principal, what) {
  const r = await query(`SELECT * FROM ${table} WHERE id = $1 AND institution_id = $2 FOR UPDATE`, [id, principal.institutionId], client);
  if (!r.rows[0]) throw notFound(what);
  return r.rows[0];
}

export async function createCampus(principal, { code, name }) {
  return withTransaction(async (client) => {
    const r = await query(`INSERT INTO campuses (institution_id, code, name) VALUES ($1, $2, $3) RETURNING id, code, name`, [principal.institutionId, code, name], client);
    await recordAudit(client, { principal, action: "campus.created", entityType: "campus", entityId: r.rows[0].id, after: r.rows[0] });
    return camel(r.rows[0]);
  });
}

export async function updateCampus(principal, id, { name }) {
  return withTransaction(async (client) => {
    const before = await ownedRow(client, "campuses", id, principal, "Campus");
    const r = await query(`UPDATE campuses SET name = COALESCE($2, name) WHERE id = $1 RETURNING id, code, name`, [id, name ?? null], client);
    await recordAudit(client, { principal, action: "campus.updated", entityType: "campus", entityId: id, before, after: r.rows[0] });
    return camel(r.rows[0]);
  });
}

export async function createHostel(principal, { campusId, code, name, capacity }) {
  return withTransaction(async (client) => {
    await ownedRow(client, "campuses", campusId, principal, "Campus");
    const r = await query(
      `INSERT INTO hostels (institution_id, campus_id, code, name, capacity) VALUES ($1, $2, $3, $4, $5) RETURNING id, campus_id, code, name, capacity`,
      [principal.institutionId, campusId, code, name, capacity ?? null],
      client,
    );
    await recordAudit(client, { principal, action: "hostel.created", entityType: "hostel", entityId: r.rows[0].id, after: r.rows[0] });
    return camel(r.rows[0]);
  });
}

export async function updateHostel(principal, id, { name, capacity }) {
  return withTransaction(async (client) => {
    const before = await ownedRow(client, "hostels", id, principal, "Hostel");
    const r = await query(
      `UPDATE hostels SET name = COALESCE($2, name), capacity = COALESCE($3, capacity) WHERE id = $1 RETURNING id, campus_id, code, name, capacity`,
      [id, name ?? null, capacity ?? null],
      client,
    );
    await recordAudit(client, { principal, action: "hostel.updated", entityType: "hostel", entityId: id, before, after: r.rows[0] });
    return camel(r.rows[0]);
  });
}

export async function createMess(principal, { campusId, hostelId, code, name, seatingCapacity }) {
  return withTransaction(async (client) => {
    await ownedRow(client, "campuses", campusId, principal, "Campus");
    if (hostelId) await ownedRow(client, "hostels", hostelId, principal, "Hostel");
    const r = await query(
      `INSERT INTO messes (institution_id, campus_id, hostel_id, code, name, seating_capacity) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, campus_id, hostel_id, code, name, seating_capacity, is_active`,
      [principal.institutionId, campusId, hostelId ?? null, code, name, seatingCapacity ?? null],
      client,
    );
    await recordAudit(client, { principal, action: "mess.created", entityType: "mess", entityId: r.rows[0].id, messId: r.rows[0].id, after: r.rows[0] });
    return camel(r.rows[0]);
  });
}

export async function updateMess(principal, id, { name, seatingCapacity, isActive, hostelId }) {
  return withTransaction(async (client) => {
    const before = await ownedRow(client, "messes", id, principal, "Mess");
    if (hostelId) await ownedRow(client, "hostels", hostelId, principal, "Hostel");
    const r = await query(
      `UPDATE messes SET name = COALESCE($2, name), seating_capacity = COALESCE($3, seating_capacity),
              is_active = COALESCE($4, is_active), hostel_id = CASE WHEN $5::boolean THEN $6 ELSE hostel_id END
        WHERE id = $1 RETURNING id, campus_id, hostel_id, code, name, seating_capacity, is_active`,
      [id, name ?? null, seatingCapacity ?? null, isActive ?? null, hostelId !== undefined, hostelId ?? null],
      client,
    );
    await recordAudit(client, { principal, action: "mess.updated", entityType: "mess", entityId: id, messId: id, before, after: r.rows[0] });
    return camel(r.rows[0]);
  });
}

const MEAL_TYPE_COLS = `id, code, name, to_char(default_service_start, 'HH24:MI') AS default_service_start,
  to_char(default_service_end, 'HH24:MI') AS default_service_end, default_cutoff_minutes, default_open_hours, sort_order, is_active`;

export async function listMealTypes(principal) {
  return (await query(`SELECT ${MEAL_TYPE_COLS} FROM meal_types WHERE institution_id = $1 ORDER BY sort_order, name`, [principal.institutionId])).rows.map(camel);
}

export async function createMealType(principal, t) {
  return withTransaction(async (client) => {
    const r = await query(
      `INSERT INTO meal_types (institution_id, code, name, default_service_start, default_service_end, default_cutoff_minutes, default_open_hours, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${MEAL_TYPE_COLS}`,
      [principal.institutionId, t.code, t.name, t.defaultServiceStart, t.defaultServiceEnd, t.defaultCutoffMinutes, t.defaultOpenHours, t.sortOrder ?? 0],
      client,
    );
    await recordAudit(client, { principal, action: "meal_type.created", entityType: "meal_type", entityId: r.rows[0].id, after: r.rows[0] });
    return camel(r.rows[0]);
  });
}

export async function updateMealType(principal, id, t) {
  return withTransaction(async (client) => {
    const before = await ownedRow(client, "meal_types", id, principal, "Meal type");
    const r = await query(
      `UPDATE meal_types SET name = COALESCE($2, name), default_service_start = COALESCE($3, default_service_start),
              default_service_end = COALESCE($4, default_service_end), default_cutoff_minutes = COALESCE($5, default_cutoff_minutes),
              default_open_hours = COALESCE($6, default_open_hours), sort_order = COALESCE($7, sort_order), is_active = COALESCE($8, is_active)
        WHERE id = $1 RETURNING ${MEAL_TYPE_COLS}`,
      [id, t.name ?? null, t.defaultServiceStart ?? null, t.defaultServiceEnd ?? null, t.defaultCutoffMinutes ?? null, t.defaultOpenHours ?? null, t.sortOrder ?? null, t.isActive ?? null],
      client,
    );
    await recordAudit(client, { principal, action: "meal_type.updated", entityType: "meal_type", entityId: id, before, after: r.rows[0] });
    return camel(r.rows[0]);
  });
}

export async function listBaselines(principal, messId) {
  const r = await query(
    `SELECT b.id, b.mess_id, m.name AS mess_name, b.label, b.period_start, b.period_end, b.discarded_g_per_serving, b.basis, b.source_note,
            b.created_at, u.full_name AS created_by_name
       FROM waste_baselines b JOIN messes m ON m.id = b.mess_id JOIN users u ON u.id = b.created_by
      WHERE b.institution_id = $1 AND ($2::bigint IS NULL OR b.mess_id = $2) ORDER BY b.created_at DESC`,
    [principal.institutionId, messId ?? null],
  );
  return r.rows.map(camel);
}

export async function createBaseline(principal, b) {
  return withTransaction(async (client) => {
    await ownedRow(client, "messes", b.messId, principal, "Mess");
    const r = await query(
      `INSERT INTO waste_baselines (institution_id, mess_id, label, period_start, period_end, discarded_g_per_serving, basis, source_note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [principal.institutionId, b.messId, b.label, b.periodStart, b.periodEnd, b.discardedGPerServing, b.basis, b.sourceNote, principal.userId],
      client,
    );
    await recordAudit(client, { principal, action: "baseline.created", entityType: "waste_baseline", entityId: r.rows[0].id, messId: b.messId, after: r.rows[0] });
    return camel(r.rows[0]);
  });
}

export { camel };
