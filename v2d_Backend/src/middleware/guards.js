import { forbidden, unauthenticated } from "../lib/errors.js";

/** Requires a valid session. Distinguishes "never signed in" from "session ended". */
export function requireAuth(req, res, next) {
  if (req.principal) return next();
  if (req.sessionEnded) {
    return next(unauthenticated("Your session has ended. Sign in again.", "SESSION_EXPIRED"));
  }
  next(unauthenticated());
}

/** Requires at least one of the given roles among the user's *assigned* roles. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.principal) return requireAuth(req, res, next);
    if (roles.some((r) => req.principal.roles.has(r))) return next();
    next(forbidden());
  };
}
