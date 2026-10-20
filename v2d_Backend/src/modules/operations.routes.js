import { Router } from "express";
import { z } from "zod";
import { id, isoDate, localTime, pagination, parse, reason, send } from "../lib/http.js";
import { requireAuth, requireRole } from "../middleware/guards.js";
import { UNIT_NAMES } from "../lib/units.js";
import * as meals from "./meals/meals.service.js";
import * as forecasting from "./forecasting/forecasting.service.js";
import * as planning from "./planning/planning.service.js";
import * as kitchen from "./kitchen/kitchen.service.js";
import * as attendance from "./attendance/attendance.service.js";
import * as reconciliation from "./reconciliation/reconciliation.service.js";
import * as accountability from "./reconciliation/accountability.service.js";
import * as analytics from "./analytics/analytics.service.js";
import * as overview from "./overview/overview.service.js";

/**
 * Staff operations. Every handler re-checks the caller's scope against the
 * mess that owns the resource (see loadMess / loadSlot), so changing an ID in
 * the URL can never reach another mess or institution.
 */
export const operationsRouter = Router();
operationsRouter.use(
  ["/messes", "/slots", "/incidents", "/appeals", "/attendance", "/kitchen", "/prep-tasks", "/food-logs"],
  requireAuth,
  requireRole("SUPERVISOR", "KITCHEN_STAFF", "INSTITUTION_ADMIN"),
);

const slotId = (req) => parse(id, req.params.slotId);
const messId = (req) => parse(id, req.params.messId);
const range = z
  .object({ from: isoDate, to: isoDate, mealTypeId: id.optional() })
  .refine((r) => r.to >= r.from, { message: "'to' must not be before 'from'", path: ["to"] })
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 <= 400, { message: "Choose a range of at most 400 days", path: ["to"] });
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, "Use YYYY-MM-DDTHH:MM");
const menu = z.array(z.object({ dishId: id, uptakeFraction: z.number().gt(0).max(1).optional() })).max(30);
const massUnit = z.enum(["kg", "g"]);

// ----- Mess-level -----------------------------------------------------------
operationsRouter.get("/messes/:messId/overview", async (req, res) => {
  const { date } = parse(z.object({ date: isoDate.optional() }), req.query);
  send(res, await overview.messOverview(req.principal, messId(req), { date }));
});

operationsRouter.get("/messes/:messId/slots", async (req, res) => {
  const q = parse(
    z.object({ from: isoDate, to: isoDate, status: z.enum(["DRAFT", "OPEN", "LOCKED", "FORECAST_READY", "APPROVED", "IN_SERVICE", "SERVICE_CLOSED", "RECONCILED", "CANCELLED"]).optional() }),
    req.query,
  );
  send(res, await meals.listSlots(req.principal, messId(req), q));
});

operationsRouter.post("/messes/:messId/slots", async (req, res) => {
  const body = parse(
    z.object({
      mealTypeId: id,
      serviceDate: isoDate,
      serviceStart: localTime.optional(),
      serviceEnd: localTime.optional(),
      votingOpensAt: localDateTime.optional(),
      votingClosesAt: localDateTime.optional(),
      notes: z.string().trim().max(500).optional(),
      isSpecialEvent: z.boolean().optional(),
      isExamPeriod: z.boolean().optional(),
      isHoliday: z.boolean().optional(),
      menu: menu.optional(),
    }),
    req.body,
  );
  send(res, await meals.createSlot(req.principal, messId(req), body), { status: 201 });
});

operationsRouter.post("/messes/:messId/schedule", async (req, res) => {
  const body = parse(
    z
      .object({ fromDate: isoDate, toDate: isoDate, mealTypeIds: z.array(id).min(1).max(10), copyMenuFromDaysBefore: z.number().int().min(1).max(28).optional() })
      .refine((b) => b.toDate >= b.fromDate, { message: "'toDate' must not be before 'fromDate'", path: ["toDate"] }),
    req.body,
  );
  send(res, await meals.createSchedule(req.principal, messId(req), body), { status: 201 });
});

