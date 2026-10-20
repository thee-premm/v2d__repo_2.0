import { Router } from "express";
import { z } from "zod";
import { id, isoDate, pagination, parse, reason, send } from "../../lib/http.js";
import { requireRole } from "../../middleware/guards.js";
import * as accounts from "./accounts.service.js";

const username = z.string().trim().toLowerCase().pipe(z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/, "3–64 characters: letters, digits, . _ -"));
const email = z.string().trim().toLowerCase().pipe(z.string().email().max(160));
const roleInput = z.object({ role: z.enum(["SUPERVISOR", "KITCHEN_STAFF", "INSTITUTION_ADMIN"]), messId: id.optional() });
const studentInput = z.object({
  rollNumber: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z0-9][A-Z0-9/_-]{1,31}$/, "Use letters, digits, / _ -")),
  messId: id,
  hostelId: id.optional(),
  roomNumber: z.string().trim().max(20).optional(),
  program: z.string().trim().max(80).optional(),
  yearOfStudy: z.number().int().min(1).max(10).optional(),
});

export const accountsRouter = Router();
accountsRouter.use(requireRole("INSTITUTION_ADMIN"));

accountsRouter.get("/users", async (req, res) => {
  const q = parse(
    pagination.extend({
      q: z.string().trim().max(80).optional(),
      role: z.enum(["STUDENT", "SUPERVISOR", "KITCHEN_STAFF", "INSTITUTION_ADMIN"]).optional(),
      status: z.enum(["INVITED", "ACTIVE", "SUSPENDED", "DEACTIVATED"]).optional(),
      messId: id.optional(),
    }),
    req.query,
  );
  send(res, await accounts.listUsers(req.principal, q));
});

accountsRouter.post("/users", async (req, res) => {
  const body = parse(
    z
      .object({
        fullName: z.string().trim().min(1).max(160),
        username: username.optional(),
        email: email.optional(),
        phone: z.string().trim().max(30).optional(),
        roles: z.array(roleInput).max(20).optional(),
        student: studentInput.optional(),
      })
      .refine((b) => b.student || (b.roles && b.roles.length), { message: "Assign at least one role or a student profile", path: ["roles"] }),
    req.body,
  );
  send(res, await accounts.createUser(req.principal, body), { status: 201 });
});

accountsRouter.get("/users/:id", async (req, res) => send(res, await accounts.getUser(req.principal, parse(id, req.params.id))));

accountsRouter.patch("/users/:id", async (req, res) => {
  const body = parse(
    z
      .object({
        fullName: z.string().trim().min(1).max(160).optional(),
        email: email.nullable().optional(),
        phone: z.string().trim().max(30).nullable().optional(),
        student: studentInput.omit({ rollNumber: true, messId: true }).partial().optional(),
      })
      .strict(),
    req.body,
  );
  await accounts.updateUser(req.principal, parse(id, req.params.id), body);
  send(res, await accounts.getUser(req.principal, parse(id, req.params.id)));
});

accountsRouter.post("/users/:id/status", async (req, res) => {
  const body = parse(z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "DEACTIVATED"]), reason }), req.body);
  send(res, await accounts.setStatus(req.principal, parse(id, req.params.id), body));
});

accountsRouter.post("/users/:id/roles", async (req, res) => {
  send(res, await accounts.grantRole(req.principal, parse(id, req.params.id), parse(roleInput, req.body)), { status: 201 });
});

accountsRouter.post("/users/:id/roles/:assignmentId/revoke", async (req, res) => {
  await accounts.revokeRole(req.principal, parse(id, req.params.id), parse(id, req.params.assignmentId), parse(z.object({ reason }), req.body));
  send(res, { revoked: true });
});

accountsRouter.post("/users/:id/codes", async (req, res) => {
  const { purpose } = parse(z.object({ purpose: z.enum(["ACTIVATION", "PASSWORD_RESET"]) }), req.body);
  res.setHeader("Cache-Control", "no-store");
  send(res, await accounts.issueCode(req.principal, parse(id, req.params.id), purpose), { status: 201 });
});

accountsRouter.put("/users/:id/membership", async (req, res) => {
  const body = parse(z.object({ messId: id, validFrom: isoDate }), req.body);
  await accounts.changeMembership(req.principal, parse(id, req.params.id), body);
  send(res, await accounts.getUser(req.principal, parse(id, req.params.id)));
});

accountsRouter.post("/students/import", async (req, res) => {
  const body = parse(z.object({ csv: z.string().min(1).max(2_000_000), dryRun: z.boolean().default(true) }), req.body);
  res.setHeader("Cache-Control", "no-store");
  send(res, await accounts.importStudents(req.principal, body));
});
