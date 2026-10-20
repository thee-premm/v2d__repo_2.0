import { query } from "../../config/db.js";

/**
 * Create an in-app notification. `dedupeKey` makes the call idempotent: a
 * retried job or request never notifies the same person twice.
 */
export async function notify(client, { userId, kind, title, body, link = null, data = {}, dedupeKey = null }) {
  await query(
    `INSERT INTO notifications (user_id, kind, title, body, link, data, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [userId, kind, title, body, link, JSON.stringify(data), dedupeKey],
    client,
  );
}

/** Notify the active supervisors of a mess. */
export async function notifySupervisors(client, messId, { kind, title, body, link, data, dedupeKey }) {
  const sups = await query(
    `SELECT DISTINCT ra.user_id FROM role_assignments ra JOIN users u ON u.id = ra.user_id
      WHERE ra.mess_id = $1 AND ra.role = 'SUPERVISOR' AND ra.revoked_at IS NULL AND u.status = 'ACTIVE'`,
    [messId],
    client,
  );
  for (const { user_id: userId } of sups.rows) {
    await notify(client, { userId, kind, title, body, link, data, dedupeKey: dedupeKey ? `${dedupeKey}:${userId}` : null });
  }
}
