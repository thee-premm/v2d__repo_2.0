import { env } from "../../config/env.js";
import { query, withTransaction } from "../../config/db.js";
import { clock } from "../../lib/clock.js";
import { AppError, tooManyRequests, validationFailed, unauthenticated } from "../../lib/errors.js";
import {
  burnPasswordCheck,
  generateOneTimeCode,
  hashOneTimeCode,
  hashPassword,
  passwordProblems,
  randomToken,
  sha256,
  verifyPassword,
} from "../../lib/security.js";
import { sendMail, mailEnabled } from "../../lib/mailer.js";
import { createLimiter } from "../../middleware/rateLimit.js";
import { loadIdentity } from "../../middleware/session.js";
import { recordAudit } from "../audit/audit.service.js";
import { getInstitution } from "../org/context.js";

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const ROLE_LABEL = { STUDENT: "Student", SUPERVISOR: "Mess supervisor", KITCHEN_STAFF: "Kitchen", INSTITUTION_ADMIN: "Institution admin" };
const ROLE_PRIORITY = ["INSTITUTION_ADMIN", "SUPERVISOR", "KITCHEN_STAFF", "STUDENT"];

// Failures per identifier, including identifiers that match no account, so
// lockout behaviour cannot be used to discover which accounts exist.
const failedByIdentifier = createLimiter({ name: "login-identifier", windowMs: LOCKOUT_MINUTES * 60_000, max: MAX_FAILED_LOGINS });
const codeAttemptsByIdentifier = createLimiter({ name: "code-identifier", windowMs: 15 * 60_000, max: 8 });

const invalidCredentials = () => unauthenticated("The username or password is incorrect.", "INVALID_CREDENTIALS");
const lockedOut = () => tooManyRequests(`Too many sign-in attempts. Wait ${LOCKOUT_MINUTES} minutes and try again.`);
const invalidCode = () => new AppError(400, "INVALID_CODE", "That code is invalid or has expired. Ask your mess office for a new one.");

export const normalizeIdentifier = (s) => String(s ?? "").trim().toLowerCase();

async function findUser(identifier, client) {
  const r = await query(
    `SELECT id, institution_id, username, full_name, email, password_hash, status, locked_until
       FROM users WHERE username = $1 OR email = $1 LIMIT 1`,
    [identifier],
    client,
  );
  return r.rows[0] ?? null;
}

async function createSession(client, { userId, activeRole, ip, userAgent }) {
  const now = clock.now();
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const absolute = new Date(now.getTime() + env.sessionAbsoluteHours * 3_600_000);
  const idle = new Date(Math.min(now.getTime() + env.sessionIdleMinutes * 60_000, absolute.getTime()));
  await query(
    `INSERT INTO sessions (token_hash, user_id, active_role, csrf_token, created_at, last_seen_at, idle_expires_at, absolute_expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9)`,
    [sha256(token), userId, activeRole, csrfToken, now, idle, absolute, ip ?? null, userAgent ?? null],
    client,
  );
  return { token, csrfToken, absoluteExpiresAt: absolute };
}

export async function revokeUserSessions(client, userId, reason, { exceptSessionId } = {}) {
  await query(
    `UPDATE sessions SET revoked_at = $2, revoke_reason = $3
      WHERE user_id = $1 AND revoked_at IS NULL AND ($4::bigint IS NULL OR id <> $4)`,
    [userId, clock.now(), reason, exceptSessionId ?? null],
    client,
  );
}

/**
 * Authenticate and open a session. `role` is the workspace the user asked for;
 * it is only honoured if the database says the user holds that role.
 */
