import { Router } from "express";
import { requireAuth } from "./middleware/guards.js";
import authRoutes from "./modules/auth/auth.routes.js";
import { orgRouter, adminOrgRouter } from "./modules/org/org.routes.js";
import { accountsRouter } from "./modules/accounts/accounts.routes.js";
import { catalogRouter } from "./modules/catalog/catalog.routes.js";
import { studentRouter, notificationsRouter } from "./modules/votes/student.routes.js";
import { operationsRouter, institutionRouter, definitionsRouter } from "./modules/operations.routes.js";

/** Every API module is mounted here, under /api/v1. See docs/API.md. */
export const apiRouter = Router();

apiRouter.use("/auth", authRoutes);
apiRouter.use("/org", orgRouter);
apiRouter.use("/me/notifications", requireAuth, notificationsRouter);
apiRouter.use("/me", studentRouter);
apiRouter.use("/catalog", catalogRouter);
apiRouter.use("/admin", adminOrgRouter);
apiRouter.use("/admin", accountsRouter);
apiRouter.use("/admin", institutionRouter);
apiRouter.use("/definitions", definitionsRouter);
apiRouter.use(operationsRouter);
