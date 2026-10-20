import { env } from "../config/env.js";

/**
 * The backend's authoritative clock. Every business deadline (voting cutoff,
 * service windows, appeal windows) is evaluated against `clock.now()` on the
 * server, never against a client-supplied time.
 *
 * Tests may shift the clock to exercise time-dependent rules deterministically.
 */
let offsetMs = 0;

export const clock = {
  now() {
    return new Date(Date.now() + offsetMs);
  },
  advance(ms) {
    if (!env.isTest) throw new Error("clock.advance is only available in tests");
    offsetMs += ms;
  },
  reset() {
    if (!env.isTest) throw new Error("clock.reset is only available in tests");
    offsetMs = 0;
  },
};
