import { Router } from "express";
import { z } from "zod";
import { id, isoDate, localTime, parse, send } from "../../lib/http.js";
import { requireAuth, requireRole } from "../../middleware/guards.js";
import { settingsPatchSchema } from "../../domain/settings.js";
import * as org from "./org.service.js";

const code = z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/, "Use letters, digits, - or _"));
const name = z.string().trim().min(2).max(160);

/** Read endpoints for any signed-in user (scoped to their institution). */
export const orgRouter = Router();
orgRouter.use(requireAuth);
orgRouter.get("/institution", async (req, res) => send(res, await org.institutionSummary(req.principal)));
orgRouter.get("/messes", async (req, res) => send(res, await org.listVisibleMesses(req.principal)));
orgRouter.get("/meal-types", async (req, res) => send(res, await org.listMealTypes(req.principal)));

/** Institution administration. */
export const adminOrgRouter = Router();
adminOrgRouter.use(requireRole("INSTITUTION_ADMIN"));

adminOrgRouter.get("/institution", async (req, res) => send(res, await org.institutionForAdmin(req.principal)));
adminOrgRouter.patch("/institution", async (req, res) => {
  const body = parse(
    z.object({ name: name.optional(), timezone: z.string().min(3).max(64).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional() }).strict(),
    req.body,
  );
  send(res, await org.updateInstitution(req.principal, body));
});
adminOrgRouter.put("/settings", async (req, res) => {
  send(res, await org.updateSettings(req.principal, parse(settingsPatchSchema, req.body)));
});

adminOrgRouter.get("/structure", async (req, res) => send(res, await org.structure(req.principal)));
adminOrgRouter.post("/campuses", async (req, res) => {
  send(res, await org.createCampus(req.principal, parse(z.object({ code, name }), req.body)), { status: 201 });
});
adminOrgRouter.patch("/campuses/:id", async (req, res) => {
  send(res, await org.updateCampus(req.principal, parse(id, req.params.id), parse(z.object({ name: name.optional() }).strict(), req.body)));
});
adminOrgRouter.post("/hostels", async (req, res) => {
  const body = parse(z.object({ campusId: id, code, name, capacity: z.number().int().min(0).max(100000).optional() }), req.body);
  send(res, await org.createHostel(req.principal, body), { status: 201 });
});
adminOrgRouter.patch("/hostels/:id", async (req, res) => {
  const body = parse(z.object({ name: name.optional(), capacity: z.number().int().min(0).max(100000).optional() }).strict(), req.body);
  send(res, await org.updateHostel(req.principal, parse(id, req.params.id), body));
});
adminOrgRouter.post("/messes", async (req, res) => {
  const body = parse(
    z.object({ campusId: id, hostelId: id.nullable().optional(), code, name, seatingCapacity: z.number().int().min(0).max(100000).optional() }),
    req.body,
  );
  send(res, await org.createMess(req.principal, body), { status: 201 });
});
adminOrgRouter.patch("/messes/:id", async (req, res) => {
  const body = parse(
    z
      .object({
        name: name.optional(),
        seatingCapacity: z.number().int().min(0).max(100000).optional(),
        isActive: z.boolean().optional(),
        hostelId: id.nullable().optional(),
      })
      .strict(),
    req.body,
  );
  send(res, await org.updateMess(req.principal, parse(id, req.params.id), body));
});

const mealType = z.object({
  code: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z][A-Z_]{1,23}$/)),
  name: z.string().trim().min(2).max(60),
  defaultServiceStart: localTime,
  defaultServiceEnd: localTime,
  defaultCutoffMinutes: z.number().int().min(0).max(4320),
  defaultOpenHours: z.number().int().min(1).max(336),
  sortOrder: z.number().int().min(0).max(100).optional(),
});
adminOrgRouter.post("/meal-types", async (req, res) => {
  const body = parse(mealType.refine((t) => t.defaultServiceEnd > t.defaultServiceStart, { message: "Service must end after it starts", path: ["defaultServiceEnd"] }), req.body);
  send(res, await org.createMealType(req.principal, body), { status: 201 });
});
adminOrgRouter.patch("/meal-types/:id", async (req, res) => {
  const body = parse(mealType.omit({ code: true }).partial().extend({ isActive: z.boolean().optional() }).strict(), req.body);
  send(res, await org.updateMealType(req.principal, parse(id, req.params.id), body));
});

adminOrgRouter.get("/baselines", async (req, res) => {
  const { messId } = parse(z.object({ messId: id.optional() }), req.query);
  send(res, await org.listBaselines(req.principal, messId));
});
adminOrgRouter.post("/baselines", async (req, res) => {
  const body = parse(
    z
      .object({
        messId: id,
        label: z.string().trim().min(2).max(120),
        periodStart: isoDate,
        periodEnd: isoDate,
        discardedGPerServing: z.number().min(0).max(5000),
        basis: z.enum(["MEASURED", "ESTIMATED"]),
        sourceNote: z.string().trim().min(5).max(1000),
      })
      .refine((b) => b.periodEnd >= b.periodStart, { message: "Period must end after it starts", path: ["periodEnd"] }),
    req.body,
  );
  send(res, await org.createBaseline(req.principal, body), { status: 201 });
});
