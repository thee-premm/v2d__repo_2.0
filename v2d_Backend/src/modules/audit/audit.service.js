import { query } from "../../config/db.js";
import { redact } from "../../lib/logger.js";
import { requestContext } from "../../lib/requestContext.js";

/**
 * Append an audit event. Pass the transaction client so the audit row commits
 * (or rolls back) together with the change it describes.
 */
export async function recordAudit(client, { principal, institutionId, messId, action, entityType, entityId, reason, before, after }) {
  const ctx = requestContext.get();
  await query(
    `INSERT INTO audit_events
       (institution_id, mess_id, actor_user_id, action, entity_type, entity_id, reason, before_state, after_state, request_id, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      institutionId ?? principal?.institutionId ?? null,
      messId ?? null,
      principal?.userId ?? null,
      action,
      entityType,
      entityId === undefined || entityId === null ? null : String(entityId),
      reason ?? null,
      before === undefined ? null : JSON.stringify(redact(before)),
      after === undefined ? null : JSON.stringify(redact(after)),
      ctx?.requestId ?? null,
      ctx?.ip ?? null,
      ctx?.userAgent ?? null,
    ],
    client,
  );
}
