import { Router } from "express";
import { z } from "zod";
import { id, pagination, parse, send } from "../../lib/http.js";
import { requireRole } from "../../middleware/guards.js";
import * as votes from "./votes.service.js";
import * as accountability from "../reconciliation/accountability.service.js";
import * as notifications from "../notifications/notifications.service.js";

/** Everything under /me is the signed-in student's own data — never another student's. */
export const studentRouter = Router();
studentRouter.use(requireRole("STUDENT"));

studentRouter.get("/meals", async (req, res) => {
  const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(14).default(7) }), req.query);
  send(res, await votes.myMeals(req.principal, { days }));
});

studentRouter.put("/meals/:slotId/vote", async (req, res) => {
  const { intent } = parse(z.object({ intent: z.enum(["YES", "NO"]) }), req.body);
  send(res, await votes.castVote(req.principal, parse(id, req.params.slotId), intent));
});

studentRouter.get("/meals/:slotId/pass", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  send(res, await votes.myPass(req.principal, parse(id, req.params.slotId)));
});

studentRouter.get("/history", async (req, res) => send(res, await votes.myHistory(req.principal, parse(pagination, req.query))));

studentRouter.get("/warnings", async (req, res) => send(res, await accountability.myWarnings(req.principal)));
studentRouter.post("/warnings/:id/appeal", async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(10, "Explain in at least 10 characters").max(2000) }), req.body);
  send(res, await accountability.submitAppeal(req.principal, parse(id, req.params.id), reason), { status: 201 });
});

export const notificationsRouter = Router();
notificationsRouter.get("/", async (req, res) => {
  const q = parse(pagination.extend({ unreadOnly: z.enum(["true", "false"]).optional().transform((v) => v === "true") }), req.query);
  send(res, await notifications.list(req.principal, q));
});
notificationsRouter.post("/read-all", async (req, res) => send(res, await notifications.markAllRead(req.principal)));
notificationsRouter.post("/:id/read", async (req, res) => send(res, await notifications.markRead(req.principal, parse(id, req.params.id))));