operationsRouter.get("/messes/:messId/forecast-accuracy", async (req, res) => {
  const q = parse(z.object({ mealTypeId: id.optional(), limit: z.coerce.number().int().min(1).max(200).default(60) }), req.query);
  send(res, await forecasting.forecastAccuracy(req.principal, messId(req), q));
});

operationsRouter.get("/messes/:messId/inventory", async (req, res) => send(res, await planning.inventory(req.principal, messId(req))));
operationsRouter.get("/messes/:messId/inventory/transactions", async (req, res) => {
  const q = parse(pagination.extend({ ingredientId: id.optional() }), req.query);
  send(res, await planning.listTransactions(req.principal, messId(req), q));
});
operationsRouter.post("/messes/:messId/inventory/transactions", async (req, res) => {
  const body = parse(
    z
      .object({
        ingredientId: id,
        kind: z.enum(["RECEIPT", "ISSUE", "ADJUSTMENT", "SPOILAGE"]),
        direction: z.enum(["IN", "OUT"]).optional(),
        quantity: z.number().positive().max(1_000_000),
        unit: z.enum(UNIT_NAMES),
        unitCost: z.number().min(0).max(1_000_000).optional(),
        mealSlotId: id.optional(),
        note: z.string().trim().max(500).optional(),
      })
      .refine((t) => t.kind !== "ADJUSTMENT" || t.direction, { message: "Adjustments need a direction (IN or OUT)", path: ["direction"] }),
    req.body,
  );
  send(res, await planning.recordTransaction(req.principal, messId(req), body), { status: 201 });
});
operationsRouter.put("/messes/:messId/inventory/settings/:ingredientId", async (req, res) => {
  const body = parse(
    z.object({ safetyStock: z.number().min(0).max(1_000_000), packSize: z.number().positive().max(1_000_000).nullable().optional(), minOrder: z.number().positive().max(1_000_000).nullable().optional() }),
    req.body,
  );
  send(res, await planning.updateStockSettings(req.principal, messId(req), parse(id, req.params.ingredientId), body));
});
operationsRouter.get("/messes/:messId/procurement", async (req, res) => {
  const q = parse(z.object({ from: isoDate, to: isoDate }), req.query);
  send(res, await planning.procurementOutlook(req.principal, messId(req), q));
});

