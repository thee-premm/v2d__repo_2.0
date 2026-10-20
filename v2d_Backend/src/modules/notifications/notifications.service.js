import { query } from "../../config/db.js";
import { clock } from "../../lib/clock.js";
import { notFound } from "../../lib/errors.js";

export async function list(principal, { unreadOnly, limit, offset }) {
  const [items, unread] = await Promise.all([
    query(
      `SELECT id, kind, title, body, link, data, created_at, read_at FROM notifications
        WHERE user_id = $1 AND ($2::boolean = false OR read_at IS NULL)
        ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [principal.userId, unreadOnly, limit, offset],
    ),
    query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [principal.userId]),
  ]);
  return {
    unreadCount: unread.rows[0].n,
    items: items.rows.map((n) => ({ id: Number(n.id), kind: n.kind, title: n.title, body: n.body, link: n.link, data: n.data, createdAt: n.created_at, readAt: n.read_at })),
  };
}

export async function markRead(principal, id) {
  const r = await query(`UPDATE notifications SET read_at = COALESCE(read_at, $3) WHERE id = $1 AND user_id = $2 RETURNING id`, [id, principal.userId, clock.now()]);
  if (!r.rowCount) throw notFound("Notification");
  return { read: true };
}

export async function markAllRead(principal) {
  const r = await query(`UPDATE notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL`, [principal.userId, clock.now()]);
  return { marked: r.rowCount };
}
