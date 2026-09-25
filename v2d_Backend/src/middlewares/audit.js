import { query } from "../config/db.js";
import { logger } from "../utils/logger.js";

export const auditLogger = (eventType) => {
  return async (req, res, next) => {
    const userId = req.user ? req.user.userId : null;
    const ipAddress =
      req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";
    const userAgent = req.headers["user-agent"] || "Unknown";

    // Log asynchronously without blocking HTTP response pipeline
    query(
      `INSERT INTO auth_and_system_audit_logs (user_id, ip_address, user_agent, event_type, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId,
        ipAddress,
        userAgent,
        eventType,
        JSON.stringify({
          path: req.originalUrl,
          method: req.method,
          body: req.body,
        }),
      ],
    ).catch((err) => {
      logger.error("Failed to save audit log", err);
    });

    next();
  };
};
