import { tooManyRequests } from "../lib/errors.js";

/**
 * Fixed-window, in-memory counters. Adequate for a single API instance; a
 * multi-instance deployment should move these counters to a shared store
 * (documented in docs/DEPLOYMENT.md). Per-account lockout is also persisted
 * in the database (users.locked_until), so restarts do not reset it.
 */
const buckets = new Map();
const limiters = new Set();

export function createLimiter({ name, windowMs, max }) {
  const limiter = {
    name,
    hit(key) {
      const now = Date.now();
      const k = `${name}:${key}`;
      let b = buckets.get(k);
      if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + windowMs };
        buckets.set(k, b);
      }
      b.count += 1;
      return { allowed: b.count <= max, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
    },
    peek(key) {
      const b = buckets.get(`${name}:${key}`);
      return b && b.resetAt > Date.now() && b.count >= max;
    },
    reset(key) {
      buckets.delete(`${name}:${key}`);
    },
  };
  limiters.add(limiter);
  return limiter;
}

/** Express middleware: limit by client IP. */
export function limitByIp(limiter) {
  return (req, res, next) => {
    const { allowed, retryAfterSec } = limiter.hit(req.ip);
    if (!allowed) {
      res.setHeader("Retry-After", String(retryAfterSec));
      return next(tooManyRequests());
    }
    next();
  };
}

export function resetAllLimiters() {
  buckets.clear();
}

// Periodically drop expired buckets so memory stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000).unref();
