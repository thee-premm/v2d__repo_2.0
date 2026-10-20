import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { parse, send } from "../../lib/http.js";
import { createLimiter, limitByIp } from "../../middleware/rateLimit.js";
import { requireAuth } from "../../middleware/guards.js";
import { SESSION_COOKIE, sessionCookieOptions } from "../../middleware/session.js";
import { ROLES } from "../../domain/permissions.js";
import * as auth from "./auth.service.js";

const scale = env.isTest ? 100 : 1;
const loginIpLimit = createLimiter({ name: "login-ip", windowMs: 15 * 60_000, max: 30 * scale });
const codeIpLimit = createLimiter({ name: "code-ip", windowMs: 15 * 60_000, max: 20 * scale });
const resetRequestLimit = createLimiter({ name: "reset-request-ip", windowMs: 15 * 60_000, max: 5 * scale });

const identifier = z.string().trim().min(3, "Enter your username or email").max(160);
const password = z.string().min(1, "Enter your password").max(256);
const code = z.string().trim().min(12, "Enter the 12-character code").max(20);

const router = Router();

router.post("/login", limitByIp(loginIpLimit), async (req, res) => {
  const body = parse(z.object({ identifier, password, role: z.enum(ROLES).optional() }), req.body);
  const session = await auth.login(body, {
    ip: req.ip,
    userAgent: req.get("user-agent")?.slice(0, 300),
    previousSessionToken: req.cookies?.[SESSION_COOKIE],
  });
  res.cookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.absoluteExpiresAt));
  // The client follows up with GET /auth/session for the full, server-derived context.
  send(res, { signedIn: true, csrfToken: session.csrfToken });
});

router.get("/session", requireAuth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  send(res, await auth.describeSession(req.principal, req.session.csrfToken));
});

router.post("/logout", requireAuth, async (req, res) => {
  await auth.logout(req.principal);
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
  send(res, { signedOut: true });
});

router.post("/switch-role", requireAuth, async (req, res) => {
  const { role } = parse(z.object({ role: z.enum(ROLES) }), req.body);
  await auth.switchRole(req.principal, role);
  send(res, { activeRole: role });
});

router.post("/activate", limitByIp(codeIpLimit), async (req, res) => {
  const body = parse(z.object({ identifier, code, password: z.string().max(256) }), req.body);
  send(res, await auth.activateAccount(body));
});

router.post("/password-reset/request", limitByIp(resetRequestLimit), async (req, res) => {
  const body = parse(z.object({ identifier }), req.body);
  send(res, await auth.requestPasswordReset(body), { status: 202 });
});

router.post("/password-reset/confirm", limitByIp(codeIpLimit), async (req, res) => {
  const body = parse(z.object({ identifier, code, password: z.string().max(256) }), req.body);
  send(res, await auth.resetPassword(body));
});

router.post("/password/change", requireAuth, async (req, res) => {
  const body = parse(z.object({ currentPassword: password, newPassword: z.string().max(256) }), req.body);
  await auth.changePassword(req.principal, body);
  send(res, { changed: true });
});

export default router;
