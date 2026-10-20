import crypto from "node:crypto";
import { requestContext } from "../lib/requestContext.js";
import { logger } from "../lib/logger.js";

const VALID_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Assigns a correlation ID, exposes it in X-Request-Id, and writes one access-log line per request. */
export function requestContextMiddleware(req, res, next) {
  const incoming = req.get("x-request-id");
  const requestId = incoming && VALID_ID.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader("X-Request-Id", requestId);
  const started = performance.now();
  const ctx = { requestId, ip: req.ip, userAgent: req.get("user-agent")?.slice(0, 300) ?? null, userId: null };
  req.ctx = ctx;

  res.on("finish", () => {
    if (!req.originalUrl.startsWith("/api")) return;
    const ms = Math.round(performance.now() - started);
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    requestContext.run(ctx, () =>
      logger[level === "info" && req.originalUrl.startsWith("/api/v1/health") ? "debug" : level]("request", {
        method: req.method,
        path: req.originalUrl.split("?")[0],
        status: res.statusCode,
        ms,
      }),
    );
  });

  requestContext.run(ctx, next);
}