operationsRouter.get("/messes/:messId/incidents", async (req, res) => {
  const q = parse(z.object({ status: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED"]).optional() }), req.query);
  send(res, await kitchen.listIncidents(req.principal, messId(req), q));
});
operationsRouter.post("/messes/:messId/incidents", async (req, res) => {
  const body = parse(
    z.object({
      kind: z.enum(["SHORTAGE", "SUBSTITUTION", "DEVIATION", "EQUIPMENT", "QUALITY", "OTHER"]),
      description: z.string().trim().min(5, "Describe the issue in at least 5 characters").max(1000),
      mealSlotId: id.optional(),
      ingredientId: id.optional(),
    }),
    req.body,
  );
  send(res, await kitchen.reportIncident(req.principal, messId(req), body), { status: 201 });
});
operationsRouter.post("/incidents/:id", async (req, res) => {
  const body = parse(z.object({ status: z.enum(["ACKNOWLEDGED", "RESOLVED"]), resolutionNote: z.string().trim().min(5).max(1000).optional() }), req.body);
  send(res, await kitchen.updateIncident(req.principal, parse(id, req.params.id), body));
});

operationsRouter.get("/messes/:messId/warnings", async (req, res) => {
  const q = parse(pagination.extend({ status: z.enum(["ACTIVE", "APPEALED", "UPHELD", "WAIVED", "VOIDED"]).optional() }), req.query);
  send(res, await accountability.messWarnings(req.principal, messId(req), q));
});
operationsRouter.get("/messes/:messId/appeals", async (req, res) => {
  const q = parse(z.object({ status: z.enum(["PENDING", "UPHELD", "WAIVED"]).optional() }), req.query);
  send(res, await accountability.messAppeals(req.principal, messId(req), q));
});
operationsRouter.post("/appeals/:id/resolve", async (req, res) => {
  const body = parse(z.object({ decision: z.enum(["UPHELD", "WAIVED"]), note: z.string().trim().min(5, "Explain the decision to the student").max(1000) }), req.body);
  send(res, await accountability.resolveAppeal(req.principal, parse(id, req.params.id), body));
});

operationsRouter.get("/messes/:messId/analytics", async (req, res) => {
  send(res, await analytics.messAnalytics(req.principal, messId(req), parse(range, req.query)));
});
operationsRouter.get("/messes/:messId/analytics/export.csv", async (req, res) => {
  const { filename, csv } = await analytics.messExportCsv(req.principal, messId(req), parse(range, req.query));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(`﻿${csv}`);
});

// ----- Slot-level -----------------------------------------------------------
operationsRouter.get("/slots/:slotId", async (req, res) => send(res, await meals.getSlotDetail(req.principal, slotId(req))));
operationsRouter.patch("/slots/:slotId", async (req, res) => {
  const body = parse(
    z
      .object({
        serviceStart: localTime.optional(),
        serviceEnd: localTime.optional(),
        votingOpensAt: localDateTime.optional(),
        votingClosesAt: localDateTime.optional(),
        notes: z.string().trim().max(500).nullable().optional(),
        isSpecialEvent: z.boolean().optional(),
        isExamPeriod: z.boolean().optional(),
        isHoliday: z.boolean().optional(),
      })
      .strict(),
    req.body,
  );
  send(res, await meals.updateSlot(req.principal, slotId(req), body));
});
operationsRouter.put("/slots/:slotId/menu", async (req, res) => send(res, await meals.updateMenu(req.principal, slotId(req), parse(z.object({ menu }), req.body).menu)));
operationsRouter.post("/slots/:slotId/publish", async (req, res) => send(res, await meals.publishSlot(req.principal, slotId(req))));
operationsRouter.post("/slots/:slotId/cancel", async (req, res) => send(res, await meals.cancelSlot(req.principal, slotId(req), parse(z.object({ reason }), req.body))));
operationsRouter.post("/slots/:slotId/lock", async (req, res) => send(res, await forecasting.lockFromRequest(req.principal, slotId(req))));
operationsRouter.post("/slots/:slotId/forecast", async (req, res) => send(res, await forecasting.regenerateForecast(req.principal, slotId(req))));
operationsRouter.get("/slots/:slotId/forecasts", async (req, res) => send(res, await forecasting.listForecasts(req.principal, slotId(req))));
operationsRouter.get("/slots/:slotId/requirements", async (req, res) => {
  const { servings } = parse(z.object({ servings: z.coerce.number().int().min(0).max(100000).optional() }), req.query);
  send(res, await planning.slotRequirements(req.principal, slotId(req), { servings }));
});
operationsRouter.post("/slots/:slotId/approve", async (req, res) => {
  const body = parse(z.object({ servings: z.number().int().min(0).max(100000).optional(), reason: reason.optional() }), req.body);
  send(res, await planning.approvePlan(req.principal, slotId(req), body));
});
operationsRouter.post("/slots/:slotId/start-service", async (req, res) => send(res, await meals.startService(req.principal, slotId(req))));
operationsRouter.post("/slots/:slotId/close-service", async (req, res) => send(res, await meals.closeService(req.principal, slotId(req))));

operationsRouter.get("/slots/:slotId/attendance", async (req, res) => {
  send(res, await attendance.listAttendance(req.principal, slotId(req), parse(z.object({ q: z.string().trim().max(60).optional() }), req.query)));
});
operationsRouter.post("/slots/:slotId/attendance", async (req, res) => {
  const body = parse(
    z
      .object({
        rollNumber: z.string().trim().min(1).max(40).optional(),
        passToken: z.string().trim().max(200).optional(),
        method: z.enum(["ROLL_NUMBER", "QR", "MANUAL"]).optional(),
        walkInReason: reason.optional(),
        lateEntryReason: reason.optional(),
        note: z.string().trim().max(500).optional(),
      })
      .refine((b) => b.rollNumber || b.passToken, { message: "Enter a roll number or scan a meal pass", path: ["rollNumber"] }),
    req.body,
  );
  send(res, await attendance.verify(req.principal, slotId(req), body), { status: 201 });
});
operationsRouter.post("/attendance/:id/void", async (req, res) => {
  send(res, await attendance.voidAttendance(req.principal, parse(id, req.params.id), parse(z.object({ reason }), req.body)));
});

operationsRouter.get("/slots/:slotId/reconciliation", async (req, res) => send(res, await reconciliation.reconciliationView(req.principal, slotId(req))));
operationsRouter.post("/slots/:slotId/reconcile", async (req, res) => {
  const body = parse(z.object({ excusals: z.array(z.object({ studentUserId: id, reason })).max(5000).default([]) }), req.body);
  send(res, await reconciliation.reconcile(req.principal, slotId(req), body));
});
operationsRouter.post("/slots/:slotId/outcomes/:studentUserId/correct", async (req, res) => {
  const body = parse(
    z
      .object({ attended: z.boolean().optional(), excuseReason: reason.optional(), reason })
      .refine((b) => b.attended !== undefined || b.excuseReason, { message: "Change attendance or give an excuse", path: ["attended"] }),
    req.body,
  );
  send(res, await reconciliation.correctOutcome(req.principal, slotId(req), parse(id, req.params.studentUserId), body));
});

// ----- Kitchen --------------------------------------------------------------
operationsRouter.get("/kitchen/board", async (req, res) => {
  send(res, await kitchen.board(req.principal, parse(z.object({ messId: id.optional(), date: isoDate.optional() }), req.query)));
});
operationsRouter.get("/slots/:slotId/kitchen", async (req, res) => send(res, await kitchen.slotKitchen(req.principal, slotId(req))));
operationsRouter.post("/prep-tasks/:id/start", async (req, res) => send(res, await kitchen.startTask(req.principal, parse(id, req.params.id))));
operationsRouter.post("/prep-tasks/:id/complete", async (req, res) => {
  const body = parse(
    z.object({
      preparedQuantity: z.number().min(0).max(1_000_000),
      unit: massUnit,
      measurement: z.enum(["MEASURED", "ESTIMATED"]),
      deviationNote: z.string().trim().min(3).max(1000).optional(),
    }),
    req.body,
  );
  send(res, await kitchen.completeTask(req.principal, parse(id, req.params.id), body));
});
operationsRouter.get("/slots/:slotId/food-logs", async (req, res) => send(res, await kitchen.listFoodLogs(req.principal, slotId(req))));
operationsRouter.post("/slots/:slotId/food-logs", async (req, res) => {
  const body = parse(
    z.object({
      category: z.enum(["REUSABLE_SURPLUS", "DISCARDED_SURPLUS", "PLATE_WASTE", "KITCHEN_WASTE"]),
      quantity: z.number().min(0).max(1_000_000),
      unit: massUnit,
      measurement: z.enum(["MEASURED", "ESTIMATED"]),
      dishId: id.optional(),
      note: z.string().trim().max(500).optional(),
    }),
    req.body,
  );
  send(res, await kitchen.addFoodLog(req.principal, slotId(req), body), { status: 201 });
});
operationsRouter.post("/food-logs/:id/void", async (req, res) => {
  send(res, await kitchen.voidFoodLog(req.principal, parse(id, req.params.id), parse(z.object({ reason }), req.body)));
});

// ----- Institution-wide (admin) ---------------------------------------------
export const institutionRouter = Router();
institutionRouter.use(requireRole("INSTITUTION_ADMIN"));
institutionRouter.get("/overview", async (req, res) => send(res, await overview.institutionOverview(req.principal)));
institutionRouter.get("/analytics", async (req, res) => send(res, await analytics.institutionAnalytics(req.principal, parse(range, req.query))));
institutionRouter.get("/analytics/export.csv", async (req, res) => {
  const { filename, csv } = await analytics.institutionExportCsv(req.principal, parse(range, req.query));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(`﻿${csv}`);
});
institutionRouter.get("/audit", async (req, res) => {
  const q = parse(
    pagination.extend({
      action: z.string().trim().max(60).optional(),
      entityType: z.string().trim().max(60).optional(),
      messId: id.optional(),
      actorId: id.optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
    }),
    req.query,
  );
  send(res, await overview.listAudit(req.principal, q));
});

export const definitionsRouter = Router();
definitionsRouter.get("/metrics", requireAuth, (req, res) => send(res, analytics.METRIC_DEFINITIONS));