export async function login({ identifier, password, role }, { ip, userAgent, previousSessionToken }) {
  const key = normalizeIdentifier(identifier);
  if (failedByIdentifier.peek(key)) throw lockedOut();

  const user = await findUser(key);
  const now = clock.now();
  if (!user) {
    await burnPasswordCheck(password);
    failedByIdentifier.hit(key);
    throw invalidCredentials();
  }
  if (user.locked_until && user.locked_until > now) throw lockedOut();

  if (!(await verifyPassword(password, user.password_hash))) {
    failedByIdentifier.hit(key);
    await withTransaction(async (client) => {
      await query(
        `UPDATE users SET failed_login_count = failed_login_count + 1,
                locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN $3 ELSE locked_until END
          WHERE id = $1`,
        [user.id, MAX_FAILED_LOGINS, new Date(now.getTime() + LOCKOUT_MINUTES * 60_000)],
        client,
      );
      await recordAudit(client, { institutionId: user.institution_id, action: "auth.login_failed", entityType: "user", entityId: user.id });
    });
    throw invalidCredentials();
  }

  if (user.status !== "ACTIVE") {
    throw new AppError(403, "ACCOUNT_INACTIVE", "This account is not active. Contact your institution's mess office.");
  }

  const identity = await loadIdentity(user.id);
  const roles = ROLE_PRIORITY.filter((r) => identity.assignments.some((a) => a.role === r));
  if (roles.length === 0) {
    throw new AppError(403, "NO_WORKSPACE", "No workspace has been assigned to this account yet. Contact your administrator.");
  }
  const activeRole = role ?? roles[0];
  if (!roles.includes(activeRole)) {
    throw new AppError(
      403,
      "ROLE_NOT_ASSIGNED",
      `This account does not have access to the ${ROLE_LABEL[activeRole]} workspace.`,
      { assignedRoles: roles },
    );
  }

  const session = await withTransaction(async (client) => {
    if (previousSessionToken) {
      // Never keep a pre-login session alive (session fixation).
      await query(`UPDATE sessions SET revoked_at = $2, revoke_reason = 'REPLACED' WHERE token_hash = $1 AND revoked_at IS NULL`, [
        sha256(previousSessionToken),
        now,
      ], client);
    }
    const s = await createSession(client, { userId: user.id, activeRole, ip, userAgent });
    await query(`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1`, [user.id, now], client);
    await recordAudit(client, {
      institutionId: user.institution_id,
      principal: { userId: Number(user.id) },
      action: "auth.login",
      entityType: "user",
      entityId: user.id,
      after: { activeRole },
    });
    return s;
  });
  failedByIdentifier.reset(key);
  return session;
}

export async function logout(principal) {
  await withTransaction(async (client) => {
    await query(`UPDATE sessions SET revoked_at = $2, revoke_reason = 'LOGOUT' WHERE id = $1 AND revoked_at IS NULL`, [principal.sessionId, clock.now()], client);
    await recordAudit(client, { principal, action: "auth.logout", entityType: "user", entityId: principal.userId });
  });
}

export async function switchRole(principal, role) {
  if (!principal.roles.has(role)) {
    throw new AppError(403, "ROLE_NOT_ASSIGNED", `This account does not have access to the ${ROLE_LABEL[role]} workspace.`);
  }
  await query(`UPDATE sessions SET active_role = $2 WHERE id = $1`, [principal.sessionId, role]);
}

/** Everything the client needs to render the right workspace. Derived from the server principal only. */
export async function describeSession(principal, csrfToken) {
  const institution = await getInstitution(principal.institutionId);
  const messIds = [...new Set([...principal.supervisorMessIds, ...principal.kitchenMessIds, ...(principal.student?.messId ? [principal.student.messId] : [])])];
  const messes = principal.isAdmin
    ? (await query(`SELECT id, code, name FROM messes WHERE institution_id = $1 AND is_active ORDER BY name`, [principal.institutionId])).rows
    : messIds.length
      ? (await query(`SELECT id, code, name FROM messes WHERE id = ANY($1::bigint[]) ORDER BY name`, [messIds])).rows
      : [];
  return {
    user: { id: principal.userId, username: principal.username, fullName: principal.fullName, email: principal.email },
    institution: { id: Number(institution.id), code: institution.code, name: institution.name, timezone: institution.timezone, currency: institution.currency, isDemo: institution.is_demo },
    roles: ROLE_PRIORITY.filter((r) => principal.roles.has(r)),
    activeRole: principal.activeRole,
    scopes: {
      supervisorMessIds: [...principal.supervisorMessIds],
      kitchenMessIds: [...principal.kitchenMessIds],
      student: principal.student,
    },
    messes: messes.map((m) => ({
      id: Number(m.id),
      code: m.code,
      name: m.name,
      roles: [
        ...(principal.supervisorMessIds.has(Number(m.id)) ? ["SUPERVISOR"] : []),
        ...(principal.kitchenMessIds.has(Number(m.id)) ? ["KITCHEN_STAFF"] : []),
        ...(principal.student?.messId === Number(m.id) ? ["STUDENT"] : []),
      ],
    })),
    csrfToken,
  };
}

