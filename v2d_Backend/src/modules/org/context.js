import { query } from "../../config/db.js";
import { notFound, forbidden } from "../../lib/errors.js";
import { resolveSettings } from "../../domain/settings.js";

/** Institution row with resolved policy settings. */
export async function getInstitution(institutionId, client) {
  const r = await query(`SELECT id, code, name, timezone, currency, settings, is_demo FROM institutions WHERE id = $1`, [institutionId], client);
  if (!r.rows[0]) throw notFound("Institution");
  const inst = r.rows[0];
  return { ...inst, settings: resolveSettings(inst.settings) };
}

/**
 * Load a mess and check a capability. Messes outside the principal's scope
 * are reported as not found, so IDs cannot be probed.
 */
export async function loadMess(principal, messId, check, client) {
  const r = await query(`SELECT id, institution_id, campus_id, hostel_id, code, name, seating_capacity, is_active FROM messes WHERE id = $1`, [messId], client);
  const mess = r.rows[0];
  if (!mess || Number(mess.institution_id) !== principal.institutionId || !check(principal, mess)) throw notFound("Mess");
  return mess;
}

const SLOT_COLUMNS = `
  ms.id, ms.institution_id, ms.mess_id, ms.meal_type_id, ms.service_date, ms.voting_opens_at, ms.voting_closes_at,
  ms.service_starts_at, ms.service_ends_at, ms.status, ms.notes, ms.is_special_event, ms.is_exam_period, ms.is_holiday,
  ms.created_by, ms.created_at, ms.updated_at, ms.published_at, ms.locked_at, ms.service_started_at, ms.service_closed_at,
  ms.reconciled_at, ms.cancelled_at, ms.cancel_reason,
  mt.code AS meal_type_code, mt.name AS meal_type_name, mt.sort_order AS meal_type_order,
  m.name AS mess_name, m.code AS mess_code`;

export const slotSelect = `SELECT ${SLOT_COLUMNS}
  FROM meal_slots ms JOIN meal_types mt ON mt.id = ms.meal_type_id JOIN messes m ON m.id = ms.mess_id`;

/**
 * Load a meal slot and authorize against its mess. With `forUpdate`, the slot
 * row is locked for the rest of the transaction (serializes lifecycle changes).
 */
export async function loadSlot(principal, slotId, check, client, { forUpdate = false, forShare = false } = {}) {
  const lock = forUpdate ? "FOR UPDATE OF ms" : forShare ? "FOR SHARE OF ms" : "";
  const r = await query(`${slotSelect} WHERE ms.id = $1 ${lock}`, [slotId], client);
  const slot = r.rows[0];
  if (!slot || Number(slot.institution_id) !== principal.institutionId) throw notFound("Meal");
  if (!check(principal, { id: slot.mess_id, institution_id: slot.institution_id })) throw notFound("Meal");
  return slot;
}

export function assertAdmin(principal) {
  if (!principal.isAdmin) throw forbidden();
}
