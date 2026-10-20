import { env } from "../config/env.js";
import { query } from "../config/db.js";
import { clock } from "../lib/clock.js";
import { sha256 } from "../lib/security.js";
import { buildPrincipal } from "../domain/permissions.js";
import { logger } from "../lib/logger.js";

// "__Host-" cookies must be Secure, Path=/ and have no Domain: the browser
// then refuses to let any subdomain or plain-HTTP page set or overwrite it.
export const SESSION_COOKIE = env.cookieSecure ? "__Host-v2d_session" : "v2d_session";

export function sessionCookieOptions(expires) {
  return { httpOnly: true, secure: env.cookieSecure, sameSite: "lax", path: "/", ...(expires ? { expires } : {}) };
}

/** Loads role assignments, student profile and current mess membership for a user. */
export async function loadIdentity(userId, client) {
  const run = (sql, params) => query(sql, params, client);
  const [assignments, student] = await Promise.all([
    run(`SELECT role, mess_id FROM role_assignments WHERE user_id = $1 AND revoked_at IS NULL`, [userId]),
    run(
      `SELECT sp.roll_number, sp.hostel_id, mm.mess_id
         FROM student_profiles sp
         LEFT JOIN mess_memberships mm ON mm.student_user_id = sp.user_id AND mm.valid_to IS NULL
        WHERE sp.user_id = $1`,
      [userId],
    ),
  ]);
  return { assignments: assignments.rows, student: student.rows[0] ?? null };
}

/**
 * Resolves the session cookie into `req.principal`. Never rejects the request
 * itself: route guards decide whether authentication is required.
 */
export async function sessionMiddleware(req, res, next) {
  req.principal = null;
  req.session = null;
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || typeof token !== "string" || token.length > 128) return next();

  const result = await query(
    `SELECT s.id, s.user_id, s.active_role, s.csrf_token, s.last_seen_at, s.idle_expires_at, s.absolute_expires_at,
            u.institution_id, u.username, u.full_name, u.email, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL`,
    [sha256(token)],
  );
  const row = result.rows[0];
  const now = clock.now();
  const expire = async (reason) => {
    if (row) await query(`UPDATE sessions SET revoked_at = $2, revoke_reason = $3 WHERE id = $1 AND revoked_at IS NULL`, [row.id, now, reason]);
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    req.sessionEnded = reason;
    next();
  };

  if (!row) return expire("UNKNOWN");
  if (row.idle_expires_at <= now || row.absolute_expires_at <= now) return expire("EXPIRED");
  if (row.status !== "ACTIVE") return expire("ACCOUNT_INACTIVE");

  const identity = await loadIdentity(row.user_id);
  if (identity.assignments.length === 0) return expire("NO_ROLES");

  let activeRole = row.active_role;
  if (!identity.assignments.some((a) => a.role === activeRole)) {
    // The workspace's role was revoked mid-session: fall back to a role the user still holds.
    activeRole = identity.assignments[0].role;
    await query(`UPDATE sessions SET active_role = $2 WHERE id = $1`, [row.id, activeRole]);
  }

  // Sliding idle expiry, written at most once a minute to avoid a write per request.
  if (now - row.last_seen_at > 60_000) {
    const idle = new Date(Math.min(now.getTime() + env.sessionIdleMinutes * 60_000, row.absolute_expires_at.getTime()));
    query(`UPDATE sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1`, [row.id, now, idle]).catch((err) =>
      logger.warn("Could not extend session", err),
    );
  }

  req.session = { id: row.id, csrfToken: row.csrf_token, absoluteExpiresAt: row.absolute_expires_at };
  req.principal = buildPrincipal({
    user: { id: row.user_id, institution_id: row.institution_id, username: row.username, full_name: row.full_name, email: row.email },
    assignments: identity.assignments,
    student: identity.student,
    activeRole,
    sessionId: row.id,
  });
  if (req.ctx) req.ctx.userId = req.principal.userId;
  next();
}