/** Issue a one-time activation/reset code. Previous unused codes of the same purpose are revoked. */
export async function issueAccountCode(client, { userId, purpose, createdBy, ttlHours }) {
  const now = clock.now();
  await query(
    `UPDATE account_tokens SET revoked_at = $3 WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL AND revoked_at IS NULL`,
    [userId, purpose, now],
    client,
  );
  const code = generateOneTimeCode();
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);
  await query(
    `INSERT INTO account_tokens (user_id, purpose, token_hash, expires_at, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [userId, purpose, hashOneTimeCode(code), expiresAt, createdBy ?? null],
    client,
  );
  return { code, expiresAt };
}

function assertPasswordPolicy(password, user) {
  const problems = passwordProblems(password, { username: user?.username, email: user?.email });
  if (problems.length) throw validationFailed(problems.map((message) => ({ field: "password", message })));
}

async function redeemCode({ identifier, code, password, purpose, requiredStatus }) {
  const key = normalizeIdentifier(identifier);
  if (codeAttemptsByIdentifier.peek(key)) throw tooManyRequests();
  const user = await findUser(key);
  assertPasswordPolicy(password, user);
  if (!user || user.status !== requiredStatus) {
    codeAttemptsByIdentifier.hit(key);
    throw invalidCode();
  }
  const passwordHash = await hashPassword(password);
  const now = clock.now();
  return withTransaction(async (client) => {
    const token = (
      await query(
        `SELECT id FROM account_tokens
          WHERE token_hash = $1 AND user_id = $2 AND purpose = $3 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $4
          FOR UPDATE`,
        [hashOneTimeCode(code), user.id, purpose, now],
        client,
      )
    ).rows[0];
    if (!token) {
      codeAttemptsByIdentifier.hit(key);
      throw invalidCode();
    }
    await query(`UPDATE account_tokens SET used_at = $2 WHERE id = $1`, [token.id, now], client);
    await query(
      `UPDATE users SET password_hash = $2, status = 'ACTIVE', password_changed_at = $3, failed_login_count = 0, locked_until = NULL WHERE id = $1`,
      [user.id, passwordHash, now],
      client,
    );
    await revokeUserSessions(client, user.id, purpose === "ACTIVATION" ? "ACTIVATED" : "PASSWORD_RESET");
    await recordAudit(client, {
      institutionId: user.institution_id,
      principal: { userId: Number(user.id) },
      action: purpose === "ACTIVATION" ? "account.activated" : "account.password_reset",
      entityType: "user",
      entityId: user.id,
    });
    codeAttemptsByIdentifier.reset(key);
    return { username: user.username };
  });
}

export const activateAccount = (input) => redeemCode({ ...input, purpose: "ACTIVATION", requiredStatus: "INVITED" });
export const resetPassword = (input) => redeemCode({ ...input, purpose: "PASSWORD_RESET", requiredStatus: "ACTIVE" });

/**
 * Always reports acceptance (no account enumeration). A reset email is only
 * produced when a mail transport is configured and the account has an email.
 */
export async function requestPasswordReset({ identifier }) {
  const deliveryAvailable = mailEnabled();
  const user = await findUser(normalizeIdentifier(identifier));
  if (deliveryAvailable && user && user.status === "ACTIVE" && user.email) {
    const { code } = await withTransaction(async (client) => {
      const issued = await issueAccountCode(client, { userId: user.id, purpose: "PASSWORD_RESET", ttlHours: 0.5 });
      await recordAudit(client, { institutionId: user.institution_id, action: "account.reset_requested", entityType: "user", entityId: user.id });
      return issued;
    });
    const link = `${env.appOrigin}/reset-password?u=${encodeURIComponent(user.username)}`;
    await sendMail({
      to: user.email,
      subject: "Reset your Vote2Dine password",
      text: `Use this one-time code within 30 minutes: ${code}\n\nOpen ${link} and enter the code with a new password. If you did not ask for this, ignore this email.`,
    });
  }
  return { accepted: true, emailDelivery: deliveryAvailable ? "IF_ACCOUNT_HAS_EMAIL" : "NOT_CONFIGURED" };
}

export async function changePassword(principal, { currentPassword, newPassword }) {
  const user = (await query(`SELECT id, username, email, password_hash FROM users WHERE id = $1`, [principal.userId])).rows[0];
  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    throw new AppError(400, "INVALID_CURRENT_PASSWORD", "Your current password is incorrect.");
  }
  assertPasswordPolicy(newPassword, user);
  const hash = await hashPassword(newPassword);
  await withTransaction(async (client) => {
    await query(`UPDATE users SET password_hash = $2, password_changed_at = $3 WHERE id = $1`, [principal.userId, hash, clock.now()], client);
    await revokeUserSessions(client, principal.userId, "PASSWORD_CHANGED", { exceptSessionId: principal.sessionId });
    await recordAudit(client, { principal, action: "account.password_changed", entityType: "user", entityId: principal.userId });
  });
}
