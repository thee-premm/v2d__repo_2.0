import crypto from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function allowedOrigins(req) {
  const own = `${req.protocol}://${req.get("host")}`;
  return new Set([env.appOrigin, ...env.corsOrigins, own]);
}

function equal(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Cross-site request forgery protection for state-changing requests:
 *  1. If the browser sends an Origin header, it must be one we serve.
 *     (Also stops login-CSRF, where no session exists yet.)
 *  2. With a session, the X-CSRF-Token header must match the token bound to
 *     that session server-side (synchronizer-token pattern).
 *  3. Bodies must be JSON, which cross-site HTML forms cannot send.
 */
export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get("origin");
  if (origin && !allowedOrigins(req).has(origin)) {
    return next(new AppError(403, "ORIGIN_REJECTED", "Request origin is not allowed"));
  }

  const hasBody = Number(req.get("content-length") ?? 0) > 0 || req.get("transfer-encoding");
  if (hasBody && !req.is("application/json")) {
    return next(new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Send request bodies as application/json"));
  }

  if (req.session && !equal(req.get("x-csrf-token"), req.session.csrfToken)) {
    return next(new AppError(403, "CSRF_TOKEN_INVALID", "Your session security token is missing or out of date. Reload the page."));
  }
  next();
}
